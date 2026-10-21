# Electron 引擎迁移评估（28 → 44）

> 2026-10-21 · 只评估不动手（W1-批次 3A）
> 结论先给：**建议升，一口气升到 44**；风险低于预期，因为它几乎不依赖 Electron 新老 API，也没有运行时原生模块。
> 本文所有"事实"都标了取证方式；没验过的我标了"未验"。

---

## 一、现状事实

| 项 | 值 | 取证 |
|---|---|---|
| 装在项目里的 Electron | **28.3.3** | `node_modules/electron/package.json` → 28.3.3 |
| `package.json` 声明 | `"electron": "^28.0.0"` | 同上 |
| Electron 28 官方 EOL | **2024-06-10**（已过期约 2 年 4 个月） | endoflife.date / keelbench 交叉核对 |
| 当前仍受支持的三条线（2026-10-21） | **44**（EOL 2027-03-02）、43（2027-01-05）、42（**2026-10-20 刚过期**） | 同上；Electron 策略「最近三个 stable major」 |
| Electron 28 内含 | Chromium 120 / Node 18 | 官方 release notes（按 28 线） |
| Electron 44 内含 | Chromium 152 / Node 24 | endoflife.date 表格 |
| 打包链 | electron-builder **26.15.3**、electron-updater **6.8.9**、electron-log 5.4.4 | `node_modules/*/package.json` |
| 安装包体积 | 79.4 MB（0.3.9） | `release/Fangcun-Setup.0.3.9.exe` |

**这意味着什么**：两年多没吃过安全补丁。方寸常驻托盘、开着 MCP 桥、能拉远端、能读本机文件 —— 它不是"离网玩具"，
Chromium 侧的漏洞是会真被利用的（尤其"打开外部链接/附件"这条路径）。这不是洁癖问题。

---

## 二、迁移风险面：实测清点（不是通读 breaking changes 猜）

### 2.1 Electron API 用量：13 个，全是长期稳定件

```
app  BrowserWindow  Menu  Tray  Notification  powerMonitor  safeStorage
dialog  shell  clipboard  ipcMain  ipcRenderer  contextBridge
```
（`grep -rh "from 'electron'" src/` 汇总，去重 13 项）

28 → 44 之间被移除/改名的那批（`@electron/remote`、`enableRemoteModule`、
`allowRendererProcessReuse`、`webContents.getPrinters` 等）**一个都没用到**：
`grep @electron/remote|enableRemoteModule|allowRendererProcessReuse` 零命中。

**判定**：API 面几乎无迁移成本。这是本次评估最重要的一条 —— 引擎版本落后不等于代码落后。

### 2.2 原生模块：零运行时依赖

`find node_modules -name "*.node"` 只捞到 rollup 的两个（**构建期**用的，不进包）。
换句话说：没有 `better-sqlite3` / `node-pty` / `sharp` 这类需要 `electron-rebuild` 的东西。
（顺带：这也是 0.3.9 打包时 `npm prefix` 崩、得加 `-c.npmRebuild=false` 绕过的根因 —— 本来就没东西可 rebuild。）

**判定**：不需要重建原生模块，迁移不会卡在编译链上。

### 2.3 窗口与安全配置：已经是现代写法

`src/index.ts` → `webPreferences`：`contextIsolation: true` / `nodeIntegration: false` /
`backgroundThrottling: false`（托盘常驻必需）。
Electron 20 起 `sandbox` 默认 true，preload 只用 `require('electron')`，在沙箱里合法。

**判定**：不需要跟着新版改安全配置（反过来，28 的默认值也不阻碍升级）。

### 2.4 真正的风险：Chromium 120 → 152（8 个大版本）的渲染差异

接口没变，但 CSS/排版引擎变了。方寸的界面全是 **Tailwind + 自定义 CSS（App.vue 里 2954 行）**，
已知历史坑里有 `backdrop-filter`、`getComputedStyle` 与 CSSOM 不一致这类引擎行为差异。

**对策（已有现成工具，不用新建）**：
- `node scripts/test/e2e-renderer-web.cjs --shots=docs/views-web-after` —— 逐页签拍真机截图，与 `docs/views-web` 逐张目检对比
- `node scripts/test/e2e-renderer-web.cjs`（607 条 DOM 几何/样式断言）—— 引擎换了这些断言最容易先响
- `node scripts/test/e2e-renderer.cjs`（312 条真点击）

**判定**：这是唯一需要"看"的部分，而且**验证手段已经在仓库里**，不是空白期。

### 2.5 需要跟进的依赖（都已达标，但升级时要复验）

| 依赖 | 现状 | 与 Electron 44 的关系 |
|---|---|---|
| electron-updater | 6.8.9 | 6.x 线支持新版本；升级后**必须真跑一次"检查更新"**（不能只看编译过） |
| electron-builder | 26.15.3 | 26.x 支持 44；`-c.npmRebuild=false` 仍建议保留 |
| electron-log | 5.4.4 | 与引擎版本无关，纯 Node 侧 |
| js-yaml / marked / dompurify / reka-ui | 见 package.json | 都跑在渲染层或主进程纯 JS 侧，不碰 Electron API |

---

## 三、工时估算（按"半天一档"给，不给虚假的精确到小时）

| 阶段 | 内容 | 估算 |
|---|---|---|
| ① 改版本 + 装依赖 + 构建 | `electron: ^44`、`npm i`、`npm run build`、`electron:build` | **0.5 天**（其中大头是 npm 下载 100MB+，以及踩 `npm prefix` 那个老坑） |
| ② 首启冒烟（手工，必须人点） | 开窗/托盘/关窗不退/通知/剪贴板复制/MCP 桥 4 个回包/启动台拉起浏览器/挂机提醒 | **0.5 天** |
| ③ 自动化回归 | verify 293 + renderer-web 607 + renderer 312 + 六守卫 + `--shots` 截图对比 | **0.5 天** |
| ④ 未知缓冲 | 渲染差异修 CSS、updater 行为变化 | **1 天** |
| **合计** | | **2–2.5 天** |

对比参考：0.3.9 那次"打包 + 资产上传 + 自检"半个晚上就完了，说明这条链本身不长；
这里多出来的主要是②③两段"人眼 + 断言"的成本。

---

## 四、三选一建议

### 结论：**升**（目标 44，不逐版升）

不选 43（2027-01-05 就过期，白干一遍）；不选 45（2026-10-20 刚发布，做首日用户不划算，
而且方寸只有一个用户 —— 你 —— 没有"等等看社区反馈"的收益，真出问题只能自己查）。

**为什么"一口气跳 16 个大版本"反而比逐版升更安全**：
逐版升（28→29→30…）每一步都要重跑一遍全部断言、重拍一遍截图，成本 ×16，
而 `breaking changes` 里被我们碰到的那几条是**一个都没有**（见 2.1）。逐版升的唯一理由是"定位是哪个版本坏的" ——
但我们的断言是**行为级**的，一条挂了会直接指名哪个功能，不需要靠版本二分。

### 不升的代价（如果你选这条）
- 继续吃不到安全补丁；Chromium 120 的已知漏洞在"打开附件 / 点外链"路径上是真实攻击面
- 从 28 升到未来的 46/48，跨度只会更大，`electron-builder` 与 `updater` 的兼容窗口越拖越窄
- 唯一收益是"这几天不折腾" —— 而这几天本来就是 W1 清障窗口

### 缓升的条件（如果你选这条）
只有一条成立就成立：**本季度要用方寸做"给别人用"的事**（分享安装包、公开下载）。
那种情况下先保稳定；否则升。

---

## 五、执行顺序（真要动手时照这个走）

1. **快照**：`git tag pre-engine-44`，并留 0.3.9 安装包（`release/Fangcun-Setup.0.3.9.exe` 已在）
2. 只改 `package.json` 的 `electron` 到 `^44.0.0` → `npm i` → `npm run build`
3. `ELECTRON_OVERRIDE_DIST_PATH=... npx electron-builder -c.npmRebuild=false` 出一版 **0.4.0-dev**
4. 跑 ②③ 两段；截图存 `docs/views-web-after/`，与 `docs/views-web/` 逐张对比
5. 红了就修；修不动就 `git revert` 版本号那一笔 + 重打 0.3.9（回滚成本 = 一次重打包，约 1 分钟）
6. 全绿再发版，发布说明里写清"引擎 28→44、Chromium 120→152"

**红线**：不要在同一次发版里既升引擎又拆 App.vue —— 两个大变动叠在一起，红了分不清是谁的锅。

---

## 六、本次没验的东西（明说，别当已验）

- **Electron 44 是否真能装起来**：只查了 EOL 数据与依赖版本，**没在本机实跑**（评估阶段刻意不动手）
- **`--shots` 在新引擎下的成图**：同样没跑；这是迁移当天的第一件事
- **electron-updater 在 44 下的灰度/差量行为**：需要真发一版才能验
- Windows 侧 `safeStorage`（DPAPI）跨版本行为：Electron 未改这块，但迁移当天要**真存一次 WebDAV 密码再读回**
