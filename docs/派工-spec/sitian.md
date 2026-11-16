# 派工单：给「司天」写分层 spec

- 卡类型：数据整理（产出一份 JSON 文件，不改任何代码）
- 项目：司天（`sitian`）
- 仓库根：`E:/CODE/CangKu/SiTian`
- 产物落点：`task-data/layer-specs/sitian.json`（**方寸数据目录**，不是项目仓库）

## 1 任务目标

把「司天」**自己声称的分层**写成一份 spec JSON，供方寸回答一个问题：

> 这个项目号称是 A，但 88% 的行数在 B。

⚠ 这句话**只能靠你判断**，因为「哪几层是一伙的」是项目的自我认知，不是目录结构。
方寸已经把**事实**算好了（下面第 3 节），你只需要做**归类与命名**。

## 2 工作目录 / 范围

- 只读项目仓库（**一个字都不许写进去**）：`E:/CODE/CangKu/SiTian`
- 唯一允许写入的地方：方寸数据根的 `task-data/layer-specs/sitian.json`
- **不许改代码、不许改文档、不许 git 操作**

## 3 已经算好的事实（别自己重新数）

方寸扫盘结果：**产品 139,344 行**（全仓合计 279,835 行，含测试与脚本）。

> 口径：只数能解码成文本的文件（二进制不算）；排除依赖 / 构建产物 / 打包目录 /
> 内嵌运行时 / 隐藏目录。`.ts` 可能是 MPEG 视频分片，GBK 脚本是文本不是二进制 ——
> 这两条方寸已经处理过，**你不用再踩**。

| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |
|---|---|---:|---:|
| `src/renderer/src` | 产品 | 358 | 129,764 |
| `scripts/tests/cases` | 测试 | 178 | 53,370 |
| `scripts/tests/unit` | 测试 | 136 | 32,824 |
| `scripts/tests/tools` | 测试 | 152 | 25,646 |
| `scripts/tests` | 测试 | 47 | 19,138 |
| `scripts` | 工具 | 27 | 5,738 |
| `src/main` | 产品 | 10 | 3,211 |
| `scripts/lib` | 工具 | 4 | 1,679 |
| `src/main/handlers` | 产品 | 3 | 1,485 |
| `docs/mockups` | 产品 | 2 | 1,246 |
| `src/ledger` | 产品 | 6 | 1,110 |
| `scripts/tests/lib` | 测试 | 4 | 1,059 |
| `prototype` | 产品 | 2 | 685 |
| `docs/assets` | 产品 | 2 | 650 |
| `scripts/tests/fixtures` | 测试 | 3 | 627 |
| `src/renderer` | 产品 | 1 | 476 |
| `scripts/maint` | 工具 | 1 | 410 |
| `(根)` | 产品 | 3 | 325 |
| `src/preload` | 产品 | 1 | 245 |
| `docs/assets/s0-brush-20261019` | 产品 | 1 | 147 |

### 被规则挡在分母外面的（方寸已排除，列出来让你知道）

- `.git` —— 版本库
- `.hermes` —— agent 私有目录
- `.lab-edge-profile` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.sitian` —— 运行时缓存
- `.test-edge-profile` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.test-edge-profile-3d` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.workbuddy` —— agent 私有目录
- `__pycache__` —— 字节码缓存
- `backups` —— 备份
- `build` —— 构建产物
- `dist` —— 构建产物
- `node_modules` —— 依赖
- `refs/out` —— 构建产物
- `scripts/__pycache__` —— 字节码缓存
- `scripts/maint/__pycache__` —— 字节码缓存
- `scripts/tests/__pycache__` —— 字节码缓存

## 4 项目自己怎么说自己（骨架原文）

### `AGENTS.md`（51650 字，下面只带前 6000 字）

```markdown
# SiTian (司天)

为世界构建者设计的本地桌面应用（Electron 28），以 Obsidian 库（默认 `<库根>/`）为事实源之一，通过七层视图呈现世界观地理层级，为 Markdown 附加可编辑的坐标元数据，实现画布与笔记的双向同步。

> **独立运行化（Phase 1 已落地 2026-09-18；Phase 2.4 接线 + 终态翻开 2026-09-20）**：司天另有一套自有项目文件（`.sitian`，JSON 单文件：实体树 + 剧本 + 地图 + 自动快照），目标是脱离知识库也能新建/编辑/保存世界观。
> 接线已完成：**打开项目 → 画布事实源切到项目文件；关闭项目 → 还原打开前的知识库工作态**（`store/canvasBridge.js` 是唯一接线点）；**无项目 = 只读**（`READONLY_WITHOUT_PROJECT = true`，UI 已灰禁且灰禁带能力说明）。细节（写闸门 / 接线 / 快照 / 退出落盘）见 [`docs/agents-archive/project-save.md`](docs/agents-archive/project-save.md)。

## 技术栈 (Tech Stack)

- 桌面壳: Electron 28
- UI 框架: Vue 3 + Pinia
- 构建工具: Vite 5
- 数据格式: Markdown + YAML frontmatter + JSON 缓存层（`<库根>/.sitian/`）+ `.sitian` 项目文件
- 前端画布: 原生 Canvas 2D（无外部渲染库）；**星系 3D 观景**按需加载 `three@0.128.0`（动态 import，不进首屏，见 views 归档）
- UI 基座（2026-10-06 试点）: Tailwind CSS 3（**只出 utilities 层**）+ shadcn-vue 源码组件（`components/ui/`，基于 reka-ui）

## 常用命令 (Common Commands)

- 安装依赖: `npm install`
- 开发模式 (仅前端): `npm run dev`（端口 **5180**）
- 开发模式 (Electron 完整): `npm run dev:watch`（wait-on tcp:5180 后拉起 Electron）
- 构建生产版本: `npm run build`
- 打包安装包: `npm run dist`（→ **仓库外**的产物目录，见下条；不再写 `release/`）
- **打包产物不许落进仓库（2026-11-08 用户拍板：“构建目录本来就不应该跑到其他文件夹里污染仓库”）**：
  输出目录由 `scripts/lib/distPaths.mjs` 算（**唯一实现**）——默认 `%LOCALAPPDATA%\sitian-build\release`
  （macOS = `~/Library/Application Support/sitian-build`，Linux = `$XDG_DATA_HOME/sitian-build`），
  可用环境变量 `SITIAN_DIST_ROOT` 覆盖；`npm run dist / dist:dir / dist:publish` 一律经 `scripts/dist.mjs`
  （它把 `--config.directories.output=<算出来的>` 透传给 electron-builder）。**不要再裸调 electron-builder**，
  也不要再靠 `release-xxx/` 换目录（历史上这么攒出 10 个目录 / 3.9 GB，已清）。
  验包脚本 `drill_packaged_app.py` 也问同一个模块（不自己算）。守门：`unit/test_dist_paths.js`
  （默认不在仓库内 + 三个脚本都走 dist.mjs + 反向探针）。
- 从 Obsidian 提取数据: `npm run extract-data`
- 回归测试: `python scripts/tests/run_tests.py`（**178 用例**；须用系统 Python，Hermes 自带 venv 缺 `websocket-client`）
  - 数据源默认 = **仓库内合成 fixture**（`scripts/tests/fixtures/vault-fixture/`，由 `fixtures/make_vault_fixture.py` 生成：层级结构同构、内容全虚构、地图几何程序合成）→ **用户改自己的世界观数据不会让用例变红**；要对着真实库跑加 `--real-data`
  - 该命令会先跑 `scripts/tests/unit/*.js`（**135 个** Node 单元测试文件：主进程文件 I/O + 真实 git 同步 + 令牌加密保管 + 纯函数层若干，CDP 用例的 mock 覆盖不到），失败计为 1 个失败用例
  - 单跑某个用例：`python scripts/tests/run_tests.py test_47`
  - **退出码 3 = 环境没起来（不是产品结论）**（2026-11-08）：`store.nodes` 恒 0 / 页面被关掉 /
    harness 基线项目打不开（`no-app`、`browser-dev-mode`）时，整轮**中止**并印一段横幅，
    而不是让 165 条用例各自把“空 store”演成产品缺陷。实测踩过：一次冷启动抖动让 9 条用例集体假红
    （`test_109` 说“推演没起伏”、`test_85` 说“没有打开的项目”、`test_48` 说“面板没渲染”），
    而同一份代码紧接着单跑 `test_46 test_124` 是 2/2 绿。想让它自己重建浏览器重来一次：加 `--retry-env 1`
    （默认 0 = 直接中止）。负向演练：拿一个 `{"nodes":[]}` 的空库跑，必须 exit 3 + 横幅、一条用例都不执行。
  - 🔴 **用例判定必须走 `lib/cdp.py` 的 `eval_json()`**：`cdp.eval` 在 JS 抛异常时返回 `{'__err__': …}`，写成「没有 `fails` 字段就算通过」会造成**静默假绿**（本项目真实踩过：假绿掩盖了「主进程不回显 project → 新建项目必失败」的生产缺陷）
- 提取覆盖率审计: `npm run audit-coverage`（只读；`-- --write-report` 落 `96 事务管理/`）
- mapdata 旧 key 清理: `npm run migrate-mapdata-keys`（默认 dry-run，`-- --apply` 才写盘）
- **存量机器属性搬家（A-1，2026-09-27）**: `npm run migrate-vault-attrs -- --project <file.sitian> [--vault <路径>] [--from-cache]`（默认 dry-run 出**清点表**，`-- --apply` 才写盘）。把笔记 frontmatter 承载的「层级 / 上层挂靠 / 地点类型」搬进项目文件；**只补空、绝不覆盖项目已有值**（不一致进「冲突」清单交人判断），补 parentId 前校验父实体存在，写盘前备份项目文件 + 落**反向档**；**不动笔记**（原字段原地不动 = 后悔药级保险）。⚠️ 跑 `--apply` 前先在司天里关闭该项目（内存态会把改动盖回去）
- **剧本账本 v2 迁移（2026-10-21）**: `node scripts/migrate-ledger-v2.mjs --project <file.sitian> [--apply]`（默认 dry-run 出每代清点；`--apply` 自动备份 + 读回校验）。每代写入 `initialOwnership` + 物化 `changeEvents`（含 `synthesized` 标记），`ownership` 保留为缓存；真实 415 省项目 +6.1% 体积、0 派生冲突。⚠️ 先关闭项目再 apply。
- **事件账本查询/录入（2026-10-22，三刀第一刀）**: `node scripts/ledger-query.mjs --project <file.sitian> --at 1350 --a 瓯 --b 梁`（答「某年两方什么关系」）；`--list` 清点；`--add '<json>' --apply` 录入（默认 dry-run，写前备份 + 写后读回校验；PowerShell 用 `--add @事件.json`）。语义/形状见 [docs/SCENARIO_EVENT_LEDGER.md](docs/SCENARIO_EVENT_LEDGER.md)
- **账本引擎 v3 试算（2026-10-24，第 3 件）**: `node scripts/ledger-dryrun.mjs --project <file.sitian>` —— **只读**：把每段剧本的 `initialOwnership + changeEvents` 迁成事件流（`src/ledger/`）再回放，与落盘缓存 `ownership` **逐省对拍**；有冲突非 0 退出，跑完自证文件未动。回放是**唯一实现**（`src/ledger/replay.js`；`utils/scenarioLedgerV2.deriveFrom` 只是 v2 形状适配器）。415 孤本实测：13 段 / 冲突 0 / 11ms
- **读料扫描（2026-10-22，三刀第二刀）**: `node scripts/vault-scan.mjs --vault <库根> --out <目录> [--geodata]` —— 全库只读归类（地图实体 / 资料 / 待人工），产物 `scan-report.json` + `待人工.md`（每条带原因与凭据）+ 可选 `geodata.json` 试导；输出目录在库内会被拒绝，跑完自动对比库指纹证明一个字节都没写。归类口径见 [docs/VAULT_BRIDGE.md](docs/VAULT_BRIDGE.md)
- `.sitian` 缓存垃圾清理: `npm run clean-cache-junk`（默认 dry-run，`-- --apply` 才写盘；清空名地形 / 空壳底图 / 测试残留节点，删前自检「引用 / 包围盒 / 子节点」，备份落 `backups/cleanup-<ts>/`）
- **备份目录瘦身（2026-10-30 用户拍板：保留最近 3 份）**: `npm run prune-backups`（默认 dry-run，`-- --apply` 才动盘）。每个 `<项目>.sitian.backups/` 与 `<库>/.sitian/backups/` 按 mtime 留最近 N 份（`-- --keep 5` 可改），**超出的"复制 → 校验大小 → 删源"移到归档盘**（默认 `E:\归档\司天备份-<日期>`，不删）；`*.session-baseline.sitian`（打开时的样子）**不参与轮转**。应用侧同口径：`projectHandler.js#BACKUP_KEEP = 3`、`main/index.js` 缓存备份 = 3
- **隐私与署名扫描（发布门槛③，2026-11-05）**: `node scripts/privacy-scan.mjs` —— 三个作用域
  （`code` = `src/` + `scripts/`、`docs` 非归档区、`root` = README/LICENSE/package.json/构建配置）
  扫私人专名与私人路径，**必须 0 命中**；`--signature` 断言 LICENSE / README 的“暮雨”还在
  （**署名要保留**，作者名不在黑名单里）。词表存 `scripts/privacy-terms.js`（base64，明文不落库 ——
  否则扫描器自己就是最大的泄漏点）；`--self-test` 是负向探针，`unit/test_privacy_scan.js`
  把它接进回归（塞真专名必须报；词表文件里也不许出现明文）。
- **诊断包真机演练（发布门槛④，2026-11-05）**: `python scripts/tests/drill_diag_package.py` —— 起
  Vite(5180) + **真实 Electron**（CDP 9224），页面里调 `sitianAPI.diagExport({target})`（走**与按钮完全相同**
  的 IPC），再用 Python `zipfile` **真实解压**核对：两条目、版本/Electron 版本非空、项目计数原样、
  配置只有“空不空 + 盘符”、包内无盘符绝对路径与 `\Users\`。产物 `build/diag-package/`。
  ⚠️ 也会开真实窗口；Windows 重定向 stdout 默认 GBK，脚本里已 `reconfigure(encoding='utf-8')`。
- **示例项目（发布门槛②，2026-11-05）**: 仓里带一份**自造**示例 `sample/示例世界.sitian`
  （72 省 / 4 势力 / 两段时代 / 656 河 / 22,002 格；预览 `sample/示例世界-预览.png`）。
  入口：世界选择页的「示例地图项目」或项目面板的「示例项目」→ 主进程把它**复制到文档目录**再打开
  （asar 只读，直接开会保存失败）。示例带一棵小实体树（世界 → 行星 → 3 区域）。
  重新生成：`python scripts/tests/
```


> ⚠ 上表只是**一级目录**。项目的「分层」往往不等同于目录：像司天那样「生成器 vs 编辑器」是**两套读法**，两者共用同一个 `utils/`。所以你要做的是：把上面的目录**归成几块**，每块回答'这是什么'。

## 5 方寸已经推出来的（供你参考，可能错）

（自动推导**没推出来**：只推出 1 层（至少要 2 层才算「分层」）—— 文档里点到的东西集中在 src/（当前红线（跨模块、动手之前必须知道）） —— 所以更需要你判断）

## 6 现有 spec（**请在这份上改**，不要重写）

```json
{
  "_comment": "司天「声称的分层」——来源：暮雨 2026-11-15 原话『司天本质是生成器+编辑器』+ AGENTS.md 七层视图架构表。这是**人给的口径**，脚本只负责按这个口径去数，不负责替人决定哪层叫什么。",
  "source": "2026-11-15 交接日志 log_20261115151047_scjs3p §2.5（暮雨原话『司天本质是生成器+编辑器』）",
  "layers": {
    "生成器（地形/生物群系/河流派生）": {
      "paths": ["src/renderer/src/utils/terrain*"],
      "note": "utils/terrain*.js 8 个模块：Synthesis / Erosion / Hills / Labels / Params / Pipeline / Representation / Brush"
    },
    "账本引擎": {
      "paths": ["src/ledger/"],
      "note": "src/ledger 目录：schema / stroke / replay / migrate / groups / index"
    },
    "编辑器 · 历史剧本": {
      "paths": ["src/renderer/src/scenario/", "src/renderer/src/utils/scenario*", "src/renderer/src/components/Scenario*"],
      "note": "scenario 目录 + utils/scenario* 12 个模块 + components/Scenario* 7 个组件"
    },
    "编辑器 · 建筑内部": {
      "paths": ["src/renderer/src/interior/", "src/renderer/src/components/InteriorView.vue"],
      "note": "interior 目录 17 文件 + InteriorView.vue"
    },
    "编辑器 · 星域": {
      "paths": ["src/renderer/src/galaxy/", "src/renderer/src/utils/galaxy*"],
      "note": "galaxy 目录 6 文件 + utils/galaxyLayout.js 等"
    }
  },
  "groups": {
    "生成器": ["生成器（地形/生物群系/河流派生）"],
    "编辑器（三种读法合计）": ["编辑器 · 历史剧本", "编辑器 · 建筑内部", "编辑器 · 星域"],
    "账本引擎": ["账本引擎"]
  },
  "claims": {
    "生成器（地形/生物群系/河流派生）": 2711,
    "账本引擎": 1110,
    "编辑器 · 历史剧本": 18428,
    "编辑器 · 建筑内部": 9931,
    "编辑器 · 星域": 1955
  },
  "claimsNote": "这五个数来自 2026-11-15 深夜我**手工**算的（交接日志 §2.5 表格）。2026-11-16 用本脚本复算：账本引擎 1,110 与建筑内部 9,931 完全对上；生成器 2,711 对上；剧本与星域比声称的**多** 6,286 / 607 行 —— 因为手工那晚我按 `scenario/` 与 `galaxy/` 目录算，漏了 `utils/scenario*`、`utils/galaxyLayout.js`。所以「实测≠声称」不代表代码变了，是**当时的口径没写清**。这正是这个脚本要解决的问题。"
}
```

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

1. 把 JSON 写进 `task-data/layer-specs/sitian.json`
2. 回报一段话，说清四件事：
   - 分了哪几层，每层一句话
   - 依据是哪个文档的哪一节（**必须能指回原文**）
   - 哪些路径你验过存在（实测）、哪些是推测
   - 有没有「两套读法」这种需要 `groups` 的情况；没有就明说没有
3. **不要打包、不要提交 git、不要改任何项目文件**
