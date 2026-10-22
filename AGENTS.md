# 方寸 (Tegula)

> **开工前先读 [`立项契约.md`](./立项契约.md)** —— 终态形态 / 验收线 / 不要什么 / 选型定死。
> 契约的**第一个读者是 AI**：与「最新一句话」冲突时以契约为准，除非走 REV 修订留痕。

**零依赖本地多 agent 任务看板**（Python stdlib；`tegula/` 包 = `cli.py` 1991 + `core.py` 4231 + `web.py` 711，`tegula.py` 只是 19 行 wrapper；看板用 http.server，端口 8753）。为您创造全部项目的统一任务入口。

## 定位（边界写在这里，省得每次重新吵）

**「任务收口 + 方针载体」** —— 不是全周期管理平台。**LLM 智能层：本阶段接，但是 BYOK**（见下三条边界）。
约束力来自 **唯一入口 + 低摩擦 + 有收益**。

**LLM 智能层的三条边界**（REV-005，2026-10-12 暮雨拍板；越界即为不受理）：
① **BYOK** —— 端点/模型名/密钥由用户在设置页自填，方寸不连任何默认端点、不预置钥匙；
② **产出只落「待审批」卡** —— 用户点头才转正，AI 不能背着你往方寸里塞东西；
③ **花销每次可见** —— 写回入口与界面 toast 都透传 usage。

- ⚠ 这两条都不是"我猜的"，是契约 ③ 的成文条款 + 文末 **REV-003 / REV-004**（2026-10-10 拍板）留痕。
  想往「完全的项目管理系统」或「内置智能层」方向做的提案，**先走 REV 改契约**，别在实现里顺手做掉。
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
- 打包安装包: `cd desktop && ELECTRON_OVERRIDE_DIST_PATH="$PWD/node_modules/electron/dist" npx electron-builder`
  —— ⚠ **那个环境变量不能省**：不带它，electron-builder 会去下载 electron 28.3.3（本机缓存里通常没有，
  只有别的版本），然后 10 分钟 `Timeout awaiting 'request' for 600000ms` 才能知道失败；带上后约 45 秒。
  产物落 `desktop/release/`（`Fangcun-Setup.<版本>.exe` + `.blockmap` + `latest.yml`）。
  **打完必须自检**：读 `win-unpacked/resources/app.asar` 字节，确认本轮新增的标识串真的在里面 ——
  "打包命令退出 0" 不等于包里有新代码。

## 常用验证方式

仅供开发者参考，日常使用请忽略。

| 层 | 命令 | 作用 |
|---|---|---|
| 数据层 | `python verify.py` | 解析/渲染/乐观锁/备份/老 YAML 写法（**270/0**，24 个检查组；2026-10-14 实测） |
| 主进程 e2e（Node + electron 桩） | `node scripts/test/e2e-{backup,task-fields,notifications,datadir,applog,launchpad,logs}.cjs` | 备份链路、字段一致性、通知、数据根、**应用日志与 IPC 守卫**、**启动台执行器**、**执行日志（改项目/清理超期）**。⚠ **2026-10-11 用户第 2 条**：备份范围补漏（`policies/` 此前**根本不在包里**）+ 新增「备份瘦身」两个旋钮（排除执行日志附件目录 / 跳过超过 N MB 的单个文件，默认 10MB）—— 跳过项**逐条记账**进 `manifest.omittedFiles`（不许静默），并新增 `backup:sizeReport` 把体积构成摊开（体积黑洞是 `docs/执行日志/_attachments` 里一份 57MB 的误挂 bundle）。`e2e-backup` 含断言：「报告说会跳过什么」与「备份时真跳过什么」**逐条一致**（同一套判据 `planSnapshot`） |
| **备份多通道 · restic / Git（卡 20261002-003）** | `node scripts/test/e2e-restic-script.cjs` / `e2e-git-backup.cjs` | **restic**：只生成脚本（方案 A），三条红线 = 密码不进脚本 + 密钥文件必须 exclude（用备份包同一份 `SECRET_BASENAMES`）+ 不替用户注册定时任务，18 条含反例。**Git**：`gitBackupPure.ts` 纯逻辑（令牌不进 argv / 输出脱敏 / `GIT_TERMINAL_PROMPT=0` / 「令牌被拒」与「无凭据」分开报 / 地址内嵌令牌抽出）+ **真 git 端到端**（临时裸仓库跑 clone→commit→push→被拒→fetch+reset --soft 补救，**不用 --force**）+ **执行器本体端到端**（electron 桩 + 临时 userData，把「点一下按钮」真跑通）。70 条，含反例自证。⚠ 2026-10-11 真机修的三处：`ls-remote --exit-code` 在**空仓库**上「退出码 2 + 零输出」被翻成"未能识别"（用户看到"填了地址说失败"）、clone 失败盲目退化 init 吞掉真因、`fail()` 回 `error` 而渲染层只读 `message` → 异常变成"没有返回结果"。**⚠ 2026-10-11 用户第 1 条后语义变了**：这条通道**不再推压缩包**，改成把 `task-data/ + registry.yaml + policies/ + docs/` 的**真实文件镜像进仓库工作树**（每文件可 diff 的历史）—— 用户原话「全世界没有任何软件的 git 备份直接扔压缩包上去…那要 git 有什么用？」。断言随之加了"仓库里是 `.md` 而不是 `.zip`""改一行在历史里看得见""删文件会跟着删""密钥类不进仓库"，以及源码守卫（不许再出现 `copyFileSync(zipPath`）。85 条 |
| 任务删除/归档健壮性 | `node scripts/test/e2e-task-delete.cjs` | **同名重复副本（archive/ 与 .trash/ 同 id）下 delete/archive/unarchive 不抛异常、幂等、去重；readTask 优先活跃区** |
| **装到别的 agent（目标检测 + 多目标安装）** | `node scripts/test/e2e-agent-targets.cjs` | **装卡区必须有 DSH（此前根本没有这一条 → 用户「检测不到 DSH 装了」的真因）**：DSH 落点 `~/.dsh/skills`、与 Hermes 同级可直装；「已接入」两问 = 技能副本 + MCP 配置含 fangcun，**落点不可知时给 `undefined` 而不是 `false`**；多目标安装各目标分账（不串目录）、未知目标显式报错；**DSH 不在场时不许给它造目录**；含反例（删掉 `~/.dsh` → `detected=false`） |
| **已完成任务自动归档（卡 012）** | `node scripts/test/e2e-archive-overdue.cjs` | 判据 =「状态=完成 **且** 更新时间早于 N 天」——刚动过的不收、非完成的不收、没写时间的退 mtime（不是"老得不能再老"）；**保留天数 0 = 关闭，默认必须关**；归档**真把文件移进 archive/**（不是只改状态那种假归档）且可逆；数字时间戳按**秒级**解析（毫秒写法跑到未来 → 不收，钉成负面案例） |
| 渲染层纯逻辑 | `node scripts/test/e2e-calendar.cjs` | 日历跨月/时间段算术（tsc 编 calendar.ts 后直接断言） |
| **渲染层纯逻辑（时间 / 分组）** | `node scripts/test/e2e-timefmt.cjs` / `e2e-grouping.cjs` | **时间解析：数据里同时有 ISO / 秒级 Unix 数字 / MM-DD 三种写法，坏输入必须给 `—` 而不是 Invalid Date/NaN**；**看板分组：标题必须是项目名而不是内部 id、跨项目计数、未归属任务不丢分组** |
| **阻塞链关键路径（卡 023）** | `node scripts/test/e2e-blockers.cjs` | **本机可跑**：真跑编译产物 `dist/shared/blockers.js`（算法在 `src/shared/blockers.ts`，**不埋在组件里**）。判据 = 「解哪个阻塞最划算要算**传递效应**」：A 挡住 B、B 又挡住 C ⇒ 解 A 值 **4** 而不是 2（只数 `blockedTasks.length` 是错的）；另覆盖「一个任务被多个源挡着时解一个不够」「已终态的源不进推荐」「已完成的被阻塞任务不算收益」「纯函数不改传入数组」。9 条 |
| **看板信息卡墙（卡 20261010-003）** | `node scripts/test/e2e-board-cards.cjs` | **本机可跑**：真跑编译产物 `dist/shared/boardCards.js`（纯逻辑在 `src/shared/boardCards.ts`，**不埋在组件里**）。判据 =「**卡面上宁缺勿滥**」：取不到的值**整格不渲染**（不写 0、不写「—」、也不糊一个近似色档）。覆盖短 ID 只剥已知前缀、优先级只认三档中文、阻塞索引（多源 / 去重 / 终态不计 / 源已终态不进计数）、`openOnly` 只看未完成（**空状态算未完成** —— 没填 ≠ 做完）；另含 **9 条源码守卫**：卡片墙必须跑 `columns` 分区（首版平铺 filteredTasks → **分组整个丢失**，用户截图才发现）、分区头可折叠、组容器接 drop、开关**默认关**且**只读过滤不回写 columns**。41 条，含两处反例自证 |
| 渲染层真点击 | `node scripts/test/e2e-renderer.cjs` | **真 Electron 跑 dist/renderer + 真点按钮**（需桌面会话；受限环境自动 SKIP） |
| **渲染层 DOM（无头浏览器兜底）** | `node scripts/test/e2e-renderer-web.cjs` | **本机可跑的渲染层断言（358/0）**：多视图互斥与几何、排序/视图选择落盘、弹药库派工单六字段、**遮罩拖选不误关**（拖选滑出弹窗 → 不许关；真点遮罩 → 仍关得掉）、**死通道接回验收**（快速记必须真调 `quickAdd` 且**原样传整段简写串**、跨项目建议/里程碑/诊断三块的文案必须来自主进程、备份列表刷新必须真重读）—— 用系统 Edge/Chrome 无头加载 `dist/renderer` + 同一份假 preload；产物必须单块（有顶层 import/export 会显式报错而不是静默降级）。它验不了真 IPC / 真点击，那些仍以 `e2e-renderer` 为准 |
| **IPC 载荷过 bridge** | `node scripts/test/e2e-bridge-clone.cjs` | **真 Electron + 真 preload：裸 Vue 代理过 contextBridge 必抛「could not be cloned」、过 `toPlain()` 后必通过；含精确静态守卫 + 红测自证** |
| **剪贴板复制** | `node scripts/test/e2e-clipboard.cjs` | **真 Electron + 真 preload + 真读回剪贴板：file:// 起源下的复制走主进程 IPC 通道成立；含「掐掉 IPC 后浏览器路径确实失败」的危害复现 + 静态守卫（渲染层不得再有裸 `navigator.clipboard`）** |
| **在途一屏（Q2 · 契约验收线①）** | `node scripts/test/e2e-trip-board.cjs` | **真跑编译产物 `dist/main/services/tripBoard.js` + 临时数据目录**（本机可跑，不用 spawn）：契约六字段解析（标题带 ①② 也认）、四种判据各命中谁、**无卡项目 current 回落到执行日志**（司天那类 0 卡项目唯一的数据源）、**缺值给空串而不是默认值**、健康度人工覆盖 + 非法值回落机器默认、**manual 模式必须优先于判据**（首次实现漏了这条，测试当场抓到）、**「手动指定」但 `fc_trip_projects` 键不存在 → 兜底回自动**（2026-10-05 用户「一屏是空的」的真因：字符串键落了盘、数组键没落，清单为空 → 15 个全出局）＋反例「键存在但为空数组 → 尊重用户选择、不回退」＋**manual 下未勾的项目原因必须说「手动指定」而不是「没有未完结任务」**、`repoOfProject` 不产出未登记路径（防任意路径打开）、契约模板含六字段。32 条 |
| **registry 增删项目** | `node scripts/test/e2e-registry.cjs` | **真跑编译产物 + 临时注册表**：增/删都是**文本块**级操作（不是 yaml dump 重写）—— 钉住「顶部注释与自定义中文字段**逐字节保留**」「删一个项目**不吃掉隔壁、不吃掉 released 段**」「删不存在的 / 非法 / 空 id → 显式报错且**文件零改动**」「删登记**不动 task-data**（卡还在，只是变未归属）」「全删干净后仍是合法注册表」。22 条 |
| **registry 三字段写回（06 单）** | `node scripts/test/e2e-registry-fields.cjs` | **真跑编译产物 + 临时注册表**：`状态 / 路线图 / 说明` 三个中文字段的写回 —— 钉住「**文本块级就地替换**，注释/members/released/隔壁项目逐字节保留」「**白名单**：传 name / repo 之类 → 显式报错且**文件零改动**（不静默忽略）」「写前自校验：项目数不变 + 读回值 === 期望值」「**回传 before**，撤销条靠它反推回滚」「缺失字段追加在**本项目块内**（不能掉到下一个项目下面）」「含全角冒号 / # / 引号的值必须转义对 —— 不做转义时自校验会当场拦下（已做反例：注入 → 3 条精确变红 → 还原）」「同值写回 **changed 为空且不写盘**」。40 条 |
| **agent 上下文包（b 版落地物）** | `node scripts/test/e2e-context-pack.cjs` | **真跑编译产物 + 临时数据目录**：把项目现状拼成一段能直接粘给 agent 的 Markdown —— 钉住「拼进来的必须是**原文**（契约多行块/表格不许被塞进一行列表、不许摘要改写）」「决策**只列有效**（已撤销的不许出现，否则 agent 把撤销过的当现行规矩）」「全局决策（项目为空）对每个项目都算数」「未完成卡按优先级、已完成不进」「**缺什么必须说出来**：`missing` 逐项 + 正文末尾『缺不等于没有』」。29 条，含反例（不筛决策状态 → 精确 1 条红） |
| **随纠 · 一句话改方向（03 任务二）** | `node scripts/test/e2e-correct.cjs` | **真跑编译产物 + 临时数据目录**：钉住「纠得动」的三个前提 ——「只认**三种固定句式**（改/把…改成/`=`），认不出就明说、**零写入**（不许猜一个方向改掉用户方针）」「改完必留痕：决策卡含项目名 + 从什么到什么 + 出处『方寸随纠』+ 日期」「撤销把字段写回旧值，**并把决策卡一并标『已撤销』**（只改回字段却留一张"已定案"的卡＝台账说假话）」「改成同值 → 拒绝且**不产生**垃圾决策卡」「句子点名了项目就按句子走，不按调用方给的 id 改错项目」「preview 零副作用」。37 条 |
| **随问 · 结构化查询（03 任务一）** | `node scripts/test/e2e-ask.cjs` | **真跑编译产物 + 临时数据目录**：钉的是**成本红线**不是"能问出话"——「10 类典型问题全部 `needsLlm=false`（03 验收线 ≥8/10）」「**只有**含糊到结构化算不出来的句子才 `needsLlm=true`（反例二连：「接下来该不该…」是判断题，不许被 next 认领；「你觉得这个方向对不对」必须落到答不了）」「数字与夹具**真身**对得上（不写死条数）」「没填截止日的不进逾期口径；源卡已完成的不算挡路」「没报 usage 的调用不折算 token」「**零副作用**：问十遍 registry / task-data / ai-trace 一个字节不变」「常用问题每条都能被结构化接住」。47 条 |
| **UI 偏好持久化** | `node scripts/test/e2e-prefs.cjs` | **Agent 预设真身在 `userData/prefs.json`：合并写入·原子替换·坏文件回退；要害断言＝模拟换 origin（localStorage 清空）后清模块缓存重载，值仍在磁盘上** |
| **端口/服务登记** | `node scripts/test/e2e-ports.cjs` | **真起 TCP 监听，断言 netstat+tasklist 对表读出的 PID 就是本进程**；登记源（apps.json port + 手填清单）合并·重复端口预警·坏文件不静默·未登记列表两道路滤网（端口段 + 像服务的进程白名单）·**实现里不许有杀进程能力（源码扫描断言）**；一键启动只认启动台登记过带 port 的应用 |
| **技能直接导入** | `node scripts/test/e2e-skill-import.cjs` | 文件夹 / .zip（含目录条目 + deflate）/ 外壳目录 / 单 .md 四种输入；缺 SKILL.md、YAML 缺字段、zip slip **一律零写入**；重名默认拒绝、方寸自发布技能永不被覆盖；移除只认带导入标记的目录 |
| **自仓启动同步（W1-1C）** | `node scripts/test/e2e-self-sync.cjs` | 真临时裸仓库跑 `git pull --ff-only`：远端有新提交 → 落地（state=ok，读回 registry 真有新内容）；**本地领先/分叉 → 必须拒**（HEAD 不动、工作区不被覆盖）；无上游 → 分到「没有上游」；用户理顺后下一次恢复 ok。源码守卫钉三条：只 `--ff-only`、`GIT_TERMINAL_PROMPT=0`（否则没凭据时静默挂成僵尸）、异步 spawn + 硬超时。⚠ 夹具里**故意装回 `pull.ff=true` 的危险默认** —— 本机 git 2.55 没配它时自己也会拒，不装则反例假绿 |
| **实况回流 · 路线文档（W1-批次2）** | `node scripts/test/e2e-repo-docs.cjs` | 真仓库读 **README / ROADMAP**（README 只取一句话摘要）+ 最近动过 `docs/` 的提交；**只读**（跑完 `git status` 仍为空、文档 mtime 不变）；一天一批（`cached`/`readAt` 判据，force 绕过）；缺一份就是 `null`（不造空壳）；四种"读不到"各有各的话。⚠ 必须 `-c core.quotepath=false`，否则中文路径是八进制乱码 |
| **两份 W1 评估报告的合同守卫** | `node scripts/test/check-w1-reports.cjs` | 施工单对这两份文档有硬字段要求：引擎评估必须有「升/不升/缓升」三选一 + **本次没验的东西**；拆分方案必须含**回滚路径（快照点 + 灰度开关）**。只校验结构不校验行文 —— 防的是"太长了一次精简"把决策依据删掉 |
| 静态守卫 | `check-ipc-parity` / **`check-template-bindings`（四项）** / `check-button-styles` / `check-themes` / **`check-skills`（改技能必跑）** / **`check-ui-copy`（改界面文案必跑）** | **死通道 44→31→18→0（2026-10-11 归零）**：接回 8 条（`quickAdd`/`loadActivity`/`selfCheck`/`skillsCheck`/`suggestActions`/`detectParallelOpportunities`/`suggestCrossProject`/`suggestMilestones`）、删死暴露 5 条（函数保留，另有调用方走函数不走 IPC）、登记豁免 18 条（每条写明理由，**扫描器每次运行都把这份清单打印出来** —— 登记 ≠ 藏起来）。僵尸按钮·僵尸通道·未接线模块·模板未声明标识符·**脚本内调用未定义函数**·**定义但零引用的死函数（漏接入口）**·**遮罩用 `@click.self` 关闭（拖选滑出弹窗会被当成"点了遮罩"而关掉弹窗 —— 必须 `@mousedown.self`）**·按钮用了 class 却无全局样式·主题对比度·**技能版本漂移与副本分叉**·**Markdown 标记（`**`/反引号）漏进界面文案（Vue 不解析 Markdown，用户看到的是字面星号）** |
| **frontmatter 跨语言契约（改写盘必跑）** | `node scripts/test/e2e-fm-contract.cjs` | **TS 与 Python 读同一份 `task-data/*.md` / `docs/执行日志/*.md`**：块式列表、行内列表、引号、空值两个方向各走一遍 —— 首跑即抓到 `_parse_log` 把块式 `附件:` 读成空串（＝下次写回静默清空）；源码守卫：TS 日志 `yaml.dump` 必须带 `flowLevel:-1`（列表一律内联）、TS 任务写盘仍走 yaml.dump |
| **MCP 读口契约** | `node scripts/test/e2e-mcp-views.cjs` | **真跑编译产物 `dist/main/mcp/tools.js` + 临时数据目录**（纯 Node 下 `setDataDir` 的持久化分支被 try/catch 吞掉，不会动真实数据目录）：`view=trash` 必须返回回收站而不是活跃+归档、`search_tasks` 必须能搜到归档、`project` 过滤对数组字段生效；源码守卫：禁止私有读扫描回潮 |
| **主题对比度（多主题后必跑）** | `node scripts/test/check-themes.cjs` | 六套浅色主题**逐套实测 13 对 WCAG 对比度**（正文压底 / 次要文字 / 白字压品牌色 ≥4.5），并把 `THEME_LIST` 与 CSS `:root[data-theme]` 块对表；漏主题、令牌自指、对比度掉档一律红 |
| **技能真源一致性（改技能必跑）** | `node scripts/test/check-skills.cjs` | **改 `skills/**` 或发版时必跑**：`manifest.version` 必须等于 `desktop/package.json` 版本；每个技能 `frontmatter.version` 必须等于 manifest 登记值（**防版本号漂移** —— 首跑就抓到 fangcun-bridge 写着 1.2.0 而 manifest 记 1.3.0）；`frontmatter.name` 必须等于 id；`docs/agents/<id>/` 副本与真源**逐字节一致**（防两处分叉）；有 SKILL.md 却没登记的目录必须报出来。顺带打印每个技能 md5（人工对账用） |
| **界面文案（改 UI 文案必跑）** | `node scripts/test/check-ui-copy.cjs` | **Vue 不解析 Markdown** —— `**粗体**` 和反引号会原样印给用户（在途一屏空屏提示、设置页看板归档说明、`mcpConnect.ts` 的 howTo、`chat.ts` 的鉴权提示都犯过）。只看「最终会以纯文本渲染」的位置：App.vue 的 `<template>` 段（剥注释、取**最后一个**行首 `</template>` 才不会被内部 `<template v-if>` 截断）+ howTo/showToast/message/label/hint/placeholder 行；`logs.ts injectLog` / `buildSelfInstallPrompt` / 契约模板 / 派工单是**有意给 AI 读的 Markdown**，天然不在范围。守卫自身带一条「切片长度合理」的断言，防切片失效后永远绿 |
| 构建 | `cd desktop && npm run build` | sync-public-tools + vite + tsc(main/cli) 零错误 |

> ⚠ **开发态改主进程/preload 必须重启 Electron**。`npm run dev` 的 `dev:electron` 已是
> `scripts/dev-electron-watch.cjs`：监听 `dist/**`（排除 renderer）自动重启 ——
> 因为渲染层走 vite 会热更、主进程只在启动时读一次，否则会出现"界面是新的、通道是旧的"
> 这种极具欺骗性的状态（2026-09-22 用户第 1/3 条的真因）。
> `--dry` 参数可用占位子进程验证重启逻辑。
>
> **启动开发态就三条命令**（2026-10-22 受污染后加注）：
> · `npm run dev` —— 正名（`dev:watch` 是同一条的别名，历史执行日志里一直写这个名字，
>   所以它现在真的存在了，不再报 Missing script）；
> · `npm run dev:nogpu` —— **`.cjs` 里 GPU 进程连崩（`-1073741819` = 0xC0000005，
>   日志出现 `FATAL:gpu_data_manager_impl_private.cc`）时用这条**：只多给 Electron
>   一个 `--no-sandbox`，界面照常。受限沙箱/无显卡上下文里必现，不是代码错；
> · `npm run dev:debug` —— 同上 + 自动开 DevTools。
> 参数透传靠 `FC_ELECTRON_ARGS`（空格分隔），脚本只透传、不默认降安全。

> ⚠ `e2e-renderer.cjs` 在无窗口/受限环境会以 `RESULT SKIP` 结束（网络服务被限制，任何非 data: 页面加载都 ERR_FAILED）。
> 那是**环境不可用**，不是通过也不是失败；请在有桌面会话的机器上跑。

> ✅ **2026-09-25 已修复（此前两条红是测试自身/类型缺陷，不是产品坏）**
> - `e2e-calendar.cjs`：根因是 `buildMonth<T, D, L>` 的 **`D`/`L` 只写了默认值、没加 `extends` 约束**
>   → 函数体里 `td.done/log.status/...` 全 TS2339 → `tsc calendar.ts` 编译不过 → 本套自 09-23 起从未跑起来
>   （跨月/时间段算术**一直无回归保护**）。已补 `D extends CalTodoLike` / `L extends CalLogLike`
>   并把 `CalEvent<T,D>`/`CalMonthResult.cells` 等漏掉 L 的泛型补齐。**现 50/0。**
> - `e2e-logs.cjs`：`logs.createLog()` 早已改为返回 `{ok,data,error}`，而测试仍按旧签名取 `a.id`
>   → `undefined` → `getLog(undefined)` 返回 null → 第 52 行 TypeError。**产品侧语义是对的**
>   （非 active 拒改、只改状态不删文件都验证通过）。已把测试对齐新签名。**现 31/0。**
> 上面「回归断言数」里的两个数此前**拿不到**，现已并入绿灯。
> **2026-10-03 22:02 实测（本机口径，`spawnSync`/`execFileSync` 一律 EBUSY）**：
> **本机可跑 15 套全绿合计 900**（agent-targets24 · applog31 · archive-overdue19 · bridge-clone5 · clipboard8 ·
> launchpad17 · logs189 · **mcp-connect67** · ports57 · prefs41 · **renderer-web217** · skill-import48 · skills55 ·
> task-delete93 · todos29）+ `policies` **24/25**（1 条 `spawnSync python EBUSY`）+ `verify.py` **242/0** +
> **五守卫 43**（ipc4 · bindings1 · buttons5 · themes14 · **skills19**）→ **合计 1209**。
> 另 9 套因**本机 spawn 子进程 EBUSY** 跑不起来（**不是回归**）：calendar / datadir / notifications /
> task-fields / logdedupe / fm-contract / grouping / timefmt / mcp-views；`e2e-backup`、`e2e-renderer` 另需环境。
> 本轮新增 4 处可跑断言：`e2e-agent-targets`（24）、`e2e-archive-overdue`（19）、`check-skills`（19）、
> `renderer-web` **167→217**；`mcp-connect` **58→67**（WorkBuddy 目标）。
> —— 09-30 那次「20 套全绿 1041」是按当时同口径记录的，数字对不上是因为**环境**（spawn 可用性）变了，不是产品退化。
> 本机实测（2026-09-30 11:30 重跑）：**20 套全绿、合计 1041 断言**（09-30 11:30：1032 + 四卡修复断言 9 = 1041；09-29 同口径 955），
> 其中 `calendar / timefmt / logdedupe / grouping / policies` 本机也能跑了
> （此前「恒 EBUSY / 需桌面会话」的限制不再复现）。**仍需桌面会话的只剩 `e2e-renderer`（真 Electron）**：
> 2026-09-29 本机首次真跑通 294/12；**2026-09-30 对齐归档分区头过期断言后 298 / 8** —— 余 8 条红**全在改动面之外**
> （完成驳回折叠/悬停轻提示/待办分区头/网格三连/遮罩+AA×2；`.card-date.dim` 3.18 那条已开卡 007），
> 逐条对照见开发日志 09-29「e2e-renderer 首跑」与 09-30 第 34/35 轮。`backup` 仍未跑。
> 新增守卫 `check-themes.cjs`（14 条，逐主题 WCAG 对比度）见下方测试表。

> **2026-10-10 实测（本机口径）**：`verify.py` **262/0** · 六守卫 **53/0**（ipc6 · bindings1 · buttons5 ·
> themes16 · skills19 · **ui-copy6**）· 本机可跑 e2e 全绿：**`e2e-board-cards` 41/0（新，含两处反例自证）** ·
> `e2e-logs` 203/0 · `e2e-todos` 35/0 · `e2e-prefs` 54/0 · `e2e-trip-board` 32/0 · build 零 TS 错。
> ⚠ **`e2e-renderer-web` 的「一次性模式」在某些执行环境里零产出**：Chromium 进程启动后**立即退出**，
> `--dump-dom` / `--screenshot` 无任何输出（exit 0、stderr 也空，**连 `--screenshot=<路径>` 的截图文件都不生成**）。
> 与「实例冲突」无关 —— 换 Chrome 一样、Chrome 进程数为 0 时一样、放开沙箱也一样。
> **但浏览器本体是好的**：`--remote-debugging-port` 起的**常驻**实例渲染正常、`/json/version` 正常响应、
> `Runtime.evaluate` 能取到真实 DOM（实测 DOM 557KB）。
> 所以脚本已加**兜底**：dump-dom 拿不到结果时自动改走「**常驻 + CDP**」再试一次。
> 2026-10-10 实测兜底路径跑出 **332/0**。
> ⚠ 写这类脚本时注意：**常驻模式不要加 `--virtual-time-budget`** —— 它会把页面钉在虚拟时间轴上，
> 断言里的 sleep/waitFor 永远跑不完，表现为「CDP 兜底超时」（一次性模式那边则必须加）。
> 另有两条**完全不依赖浏览器**的兜底，照旧保留：**① 派生逻辑抽 `shared/` 用 node 直接断言**；
> **② 源码守卫**（读 `App.vue` 做正则断言，`e2e-board-cards` 里那 9 条）。

> ✅ 2026-09-29 起，渲染层断言有了**本机可跑**的兜底：`node scripts/test/e2e-renderer-web.cjs`
>    （系统 Edge/Chrome 无头 + 真构建产物 + 同一份假 preload）。它不能替代 `e2e-renderer` 的真点击，
>    但能让"改了渲染层却本机验不了"这件事不再发生。

## 架构速查 (Quick Facts)

> 慢变量事实层。运行期产物（project-status.md 等）会变，不在此维护。

- **包结构**: `tegula.py` 是 19 行 wrapper → `tegula/cli.py`（1991 行，cmd_* 函数按子命令命名）+ `tegula/core.py`（4231 行，数据层 + API）+ `tegula/web.py`（711 行，HTTP/看板/托盘）；另有 `tegula_planning.py` / `tegula_llm.py` 两个顶层模块
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
| cli.py 行数 | ~1991（`tegula.py` 仅 19 行 wrapper） | `wc -l tegula.py tegula/*.py` |
| core.py 行数 | 4231 | 同上 |
| 子命令数 | 56 | `grep -c "add_parser" tegula/cli.py` |
| 状态值数 | 7 | 看 `STATUSES` 常量（`tegula/core.py`） |
| registry 项目数 | 13（projects 12 + released 1） | `grep -c "id:" registry.yaml` |
| 回归断言数 | **2026-10-14 实测**：`verify.py` **276/0** · e2e `renderer-web` **458/0** · `logs` **218/0**；守卫 `check-ui-base` **18/0** · `check-decisions.py` **31/0** · `check-writeback.py` **32/0** · `check-skills` **19/0** · `check-themes` **16/0** · `check-ui-copy` **6/0** · `check-button-styles` **5/0** · `check-ipc-parity` **6/0** · `check-template-bindings` **1/0**；`check-render-roundtrip.py` = 「两侧往返全部一致 ✓」。脚本规模：e2e **36 套** · `check-*.cjs` **7** · `check-*.py` **3**（逐套数字以 `scripts/test/` 实跑为准） | `python verify.py \| tail -1` |
| （历史快照） | verify.py 242 / e2e 27 套 / 五守卫 43（2026-10-03 22:02 实测，勿当现值） | —— |
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
- `verify.py` 1325 行 = 数据层回归（**24 个检查组**；第 23/24 组是 2026-09-28/29 新增的
  「老 YAML 写法」——块式列表 / 裸标量 / 块标量 / 前言嵌套映射，四类都会让写回静默毁数据）
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

## Multi-Agent 接入（MCP 协议）

方寸桌面版暴露 **MCP (Model Context Protocol)** 服务，任何支持 MCP 的 agent 均可接入。

### 连接方式

```
命名管道: \\.\pipe\tegula-mcp
```

**stdio 桥的正确形态（2026-10-18 定稿，别走回头路）**：MCP 客户端 spawn 的是
「方寸自己的可执行文件 + `ELECTRON_RUN_AS_NODE=1` + 包内桥脚本」：

```yaml
command: "…\方寸.exe"            # 开发态 = desktop\node_modules\electron\dist\electron.exe
args:    ["…\resources\app.asar\dist\main\mcp\bridge-standalone.js"]
env:     { ELECTRON_RUN_AS_NODE: "1" }   # ← 不能省
```

- **env 不能省**：少了它方寸以 GUI 模式启动，会拉起 GPU 进程（本机连崩 6 次后
  `FATAL: gpu_process_host isn't usable. Goodbye.` 直接带走进程），客户端只看到"服务瞬间没了"。
- **不要退回 `node dist/cli/tegula-mcp.js`**：安装版里那个 js 在 `app.asar` 内，
  外部 node 执行不了；而且裸 `node` 在 GUI 应用的 PATH 里通常不存在。
- 客户端不支持配置 `env` → 用「入口 C」（本机 node 绝对路径跑同一个桥脚本，能力相同）。
- 方寸设置页「接入其他 Agent」按本机路径生成配置段，两个入口都在。

### 快速自检

```bash
# 读 DSH / Hermes 的真实配置，像客户端一样 spawn + 握手 + 真写一张卡再删
node scripts/check-agent-mcp.cjs            # 全量（含写侧）
node scripts/check-agent-mcp.cjs --readonly # 只读
ls \\.\pipe\\tegula-mcp 2>/dev/null && echo "MCP OK" || echo "MCP MISSING"
```

⚠ `echo '{…}' | 方寸.exe …` 这类一次性管道自检对 exe 类入口不可靠（启动 300ms+ 时 stdin 已 EOF），
用例脚本 `probe-mcp-bridge.cjs` 才是准的。

### MCP 工具清单

| 工具 | 说明 |
|---|---|
| `list_tasks` | 列出任务（按视图/项目/状态筛选） |
| `search_tasks` | 全文搜索 |
| `get_task` | 获取单任务详情 |
| `create_task` | 创建任务 |
| `update_task` | 更新任务字段 |
| `move_status` | 状态流转 |
| `delete_task` | 移入回收站 |
| `list_projects` | 列出项目 |
| `get_project_status` | 项目健康度 |
| `find_blockers` | 查找阻塞链 |
| `scan_services` | 检查服务状态 |
| `get_roadmap` | 路线图进度 |
| `plan_list/plan_get/plan_pending` | 规划管理 |
| `gate_list` | 验收门列表 |
| `list_logs` / `search_logs` / `get_log` | 执行日志：按 ID 定位 / 全文检索 / 单条读取（只读，2026-09-29 加） |

### 各 Agent 接入方式

| Agent | 接入方式 |
|---|---|
| **Claude Code** | MCP 原生支持 + `CLAUDE.md` 项目指令 |
| **Hermes** | MCP 原生 + `fangcun-bridge` skill |
| **Cursor** | MCP 原生 + `.cursorrules` 配置 |
| **OpenCode** | MCP 原生 |
| **Codex** | MCP 原生 |

### Hermes 专属优化

Hermes 用户可额外安装 `fangcun-bridge` skill 获取：
- 自动发现方寸桌面版是否运行
- Hermes 侧语义指南（何时用哪个工具）
- 错误处理最佳实践

安装：将 `docs/agents/fangcun-bridge/SKILL.md` 复制到 `~/.hermes/skills/` 后重载。

