# 方寸 (tegula) 架构地图

> **用途**：任务开场读一次，替代全仓库盲扫。先核对锚点（任选 2-3 个），不符以代码为准。
>
> **维护**：「结构清单」节由 `python scripts/gen_architecture_map.py` 再生成（快变量）；职责列人工维护（慢变量）；行为规则去 AGENTS.md。≤200 行。

## 锚点（2026-09-08 实测）

| 锚点 | 期望值 |
|---|---|
| 清单文件数（脚本扫描） | 见 GEN 块自检 |
| 子命令数 | 11 |
| registry 项目数 | 12 |
| 看板端口 | 8753 |
| verify.py 检查组 | ≥8 |

## 数据流

```
registry.yaml (项目登记: projects + released 段)
task-data/*.md (任务文件: frontmatter 状态机 + 锁字段)
        │
        ▼
tegula.py (单文件 CLI + http.server)
  ├─ verify.py 调用核心解析函数做数据层回归
  ├─ templates/board.html → 看板视图 (127.0.0.1:8753, Edge 应用窗口)
  ├─ tegula report → project-status.md (覆盖式生成, 运行期产物)
  ├─ tegula backup → backups/ (zip, 保留 10 份)
  └─ task-data/.activity.log (审计)
```

## 结构清单

<!-- GEN:START -->
| 行数 | 文件 | 职责 |
|---:|---|---|
| 74 | `AGENTS.md` | 项目规则与架构速查（三件套之一） |
| 101 | `registry.yaml` | 项目注册表：members + projects + released 三段（改此文件即加项目） |
| 2034 | `tegula.py` | 主程序：零依赖 CLI + http.server 看板（127.0.0.1:8753）+ 派活/回写/报告 |
| 522 | `verify.py` | 数据层回归基线：10 检查组（往返保真/乐观锁/碰撞/备份/日志） |
| 23 | `tegula` | bash wrapper（~700 字节转发）；git 没追踪则属本地工具 |
| 14 | `方寸看板.bat` | 一键看板入口（用户日常双击） |
| 22 | `tegula-serve.bat` | 看板服务启动器（杀旧进程→起服务→开浏览器） |
| 99 | `scripts/gen_architecture_map.py` | 再生成本清单（--check 自检） |
| 12 | `scripts/run_smoke.bat` | 冒烟入口 bat |
| 95 | `scripts/smoke_pythonw.py` | 看板冒烟（pythonw 无窗场景） |
| 953 | `templates/board.html` | 看板前端（零依赖单文件，轮询 + 编辑 API） |
<!-- GEN:END -->

> docs/ 下为 Archify 架构图与 pv-check 验证产物（生成物不入清单扫描范围）。
