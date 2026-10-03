---
name: fangcun-bridge
description: 方寸（tegula）↔ 任意 agent 接线卡（agent 中立）。要查询/修改方寸任务、读项目状态或阻塞链时加载：两个 stdio 入口选型、named pipe 自检、工具边界、写操作规则。
version: 1.2.0
metadata:
  hermes:
    tags: [fangcun, 方寸, mcp, bridge, 接线卡]
    category: integration
---

# 方寸（tegula）agent 接线卡

**仓库真源**：`fangcun/skills/fangcun-bridge/SKILL.md`（本文件是它的副本）。

本卡 **agent 中立**：DSH / Claude Code / Cursor / OpenCode / Codex / Hermes 通用。
各家落点不同（技能目录与配置文件位置由各家自己的文档规定，方寸不猜、不代写）：
方寸桌面版设置页「接入其他 Agent」提供**按本机安装路径生成的配置段 + 一键复制 + 打开目标文件**按钮。
Hermes 侧的自动装卡与覆盖策略是特例（`skills/manifest.json` 登记 + hash 比对），见 `skill-management-policy`。

---

## 何时使用

- 任何 agent 需要主动查询方寸数据（任务列表/状态/日志/阻塞链）
- 派活前后需要确认任务状态
- 需要从本 agent 侧触发方寸操作
- 需要从本 agent 侧了解绒花墨坊运行状态

## 入口（两个，按需选型）

**入口 A · named pipe（桌面版运行时，读写全量工具）**

方寸桌面版通过 named pipe 暴露 MCP 服务：

```
\\.\pipe\tegula-mcp
```

桥接 CLI（stdio → named pipe 通信）：

```bash
node dist/cli/tegula-mcp.js
```

依赖方寸桌面版在运行（pipe 由主进程持有）。

**入口 B · Python stdio（只读，方寸没开也能读）**

```bash
cd <fangcun 仓库/安装目录> && python tegula.py mcp
```

JSON-RPC 2.0 over stdio，**14 个只读工具**，直接读 `task-data/`：
**不依赖桌面版是否运行、不占用任何 TCP 端口**。适合只要读、或方寸未启动的场景。

> 选型：要写操作 / 桌面版 MCP 全量工具 → A；只要读、要离线可用 → B。

## 自检（调用前必做，失败显式报错）

1. **入口 A**：检查 named pipe 是否存在：
   ```bash
   ls \\\\.\\pipe\\tegula-mcp 2>/dev/null && echo "pipe OK" || echo "pipe MISSING"
   ```
   桥接可用性自检：
   ```bash
   cd <desktop 目录> && echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/cli/tegula-mcp.js
   ```
   期望返回含 `result` 的 JSON-RPC 响应。报 `ECONNREFUSED` 或超时 → 桌面版未运行或 pipe 未就绪，**停止调用并报错**，不静默回退。
2. **入口 B**：直接发一条 `tools/list`，期望返回只读工具列表。

## 工具清单（真源 `desktop/src/main/mcp/tools.ts`，下面是快照）

**读**：`list_tasks` / `search_tasks` / `get_task` / `list_projects` / `get_project_status` /
`find_blockers` / `scan_services` / `get_roadmap` / `get_data_dir` / `plan_list` / `plan_get` / `plan_pending` / `gate_list`
`list_logs` / `search_logs` / `get_log` — 执行日志读取（拿日志 ID 直接 `get_log` 取，不必整篇注入）

**写**（仅入口 A）：`create_task` / `update_task` / `move_status` / `delete_task`

> 快照会滞后。以 tools.ts 为准；新增工具后回来补这一行。
> 入口 B（`python tegula.py mcp`）只含上面的**读**工具。

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

1. **调用前先自检**：入口 A 的 pipe 不存在 / CLI 无响应 → 停止，告诉用户「方寸桌面版未运行，请重启」（入口 B 不依赖桌面版，不受此限）
2. **不静默回退**：连接失败 ≠ 数据为空。报错比假装没有更安全
3. **工具清单现场读**：`desktop/src/main/mcp/tools.ts` 是唯一真源，skill 不维护工具列表快照
