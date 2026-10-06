/**
 * Git 联动（卡 20260925-017，2026-10-06）
 *
 * 用户口径：「与 Git 的联动增强（做成项目管理抓手）」—— 原卡正文是空的（只有 `- [ ]`），
 * 按 2026-10-06 的草案实现前两项：
 *   ① 一张任务卡存续期间，它所属仓库有哪些提交（只读 git log，按时间窗）；
 *   ② 提交信息里提到这个任务 ID 的（`fix: xxx (#task-20261005-005)` 这类）。
 *
 * 铁律：
 *   · **只读**。`git log` / `git rev-parse` 而已 —— 不 checkout、不 fetch、不写工作区，
 *     更不碰别人仓库的任何文件（契约 ③「不写别人的仓库」）。
 *   · **永不抛**。不是 git 仓库 / 没装 git / 超时 / 命令失败，一律给空结果 —— 界面自己决定怎么说。
 *   · **不改任务数据**。本模块只回答"有哪些提交"，不往卡里写任何东西（要不要落卡由人决定）。
 *   · **异步**。⚠ 第一版用了 `execFileSync`（照抄 `services/tripBoard.ts` 的读法）—— 那是错的：
 *     sync 会把主进程事件循环**整个卡住**，而这个函数是"每打开一张卡就跑两次 git"，
 *     仓库一大就是几秒级的界面冻结。tripBoard 能接受 sync 是因为它只在读"在途一屏"时调一次 + 带缓存；
 *     这里调用频率高得多，**必须异步**（`execFile` 回调，不阻塞）。
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export interface CommitRow {
  hash: string
  short: string
  date: string      // ISO（作者提交时间 %cI）
  author: string
  subject: string
}

/** 字段分隔用 0x1f、记录分隔用 0x1e —— 提交信息里几乎不可能出现这两个控制字符 */
const FMT = '%H%x1f%h%x1f%cI%x1f%an%x1f%s%x1e'

/** 跑一条 git 命令；任何失败（非仓库 / 无 git / 超时 / 权限）都解析成空串，**绝不 reject** */
function git(repo: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise(resolve => {
    if (!repo) { resolve(''); return }
    try {
      execFile('git', ['-C', repo, ...args], {
        encoding: 'utf-8',
        timeout,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }, (err, stdout) => resolve(err ? '' : String(stdout || '')))
    } catch {
      resolve('')
    }
  })
}

function parseRows(out: string): CommitRow[] {
  return out
    .split('\x1e')
    .map(s => s.trim())
    .filter(Boolean)
    .map(rec => {
      const p = rec.split('\x1f')
      return {
        hash: p[0] || '',
        short: p[1] || '',
        date: p[2] || '',
        author: p[3] || '',
        subject: p[4] || '',
      }
    })
}

/** 这个目录是不是 git 仓库（同时挡住路径不存在的情况） */
export async function isGitRepo(repo: string): Promise<boolean> {
  if (!repo || !fs.existsSync(path.join(repo, '.git'))) return false
  return (await git(repo, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
}

/**
 * 时间归一：任务卡上的时间是**两套写法**（Python 写秒级数字、桌面写 ISO，见 2026-09-29 的裁决），
 * 这里两种都认；认不出来就给空（调用方自己去掉 --since/--until，等于不设限）。
 * `plusDays` 用于把"任务最后更新"往后推几天 —— 提交通常晚于卡上的更新时间。
 */
export function toIso(v: unknown, plusDays = 0): string {
  let ms: number | null = null
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 秒级（10 位）还是毫秒级（13 位）？数字时间戳一律按**秒级**解析是本项目的既有规矩
    ms = v < 1e11 ? v * 1000 : v
  } else if (typeof v === 'string' && v.trim()) {
    const s = v.trim()
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      ms = n < 1e11 ? n * 1000 : n
    } else {
      const t = Date.parse(s)
      ms = Number.isFinite(t) ? t : null
    }
  }
  if (ms === null) return ''
  return new Date(ms + plusDays * 86400000).toISOString()
}

/** 该仓库在时间窗内的提交（新 → 旧）。since/until 传空则不限那一端。 */
export async function repoCommitsBetween(repo: string, sinceIso = '', untilIso = '', limit = 40): Promise<CommitRow[]> {
  if (!repo) return []
  const args = ['log', `--max-count=${Math.max(1, Math.min(200, limit))}`, `--format=${FMT}`]
  if (sinceIso) args.push(`--since=${sinceIso}`)
  if (untilIso) args.push(`--until=${untilIso}`)
  return parseRows(await git(repo, args))
}

/**
 * 提交信息里提到这个任务 ID 的（新 → 旧）。
 * 用 `--grep=<id>`（**固定字符串**，不是正则 —— 任务 ID 里有 `-`）。
 * `-i` 大小写不敏感；`--all` 把所有分支算进来（提交可能还只在分支上）。
 */
export async function commitsMentioning(repo: string, taskId: string, limit = 20): Promise<CommitRow[]> {
  if (!repo || !taskId) return []
  return parseRows(await git(repo, [
    'log', '--all', '-i', `--grep=${taskId}`,
    `--max-count=${Math.max(1, Math.min(200, limit))}`, `--format=${FMT}`,
  ]))
}
