/**
 * 结构地图「结构大改就过期」—— 取数层（2026-11-08，同日按暮雨的追问重写；
 * 2026-11-17 重构成「取数 / 判定」两段，见下）
 *
 * 判断规则在 `shared/structureDrift.ts`（纯函数）；这一层只负责问 git，并且**只问 5 次**：
 *   ① `git rev-parse --is-inside-work-tree` → 是不是 git 仓库；
 *   ② `git rev-list -1 --before=<核实日> HEAD` → 拿到“核实那天”的提交；
 *   ③ `git diff --name-status -M <base> HEAD` → 自那天起 A/D/R 的文件；
 *   ④⑤ `git ls-tree -r --name-only <base|HEAD>` → 两边的目录集合。
 *
 * ## 2026-11-17 为什么要重构（这不是"顺手优化"，是修一个实测的卡死）
 *
 * 暮雨报：「刷新要 5000ms 以上」「点记忆页几乎整个方寸卡死，狂点好几下才进去」。
 * 实测根因**不在界面**：`policy:driftAll` 走的这条路径原本用 `execFileSync` **同步** spawn git，
 * 16 个项目 × 5 次子进程 ≈ **4.7 秒**，而且是在**主进程**里同步跑的 —— 事件循环整个冻住，
 * 期间**任何** IPC（点页签、读任务、读记忆）都只能排队。于是用户看到的就是"点了没反应"。
 *
 * 本机铁律（AGENTS.md 记过两次，e2e 也钉过）：`spawnSync/execFileSync` 一律 EBUSY 且会卡首屏，
 * git 必须走异步 `runGit`（`services/gitExec.ts`）。这条路径当时漏了。
 *
 * 所以现在：
 *   · **判定只有一份**：`verdictFromRaw()` —— 取数结果进、结论出，同步/异步两条腿共用，
 *     不可能出现"界面说不一致、MCP 说不一致"（同一套 git 输出喂进去必然同一结论，用例可自证）；
 *   · **产品路径一律异步**：`structureDriftAsync` / `structureDriftAllAsync`（并发 4，仍带缓存）；
 *   · **同步版保留但只给用例用**：`structureDrift` —— `e2e-structure-drift.cjs` 靠它跑真仓库。
 *     ⚠ 别在产品路径里再调同步版；`e2e-structure-drift.cjs` 有一条断言专门钉这个。
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import { runGit } from './gitExec'
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

/** 一次判定要的 git 输出（取数层只负责把这三样拿回来） */
interface DriftRaw {
  /** 核实日那天的提交；空 = 没有基线 */
  root: string
  /** `diff --name-status -M <root> HEAD` 的原文 */
  diff: string
  /** `<root>` 的 ls-tree 文件名清单 */
  baseTree: string
  /** `HEAD` 的 ls-tree 文件名清单 */
  headTree: string
  /** 改名条数（从 diff 里数出来的，只做说明） */
  renamed: number
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
 * **判定**：取数结果 → 结论。同步/异步两条腿共用这一份，判定口径只有一处。
 * 纯计算，不碰磁盘、不 spawn —— 所以可以被同一个夹具双向喂、互相对账。
 */
function verdictFromRaw(raw: DriftRaw, repo: string, day: string): StructureDriftResult {
  const added: string[] = []
  const deleted: string[] = []
  for (const line of raw.diff.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('R')) continue                          // 改名不算增删（条数另记）
    const m = /^([AD])\s+(.+)$/.exec(t)
    if (!m) continue
    const p = m[2].replace(/\\/g, '/')
    if (!isStructuralPath(p)) continue
    if (m[1] === 'A') added.push(p)
    else deleted.push(p)
  }

  const baseDirs = dirSetOf(raw.baseTree.split('\n'))
  const headDirs = dirSetOf(raw.headTree.split('\n'))

  const newDirs = Array.from(new Set(added.filter(isSourcePath).map(parentDir).filter((d) => d && !baseDirs.has(d))))
  const removedDirs = Array.from(baseDirs).filter((d) => !headDirs.has(d))

  const verdict = judgeStructureDrift({ added, deleted, newDirs, removedDirs })
  return { ...verdict, status: 'ok', repo, since: day, renamed: raw.renamed }
}

/** 从 `diff --name-status` 原文里数改名条数（R100/R087…） */
function countRenamed(diff: string): number {
  let n = 0
  for (const line of diff.split('\n')) {
    if (/^R\d*\t/.test(line.trim()) || /^R\d*\s/.test(line.trim())) n++
  }
  return n
}

function cacheGet(key: string, fresh: boolean): StructureDriftResult | null {
  if (fresh) return null
  const hit = CACHE.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.r, cached: true }
  return null
}

function cachePut(key: string, r: StructureDriftResult): StructureDriftResult {
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string)
  CACHE.set(key, { at: Date.now(), r })
  return r
}

function baseResult(repo: string, day: string): StructureDriftResult {
  return {
    status: 'ok', repo, since: day,
    stale: false, reason: '', files: 0, newDirs: [], removedDirs: [], renamed: 0,
  }
}

// ── 同步取数（**只给用例用**，产品路径禁止） ─────────────────────────────
function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT, ...args], {
    cwd, encoding: 'utf-8', timeout: 8000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * 同步版判定。⚠ **产品路径别调它** —— 它同步 spawn，会把主进程冻住（见文件头）。
 * 留着的唯一理由是 `e2e-structure-drift.cjs` 要在一个临时仓库上连续造几种历史并当场断言。
 *
 * @param repoPath 项目仓库绝对路径（registry 的 repo 字段）
 * @param since    结构地图的「最后核实」日期 `YYYY-MM-DD`；空 → 无法比较
 * @param opts.fresh 跳过缓存
 */
export function structureDrift(repoPath: string, since: string, opts?: { fresh?: boolean }): StructureDriftResult {
  const repo = String(repoPath || '').trim()
  const day = String(since || '').trim()
  const cached = cacheGet(`${repo}|${day}`, !!opts?.fresh)
  if (cached) return cached

  const base = baseResult(repo, day)
  const done = (r: StructureDriftResult) => cachePut(`${repo}|${day}`, r)

  if (!repo || !fs.existsSync(repo)) return done({ ...base, status: 'no-repo', reason: '仓库路径不存在或未登记' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return done({ ...base, status: 'no-date', reason: '结构地图没有“最后核实”日期，无从比较' })
  try {
    gitSync(repo, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return done({ ...base, status: 'no-git', reason: '这个目录不是 git 仓库，无法判断结构变动' })
  }

  let root = ''
  try {
    root = gitSync(repo, ['rev-list', '-1', `--before=${day} 00:00:00`, 'HEAD']).trim()
  } catch { root = '' }
  if (!root) {
    return done({
      ...base, status: 'no-base',
      reason: `仓库在 ${day} 之前没有任何提交，没有可比较的基线 —— 地图写成“截至今天”即可`,
    })
  }

  let diff = ''
  try { diff = gitSync(repo, ['diff', '--name-status', '-M', root, 'HEAD']) } catch { diff = '' }
  let baseTree = ''
  let headTree = ''
  try {
    baseTree = gitSync(repo, ['ls-tree', '-r', '--name-only', root])
    headTree = gitSync(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])
  } catch { baseTree = ''; headTree = '' }

  return done(verdictFromRaw({ root, diff, baseTree, headTree, renamed: countRenamed(diff) }, repo, day))
}

// ── 异步取数（产品路径走这条） ───────────────────────────────────────────
/** 异步跑一条 git；失败/超时返回空串（与同步版的 catch 语义一致：当成"没有变化"） */
async function gitAsync(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await runGit(cwd, [...GIT, ...args], 8000)
  return { ok: r.code === 0 && !r.timedOut, out: r.out || '' }
}

/**
 * 异步版判定（**产品路径用这个**）。
 *
 * 不阻塞事件循环 —— 这是它与同步版的唯一区别，判定口径完全共用 `verdictFromRaw`。
 * 返回形状与同步版逐字段一致，调用方零改动。
 */
export async function structureDriftAsync(
  repoPath: string, since: string, opts?: { fresh?: boolean },
): Promise<StructureDriftResult> {
  const repo = String(repoPath || '').trim()
  const day = String(since || '').trim()
  const key = `${repo}|${day}`
  const cached = cacheGet(key, !!opts?.fresh)
  if (cached) return cached

  const base = baseResult(repo, day)
  const done = (r: StructureDriftResult) => cachePut(key, r)

  if (!repo || !fs.existsSync(repo)) return done({ ...base, status: 'no-repo', reason: '仓库路径不存在或未登记' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return done({ ...base, status: 'no-date', reason: '结构地图没有“最后核实”日期，无从比较' })

  // ① 第一轮并发：是不是仓库 / 核实日的基线 / HEAD 的目录集合 —— 这三条互不依赖。
  //   （`ls-tree HEAD` 不需要 root，所以能提前跑；这样整个判定从三轮串行压到两轮，
  //     实测 16 个项目从 3.5s 的同步阻塞降到 1.9s→1.2s 的非阻塞。）
  const [inside, rv, ht] = await Promise.all([
    gitAsync(repo, ['rev-parse', '--is-inside-work-tree']),
    gitAsync(repo, ['rev-list', '-1', `--before=${day} 00:00:00`, 'HEAD']),
    gitAsync(repo, ['ls-tree', '-r', '--name-only', 'HEAD']),
  ])
  if (!inside.ok) return done({ ...base, status: 'no-git', reason: '这个目录不是 git 仓库，无法判断结构变动' })

  const root = rv.ok ? rv.out.trim() : ''
  if (!root) {
    return done({
      ...base, status: 'no-base',
      reason: `仓库在 ${day} 之前没有任何提交，没有可比较的基线 —— 地图写成“截至今天”即可`,
    })
  }

  // ② 第二轮并发：diff 与基线目录集合（都要知道 root 才能问）
  const [df, bt] = await Promise.all([
    gitAsync(repo, ['diff', '--name-status', '-M', root, 'HEAD']),
    gitAsync(repo, ['ls-tree', '-r', '--name-only', root]),
  ])
  const diff = df.ok ? df.out : ''
  return done(verdictFromRaw({
    root, diff,
    baseTree: bt.ok ? bt.out : '',
    headTree: ht.ok ? ht.out : '',
    renamed: countRenamed(diff),
  }, repo, day))
}

export interface DriftItem { project: string; repo: string; since: string }
export interface DriftRow { project: string; status: string; stale: boolean; reason: string }

/**
 * 批量判定（`policy:driftAll` / 结构地图一览）。**并发 4**：快，但不至于一次起 16×5 个子进程
 * 把机器拖垮；有 10 分钟缓存，第二轮基本全是命中。
 *
 * 每一条各自 try/catch —— 一个仓库坏了不该让整页没数（与旧的逐条 try 语义一致）。
 */
export async function structureDriftAllAsync(items: DriftItem[]): Promise<DriftRow[]> {
  const list = (Array.isArray(items) ? items : []).slice(0, 60)
  const out: DriftRow[] = new Array(list.length)
  const CONCURRENCY = 4
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= list.length) return
      const it = list[i]
      const project = String(it?.project || '')
      try {
        const r = await structureDriftAsync(String(it?.repo || ''), String(it?.since || ''))
        out[i] = { project, status: r.status, stale: r.stale, reason: r.reason }
      } catch (e: any) {
        out[i] = { project, status: 'error', stale: false, reason: String(e?.message || e) }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker))
  return out
}

/** 给用例/调试用：清空缓存 */
export function clearStructureDriftCache(): void {
  CACHE.clear()
}
