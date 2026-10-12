/**
 * Fangcun Desktop — AI 规划写回层（TS 侧）
 * 2026-10-12 ｜ 方案卡：AI 规划功能（与 Python 侧 tegula_writeback.py 同语义、双栈各表）
 *
 * 为什么有这个文件：
 *   planning.ts 的五个功能（audit/decompose/decideDP/quarterly/roadmap）只返回字符串——
 *   渲染层从未接线（10-12 实证：App.vue 零调用），即使接上也是「看完就没」。
 *   本文件把 LLM 输出结构化落成任务卡，让「AI 起草 → 用户点头」成为可回溯的链。
 *
 * 设计红线（与 Python 版一致）：
 *   1. 不侵入 planning.ts——仅复用其上下文组装 helper（getProjectSummary 等）。
 *   2. AI 卡一律「待审批」，绝不直接进「待办」——转正唯一路径是用户点头。
 *   3. source=ai-planning + 标签 ai-draft，审计一条过滤全捞出。
 *   4. 项目说明草稿落「待审批」卡（方寸侧草稿；契约真源在各 repo，方寸只读 REV-002）。
 *   5. 解析失败不丢内容：原文兜底落一张草稿卡，错误信息里带卡 id。
 */

import { chatDetailed, ChatUsage, emptyUsage, usageLabel } from './chat'
import { getProjectSummary, formatTasksForAudit } from './planning'
import { createTask, updateTask } from '../data/tasks'
import type { Task } from '../data/tasks'

// ── System prompts ─────────────────────────────────────────────────────

const PLAN_SYSTEM = `你是方寸项目管理系统 AI 顾问。你正在执行「智能任务拆解」。

输出要求（务必严格遵守）：
- 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏
- 格式：{"tasks": [{"标题": "…", "优先级": "高|中|低", "标签": ["…"], "方案": ["…", "…"], "验收标准": "…"}]}

拆解规则：
- 每张卡独立可验收：标题 15 字内动宾短语；方案 2-6 条具体步骤；验收标准必填（怎么确认修好了，具体到可观察结果）
- 用户消息里会给现有任务列表——重复的不要生成
- 数量 3-8 张，宁少勿滥；优先级默认"中"`

const BRIEF_SYSTEM = `你是方寸项目管理系统 AI 档案员。你正在执行「项目说明起草」。

输出要求（务必严格遵守）：
- 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏
- 格式：{"现状": "…", "目标": "…", "不做": "…", "欠着什么": "…"}

各栏要求：
- 每栏 2-4 句白话，只依据给到的任务数据，不编造
- "不做"写明确边界（明确排除的范围）
- "欠着什么"写已知的未决事项（挂在哪些任务上）`

// ── JSON 提取（LLM 输出容错：剥围栏 / 找首尾大括号）────────────────────

export function extractJson(text: string): object {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('LLM 输出里找不到 JSON 对象')
  return JSON.parse(t.slice(start, end + 1))
}

// ── 内部工具 ────────────────────────────────────────────────────────────

interface DraftCard { title: string; priority?: string; tags?: string[]; steps?: string[]; review?: string }

function normalizeCards(raw: unknown): DraftCard[] {
  const tasks = (raw as { tasks?: unknown[] })?.tasks
  if (!Array.isArray(tasks)) throw new Error('JSON 里缺 tasks 数组')
  const cards: DraftCard[] = []
  for (const item of tasks) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as Record<string, unknown>
    const title = typeof t['标题'] === 'string' ? (t['标题'] as string).trim() : ''
    if (!title) continue
    const steps = Array.isArray(t['方案'])
      ? (t['方案'] as unknown[]).map(s => String(s)).filter(Boolean)
      : []
    const tags = Array.isArray(t['标签'])
      ? (t['标签'] as unknown[]).map(s => String(s).replace(/^#/, '').trim()).filter(Boolean)
      : []
    const priorityRaw = typeof t['优先级'] === 'string' ? t['优先级'] : ''
    cards.push({
      title,
      priority: (['高', '中', '低'] as const).includes(priorityRaw as any) ? priorityRaw : '中',
      tags,
      steps,
      review: typeof t['验收标准'] === 'string' ? t['验收标准'].trim() : '',
    })
  }
  if (!cards.length) throw new Error('JSON 里没有一张合法的卡（标题全空）')
  return cards
}

/** AI 卡正文：方案勾选框 + 验收判据（对齐 arsenal.ts「验收判据禁形容词」纪律） */
function renderDraftBody(card: DraftCard, goal: string): string {
  const steps = (card.steps && card.steps.length ? card.steps : ['（AI 未给步骤，人工补）'])
    .map(s => `- [ ] ${s}`)
  return [
    `## 方案`,
    ...steps,
    '',
    `## 结果记录`,
    '',
    `## 附言`,
    `- AI 起草（目标：${goal}）。验收标准：${card.review || '（AI 未给，人工补——验收判据禁形容词）'}`,
  ].join('\n')
}

function markAiSource(task: Task): void {
  // TaskFrontmatter 开放索引允许未知字段；source 已在 index.ts 的中英映射表里（'来源'↔'source'）
  updateTask(task.id, { source: 'ai-planning', review: 'human' } as any)
}

// ── 对外入口 1：目标拆解 → 待审批任务卡 ─────────────────────────────────

export async function planToDraft(
  goal: string,
  projectId = '',
  model?: string,
): Promise<{ ok: true; created: { id: string; title: string }[]; usage: ChatUsage } | { ok: false; error: string; usage: ChatUsage }> {
  const g = (goal || '').trim()
  if (!g) return { ok: false, error: '目标为空——告诉 AI 你要拆什么', usage: emptyUsage }

  let context = ''
  if (projectId) {
    const data = getProjectSummary(projectId)
    if (!data.error && data.tasks.length) {
      context = `\n\n当前项目任务（避免重复）：\n${formatTasksForAudit(data.tasks)}`
    }
  }

  let text: string
  let usage: ChatUsage = emptyUsage
  try {
    const r = await chatDetailed(`目标：${g}\n项目：${projectId || '未指定'}${context}`, {
      model, system: PLAN_SYSTEM, temperature: 0.2, maxTokens: 3000,
    })
    text = r.text
    usage = r.usage
  } catch (e: any) {
    return { ok: false, error: `LLM 调用失败：${e?.message || e}`, usage }
  }

  let cards: DraftCard[]
  try {
    cards = normalizeCards(extractJson(text))
  } catch {
    // 兜底：原文不丢——落一张草稿卡供人工救援
    const rescue = createTask({
      title: `AI 拆解失败存档（${g.slice(0, 20)}）`,
      project: projectId || undefined,
      status: '草稿',
      tags: ['ai-draft', '解析失败'],
      body: `## 方案\n- [ ] 人工检查下面原文，救出可用部分\n\n## 结果记录\n\n## 附言\n- AI 输出解析失败，原文如下：\n\n\`\`\`\n${text}\n\`\`\``,
    })
    if (rescue) markAiSource(rescue)
    return { ok: false, error: `JSON 解析失败——原文已存草稿卡 ${rescue.id}，可人工救${usageLabel(usage)}`, usage }
  }

  const created: { id: string; title: string }[] = []
  for (const card of cards) {
    const task = createTask({
      title: card.title,
      project: projectId || undefined,
      status: '待审批',
      priority: card.priority,
      tags: [...card.tags, 'ai-draft'].filter((v, i, a) => a.indexOf(v) === i),
      body: renderDraftBody(card, g),
    })
    markAiSource(task)
    created.push({ id: task.id, title: task.fm.title || card.title })
  }
  return { ok: true, created, usage }
}

// ── 对外入口 2：四栏项目说明草稿 → 待审批卡 ─────────────────────────────

export async function draftProjectBrief(
  projectId: string,
  model?: string,
): Promise<{ ok: true; taskId: string; usage: ChatUsage } | { ok: false; error: string; usage: ChatUsage }> {
  const pid = (projectId || '').trim()
  if (!pid) return { ok: false, error: '缺项目 id', usage: emptyUsage }

  const data = getProjectSummary(pid)
  if (data.error) return { ok: false, error: data.error, usage: emptyUsage }

  const projName = data.project?.name || pid
  const userMsg = `项目：${projName}（${pid}）\n\n当前项目任务：\n${
    data.tasks.length ? formatTasksForAudit(data.tasks) : '（还没有任务卡）'
  }`

  let text: string
  let usage: ChatUsage = emptyUsage
  try {
    const r = await chatDetailed(userMsg, { model, system: BRIEF_SYSTEM, temperature: 0.3, maxTokens: 2000 })
    text = r.text
    usage = r.usage
  } catch (e: any) {
    return { ok: false, error: `LLM 调用失败：${e?.message || e}`, usage }
  }

  let brief: Record<string, string>
  try {
    brief = extractJson(text) as Record<string, string>
  } catch {
    const rescue = createTask({
      title: `AI 说明草稿失败存档（${projName}）`,
      project: pid,
      status: '草稿',
      tags: ['ai-draft', '解析失败'],
      body: `## 方案\n- [ ] 人工检查原文\n\n## 结果记录\n\n## 附言\n${text}`,
    })
    if (rescue) markAiSource(rescue)
    return { ok: false, error: `JSON 解析失败——原文已存草稿卡 ${rescue.id}${usageLabel(usage)}`, usage }
  }

  const missing = ['现状', '目标', '不做', '欠着什么'].filter(k => !brief[k])
  if (missing.length) return { ok: false, error: `四栏缺：${missing.join('、')}${usageLabel(usage)}`, usage }

  const today = new Date().toISOString().slice(0, 10)
  const task = createTask({
    title: `[AI 起草] ${projName} 项目说明草稿（${today}）`,
    project: pid,
    status: '待审批',
    tags: ['ai-draft', '项目说明'],
    body: [
      `## 方案`,
      `- [ ] 过目四栏，改错的留对的`,
      `- [ ] 点头后由各线 agent 把终版落进该项目 repo 的立项契约（方寸侧是草稿，不是权威契约）`,
      '',
      `## 结果记录`,
      '',
      `## 附言`,
      `**现状**：${brief['现状']}`,
      '',
      `**目标**：${brief['目标']}`,
      '',
      `**不做**：${brief['不做']}`,
      '',
      `**欠着什么**：${brief['欠着什么']}`,
    ].join('\n'),
  })
  markAiSource(task)
  return { ok: true, taskId: task.id, usage }
}
