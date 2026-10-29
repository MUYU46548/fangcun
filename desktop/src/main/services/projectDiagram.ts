/**
 * 项目结构图 —— 主进程装配（2026-10-29 暮雨第 2 条）。
 *
 * 判断全部在 `shared/projectDiagram.ts`（纯函数，Node 直跑可断言）；这里只做三件事：
 *   ① registry 取项目身份（名字 / 状态）
 *   ② 该项目的任务卡（**含已完成**，因为图里要画"已完成"那一层）
 *   ③ 该项目的执行日志（最近 3 条进图，其余只计数）
 *
 * 只读：不写任何文件、不改任何卡。
 */
import { loadTasks, parseRegistry } from '../data'
import * as logs from './logs'
import { buildProjectDiagram, type ProjectDiagramResult } from '../../shared/projectDiagram'

export interface ProjectDiagramReport extends ProjectDiagramResult {
  ok: boolean
  error?: string
  project?: { id: string; name: string; repo?: string }
}

const val = (t: any, k: string) => (t && t.fm && t.fm[k] !== undefined ? t.fm[k] : t?.[k])

export function checkProjectDiagram(projectId: string): ProjectDiagramReport {
  const want = String(projectId || '').trim()
  if (!want) {
    return {
      ok: false, error: '没给项目 id',
      spec: { lanes: [] }, note: '',
      counts: { open: 0, done: 0, logs: 0, hiddenOpen: 0, hiddenDone: 0 },
    }
  }

  let projects: any[] = []
  try {
    projects = parseRegistry(true) as any[]
  } catch (e: any) {
    return {
      ok: false, error: 'registry 读不出来：' + (e?.message || String(e)),
      spec: { lanes: [] }, note: '',
      counts: { open: 0, done: 0, logs: 0, hiddenOpen: 0, hiddenDone: 0 },
    }
  }
  const p = projects.find((x) => {
    const keys = [x?.id, x?.name].map((v) => String(v ?? '').trim())
    return keys.includes(want)
  })
  if (!p) {
    return {
      ok: false, error: `registry 里没有这个项目：${want}`,
      spec: { lanes: [] }, note: '',
      counts: { open: 0, done: 0, logs: 0, hiddenOpen: 0, hiddenDone: 0 },
    }
  }

  const pid = String(p.id ?? p.name ?? want).trim()
  // 任务：active + archive 都要 —— 已完成/驳回的卡在 archive 里，只读 active 会少一层
  const all = ([] as any[]).concat(loadTasks('active') as any[], loadTasks('archive') as any[])
  const mine = all.filter((t: any) => {
    const proj = val(t, 'project')
    return (Array.isArray(proj) ? proj : [proj]).some((x: any) => String(x ?? '').trim() === pid)
  })
  const tasks = mine.map((t: any) => ({
    title: String(val(t, 'title') || t?.id || ''),
    status: String(val(t, 'status') || ''),
    priority: String(val(t, 'priority') || ''),
  }))

  const logsOf = logs.listLogs({ project: pid }).slice(0, 50)
  const logRefs = logsOf.map((l) => ({ title: l.title, status: logs.logStatusText(l), created: l.created }))

  const r = buildProjectDiagram({
    project: { id: pid, name: String(p.name ?? pid), status: String(p['状态'] ?? ''), repo: String(p.repo ?? '') },
    tasks,
    logs: logRefs,
  })
  return { ok: true, ...r, project: { id: pid, name: String(p.name ?? pid), repo: String(p.repo ?? '') } }
}
