# 派工单：给「ROSA 创作」写分层 spec

- 卡类型：数据整理（产出一份 JSON 文件，不改任何代码）
- 项目：ROSA 创作（`rosa-chuangzuo`）
- 仓库根：`E:/图书馆/ROSA`
- 产物落点：`task-data/layer-specs/rosa-chuangzuo.json`（**方寸数据目录**，不是项目仓库）

## 1 任务目标

把「ROSA 创作」**自己声称的分层**写成一份 spec JSON，供方寸回答一个问题：

> 这个项目号称是 A，但 88% 的行数在 B。

⚠ 这句话**只能靠你判断**，因为「哪几层是一伙的」是项目的自我认知，不是目录结构。
方寸已经把**事实**算好了（下面第 3 节），你只需要做**归类与命名**。

## 2 工作目录 / 范围

- 只读项目仓库（**一个字都不许写进去**）：`E:/图书馆/ROSA`
- 唯一允许写入的地方：方寸数据根的 `task-data/layer-specs/rosa-chuangzuo.json`
- **不许改代码、不许改文档、不许 git 操作**

## 3 已经算好的事实（别自己重新数）

方寸扫盘结果：**产品 31 行**（全仓合计 31 行，含测试与脚本）。

> 口径：只数能解码成文本的文件（二进制不算）；排除依赖 / 构建产物 / 打包目录 /
> 内嵌运行时 / 隐藏目录。`.ts` 可能是 MPEG 视频分片，GBK 脚本是文本不是二进制 ——
> 这两条方寸已经处理过，**你不用再踩**。

| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |
|---|---|---:|---:|
| `96 事务管理` | 产品 | 1 | 31 |

### 被规则挡在分母外面的（方寸已排除，列出来让你知道）

- `.agent_context` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.git` —— 版本库
- `.hermes` —— agent 私有目录
- `.obsidian` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.sitian` —— 运行时缓存

## 4 项目自己怎么说自己（骨架原文）

### `AGENTS.md`（2915 字，全文）

```markdown
---
publish: true
---

# Agent Context Index

This vault uses Agent Context Indexing.

Before exploring this vault directly, read:

`.agent_context/latest/agent_context_manifest.json`

Recommended workflow:

1. Read `.agent_context/latest/agent_context_manifest.json`.
2. Read `.agent_context/latest/directory_context.md`.
3. Read `.agent_context/latest/large_index_notice.md`.
4. Read `.agent_context/latest/folder_tree_summary.md`.
5. Read `.agent_context/latest/file_inventory_summary.md`.
6. Read `.agent_context/latest/inventory_group_counts.csv`.
7. Use the category-specific inventory files only as needed.
8. Use `.agent_context/latest/note_index.csv`, `.agent_context/latest/markdown_outline.csv`, `.agent_context/latest/note_link_graph.csv`, `.agent_context/latest/backlink_summary.md`, and `.agent_context/latest/frontmatter_index.csv` for note navigation.
9. Use `.agent_context/latest/attachment_reference_graph.csv` to understand references from notes to PDFs, images, data files, and other non-Markdown files.
10. Prefer rows where target_exists is true before trying to read original files.
11. Read original source files only after selecting a small number of relevant candidates.

Important notes:

- The index is breadth-first and metadata-first.
- The index is intentionally capped to avoid large single files.
- Non-Markdown files are indexed by metadata only.
- If this file was generated as AGENTS.agent-context-indexer.md, an existing AGENTS.md was not overwritten. Merge manually if desired.
- If the index looks stale, ask the user to rerun the appropriate agent context command in Obsidian.

---

## 编写规范索引

- 各模板的填写规范（字段含义、可选值、自定义边界、通用编写纪律）统一维护于 `02 帮助/编写规范/模板文件说明.md`，新建/修订条目以该文档为准，本文件不重复规范正文。
- 模板文件本身位于 `99 模板/`，每类实体对应一个模板（如 `官方书籍模板.md`）。

---

# 严重错误文档处理规范（错分纠正 SOP）

当人工核查或自动化审计发现词条存在**分类错归**或**事实表述错误**时，按以下流程处理。**核心原则：保留线索、纠正事实、归位正确分类，不轻易删除**（线索本身有价值，错的是分类与表述）。

## 识别信号

- 文件路径与 frontmatter 标注的 `tags` / `层级` / `地点类型` / `类别` 不一致。
- 正文出现与全库正典冲突的断言（如把两个独立世界混为同一个、领土所属世界写错）。
- 跨分类目录中存在本应归属他类的词条（例：`02 场景地点/02 幻境/` 下混入国家类实体）。

## 处理流程

1. **先核查，后动手**：读取全库证据确认正确归属（目录树、同分类样例词条 frontmatter、关联事件/角色词条），确认错误属实。
2. **确定正确分类口径**，常见归属：
   - 国家/政权实体 → `06 组织势力/04 国家/`（模板参考绒花帝国；frontmatter 用 `tags`/`aliases`/`政权现状`/`政权类型`，无 `层级` 字段）。
   - 世界内的具体地点的（非政权）→ 对应世界文件夹（如 `02 场景地点/07 粘土世界/`）。
   - 可移动、位置随时变化的设施 → `02 场景地点/98 移动设施/`（frontmatter 用 `地点类型: 特殊`、`上层区域: 无`）。
3. **写入新位置**（改用对应分类模板、重写 frontmatter 与错误正文），保留原始线索价值。
4. **删除旧位置文件**（破坏性操作，须获用户明确授权）。
5. **同步修正反向链接的语境措辞**：跨文件夹移动后 Obsidian 按文件名解析 `[[链接]]` 不失效，但同文件内的描述语境需手动修正（例：原描述"幻境语境下的粘土世界地点"应改为"粘土世界国家"）。
6. **链接校验**：移动/删除后，全局检索 `[[文件名]]` 引用点，确认目标仍存在、无旧路径引用残留。

## 安全约束

- 移动/删除/重命名属破坏性操作，**执行前必须获用户明确授权**。
- 本 `AGENTS.md` 已被 `obsidian-agent-context` 插件标记为 `created_fallback_existing_primary`（插件保留现有文件、另建兜底指针）。**切勿删除本文件后手动重跑插件生成命令**，否则会被插件内容覆盖；正常追加内容安全，不会被插件自动冲掉。

## 记录

- 重大纠正应记入 `96 事务管理/变更日志_YYYY-MM.md` 与审计报告。
- 反复出现的错分模式可沉淀为本规范的补充条款。
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

1. 把 JSON 写进 `task-data/layer-specs/rosa-chuangzuo.json`
2. 回报一段话，说清四件事：
   - 分了哪几层，每层一句话
   - 依据是哪个文档的哪一节（**必须能指回原文**）
   - 哪些路径你验过存在（实测）、哪些是推测
   - 有没有「两套读法」这种需要 `groups` 的情况；没有就明说没有
3. **不要打包、不要提交 git、不要改任何项目文件**
