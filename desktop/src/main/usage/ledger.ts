/**
 * 投入产出账 · 取数（0.6.0 P5）
 *
 * 三个来源各取各的，**取不到就传 null**（不是空数组）——
 * 界面据此整格不渲染。口径与算法全在 `shared/waste.ts`，这里只负责"真去读"。
 *
 * 为什么不在渲染层取：ai-trace 是主进程写的文件、git 要在主进程起子进程、
 * 任务要从数据层读 —— 三件事都不该让界面各写一套。
 *
 * 依赖全部可注入：e2e 里用假 trace/commits/tasks 验"取不到"的分支，
 * 不用真起 git、不用真读用户数据。
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'
import { readTrace } from '../llm/trace'
import {
  buildWasteLedger,
  type WasteLedger,
  type WasteTaskRecord,
  type WasteTraceRecord,
} from '../../shared/waste'

export interface WasteLedgerOptions {
  days?: number
  repo?: string
  /** 固定基准时间（测试用） */
  now?: string | number
}

export interface WasteLedgerDeps {
  trace?: () => WasteTraceRecord[] | null
  commits?: (repo: string, days: number) => string[] | null
  tasks?: () => WasteTaskRecord[] | null
  /** 路径是否真实存在（D-141：判「可核实产出」用；测试可注入假实现） */
  exists?: () => (rel: string) => boolean
}

const GIT_TIMEOUT_MS = 15_000

function defaultTrace(): WasteTraceRecord[] | null {
  try {
    const r = readTrace({ limit: -1 })
    return Array.isArray(r.records) ? (r.records as any as WasteTraceRecord[]) : null
  } catch {
    // 没有 ai-trace（或路径取不到）= 这笔账取不到，不是 0
    return null
  }
}

function defaultCommits(repo: string, days: number): string[] | null {
  if (!repo) return null
  try {
    if (!fs.existsSync(path.join(repo, '.git'))) return null
    const since = days > 0 ? `${days} days ago` : '1970-01-01'
    const out = execFileSync(
      'git',
      ['-C', repo, 'log', `--since=${since}`, '--pretty=format:%h'],
      { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, windowsHide: true },
    )
    return String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch {
    return null
  }
}

function defaultTasks(): WasteTaskRecord[] | null {
  try {
    // 延迟 require：e2e 注入 deps 时不该被数据层/electron 拖住
    const data = require('../data') as any
    const rows = data.loadTasks('active') as any[]
    return rows.map((t: any) => ({
      id: String(t?.id || ''),
      title: String(t?.fm?.title || t?.fm?.['标题'] || t?.id || ''),
      status: String(t?.fm?.status || t?.fm?.['状态'] || ''),
      updated: t?.fm?.updated ?? t?.fm?.['更新时间'],
      // 2026-11-15（D-141）：判「可核实产出」要读正文；不传正文 = 那张卡一律不算产出
      body: String(t?.body ?? ''),
    }))
  } catch {
    return null
  }
}

/**
 * 「可核实产出」的路径判据（2026-11-15 · D-141）。
 *
 * 口径复用 `shared/verifiableOutput.ts`（与 mismatch 同一份），这里只提供"路径是否真存在"。
 * 只在**数据目录所在仓库**里查 —— 跨仓库那套需要 registry + 每仓 root，
 * 由 mismatch 那条链路负责；投入产出账先只算本仓，并在 detail 里说清这个边界。
 */
function defaultExists(): (rel: string) => boolean {
  let root = ''
  try { root = getDataDir() } catch { root = process.cwd() }
  return (rel: string) => {
    const r = String(rel || '').trim()
    if (!r) return false
    try {
      return fs.existsSync(path.resolve(root, r))
    } catch {
      return false
    }
  }
}

/**
 * 取一次账。所有来源互相独立：谁读不到就传 null，谁读到就算谁。
 */
export function collectWasteLedger(opts: WasteLedgerOptions = {}, deps: WasteLedgerDeps = {}): WasteLedger {
  let repo = String(opts.repo || '').trim()
  if (!repo) {
    try { repo = getDataDir() } catch { repo = process.cwd() }
  }
  const days = Number.isFinite(Number(opts.days)) ? Math.max(0, Math.floor(Number(opts.days))) : 30
  const trace = (deps.trace || defaultTrace)()
  const commits = (deps.commits || defaultCommits)(repo, days)
  const tasks = (deps.tasks || defaultTasks)()
  // 2026-11-15（D-141）：产出格只认「可核实产出」。exists 取不到时不传 ——
  // 那格会明说「判不了可核实产出」，而不是退回去数自报的完成卡。
  let exists: ((rel: string) => boolean) | undefined
  try { exists = (deps.exists || defaultExists)() } catch { exists = undefined }
  return buildWasteLedger({ days, now: opts.now, trace, commits, tasks, exists })
}
