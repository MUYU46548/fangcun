/**
 * 项目结构图 —— **打开该项目的 archify 产物**（2026-10-29 暮雨当场纠正后重写）。
 *
 * 上一版是错的，写在这里留个诊断：
 *   我拿“项目 → 在途 → 已完成 → 执行日志”画了一张分层图，还叫它"项目结构图"。
 *   暮雨原话：“你是不是根本他妈不知道 archify 的结构图产物长什么样？这结构图有问题啊。”
 *   他说得对：archify 的产物是 **一份可交互的架构图 HTML**（组件/边界/连线/连线说明/视图章节），
 *   不是任务状态分层。方寸目前**没有能力**自己生成那种图 —— 硬拿任务数据凑一张，就是编。
 *   但"方寸自己画架构图"是他的目标（2026-10-30 第 2 条原话），已落卡 task-20261030-002；
 *   这一版先做能做的事，不冒充那个目标。
 *
 * 所以这一版只做一件事：**找到该项目仓库里最新的一份 archify 产物，打开它。**
 *   · 找不到 → 明说“还没有 archify 结构图”，并给出生成方法。
 *   · 找到了 → 交给 shell.openPath 用系统浏览器打开（方寸不重画、不改写）。
 *
 * 2026-11-21（卡 ff9476ff）补第二层：**打开的是“稳定副本”，不是仓库里那份原件。**
 *   archify 2.17 的 adaptive reader layout 会在 `ResizeObserver` / `requestAnimationFrame`
 *   里按“垂直预算”反推容器宽度；容器宽度又会改变 header/cards 的换行高度 →
 *   再触发 measure → 宽度来回跳。本机无头 Edge 实测（125%/150% 缩放，120 帧）：
 *     · 原图：clientWidth 每帧 1497↔1512（滚动条进出），SVG 宽 1097.4↔1114.4，
 *       scrollHeight 772↔778，**3 帧一个循环**；
 *     · 只补 `scrollbar-gutter`：宽度稳定了，但 SVG 仍 1097.4↔1114.4 抖（换行反馈环还在）；
 *     · 再钉死 `--archify-reader-width`：120 帧全部 0 变化。
 *   方寸**不原地改项目仓库**（对 repo 只读），所以把 HTML 读进来、注入两行稳定样式、
 *   写到临时目录再用浏览器打开；`<base href>` 指回原目录，相对资源照常能取。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { pathToFileURL } from 'url'
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

/** 从“文件名 + mtime”里挑最新的一份（纯函数，供 Node 直跑断言）。 */
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
  if (!repo) return { ok: false, error: `${name} 没有登记仓库路径，找不到它的架构图` }
  if (!fs.existsSync(repo)) return { ok: false, error: `${name} 的仓库目录不存在：${repo}` }
  const hit = findProjectArchitectureArtifact(repo)
  if (!hit) {
    return {
      ok: false,
      error: `${name} 还没有架构图 —— 先用 archify 生成一份 HTML，落到该仓库 docs/ 下`
        + `（文件名带“架构图”或 architecture），再点这里。`,
      project: { id: String(p.id ?? want), name, repo },
    }
  }
  return { ok: true, hit, project: { id: String(p.id ?? want), name, repo } }
}

// ── 打开副本的稳定性补丁（2026-11-21 · 卡 ff9476ff）──────────────────────────
//
// 只改**方寸打开的那一份副本**，仓库里的原件一个字节不动。
// 两行样式各治一个环，缺一不可（120 帧实测见文件头）：
//   ① `scrollbar-gutter: stable` —— 滚动条进出不再改内容宽度；
//   ② 钉死 `--archify-reader-width` —— archify 的“按垂直预算反推宽度”不再
//      参与布局（宽度→header 换行→高度→宽度 的反馈环被剪断）。
// 数值取 archify 自己的默认上限 1440px：比它窄的窗口照旧 100% 自适应。

export const STABLE_OPEN_STYLE_ID = 'fangcun-stable-open'

/** 注入的样式（e2e 直接断言这一份，别在测试里另抄一遍）。 */
export const STABLE_OPEN_CSS = [
  'html{scrollbar-gutter:stable;overflow-y:scroll}',
  'html{--archify-reader-width:1440px !important}',
].join('')

function escapeAttr(v: string): string {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * 给 archify 产物注入稳定样式 + `<base>`（相对资源仍从原目录取）。
 * 幂等：已注入过的 HTML 原样返回，重复打开不会叠一层。
 */
export function patchArtifactHtml(html: string, baseHref: string): string {
  const src = String(html ?? '')
  if (src.includes(`id="${STABLE_OPEN_STYLE_ID}"`)) return src
  const inject = `<base href="${escapeAttr(baseHref)}">`
    + `<style id="${STABLE_OPEN_STYLE_ID}">${STABLE_OPEN_CSS}</style>`
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => m + inject)
  if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, (m) => m + `<head>${inject}</head>`)
  return inject + src
}

/** 副本落点：按**源路径**做哈希，同一张图反复打开只覆盖同一份副本。 */
export function stableCopyPathFor(srcPath: string, root?: string): string {
  const rootDir = root || path.join(os.tmpdir(), 'fangcun-arch-open')
  const hash = crypto.createHash('sha1').update(path.resolve(srcPath)).digest('hex').slice(0, 12)
  return path.join(rootDir, hash, path.basename(srcPath))
}

/**
 * 读原图 → 注入 → 写临时副本。失败返回原因（调用方决定退回原图还是报错）。
 * ⚠ 只读源文件：不写回项目仓库、不改 mtime。
 */
export function prepareStableArtifactCopy(
  srcPath: string,
  root?: string,
): { ok: boolean; path?: string; error?: string } {
  try {
    const html = fs.readFileSync(srcPath, 'utf8')
    const baseHref = pathToFileURL(path.dirname(srcPath) + path.sep).href
    const out = stableCopyPathFor(srcPath, root)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, patchArtifactHtml(html, baseHref), 'utf8')
    return { ok: true, path: out }
  } catch (e: any) {
    return { ok: false, error: '生成稳定副本失败：' + (e?.message || e) }
  }
}
