---
name: fangcun-hermes-bridge
description: 方寸（tegula）↔ Hermes 接线卡。要主动查询/修改方寸任务、读项目状态或阻塞链时加载：named pipe MCP 自检、工具边界、写操作规则。
version: 1.1.0
metadata:
  hermes:
    tags: [fangcun, 方寸, mcp, bridge, 接线卡]
    category: integration
---

# 方寸 ↔ Hermes 连接卡

**仓库真源**：`fangcun/skills/fangcun-hermes-bridge/SKILL.md`（本文件是它的副本）。
方寸桌面版**首次启动会自动装卡**到 `~/.hermes/skills/`（`skills/manifest.json` 登记，hash 比对后覆盖）。
Hermes 侧是可焚毁区：发现本卡有误 → 不动 Hermes 侧文件，产出建议给暮雨 → 改仓库真源 + commit → 下次装卡带走（见 `skill-management-policy`）。

---

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

## 工具清单（真源 `desktop/src/main/mcp/tools.ts`，下面是快照）

**读**：`list_tasks` / `search_tasks` / `get_task` / `list_projects` / `get_project_status` /
`find_blockers` / `scan_services` / `get_roadmap` / `get_data_dir` / `plan_list` / `plan_get` / `plan_pending` / `gate_list`

**写**：`create_task` / `update_task` / `move_status` / `delete_task`

> 快照会滞后。以 tools.ts 为准；新增工具后回来补这一行。

**写操作规则**：
- `create_task` / `update_task` 等写操作通过 MCP 调用（桌面版已登录用户身份）
- 乐观锁：`update_task` 使用 `expected_update` 字段防止冲突
- `delete_task` = 移入 `.trash/`（可恢复），不是真删除

## 边界

- 只通过 MCP 读写方寸数据；不直接改 `task-data/*.md`（绕过乐观锁与审计）
- 数据根不确定时先 `get_data_dir` 确认，不要在文件系统里猜目录（数据根可能被用户改到别处）

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
