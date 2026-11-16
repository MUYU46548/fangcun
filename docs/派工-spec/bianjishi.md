# 派工单：给「设定资料工具库」写分层 spec

- 卡类型：数据整理（产出一份 JSON 文件，不改任何代码）
- 项目：设定资料工具库（`bianjishi`）
- 仓库根：`E:/图书馆/编辑室/设定资料维护工具库`
- 产物落点：`task-data/layer-specs/bianjishi.json`（**方寸数据目录**，不是项目仓库）

## 1 任务目标

把「设定资料工具库」**自己声称的分层**写成一份 spec JSON，供方寸回答一个问题：

> 这个项目号称是 A，但 88% 的行数在 B。

⚠ 这句话**只能靠你判断**，因为「哪几层是一伙的」是项目的自我认知，不是目录结构。
方寸已经把**事实**算好了（下面第 3 节），你只需要做**归类与命名**。

## 2 工作目录 / 范围

- 只读项目仓库（**一个字都不许写进去**）：`E:/图书馆/编辑室/设定资料维护工具库`
- 唯一允许写入的地方：方寸数据根的 `task-data/layer-specs/bianjishi.json`
- **不许改代码、不许改文档、不许 git 操作**

## 3 已经算好的事实（别自己重新数）

方寸扫盘结果：**产品 205 行**（全仓合计 1,467 行，含测试与脚本）。

> 口径：只数能解码成文本的文件（二进制不算）；排除依赖 / 构建产物 / 打包目录 /
> 内嵌运行时 / 隐藏目录。`.ts` 可能是 MPEG 视频分片，GBK 脚本是文本不是二进制 ——
> 这两条方寸已经处理过，**你不用再踩**。

| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |
|---|---|---:|---:|
| `scripts` | 工具 | 7 | 1,262 |
| `(根)` | 产品 | 1 | 205 |

### 被规则挡在分母外面的（方寸已排除，列出来让你知道）

- `.git` —— 版本库

## 4 项目自己怎么说自己（骨架原文）

### `AGENTS.md`（4089 字，全文）

```markdown
# AGENTS.md — 设定资料维护工具库

> 本文件是 AI 在本仓库内查询、调用、修改时的**权威依据与行为约束**。任何 AI 操作前先读本文件。

## 0. 一句话定位

本库离线处理 ROSA 世界观 IP 的**小说正文索引与逐章摘要**，产出供 AI 检索的 `canonical_enriched.json`。**只读源文件、只写 `output/`，绝不回写 ROSA。**

## 1. 红线（违反即中止）

- **不修改 ROSA 任何内容**（笔记、附件、配置）。所有产物落在 `output/`，绝不反向写入 `E:/图书馆/ROSA`。
- **不接触任何 API 密钥 / `.env` / 凭证文件**。摘要补全若需 LLM，由调用方在隔离环境执行；本库脚本不应内嵌密钥。
- **不删除、不移动不属于本任务的文件**。破坏性操作（删除/重命名/移动）前必须征得用户确认。
- `output/` 下的中间产物可被重跑覆盖，但**终态交付物 `canonical_enriched.json` 与 `canonical_index.json` 不可手动删除**（除非用户明确要求重建）。

## 2. 外部依赖路径（只读）

| 用途 | 路径 | 说明 |
|------|------|------|
| 唯一事实源（主表） | `修订计划表.xlsx` → `官方书籍` sheet | OB 编号/书名/类型/状态/优先级/代码 |
| 作品代码存档 | `修订计划表.xlsx` → `作品代码存档` sheet | OB 编号 ↔ 代码映射 |
| 正文源文件（docx） | `E:/图书馆/资源库/文字类/**`（排除 `_索引` 子目录） | 按书名模糊匹配 basename |
| 旧作 markdown | `E:/图书馆/ROSA/07 资料收藏/01 旧作/<书名>/*.md` | OB1–OB7 等无正文旧作（仅元信息） |
| hy3 逐章切分事实源 | `output/hy3_chapters.json` | `build_canonical_index.py` 的依赖输入 |

## 3. 目录结构

```
设定资料维护工具库/
├─ AGENTS.md                  # 本文件
├─ README.md                  # 概览与重跑顺序
├─ scripts/                   # 所有处理脚本
│  ├─ build_canonical_index.py # P0：重建 canonical_index.json/.md
│  ├─ p1_prepare.py            # P1：抽包 → output/intermediate/p1_batches/
│  ├─ p1_enrich.py            # P1：抽取验证 / LLM 回填接口（extract_only 模式可离线验证）
│  ├─ merge_enriched.py        # P1：合并 → output/canonical_enriched.json
│  └─ noveltools_indexer.py    # 旧 v2/v3 索引器（已废弃，产物在 output/legacy_noveltools/）
├─ output/
│  ├─ canonical_enriched.json  # ★ 终态交付物：32 部逐章摘要 + 关键词
│  ├─ canonical_index.json/.md # P0 规范化索引（逐章字数）
│  ├─ hy3_chapters.json        # 事实源：hy3 逐章切分结果
│  ├─ hy3_chapters_partial.json
│  ├─ intermediate/            # P1 中间产物（重跑可覆盖）
│  │  ├─ p1_batches/           # 32 部抽包（喂给 LLM 的章节文本）
│  │  └─ p1_enriched/         # 32 部回填后的逐章摘要（merge 的输入）
│  └─ legacy_noveltools/       # 旧管线孤儿产物（作品索引.* + chapters_OB*.json），已废弃保留备查
├─ 修订计划表.xlsx / 作品信息维护.xlsx
├─ 不常用/ 角色关系维护/ 咒语/ 官方书籍分类规范.txt 引号更正指南.md
```

## 4. 管线与调用顺序

```
修订计划表.xlsx + 源 docx + hy3_chapters.json
        │  build_canonical_index.py
        ▼
output/canonical_index.json  (+ .md)
        │  p1_prepare.py  ──► output/intermediate/p1_batches/OBxx.json
        ▼
   （LLM 按 p1_batches 回填摘要/关键词 → 写入 output/intermediate/p1_enriched/OBxx.json）
        │  merge_enriched.py
        ▼
output/canonical_enriched.json   ★ 终态
```

**正确重跑顺序**：`build_canonical_index.py` → `p1_prepare.py` → （LLM 回填写 `intermediate/p1_enriched/`）→ `merge_enriched.py`。

- `p1_prepare.py` 与 `merge_enriched.py` 硬编码了 `intermediate/` 子路径，移动中间产物目录须同步改这两个脚本。
- `merge_enriched.py` 以 `intermediate/p1_enriched/OBxx.json` 覆盖合并进 `canonical_enriched.json`：**缺失某 OB 的 p1_enriched 文件，则该 OB 摘要被清空为 None**。重跑前必须确认 32 部（OB2 除外）均已有 p1_enriched 文件。

## 5. canonical_enriched.json 数据约定

- **范围**：33 个 OB 条目；OB2 为失传作品，章节为空。其余 32 部共 **794 章**。
- **单章 schema**：`{idx, title, char_count, summary, keywords[]}`。
- `summary` 为 null 或含 `"待补"/"截断"` 字样 = **未完成/缺口**，需排查。
- 0 字数章（`char_count==0`）属**真实缺失**（源文件该日空白/标注"略"），不应视为质量问题，保持原样。

## 6. 已知陷阱（AI 自查清单）

1. **`whole` 模式截断**：`WHOLE_OBS = {OB8, OB10, OB12, OB14, OB18, OB19, OB24}` 走整篇摘要 + 4000 字 excerpt 上限。超长篇该上限之后的章节会落入"内容待补"占位。
   - OB8《暮雨随笔》已在 2026-08-22 补全 ch7–ch11（基于真实源文本，未调 LLM）。
   - **OB10 / OB12《净土的风》仍是 whole 模式未逐章抽取**（315 章日记，需改 per_chapter 重跑，价值偏低，暂搁置）。
2. **标题锚点切分 bug（已修复）**：`split_by_titles` 取标题**最后一次出现**（正文标记），而非首次（目录区），避免把目录标题误当章节起点。涉及 H1 文档用 H1 分段，非 H1 用锚点。
3. **H1 文档集合**：`H1_OBS = {OB9, OB16, OB21, OB22, OB30, OB31, OB32, OB33}`，按 Heading 1 切分；其余按 hy3 章节清单或锚点。
4. **文件名匹配**：源 docx 优先选含「修订版存档」者；H1 文档选 H1 数最多者。全/半角括号需归一化比对。

## 7. AI 行为约束（操作前自检）

- 查询某作品摘要 → 直接读 `output/canonical_enriched.json` 的 `by_ob[OBxx].chapters`。
- 需补某章摘要 → 先查 `output/intermediate/p1_enriched/OBxx.json` 是否已有；改前备份，改后重跑 `merge_enriched.py` 并校验该 OB 无"待补/截断"残留。
- 想重抽章节 → 跑 `p1_prepare.py`，确认产物落在 `output/intermediate/p1_batches/`。
- **绝不允许**：为"整洁"删除 `output/legacy_noveltools/`（用户明确保留备查）；把脚本改成内嵌密钥；把产出写回 ROSA。
- 任何破坏性/移动操作前 → 先 `clarify` 征得用户确认。

## 8. 与 ROSA 的关系

本库是 ROSA 的**离线索引卫星**，服务于「AI 可检索的小说正文摘要」。ROSA 笔记库路径 `E:/图书馆/ROSA` 仅作为旧作 markdown 的**只读源**出现，绝不作为写入目标。合入 ROSA 主库的时机由用户决定，不在本库职责内。
```


> ⚠ 上表只是**一级目录**。项目的「分层」往往不等同于目录：像司天那样「生成器 vs 编辑器」是**两套读法**，两者共用同一个 `utils/`。所以你要做的是：把上面的目录**归成几块**，每块回答'这是什么'。

## 5 方寸已经推出来的（供你参考，可能错）

（自动推导**没推出来**：只推出 1 层（至少要 2 层才算「分层」）—— 文档里点到的东西集中在 output/（3. 目录结构） —— 所以更需要你判断）

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

1. 把 JSON 写进 `task-data/layer-specs/bianjishi.json`
2. 回报一段话，说清四件事：
   - 分了哪几层，每层一句话
   - 依据是哪个文档的哪一节（**必须能指回原文**）
   - 哪些路径你验过存在（实测）、哪些是推测
   - 有没有「两套读法」这种需要 `groups` 的情况；没有就明说没有
3. **不要打包、不要提交 git、不要改任何项目文件**
