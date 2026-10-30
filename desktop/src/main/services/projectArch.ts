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
import { buildArchGraph, filterArchGraph, type ArchGraph, type ArchScanFacts } from '../../shared/archGraph'
import { evaluateArchGraph, repairArchGraph, type ArchReview } from '../../shared/archValidate'

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

/** 文件 → 目录级节点 id（`src/main/services/logs.ts` → `src/main/services`；根目录散文件 → `(根目录)`）
 *
 * 2026-10-30（暮雨：「质量极差，无实战意义」）：原实现只到 `src/main` 一层 —— 整个主进程
 * 四百多个文件被画成一个方块，那不是架构图，是目录清单。现在**先到第三层**，
 * 再由 scanProject 把"只有一两个文件"的碎目录并回父级（见 rollupFineNodes）：
 * 真项目里 `src/main/services` / `src/renderer/components` 会各自成块，碎目录不占坑。
 */
export function nodeIdOfRel(rel: string): string {
  const seg = String(rel || '').split('/').filter(Boolean)
  const dirs = seg.slice(0, -1)          // 末段是文件名，节点只到目录
  if (!dirs.length) return '(根目录)'
  // 2026-10-30：仓库根不一定就是代码根 —— 常见形态是 `desktop/src/main/services/...`
  // （方寸自己就是）。先前只认 `src` 在第一段，结果整个 desktop 被压成一个方块。
  // 现在**在任意一段找 src/app/packages**，带上它前面的包名前缀，再取其后最多三层。
  const rootAt = dirs.findIndex((d) => d === 'src' || d === 'app' || d === 'packages')
  if (rootAt >= 0) {
    const tail = dirs.slice(rootAt + 1, rootAt + 4)
    const head = dirs.slice(0, rootAt)
    return [...head, dirs[rootAt], ...tail].join('/')
  }
  return dirs[0]
}

/**
 * 把「文件数 < 2 的第三层目录」并回父级，并把节点总数压到上限内。
 * 纯函数（输入 rawCount，输出 raw → final 映射），`e2e-project-arch` 直接断言。
 *
 * 为什么按文件数而不是按名字：名字无从判断重要性；文件数是扫出来的事实。
 */
export function rollupFineNodes(rawCount: Map<string, number>, maxNodes = 13): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of rawCount.keys()) map.set(raw, raw)
  const parentOf = (raw: string): string => raw.split('/').slice(0, -1).join('/')
  // 有些目录**不能并**：preload 只有 1 个文件，但它是 IPC / 桥两类证据的唯一落点；
  // renderer / main / shared / cli 同理 —— 并掉它们，图上就只剩一堆"大目录"，又回到目录清单。
  const PROTECTED = new Set(['preload', 'renderer', 'main', 'shared', 'cli'])
  const keep = (raw: string) => PROTECTED.has(raw.split('/').filter(Boolean).pop() || '')
  for (const [raw, n] of rawCount) {
    const depth = raw.split('/').filter(Boolean).length
    if (depth >= 3 && n < 2 && !keep(raw)) map.set(raw, parentOf(raw))
  }
  // 节点太多：每次把"文件最少"的第三层目录并回父级，直到压进上限
  let guard = 0
  while (new Set(map.values()).size > maxNodes && guard++ < 200) {
    const cand = Array.from(rawCount.entries())
      .filter(([raw]) => map.get(raw) === raw && raw.split('/').filter(Boolean).length >= 3 && !keep(raw))
      .sort((a, b) => a[1] - b[1])[0]
    if (!cand) break
    map.set(cand[0], parentOf(cand[0]))
  }
  return map
}

function readPackageJson(dir: string): ArchScanFacts['packageJson'] {
  const p = path.join(dir, 'package.json')
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

/**
 * 找这个仓库的 package.json（2026-10-30 修正：方寸自己就是 monorepo）。
 *
 * 上一版只读仓库根 —— 方寸的 package.json 在 `desktop/` 下，于是图上写着
 * 「缺 package.json / 缺入口」，而它明明就在那儿。这不是"缺"，是扫描器的盲区。
 * 顺序：根 → desktop / app / packages/*（只认真实存在的，不猜）。
 */
function findPackageJson(repo: string): { pkg: ArchScanFacts['packageJson']; base: string } {
  const rootPkg = readPackageJson(repo)
  if (rootPkg) return { pkg: rootPkg, base: '' }
  const cands: string[] = ['desktop', 'app', 'client', 'web']
  try {
    const pkgs = path.join(repo, 'packages')
    if (fs.existsSync(pkgs)) {
      for (const e of fs.readdirSync(pkgs, { withFileTypes: true })) {
        if (e.isDirectory()) cands.push('packages/' + e.name)
      }
    }
  } catch { /* 读不到 packages 就只试固定候选 */ }
  for (const base of cands) {
    const pkg = readPackageJson(path.join(repo, base))
    if (pkg) return { pkg, base }
  }
  return { pkg: null, base: '' }
}

function collectEntries(repo: string, pkg: ArchScanFacts['packageJson'], base = ''): string[] {
  const out: string[] = []
  const push = (rel: string) => {
    const r0 = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '')
    const r = base ? `${base}/${r0}` : r0
    if (!r || out.includes(r)) return
    // 构建产物不是架构入口（`dist/boot.js` 是 tsc 的输岀，不是“从哪进”）——
    // 2026-10-30 实测：入口节点差点变成 dist/boot.js，图上等于没有源码入口。
    if (/(^|\/)(dist|build|out|release)\//.test(r)) return
    if (fs.existsSync(path.join(repo, r))) out.push(r)
  }
  if (pkg?.main) push(pkg.main)
  if (pkg?.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) push(String(v))
  for (const c of [
    'src/main.ts', 'src/main.js', 'src/main/index.ts', 'src/main/index.js',
    'src/index.ts', 'src/index.js', 'src/boot.ts', 'src/boot.js', 'index.ts', 'index.js',
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
  const pkgInfo = root && fs.existsSync(root) ? findPackageJson(root) : { pkg: null, base: '' }
  const pkg = pkgInfo.pkg
  const { files, truncated } = root && fs.existsSync(root) ? walkFiles(root) : { files: [], truncated: false }
  const limit = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : MAX_FILES
  const used = files.slice(0, limit)

  const dirMap = new Map<string, { files: number; samples: string[]; exts: Set<string> }>()
  const relOf = new Map<string, string>()
  // 先按"细粒度"数一遍文件，再决定哪些碎目录并回父级（2026-10-30 质量重做）。
  const rawCount = new Map<string, number>()
  for (const f of used) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    relOf.set(f, rel)
    const raw = nodeIdOfRel(rel)
    rawCount.set(raw, (rawCount.get(raw) || 0) + 1)
  }
  const finalMap = rollupFineNodes(rawCount)
  const finalOf = (rel: string): string => {
    const raw = nodeIdOfRel(rel)
    return finalMap.get(raw) || raw
  }
  for (const f of used) {
    const rel = relOf.get(f) || ''
    const id = finalOf(rel)
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
    const from = finalOf(rel)
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
      const to = finalOf(path.relative(root, target).split(path.sep).join('/'))
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
    entries: collectEntries(root, pkg, pkgInfo.base),
    imports: Array.from(edgeMap.values()).sort((a, b) => b.count - a.count),
    ipc,
    ports,
    scannedFiles: used.length,
    truncated: truncated || files.length > limit,
  }
}

/** 项目 id/name → 图。失败说清为什么（没登记 / 没 repo / 目录不在 / 扫不出东西）。 */
export function archForProject(projectId: string, opts: { strict?: boolean; excluded?: string[] } = {}): {
  ok: boolean
  error?: string
  graph?: ArchGraph
  review?: ArchReview
  repairs?: string[]
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
  let graph = buildArchGraph(facts, { strict: !!opts.strict })
  const repairs: string[] = []
  // 「驳回重画」（2026-10-30 第 3 条）：不是在原图上涂改，而是按诊断做减法，
  // 最多重画 3 版；每一版做了什么都要能说出来。
  if (opts.strict) {
    for (let round = 1; round <= 3; round++) {
      const rev = evaluateArchGraph(graph)
      if (rev.ok) break
      const rep = repairArchGraph(graph, round)
      graph = rep.graph
      repairs.push(...rep.repairs)
    }
  }
  const excluded = (Array.isArray(opts.excluded) ? opts.excluded : []).map(String).filter(Boolean)
  if (excluded.length) graph = filterArchGraph(graph, excluded)
  const review = evaluateArchGraph(graph)
  if (!graph.nodes.length) {
    return {
      ok: false,
      error: `${name} 里没有可扫的代码目录（不是 TS/JS 项目，或者仓库路径指错了）—— 缺什么已在卡上列出`,
      graph,
      review,
      repairs,
      repo,
      project: { id: String(p.id ?? want), name, repo },
    }
  }
  return { ok: true, graph, review, repairs, repo, project: { id: String(p.id ?? want), name, repo } }
}
