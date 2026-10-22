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
import { readProjectFields, parseRegistry } from '../data'
import { loadDecisions } from '../data/decisions'
import type { Task } from '../data/tasks'

// ── 决策卡注入（2026-10-16 批次第 6 项机制件，与 Python 侧 _decisions_block 同语义）──
// 治的病：任务卡进上下文、决策卡零引用——AI 拆目标不知道已拍板的事。
// 有效卡（该项目优先、全库补齐）最近 10 条拼进两入口的 user message。
// decisions.md 是运行时数据，读挂了返回空串：锦上添花不拦主链。
function decisionsBlock(projectId: string, limit = 10): string {
  let decs: any[]
  try {
    decs = loadDecisions()
  } catch {
    return ''
  }
  const valid = decs.filter((d) => (d as any).状态 === '有效')
  let scoped = valid.filter((d) => String((d as any).项目 || '') === projectId)
  if (projectId && scoped.length < limit) {
    const seen = new Set(scoped.map((d) => (d as any).id))
    scoped = [...scoped, ...valid.filter((d) => !seen.has((d as any).id)).slice(0, limit - scoped.length)]
  } else if (!projectId) {
    scoped = valid
  }
  if (!scoped.length) return ''
  const lines = ['最近拍板（作数，AI 不得违背或重复提）：']
  for (const d of scoped.slice(0, limit)) {
    const src = (d as any).出处 ? `（出自 ${(d as any).出处}）` : ''
    lines.push(`- [${(d as any).id || ''}] ${(d as any).日期 || ''} ${(d as any).内容 || ''}${src}`)
  }
  return lines.join('\n')
}

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

const DOC_SYSTEM = `你是方寸项目管理系统的任务拆解助手。你正在执行「文档一键转任务」。

输入是一份文档（需求说明/会议记录/笔记/文章等）。你的职责：
1. 从文档中提取**可执行的任务**——忽略纯背景介绍、感想、已完成事项的叙述
2. 每个任务一句话标题，动词开头，范围小到一个人一两天能做完
3. 大块工作拆成多个任务；琐碎小事合并成一个任务
4. 文档里已有的结论或拍板（如「决定不做 X」）不要变成任务

输出要求（务必严格遵守）：
- 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏
- 格式：{"tasks": [{"标题": "…", "说明": "一句话背景或要点", "优先级": "高|中|低", "标签": ["…"], "方案": ["步骤1", "步骤2"], "验收标准": "怎么确认做完了"}]}
- tasks 数量不超过 {MAX}；文档里没有可提取的任务时输出 {"tasks": []}`

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

interface DraftCard { title: string; priority?: string; tags?: string[]; steps?: string[]; review?: string; desc?: string }

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
      desc: typeof t['说明'] === 'string' ? (t['说明'] as string).trim() : '',
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

function markAiSource(task: Task, source = 'ai-planning'): void {
  // TaskFrontmatter 开放索引允许未知字段；source 已在 index.ts 的中英映射表里（'来源'↔'source'）
  updateTask(task.id, { source, review: 'human' } as any)
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
    // 决策卡注入（批次第 6 项）：已拍板的事拼进上下文——AI 不得违背或重复提
    const decBlock = decisionsBlock(projectId)
    if (decBlock) context += `\n\n${decBlock}`
  }

  let text: string
  let usage: ChatUsage = emptyUsage
  try {
    const r = await chatDetailed(`目标：${g}\n项目：${projectId || '未指定'}${context}`, {
      model, system: PLAN_SYSTEM, trigger: 'desktop.planToDraft', temperature: 0.2, maxTokens: 3000,
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
  let userMsg = `项目：${projName}（${pid}）\n\n当前项目任务：\n${
    data.tasks.length ? formatTasksForAudit(data.tasks) : '（还没有任务卡）'
  }`
  // 决策卡注入（批次第 6 项）：四栏起草前先看清已拍板的事——「不做」栏有据可依
  const decBlock = decisionsBlock(pid)
  if (decBlock) userMsg += `\n\n${decBlock}`

  let text: string
  let usage: ChatUsage = emptyUsage
  try {
    const r = await chatDetailed(userMsg, { model, system: BRIEF_SYSTEM, trigger: 'desktop.draftProjectBrief', temperature: 0.3, maxTokens: 2000 })
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

// ── 对外入口 3：文档一键转任务 → 待审批卡（2026-10-17 用户拍板四件补立项之二）──

/** 文档卡正文：同 renderDraftBody 结构，附言注明「文档拆卡」来源与说明 */
function renderDocBody(card: DraftCard, docHint: string): string {
  const steps = (card.steps && card.steps.length ? card.steps : ['（AI 未给步骤，人工补）'])
    .map(s => `- [ ] ${s}`)
  const desc = card.desc ? `${card.desc}；` : ''
  return [
    `## 方案`,
    ...steps,
    '',
    `## 结果记录`,
    '',
    `## 附言`,
    `- 文档拆卡（AI 起草，来源：${docHint}）。${desc}验收标准：${card.review || '（AI 未给，人工补——验收判据禁形容词）'}`,
  ].join('\n')
}

const DOC_MAX_CHARS = 60000

export async function docToDrafts(
  docText: string,
  projectId = '',
  model?: string,
  maxCards = 20,
): Promise<{ ok: true; created: { id: string; title: string }[]; usage: ChatUsage } | { ok: false; error: string; usage: ChatUsage }> {
  const doc = (docText || '').trim()
  if (!doc) return { ok: false, error: '文档内容为空——粘贴文本或选文件后再拆', usage: emptyUsage }
  if (doc.length > DOC_MAX_CHARS) {
    return { ok: false, error: `文档过长（${doc.length} 字符 > ${DOC_MAX_CHARS}），先分段或摘出要点再拆`, usage: emptyUsage }
  }

  let context = `文档全文：\n${doc}\n\n项目：${projectId || '未指定'}`
  if (projectId) {
    const data = getProjectSummary(projectId)
    if (!data.error && data.tasks.length) {
      context += `\n\n当前项目任务（避免重复）：\n${formatTasksForAudit(data.tasks)}`
    }
    // 决策卡注入：文档里提的方案若与已拍板决策冲突，AI 先看到红线
    const decBlock = decisionsBlock(projectId)
    if (decBlock) context += `\n\n${decBlock}`
  }

  let text: string
  let usage: ChatUsage = emptyUsage
  try {
    const r = await chatDetailed(context, {
      model, system: DOC_SYSTEM.replace('{MAX}', String(maxCards)),
      trigger: 'desktop.docToDrafts', temperature: 0.2, maxTokens: 4000,
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
    // 兜底：原文不丢——落一张草稿卡供人工救援（红线 5 同款）
    const rescue = createTask({
      title: `文档拆卡失败存档（${doc.slice(0, 20)}）`,
      project: projectId || undefined,
      status: '草稿',
      tags: ['ai-draft', '解析失败'],
      body: `## 方案\n- [ ] 人工检查下面原文，救出可用部分\n\n## 结果记录\n\n## 附言\n- AI 输出解析失败，原文如下：\n\n\`\`\`\n${text}\n\`\`\``,
    })
    if (rescue) markAiSource(rescue, 'ai-doc')
    return { ok: false, error: `JSON 解析失败——原文已存草稿卡 ${rescue.id}，可人工救${usageLabel(usage)}`, usage }
  }
  if (cards.length > maxCards) cards = cards.slice(0, maxCards)

  const created: { id: string; title: string }[] = []
  for (const card of cards) {
    const task = createTask({
      title: card.title,
      project: projectId || undefined,
      status: '待审批',
      priority: card.priority,
      tags: [...card.tags, 'ai-draft'].filter((v, i, a) => a.indexOf(v) === i),
      body: renderDocBody(card, doc.slice(0, 40)),
    })
    markAiSource(task, 'ai-doc')
    created.push({ id: task.id, title: task.fm.title || card.title })
  }
  return { ok: true, created, usage }
}

// ── 对外入口 4：从台账出下一批（2026-10-22 · 施工方案 03 任务三「阶段性出单」）──
/**
 * 给一个项目**出下一批施工任务卡**。
 *
 * 03 单的验收线是「第一张由方寸产出的施工单被本地 agent 执行通过」，所以这里不新写一套
 * 提示词与落卡机制 —— 直接复用 `planToDraft`：它已经有「决策卡注入（已拍板的事不许违背）」
 * 「一律落待审批」「解析失败原文兜底落草稿卡」「usage 回传」这些真金白银的机制。
 * 本函数只干一件事：**把台账拼成一个目标**（现状 / 路线图 / 欠着 + 出单要求）。
 *
 * ⚠ 刻意不调 tripBoard：那个要逐项目 spawn git，而出单是低频人工动作，
 *   为了一句话的目标去跑十几条 git 不划算；三字段 + 任务卡 + 决策卡已经够出单了。
 */
/**
 * 把台账拼成出单目标（**纯函数、不花钱、可断言**）。
 *
 * 单独抽出来是为了让"出单的输入长什么样"能被测试咬住 —— 否则只能靠真调一次模型才知道
 * 目标拼错了没有，而那是要花用户的钱的。
 */
export function buildBatchGoal(
  projectId: string,
): { ok: true; goal: string; projectName: string } | { ok: false; error: string } {
  const pid = String(projectId || '').trim()
  if (!pid) return { ok: false, error: '要说清给哪个项目出单' }
  const f = readProjectFields(pid)
  if (!f.ok) return { ok: false, error: f.error || '读不到这个项目的三个手写字段' }
  const reg = (parseRegistry(true) as any[]).find((p) => String(p?.id) === pid) || {}
  const name = String(reg?.name || pid)

  const goal = [
    `给「${name}」出下一批施工任务（3~6 张），供本地 agent 直接执行。`,
    '',
    `现状（registry 手写）：${String(f.fields?.['状态'] || '未填')}`,
    `路线图（registry 手写）：${String(f.fields?.['路线图'] || '未填')}`,
    `欠着（registry 手写）：${String(f.fields?.['说明'] || '未填')}`,
    '',
    '出单要求：',
    '- 优先消化「欠着」里的事项，方向与「路线图」一致',
    '- 每张卡的方案里写清「改哪块（文件/模块/界面位置）」和「怎么算做完（可观察的验收判据）」，让本地 agent 不用再问就能干',
    '- 不重复已有任务，不违背已拍板的决策',
  ].join('\n')

  return { ok: true, goal, projectName: name }
}

export async function planBatch(
  projectId: string,
  model?: string,
): Promise<{ ok: true; created: { id: string; title: string }[]; usage: ChatUsage } | { ok: false; error: string; usage: ChatUsage }> {
  const g = buildBatchGoal(projectId)
  // 护栏排在**建请求之前**：项目不存在 / 读不到字段时，一次模型都不该调
  if (!g.ok) return { ok: false, error: (g as { ok: false; error: string }).error, usage: emptyUsage }
  return planToDraft(g.goal, String(projectId).trim(), model)
}
