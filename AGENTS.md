# 方寸 (Tegula)

**零依赖本地多 agent 任务看板**（Python stdlib；`tegula/` 包 = `cli.py` 1991 + `core.py` 4231 + `web.py` 711，`tegula.py` 只是 19 行 wrapper；看板用 http.server，端口 8753）。为您创造全部项目的统一任务入口。

## 技术栈

- Python 3 标准库（零外部依赖）：http.server + ThreadingHTTPServer 视图服务
- 数据：`task-data/` Markdown + YAML frontmatter 任务文件（**不入 git**）
- 注册表：`registry.yaml`（项目登记，改此文件即加项目，无需改代码）

## 常用命令 (Common Commands)

- 看板视图（Edge 应用窗口，关窗自退）: `tegula open` / 双击 `方寸看板.bat`
- 看板服务（纯网页，端口 **8753**）: `tegula serve` / 双击 `tegula-serve.bat`
- 命令行入口: `python E:/CODE/CangKu/fangcun/tegula.py <子命令>`（bash 下也可用根目录 `./tegula` wrapper）
- 子命令: `next`（agent 面：取活 + 带出项目方针卡）/ `new` / `dispatch` / `hermes-sync` / `hermes-open` / `done` / `open` / `serve` / `backup` / `doctor` / `status` / `report`（`--brief`）/ 详见 `tegula/cli.py main()` argparse
- 回归基线: `python verify.py`（数据层 10+ 项检查：frontmatter 往返保真/乐观锁/gen_id 碰撞/备份/活动日志等；**凡改解析/渲染必跑**）
- 进度总览: `python scripts/gen-progress.py` —— 从 `task-data/*.md` 的**状态字段**汇总成一张总览表，
  写进 `开发日志.md` 顶部的 AUTO 区（另可 `--also <path>` 导出独立文件）。**它存在的理由**：开发日志是流水账，
  用户看不出"哪些做了哪些没做"（2026-09-26 原话），状态字段才是唯一权威来源，脚本只汇总不改状态

## 常用验证方式

仅供开发者参考，日常使用请忽略。

| 层 | 命令 | 作用 |
|---|---|---|
| 数据层 | `python verify.py` | 解析/渲染/乐观锁/备份/老 YAML 写法（**242**，24 个检查组） |
| 主进程 e2e（Node + electron 桩） | `node scripts/test/e2e-{backup,task-fields,notifications,datadir,applog,launchpad,logs}.cjs` | 备份链路、字段一致性、通知、数据根、**应用日志与 IPC 守卫**、**启动台执行器**、**执行日志（改项目/清理超期）** |
| 任务删除/归档健壮性 | `node scripts/test/e2e-task-delete.cjs` | **同名重复副本（archive/ 与 .trash/ 同 id）下 delete/archive/unarchive 不抛异常、幂等、去重；readTask 优先活跃区** |
| **装到别的 agent（目标检测 + 多目标安装）** | `node scripts/test/e2e-agent-targets.cjs` | **装卡区必须有 DSH（此前根本没有这一条 → 用户「检测不到 DSH 装了」的真因）**：DSH 落点 `~/.dsh/skills`、与 Hermes 同级可直装；「已接入」两问 = 技能副本 + MCP 配置含 fangcun，**落点不可知时给 `undefined` 而不是 `false`**；多目标安装各目标分账（不串目录）、未知目标显式报错；**DSH 不在场时不许给它造目录**；含反例（删掉 `~/.dsh` → `detected=false`） |
| **已完成任务自动归档（卡 012）** | `node scripts/test/e2e-archive-overdue.cjs` | 判据 =「状态=完成 **且** 更新时间早于 N 天」——刚动过的不收、非完成的不收、没写时间的退 mtime（不是"老得不能再老"）；**保留天数 0 = 关闭，默认必须关**；归档**真把文件移进 archive/**（不是只改状态那种假归档）且可逆；数字时间戳按**秒级**解析（毫秒写法跑到未来 → 不收，钉成负面案例） |
| 渲染层纯逻辑 | `node scripts/test/e2e-calendar.cjs` | 日历跨月/时间段算术（tsc 编 calendar.ts 后直接断言） |
| **渲染层纯逻辑（时间 / 分组）** | `node scripts/test/e2e-timefmt.cjs` / `e2e-grouping.cjs` | **时间解析：数据里同时有 ISO / 秒级 Unix 数字 / MM-DD 三种写法，坏输入必须给 `—` 而不是 Invalid Date/NaN**；**看板分组：标题必须是项目名而不是内部 id、跨项目计数、未归属任务不丢分组** |
| 渲染层真点击 | `node scripts/test/e2e-renderer.cjs` | **真 Electron 跑 dist/renderer + 真点按钮**（需桌面会话；受限环境自动 SKIP） |
| **渲染层 DOM（无头浏览器兜底）** | `node scripts/test/e2e-renderer-web.cjs` | **本机可跑的渲染层断言**：多视图互斥与几何、排序/视图选择落盘、弹药库派工单六字段 —— 用系统 Edge/Chrome 无头加载 `dist/renderer` + 同一份假 preload；产物必须单块（有顶层 import/export 会显式报错而不是静默降级）。它验不了真 IPC / 真点击，那些仍以 `e2e-renderer` 为准 |
| **IPC 载荷过 bridge** | `node scripts/test/e2e-bridge-clone.cjs` | **真 Electron + 真 preload：裸 Vue 代理过 contextBridge 必抛「could not be cloned」、过 `toPlain()` 后必通过；含精确静态守卫 + 红测自证** |
| **剪贴板复制** | `node scripts/test/e2e-clipboard.cjs` | **真 Electron + 真 preload + 真读回剪贴板：file:// 起源下的复制走主进程 IPC 通道成立；含「掐掉 IPC 后浏览器路径确实失败」的危害复现 + 静态守卫（渲染层不得再有裸 `navigator.clipboard`）** |
| **UI 偏好持久化** | `node scripts/test/e2e-prefs.cjs` | **Agent 预设真身在 `userData/prefs.json`：合并写入·原子替换·坏文件回退；要害断言＝模拟换 origin（localStorage 清空）后清模块缓存重载，值仍在磁盘上** |
| **端口/服务登记** | `node scripts/test/e2e-ports.cjs` | **真起 TCP 监听，断言 netstat+tasklist 对表读出的 PID 就是本进程**；登记源（apps.json port + 手填清单）合并·重复端口预警·坏文件不静默·未登记列表两道路滤网（端口段 + 像服务的进程白名单）·**实现里不许有杀进程能力（源码扫描断言）**；一键启动只认启动台登记过带 port 的应用 |
| **技能直接导入** | `node scripts/test/e2e-skill-import.cjs` | 文件夹 / .zip（含目录条目 + deflate）/ 外壳目录 / 单 .md 四种输入；缺 SKILL.md、YAML 缺字段、zip slip **一律零写入**；重名默认拒绝、方寸自发布技能永不被覆盖；移除只认带导入标记的目录 |
| 静态守卫 | `check-ipc-parity` / **`check-template-bindings`（三项）** / `check-button-styles` / `check-themes` / **`check-skills`（改技能必跑）** | 僵尸按钮·僵尸通道·未接线模块·模板未声明标识符·**脚本内调用未定义函数**·**定义但零引用的死函数（漏接入口）**·按钮用了 class 却无全局样式·主题对比度·**技能版本漂移与副本分叉** |
| **frontmatter 跨语言契约（改写盘必跑）** | `node scripts/test/e2e-fm-contract.cjs` | **TS 与 Python 读同一份 `task-data/*.md` / `docs/执行日志/*.md`**：块式列表、行内列表、引号、空值两个方向各走一遍 —— 首跑即抓到 `_parse_log` 把块式 `附件:` 读成空串（＝下次写回静默清空）；源码守卫：TS 日志 `yaml.dump` 必须带 `flowLevel:-1`（列表一律内联）、TS 任务写盘仍走 yaml.dump |
| **MCP 读口契约** | `node scripts/test/e2e-mcp-views.cjs` | **真跑编译产物 `dist/main/mcp/tools.js` + 临时数据目录**（纯 Node 下 `setDataDir` 的持久化分支被 try/catch 吞掉，不会动真实数据目录）：`view=trash` 必须返回回收站而不是活跃+归档、`search_tasks` 必须能搜到归档、`project` 过滤对数组字段生效；源码守卫：禁止私有读扫描回潮 |
| **主题对比度（多主题后必跑）** | `node scripts/test/check-themes.cjs` | 六套浅色主题**逐套实测 13 对 WCAG 对比度**（正文压底 / 次要文字 / 白字压品牌色 ≥4.5），并把 `THEME_LIST` 与 CSS `:root[data-theme]` 块对表；漏主题、令牌自指、对比度掉档一律红 |
| **技能真源一致性（改技能必跑）** | `node scripts/test/check-skills.cjs` | **改 `skills/**` 或发版时必跑**：`manifest.version` 必须等于 `desktop/package.json` 版本；每个技能 `frontmatter.version` 必须等于 manifest 登记值（**防版本号漂移** —— 首跑就抓到 fangcun-bridge 写着 1.2.0 而 manifest 记 1.3.0）；`frontmatter.name` 必须等于 id；`docs/agents/<id>/` 副本与真源**逐字节一致**（防两处分叉）；有 SKILL.md 却没登记的目录必须报出来。顺带打印每个技能 md5（人工对账用） |
| 构建 | `cd desktop && npm run build` | sync-public-tools + vite + tsc(main/cli) 零错误 |

> ⚠ **开发态改主进程/preload 必须重启 Electron**。`npm run dev` 的 `dev:electron` 已是
> `scripts/dev-electron-watch.cjs`：监听 `dist/**`（排除 renderer）自动重启 ——
> 因为渲染层走 vite 会热更、主进程只在启动时读一次，否则会出现"界面是新的、通道是旧的"
> 这种极具欺骗性的状态（2026-09-22 用户第 1/3 条的真因）。
> `--dry` 参数可用占位子进程验证重启逻辑。

> ⚠ `e2e-renderer.cjs` 在无窗口/受限环境会以 `RESULT SKIP` 结束（网络服务被限制，任何非 data: 页面加载都 ERR_FAILED）。
> 那是**环境不可用**，不是通过也不是失败；请在有桌面会话的机器上跑。

> ✅ **2026-09-25 已修复（此前两条红是测试自身/类型缺陷，不是产品坏）**
> - `e2e-calendar.cjs`：根因是 `buildMonth<T, D, L>` 的 **`D`/`L` 只写了默认值、没加 `extends` 约束**
>   → 函数体里 `td.done/log.status/...` 全 TS2339 → `tsc calendar.ts` 编译不过 → 本套自 09-23 起从未跑起来
>   （跨月/时间段算术**一直无回归保护**）。已补 `D extends CalTodoLike` / `L extends CalLogLike`
>   并把 `CalEvent<T,D>`/`CalMonthResult.cells` 等漏掉 L 的泛型补齐。**现 50/0。**
> - `e2e-logs.cjs`：`logs.createLog()` 早已改为返回 `{ok,data,error}`，而测试仍按旧签名取 `a.id`
>   → `undefined` → `getLog(undefined)` 返回 null → 第 52 行 TypeError。**产品侧语义是对的**
>   （非 active 拒改、只改状态不删文件都验证通过）。已把测试对齐新签名。**现 31/0。**
> 上面「回归断言数」里的两个数此前**拿不到**，现已并入绿灯。
> **2026-10-03 22:02 实测（本机口径，`spawnSync`/`execFileSync` 一律 EBUSY）**：
> **本机可跑 15 套全绿合计 900**（agent-targets24 · applog31 · archive-overdue19 · bridge-clone5 · clipboard8 ·
> launchpad17 · logs189 · **mcp-connect67** · ports57 · prefs41 · **renderer-web217** · skill-import48 · skills55 ·
> task-delete93 · todos29）+ `policies` **24/25**（1 条 `spawnSync python EBUSY`）+ `verify.py` **242/0** +
> **五守卫 43**（ipc4 · bindings1 · buttons5 · themes14 · **skills19**）→ **合计 1209**。
> 另 9 套因**本机 spawn 子进程 EBUSY** 跑不起来（**不是回归**）：calendar / datadir / notifications /
> task-fields / logdedupe / fm-contract / grouping / timefmt / mcp-views；`e2e-backup`、`e2e-renderer` 另需环境。
> 本轮新增 4 处可跑断言：`e2e-agent-targets`（24）、`e2e-archive-overdue`（19）、`check-skills`（19）、
> `renderer-web` **167→217**；`mcp-connect` **58→67**（WorkBuddy 目标）。
> —— 09-30 那次「20 套全绿 1041」是按当时同口径记录的，数字对不上是因为**环境**（spawn 可用性）变了，不是产品退化。
> 本机实测（2026-09-30 11:30 重跑）：**20 套全绿、合计 1041 断言**（09-30 11:30：1032 + 四卡修复断言 9 = 1041；09-29 同口径 955），
> 其中 `calendar / timefmt / logdedupe / grouping / policies` 本机也能跑了
> （此前「恒 EBUSY / 需桌面会话」的限制不再复现）。**仍需桌面会话的只剩 `e2e-renderer`（真 Electron）**：
> 2026-09-29 本机首次真跑通 294/12；**2026-09-30 对齐归档分区头过期断言后 298 / 8** —— 余 8 条红**全在改动面之外**
> （完成驳回折叠/悬停轻提示/待办分区头/网格三连/遮罩+AA×2；`.card-date.dim` 3.18 那条已开卡 007），
> 逐条对照见开发日志 09-29「e2e-renderer 首跑」与 09-30 第 34/35 轮。`backup` 仍未跑。
> 新增守卫 `check-themes.cjs`（14 条，逐主题 WCAG 对比度）见下方测试表。

> ✅ 2026-09-29 起，渲染层断言有了**本机可跑**的兜底：`node scripts/test/e2e-renderer-web.cjs`
>    （系统 Edge/Chrome 无头 + 真构建产物 + 同一份假 preload）。它不能替代 `e2e-renderer` 的真点击，
>    但能让"改了渲染层却本机验不了"这件事不再发生。

## 架构速查 (Quick Facts)

> 慢变量事实层。运行期产物（project-status.md 等）会变，不在此维护。

- **包结构**: `tegula.py` 是 19 行 wrapper → `tegula/cli.py`（1991 行，cmd_* 函数按子命令命名）+ `tegula/core.py`（4231 行，数据层 + API）+ `tegula/web.py`（711 行，HTTP/看板/托盘）；另有 `tegula_planning.py` / `tegula_llm.py` 两个顶层模块
- **数据流**: `registry.yaml`（项目登记）+ `task-data/*.md`（任务，frontmatter 含 状态/成员/expected_update 锁）→ `tegula.py` 读写 → 看板 `templates/board.html`（零依赖轮询渲染）+ `project-status.md`（`tegula report` 覆盖式生成）
- **状态机**: 草稿→待审批→待办→进行中→待验收→完成（+驳回），定义在 `tegula.py` 顶部 `STATUSES`
- **并发纪律**: mtime 乐观锁 + `expected_update` 版本字段（verify.py 检查项 3）；无数据库，文件即数据
- **成员**: `registry.yaml` 顶部 `members:`（hermes/human/暮雨），页面设置可增删
- **项目注册三类**: `projects:`（活跃）/ 文件内注释说明跳过项 / `released:`（已稳定，报告折叠不参与活跃排序）
- **派活模式 B**（2026-09-06 定案）: `dispatch` 默认只生成命令不拉起 agent，`--go` 保留旧自动拉起
- **Hermes 集成**: `hermes-sync` 幂等注册 registry 项目进 Hermes；派活命令形如 `hermes chat --in <repo>`
- **自检**: `tegula doctor`（只读：frontmatter/锁字段/阻塞引用健康检查）

## 锚点（读文档后先核对 2-3 个，不符以代码为准）

| 锚点 | 期望值 | 核对命令 |
|---|---|---|
| cli.py 行数 | ~1991（`tegula.py` 仅 19 行 wrapper） | `wc -l tegula.py tegula/*.py` |
| core.py 行数 | 4231 | 同上 |
| 子命令数 | 56 | `grep -c "add_parser" tegula/cli.py` |
| 状态值数 | 7 | 看 `STATUSES` 常量（`tegula/core.py`） |
| registry 项目数 | 13（projects 12 + released 1） | `grep -c "id:" registry.yaml` |
| 回归断言数 | verify.py **242** / e2e **27 套（本机可跑 15 套全绿 900；policies 24/25；9 套需 spawn 子进程→本机 EBUSY）**（2026-10-03 22:02 实测：agent-targets24 · applog31 · archive-overdue19 · bridge-clone5 · clipboard8 · launchpad17 · logs189 · mcp-connect67 · ports57 · prefs41 · **renderer-web217** · skill-import48 · skills55 · task-delete93 · todos29）+ **五守卫 43**（bindings1 · buttons5 · ipc4 · themes14 · **skills19**）；另真 Electron `e2e-renderer` 需桌面会话、`backup` 未跑 | `python verify.py \| tail -1` |
| 看板端口 | 8753 | `grep -n "8753" tegula/web.py tegula-serve.bat` |

## 派活与闭环（原规则保留）

- ⚡派活：新终端拉 `hermes chat`，任务状态置「进行中」
- done 回写闭环：任务完成必须回写看板，不留悬空状态
- unknown 字段与正文小节原样透传，不擅自增删结构

## 数据与并发（原规则保留）

- `task-data/` = 使用数据，不入 git；`backups/` = `tegula backup` 产物（zip，保留 10 份）
- mtime 乐观锁：写回前比对 mtime，冲突则重读后再改；frontmatter 更新用 `expected_update` 字段
- `activity.log`（task-data/.activity.log）= 派活审计日志

## 项目状态感知（原规则保留）

- `tegula status` = git 活动 + 任务关联健康度（active/stuck/dormant/idle/unknown）
- `tegula report` = 生成 `project-status.md`（覆盖式更新，供 Hermes 启动读取）；**运行期生成物，不入库**
- `scan_project_status(p)` = 对应感知函数（`tegula/core.py` 内）

## 重要约束

- **零依赖红线**：不引入 pip 包/数据库/前端框架；视图服务就是 http.server + 轮询
- **task-data 与代码分割**：任务内容永不入 git（.gitignore 配置 pattern 拦截时间戳_hex 大文件）
- **回归铁律**：改 `tegula/cli.py` 或 `tegula/core.py` 的解析/写入逻辑 → 必跑 `python verify.py` 全绿才算完；改 UI/IPC 再加跑 `node scripts/test/check-ipc-parity.cjs`
- fangcun 本体未正式投用/未公开（2026-09），结构改动自由度高，但仍走 verify.py 基线

## 开工流程（铁律）

每次会话开工，**必须先执行**：
1. `read_file(E:/CODE/CangKu/fangcun/开发日志.md)` — 读末条，了解上次做到哪
2. 本次工作中，完成阶段性进展后，**回填开发日志**
3. 不另立 STATUS.md，开发日志是唯一的过程记录



## docs/ 与杂项

- `docs/tegula-architecture.*` = Archify 架构图生成物（HTML/JSON/视觉验证快照）
- `docs/pv-check*` = 项目视图手动验证产物；`references/` = 重设计对比稿
- `verify.py` 1325 行 = 数据层回归（**24 个检查组**；第 23/24 组是 2026-09-28/29 新增的
  「老 YAML 写法」——块式列表 / 裸标量 / 块标量 / 前言嵌套映射，四类都会让写回静默毁数据）
- `scripts/smoke_pythonw.py` = 看板冒烟测试（pythonw 场景）
- `desktop/src/renderer/calendar.ts` = 日历纯逻辑（日期解析/时间段跨度/跨月分组），
  不依赖 Vue/DOM，因此可被 `e2e-calendar.cjs` 直接编译断言 —— 跨月边界错误肉眼抓不住，必须靠脚本
- `desktop/test/` = **渲染层 e2e 的 Electron 主进程 + 假 preload**，只测试用、不参与打包
  （必须放在 `desktop/` 下，否则 Electron 主进程 `require('electron')` 解析不到 node_modules）
- `desktop/src/main/services/appLog.ts` = 应用日志（`userData/logs/fangcun-YYYYMMDD.log`）。
  主进程全局兜底 + 所有 IPC 经 `guarded-ipc.ts` 包装落盘 + 渲染层错误经 preload 回报。
  **写日志永不抛**；日志目录不在数据目录内，因此不进备份包、不污染 `task-data/`
- `scripts/dev-electron-watch.cjs` = 开发态 Electron 启动器（主进程/preload 变更自动重启）。
  **它存在的唯一理由**：渲染层热更、主进程不热更，两者不同步会造出"改了没用"的假象

## Multi-Agent 接入（MCP 协议）

方寸桌面版暴露 **MCP (Model Context Protocol)** 服务，任何支持 MCP 的 agent 均可接入。

### 连接方式

```
命名管道: \\.\pipe\tegula-mcp
```

### MCP 工具清单

| 工具 | 说明 |
|---|---|
| `list_tasks` | 列出任务（按视图/项目/状态筛选） |
| `search_tasks` | 全文搜索 |
| `get_task` | 获取单任务详情 |
| `create_task` | 创建任务 |
| `update_task` | 更新任务字段 |
| `move_status` | 状态流转 |
| `delete_task` | 移入回收站 |
| `list_projects` | 列出项目 |
| `get_project_status` | 项目健康度 |
| `find_blockers` | 查找阻塞链 |
| `scan_services` | 检查服务状态 |
| `get_roadmap` | 路线图进度 |
| `plan_list/plan_get/plan_pending` | 规划管理 |
| `gate_list` | 验收门列表 |
| `list_logs` / `search_logs` / `get_log` | 执行日志：按 ID 定位 / 全文检索 / 单条读取（只读，2026-09-29 加） |

### 快速自检

```bash
ls \\.\pipe\\tegula-mcp 2>/dev/null && echo "MCP OK" || echo "MCP MISSING"
```

### 各 Agent 接入方式

| Agent | 接入方式 |
|---|---|
| **Claude Code** | MCP 原生支持 + `CLAUDE.md` 项目指令 |
| **Hermes** | MCP 原生 + `fangcun-bridge` skill |
| **Cursor** | MCP 原生 + `.cursorrules` 配置 |
| **OpenCode** | MCP 原生 |
| **Codex** | MCP 原生 |

### Hermes 专属优化

Hermes 用户可额外安装 `fangcun-bridge` skill 获取：
- 自动发现方寸桌面版是否运行
- Hermes 侧语义指南（何时用哪个工具）
- 错误处理最佳实践

安装：将 `docs/agents/fangcun-bridge/SKILL.md` 复制到 `~/.hermes/skills/` 后重载。

