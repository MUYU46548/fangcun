# 派工单：给「方寸-DSH插件」写分层 spec

- 卡类型：数据整理（产出一份 JSON 文件，不改任何代码）
- 项目：方寸-DSH插件（`dsh-fangcun`）
- 仓库根：`E://CODE//CangKu//dsh-fangcun`
- 产物落点：`task-data/layer-specs/dsh-fangcun.json`（**方寸数据目录**，不是项目仓库）

## 1 任务目标

把「方寸-DSH插件」**自己声称的分层**写成一份 spec JSON，供方寸回答一个问题：

> 这个项目号称是 A，但 88% 的行数在 B。

⚠ 这句话**只能靠你判断**，因为「哪几层是一伙的」是项目的自我认知，不是目录结构。
方寸已经把**事实**算好了（下面第 3 节），你只需要做**归类与命名**。

## 2 工作目录 / 范围

- 只读项目仓库（**一个字都不许写进去**）：`E://CODE//CangKu//dsh-fangcun`
- 唯一允许写入的地方：方寸数据根的 `task-data/layer-specs/dsh-fangcun.json`
- **不许改代码、不许改文档、不许 git 操作**

## 3 已经算好的事实（别自己重新数）

方寸扫盘结果：**产品 2,826 行**（全仓合计 4,946 行，含测试与脚本）。

> 口径：只数能解码成文本的文件（二进制不算）；排除依赖 / 构建产物 / 打包目录 /
> 内嵌运行时 / 隐藏目录。`.ts` 可能是 MPEG 视频分片，GBK 脚本是文本不是二进制 ——
> 这两条方寸已经处理过，**你不用再踩**。

| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |
|---|---|---:|---:|
| `lib` | 产品 | 9 | 2,826 |
| `test` | 测试 | 8 | 2,120 |

### 被规则挡在分母外面的（方寸已排除，列出来让你知道）

- `.git` —— 版本库
- `.github` —— 隐藏目录（VCS / 浏览器 profile / 缓存）

## 4 项目自己怎么说自己（骨架原文）

### `AGENTS.md`（15785 字，下面只带前 6000 字）

```markdown
# AGENTS.md —— 在这个仓库开工前先读这一页

> 面向：接手本仓库的 agent（也包括未来的我）。
> 这里只放**已核实的事实**和**不容越界的规则**；写给用户看的东西在 `README.md`，
> 方向与需求在 `立项契约.md`。三者分工不要混。
>
> 本文件取代了旧的 `HANDOFF.md` 与 `PLAN.md`：那两份是施工期的临时单，
> 一份名字对公开仓库不合适，一份每次做完就过期（它曾经同时含两条错前提）。
> 内容已并入本文件，历史仍可用 `git log` 取回。

## 0. 一句话

把方寸（tegula）接进 DSH：**每轮把本会话 token 用量报回方寸账本**，**让 agent 开工先查、收工回写方寸**，
**在 DSH 里看得到方寸待办**。零依赖、只读、只走方寸的命名管道 MCP —— 不 import 方寸代码、不 import electron。

## 1. 硬边界（越界即错，测试里钉着）

- **不 import 方寸代码、不 import electron** —— 只走 MCP / CLI / 数据文件（`test/plugin.test.mjs` ③）；
- **只读方寸数据**：写方寸必须走 MCP 工具，不直接改 `task-data/`；
- **不改 DSH 自己的配置**：只声明自己的路由；
- **绝不推 `script-src` 行**：加载失败会 reject 掉 `__DSH_BOOT_READY__`，整个应用起不来；
- **`webserver/index-inject` 必须在 `apply()` 最前面注册**：宿主启动时只收集一次；
- **零依赖**：只用 Node 内置模块；
- **不报金额**：只报 token（DSH 没有供应商报价，自己算是估算）；
- **插件自己不发任何网络请求**；路由只读、非本机 403。

## 2. 已核实的宿主事实（每条都有出处，别再自己猜一遍）

猜错的代价是"装了但插件不出现"、"账目静默漏报"这类要看宿主日志才查得动的故障。

| # | 事实 | 证据 |
|---|---|---|
| 1 | 插件导出 `export default { name, apply(root) }` | 已装插件的真实源码 |
| 2 | 局部等待服务：`root.inject(['webServer'], (ctx) => …)` | 同上 |
| 3 | 注册路由：`ctx.webServer.register({ kind: 'exact', path, handler })` | `dsh-keep-awake`、`dsh-whale-widget` 两处 20 余条路由 |
| 4 | **路由没有 `method` 字段**，方法在 handler 里判 | 同上 |
| 5 | 往页面推行：`root.on('webserver/index-inject', (table) => table.push(row))` | same |
| 6 | 行形状：`{ kind: 'script', placement: 'body', text }`（**内联**） | 同上 |
| 7 | ⚠ **那张表是宿主启动时收集一次的**：订阅晚于收集，行永远进不去 | whale 注释（#152/#153 的根因） |
| 8 | ⚠ **`script-src` 行加载失败会让整个应用起不来** | whale 注释 |
| 9 | 用量钩子：`ctx.on('session/event', …)` | — |
| 10 | ⚠ **签名是 `(session, event)`：第一个参数是 Session 对象，不是 id 字符串**。id 在 `session.id`（= `session.header.id`） | ①`file-upload` 服务原文 `(session, event) => this.observeSessionEvent(session, event)`；`acp` 用 `session.header.id`；`productAnalytics` 用 `session.id`。②反证：0.2.0 早先把它当字符串，真机 `sent.jsonl` 里 key 全是 `[object Object]#<turn>` |
| 10b | `event.data.usage` = `{ inputTokens, cacheReadTokens, outputTokens }`；`event.data.turn` 是轮次；`event.data.message.source.model` 是模型；`turn/end` 是结算点 | whale + 宿主事件表 |
| 10c | 还有 `compaction/start`（`turn === null` 表示手动触发）、`compaction/end` | 宿主 `SessionEventMap` |
| 10d | 想收**所有** agent 的会话（含子代理）要传 `{ global: true }`：`EventOptions.global` 原文 "Receive the event regardless of context filter checks" —— 只放宽过滤，**不会重复投递** | `Context.on` 类型声明 + `history follow` 用法 |
| 10e | **`turn` 不会回绕**：`const turn = phase.turn + 1`，`phase.turn` 由持久投影恢复（`stateOf(session,'turnBoundary')?.lastTurn ?? 0`）。压缩与重启都不动它；只有投影彻底缺失才从 0 开始，而那基本等于新会话 | `AgentLoop` 构造函数 + `turnBoundary` 投影 |
| 10f | **宿主里没有 `subagent/start\|end` 事件**。判子代理看 `SessionHeader`：`origin:'subagent'` / `parentSession` / `delegationDepth` | `SessionHeader` 类型声明原文 |
| 10g | ⚠ **未解**：`compaction/summary` 自带 `usage`，压缩那次调用的 token 现在**没进账**。但它是否同时也体现为一条 `assistant/message` 还没证实（生产端用 spread 拼对象，静态追不到）。**先真机跑出一次压缩、对比两边，再决定接不接** —— 接错就是多报账，比少报更糟 | `compaction/summary` 类型声明 |
| 11 | 可选服务用 `ctx.get('x')` 读，**绝不能写进 inject**（老宿主没那服务 → 插件永不 apply） | whale 注释 |
| 12 | `dsh plugin` 只是 pnpm 的转发壳；装/更新都靠版本号 | `dsh plugin --help` 原话 |
| 13 | 更新器按 `package.json.repository` 找上游 Release / Tag | `dsh-plugin-updates` README |
| 14 | **右下角是 `dsh-whale-widget` 的**：根节点 `.dshwv-root` 钉在 `right:0;bottom:0`（z-index 9999，`pointer-events:none`），宽高 122px 起 —— 挂件别往那儿放 | 已装插件 `assets/whale-widget.js` 的 CSS 原文；真机截图里挂件正压在鲸鱼脸上 |
| 15 | 提示词注册：`ctx.systemPrompt.section({ name, order, text })` 与 `.context({ name, order, text })`；`text` 可以是**同步函数**（装配时调用，**不能 await**）；服务用 `ctx.get('systemPrompt')` 读 | 本机 `cordis_inspect_query` 的 `Service.listService` 原文：`PromptSection` / `PromptContext` 声明 |
| 16 | `tool/call` 事件数据 = `{ turn, step, callId, name, arguments }`；方寸工具在会话里叫 `mcp__fangcun__<tool>` | `session/event` 的 `SessionEventMap` 声明 + 本会话工具表 |
| 17 | **桌面端 Electron 的请求不带 `sec-fetch-*`，也不带 `referer`**（挂件脚本那次实测 `servedByPage` 恒为 0）。判"页面真的来取"要靠自己加的标记，别靠头 | 2026-11-03 真机：页面有挂件、health 却是 0 |
| 18 | **桌面端页面不是 http，是 `dsh-app://app/`**：主窗口加载它，页面侧靠 IPC `dshDesktopBoot` 拿注入表并**自己执行**；`/fangcun/*` 这类不是 dist 文件的路径由主进程 `forwardWebRequest` 带上 host cookie 转发到 Host —— 所以挂件在桌面端照样拉得到脚本和接口 | `app.asar` 的 `/lib/main.js`：`protocol.handle(SCHEME, …)` + `forwardWebRequest()`；`dsh-web-frontend` 的 `UZ()` |
| 19 | **`collectIndexInjections()` 每次调用都新发一张表**（"Fresh per call"）。`widget.injected/pushed` 是**收集次数**（桌面 boot 一次 + 每次 index 渲染一次），**不是插件 apply 次数**，别当重复安装的证据 | `webServer` 服务原文：`collectIndexInjections()` 描述 + 2026-11-04 实测 2/2 而 `package.json` 只有一处安装 |
| 20 | 桌面端 `kind:'script'` 行 = 页面侧建内联 `<script>` **append 到 `body`**（`placement` 决定 head/body）。`script-src` 走 `await` 加载、失败会 reject 启动 —— 别用 | 同上 `UZ()` 实现 |
| 21 | ⚠ **桌面窗口顶上 40px 是原生窗口按钮区**：Windows 上用 `titleBarStyle:'hidden'` + `titleBarOverlay{height:40}`，页面铺满整窗、**被原生层盖住**。DOM 里放在 `top:14px` 的东西 `elementFromPoint` 仍命中它自己，但人眼看不见（2026-11-04 真机：挂件"消失"的真因）。让开用 `env(titlebar-area-height)`（Chromium 在开了 overlay 的窗口里提供） | `app.asar /lib/main.js` 的 `new BrowserWindow({ titleBarStyle: 'hidden', titleBarOverlay: { height: 40 } })`（0.2.2-rc.1）+ 真机 probe |

## 3. 四条链路（改之前先看懂数据怎么走）

**用量上报**：`session/event` → `UsageLedger.onSessionEvent`（按 `(sessionId, turn)` 聚合
`assistant/message`）→ `turn/end` 结算 → 本地 `outbox.jsonl` → 管道 MCP `usage_report` →
已发键落 `sent.jsonl`。方寸没开就攒在 outbox，60 秒重试。会话销毁时补结算半轮。
结算时 `note` 会带**这一轮在办那张卡的卡号**（`card=<id>`，来自 `lib/cards.js`）——
方寸账本可按卡归因 token。卡号放不进 120 字上限就整段不带，**绝不写半截 id**。

**待办挂件**：`apply()` 最前面订阅 `webserver/index-inject` → 推一行内联 script →
浏览器加载 `/fangcun/widget.js` → 拉 `/fangcun/api/tasks` → 经同一根管道 `list_tasks`（10 秒缓存）。
**位置**是客户端自己的事，两种模式：
① **四角锚定**（默认右上，不占右下 —— 那一角是 `dsh-whale-widget` 的，事实 14），存
`fc-todo-widget:corner`，用 CSS 的 left/right/bottom 贴角；
② **自由摆放**，存 `fc-todo-widget:pos` = `"x,y"`（**角标左上角**的视口 px，不是根节点的），
用 inline `left/top`，夹在视口内（顶部下限 `env(titlebar-area-height)`），窗口缩放时重新夹。
**拖动**默认上锁（`fc-todo-widget:locked`，只有存过 `'0'` 才是解锁）：解锁后按住圆点拖，
**松手就停在原地**（不吸角、不弹回 —— 2026-11-05 真机反馈：鲸鱼挂件能随便拖，这个一松手就弹角）；
位移 <6px 当点击。自由模式下面板改成 `position:absolute` 挂在角标上/下（`placePanel`），
开合面板不会再把角标顶走；坐标量的是**角标**（`
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

1. 把 JSON 写进 `task-data/layer-specs/dsh-fangcun.json`
2. 回报一段话，说清四件事：
   - 分了哪几层，每层一句话
   - 依据是哪个文档的哪一节（**必须能指回原文**）
   - 哪些路径你验过存在（实测）、哪些是推测
   - 有没有「两套读法」这种需要 `groups` 的情况；没有就明说没有
3. **不要打包、不要提交 git、不要改任何项目文件**
