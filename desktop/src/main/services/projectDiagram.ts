/**
 * 项目结构图 —— **打开该项目的 archify 产物**（2026-10-29 暮雨当场纠正后重写）。
 *
 * 上一版是错的，写在这里留个诊断：
 *   我拿「项目 → 在途 → 已完成 → 执行日志」画了一张分层图，还叫它"项目结构图"。
 *   暮雨原话：「你是不是根本他妈不知道 archify 的结构图产物长什么样？这结构图有问题啊。」
 *   他说得对：archify 的产物是 **一份可交互的架构图 HTML**（组件/边界/连线/连线说明/视图章节），
 *   不是任务状态分层。方寸**没有能力**自己生成那种图 —— 硬拿任务数据凑一张，就是编。
 *
 * 所以这一版只做一件事：**找到该项目仓库里最新的一份 archify 产物，打开它。**
 *   · 找不到 → 明说「还没有 archify 结构图」，并给出生成方法。
 *   · 找到了 → 交给 shell.openPath 用系统浏览器打开（方寸不重画、不改写）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { parseRegistry } from '../data'

export interface ArchifyArtifactHit {
  /** 绝对路径 */
  path: string
  /** 相对项目仓库的路径（给人看） */
  rel: string
  /** 修改时间（ms），用来挑最新的 */
  mtime: number
}

/** 文件名的判据：架构图 / architecture / archify，且是 .html（archify 的交付物形态） */
export function isArchifyArtifactName(name: string): boolean {
  const n = String(name || '')
  if (!/\.html?$/i.test(n)) return false
  return /(架构图|架构|architecture|archify)/i.test(n)
}

/** 从「文件名 + mtime」里挑最新的一份（纯函数，供 Node 直跑断言）。 */
export function pickNewestArtifact(
  files: Array<{ path: string; rel?: string; mtime: number }>,
): ArchifyArtifactHit | null {
  const hits = (Array.isArray(files) ? files : [])
    .filter((f) => f && f.path && isArchifyArtifactName(path.basename(String(f.path))))
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  if (!hits.length) return null
  const top = hits[0]
  return { path: String(top.path), rel: String(top.rel || path.basename(String(top.path))), mtime: Number(top.mtime) || 0 }
}

/** 递归列目录里两层的 .html（跳过 node_modules / dist / 隐藏目录） */
function listHtml(dir: string, depth = 0, out: Array<{ path: string; rel: string; mtime: number }> = []): typeof out {
  if (depth > 2 || !fs.existsSync(dir)) return out
  let ents: fs.Dirent[] = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) listHtml(p, depth + 1, out)
    else if (/\.html?$/i.test(e.name)) {
      try { out.push({ path: p, rel: p, mtime: fs.statSync(p).mtimeMs }) } catch { /* 读不到就跳过 */ }
    }
  }
  return out
}

/**
 * 在项目仓库里找最新的 archify 产物。
 * 只认 `<repo>/docs` 及下一层 —— 不扫全仓：那是几万个文件，且不该替用户猜。
 */
export function findProjectArchitectureArtifact(repo: string): ArchifyArtifactHit | null {
  const root = String(repo || '').trim()
  if (!root || !fs.existsSync(root)) return null
  const docs = path.join(root, 'docs')
  const files = listHtml(fs.existsSync(docs) ? docs : root)
  const norm = files.map((f) => ({ ...f, rel: path.relative(root, f.path).split(path.sep).join('/') }))
  return pickNewestArtifact(norm)
}

/**
 * 项目 id/name → 该项目的最新 archify 产物。
 * 失败必须说清**为什么**（没登记 / 没 repo 目录 / 目录里没有产物），别让界面只说"失败"。
 */
export function findArtifactForProject(projectId: string): {
  ok: boolean
  error?: string
  hit?: ArchifyArtifactHit
  project?: { id: string; name: string; repo: string }
} {
  const want = String(projectId || '').trim()
  if (!want) return { ok: false, error: '没给项目 id' }
  let projects: any[] = []
  try { projects = parseRegistry(true) as any[] } catch (e: any) {
    return { ok: false, error: 'registry 读不出来：' + (e?.message || String(e)) }
  }
  const p = projects.find((x) => [x?.id, x?.name].map((v) => String(v ?? '').trim()).includes(want))
  if (!p) return { ok: false, error: `registry 里没有这个项目：${want}` }
  const repo = String(p.repo ?? '').trim()
  const name = String(p.name ?? p.id ?? want)
  if (!repo) return { ok: false, error: `${name} 没有登记 repo 路径，找不到它的结构图` }
  if (!fs.existsSync(repo)) return { ok: false, error: `${name} 的仓库目录不存在：${repo}` }
  const hit = findProjectArchitectureArtifact(repo)
  if (!hit) {
    return {
      ok: false,
      error: `${name} 还没有 archify 结构图 —— 先用 archify 生成一份 HTML，落到该仓库 docs/ 下`
        + `（文件名带「架构图」或 architecture），再点这里；方寸不自己画架构图。`,
      project: { id: String(p.id ?? want), name, repo },
    }
  }
  return { ok: true, hit, project: { id: String(p.id ?? want), name, repo } }
}
