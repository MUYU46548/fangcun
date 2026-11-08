/**
 * 结构地图「结构大改就过期」—— 取数层（2026-11-08，同日按暮雨的追问重写）
 *
 * 判断规则在 `shared/structureDrift.ts`（纯函数）；这一层只负责问 git，并且**只问 3 次**：
 *   ① `git rev-list -1 --before=<核实日> HEAD` → 拿到“核实那天”的提交；
 *   ② `git diff --name-status -M <base> HEAD` → 自那天起 A/D/R 的文件；
 *   ③ `git ls-tree -r --name-only <base|HEAD>` → 两边的目录集合（用来判断“目录是新增还是本来就有”）。
 *
 * 为什么这么改（2026-11-08 暮雨：“源文件增删 ≥ 25 会不会导致每天过期？”）：
 *   · 旧版每个新增文件的父目录都要单跑一次 `git log --before`，20 个目录 = 20 次子进程；
 *     agent 每调一次 `project_charter` 就烧一次，一天几十次很实在。
 *   · 现在一次 `ls-tree` 就把“核实日有哪些目录”全拿到了，子进程从 ~40 降到 3。
 *   · 结果按 `仓库 + 核实日` 缓存 10 分钟：同一轮里反复问同一个项目不会重复扫。
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import {
  judgeStructureDrift, isStructuralPath, isSourcePath, parentDir,
  type DriftVerdict,
} from '../../shared/structureDrift'

export interface StructureDriftResult extends DriftVerdict {
  status: 'ok' | 'no-repo' | 'no-git' | 'no-date' | 'no-base'
  repo: string
  since: string
  /** 改名的文件数（只做说明） */
  renamed: number
  /** 缓存命中？ */
  cached?: boolean
}

const GIT = ['-c', 'core.quotepath=false']
const TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 64
const CACHE = new Map<string, { at: number; r: StructureDriftResult }>()

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT, ...args], {
    cwd, encoding: 'utf-8', timeout: 8000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/** 一份文件清单 → 结构目录集合（噪声已剔除） */
function dirSetOf(files: string[]): Set<string> {
  const out = new Set<string>()
  for (const f of files) {
    if (!isStructuralPath(f) || !isSourcePath(f)) continue   // 数据/素材目录不算模块结构
    const d = parentDir(f)
    if (d) out.add(d)
  }
  return out
}

/**
 * @param repoPath 项目仓库绝对路径（registry 的 repo 字段）
 * @param since    结构地图的「最后核实」日期 `YYYY-MM-DD`；空 → 无法比较
 * @param opts.fresh 跳过缓存（用例要连续造几种历史时用）
 */
export function structureDrift(repoPath: string, since: string, opts?: { fresh?: boolean }): StructureDriftResult {
  const repo = String(repoPath || '').trim()
  const day = String(since || '').trim()
  const base: StructureDriftResult = {
    status: 'ok', repo, since: day,
    stale: false, reason: '', files: 0, newDirs: [], removedDirs: [], renamed: 0,
  }

  const key = `${repo}|${day}`
  if (!opts?.fresh) {
    const hit = CACHE.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.r, cached: true }
  }

  const done = (r: StructureDriftResult): StructureDriftResult => {
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string)
    CACHE.set(key, { at: Date.now(), r })
    return r
  }

  if (!repo || !fs.existsSync(repo)) return done({ ...base, status: 'no-repo', reason: '仓库路径不存在或未登记' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return done({ ...base, status: 'no-date', reason: '结构地图没有“最后核实”日期，无从比较' })
  try {
    git(repo, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return done({ ...base, status: 'no-git', reason: '这个目录不是 git 仓库，无法判断结构变动' })
  }

  // ① 核实那天的提交
  let root = ''
  try {
    root = git(repo, ['rev-list', '-1', `--before=${day} 00:00:00`, 'HEAD']).trim()
  } catch {
    root = ''
  }
  if (!root) {
    return done({
      ...base, status: 'no-base',
      reason: `仓库在 ${day} 之前没有任何提交，没有可比较的基线 —— 地图写成“截至今天”即可`,
    })
  }

  // ② 自那天起的增/删/改名
  const added: string[] = []
  const deleted: string[] = []
  let renamed = 0
  try {
    const diff = git(repo, ['diff', '--name-status', '-M', root, 'HEAD'])
    for (const line of diff.split('\n')) {
      const t = line.trim()
      if (!t) continue
      if (t.startsWith('R')) { renamed++; continue }        // 改名不算增删
      const m = /^([AD])\s+(.+)$/.exec(t)
      if (!m) continue
      const p = m[2].replace(/\\/g, '/')
      if (!isStructuralPath(p)) continue
      if (m[1] === 'A') added.push(p)
      else deleted.push(p)
    }
  } catch { /* 空 diff / 权限问题：当成没变动 */ }

  // ③ 两边的目录集合（一次 ls-tree 拿全，不再逐目录问 git log）
  let baseDirs = new Set<string>()
  let headDirs = new Set<string>()
  try {
    baseDirs = dirSetOf(git(repo, ['ls-tree', '-r', '--name-only', root]).split('\n'))
    headDirs = dirSetOf(git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n'))
  } catch {
    baseDirs = new Set()
    headDirs = new Set()
  }

  const newDirs = Array.from(new Set(added.filter(isSourcePath).map(parentDir).filter((d) => d && !baseDirs.has(d))))
  const removedDirs = Array.from(baseDirs).filter((d) => !headDirs.has(d))

  const verdict = judgeStructureDrift({ added, deleted, newDirs, removedDirs })
  return done({ ...verdict, status: 'ok', repo, since: day, renamed })
}

/** 给用例/调试用：清空缓存 */
export function clearStructureDriftCache(): void {
  CACHE.clear()
}
