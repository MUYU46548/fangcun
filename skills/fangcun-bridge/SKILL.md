---
name: fangcun-bridge
description: 方寸（tegula）↔ 任意 agent 接线卡（agent 中立）。要查询/修改方寸任务、读项目状态或阻塞链时加载：两个 stdio 入口选型、named pipe 自检、工具边界、写操作规则。
version: 1.10.0
metadata:
  hermes:
    tags: [fangcun, 方寸, mcp, bridge, 接线卡]
    category: integration
---

# 方寸（tegula）agent 接线卡

**仓库真源**：`fangcun/skills/fangcun-bridge/SKILL.md`（本文件是它的副本）。

本卡 **agent 中立**：DSH / Claude Code / Cursor / OpenCode / Codex / Hermes 通用。
各家落点不同（技能目录与配置文件位置由各家自己的文档规定，方寸不猜、不代写）：
方寸桌面版设置页“接入其他 Agent”提供**按本机安装路径生成的配置段 + 一键复制 + 打开目标文件**按钮。
Hermes 侧的自动装卡与覆盖策略是特例（`skills/manifest.json` 登记 + hash 比对），见 `skill-management-policy`。

---

## 何时使用

- 任何 agent 需要主动查询方寸数据（任务列表/状态/日志/阻塞链）
- 派活前后需要确认任务状态
- 需要从本 agent 侧触发方寸操作
- 需要从本 agent 侧了解绒花墨坊运行状态

## 入口（两个，按需选型）

**入口 A · named pipe（桌面版运行时，读写全量工具）**

方寸桌面版通过 named pipe 暴露 MCP 服务：

```
\\.\pipe\tegula-mcp
```

stdio 桥 = **方寸自己的可执行文件以“纯 node 模式”跑包内桥脚本**（2026-10-18 最终形态）：

```bash
# 环境变量不能省：少了它方寸会以 GUI 模式启动，拉起 GPU 进程（本机核显上连崩，
# 第 6 次 Chromium 直接 FATAL: gpu_process_host isn't usable. Goodbye. 把进程带走）
ELECTRON_RUN_AS_NODE=1 "<方寸.exe>" "<安装目录>/resources/app.asar/dist/main/mcp/bridge-standalone.js"
# 开发态（仓库 desktop 目录）
ELECTRON_RUN_AS_NODE=1 <fangcun>/desktop/node_modules/electron/dist/electron.exe \
  <fangcun>/desktop/dist/main/mcp/bridge-standalone.js
```

配置段要写三段：`command`（方寸 exe）、`args`（包内桥脚本绝对路径）、`env`。
**客户端不支持 `env` 时改用入口 C**（本机 node 直接跑同一个桥脚本，能力完全相同）。

> 历史坑（别走回头路）：`node dist/cli/tegula-mcp.js` 在安装版上**从来跑不起来** ——
> 那个 js 被打进 app.asar，外部 node 执行不了；而且裸 `node` 在 GUI 应用的 PATH 里通常不存在。
> 也**不要**指望“Electron 主进程里自己收发 stdio”：GUI 模式会拉起 GPU 进程，崩到阈值就 FATAL。

**入口 B · Python stdio（只读，方寸没开也能读）**

```bash
cd <fangcun 仓库/安装目录> && python tegula.py mcp
```

JSON-RPC 2.0 over stdio，**14 个只读工具**，直接读 `task-data/`：
**不依赖桌面版是否运行、不占用任何 TCP 端口**。适合只要读、或方寸未启动的场景。

> 选型：要写操作 / 桌面版 MCP 全量工具 → A；只要读、要离线可用 → B。

## 自检（调用前必做，失败显式报错）

1. **入口 A**：检查 named pipe 是否存在：
   ```bash
   ls \\\\.\\pipe\\tegula-mcp 2>/dev/null && echo "pipe OK" || echo "pipe MISSING"
   ```
   桥接可用性自检（一条命令走完 initialize + tools/list）：
   ```bash
   node <fangcun>/scripts/check-agent-mcp.cjs --readonly
   ```
   该脚本**读 DSH / Hermes 的真实配置文件**取 command，像客户端一样 spawn + 握手，
   逐家打印“通了 / 卡在哪”。也可单独验一家：
   ```bash
   node <fangcun>/scripts/test/probe-mcp-bridge.cjs "<方寸.exe 完整路径>" [--mcp-bridge]
   ```
   ⚠ **不要用 `echo '{...}' | 方寸.exe --mcp-bridge` 这种一次性管道做自检**（2026-10-18 实测）：
   exe 类入口启动要 300ms+，`echo` 的 stdin 在那之前就 EOF，消息直接丢，输出恒为空
   —— 看起来像"桥坏了"，其实是启动竞态。要验就连着 stdin 发（probe 脚本就是这么做的）。
   报“方寸桌面版没有在运行”或超时 → 桌面版未启动或 pipe 未就绪，**停止调用并报错**，不静默回退。
2. **入口 B**：直接发一条 `tools/list`，期望返回只读工具列表。

## 工具清单（自动生成，别去读源码）

<!-- MCP-TOOLS:BEGIN -->

> 由 `scripts/gen-skill-tools.cjs` 从 `desktop/src/main/mcp/tools.ts` 生成，共 **31** 个。
> **不要手改这一段**，改工具后跑一次生成脚本。**也不用去读源码** —— 这张表就是现场。

| 工具 | 干什么 |
|---|---|
| `list_tasks` | List tasks with optional filters |
| `search_tasks` | Full-text search across task titles, bodies, and tags |
| `get_task` | Get a single task by ID |
| `create_task` | Create a new task |
| `arch_generate` | 让方寸给某个已登记项目**生成架构图**（AI 画 + 逐条证据审计）。 |
| `intake_task` | 收卡（ADR-003 一期）：把交付物 + 卡上判据交进方寸，**先机检再落卡**。 |
| `usage_report` | Report AI usage from an external client (e.g. |
| `never_read` | List open tasks that NO agent has read in the last N days (source: mcp-usage.jsonl). |
| `update_task` | Update a task |
| `move_status` | Move a task to a different status |
| `delete_task` | Delete a task (move to trash) |
| `list_projects` | List all registered projects |
| `get_project_status` | Get detailed project status and health |
| `find_blockers` | Find tasks with blocking dependencies |
| `scan_services` | Scan running services declared in registry |
| `get_roadmap` | Get project roadmap with progress |
| `get_data_dir` | Get current data directory path |
| `plan_list` | List all plans |
| `plan_get` | Get a single plan by task ID |
| `plan_pending` | List plans with pending decisions |
| `gate_list` | List all acceptance gates |
| `list_logs` | List execution logs (方寸执行日志). |
| `search_logs` | Full-text search across log titles, contents and project names |
| `get_log` | Get one execution log by ID (e.g. |
| `create_log` | Create an execution log (方寸执行日志) for this round of work. |
| `update_log` | Edit an existing execution log (title / content / nextSteps / project / taskIds / priority). |
| `set_log_status` | Mark a log as running (进行中) or idle (取消进行中). |
| `attach_log_files` | Attach local files (screenshots, reports) to an execution log by ABSOLUTE path. |
| `inject_logs` | Bundle several logs into ONE hand-off text (main log first, the rest marked as parallel channels of the same r |
| `rice_pool_list` | Read the requirement pool (task-data/rice-pool.md): every item with its R/I/C/E raw scores, |
| `rice_pool_upsert` | Upsert RICE initial scores into the requirement pool (idempotent). |

<!-- MCP-TOOLS:END -->

入口 B（`python tegula.py mcp`）只含**读**工具；写工具只在入口 A。

> **2026-10-30 用户拍板（硬规则）：完成是签字，不是干活。**
> **2026-11-01 追加：签字对象是任务卡，不是日志。**
> **2026-11-03 追加（用户原话）：执行日志是用户自己记上下文用的私人笔记，agent 不写。**
> 干完活要记的是**看板任务**（`update_task` / `intake_task`），不是 `create_log`。
> 本卡下文老口径已按这条改掉；`create_log` / `attach_log_files` / `update_log`
> 只在用户**明确说“记一条日志”**时才用。
> - 任务卡：agent 最多移到“待验收”；`move_status` 传“完成 / 驳回”会被**硬拒**。
> - 执行日志：只记过程，agent 只能 `running / idle`；`complete / archive / reopen` 会被**硬拒**。
>   **没有 `request_close` 这套“等你确认”** —— 日志页不该堆待验收队列。
> - 收工动作 = 把关联任务移到“待验收”（`move_status`），不是给日志打标记。
> - 决策：`decision_record` 已从 MCP 移除；拍板只在方寸界面“需求矩阵”页由用户点。
> 越权不是"会被批评"，是接口直接报错 —— 看到 `只能由用户` 就停手，别换条路绕。

## 常做的几件事（照抄参数，别探索）

> 这一段存在的原因：agent 每次干活都要“先看看有什么工具、再摸摸参数怎么写”——
> 那就是 token 白烧。下面几条覆盖 90% 的日常，参数直接照抄。

**① 开工：先看看板上的活（不是先翻日志）**
```
list_tasks     { project: "fangcun-base", status: "进行中" }   # 现在谁在做、做到哪
get_task       { id: "<任务 id>" }                             # 这张卡的正文 + 判据
get_roadmap    { project: "fangcun-base" }                     # 批次（batch）沿用这里的名字
list_logs      { project: "fangcun-base" }                     # 只在用户点名某条日志 / 让查历史时才看
get_log        { id: "log_20261028140158_yo07jt" }             # 单条；附件会带 abs 绝对路径
```

**② 收工：把结果写回任务卡，再把卡移进“待验收”**
```
update_task   { id: "<任务 id>", fields: { body: "<做了什么 + 判据 + 没做到的>" },
                expected_update: <读到的 updated> }             # 乐观锁，冲突就重读再写
move_status   { id: "<任务 id>", status: "待验收" }              # 收口：卡进待验收，等用户签字
intake_task   { title, project, deliverable, criteria, agent }    # 有交付物时用它落卡（先机检）
```
⚠ **不写执行日志**：日志是用户自己记上下文的私人笔记（`create_log` 只在用户明确要求时用）。
⚠ 收工别先问用户“要不要记一条”——要记的是**任务卡**，直接写进卡里。
⚠ **不要**把 `complete` 当成收工的最后一步：它会被拒，而且那本来就是用户的签字。

**③ 看项目：状态与路线**
```
list_projects {}  →  get_project_status { project: "fangcun-base" }
get_roadmap   { project: "fangcun-base" }     find_blockers { project: "..." }
```

**④ 改任务**
```
create_task { title, project, status: "待办", priority: "中", batch, body }
update_task { id, fields…, expected_update: <读到的 updated> }   # 乐观锁，冲突就重读再写
move_status { id, status: "进行中" }                              # 最多到“待验收”；完成/驳回被硬拒
```
⚠ **`batch`（批次）必须沿用项目里已有的名字**，不要自己新造一个：
`get_roadmap { project }` 先看一眼现有批次（如 `P1 功能` / `2026-Q3`），能归就归；
真的都不合适再起新名字，并在**任务卡正文**里说明为什么。**批次名字一乱，路线图就变成一堆“未分类”**——
方寸不会替你猜"这两张算不算一批"。

**⑤ 交单：有交付物就用 `intake_task`（2026-11-02 新增）**

干完一段活、出了报告/清单/代码改动 → **用 `intake_task`，不要用 `create_task` 裸交**。
它会把**交付物**和**卡上判据**一起机检，结果写进卡正文：

```
intake_task {
  title, project,
  deliverable: "<交付物全文，Markdown>",
  criteria: ["str: 'CJK 统一表意文字'", "count: '诉求' == 6", "format: /^# 功能缺口判定/", "file: docs/功能缺口判定-20261102.md 存在"],
  agent: "<你的名字>", model: "<模型名>", priority: "中"
}
```

- **全过 → 落“待审批”**（用户点头才转正）
- **有不过 → 落“草稿”+ 正文里一节“⚠ 红标（这几条没过）”逐条列出原文与实际值**
  —— 卡照样建，东西不会丢；你返工后再交一次
- 返回体里的 `intake.redFlags` 就是返工清单，`next` 说明下一步该干什么

判据四类（写的都是**可复算**的东西）：

| 写法 | 判什么 |
|---|---|
| `str: '原文'` | 交付物必须含这段原文（引号必需） |
| `count: '原文' == N` | 出现次数（`>=` `<=` `==` `!=` `>` `<` 都收） |
| `format: <正则>` | 交付物必须匹配（写坏正则 → 未判定，不算不过） |
| `file: docs/x.md 存在` | 仓库里真存在（相对仓库根；`../` 与绝对路径一律 false） |

⚠ `cmd:` 判据在收卡时**不跑**（跑测试套件归“待验收”阶段人点自检），传了也是"未判定"，会挡住"全过"。
⚠ 判据别写“效果更好”“体验流畅”这类话——那不是判据，收卡机检会判不了，卡的结论就是空话。

**⑥ 要架构图：用 `arch_generate`（2026-11-02 新增）**

需要某个项目的架构图（谁连着谁、入口在哪）→ 调方寸，不要自己在对话里画：

```
arch_generate { project: "fangcun-base", max_attempts: 2 }
```

- 方寸走**它自己的**生成链路：AI 按扫描事实画 → 每条节点/连线检查证据 → 不过按意见重画 → 仍不过降级扫描图；
- 返回 `source`：`ai` = 模型画且过审；`scan` = 降级扫描图（`reason` 写为什么，例如没配模型）；
- 返回 `issues`（哪条被拒、为什么）与 `notes`（不阻断的修正，例如标签被丢弃）；
- **会调用用户在方寸设置里配的模型（BYOK），每次调用产生花销**；返回体里带 `usage`，别重复计费；
- 图上的文件数/连线数一律来自扫描事实 —— 模型编不出数字，你也别替它编。

⚠ 想看**已经画好的**图（不花钱）用 `arch:get` 那条界面通道，或直接读 `arch_generate` 上一次的结果；
⚠ 不要为了"先看看"就调 `arch_generate` —— 那是一次真实模型调用。

**不知道数据根** → `get_data_dir`，**不要**在文件系统里猜（数据根可能被用户改到别处）。


**写操作规则**：
- `create_task` / `update_task` 等写操作通过 MCP 调用（桌面版已登录用户身份）
- 乐观锁：`update_task` 使用 `expected_update` 字段防止冲突
- `delete_task` = 移入 `.trash/`（可恢复），不是真删除

## 边界

- 只通过 MCP 读写方寸数据；不直接改 `task-data/*.md`（绕过乐观锁与审计）
- 数据根不确定时先 `get_data_dir` 确认，不要在文件系统里猜目录（数据根可能被用户改到别处）

## 绒花墨坊（NovelForge）

绒花墨坊**无 MCP 层**。操作接入走 **`ronghuamofang` 技能卡**
（`skills/worldbuilding/ronghuamofang/`）—— 本节只留接线口径，细节以那张卡为准。

仓库根**不写死**（路径写死审计 2026-10-03，卡014）：从方寸数据根下的 `registry.yaml`
里读绒花墨坊条目的 `repo` 字段作为 `<NF_ROOT>`，别把本机路径抄死在卡里。

```bash
# 只读自检（<NF_ROOT> = registry.yaml 绒花墨坊 repo 字段）
cd <NF_ROOT> && .venv/Scripts/python.exe scripts/nfctl.py check
# 全景
.venv/Scripts/python.exe scripts/nfctl.py status
```

## 纪律

1. **调用前先自检**：入口 A 的 pipe 不存在 / CLI 无响应 → 停止，告诉用户“方寸桌面版未运行，请重启”（入口 B 不依赖桌面版，不受此限）
2. **不静默回退**：连接失败 ≠ 数据为空。报错比假装没有更安全
3. **工具清单看卡里的生成表，不要去读 `tools.ts`**（2026-10-29 暮雨第 9 条：
   “每次都查一堆东西，极度浪费 TOKEN”）。那张表由 `node scripts/gen-skill-tools.cjs` 从源码生成，
   `--check` 可核对是否落后；落后就重跑，别手改。
