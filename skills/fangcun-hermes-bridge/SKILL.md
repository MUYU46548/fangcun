# 方寸 ↔ Hermes 连接卡（参考稿）

**本文件是 Hermes 专属优化指南的参考稿。**

**安装方式**：复制到 `~/.hermes/skills/fangcun-hermes-bridge/` 后重启 Hermes。
**注意**：本文件不随方寸安装包自动部署，需要用户手动安装。

---

# 方寸 ↔ Hermes 连接卡

## 何时使用

- Hermes 需要主动查询方寸数据（任务列表/状态/日志/阻塞链）
- Agent 派活前后需要确认任务状态
- 需要从 Hermes 侧触发方寸操作
- 需要从 Hermes 侧了解绒花墨坊运行状态

## 入口

方寸桌面版通过 **named pipe** 暴露 MCP 服务：

```
\\.\pipe\tegula-mcp
```

桥接 CLI（将 stdio 转为 named pipe 通信）：

```bash
node dist/cli/tegula-mcp.js
```

或直接通过 Electron 主进程的 MCP server（桌面版运行时已自动启动）。

## 自检（调用前必做，失败显式报错）

1. **检查桌面版是否运行**：任务栏托盘图标存在 或 进程列表有 `electron.exe` 且命令行含 `fangcun-desktop`
2. **检查 named pipe 是否存在**：
   ```bash
   ls \\.\pipe\tegula-mcp 2>/dev/null && echo "pipe OK" || echo "pipe MISSING"
   ```
3. **检查 CLI 桥接可用**：
   ```bash
   cd E:/CODE/CangKu/fangcun/desktop && echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/cli/tegula-mcp.js
   ```
   期望返回含 `result` 的 JSON-RPC 响应。如果报 `ECONNREFUSED` 或超时 → 桌面版未运行或 pipe 未就绪，**停止调用并报错**，不静默回退。

## 边界

**允许**（通过 MCP 调用）：
- `list_tasks` / `search_tasks` / `get_task` — 读任务
- `create_task` / `update_task` / `move_status` / `delete_task` — 写任务
- `list_projects` / `get_project_status` — 读项目状态
- `find_blockers` / `scan_services` / `get_roadmap` — 读项目数据
- `plan_list` / `plan_get` / `plan_pending` — 读规划
- `gate_list` — 读验收门

**写操作规则**：
- `create_task` / `update_task` 等写操作通过 MCP 调用（桌面版已登录用户身份）
- 乐观锁：`update_task` 使用 `expected_update` 字段防止冲突
- `delete_task` = 移入 `.trash/`（可恢复），不是真删除

## 绒花墨坊（NovelForge）

绒花墨坊**无 MCP 层**。操作接入走 **`ronghuamofang` 技能卡**
（`skills/worldbuilding/ronghuamofang/`）—— 本节只留接线口径，细节以那张卡为准。

```bash
# 只读自检
cd E:/CODE/CangKu/NovelForge && .venv/Scripts/python.exe scripts/nfctl.py check
# 全景
.venv/Scripts/python.exe scripts/nfctl.py status
```

## 纪律

1. **调用前先自检**：pipe 不存在 / CLI 无响应 → 停止，告诉用户「方寸桌面版未运行，请重启」
2. **不静默回退**：连接失败 ≠ 数据为空。报错比假装没有更安全
3. **工具清单现场读**：`desktop/src/main/mcp/tools.ts` 是唯一真源，skill 不维护工具列表快照
