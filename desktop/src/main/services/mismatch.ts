/**
 * 「对不上」检测 —— 主进程装配（2026-10-27，REV-008 一期 R4）
 *
 * 这里只做三件事，**判断全部在 `shared/mismatch.ts`**（那样才能在纯 Node 里验口径）：
 *   ① 读 registry → 每个项目一条 RepoInfo（含 git 最后提交日期）
 *   ② 读 task-data 的原始 md 文本 → TaskRef[]（**要原文**，因为要按 `^状态:` 行判）
 *   ③ 注入 `exists` / `reposOf` 两个访问器，跨仓库查找才不会误报
 *
 * ⚠ 为什么 git 走 `runGit`（异步 spawn）：本机 `spawnSync`/`execFileSync` 一律 EBUSY，
 *   那是环境坑不是回归（MEMORY 环境坑第 1 条）。
 * ⚠ 只读：不写任何文件，不改任何卡。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, parseRegistry } from '../data'
import { runGit } from './gitExec'
import { collectMismatch, taskProjectsOf, type MismatchResult, type RepoInfo, type TaskRef } from '../../shared/mismatch'

export interface MismatchReport extends MismatchResult {
  ok: boolean
  error?: string
  /** 参与判定的项目数 / 卡数，给界面说明"这数是从多少条里算出来的" */
  scanned?: { projects: number; tasks: number }
  /** 取不到 git 的项目（不是 git 仓库等）——不许静默，要让用户知道哪条没法判 */
  noGit?: string[]
}

const todayISO = (): string => {
  const d = new Date()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

function readTaskTexts(root: string): TaskRef[] {
  const dir = path.join(root, 'task-data')
  if (!fs.existsSync(dir)) return []
  const out: TaskRef[] = []
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue
    try {
      out.push({ name, text: fs.readFileSync(path.join(dir, name), 'utf-8') })
    } catch {
      // 单张卡读不出来不该让整页失败；跳过并在 noGit 之外由调用方自行反映
    }
  }
  return out
}

/** 相对数据根的路径是否存在（`rel` 用 `/` 分隔） */
const existsUnder = (root: string) => (rel: string): boolean => {
  try {
    return fs.existsSync(path.join(root, rel.split('/').join(path.sep)))
  } catch {
    return false
  }
}

export async function checkMismatch(opts: { days?: number } = {}): Promise<MismatchReport> {
  const root = getDataDir()
  if (!root) return { ok: false, error: '取不到数据根目录', stale: [], noDate: [], broken: [], moved: [], nocriteria: [], total: 0 }

  let projects: any[] = []
  try {
    projects = parseRegistry(true) as any[]
  } catch (e) {
    return {
      ok: false, error: 'registry 读不出来：' + ((e as Error)?.message || String(e)),
      stale: [], noDate: [], broken: [], moved: [], nocriteria: [], total: 0,
    }
  }

  const noGit: string[] = []
  const repos: RepoInfo[] = []
  for (const p of projects) {
    const repo = String(p?.repo ?? '').trim().replace(/^~(?=$|[\\/])/, '')
    const label = String(p?.name ?? p?.id ?? '').trim()
    const keys = [String(p?.id ?? '').trim(), String(p?.name ?? '').trim()].filter(Boolean)
    if (!keys.length) continue
    let lastCommit: string | null = null
    if (repo && fs.existsSync(repo)) {
      const r = await runGit(repo, ['log', '-1', '--format=%ad', '--date=short'], 8000)
      const line = (r.out || '').trim().split('\n')[0] || ''
      if (r.code === 0 && /^\d{4}-\d{2}-\d{2}$/.test(line)) lastCommit = line
      else noGit.push(label || repo)
    } else {
      noGit.push(label || repo || '(无 repo)')
    }
    repos.push({ keys, path: repo, status: String(p?.['状态'] ?? ''), lastCommit })
  }

  const tasks = readTaskTexts(root)
  const exists = existsUnder(root)

  // 跨仓库：按卡的「项目」字段找它自己项目的 repo，逐条判存在
  const repoCache = new Map<string, RepoInfo>()
  for (const r of repos) for (const k of r.keys) repoCache.set(k, r)
  const reposOf = (t: TaskRef) => {
    const out: { name: string; exists: (rel: string) => boolean }[] = []
    for (const pid of taskProjectsOf(t.text)) {
      const r = repoCache.get(pid)
      if (!r || !r.path || path.resolve(r.path) === path.resolve(root)) continue
      if (!fs.existsSync(r.path)) continue
      out.push({ name: r.keys[0], exists: existsUnder(r.path) })
    }
    return out
  }

  const res = collectMismatch({ repos, tasks, todayISO: todayISO(), exists, reposOf, days: opts.days ?? 3 })
  return { ok: true, ...res, scanned: { projects: repos.length, tasks: tasks.length }, noGit }
}
