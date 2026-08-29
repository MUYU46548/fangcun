# 方寸 (tegula) — Agent 协作任务地图 · 协议文档

## 这是什么
方寸是一个**本地优先、文件即数据**的多 agent 任务协作层。
- 它是"地图"：告诉你任务是什么、状态在哪、资源在哪。
- 它**不碰执行引擎**：资料怎么查、代码怎么跑、数据库怎么检索，由接入的 agent（Hermes / DeepSeek Harness / ZCode / Workbuddy 等）用自己的能力完成。
- 唯一数据层是 `task-data/` 下的 Markdown 文件（frontmatter + 正文）。没有数据库、没有网关 API。

## 数据层位置
- 任务仓库根：`E:/CODE/CangKu/fangcun/`
- 任务文件目录：`task-data/`
- 每**一个任务 = 一个 `.md` 文件**。文件名建议 `task-<日期>-<序号>.md`。
- 项目注册表：`registry.yaml`（仓库根）
- 本文件：`AGENTS.md`（协议即文档，新 agent 进场先读这个）

## 任务文件格式
```markdown
---
id: task-20260828-001
标题: 核查用户模块文档与代码一致性
项目: [后台系统]          # 列表，天然支持跨项目联动
状态: 待审批
来源: hermes              # 谁发起的
指派: hermes              # 谁执行——多 agent 信箱路由靠它
验收: human               # 谁验收
资源:                     # 只指路，不执行
  资料: ~/docs/user-module/
  工具: [grep, pytest]
---
## 方案
- [ ] 对照接口文档检查 handler 签名
- [ ] 列出不一致项
## 结果记录
（执行后由执行方填写）
```

### frontmatter 字段含义
| 字段 | 类型 | 含义 | 谁写 |
|---|---|---|---|
| `id` | string | 全局唯一任务号，格式 `task-YYYYMMDD-NNN` | 创建时生成 |
| `标题` | string | 一句话任务描述 | 创建者 |
| `项目` | list[string] | 所属项目 id 列表（见 registry.yaml） | 创建者 |
| `状态` | enum | 见状态机 | 人（GUI）/ 流程 |
| `来源` | string | 发起人/框架标识（hermes / zcode / workbuddy / human） | 创建时 |
| `指派` | string | 执行方标识；信箱路由目标 | 派发方 |
| `验收` | string | 验收方标识（human / 某 agent） | 创建者 |
| `资源` | map | 仅指路：`资料`(路径)、`工具`(可用工具列表) | 创建者 |

### 合法状态值（状态机）
```
草稿 → 待审批 → 待办 → 进行中 → 待验收 → 完成
                                  ↘ 驳回 →(退回 待办/草稿)
```
- 草稿：刚建，方案未定
- 待审批：某 agent 写好方案草稿，等人批准
- 待办：已批准，等待执行方接单
- 进行中：执行方已领取
- 待验收：执行方交付，等验收方确认
- 完成 / 驳回：终态

### 写入规则（铁律）
1. **原子写**：先写临时文件 `.<name>.tmp`，写完后 `rename` 覆盖目标。禁止就地 truncate 改写。
2. **不删历史**：禁止删除任务文件；作废请用状态字段表达，文件保留。
3. **建议 git commit**：改完建议 `git commit`（Hermes 侧自动；外部 harness 不强求必须有 git）。
4. **字段所有权**：
   - 人写：`状态`、`方案`勾选、审批决策
   - agent 写：`结果记录`、`资源`补充、执行日志
   - 同一任务一文件，天然隔离人/agent 并发写

### 资源约定
`资源` 字段**只指路，不执行**。执行方读到此字段，自行决定如何调用本地工具/检索数据源。方寸工具本身不调用任何外部工具。

## 项目注册表 registry.yaml
```yaml
projects:
  - id: backend
    name: 后台系统
    tasks: ~/task-data/后台系统/   # 该项目任务子目录（可选，可共用根目录）
    repo: ~/code/backend           # 关联代码仓库
    tools: [pytest, grep]          # 该项目可用本地工具提示
    sources: [local:sqlite:app.db] # 可检索数据源
```
- `id` 用于任务 `项目` 字段引用。
- 新项目在此登记即可，无需改代码。

## 外部 Agent 接入约定
任何新 agent（Hermes / DeepSeek Harness / ZCode / Workbuddy 等）进场只需：
1. 读 `AGENTS.md`（本文件）理解协议；
2. 读 `registry.yaml` 了解项目与可用资源；
3. 用自身文件读写能力操作 `task-data/*.md`：
   - 读任务 → 看 `指派` 是否指向自己、`状态` 是否可接；
   - 写结果 → 填 `结果记录`、推进 `状态`；
   - 派发给他方 → 写目标 agent 的 `指派` 并置 `状态: 待审批/待办`。
4. 无需任何网关、无需专用 SDK。文件即接口。

## 信箱约定（未来，多 agent 阶段启用）
```
task-data/mailbox/
  <agent-id>/
    inbox/    # 收到的任务（被指派给它的任务镜像/索引）
    outbox/  # 它交付的成果
```
- 发派 = 在对方 inbox 写文件 + 置 `状态: 待接单`；
- 验收 = 读对方 outbox + 通过/驳回。
- 现阶段一行代码不用写，只需保证上方字段已预留。

## 命令别名（可选）
```bash
# 加入 ~/.bashrc 或 git-bash 启动配置：
alias tegula='python "E:/CODE/CangKu/fangcun/tegula.py"'
# 之后即可：tegula new --title "..." / tegula serve
```

## 边界纪律
方寸只做"地图"。资料核查、数据库检索、工具调用——那是对接 agent 自带的能力。方寸碰了，你就得维护两套执行引擎。千万别膨胀成"再造一个 Hermes 平台"。
