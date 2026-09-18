# 会话堆积治理：方寸「执行日志」功能规格

> 问题根因：Hermes 会话无限增长（当前 1,879 个，636MB，日增 ~40 个）。
> 治本：把每次执行的内容沉淀到方寸「执行日志」，旧会话价值归零，随时可删。

---

## 一、三层定位

| 层级 | 模块 | 颗粒度 | 更新频率 | 生命周期 |
|---|---|---|---|---|
| **宏观** | `tegula task` | 中长期任务 | 周/月 | 持续跟踪 |
| **微观** | `tegula log` | 具体执行单元 | **一天多条** | active → completed → archived → 手动销毁 |
| **汇总** | `tegula phase`（暂缓） | 里程碑总结 | 阶段结束 | 长期保留 |

---

## 二、存储

```
E:/CODE/CangKu/fangcun/docs/执行日志/
├── log_20260918_1234_a1b2c3.md
└── ...
```

---

## 三、文件结构

```markdown
---
type: execution-log
id: log_20260918_1234_a1b2c3
project: fangcun-base
title: 方寸0918-1234
status: active | completed | archived
created: 2026-09-18T12:34:00+08:00
completed: null | <ISO timestamp>
retain_days: null | 7 | 14 | 0
retain_until: null | <ISO timestamp>
model: null | <模型名>
provider: null | <provider>
tags: []
tasks: []
---

# 方寸0918-1234

## 上下文
- **工作目录**：`E:/CODE/CangKu/fangcun/desktop`
- **关联任务**：（阶段总结创建后手动关联）

## 执行内容
- 完成了 IPC 层 todos:list 对接
- 修复了归档搜索 bug

## 产出物
- `desktop/src/main/ipc.ts` 修改

## 下一步
- 继续 P1 批次开发

## 完成确认
- 完成备注：（可选）
```

---

## 四、状态机

```
active ──(手动确认完成)──> completed ──(超过保留天数)──> archived
  │                            │                            │
  │ 可编辑                      │ 暂存区保留                 │ 待销毁
  │                            │                            │
  └────────────────────────────┴────(手动销毁)────────────────┘
```

**关键**：`archived` ≠ 删除。只是标记为「可销毁」，文件仍在磁盘上，直到用户手动 `tegula log destroy`。

---

## 五、CLI 命令

```bash
tegula log create --project <slug> --title <标题> [--content <正文>] [--task <task-id>]
tegula log get <id>
tegula log list [--project <slug>] [--status active|completed|archived] [--limit N]
tegula log edit <id> [--title <标题>] [--content <正文>] [--next-steps <下一步>]
tegula log complete <id> [--retain-days 7|14|0|never] [--note <备注>]
tegula log archive <id> [--note <备注>]
tegula log destroy <id>
tegula log search <query>
tegula log link <id> <task-id>
tegula log unlink <id> <task-id>
tegula log inject <id>
tegula log cleanup
```

---

## 六、与任务卡片的关系

| 维度 | 任务卡片（task） | 执行日志（log） |
|---|---|---|
| 颗粒度 | 宏观、中长期 | 微观、短期 |
| 更新频率 | 周/月 | 一天多条 |
| 状态 | 草稿→待办→进行中→待验收→完成 | active→completed→archived |
| 暂存区 | 无 | 有（retain_days 可配置） |
| 接力机制 | 无 | inject 命令 |
| 关联 | 一个任务可有多条日志 | 一条日志可关联多个任务 |

---

## 七、接力机制（核心）

`tegula log inject <id>` 生成一段文本，用于新会话提示词注入：

```markdown
## 上次执行日志（来源：方寸执行日志 log_20260918_1234_a1b2c3）

**项目**：方寸桌面版
**时间**：2026-09-18 12:34
**状态**：已完成

### 做了什么
- 完成了 IPC 层 todos:list 对接
- 修复了归档搜索 bug

### 下一步
- 继续 P1 批次开发

### 关联任务
- task_xxxx（方寸桌面版 P1）
```

---

## 八、纪律

- **做完一条执行 → 手动 `tegula log create` 记录**
- **做完确认 → `tegula log complete`，设保留天数**
- **新会话启动 → `tegula log inject` 拉最近一条 completed 日志粘贴进去**
- **archived 日志 → 手动 `tegula log destroy` 销毁，不自动删**

---

## 九、实施路径

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 CLI | `api_log_*` + `cmd_log` + 12 个子命令 | ✅ 已完成 |
| P0 回归 | verify.py 217/217 全绿 | ✅ 已完成 |
| P0 文档 | 本文档 | ✅ 已完成 |
| P1 桌面版 | `services/logs.ts` + IPC + preload + App.vue 日志视图 | 🔴 待开发 |
| P1 MCP | `mcp_log_list` / `mcp_log_search` / `mcp_log_inject` | 🔴 待开发 |
| P2 Hermes skill | 新会话启动自动 inject 最近日志 | 🔴 待开发 |
| P2 `tegula phase` | 里程碑总结（暂缓） | ⏸️ 暂缓 |

---

*文档版本：2.0 | 更新：2026-09-18 | 状态：P0 CLI 已完成，桌面版待开发*
