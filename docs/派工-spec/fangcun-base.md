# 派工单：给「方寸」写分层 spec

- 卡类型：数据整理（产出一份 JSON 文件，不改任何代码）
- 项目：方寸（`fangcun-base`）
- 仓库根：`E:/CODE/CangKu/fangcun`
- 产物落点：`task-data/layer-specs/fangcun-base.json`（**方寸数据目录**，不是项目仓库）

## 1 任务目标

把「方寸」**自己声称的分层**写成一份 spec JSON，供方寸回答一个问题：

> 这个项目号称是 A，但 88% 的行数在 B。

⚠ 这句话**只能靠你判断**，因为「哪几层是一伙的」是项目的自我认知，不是目录结构。
方寸已经把**事实**算好了（下面第 3 节），你只需要做**归类与命名**。

## 2 工作目录 / 范围

- 只读项目仓库（**一个字都不许写进去**）：`E:/CODE/CangKu/fangcun`
- 唯一允许写入的地方：方寸数据根的 `task-data/layer-specs/fangcun-base.json`
- **不许改代码、不许改文档、不许 git 操作**

## 3 已经算好的事实（别自己重新数）

方寸扫盘结果：**产品 128,091 行**（全仓合计 194,404 行，含测试与脚本）。

> 口径：只数能解码成文本的文件（二进制不算）；排除依赖 / 构建产物 / 打包目录 /
> 内嵌运行时 / 隐藏目录。`.ts` 可能是 MPEG 视频分片，GBK 脚本是文本不是二进制 ——
> 这两条方寸已经处理过，**你不用再踩**。

| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |
|---|---|---:|---:|
| `scripts/test` | 测试 | 189 | 40,849 |
| `desktop/src/main` | 产品 | 102 | 32,951 |
| `desktop/src/renderer` | 产品 | 97 | 32,467 |
| `docs` | 产品 | 6 | 30,008 |
| `desktop/test` | 测试 | 3 | 14,798 |
| `desktop/src/shared` | 产品 | 57 | 10,699 |
| `scripts` | 工具 | 45 | 10,555 |
| `tegula` | 产品 | 5 | 10,438 |
| `(根)` | 产品 | 8 | 3,463 |
| `references` | 产品 | 7 | 3,148 |
| `templates` | 产品 | 1 | 2,866 |
| `desktop/src/preload` | 产品 | 1 | 533 |
| `desktop/public` | 产品 | 1 | 525 |
| `desktop/src` | 产品 | 2 | 497 |
| `desktop/src/cli` | 产品 | 1 | 120 |
| `scripts/lib` | 工具 | 1 | 111 |
| `assets` | 产品 | 2 | 108 |
| `desktop/task-data` | 产品 | 1 | 92 |
| `task-data` | 产品 | 1 | 92 |
| `desktop` | 产品 | 3 | 84 |

### 被规则挡在分母外面的（方寸已排除，列出来让你知道）

- `.backup` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.git` —— 版本库
- `.hermes` —— agent 私有目录
- `.shots-tmp` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.tmp-test` —— 隐藏目录（VCS / 浏览器 profile / 缓存）
- `.workbuddy` —— agent 私有目录
- `__pycache__` —— 字节码缓存
- `backups` —— 备份
- `desktop/dist` —— 构建产物
- `desktop/node_modules` —— 依赖
- `desktop/pkg` —— 发版取件目录（官方定义：desktop/pkg 放安装包）
- `desktop/public/__pycache__` —— 字节码缓存
- `desktop/task-data/.backup` —— 打包/构建产物（前缀规则）
- `desktop/task-data/.trash` —— 回收站
- `desktop/task-data/plans/.backup` —— 打包/构建产物（前缀规则）
- `desktop/task-data/plans/_drafts/.backup` —— 打包/构建产物（前缀规则）

## 4 项目自己怎么说自己（骨架原文）

### `AGENTS.md`（37982 字，下面只带前 6000 字）

```markdown
# 方寸 (Tegula)

> **开工前先读 [`立项契约.md`](./立项契约.md)** —— 终态形态 / 验收线 / 不要什么 / 选型定死。
> 契约的**第一个读者是 AI**：与“最新一句话”冲突时以契约为准，除非走 REV 修订留痕。
>
> **不知道文档在哪 → 先读 `task-data/plans/fangcun-base.md`（唯一施工跑道 P0–P7），
> 再在 `docs/执行日志/` 里搜标题含“跑道交接”的日志（一张可直接执行的交接单）。**
> `docs/` 下 307 份 md 绝大多数是过程附件，**别按目录顺序读**；`开发日志.md` 已停用，只当历史存档。

**零依赖本地多 agent 任务看板**（Python stdlib；`tegula/` 包 = `cli.py` 2363 + `core.py` 4688 + `web.py` 662，`tegula.py` 只是 19 行 wrapper；看板用 http.server，端口 8753）。为您创造全部项目的统一任务入口。

> ⚠ **接手方寸的活，先读 `docs/方寸-待办长Loop-20261112.md`**（2026-11-12 收口）。
> 那是**唯一一份**待办长 loop：现状快照、按代价排序的 P0–P3 清单、每条的可机检判据、
> 以及这一轮暴露的六个机制病灶。**别再造第七份待办文档** —— 要改就改那一份。
> 起因：暮雨「文档已经够多了，没做完的内容更多」「后续没空一点一点人工测」。

## 定位（边界写在这里，省得每次重新吵）

**“任务收口 + 方针载体”** —— 不是全周期管理平台。**LLM 智能层：本阶段接，但是 BYOK**（见下三条边界）。
约束力来自 **唯一入口 + 低摩擦 + 有收益**。

**LLM 智能层的三条边界**（REV-005，2026-10-12 暮雨拍板；越界即为不受理）：
① **BYOK** —— 端点/模型名/密钥由用户在设置页自填，方寸不连任何默认端点、不预置钥匙；
② **产出只落“待审批”卡** —— 用户点头才转正，AI 不能背着你往方寸里塞东西；
③ **花销每次可见** —— 写回入口与界面 toast 都透传 usage。

- ⚠ 这两条都不是"我猜的"，是契约 ③ 的成文条款 + 文末 **REV-003 / REV-004**（2026-10-10 拍板）留痕。
  想往“完全的项目管理系统”或“内置智能层”方向做的提案，**先走 REV 改契约**，别在实现里顺手做掉。
- ⚠ 反面教材（2026-10-11 实测）：卡 `20261008-005` 一直把 **0.3.2 发布说明里已被收回的那句话**
  当方向证据 —— 于是一个越界提案看起来像"顺理成章该做的功能"。**契约改了就要回头清现场。**
- 显式不受理：运营期要用户手动喂的规划工具 · 重型表单/流程引擎 · 写别人的仓库（对项目 repo 只读）。

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
- **版本号（2026-11-07 起改一处即可）**：`node scripts/version.cjs check` / `set x.y.z`
  真源只有 `desktop/package.json`，另有**三处派生**：`desktop/package-lock.json`（曾停在 0.3.10）·
  `skills/manifest.json`·`desktop/src/main/mcp/handler.ts` 的 `serverInfo.version`（曾停在 0.3.9，
  于是 Hermes 看到的 MCP 服务自称 0.3.9 而实装 0.6.6）。`pack.cjs` 打包前**强制跑 check**，不靠人记得。
- **打包（推荐，2026-10-27 起）**：`node scripts/pack.cjs <版本号>`
  一条命令做四件事：① 打包前清空暂存 `.pkg-tmp`，并顺手清历史堆积的 `release-<ver>/`；
  ② 设好三件环境变量；③ 输出**固定单目录** `desktop/pkg`（`.gitignore` 已忽略，不入库）；
  ④ 自检 `app.asar` 里的版本号 + 安装包体积 + 包内 Node 版本。
  ⚠ 版本号真源只有 `desktop/package.json` 一处，脚本会先核对，不一致直接拒绝。
  ⚠⚠ `desktop/pkg` 是**发版取件目录**，**三处路径必须一致**，改一处就要改三处：
  `scripts/pack.cjs` 的 `OUT`｜`scripts/publish-release.sh` 的 `REL_DIR`｜
  `scripts/release-precheck.py` 里的 `desktop/pkg`（2 处）。
  🧹 **保留策略（2026-11-11 暮雨拍板：“禁止永不清理。我自己也会经常删旧版安装包”）**：
  打包收尾时**只留最近 `FC_PKG_KEEP` 个安装包**（默认 **3**），更早的 exe + 它们的 `.blockmap`
  + 孤儿块图一起清掉，并逐条报出来。想多留几版：`FC_PKG_KEEP=10 node scripts/pack.cjs <ver>`；
  想打完只留本次：`FC_PKG_KEEP=0`。
  ⚠ 但**“清”只能由保留策略有意地清**：搬家/换目录时若有文件不明原因消失，
  集合级核对（`carryAudit`）仍会红并保留旧目录 —— “允许清理” ≠ “允许静默丢”。
  ⚠⚠ **打包节奏（2026-11-12 暮雨：“今天又打了很多安装包，没必要，只在做完一大堆东西后一次性打就好了”）**：
  **一轮对话最多打一次包，而且必须是这一轮全部活干完之后。** 中途不打包 —— 理由不是省磁盘，
  是**中间包没有任何人会用**（装上去就是半成品，还得再装一次）。
  - 判据：动手前先说清“这一轮要做哪几件”，**全做完 + 全量回归绿** 才 `pack.cjs`。
  - 打包后如果又发现要改代码 → **不要**打第二个包；把改动积到下一轮一起打。
    （真到了必须重打的情况，用**同一个版本号**重打，别升版本 —— 升版本等于对外宣称“有新版本”。）
  - 反例（要避免）：2026-11-12 当天 0.6.30 / 0.6.31 / 0.6.32 三个包，其实可以合成一个。
  ⚠ **为什么改成单目录**：旧习惯是 `-c.directories.output=release-<ver>`，每打一版新建一个目录，
  三个月积了 15 个（3.4GB），其中 6 个是中断留下的半成品（只有 `app.asar`）。
  ✅ **产物留在工作区里是对的**（旧方寸就这么做）：**固定一个目录 + `.gitignore` 忽略**即可。
  2026-10-27 我一度把输出搬到 `E:\CODE\CangKu\_pkg\`，被暮雨否掉（"抄旧的方寸不都好好的"）——
  堆积的病根是"每版新建目录"，不是"放在工作区里"。**别再搬出去。**
  清理历史垃圾：`clean-release.bat` + `scripts/clean-release-dirs.ps1` ——
  **本机运维脚本，不入仓库**（2026-10-27 暮雨：“退出仓库，不然纯污染”；`.gitignore` 已排除）。
  ⚠ 脚本不在仓库，但**规则在这儿**，换机器按这三句重建：
  ① 只清 `release*`，**永不碰 `pkg`**（`pkg` 是发版取件目录）；
  ② **不需要管理员**（锁是文件索引器持有，退出它即可，不是服务/权限问题）；
  ③ 只盯 `*.asar` 被锁：逐文件删、跳过被锁的、把“仍被占用”**如实列出**，不假装干净。
- 打包安装包（手工方式，**2026-10-22 起要三个环境变量**）：
  ```
  cd desktop
  ELECTRON_OVERRIDE_DIST_PATH="$PWD/node_modules/electron/dist" \
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npx electron-builder -c.directories.output=release-<ver>
  ```
  · `ELECTRON_OVERRIDE_DIST_PATH` **不能省**：不带它 electron-builder 会去下别的版本，10 分钟超时才报错；
  · **两个镜像也不能省**（引擎升到 44 后实测）：只带 override 会在 `label=electron progress=100%` 之后
    立刻 `Response code 502 (Bad Gateway)` —— 它还要从 GitHub 拿 electron zip 的校验文件与 winCodeSign。
    加上 `ELECTRON_MIRROR` + `ELECTRON_BUILDER_BINARIES_MIRROR` 后 31 秒打包成功；
  · `-c.directories.output=` 是为了绕开 `release\win-unpacked.tmp\resources\*.asar` 的 EBUSY（见下）。
  产物落指定目录（`Fangcun-Setup.<版本>.exe` + `.blockmap` + `latest.yml`），`release-*/` 已在 .gitignore。
  ⚠ 直接打 `release/` 会 **EBUSY**（`win-unpacked.tmp\resources\default_app.asar` 被占）→ 换输出目录再拷回。
  **打完必须自检**：读 `win-unpacked/resources/app.asar` 字节确认标识串在里面，
  并跑 `win-unpacked/方寸.exe --version` —— 它打印的是包内 **Node** 版本
  （Electron 28 → v18 / 44 → v24），这是"引擎真换了"最快的判据。
  "打包命令退出 0" 不等于包里有新代码。

## 常用验证方式

仅供开发者参考，日常使用请忽略。

| 层 | 命令 | 作用 |
|---|---|---|
| 数据层 | `python verify.py` | 解析/渲染/乐观锁/备份/老 YAML 写法（**270/0**，24 个检查组；2026-10-14 实测） |
| 主进程 e2e（Node + electron 桩） | `node scripts/test/e2e-{backup,task-fields,notifications,datadir,applog,launchpad,logs}.cjs` | 备份链路、字段一致性、通知、数据根、**应用日志与 IPC 守卫**、**启动台执行器**、**执行日志（改项目/清理超期）**。⚠ **2026-10-11 用户第 2 条**：备份范围补漏（`policies/` 此前**根本不在包里**）+ 新增“备份瘦身”两个旋钮（排除执行日志附件目录 / 跳过超过 N MB 的单个文件，默认 10MB）—— 跳过项**逐条记账**进 `manifest.omittedFiles`（不许静默），并新增 `backup:sizeReport` 把体积构成摊开（体积黑洞是 `docs/执行日志/_attachments` 里一份 57
```


> ⚠ 上表只是**一级目录**。项目的「分层」往往不等同于目录：像司天那样「生成器 vs 编辑器」是**两套读法**，两者共用同一个 `utils/`。所以你要做的是：把上面的目录**归成几块**，每块回答'这是什么'。

## 5 方寸已经推出来的（供你参考，可能错）

自动推导**推出 2 层**（仅供你参考，可能有错）：

- `tegula/（架构速查 (Quick Facts)）` —— 从 AGENTS.md「架构速查 (Quick Facts)」推出；文档里点到 3 个具体文件，例如 `tegula/cli.py`、`tegula/core.py`、`tegula/web.py`
- `templates/（架构速查 (Quick Facts)）` —— 从 AGENTS.md「架构速查 (Quick Facts)」推出；文档里点到 1 个具体文件，例如 `templates/board.html`

## 6 现有 spec（**请在这份上改**，不要重写）

```json
{
  "_comment": "方寸自己的分层。口径来源是本仓 AGENTS.md 的「架构速查」+ docs/ARCHITECTURE_MAP.md —— 不是我猜的：那里写着「tegula/ 包 = cli.py / core.py / web.py；desktop/src/main 是主进程、renderer 是界面、shared 是两侧共用纯逻辑；scripts/test 是回归」",
  "source": "本仓 AGENTS.md「架构速查 (Quick Facts)」+ docs/ARCHITECTURE_MAP.md",
  "layers": {
    "界面（Vue 渲染层）": {
      "paths": ["desktop/src/renderer/"],
      "note": "App.vue + views/ + components/ + composables/。契约 ② 验收线要看的就是这一层"
    },
    "主进程（Electron main）": {
      "paths": ["desktop/src/main/"],
      "note": "IPC 通道 + services（读卡/扫盘/备份/git…）"
    },
    "preload 桥": {
      "paths": ["desktop/src/preload/"],
      "note": "contextBridge 暴露面，一条通道一行"
    },
    "共享纯逻辑（两侧共用）": {
      "paths": ["desktop/src/shared/"],
      "note": "blockers / boardCards / layerProfile 这类**可被 node 直跑断言**的纯函数"
    },
    "CLI 与看板服务（Python）": {
      "paths": ["tegula/", "tegula.py", "verify.py"],
      "note": "零依赖红线：http.server + stdlib，看板端口 8753"
    },
    "回归与守卫": {
      "paths": ["desktop/test/"],
      "note": "e2e 的 Electron 主进程 + 假 preload / DOM 断言（scripts/test 归工具，不算产品）"
    }
  },
  "groups": {
    "界面 + 主进程 + preload + 共享（产品代码）": [
      "界面（Vue 渲染层）", "主进程（Electron main）", "preload 桥", "共享纯逻辑（两侧共用）"
    ],
    "CLI 与看板服务（Python）": ["CLI 与看板服务（Python）"]
  }
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

1. 把 JSON 写进 `task-data/layer-specs/fangcun-base.json`
2. 回报一段话，说清四件事：
   - 分了哪几层，每层一句话
   - 依据是哪个文档的哪一节（**必须能指回原文**）
   - 哪些路径你验过存在（实测）、哪些是推测
   - 有没有「两套读法」这种需要 `groups` 的情况；没有就明说没有
3. **不要打包、不要提交 git、不要改任何项目文件**
