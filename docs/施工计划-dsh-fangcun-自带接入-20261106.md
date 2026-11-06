# 施工计划 · 让 `dsh-fangcun` 自带"把方寸接入"

> 目标仓库：`E:\CODE\CangKu\dsh-fangcun`（**本计划只在方寸仓存档，不动那个仓库**）
> 起因：2026-11-06 暮雨“DSH 插件应该自带把方寸接入的功能”
> 本计划基于**本机实测**（2026-11-06 22:00 读源码与真配置），不是推测。

---

## 一、现状（三条事实，缺一条都会把方案带歪）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 插件已装、已在加载 | `~/.dsh/profiles/desktop/package.json` 里 `dsh-fangcun: link:E:/CODE/CangKu/dsh-fangcun`，且 `dsh.profile.bundles` 含它 |
| 2 | 插件**已经**自带一条到方寸的通道 | `lib/mcp-pipe.js` 自己连 `\\.\pipe\tegula-mcp`（方寸在跑时通，`health.json` 会报） |
| 3 | 但**模型能用的工具**不来自插件 | DSH 里 `mcp__fangcun__*` 来自 `cordis.patch.yml` **第 38 行**那条手工桥（`- id: mcp-fangcun` + `@deepseek-ai/dsh-mcp-client`），command 指向 **开发版 electron.exe** |

**核心缺口**：事实 2 只让插件自己"能读方寸"，没让**模型**拿到方寸工具。模型那条路仍靠人手工写 8 行 YAML，且指向 dev 路径。

## 二、必须先认清的契约红线

`dsh-fangcun/立项契约.md` 第 125 行明确列为**不做**：

> 6. **自己实现 MCP server 或第二套工具** —— 与方寸 MCP 重复，还要处理鉴权与协议演进。

所以"自带接入"**不等于**"插件自己实现 MCP server"。合法形态只有三种，见下。

## 三、三条技术路线（按推荐度）

### T1（推荐）· 插件 bundle 自带那条 mcp-client 声明

DSH 的标准机制：插件可以带自己的 patch（`package.json` 的 `dsh.bundle.patch`），宿主加载插件时**按 bundle 层叠加**。
现在 `cordis.patch.yml` 只插了插件自己：

```yaml
- insert:
    - id: dsh-fangcun
      name: dsh-fangcun
```

改成同时插 mcp-client（等价于现在手工那条，但**由插件分发**）：

```yaml
- insert:
    - id: dsh-fangcun
      name: dsh-fangcun
    - id: mcp-fangcun
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: fangcun
        transport: stdio
        command: <?>
        args: [<?>]
        env: { ELECTRON_RUN_AS_NODE: '1' }
        failOnStartupError: false
```

**唯一未解的点**是 `command` 的路径（静态 YAML 不能跑 JS 解析）。三选一，按稳定性排序：

| 解法 | 做法 | 代价 |
|---|---|---|
| T1-a | 方寸侧**落一个稳定垫片**：安装/每次启动时写 `%LOCALAPPDATA%\Maintenance\fangcun-mcp.cmd`（内容=`set ELECTRON_RUN_AS_NODE=1` + 当前 exe + 桥脚本），patch 里 command 固定指它 | 需要 DSH 支持 `%LOCALAPPDATA%` 展开，或接受"用户名不同要手改一次" |
| T1-b | patch 里写**安装器默认落点** `%LOCALAPPDATA%\Programs\方寸\方寸.exe` | 本机实测装在 `E:\Software\fangcun-desktop`，会直接连不上 —— 只能当默认值 |
| T1-c | 用 `node` + 方寸桥脚本 | 依赖 PATH 里的 node；本机 GUI 继承的 PATH 没有独立 node（2026-10-18 踩过） |

### T2 · 插件在 `apply()` 里动态注册（如果宿主有 seam）

插件的 `apply(root)` 已经能用 `root.inject(['webServer'])` / `root.get('systemPrompt')`。
**要先探**：宿主有没有 `mcpServers` / `tools` / `configEditor` 一类的服务，能在运行时挂 MCP server 或注册工具。

- 有 `configEditor`（`dsh-tokenrhythm-vision` 就在用）→ 可以在启动时把 `mcp-fangcun` 那条**写进 profile 配置**，路径用插件自己 `detectInstall()` 算出来的真路径。**这是最优解**：一次搞定，且永远指向真实安装位置。
- 有 `tools` / `mcp` 注册 seam → 直接把方寸工具挂进去（不算"实现 MCP server"，只是转发到 pipe）。

### T3 · 什么都不改，只把旧桥的 command 改成正式版（保底）

不做"自带"，只让现状不脆：把第 38 行 command 从 dev 的 `electron.exe` 换成正式版 `方寸.exe`。
**问题**：还是人手工改，插件升级会覆盖、换盘会断 —— 只能当过渡。

## 四、执行步骤（建议 T2 优先，探不通落 T1-a）

### 第 0 步 · 探宿主能力（半天，只读）

在 `dsh-fangcun` 里写一个一次性探针（不入库），列出宿主暴露的服务名：

```
root.get / root.inject 能拿到的 service 清单（看 @deepseek-ai/dsh-* 的 d.ts 或运行时枚举）
重点找：mcpServers / mcp / tools / configEditor / providers
```

**产出**：一张"宿主有没有 configEditor / tools seam"的结论表。这一步决定走 T2 还是 T1。

### 第 1 步 · 实现（按探针结论二选一）

- **走 T2**：在 `apply()` 里加 `inject(['configEditor'])`，把 `mcp-fangcun` 条目写进 profile；
  路径用 `detectInstall()` 的结果，**写不进去就降级为 T1**（并把失败原因写进 `health.json`，不许静默）。
- **走 T1-a**：改插件自带 `cordis.patch.yml` 追加 mcp-client 段；方寸侧配合落垫片
  （方寸仓库改动：`services/` 里加"写垫片"，只在用户点"装到 DSH"时写，且先备份）。

### 第 2 步 · 清掉旧的手工桥

插件那条生效后，删 `cordis.patch.yml` 第 38 行那段（**先备份**：`cordis.patch.yml.bak-<时间戳>`）。
删之前必须确认模型侧工具还在 —— 判定见第 3 步。

### 第 3 步 · 验收（四条，缺一条不算完）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 重启 DSH 后，模型能列出 `mcp__fangcun__*` 工具 | 会话里让它 `list_tasks`，看是否真返回卡 |
| 2 | 工具指向的是**正式版**方寸，不是 dev | `health.json` 或新加的自证字段里报出实际 command 路径，且该路径 == 安装版 exe |
| 3 | 删掉旧手工桥之后，工具仍然在 | 上一条重跑一次（这是"自带"的唯一硬证据） |
| 4 | 方寸没跑时**优雅失败** | 停方寸 → 工具调用报"连不上方寸"而不是让宿主崩（`failOnStartupError: false` 已有） |

### 第 4 步 · 回滚

- 插件侧：`git revert` 那次提交 + `dsh plugin add link:` 重装（插件是热装的，重启即生效）
- 配置侧：从 `cordis.patch.yml.bak-<时间戳>` 还原
- 方寸侧：垫片文件留着无害，删了也只是回到手工

## 五、边界（不许越）

1. **不 import 方寸代码、不 import electron**（该仓契约第 83 行）—— 只走命名管道 / CLI / 文件。
2. **不自己实现 MCP server**（第 125 行）—— 转发到方寸 pipe 不算，另起一套协议算。
3. **不只支持开发态**：路径解析必须能落在安装版（本机 `E:\Software\fangcun-desktop`），
   否则"自带"只在开发者机器上成立。
4. 插件**不改方寸的数据**、方寸**不写 DSH 的配置**（除用户明确点的那一下、且带备份）。

## 六、风险

| 风险 | 触发条件 | 应对 |
|---|---|---|
| 宿主没有 configEditor / tools seam | 第 0 步探不到 | 落 T1-a（垫片），别硬造 seam |
| 垫片路径含用户名 | 多用户机器 | 方寸写垫片时用当前用户路径；DSH 侧不支持 env 展开就明确写在 README 里"换用户要重装插件" |
| 两套工具并存导致重复 | 旧桥没删干净 | 验收第 3 条专门钉这个 |
| DSH 版本升级改了 seam | 宿主发新版 | 插件 `package.json` 的 `dsh.compatibility` 里加版本范围（已有字段） |

## 七、工作量（粗估，不含等待重启）

- 第 0 步探针：半天
- 实现：T2 约 1 天；T1-a 约半天（含方寸侧垫片）
- 验收 + 回滚演练：半天
- 合计：**1.5–2 天**（含 DSH 两次重启）
