---
name: fangcun-bridge
description: 方寸（tegula）↔ 任意 agent 接线卡（agent 中立）。要查询/修改方寸任务、读项目状态或阻塞链时加载：两个 stdio 入口选型、named pipe 自检、工具边界、写操作规则。
version: 1.5.0
metadata:
  hermes:
    tags: [fangcun, 方寸, mcp, bridge, 接线卡]
    category: integration
---

# 方寸（tegula）agent 接线卡

**仓库真源**：`fangcun/skills/fangcun-bridge/SKILL.md`（本文件是它的副本）。

本卡 **agent 中立**：DSH / Claude Code / Cursor / OpenCode / Codex / Hermes 通用。
各家落点不同（技能目录与配置文件位置由各家自己的文档规定，方寸不猜、不代写）：
方寸桌面版设置页「接入其他 Agent」提供**按本机安装路径生成的配置段 + 一键复制 + 打开目标文件**按钮。
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

stdio 桥 = **方寸自己的可执行文件以「纯 node 模式」跑包内桥脚本**（2026-10-18 最终形态）：

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
> 也**不要**指望「Electron 主进程里自己收发 stdio」：GUI 模式会拉起 GPU 进程，崩到阈值就 FATAL。

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
   逐家打印「通了 / 卡在哪」。也可单独验一家：
   ```bash
   node <fangcun>/scripts/test/probe-mcp-bridge.cjs "<方寸.exe 完整路径>" [--mcp-bridge]
   ```
   ⚠ **不要用 `echo '{...}' | 方寸.exe --mcp-bridge` 这种一次性管道做自检**（2026-10-18 实测）：
   exe 类入口启动要 300ms+，`echo` 的 stdin 在那之前就 EOF，消息直接丢，输出恒为空
   —— 看起来像"桥坏了"，其实是启动竞态。要验就连着 stdin 发（probe 脚本就是这么做的）。
   报「方寸桌面版没有在运行」或超时 → 桌面版未启动或 pipe 未就绪，**停止调用并报错**，不静默回退。
2. **入口 B**：直接发一条 `tools/list`，期望返回只读工具列表。

## 工具清单（真源 `desktop/src/main/mcp/tools.ts`，下面是快照）

**读**：`list_tasks` / `search_tasks` / `get_task` / `list_projects` / `get_project_status` /
`find_blockers` / `scan_services` / `get_roadmap` / `get_data_dir` / `plan_list` / `plan_get` / `plan_pending` / `gate_list`
`list_logs` / `search_logs` / `get_log` — 执行日志读取（拿日志 ID 直接 `get_log` 取，不必整篇注入）
`rice_pool_list` — 需求矩阵池（现算 RICE 分数与等级；池文件 `task-data/rice-pool.md`）

**写**（仅入口 A）：`create_task` / `update_task` / `move_status` / `delete_task`
`rice_pool_upsert`（幂等：同 eid 覆盖分数/备注/打分，保留拍板与决策id；拒该条不拒整批）
`decision_record`（拍板落 decisions.md 并回填池条目；**这是用户动作，agent 不得代拍**）

> 快照会滞后。以 tools.ts 为准；新增工具后回来补这一行。
> 入口 B（`python tegula.py mcp`）只含上面的**读**工具。

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

1. **调用前先自检**：入口 A 的 pipe 不存在 / CLI 无响应 → 停止，告诉用户「方寸桌面版未运行，请重启」（入口 B 不依赖桌面版，不受此限）
2. **不静默回退**：连接失败 ≠ 数据为空。报错比假装没有更安全
3. **工具清单现场读**：`desktop/src/main/mcp/tools.ts` 是唯一真源，skill 不维护工具列表快照
