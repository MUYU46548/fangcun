/**
 * 方寸自绘架构图 —— 只读扫描器（2026-10-30，卡 task-20261030-002）
 *
 * 它做的事只有一件：**把仓库里真实的目录 / import / IPC 计数读出来**，交给
 * `shared/archGraph.ts` 拼图。会不会"编"？不会 —— 这里不接收任何模块名，节点只来自
 * 真的存在且真的有代码文件的目录。
 *
 * 三条纪律（e2e-project-arch 会逐条盯着）：
 *  ① **只读**：只用 readdirSync / readFileSync / statSync；本文件里出现 write/rm/mkdir 就是红。
 *  ② **不联网、不调模型**：没有 fetch / http / LLM 调用。
 *  ③ **不写项目仓库**：导出的 HTML 由用户在保存对话框里选位置（IPC 里做），
 *     这条是为了守住契约「对项目 repo 只读」。
 */
import * as fs from 'fs'
import * as path from 'path'
import { parseRegistry } from '../data'
import { buildArchGraph, type ArchGraph, type ArchScanFacts } from '../../shared/archGraph'

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'])
const SKIP_DIR = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.next', '.nuxt',
  'release', 'pkg', '.pkg-tmp', '__pycache__', '.venv', 'venv', 'target',
])
const MAX_FILES = 4000
const MAX_BYTES = 400 * 1024

function safeReadText(p: string): string {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > MAX_BYTES) return ''
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function walkFiles(repo: string): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false
  const walk = (dir: string, depth: number) => {
    if (files.length >= MAX_FILES) { truncated = true; return }
    if (depth > 6) return
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || /^release[-.]/.test(e.name)) continue
        walk(p, depth + 1)
        if (files.length >= MAX_FILES) { truncated = true; return }
      } else if (e.isFile() && CODE_EXT.has(path.extname(e.name).toLowerCase())) {
        files.push(p)
        if (files.length >= MAX_FILES) { truncated = true; return }
      }
    }
  }
  // 优先扫 src/（绝大多数 TS/JS 项目的代码都在这），没有再扫仓库根
  const src = path.join(repo, 'src')
  if (fs.existsSync(src) && fs.statSync(src).isDirectory()) walk(src, 0)
  else walk(repo, 0)
  return { files, truncated }
}

/** 文件 → 目录级节点 id（`src/main/x.ts` → `src/main`；根目录散文件 → `(根目录)`） */
export function nodeIdOfRel(rel: string): string {
  const seg = String(rel || '').split('/').filter(Boolean)
  if (!seg.length) return ''
  if (seg.length === 1) return '(根目录)'
  if (seg[0] === 'src' || seg[0] === 'app' || seg[0] === 'packages') {
    return seg.length >= 2 ? seg[0] + '/' + seg[1] : seg[0]
  }
  return seg[0]
}

function readPackageJson(repo: string): ArchScanFacts['packageJson'] {
  const p = path.join(repo, 'package.json')
  if (!fs.existsSync(p)) return null
  const text = safeReadText(p).replace(/^\uFEFF/, '')
  let j: any = null
  try { j = JSON.parse(text) } catch { return null }
  const deps: string[] = []
  for (const k of ['dependencies', 'devDependencies']) {
    const o = j && j[k]
    if (o && typeof o === 'object') for (const name of Object.keys(o)) if (!deps.includes(name)) deps.push(name)
  }
  const scripts: Record<string, string> = {}
  if (j && j.scripts && typeof j.scripts === 'object') for (const [k, v] of Object.entries(j.scripts)) scripts[k] = String(v)
  let bin: any = j?.bin
  if (typeof bin === 'string') bin = { [String(j?.name || 'bin')]: bin }
  return {
    name: typeof j?.name === 'string' ? j.name : undefined,
    version: typeof j?.version === 'string' ? j.version : undefined,
    main: typeof j?.main === 'string' ? j.main : undefined,
    bin: bin && typeof bin === 'object' ? bin : undefined,
    deps,
    scripts,
  }
}

function collectEntries(repo: string, pkg: ArchScanFacts['packageJson']): string[] {
  const out: string[] = []
  const push = (rel: string) => {
    const r = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '')
    if (!r || out.includes(r)) return
    if (fs.existsSync(path.join(repo, r))) out.push(r)
  }
  if (pkg?.main) push(pkg.main)
  if (pkg?.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) push(String(v))
  for (const c of [
    'src/main.ts', 'src/main.js', 'src/main/index.ts', 'src/main/index.js',
    'src/index.ts', 'src/index.js', 'index.ts', 'index.js',
    'src/renderer/main.ts', 'src/renderer/main.js', 'main.js', 'main.ts',
  ]) push(c)
  return out
}

const RE_FROM = /(?:import|export)\s+(?:[^'"\n]*?\sfrom\s*)?['"]([^'"]+)['"]/g
const RE_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const RE_DYN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function importsOf(text: string): string[] {
  const out: string[] = []
  for (const re of [RE_FROM, RE_REQUIRE, RE_DYN]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const spec = m[1]
      if (spec && !out.includes(spec)) out.push(spec)
    }
  }
  return out
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  const cands = [base]
  for (const ext of CODE_EXT) {
    cands.push(base + ext)
    cands.push(path.join(base, 'index' + ext))
  }
  for (const c of cands) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c } catch { /* 跳过 */ }
  }
  return null
}

function lineSamples(text: string, re: RegExp, rel: string, cap = 3): string[] {
  const out: string[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    re.lastIndex = 0
    if (re.test(lines[i])) out.push(rel + ':' + (i + 1) + ' · ' + lines[i].trim().slice(0, 110))
  }
  return out
}

export interface ScanOptions {
  maxFiles?: number
}

/**
 * 只读扫描。**唯一的 IO 入口**：readdir / readFile / stat。
 * 返回的事实交给纯函数 `buildArchGraph` —— 那里没有 IO，也就没法偷偷写盘。
 */
export function scanProject(repo: string, opts: ScanOptions = {}): ArchScanFacts {
  const root = String(repo || '').trim()
  const pkg = root && fs.existsSync(root) ? readPackageJson(root) : null
  const { files, truncated } = root && fs.existsSync(root) ? walkFiles(root) : { files: [], truncated: false }
  const limit = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : MAX_FILES
  const used = files.slice(0, limit)

  const dirMap = new Map<string, { files: number; samples: string[]; exts: Set<string> }>()
  const relOf = new Map<string, string>()
  for (const f of used) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    relOf.set(f, rel)
    const id = nodeIdOfRel(rel)
    if (!dirMap.has(id)) dirMap.set(id, { files: 0, samples: [], exts: new Set() })
    const d = dirMap.get(id)!
    d.files++
    d.exts.add(path.extname(f).toLowerCase())
    if (d.samples.length < 5) d.samples.push(rel)
  }

  // 目录级 import 聚合
  const edgeMap = new Map<string, { from: string; to: string; count: number; samples: string[] }>()
  const ipc = { handles: 0, handleSamples: [] as string[], invokes: 0, invokeSamples: [] as string[], bridgeUses: 0, bridgeSamples: [] as string[] }
  const ports: Array<{ port: number; source: string }> = []
  const reHandle = /ipcMain\.(?:handle|on)\s*\(/
  const reInvoke = /ipcRenderer\.(?:invoke|sendSync|send)\s*\(/
  const reBridge = /window\.tegula\./
  const rePort = /\.listen\s*\(\s*(\d{2,5})|port\s*[:=]\s*['"]?(\d{2,5})/

  for (const f of used) {
    const text = safeReadText(f)
    if (!text) continue
    const rel = relOf.get(f) || ''
    const from = nodeIdOfRel(rel)
    if (ipc.handles < 9999 && reHandle.test(text)) {
      ipc.handles += (text.match(new RegExp(reHandle.source, 'g')) || []).length
      ipc.handleSamples.push(...lineSamples(text, reHandle, rel, 2))
      if (ipc.handleSamples.length > 6) ipc.handleSamples.length = 6
    }
    if (reInvoke.test(text)) {
      ipc.invokes += (text.match(new RegExp(reInvoke.source, 'g')) || []).length
      ipc.invokeSamples.push(...lineSamples(text, reInvoke, rel, 2))
      if (ipc.invokeSamples.length > 6) ipc.invokeSamples.length = 6
    }
    if (reBridge.test(text)) {
      ipc.bridgeUses += (text.match(/window\.tegula\./g) || []).length
      ipc.bridgeSamples.push(...lineSamples(text, reBridge, rel, 1))
      if (ipc.bridgeSamples.length > 6) ipc.bridgeSamples.length = 6
    }
    if (ports.length < 8) {
      for (const line of text.split(/\r?\n/)) {
        const m = rePort.exec(line)
        if (!m) continue
        const n = Number(m[1] || m[2])
        if (n >= 1 && n <= 65535 && !ports.some((p) => p.port === n)) ports.push({ port: n, source: rel })
        if (ports.length >= 8) break
      }
    }
    for (const spec of importsOf(text)) {
      const target = resolveImport(f, spec)
      if (!target) continue
      const to = nodeIdOfRel(path.relative(root, target).split(path.sep).join('/'))
      if (!to || to === from) continue
      const key = from + '\u0000' + to
      if (!edgeMap.has(key)) edgeMap.set(key, { from, to, count: 0, samples: [] })
      const e = edgeMap.get(key)!
      e.count++
      if (e.samples.length < 4) e.samples.push(rel + ' → ' + spec)
    }
  }

  return {
    project: { id: '', name: '', repo: root },
    packageJson: pkg,
    dirs: Array.from(dirMap.entries())
      .map(([p, d]) => ({ path: p, files: d.files, samples: d.samples, exts: Array.from(d.exts).sort() }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    entries: collectEntries(root, pkg),
    imports: Array.from(edgeMap.values()).sort((a, b) => b.count - a.count),
    ipc,
    ports,
    scannedFiles: used.length,
    truncated: truncated || files.length > limit,
  }
}

/** 项目 id/name → 图。失败说清为什么（没登记 / 没 repo / 目录不在 / 扫不出东西）。 */
export function archForProject(projectId: string): {
  ok: boolean
  error?: string
  graph?: ArchGraph
  repo?: string
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
  if (!repo) return { ok: false, error: `${name} 没有登记仓库路径 —— 自绘架构图要先有代码可扫` }
  if (!fs.existsSync(repo)) return { ok: false, error: `${name} 的仓库目录不存在：${repo}` }
  const facts = scanProject(repo)
  facts.project = { id: String(p.id ?? want), name, repo }
  const graph = buildArchGraph(facts)
  if (!graph.nodes.length) {
    return {
      ok: false,
      error: `${name} 里没有可扫的代码目录（不是 TS/JS 项目，或者仓库路径指错了）—— 缺什么已在卡上列出`,
      graph,
      repo,
      project: { id: String(p.id ?? want), name, repo },
    }
  }
  return { ok: true, graph, repo, project: { id: String(p.id ?? want), name, repo } }
}
