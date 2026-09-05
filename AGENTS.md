# 方寸 (tegula) — Agent 协作任务地图 · 协议文档

## 这是什么
方寸是一个**本地优先、文件即数据**的多 agent 任务协作层。
- 它是"地图"：告诉你任务是什么、状态在哪、资源在哪。
- 它**不碰执行引擎**：资料怎么查、代码怎么跑、数据库怎么检索，由接入的 agent（Hermes / DeepSeek Harness / ZCode / Workbuddy 等）用自己的能力完成。
- 唯一数据层是 `task-data/` 下的 Markdown 文件（frontmatter + 正文）。没有数据库、没有网关 API。

## 数据层位置
- 任务仓库根：`E:/CODE/CangKu/fangcun/`
- 任务文件目录：`task-data/`（**使用数据，不入代码库 git**，见下方分割规则）
- 每**一个任务 = 一个 `.md` 文件**。文件名建议 `task-<日期>-<序号>.md`。
- 项目注册表：`registry.yaml`（仓库根，属配置，随代码入库）
- 本文件：`AGENTS.md`（协议即文档，新 agent 进场先读这个）

### 数据/代码分割规则（红线）
- `task-data/` 下的一切（任务、归档、回收站）是**用户使用数据**：不提交、不随代码发布、代码侧 .gitignore 永久排除。
- 代码本体（tegula.py / templates/ / AGENTS.md / registry.yaml / 启动器）随 git 管理。
- 理由：任务内容是隐私工作数据，git 历史混入使用数据会导致仓库泄漏与无限膨胀。

## 任务文件格式
```markdown
---
id: task-20260828-001
标题: 核查用户模块文档与代码一致性
项目: [后台系统]          # 列表，天然支持跨项目联动
状态: 待审批
来源: hermes              # 谁发起的
指派: hermes              # 谁执行——多 agent 信箱路由靠它
验收: 暮雨               # 谁验收（人验收时写验收人名）
截止: 09-10               # 可空
优先级: 高                # 可空
批次: A                   # 可空；批量行动分组标签
资源:                     # 只指路，不执行
  资料: ~/docs/user-module/
  工具: [grep, pytest]
标签: [重要]              # 未知自由字段：方寸不做解释，原样保留
---
## 方案
- [ ] 对照接口文档检查 handler 签名
- [ ] 列出不一致项
## 结果记录
（执行后由执行方填写）

> [!note] 正文与字段扩展
> frontmatter 可自由增加未知字段（方寸序列化时原样透传，不解释不丢弃）；
> 正文里 `## 结果记录` 之外的小节（如 `## 备注`）也原位保留，不会被编辑操作吞并。
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
| `截止` | string | 截止日期，自由格式（如 `09-10`），可空 | 创建者 |
| `优先级` | string | 高 / 中 / 低，可空 | 创建者 |
| `批次` | string | 批量行动分组标签（如 A/B/C），可空 | 创建者 |
| `创建` | string | 创建时间（epoch 秒）；新建时由方寸打戳，只补缺不覆盖 | 方寸自动 |
| `更新` | string | 最后写入时间（epoch 秒）；方寸每次写文件都重新打戳，**兼作乐观锁版本号** | 方寸自动 |
| `资源` | map | 仅指路：`资料`(路径)、`工具`(可用工具列表) | 创建者 |
| 其他字段 | 任意 | 未知字段**原样透传**：解析保留、序列化原样回写，方寸不解释 | 任意 agent/人 |

> frontmatter 序列化为**白名单 + 透传**：受管字段（id/标题/项目/状态/批次/截止/优先级/创建/更新/来源/指派/验收/资源）由方寸管理；其余未知字段保留键序原样回写。外部 agent 加字段不会在下次保存时丢失。

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

### 完工回写（闭环）
执行方完成任务后**必须回写**，不得只口头汇报：
```bash
python "E:/CODE/CangKu/fangcun/tegula.py" done task-XXXXXXXX-NNN --结果 "一句话结果"
```
- 命令把结果追加进 `结果记录` 并将 `状态` 置为 `待验收`，验收方在看板看到后自行推进/驳回。
- 派活命令（看板 ⚡ / `tegula.py dispatch` / `hermes-open`）已把回写指令自包含在 prompt 里，执行方照做即可。
- 可选加 `--expected-mtime <读到的mtime>` 做防覆盖校验（文件被并发修改时拒绝写入）。

### 派活（执行入口）
```bash
python "E:/CODE/CangKu/fangcun/tegula.py" dispatch              # 派最高优先级的待办一个
python "E:/CODE/CangKu/fangcun/tegula.py" dispatch --all        # 派全部待办（各起新终端窗口）
python "E:/CODE/CangKu/fangcun/tegula.py" dispatch task-YYYYMMDD-NNN
```
- 看板等价操作：顶栏/详情/卡片上的 **⚡ 派活** 按钮（新终端窗口拉起 `hermes chat --in <repo>`）。
- 派活后任务 `状态` 自动置 `进行中`。已在终态（完成/驳回）的任务拒绝派活。

### 并发写防护（乐观锁）
- GUI 的编辑/勾选/拖拽携带 `expected_update`（frontmatter `更新` 版本号）；服务端版本不符即拒绝并要求刷新，后写者不再静默覆盖先写者。
- 无 `更新` 字段的旧文件自动回退用文件 mtime 做版本（`expected_mtime`）；首次被方寸写入后即有版本号。
- 外部 agent 直接改文件不受影响；用 CLI `done --expected-mtime` 可获得同等保护。
- 编辑保存遇冲突时**表单内容不丢失**，弹窗提示刷新核对后自行取舍。

### 派活日志与备份（审计/兜底）
- `task-data/.activity.log`：每次派活（dispatch/dry-dispatch）、完工回写（done）、备份（backup）追加一行 `ISO时间 | 动作 | 任务id | 详情`；任务详情面板展示该任务的派活记录。
- `python tegula.py backup`：task-data/ 整体打 zip 到 `backups/`（排除 `.trash/` 与 `.tmp`），保留最近 10 份，轮换自动删旧。使用数据不入 git，这是唯一的兜底副本。

## 数据完整性（铁律）
1. **原子写**：先写临时文件 `.<name>.tmp`，写完后 `rename` 覆盖目标。禁止就地 truncate 改写。
2. **不删历史**：禁止删除任务文件；作废请用状态字段表达，文件保留（GUI 的删除=移入 `.trash/` 可还原）。
3. **数据不入 git**：`task-data/` 是使用数据，已被 .gitignore 排除；只有代码本体提交。
4. **字段所有权**：
   - 人写：`状态`、`方案`勾选、审批决策
   - agent 写：`结果记录`、`资源`补充、执行日志
   - 同一任务一文件；**跨写入方并发修改靠 mtime 乐观锁防护**（见上节），直接改文件的工具不受锁限制，但应遵守先读后写。
5. **无损往返**：解析→序列化不得丢弃任何 frontmatter 字段或正文小节；`verify.py` 是回归基线，改动解析/渲染后必须跑。

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
