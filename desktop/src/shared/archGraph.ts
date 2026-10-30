/**
 * 方寸自绘架构图 —— 图模型（纯逻辑，2026-10-30）
 *
 * 目标（卡 task-20261030-002）：不依赖 archify，方寸也能对一个 TS/JS 项目出**真正的架构图**。
 *
 * 三条硬规矩（写在类型里，不是写在愿望里）：
 *  ① **图必须来自可核实的证据**：节点只能来自真实存在的目录，连线只能来自真实的 import /
 *    IPC 计数；`buildArchGraph` 不接收"模块名"这种自由文本，所以它**编不出模块**。
 *  ② **缺什么必须说出来**：没有 package.json / 没有代码目录 / 没有入口，逐条进 `missing`，
 *    并明说"缺不等于没有"。不许退化成"给你画一张任务分层图"（上一版就是这么被否掉的）。
 *  ③ **只读**：这里只有纯函数；读盘在 `main/services/projectArch.ts`，且只调 readFile/readdir。
 *
 * 图长什么样：横向分层（renderer → preload → main → shared / 外部依赖），
 * 节点 = 目录（带文件数与样例），边 = 目录之间的 import（带条数与样例）或 IPC / 桥。
 */

export type ArchNodeKind = 'entry' | 'layer' | 'shared' | 'external'

export interface ArchNode {
  id: string
  label: string
  kind: ArchNodeKind
  /** 该目录下被扫到的代码文件数 */
  files: number
  /** 给人看的样例（相对仓库路径，最多 5 条） */
  samples: string[]
  /** 一句话说明它是什么依据出来的（目录名 / package.json 字段 …） */
  note: string
}

export type ArchEdgeKind = 'import' | 'ipc' | 'bridge'

export interface ArchEdge {
  from: string
  to: string
  kind: ArchEdgeKind
  label: string
  count: number
  samples: string[]
}

export interface ArchMissing {
  what: string
  why: string
}

export interface ArchGraph {
  title: string
  subtitle: string
  nodes: ArchNode[]
  edges: ArchEdge[]
  missing: ArchMissing[]
  /** 证据清单（给人复核：这些数字是从哪来的） */
  evidence: string[]
  /** 图上方的一句话（数字 + 口径，缺了就改口，不许装完整） */
  text: string
  /** 扫描了多少文件 / 是否被截断 */
  scannedFiles: number
  truncated: boolean
}

/** 扫描结果（由主进程填，纯函数只读它） */
export interface ArchScanFacts {
  project: { id: string; name: string; repo: string }
  packageJson: null | {
    name?: string
    version?: string
    main?: string
    bin?: Record<string, string> | string
    deps: string[]
    scripts: Record<string, string>
  }
  /** 代码目录 → 文件数 / 样例 / 后缀分布 */
  dirs: Array<{ path: string; files: number; samples: string[]; exts: string[] }>
  /** 入口文件（相对仓库路径） */
  entries: string[]
  /** 目录级 import 聚合 */
  imports: Array<{ from: string; to: string; count: number; samples: string[] }>
  ipc: {
    handles: number
    handleSamples: string[]
    invokes: number
    invokeSamples: string[]
    bridgeUses: number
    bridgeSamples: string[]
  }
  ports: Array<{ port: number; source: string }>
  scannedFiles: number
  truncated: boolean
}

/** 目录名 → 人话 + 优先级（决定在图上的行序） */
const ROLE: Record<string, { label: string; row: number; kind: ArchNodeKind }> = {
  renderer: { label: '渲染层（界面）', row: 0, kind: 'layer' },
  ui: { label: '界面组件', row: 0, kind: 'layer' },
  pages: { label: '页面', row: 0, kind: 'layer' },
  preload: { label: '预加载 / 桥', row: 1, kind: 'layer' },
  main: { label: '主进程', row: 2, kind: 'layer' },
  cli: { label: '命令行', row: 2, kind: 'layer' },
  shared: { label: '共享逻辑', row: 3, kind: 'shared' },
  common: { label: '共享逻辑', row: 3, kind: 'shared' },
  lib: { label: '内部库', row: 3, kind: 'shared' },
  scripts: { label: '脚本 / 工具', row: 4, kind: 'shared' },
  test: { label: '测试', row: 4, kind: 'shared' },
  tests: { label: '测试', row: 4, kind: 'shared' },
}

export function roleOfDir(dirPath: string): { label: string; row: number; kind: ArchNodeKind } {
  const seg = String(dirPath || '').split('/').filter(Boolean)
  const last = (seg[seg.length - 1] || '').toLowerCase()
  if (ROLE[last]) return ROLE[last]
  return { label: last || dirPath, row: 4, kind: 'layer' }
}

export const ARCH_EMPTY_TEXT = '这个项目没有可扫的代码目录 —— 缺什么下面逐条列了，缺不等于没有。'

/**
 * 事实 → 图。**不做任何猜测**：
 *  · 节点只从 `facts.dirs` 来（那些目录真的存在且真有代码文件）；
 *  · 边只从 `facts.imports` / `facts.ipc` 来（那两个数字真的从源码里数出来）；
 *  · 没有 entry 就写"没有识别到入口"，不补一个假的。
 */
export function buildArchGraph(facts: ArchScanFacts): ArchGraph {
  const f = facts || ({} as ArchScanFacts)
  const project = f.project || { id: '', name: '', repo: '' }
  const missing: ArchMissing[] = []
  const evidence: string[] = []

  const dirs = (f.dirs || []).filter((d) => d && d.path && d.files > 0)
  const pkg = f.packageJson

  if (!pkg) {
    missing.push({
      what: 'package.json',
      why: '没有它就读不出包名 / 入口 / 依赖 —— 这不是 Node 项目，或者仓库路径指错了',
    })
  }
  if (!dirs.length) {
    missing.push({
      what: '代码目录',
      why: '仓库里没有扫到 src/ 或已知的代码目录；节点只能来自真实目录，不许凭名字造',
    })
  }
  const entries = (f.entries || []).filter(Boolean)
  if (!entries.length) {
    missing.push({
      what: '入口文件',
      why: 'package.json 的 main/bin 与常见入口（src/main.ts、src/index.ts…）都没对上；图上不会硬画一个入口',
    })
  }
  const imports = (f.imports || []).filter((x) => x && x.count > 0)
  if (dirs.length && !imports.length && !(f.ipc && (f.ipc.handles > 0 || f.ipc.invokes > 0))) {
    missing.push({
      what: '可解析的连线',
      why: '没有扫到目录之间的 import，也没有 IPC 计数 —— 宁可只画方块，也不编箭头',
    })
  }
  if (f.truncated) {
    missing.push({
      what: '完整文件列表',
      why: '文件太多，这次只扫了上限以内的部分；节点上的文件数是**下限**，不是全量',
    })
  }

  const nodes: ArchNode[] = []
  for (const d of dirs) {
    const role = roleOfDir(d.path)
    nodes.push({
      id: d.path,
      label: role.label,
      kind: role.kind,
      files: d.files,
      samples: (d.samples || []).slice(0, 5),
      note: `${d.path} · ${d.exts.join(' / ') || '代码'}`,
    })
  }
  // 入口单独成节点：它是"从哪进"的答案，混在目录里会被读成又一个模块
  if (entries.length) {
    nodes.push({
      id: '__entry__',
      label: '入口',
      kind: 'entry',
      files: entries.length,
      samples: entries.slice(0, 5),
      note: pkg?.main ? `package.json main: ${pkg.main}` : '从常见入口位置识别',
    })
  }
  // 外部依赖：只列名字与个数，不画内部关系（我们没扫 node_modules）
  const deps = (pkg?.deps || []).slice()
  if (deps.length) {
    nodes.push({
      id: '__deps__',
      label: '外部依赖',
      kind: 'external',
      files: deps.length,
      samples: deps.slice(0, 8),
      note: '来自 package.json 的 dependencies / devDependencies（未扫 node_modules）',
    })
  }

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges: ArchEdge[] = []
  for (const im of imports) {
    if (!nodeIds.has(im.from) || !nodeIds.has(im.to) || im.from === im.to) continue
    edges.push({
      from: im.from,
      to: im.to,
      kind: 'import',
      label: `import ×${im.count}`,
      count: im.count,
      samples: (im.samples || []).slice(0, 4),
    })
  }
  const ipc = f.ipc || ({} as ArchScanFacts['ipc'])
  const preloadNode = nodes.find((n) => /preload/i.test(n.id))
  const mainNode = nodes.find((n) => /(^|\/)main$/i.test(n.id)) || nodes.find((n) => /main/i.test(n.id))
  const rendererNode = nodes.find((n) => /renderer/i.test(n.id))
  if (preloadNode && mainNode && (ipc.handles > 0 || ipc.invokes > 0)) {
    edges.push({
      from: preloadNode.id,
      to: mainNode.id,
      kind: 'ipc',
      label: `IPC：${ipc.handles} 个 handle / ${ipc.invokes} 个 invoke`,
      count: ipc.handles + ipc.invokes,
      samples: [...(ipc.handleSamples || []), ...(ipc.invokeSamples || [])].slice(0, 4),
    })
  }
  if (rendererNode && preloadNode && ipc.bridgeUses > 0) {
    edges.push({
      from: rendererNode.id,
      to: preloadNode.id,
      kind: 'bridge',
      label: `桥调用 ×${ipc.bridgeUses}`,
      count: ipc.bridgeUses,
      samples: (ipc.bridgeSamples || []).slice(0, 4),
    })
  }

  if (pkg) {
    evidence.push(`package.json：${pkg.name || '(无包名)'}${pkg.version ? ' ' + pkg.version : ''}${pkg.main ? ' · main=' + pkg.main : ''}`)
  }
  if (deps.length) evidence.push(`依赖清单：${deps.length} 个（只读 package.json，没扫 node_modules）`)
  if (dirs.length) evidence.push(`代码目录：${dirs.length} 个（文件数 = 实际数到的代码文件）`)
  if (imports.length) evidence.push(`目录间 import：${imports.reduce((s, x) => s + x.count, 0)} 条（正则解析 import/require 后聚合到目录）`)
  if (ipc.handles || ipc.invokes) evidence.push(`IPC：ipcMain.handle/on ${ipc.handles} 处 · ipcRenderer.invoke/send ${ipc.invokes} 处`)
  if (ipc.bridgeUses) evidence.push(`渲染层过桥调用：window.tegula.* ${ipc.bridgeUses} 处`)
  if ((f.ports || []).length) {
    evidence.push('端口：' + (f.ports || []).map((p) => `${p.port}（${p.source}）`).join(' · '))
  }
  evidence.push(`只读扫描：${Number(f.scannedFiles) || 0} 个文件${f.truncated ? '（已截断）' : ''}`)

  const title = (project.name || project.id || '项目') + ' · 架构图'
  const parts = [`${nodes.length} 个组件`, `${edges.length} 条连线`, `扫描 ${Number(f.scannedFiles) || 0} 个文件`]
  if (missing.length) parts.push(`缺 ${missing.length} 项依据`)
  const text = nodes.length
    ? parts.join(' · ')
    : ARCH_EMPTY_TEXT

  return {
    title,
    subtitle: `证据来自 package.json 与源码里的真实 import / IPC 计数 · ${project.repo || '(未登记仓库)'}`,
    nodes,
    edges,
    missing,
    evidence,
    text,
    scannedFiles: Number(f.scannedFiles) || 0,
    truncated: !!f.truncated,
  }
}

/** 行序：图上从上到下（先界面后内核），入口与依赖各占一行 */
export function rowOfNode(n: ArchNode): number {
  if (n.kind === 'entry') return -1
  if (n.kind === 'external') return 5
  return roleOfDir(n.id).row
}
