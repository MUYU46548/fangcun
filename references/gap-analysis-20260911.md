# 竞品分析驱动改进（2026-09-11 / 2026-09-12 更新）

## 背景

2026-09-11 对标 Linear / Notion / Trello / Kanboard / Flux / Kandown 等同类产品，完成差距分析。报告：`docs/gap-analysis-report.md`。

2026-09-12 扩展对标范围，增加 AI Agent 基础设施生态产品。

## 核心发现

方寸的「零依赖 + AI Agent 原生 + 项目状态感知」定位全球独一无二。最大改进机会在子任务交互、标签系统、快速添加。

## 用户决策

| 问题 | 决策 |
|:---|:---:|
| 视图优先级 | 都要（看板 + 日历 + 列表 + 时间线） |
| 子任务交互 | 前端可勾选，自动保存，显示进度 |
| 标签 vs 项目 | 增加独立标签维度（多选） |
| 自动化规则 | 需要（方案全完成 → 自动推进） |
| MCP 集成 | 暴露只读接口 |

## 三阶段实施计划

| 阶段 | 提示词 | 工作量 | 内容 |
|:---|:---|:---|:---|
| Phase 1 | `docs/phase1-prompt.md` | 1-2 天 | 子任务勾选、标签系统、资料可点击、键盘快捷键 |
| Phase 2 | `docs/phase2-prompt.md` | 2-3 天 | 快速添加语法、日历视图、命令面板 |
| Phase 3 | `docs/phase3-prompt.md` | 3-5 天 | 自动化规则、MCP 只读接口、列表视图 |

## 实施原则

- 每阶段提示词自包含（背景 + 要求 + 验收标准 + 红线），可直接外派给其他 agent
- 外部 agent 免费额度跑，主 agent 做 review
- 改完必跑 `python verify.py` 全绿

---

## 第二轮对标：AI Agent 基础设施生态（2026-09-12）

### 竞品全景

| 类别 | 代表产品 | Stars | 核心能力 | 方寸状态 |
|---|---|---|---|---|
| **AI 工作台** | KunAgent/Kun | 6.3k | 桌面 GUI + TUI + Agent 执行 + 审批流 | ❌ 仅 CLI + 看板 |
| | Routa | 新增 | 看板驱动的多 Agent 协调（Backlog→Done + Gate Specialist） | ❌ |
| | Specrails Desktop | 2 | 规格→实现→审查→交付四阶段流水线 | ❌ |
| **多 Agent 编排** | Loop (radutopala) | 7 | Docker 容器中运行 Claude + Slack/Discord | ❌ |
| | Athena Loops | 54 | Python orchestrator→worker→reviewer 模式 | ❌ |
| | Agent Manager | 7 | 按复杂度选模型、控制成本的编排层 | ❌ |
| **阶段门控** | dsh-stage-gate | — | 验收清单 → PASS/BLOCK 硬闸门 | ❌ |
| **预算熔断** | AgentBudget | 108 | 硬美元上限 + 自动熔断 | ❌ |
| | Agentic SpendGuard | 3 | 运行时安全层，KMS 签名审计链 | ❌ |
| | Syrin | 62 | 预算控制一等公民 + 声明式阈值 | ❌ |
| | Token Budget Orchestrator | — | 多 Agent 独立预算 + 超限阻断 | ❌ |
| **用量监控** | OpenGauge | — | 本地 LLM 成本追踪 + 熔断器 | ❌ |
| | LLMIO | — | Go 统一网关 + 费用追踪 | ❌ |
| | ai-dashboard | 0 | 多模型聚合网关 + 用量统计 | ❌ |
| | token-dashboard | 2 | 统一分析仪表板（Claude Code/Cline/Codex/Copilot） | ❌ |
| **操作层** | AgentOps | 410 | 编码 Agent 操作层（Plan→Implement→Validate） | ❌ |
| **公司式编排** | Paperclip | — | 零人工公司编排层（目标/预算/审批/分工） | ❌ |

### 方寸不可替代 vs 必须补

**竞品没有、方寸独有的**：
1. Git 感知健康度 — 自动扫描 git 活动判定 active/stuck/dormant（竞品全靠 agent 报告）
2. 阻塞链自动管理 — 前置完成→自动解锁下游（文件状态机驱动）
3. 跨项目路线图 — 12 个项目实时聚合批次进度+里程碑+并行建议
4. Hermes 原生集成 — `hermes chat --in <repo>` + hermes-sync 注册
5. 零依赖单文件 — Python stdlib 约 3500 行，无数据库/前端框架

**竞品有、方寸缺失的**：

| 缺失 | 严重度 | 应对 |
|---|---|---|
| Agent 执行 | 🔴 致命 | 派发抽象层（hermes/claude/codex/kun） |
| 预算感知 | 🔴 致命 | done --成本 记录实际消耗 |
| 阶段门控 | 🟡 重要 | gate_open/check/close + 验收清单拦截 |
| 多后端派发 | 🟡 重要 | dispatch --agent 参数 |
| 桌面 GUI | 🟡 重要 | 暂缓（看板视图已够用） |
| Agent 可观测性 | 🟢 加分 | 暂缓 |

### 本次实现（2026-09-12）

基于竞品分析，落地三项关键改进：

1. **派发抽象层** — `_agent_cmd()` 支持 hermes/claude/codex/kun 多后端，`dispatch --agent` 参数覆盖
2. **阶段门控** — `gate_open/check/close/list` 4 个 MCP 工具 + `api_review` 验收清单拦截
3. **预算追踪** — `done --成本` 记录实际消耗，`预算.actual_cost` 字段累计

## 参考文档

- `docs/gap-analysis-report.md` — 完整差距分析报告
- `docs/phase1-prompt.md` — Phase 1 提示词
- `docs/phase2-prompt.md` — Phase 2 提示词
- `docs/phase3-prompt.md` — Phase 3 提示词
