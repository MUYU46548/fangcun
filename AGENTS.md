# AGENTS.md — 方寸 (tegula)

**零依赖本地多 agent 任务看板**（Python stdlib，约 5500 行单文件 CLI `tegula.py` + http.server 看板视图，端口 8753）。暮雨全部项目的统一任务入口。

## 技术栈

- Python 3 标准库（零外部依赖）：http.server + ThreadingHTTPServer 视图服务
- 数据：`task-data/` Markdown + YAML frontmatter 任务文件（**不入 git**）
- 注册表：`registry.yaml`（项目登记，改此文件即加项目，无需改代码）

## 常用命令 (Common Commands)

- 看板视图（Edge 应用窗口，关窗自退）: `tegula open` / 双击 `方寸看板.bat`
- 看板服务（纯网页，端口 **8753**）: `tegula serve` / 双击 `tegula-serve.bat`
- 命令行入口: `python E:/CODE/CangKu/fangcun/tegula.py <子命令>`（bash 下也可用根目录 `./tegula` wrapper）
- 子命令: `new` / `dispatch` / `hermes-sync` / `hermes-open` / `done` / `open` / `serve` / `backup` / `doctor` / `status` / `report`（`--brief`）/ 详见 `tegula.py main()` argparse
- 回归基线: `python verify.py`（数据层 10+ 项检查：frontmatter 往返保真/乐观锁/gen_id 碰撞/备份/活动日志等；**凡改解析/渲染必跑**）

## 架构速查 (Quick Facts)

> 慢变量事实层。运行期产物（project-status.md 等）会变，不在此维护。

- **单文件架构**: 主逻辑几乎全部在 `tegula.py`（~5500 行，cmd_* 函数按子命令命名），无 src 树
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
| 主文件行数 | ~5500 | `wc -l tegula.py` |
| 子命令数 | 37 | `grep -c "add_parser" tegula.py` |
| 状态值数 | 7 | 看 `STATUSES` 常量 |
| registry 项目数 | 12（projects 10 + released 2） | `grep -c "id:" registry.yaml` |
| 回归用例组 | ≥8 | `grep -c "def check" verify.py` |
| 看板端口 | 8753 | `grep -n "8753" tegula.py tegula-serve.bat` |

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
- `scan_project_status(p)` = 对应感知函数（tegula.py 内）

## 重要约束

- **零依赖红线**：不引入 pip 包/数据库/前端框架；视图服务就是 http.server + 轮询
- **task-data 与代码分割**：任务内容永不入 git（.gitignore 配置 pattern 拦截时间戳_hex 大文件）
- **回归铁律**：改 tegula.py 解析/写入逻辑 → 必跑 `python verify.py` 全绿才算完
- fangcun 本体未正式投用/未公开（2026-09），结构改动自由度高，但仍走 verify.py 基线

## docs/ 与杂项

- `docs/tegula-architecture.*` = Archify 架构图生成物（HTML/JSON/视觉验证快照）
- `docs/pv-check*` = 项目视图手动验证产物；`references/` = 重设计对比稿
- `verify.py` ~938 行 = 数据层回归（10 个检查组）
- `scripts/smoke_pythonw.py` = 看板冒烟测试（pythonw 场景）
