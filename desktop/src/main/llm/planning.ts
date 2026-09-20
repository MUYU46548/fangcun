import { chat, ChatOptions } from './chat'
import { loadTasks, parseRegistry, getDataDir } from '../data'
import * as path from 'path'
import * as fs from 'fs'

// ── System prompts ───────────────────────────────────────────────────────

const AUDIT_SYSTEM = `你是方寸项目管理系统 AI 顾问。你正在执行「项目健康度审计」。

你的职责：
1. 根据提供的任务数据，将任务归入四个类别：已交付且有效 / 已交付但表现不佳 / 已取消或延迟 / 计划外新增
2. 识别卡点和资源浪费
3. 给出明确的废弃或整改建议

输出要求：
- 严格按 Markdown 模板输出（### 四分类 / ### 关键指标 / ### 废弃建议 / ### 整改建议）
- 不输出寒暄或客套
- 每条建议必须对应具体任务 ID`

const DECOMPOSE_SYSTEM = `你是方寸项目管理系统 AI 顾问。你正在执行「智能任务拆解」。

你的职责：
1. 将用户输入的目标拆解为层级化任务（P0/P1/P2/P3）
2. 明确依赖关系和前置条件
3. 给出合理的工时预估（人天）
4. 建议执行顺序（拓扑排序后的结果）

输出要求：
- 严格按 Markdown 模板输出（## P0 必须有 / ## P1 应该有 / ## P2 可以有 / ## P3 不会有 / ## 依赖关系 / ## 建议执行顺序 / ## 工时汇总）
- 每项任务带简短标题和一句描述
- 工时估单人天，范围 0.5-5`

const DECIDE_SYSTEM = `你是方寸项目管理系统 AI 顾问。你正在执行「决策支持」。

你的职责：
1. 基于提供的决策点上下文（选项、项目现状、历史决策），给出推荐选项
2. 分析每个选项的利弊
3. 识别关键风险
4. 给出具体的下一步行动

输出要求：
- 严格按 Markdown 模板输出（### 推荐选项 / ### 选项分析 / ### 关键风险 / ### 下一步行动）
- 推荐必须基于数据，不能模糊
- 如果信息不足以判断，明确指出需要补充什么`

const REVIEW_SYSTEM = `你是方寸项目管理系统 AI 顾问。你正在执行「季度复盘」。

你的职责：
1. 回顾上季度的任务交付情况（交付率、卡点、超支原因）
2. 识别计划外工作及其影响
3. 评估技术债务积累
4. 给出下季度建议和优先级

输出要求：
- 严格按 Markdown 模板输出（## 上季度回顾 / ## 功能废弃建议 / ## 技术债务评估 / ## 下季度建议）
- 所有数据引用必须标注来源任务 ID
- 下季度建议必须带优先级标签（P0/P1/P2）`

const ROADMAP_SYSTEM = `你是方寸项目管理系统 AI 顾问。你正在执行「路线图生成」。

你的职责：
1. 基于当前路线图、未完成任务、决策点，生成未来 3 个季度的路线图
2. 明确里程碑、依赖关系和风险
3. 给出资源分配建议

输出要求：
- 严格按 Markdown 模板输出（## Q+1 / ## Q+2 / ## Q+3 / ## 关键风险 / ## 资源分配建议）
- 每季度列出 1-3 个里程碑，每个里程碑带预期产出和依赖
- 风险按发生概率 x 影响程度排序`

// ── Helpers ─────────────────────────────────────────────────────────────

interface TaskSummary {
  id: string
  title?: string
  status?: string
  priority?: string
  project?: string | string[]
  tags?: string[]
  blockers?: string[]
  body?: string
  created?: string
  updated?: string
  batch?: string
}

/** loadTasks() 返回原始 Task（字段全在 t.fm 下且 project 可能是数组）；
 *  规划层必须先扁平化再读字段，否则全是 undefined（2026-09-20 修复）。 */
function loadTaskSummaries(): TaskSummary[] {
  return (loadTasks('active') as any[]).map(t => ({
    ...t.fm,
    id: t.id,
    body: t.body,
  }))
}

/** project 字段兼容单值与数组两种形态（`项目: [xxx]` 是数组） */
function taskInProject(t: TaskSummary, projectId: string): boolean {
  if (Array.isArray(t.project)) return t.project.includes(projectId)
  return t.project === projectId
}

function formatTasksForAudit(tasks: TaskSummary[]): string {
  return tasks.map(t => {
    const parts = [`- [${t.id}] ${t.title || ''}`]
    parts.push(`  状态=${t.status || '未知'} 优先级=${t.priority || '中'} 批次=${t.batch || '无'}`)
    parts.push(`  阻塞=${t.blockers?.join(', ') || '无'}`)
    parts.push(`  最近更新=${t.updated || '未知'}`)
    return parts.join('\n')
  }).join('\n')
}

function getProjectSummary(projectId: string): { project: any; tasks: TaskSummary[]; error?: string } {
  const projects = parseRegistry()
  const project = projects.find(p => p.id === projectId)
  if (!project) return { project: {}, tasks: [], error: `项目 ${projectId} 不存在` }

  const allTasks = loadTaskSummaries()
  const tasks = allTasks.filter(t => taskInProject(t, projectId))
  return { project, tasks }
}

// ── 1. Project Health Audit ─────────────────────────────────────────────

export async function auditProject(projectId: string, model?: string): Promise<string> {
  const { project, tasks, error } = getProjectSummary(projectId)
  if (error) return `错误：${error}`

  const statusCounts: Record<string, number> = {}
  for (const t of tasks) {
    const s = t.status || '未知'
    statusCounts[s] = (statusCounts[s] || 0) + 1
  }

  const now = new Date()
  const q90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  const recentTasks = tasks.filter(t => {
    if (!t.updated) return false
    return new Date(t.updated) > q90
  })

  const userMsg = `项目 ID：${projectId}
项目名称：${project.name || projectId}
项目描述：${project.desc || '无'}
状态统计：${JSON.stringify(statusCounts)}
近 90 天更新任务数：${recentTasks.length}

任务详情：
${formatTasksForAudit(tasks)}`

  return chat(userMsg, { model, system: AUDIT_SYSTEM, temperature: 0.15, maxTokens: 3000 })
}

// ── 2. Smart Task Decomposition ─────────────────────────────────────────

export async function decomposeGoal(goal: string, projectId?: string, model?: string): Promise<string> {
  let context = ''
  if (projectId) {
    const { tasks, error } = getProjectSummary(projectId)
    if (!error && tasks.length > 0) {
      context = `\n\n当前项目任务（避免重复）：\n${formatTasksForAudit(tasks)}`
    }
  }

  const userMsg = `目标：${goal}
项目：${projectId || '未指定'}${context}`

  return chat(userMsg, { model, system: DECOMPOSE_SYSTEM, temperature: 0.25, maxTokens: 3500 })
}

// ── 3. Decision Support ─────────────────────────────────────────────────

export interface DecisionPoint {
  id: string
  question: string
  options: string[]
  status: string
  chosen?: string
  decidedAt?: string
}

export async function decideDP(dp: DecisionPoint, model?: string): Promise<string> {
  const userMsg = `决策点 ID：${dp.id}
问题：${dp.question}
选项：${dp.options.join(' / ')}
当前状态：${dp.status}
已选：${dp.chosen || '无'}
决策时间：${dp.decidedAt || '未决策'}`

  return chat(userMsg, { model, system: DECIDE_SYSTEM, temperature: 0.1, maxTokens: 2500 })
}

// ── 4. Quarterly Review ─────────────────────────────────────────────────

export async function quarterlyReview(projectId?: string, model?: string): Promise<string> {
  const now = new Date()
  const q90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  const projects = parseRegistry()
  const targetProjects = projectId
    ? projects.filter(p => p.id === projectId)
    : projects.filter(p => (p as any).status !== 'released')

  const allTasks = loadTaskSummaries()

  let userMsg = `当前日期：${now.toISOString().slice(0, 10)}
复盘区间：${q90.toISOString().slice(0, 10)} ~ ${now.toISOString().slice(0, 10)}

项目概览：`

  for (const proj of targetProjects) {
    const pid = proj.id
    const projTasks = allTasks.filter(t => taskInProject(t, pid))
    const delivered = projTasks.filter(t => t.status === '完成' && t.updated && new Date(t.updated) > q90)
    const stuck = projTasks.filter(t => ['进行中', '待办'].includes(t.status || ''))
    const unplanned = projTasks.filter(t => !t.batch || t.batch === '临时')

    userMsg += `\n\n### ${pid}`
    userMsg += `\n- 总任务：${projTasks.length}`
    userMsg += `\n- 上季度交付：${delivered.length}`
    userMsg += `\n- 卡住中：${stuck.length}`
    if (stuck.length > 0) {
      userMsg += `\n  ${stuck.slice(0, 3).map(t => `[${t.id}] ${t.title}`).join(', ')}`
    }
    userMsg += `\n- 计划外：${unplanned.length}`
    if (unplanned.length > 0) {
      userMsg += `\n  ${unplanned.slice(0, 3).map(t => `[${t.id}] ${t.title}`).join(', ')}`
    }
  }

  return chat(userMsg, { model, system: REVIEW_SYSTEM, temperature: 0.2, maxTokens: 4000 })
}

// ── 5. Roadmap Generation ───────────────────────────────────────────────

export async function generateRoadmap(goal?: string, projectId?: string, model?: string): Promise<string> {
  const allTasks = loadTaskSummaries()

  let roadmapText = ''
  const projects = projectId
    ? [{ id: projectId, name: projectId }]
    : parseRegistry().map(p => ({ id: p.id, name: p.name || p.id }))

  for (const proj of projects) {
    const projTasks = allTasks.filter(t => taskInProject(t, proj.id))
    if (projTasks.length === 0) continue

    roadmapText += `\n## ${proj.name}\n`
    const byStatus: Record<string, TaskSummary[]> = {}
    for (const t of projTasks) {
      const s = t.status || '未知'
      if (!byStatus[s]) byStatus[s] = []
      byStatus[s].push(t)
    }
    for (const [status, tasks] of Object.entries(byStatus)) {
      roadmapText += `### ${status}\n`
      for (const t of tasks) {
        roadmapText += `- [${t.id}] ${t.title || ''}\n`
      }
    }
  }

  const userMsg = `目标项目：${projectId || '全部项目'}
用户目标：${goal || '无额外目标，基于当前路线图延展'}

当前路线图：
${roadmapText || '（无活跃任务）'}`

  return chat(userMsg, { model, system: ROADMAP_SYSTEM, temperature: 0.25, maxTokens: 4000 })
}
