/**
 * 项目结构图 —— **纯函数**（2026-10-29 暮雨第 2 条 / 卡 20261029-002）。
 *
 * 暮雨的原话：「那个 archify 相关的接口做了没？现在方寸能一键出项目结构图了吗？是对接 archify
 * 还是方寸内置的内核？」—— 事实是：**只有导入**（`tegula archify import` 把 archify 产出的 JSON
 * 存进卡的「架构」字段），从来没有生成器。这个文件补的就是「方寸内置内核」那一半。
 *
 * 范围写死在这里，免得被读错：
 *   这一版出的是 **方寸视角的项目结构** —— 项目 → 在途卡 → 已完成 → 执行日志。
 *   它 **不是代码架构图**（不读源码、不猜模块依赖）；要看代码架构，用 archify 生成后导入。
 *   这条界线必须同时出现在界面文案里（`note`），否则用户会拿它当架构图使。
 *
 * 算法不埋在组件里（同 `blockers.ts` / `boardCards.ts` 的规矩）：
 * `scripts/test/e2e-project-diagram.cjs` 用 Node 直跑编译产物断言。
 */
import type { LayerCard, LayerDiagramSpec } from './layerDiagram'

export interface DiagramTaskRef {
  title: string
  status: string
  priority?: string
}

export interface DiagramLogRef {
  title: string
  status: string
  created?: string
}

export interface ProjectDiagramInput {
  project: { id: string; name: string; status?: string; repo?: string }
  tasks: DiagramTaskRef[]
  logs: DiagramLogRef[]
}

export interface ProjectDiagramResult {
  spec: LayerDiagramSpec
  /** 与图一起出现的一句人话：这是什么、不是什么 */
  note: string
  counts: {
    open: number
    done: number
    logs: number
    /** 图里因为太多而没画出来的张数（**要说出来**，不许静默截断） */
    hiddenOpen: number
    hiddenDone: number
  }
}

const DONE_STATUS = ['完成', '驳回']
const PRIORITY_RANK: Record<string, number> = { 高: 0, 中: 1, 低: 2 }

/** 在途卡的排序：高 → 中 → 低，同档保持原顺序（稳定排序） */
function openRank(t: DiagramTaskRef): number {
  return PRIORITY_RANK[String(t.priority || '').trim()] ?? 3
}

function clip(s: string, n: number): string {
  const v = String(s || '').trim()
  return v.length > n ? v.slice(0, n - 1) + '…' : v
}

/**
 * 项目 → LayerDiagramSpec。
 *
 * 层的顺序就是"现在该看什么"：项目身份 → 在途 → 已完成 → 日志。
 * 空层**不画**（画一个空框等于说"这里应该有东西但没有"，那是噪音）。
 */
export function buildProjectDiagram(input: ProjectDiagramInput): ProjectDiagramResult {
  const project = input.project || ({ id: '', name: '' } as any)
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const logs = Array.isArray(input.logs) ? input.logs : []

  const open = tasks.filter((t) => !DONE_STATUS.includes(String(t.status || '').trim()))
  const done = tasks.filter((t) => String(t.status || '').trim() === '完成')
  const sortedOpen = open.slice().sort((a, b) => openRank(a) - openRank(b))

  const MAX_OPEN = 6
  const MAX_DONE = 4
  const MAX_LOGS = 3

  const lanes: LayerDiagramSpec['lanes'] = []
  lanes.push({
    name: '项目',
    color: 'accent',
    cards: [{ label: clip(project.name || project.id || '(未命名)', 18), sub: String(project.status || '') || undefined }],
  })

  const openCards: LayerCard[] = sortedOpen.slice(0, MAX_OPEN).map((t) => ({
    label: clip(t.title, 16),
    sub: [String(t.status || '').trim(), String(t.priority || '').trim()].filter(Boolean).join(' · '),
  }))
  if (open.length > MAX_OPEN) {
    openCards.push({ label: `…还有 ${open.length - MAX_OPEN} 张`, sub: '在途' })
  }
  if (openCards.length) lanes.push({ name: '在途', color: 'warning', cards: openCards })

  const doneCards: LayerCard[] = done.slice(0, MAX_DONE).map((t) => ({ label: clip(t.title, 16), sub: '完成' }))
  if (done.length > MAX_DONE) doneCards.push({ label: `…还有 ${done.length - MAX_DONE} 张`, sub: '已完成' })
  if (doneCards.length) lanes.push({ name: '已完成', color: 'success', cards: doneCards })

  const logCards: LayerCard[] = logs.slice(0, MAX_LOGS).map((l) => ({
    label: clip(l.title, 16),
    sub: String(l.status || '').trim() || undefined,
  }))
  if (logs.length > MAX_LOGS) logCards.push({ label: `…还有 ${logs.length - MAX_LOGS} 条`, sub: '日志' })
  if (logCards.length) lanes.push({ name: '执行日志', color: 'muted', cards: logCards })

  const spec: LayerDiagramSpec = {
    lanes,
    // 层间标签：lanes.length - 1 个（多给会被渲染器忽略，少给就少一行说明）
    between: lanes.slice(1).map((l) => String(l.name || '')),
    width: 900,
  }

  const parts: string[] = []
  parts.push(`方寸视角：${open.length} 张在途 · ${done.length} 张完成 · ${logs.length} 条日志`)
  if (open.length > MAX_OPEN) parts.push(`图里只画了前 ${MAX_OPEN} 张在途（按优先级）`)
  const note = parts.join(' · ')
    + ' —— 这是任务/日志结构，不是代码架构图；要看代码架构，用 archify 生成后导入。'

  return {
    spec,
    note,
    counts: {
      open: open.length,
      done: done.length,
      logs: logs.length,
      hiddenOpen: Math.max(0, open.length - MAX_OPEN),
      hiddenDone: Math.max(0, done.length - MAX_DONE),
    },
  }
}
