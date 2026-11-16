# 派工单：给「绒花墨坊」写分层 spec

- 卡类型：数据整理（产出一份 JSON 文件，不改任何代码）
- 项目：绒花墨坊（`project-2`）
- 仓库根：`E:/CODE/CangKu/NovelForge`
- 产物落点：`task-data/layer-specs/project-2.json`（**方寸数据目录**，不是项目仓库）

## 1 任务目标

把「绒花墨坊」**自己声称的分层**写成一份 spec JSON，供方寸回答一个问题：

> 这个项目号称是 A，但 88% 的行数在 B。

⚠ 这句话**只能靠你判断**，因为「哪几层是一伙的」是项目的自我认知，不是目录结构。
方寸已经把**事实**算好了（下面第 3 节），你只需要做**归类与命名**。

## 2 工作目录 / 范围

- 只读项目仓库（**一个字都不许写进去**）：`E:/CODE/CangKu/NovelForge`
- 唯一允许写入的地方：方寸数据根的 `task-data/layer-specs/project-2.json`
- **不许改代码、不许改文档、不许 git 操作**

## 3 已经算好的事实（别自己重新数）

方寸扫盘结果：**产品 32,828 行**（全仓合计 191,698 行，含测试与脚本）。

> 口径：只数能解码成文本的文件（二进制不算）；排除依赖 / 构建产物 / 打包目录 /
> 内嵌运行时 / 隐藏目录。`.ts` 可能是 MPEG 视频分片，GBK 脚本是文本不是二进制 ——
> 这两条方寸已经处理过，**你不用再踩**。

| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |
|---|---|---:|---:|
| `tests/unit` | 测试 | 257 | 53,813 |
| `scripts` | 工具 | 77 | 34,794 |
| `scripts/utils` | 工具 | 119 | 32,848 |
| `console/src` | 产品 | 59 | 30,600 |
| `tests/e2e` | 测试 | 48 | 14,076 |
| `scripts/nf_api_domains` | 工具 | 31 | 10,394 |
| `tests/http` | 测试 | 29 | 7,496 |
| `scripts/utils/judge` | 工具 | 12 | 3,156 |
| `console/main` | 产品 | 3 | 2,012 |
| `scripts/utils/book_extract` | 工具 | 13 | 1,794 |
| `console/scripts` | 工具 | 3 | 383 |
| `console/tests` | 测试 | 1 | 116 |
| `console` | 产品 | 6 | 86 |
| `(根)` | 产品 | 2 | 68 |
| `console/preload` | 产品 | 1 | 62 |

### 被规则挡在分母外面的（方寸已排除，列出来让你知道）

- `.git` —— 版本库
- `.github` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.pytest_cache` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.venv` —— 虚拟环境
- `.workbuddy` —— agent 私有目录
- `Temp` —— 临时目录
- `console/build` —— 构建产物
- `console/dist` —— 构建产物
- `console/node_modules` —— 依赖
- `console/runtime` —— 内嵌运行时（python/node 发行版整份拷进来）
- `console/renderer/dist` —— 构建产物
- `data/tmp` —— 临时目录
- `scripts/__pycache__` —— 字节码缓存
- `scripts/nf_api_domains/__pycache__` —— 字节码缓存
- `scripts/utils/__pycache__` —— 字节码缓存
- `scripts/utils/book_extract/__pycache__` —— 字节码缓存

## 4 项目自己怎么说自己（骨架原文）

### `AGENTS.md`（28657 字，下面只带前 6000 字）

```markdown
# NovelForge — 项目操作手册（AGENTS.md）

本文件在 AI 助手于本项目目录工作时自动加载。用户在本项目发起任务时，按本手册执行。

## 项目定位

NovelForge（对外品牌名：**绒花墨坊** / `ronghuamofang`）是基于AI的长篇小说创作工具：机器包办苦力（素材归并→大纲→写作→检查→润色→Word），用户保留审批权和最终精修权。
用户只做两件事：**放置素材** + **说"运行 NovelForge 项目"**。其余由系统自动执行，关键节点设审批门暂停等待人工确认。

**执行引擎可切换**：`config/system.yaml` 的 `engine` 字段控制。`direct`=OpenAI 兼容直连（当前接 TokenHub，可随时换供应商），`hermes`=Hermes 子会话（备选），`self`=**只出任务书、不调用任何模型**（阶段 1~6 各把任务书写到 `data/state/tasks/self/stageN/`，执行方把产物写到位后重跑即按产物续跑；零 token，细节见 `docs/agents/engine-self.md`）。所有调用点经 `make_client(cfg, role)` 取客户端，零调用点硬编码引擎；`engine: self` 下 `make_client` **直接抛错** —— 防"配了 self、后台却偷偷按量跑模型"这类静默失真。

**思考模式兼容（2026-09-14 起）**：glm-5.x / kimi 等模型默认进 thinking 模式时，正文会全进 `reasoning_content`、`content` 为空（且思考 token 吃掉 `max_tokens` 预算）→ 流水线产出空白。
防线有三：① `providers.<id>.disable_thinking_models` 名单内模型自动注入“关闭思考”片段（候选顺序见 `disable_thinking_payloads`，TokenHub 实测首选 `thinking: {type: disabled}`；`reasoning_effort: none` 会被该平台拒收）；② 未列名单的思考模型由客户端自动探测并注入后重试；③ 兜底**只取协议块**（`===FILE:` / `===APPEND:` / `===DELETE:`）：reasoning_content 里找不到
协议块就**直接丢弃**、返回空让上层判失败 —— **绝不把思考当正文写进产物**
（2026-09-23 修：原实现无标记时返回整段思考，写作阶段实测把思考残片写进了小说正文）。

**产出契约（2026-09-23 定）**：`_post_chat` / `_post_chat_stream` 返回 **4 元组**
`(text, usage, model, finish_reason)`。`finish_reason == "length"` 表示**输出被 max_tokens 截断、
正文不完整** —— 此时**不落盘**、返回 `exit_code: 2`、残缺文本隔离存 `data/state/truncated/`。
调用方无需改动（本项目统一以 `exit_code != 0` 判失败）。
**为什么必须这样**：思考模型会把输出预算耗在 reasoning 上（实测 `max_tokens=4000` 时
思考 10521 字、正文仅 466 字即被截断），旧代码不读 `finish_reason` → **半截章节会被静默当成品**。
注意 `completion_tokens_details.reasoning_tokens` **不可靠**（同样场景分别报 64 与 0），
思考成本只能从 `completion_tokens` 总额侧面反映。
**换供应商只改 `config/system.yaml` 的这两个键，不要改代码、不要在 `llm_client.py` 里硬编码模型名。**

## 细节文档（docs/agents/）—— 按需读取，别当不存在

本手册只留**动手前必须知道的**；细节按主题拆在 `docs/agents/` 下。
**为什么拆**：旧版 76,326 字节，超过 65,536 字节的指令加载预算时系统会**静默截断**，
实测截掉的正是靠后的《能力边界》《硬性约束》—— 手册失效且没有任何报错。
现在主文件 35 KB（原 76 KB），**读全本也很便宜**；下面这些在动到对应模块时读。

| 主题 | 文件 |
|---|---|
| 中文标点归一化（幂等/保守/保护区） | `docs/agents/text-norm.md` |
| 文体（form）与判据适用范围 | `docs/agents/writing-forms.md` |
| 知识库扫描通用化（禁私例当通例） | `docs/agents/kb-scan.md` |
| 索引与实物对账（登记表 vs 盘上实物） | `docs/agents/index-reconcile.md` |
| 界面改动（截图目检 / 参考稿 / 已踩坑） | `docs/agents/ui-review.md` |
| 长篇规模能力（评审账本/记忆/卷弧/伏笔/残稿） | `docs/agents/long-form.md` |
| 提示词前缀纪律（改 stage*.md 前必读） | `docs/agents/prompt-prefix.md` |
| 关键路径（数据与产物的真源） | `docs/agents/key-paths.md` |
| 运维场景（失败/熔断/打回/升级） | `docs/agents/operations.md` |
| 成书提炼（写完的书 → 正典四表 + 病灶词） | `docs/agents/book-extract.md` |
| 判定引擎（三档结论 / 缺陷单 / 回测 / 口径） | `docs/agents/judge-engine.md` |
| 设定引用过期（条目记 sources / 改章即待核 / 谁的判断） | `docs/agents/setting-stale.md` |
| stage5 改稿裁定闸（模型改稿 → 作者逐条勾 → 才合成） | `docs/agents/stage5-gate.md` |
| 自任务引擎 `engine: self`（任务书三件套 / 何时判完成） | `docs/agents/engine-self.md` |
| 作者手册（**给用户看的**，改界面文案前先读这里的说法） | `console/src/help/*.md` |

### 两套文档，别混（2026-10-31 立）

| | 给谁 | 在哪 | 什么时候改 |
|---|---|---|---|
| 本手册 + `docs/agents/` | **开发/Agent** | 仓库 `docs/` | 改架构、加判据 |
| 内置手册 | **作者（用户）** | `console/src/help/*.md`（随包打进前端） | 改界面功能、用户问"这怎么用" |

用户 2026-10-31 的原话：“本来这些东西都应该写在手册里持久化备查的。”
—— 用户在界面上看不懂的东西，第一反应必须是**把手册那篇改清楚**，
而不是在聊天里解释一遍就算了（解释完下次还得再问）。

纪律：
- 手册是**作者向**白活（术语可以出现，但必须当场解释）；`docs/` 是开发向，可以写内部代号。
- 改界面文案时，**两边一起改**：界面上的一句话 + 手册里那一段，说法必须一致
  （`test_help_and_judge_copy` 会查"黑话清零"，但查不出一致性，靠人）。
- 手册随包发布、离线可查（`src/help/*.md` → vite raw → bundle），不读工作区、不联网。

## 启用流程（用户说"运行 NovelForge"时）

1. 前置检查：
   - `config/project.yaml` 是否已填书名/类型/章节数（书名仍为"示例书名（待填写）"时提醒用户）
   - `materials/raw/` 是否有素材（为空时提醒用户，不要空跑）
2. 启动：`terminal(command="python scripts/orchestrator.py", background=true, notify_on_complete=true, workdir="<repo>")`
   - 必须用项目 .venv 的 python：`<repo>/.venv/Scripts/python.exe`（POSIX 为 `<repo>/.venv/bin/python`）
   - **写成裸 `python` 也不会再炸**：`orchestrator.py` / `nfctl.py` 入口挂了解释器守卫
     `utils/interp_guard.py` —— 当前解释器缺 PyYAML 时 stderr 留痕 `[py-guard]` 后自动切 venv 重跑
     （`NF_PY_GUARD` 防拉锯）；切不动才退 1 并给可行动命令。⚠️ 2026-10-06 试跑连炸的真根因
     就是裸 python（宿主环境缺 yaml），被误诊成“.venv 缺依赖”——venv 里 PyYAML 一直在
   - 长任务（数小时），用后台运行 + 完成通知
3. 监控：轮询 `logs/runs.db` 与 `data/state/progress.json` 向用户汇报进度/成本
4. 退出码语义（orchestrator 返回）：
   - `0` = 全部完成；`1` = 阶段失败暂停；`2` = 预算熔断；`3` = 等待审批（阶段2 大纲 / 阶段6 润色）
5. 审批门：exit=3 时，提示用户审阅：
   - 阶段2 审阅 `data/outline/global.md`：审阅前先跑 `python scripts/outline_review.py` 看体检报告（标出空泛节点/章节规划缺漏），避免草草开工
   - 阶段6 审阅 `data/chapters/refined/`：润色稿满意再放行
   - 用户确认 → `python scripts/approve.py --stage N` → 重新运行 orchestrator（断点续跑）
   - 用户不满意 → 让用户说明意见：
     - 阶段2：跑 `python scripts/refine_outline.py "意见"`（增量修订，自动备份旧版到 `data/outline/history/`）→ 反复至满意 → 再审批
     - 其余阶段：跑 `python scripts/reject.py --stage N "原因"`（记录原因+清下游产物+重置状态）→ 重新运行 orchestrator（`--from N` 重跑）

## 止烧与安全闸门（2026-10-03 定，跑长任务前先看这一节）

**token 级熔断**：`config/system.yaml` 的 `budget.token_limit`（**engine: hermes 下唯一有效的止烧闸门**）。
- 为什么不是金额：hermes 走订阅流量，`estimate_cost_yuan` 对 `provider="hermes"` **恒返 0**
  → `budget.limit_yuan` 永不命中（虚设）。切回 `engine: direct` 时金额阈值自动恢复有效。
- 判据只有一份：`CostTracker.status_detail()`（金额 / token 累计 / token 单次），
  `status()` 只是它的二元组包装；触发后走**现有** budget/pause（`progress.budget.paused` + 退出码 2），
  没有新状态机。阶段内（stage4 逐章 / stage5 分批 / stage6 分卷）也查。
- 键义：`per_request_max_tokens`（direct 引擎真设进 `payload.max_tokens`；
  hermes **没有这个旋钮** → 只比对+告警，要按次熔断就开 `per_request_pause_hermes`）、
  `max_total_tokens`（本 run 累计输入+输出；**一轮 = 一次 orchestrator.run()**，`--from N` 重跑会新开 run_id → 计数归零）。
- 熔断后处置：调大对应键 → 清 `data/state/progress.json` 的 `budget.paused` → `orchestrator.py --from N` 续跑（已完成阶段不重跑）。
- 阈值参考量级：hermes 一次 stage1 子会话 ≈ 11.6 万 token（输入 9.8 万 + 输出 1.8 万）；40 章 stage4 合计通常 200~400 万。
- **阈值可配 + 出厂预设 + 边界校验**（2026-10-03）：默认 **1000 万/轮 + 单请求 50000**
  （用户口径：单章 5000~15000 字、常态 ~8000）。桌面端“**设置 → 预算与止烧**”可改，
  “恢复默认预设”取 `cost_tracker.TOKEN_LIMIT_PRESET`（**预设与出厂配置由用例断言逐项一致**）。
  越界值（0 / 负数 / 天文数字）**一律拒绝**并由 `validate_token_limit` 说清哪一项、区间是多少；
  手工把配置改坏时 `normalize_token_limit` 会**回落预设并打印 WARN** —— 闸门不许静默消失。
  端点：`GET/POST /config/token_limit`；写入口**只认 GUI 来源**并列入
  `agent_guard.FORBIDDEN_IN_AGE
```


> ⚠ 上表只是**一级目录**。项目的「分层」往往不等同于目录：像司天那样「生成器 vs 编辑器」是**两套读法**，两者共用同一个 `utils/`。所以你要做的是：把上面的目录**归成几块**，每块回答'这是什么'。

## 5 方寸已经推出来的（供你参考，可能错）

（自动推导**没推出来**：只推出 0 层（至少要 2 层才算「分层」）—— 文档里点到的东西集中在 无 —— 所以更需要你判断）

## 6 现有 spec（**这个项目还没有 spec** —— 你要新建一份）

_没有现成 spec。直接按第 7 节的格式产出一份新的。_

## 7 产出格式（照抄这个形状）

```json
{
  "_comment": "写清这份 spec 的来路：谁写的、依据哪份文档",
  "source": "依据哪份文档 / 谁的口径（例：AGENTS.md 第 3 节 + 项目负责人确认）",
  "layers": {
    "层名（人话，别用目录名当层名）": {
      "paths": [
        "相对仓库的路径前缀",
        "支持 * 通配，如 src/utils/terrain*"
      ],
      "note": "这层是干什么的（一句话）"
    }
  },
  "groups": {
    "大块名（例：生成器 / 编辑器）": [
      "上面某一层",
      "上面另一层"
    ]
  },
  "claims": {
    "层名": 0
  },
  "claimsNote": "claims 是**项目负责人手算过的数字**。没有就整段删掉，别编。"
}
```

字段说明：

- `layers`：**至少 2 层**，否则不叫分层。层名用人话（「生成器」「账本引擎」），不要用目录名。
- `groups`：可选。当项目有「两套读法」（如司天的生成器 / 编辑器）时用它把层归成大块 ——
  这是回答「号称是 A 但 88% 在 B」的关键。没有就别写。
- `claims`：可选。**只有当项目负责人手算过数字时才填**，用于让方寸当场对账。没手算就删掉。
- `paths`：写相对仓库的路径。目录写 `src/foo/`，文件写 `src/foo.js`，通配写 `src/terrain*`。

## 8 硬约束（越界即打回）

1. **不许编路径**。`paths` 里每一条都必须**真的匹配到文件**。写完自己验：
   逐条 `paths` 去仓库里找，找不到就删掉那条，不要留着。
2. **推不出来就说推不出来**。如果这个项目根本就没有可辨识的分层
   （比如它是一堆平铺的脚本），**直接回报「推不出来 + 为什么」**，不要硬凑两层。
   硬凑出来的 spec 比没有更糟 —— 方寸会拿它去算一个假结论。
3. **层名必须是人话**。`src/` 不是层名；「渲染层」「数据层」「生成器」才是。
4. **不许声称你理解了这个项目**。你是在做一次**目录归类**，不是代码审查。
   报告里写清「依据是哪个文档的哪一节」。
5. **结论区分「实测」与「推测」**：路径存在性是实测；「这三层是一伙的」是判断。
   判断要写理由。

## 9 交付

1. 把 JSON 写进 `task-data/layer-specs/project-2.json`
2. 回报一段话，说清四件事：
   - 分了哪几层，每层一句话
   - 依据是哪个文档的哪一节（**必须能指回原文**）
   - 哪些路径你验过存在（实测）、哪些是推测
   - 有没有「两套读法」这种需要 `groups` 的情况；没有就明说没有
3. **不要打包、不要提交 git、不要改任何项目文件**
