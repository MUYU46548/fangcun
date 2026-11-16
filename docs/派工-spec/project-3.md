# 派工单：给「明鉴」写分层 spec

- 卡类型：数据整理（产出一份 JSON 文件，不改任何代码）
- 项目：明鉴（`project-3`）
- 仓库根：`E:/CODE/CangKu/MingJian`
- 产物落点：`task-data/layer-specs/project-3.json`（**方寸数据目录**，不是项目仓库）

## 1 任务目标

把「明鉴」**自己声称的分层**写成一份 spec JSON，供方寸回答一个问题：

> 这个项目号称是 A，但 88% 的行数在 B。

⚠ 这句话**只能靠你判断**，因为「哪几层是一伙的」是项目的自我认知，不是目录结构。
方寸已经把**事实**算好了（下面第 3 节），你只需要做**归类与命名**。

## 2 工作目录 / 范围

- 只读项目仓库（**一个字都不许写进去**）：`E:/CODE/CangKu/MingJian`
- 唯一允许写入的地方：方寸数据根的 `task-data/layer-specs/project-3.json`
- **不许改代码、不许改文档、不许 git 操作**

## 3 已经算好的事实（别自己重新数）

方寸扫盘结果：**产品 1,346 行**（全仓合计 10,402 行，含测试与脚本）。

> 口径：只数能解码成文本的文件（二进制不算）；排除依赖 / 构建产物 / 打包目录 /
> 内嵌运行时 / 隐藏目录。`.ts` 可能是 MPEG 视频分片，GBK 脚本是文本不是二进制 ——
> 这两条方寸已经处理过，**你不用再踩**。

| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |
|---|---|---:|---:|
| `scripts` | 工具 | 17 | 4,163 |
| `tests` | 测试 | 17 | 1,876 |
| `scripts/utils` | 工具 | 15 | 1,706 |
| `gui/templates` | 产品 | 1 | 902 |
| `scripts/api/domains` | 工具 | 6 | 631 |
| `desktop` | 产品 | 5 | 416 |
| `scripts/api` | 工具 | 3 | 355 |
| `desktop/tools` | 工具 | 4 | 325 |
| `(根)` | 产品 | 1 | 28 |

### 被规则挡在分母外面的（方寸已排除，列出来让你知道）

- `.git` —— 版本库
- `.pytest_cache` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.venv` —— 虚拟环境
- `.workbuddy` —— agent 私有目录
- `Temp` —— 临时目录
- `data/tmp` —— 临时目录
- `desktop/.cache` —— 打包/构建产物（前缀规则）
- `desktop/build` —— 构建产物
- `desktop/node_modules` —— 依赖
- `desktop/release` —— 打包产物
- `desktop/runtime` —— 内嵌运行时（python/node 发行版整份拷进来）
- `history/20260816_152922_净土的风_stage1/tmp` —— 临时目录
- `history/20260817_222633_净土的风_stage2/tmp` —— 临时目录
- `history/20260821_201704_stage3_review_restore_hy3_suggest/tmp` —— 临时目录
- `history/20260822_102835_净土的风_stage3/tmp` —— 临时目录
- `history/20260822_104121_净土的风_stage3/tmp` —— 临时目录

## 4 项目自己怎么说自己（骨架原文）

### `AGENTS.md`（6024 字，下面只带前 6000 字）

```markdown
# AGENTS.md — 明鉴（MingJian）操作手册

> 半自动文章修订工作台：AI 建议 → 人工决策 → 脚本执行。
> 项目根：`E:/CODE/CangKu/MingJian`（独立 Git 仓库，main 分支）

## 怎么启动（用户视角只有这一条）

双击项目根的 **`启动明鉴.bat`** → 打开桌面窗口（Electron 壳 + 本地服务 8757）。

- 找不到 Electron 时自动退回浏览器模式（起服务 + 开 `http://127.0.0.1:8757/`）
- 桌面壳源码在 `desktop/`（main.js 拉起 `scripts/api_server.py`，退出时 taskkill 子进程树）
- 运行时依赖：`.venv/`（Python）、`desktop/node_modules/electron`（桌面窗口）
- 批处理含中文，**必须存成 GBK**，否则 cmd 解析乱码导致 `start` 失败

## 额度红线（2026-11-12 事故后立，优先级高于本节其余所有内容）

**任何会消耗模型额度的调用，必须先获得用户明确同意，讨论方案时不算同意。**

- 禁止擅自借用其它项目的 key（墨坊 `.env` 的 TOKENHUB_API_KEY 也不许）
- 付费模型（deepseek-v4-pro / kimi-* / glm-5.3 / glm-5.* 等）一律视为"要花钱"
- 免费额度模型也不许批量刷：对同一集跑几十上百次照样会耗光
- 需要跑模型时：先说明"要跑什么、几次调用、大概多少钱"，等一句"可以"再动
- `scripts/eval_prompt.py` 已内置闸门：非免费名单模型需 `--allow-paid --confirm-cost`，
  缺一个就拒绝执行并打印预估花费

写脚本做验证时，优先用**离线可复现**的方式（假 transport、fixture 回放、纯函数单测），
不要拿真实 API 当调试工具。

## 项目定位

对长篇文稿（小说/设定集）执行四阶段修订流水线：

| 阶段 | 名称 | 方式 | token |
|------|------|------|-------|
| stage1 | 格式统一 | md/docx → docx 套模板（样式/占位符/TOC 域） | 0（全自动） |
| stage2 | 校对 | 规则错别字（确定性 accept）+ LLM 语病（pending 人工） | LLM 分片 |
| stage3 | 安全审查 | LLM 分节风险标记 + 敏感词表辅助 → 决策表 → 人工确认删除/修改 | LLM 分节 |
| stage4 | 分节/尾注 | 节末 [尾注区] 锚点 + 真实 Word 分节符 + 可选说明文本 | 0（--annotate 才用 LLM） |

核心哲学：**LLM 只产建议清单（决策表），永不直接改稿**；确定性脚本按人工确认后的决策执行。

## 环境

- Python：`.venv/`（3.11）— **一律用 `.venv/Scripts/python.exe` 运行**
- 依赖：python-docx / PyYAML / markdown
- 模板：`templates/小说格式模板V1.3.dotx`（副本；源件在 C:/Users/47219/Documents/自定义 Office 模板）
- 模型执行引擎：**engine=self（默认）** —— 程序不调用模型，只写任务书到
  `data/state/tasks/self/stage2/`，外部 agent 执行后把 JSON 写回 `data/state/results/stage2/`，
  再点「回收 agent 结果」（`stage2 --import-results`）。要直连 API 才改 `config/system.yaml` 的 engine
- 模型凭据：本项目 `.env`（不依赖 Hermes 全局），config/ 不含密钥

## 命令速查（workdir=项目根）

| 目的 | 命令 |
|------|------|
| 全流程 | `.venv/Scripts/python.exe scripts/orchestrator.py [--doc X] [--no-llm] [--annotate] [--skip-approval-wait]` |
| 审批/撤销 | `.venv/Scripts/python.exe scripts/approve.py --doc X --stage 2 [--revoke]` |
| 打回 | `.venv/Scripts/python.exe scripts/reject.py --doc X --stage 2 "原因" [--dry-run]` |
| 阶段 1 格式 | `.venv/Scripts/python.exe scripts/stage1_format.py --doc X [--book-title 名] [--author 名]` |
| 阶段 2 校对 | `.venv/Scripts/python.exe scripts/stage2_proofread.py --doc X [--no-llm]` → 改决策表 → `--apply` |
| 阶段 3 审查 | `.venv/Scripts/python.exe scripts/stage3_review.py --doc X [--no-llm]` → 改决策表 → `--apply` |
| 阶段 4 分节/尾注 | `.venv/Scripts/python.exe scripts/stage4_annotate.py --doc X [--annotate] [--apply]` |
| Obsidian 审阅 | `.venv/Scripts/python.exe scripts/obsidian_review.py --doc X --stage 2 \| 3 --export \| --import \| --suggest`（批量：`--export-all` / `--import-all` / `--approve-all`） |
| 快照管理 | `.venv/Scripts/python.exe scripts/snapshot_tool.py --list` / `--restore <name>` / `--make <label>` |
| 状态总览 | `.venv/Scripts/python.exe scripts/status.py [--doc X] [--json]`（只读 0 token：文档×阶段矩阵/待审批/决策表统计/预算） |
| 本地 API + 工作台 | `.venv/Scripts/python.exe scripts/api_server.py [--port 8757]`（导入/一键跑/审阅/导出，job+SSE） |
| 导入 Word | `POST /api/import {"path": "D:/稿.docx"}` → 复制进 `data/input/<id>/` 并跑 stage1 |
| 一键跑完 | `POST /api/pipeline {"doc": X, "mode": "rules"\|"task"}`（rules=0 token，task=只出任务书） |
| 批准并导出 | `POST /api/apply {"doc": X, "stage": 2}` → approve + apply，产出 `stage2.docx` |
| 打开产物 | `POST /api/open {"path": "data/working/X/stage2.docx"}`（仅限 data/ 下） |
| 分级与批量决策 | `.venv/Scripts/python.exe scripts/triage.py --doc X --stage 2 [--auto/--level/--type/--confidence/--decision] [--dry-run]` |
| prompt/模型评测 | 先 `export TOKENHUB_API_KEY=…`，再 `.venv/Scripts/python.exe scripts/eval_prompt.py --model M --api-base URL --api-key-env ENV`（跑固定评测集，出硬错召回/误报） |
| 测试回归 | `.venv/Scripts/python.exe -m pytest`（tests/ 套件 47 项） |
| 快照 | `.venv/Scripts/python.exe -c "import sys; sys.path.insert(0,'scripts'); from utils.snapshot import snapshot; print(snapshot('标签'))"` |

退出码：0=全部完成 / 1=失败 / 2=熔断 / 3=等待审批

## 数据流

- 输入副本：`data/input/<doc_id>/`（**源文件永不写入**，先复制再操作）
- 中间产物：`data/working/<doc_id>/stage{1..4}.docx`
- 决策表：`data/decisions/{proofread,review,annotate}_<doc_id>.{json,md}`
- 进度：`data/state/progress.json`；任务文件：`data/state/tasks/*.md`（自包含，规避命令行长度限制）
- 运行记录：`logs/runs.db`；成本：cost_log 逐次记账
- 快照：history/（每阶段成功后自动，保留 10 份）
- 提示词：`prompts/stage{2,3,4}_*.md`（**模板与代码分离，改 prompt 不改脚本**）
- 配置：`config/project.yaml`（documents/batches 按文档指定 stages）+ `config/system.yaml`（预算/分片/并发/模型）

## 决策表机制

- `items` 含 `loc`（para_index + para_hash + snippet）、original/suggested、decision
- decision 取值：pending / accept / reject / delete / keep / modify / manual
- 定位锚点：LLM 输出片段内 `[P序号]`，本地映射 para_index→para_hash
- **执行前重校验 original 存在性，失配即中止**（串行漂移防线）
- LLM 输出解析失败重试 1 次后标记 manual，不静默丢弃
- 审批门：stage2/3 生成后 waiting_approval（**空清单直接 done**）；approve 后 approved → orchestrator 走 apply 分支
- apply 某阶段后**清下游产物 + 重置下游 pending**（版本一致性）

## 开发约定

1. 每完成一个任务：Temp 下验证脚本跑通 → 清理 → git commit（信息带 P0-x/P1-x 前缀）
2. 完成后更新 `开发日志.md`（用户强制要求）
3. 测试回归：改 utils/决策表/Obsidian 审阅语义/orchestrator 后跑 `.venv/Scripts/python.exe -m pytest`（tests/ 套件，必须全绿再 commit）
4. 配置文件修改用 patch；YAML 不含密钥
5. 破坏性操作（删除段落产物）执行前征求用户确认
6. 验证脚本：`sys.path.insert(0, 'scripts')` + `.venv/Scripts/python.exe` 运行（docx 依赖只在 venv）
7. 生命周期 guardrail：验证脚本用 `python -c "import runpy; runpy.run_path('Temp/xxx.py')"` 运行（直接跑 .py 会触发 embedded null character）；Temp/ 在 gitignore
8. venv 跨机迁移即损坏（pyvenv.cfg 指向旧机 Python 绝对路径）：直接 `uv venv .venv --python 3.11 && uv pip install --python .venv/Scripts/python.exe python-docx PyYAML markdown pytest` 重建，依赖无锁定文件

## 已知陷阱

- `scripts/utils/` 必须带 `__init__.py`（regular package）——否则被 Hermes 环境同名 utils.py 模块遮蔽
- 子进程改 progress.json → orchestrator 读取状态一律用 `ProgressManager()` 新实例（内存陈旧）
- terminal 相同命令失败 5 次被 block：修完代码要改命令签名或拆步骤
- Python 字符串里写 TOC 指令 `\o \h \z \u` 必须 raw string
- config 里 `documents:` 空 → `proj.get("documents") or []`，不能直接迭代
- stage2/3/4 渲染时 blocks 从模板 [请输入文本] 锚点插入（与输入 docx 无关）
- stage4 分节必须渲染 `{"blocks": anchored}` 而非原 doc

## 权威文档

- 开发日志：项目根 `开发日志.md`（每阶段施工后必须更新，最新状态以此为准）
- 当开发日志内容过多时，需要在维护时压缩早期内容（例如前一个月的往往没什么用，文件结构早已
```


> ⚠ 上表只是**一级目录**。项目的「分层」往往不等同于目录：像司天那样「生成器 vs 编辑器」是**两套读法**，两者共用同一个 `utils/`。所以你要做的是：把上面的目录**归成几块**，每块回答'这是什么'。

## 5 方寸已经推出来的（供你参考，可能错）

（自动推导**没推出来**：AGENTS.md 里没有「架构 / 目录 / 结构」这类小节 —— 它讲的是别的事（数据流、命令、规矩），推不出分层 —— 所以更需要你判断）

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

1. 把 JSON 写进 `task-data/layer-specs/project-3.json`
2. 回报一段话，说清四件事：
   - 分了哪几层，每层一句话
   - 依据是哪个文档的哪一节（**必须能指回原文**）
   - 哪些路径你验过存在（实测）、哪些是推测
   - 有没有「两套读法」这种需要 `groups` 的情况；没有就明说没有
3. **不要打包、不要提交 git、不要改任何项目文件**
