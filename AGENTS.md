# AGENTS.md — 方寸 (tegula)

**零依赖本地多 agent 任务看板**（Python stdlib；`tegula/` 包 = `cli.py` ~1884 + `core.py` ~4093 + `web.py`，`tegula.py` 只是 20 行 wrapper；看板用 http.server，端口 8753）。暮雨全部项目的统一任务入口。

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

## 验证矩阵（2026-09-22 扩充）

| 层 | 命令 | 抓什么 |
|---|---|---|
| 数据层 | `python verify.py` | 解析/渲染/乐观锁/备份（224） |
| 主进程 e2e（Node + electron 桩） | `node scripts/test/e2e-{backup,task-fields,notifications,datadir,applog,launchpad,logs}.cjs` | 备份链路、字段一致性、通知、数据根、**应用日志与 IPC 守卫**、**启动台执行器**、**执行日志（改项目/清理超期）** |
| 渲染层纯逻辑 | `node scripts/test/e2e-calendar.cjs` | 日历跨月/时间段算术（tsc 编 calendar.ts 后直接断言） |
| 渲染层真点击 | `node scripts/test/e2e-renderer.cjs` | **真 Electron 跑 dist/renderer + 真点按钮**（需桌面会话；受限环境自动 SKIP） |
| 静态守卫 | `check-ipc-parity` / **`check-template-bindings`（三项）** / `check-button-styles` | 僵尸按钮·僵尸通道·未接线模块·模板未声明标识符·**脚本内调用未定义函数**·**定义但零引用的死函数（漏接入口）**·按钮用了 class 却无全局样式 |
| 构建 | `cd desktop && npm run build` | sync-public-tools + vite + tsc(main/cli) 零错误 |

> ⚠ **开发态改主进程/preload 必须重启 Electron**。`npm run dev` 的 `dev:electron` 已是
> `scripts/dev-electron-watch.cjs`：监听 `dist/**`（排除 renderer）自动重启 ——
> 因为渲染层走 vite 会热更、主进程只在启动时读一次，否则会出现"界面是新的、通道是旧的"
> 这种极具欺骗性的状态（2026-09-22 用户第 1/3 条的真因）。
> `--dry` 参数可用占位子进程验证重启逻辑。

> ⚠ `e2e-renderer.cjs` 在无窗口/受限环境会以 `RESULT SKIP` 结束（网络服务被限制，任何非 data: 页面加载都 ERR_FAILED）。
> 那是**环境不可用**，不是通过也不是失败；请在有桌面会话的机器上跑。

## 架构速查 (Quick Facts)

> 慢变量事实层。运行期产物（project-status.md 等）会变，不在此维护。

- **包结构**: `tegula.py` 是 20 行 wrapper → `tegula/cli.py`（~1884 行，cmd_* 函数按子命令命名）+ `tegula/core.py`（~4093 行，数据层 + API）+ `tegula/web.py`（HTTP/看板/托盘）；另有 `tegula_planning.py` / `tegula_llm.py` 两个顶层模块
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
| cli.py 行数 | ~1884（`tegula.py` 仅 20 行 wrapper） | `wc -l tegula.py tegula/*.py` |
| core.py 行数 | ~4093 | 同上 |
| 子命令数 | 54 | `grep -c "add_parser" tegula/cli.py` |
| 状态值数 | 7 | 看 `STATUSES` 常量（`tegula/core.py`） |
| registry 项目数 | 13（projects 12 + released 1） | `grep -c "id:" registry.yaml` |
| 回归断言数 | verify.py **224** / e2e **九套（69+118+81+8+24+13+50+28+32）** + 三类静态守卫 | `python verify.py \| tail -1` |
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
- `verify.py` ~938 行 = 数据层回归（10 个检查组）
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

