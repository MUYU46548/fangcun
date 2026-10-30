#!/usr/bin/env node
/**
 * 方寸自绘架构图 —— 纯逻辑 + 只读扫描断言（2026-10-30，卡 task-20261030-002）
 *
 * 真跑**编译产物**：`dist/main/services/projectArch.js`（扫描）+ `dist/shared/archGraph.js`
 * （图模型）+ `dist/shared/archSvg.js`（SVG / 独立 HTML），数据是临时目录里的**真 TS 项目夹具**。
 *
 * 这里钉的不是"能出图"，而是卡上那三条判据：
 *  ① **不许编模块**：节点只能来自真实存在的目录；连线只能来自真实 import / IPC 计数。
 *  ② **缺什么必须说出来**：空仓库 → 明确列缺项 + ARCH_EMPTY_TEXT，**不许**退化成任务分层图。
 *  ③ **只读**：扫描前后仓库里每个文件的字节数与 mtime 一个不变，也不许多出文件。
 *  ④ 另外：源码守卫（扫描器里不许出现写盘 / 联网 / 模型调用）。
 *
 * 运行：node scripts/test/e2e-project-arch.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, path.join(DATA, 'task-data'), USERDATA]) fs.mkdirSync(d, { recursive: true })

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const SCANNER = path.join(DIST, 'main', 'services', 'projectArch.js')
const GRAPH = path.join(DIST, 'shared', 'archGraph.js')
const SVG = path.join(DIST, 'shared', 'archSvg.js')
if (![SCANNER, GRAPH, SVG].every((p) => fs.existsSync(p))) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）')
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const arch = require(SCANNER)
const G = require(GRAPH)
const S = require(SVG)

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf-8')

/** 造一个真项目夹具（TS + preload + renderer + shared，含 IPC 与跨目录 import） */
function makeFixture(name) {
  const root = path.join(TMP, name)
  const w = (rel, text) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text, 'utf8')
  }
  w('package.json', JSON.stringify({
    name: 'fixture-app', version: '1.2.3', main: 'src/main/index.ts',
    dependencies: { vue: '^3.5.0', electron: '^44.0.0' },
    devDependencies: { typescript: '^5.0.0' },
    scripts: { build: 'tsc' },
  }, null, 2))
  w('src/main/index.ts', [
    "import { helper } from '../shared/util'",
    "import { register } from './ipc'",
    'const server = { listen: (p: number) => p }',
    'server.listen(8753)',
    "ipcMain.handle('arch:get', () => helper())",
    "ipcMain.on('arch:ping', () => {})",
    'register()',
  ].join('\n'))
  w('src/main/ipc.ts', [
    "import { round2 } from '../shared/util'",
    "ipcMain.handle('half', () => round2(1))",
    'export function register() { return true }',
  ].join('\n'))
  w('src/preload/index.ts', [
    "import { contextBridge, ipcRenderer } from 'electron'",
    "contextBridge.exposeInMainWorld('tegula', { get: (id) => ipcRenderer.invoke('arch:get', id) })",
  ].join('\n'))
  w('src/renderer/App.vue', [
    '<script setup lang="ts">',
    "import { helper } from '../shared/util'",
    "const r = await window.tegula.get('x')",
    '</script>',
  ].join('\n'))
  w('src/renderer/components/Card.vue', [
    '<script setup lang="ts">',
    "import { round2 } from '../../shared/util'",
    'const n = round2(2)',
    '</script>',
  ].join('\n'))
  w('src/shared/util.ts', 'export function helper() { return 1 }\nexport function round2(n: number) { return n }\n')
  w('README.md', '# fixture\n')
  return root
}

/** 快照：每个文件的相对路径 + 字节数 + mtime（判断"只读"用） */
function snapshot(root) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const st = fs.statSync(p)
        out.push(path.relative(root, p).split(path.sep).join('/') + ':' + st.size + ':' + st.mtimeMs)
      }
    }
  }
  walk(root)
  return out.sort().join('|')
}

console.log('== ① 只读扫描：事实来自真文件 ==')
const root = makeFixture('fixture-app')
const before = snapshot(root)
const facts = arch.scanProject(root)
const after = snapshot(root)

check('★★ 扫描前后仓库逐字节不变（大小 + mtime 一个不动）', before === after,
  before === after ? '' : '前后快照不同')
check('★ 没多出文件（扫描不落盘）', fs.readdirSync(root).sort().join(',') === 'README.md,package.json,src',
  fs.readdirSync(root).join(','))
check('读到 package.json 的包名与 main', facts.packageJson && facts.packageJson.name === 'fixture-app' && facts.packageJson.main === 'src/main/index.ts')
check('依赖清单合并 dependencies + devDependencies（3 个）', (facts.packageJson.deps || []).length === 3,
  JSON.stringify(facts.packageJson.deps))
check('识别入口（package.json main 命中 src/main/index.ts）',
  (facts.entries || []).includes('src/main/index.ts'), JSON.stringify(facts.entries))
check('代码目录只来自真实目录（src/main · src/preload · src/renderer · src/shared）', (() => {
  const ids = facts.dirs.map((d) => d.path).sort()
  return ids.join(',') === 'src/main,src/preload,src/renderer,src/shared'
})(), facts.dirs.map((d) => d.path + ':' + d.files).join(' '))
check('文件数是实际数到的（main 2 · renderer 2 · preload 1 · shared 1）', (() => {
  const m = Object.fromEntries(facts.dirs.map((d) => [d.path, d.files]))
  return m['src/main'] === 2 && m['src/renderer'] === 2 && m['src/preload'] === 1 && m['src/shared'] === 1
})(), JSON.stringify(facts.dirs.map((d) => [d.path, d.files])))
check('★ 目录间 import 计数来自源码（renderer→shared 2 条）', (() => {
  const e = facts.imports.find((x) => x.from === 'src/renderer' && x.to === 'src/shared')
  return !!e && e.count === 2 && e.samples.length >= 1
})(), JSON.stringify(facts.imports))
check('main→shared 1 条（两个文件各引一次：index 一次 + ipc 一次）', (() => {
  const e = facts.imports.find((x) => x.from === 'src/main' && x.to === 'src/shared')
  return !!e && e.count === 2
})(), JSON.stringify(facts.imports))
check('IPC 计数：ipcMain.handle/on 3 处 · ipcRenderer.invoke 1 处',
  facts.ipc.handles === 3 && facts.ipc.invokes === 1,
  `handles=${facts.ipc.handles} invokes=${facts.ipc.invokes}`)
check('桥调用计数：window.tegula.* 1 处', facts.ipc.bridgeUses === 1, String(facts.ipc.bridgeUses))
check('端口从源码里读出来（8753）', (facts.ports || []).some((p) => p.port === 8753), JSON.stringify(facts.ports))

console.log('\n== ② 图模型：节点/连线只来自证据 ==')
const graph = G.buildArchGraph({ ...facts, project: { id: 'fixture', name: '夹具', repo: root } })
check('title 用项目名', graph.title.indexOf('夹具') === 0, graph.title)
check('节点 = 四个目录 + 入口 + 外部依赖', (() => {
  const ids = graph.nodes.map((n) => n.id)
  return ['src/main', 'src/preload', 'src/renderer', 'src/shared', '__entry__', '__deps__'].every((x) => ids.includes(x))
})(), graph.nodes.map((n) => n.id).join(','))
check('★★ 不存在"凭名字造"的节点：每个 id 要么是真目录、要么是 __entry__/__deps__', graph.nodes.every((n) =>
  n.id === '__entry__' || n.id === '__deps__' || facts.dirs.some((d) => d.path === n.id)),
  graph.nodes.map((n) => n.id).join(','))
check('★ 入口节点带上真实文件（src/main/index.ts）', (() => {
  const e = graph.nodes.find((n) => n.id === '__entry__')
  return !!e && e.samples.includes('src/main/index.ts')
})(), JSON.stringify((graph.nodes.find((n) => n.id === '__entry__') || {}).samples))
check('★ import 边带条数与样例（renderer→shared ×2）', (() => {
  const e = graph.edges.find((x) => x.from === 'src/renderer' && x.to === 'src/shared' && x.kind === 'import')
  return !!e && e.count === 2 && e.samples[0].indexOf('→') > 0
})(), JSON.stringify(graph.edges))
check('★★ IPC 边：preload→main，标签写明 handle/invoke 条数', (() => {
  const e = graph.edges.find((x) => x.kind === 'ipc')
  return !!e && e.from === 'src/preload' && e.to === 'src/main' && /3 个 handle \/ 1 个 invoke/.test(e.label)
})(), JSON.stringify(graph.edges.map((e) => e.kind + ':' + e.label)))
check('★ 桥边：renderer→preload', (() => {
  const e = graph.edges.find((x) => x.kind === 'bridge')
  return !!e && e.from === 'src/renderer' && e.to === 'src/preload' && e.count === 1
})(), JSON.stringify(graph.edges.map((e) => e.kind)))
check('文字说明带数字（组件 / 连线 / 扫描文件）',
  graph.text.indexOf(String(graph.nodes.length)) >= 0 && graph.text.indexOf('扫描') >= 0, graph.text)
check('证据清单逐条说来源（package.json / import / IPC / 只读扫描）', (() => {
  const t = graph.evidence.join('\n')
  return /package\.json/.test(t) && /import/.test(t) && /IPC/.test(t) && /只读扫描/.test(t)
})(), graph.evidence.join(' | '))
check('没有缺项时 missing 为空（夹具是完整的）', graph.missing.length === 0,
  JSON.stringify(graph.missing))

console.log('\n== ③ 空仓库：缺什么必须说出来，不许装 ==')
const emptyRoot = path.join(TMP, 'empty-repo')
fs.mkdirSync(emptyRoot, { recursive: true })
fs.writeFileSync(path.join(emptyRoot, 'README.md'), '# 只有说明\n', 'utf8')
const emptyFacts = arch.scanProject(emptyRoot)
const emptyGraph = G.buildArchGraph({ ...emptyFacts, project: { id: 'empty', name: '空仓库', repo: emptyRoot } })
check('★★ 空仓库 → 一个节点都不编', emptyGraph.nodes.length === 0, String(emptyGraph.nodes.length))
check('★★ 缺项逐条列出（package.json / 代码目录 / 入口）', (() => {
  const what = emptyGraph.missing.map((m) => m.what)
  return what.includes('package.json') && what.includes('代码目录') && what.includes('入口文件')
})(), JSON.stringify(emptyGraph.missing))
check('★ 空图的话术就是 ARCH_EMPTY_TEXT（不是"0 个组件"）', emptyGraph.text === G.ARCH_EMPTY_TEXT, emptyGraph.text)
check('每条缺项都带一句"为什么"（不是只报缺）', emptyGraph.missing.every((m) => String(m.why || '').length > 6))

console.log('\n== ④ archForProject：正确报错，不糊弄 ==')
fs.writeFileSync(path.join(DATA, 'registry.yaml'), [
  'members:', '  - 测试', 'projects:',
  '  - id: fixture', '    name: 夹具项目', `    repo: ${root.replace(/\\/g, '\\\\')}`,
  '  - id: nope', '    name: 空项目', `    repo: ${emptyRoot.replace(/\\/g, '\\\\')}`,
  '  - id: nopath', '    name: 没路径', '',
].join('\n'), 'utf8')
const okOne = arch.archForProject('fixture')
check('★★ 真项目 → ok + 图', okOne.ok === true && !!okOne.graph && okOne.graph.nodes.length >= 4,
  JSON.stringify({ ok: okOne.ok, err: okOne.error, n: okOne.graph && okOne.graph.nodes.length }))
const emptyOne = arch.archForProject('nope')
check('★ 扫不出代码目录 → ok:false 且说明原因', emptyOne.ok === false && /代码目录/.test(emptyOne.error || ''), emptyOne.error)
check('  仍把图（含缺项）回传，界面能照实展示', !!emptyOne.graph && emptyOne.graph.missing.length >= 1)
const ghost = arch.archForProject('不存在的项目')
check('★ 没登记的项目 → 明说「没有这个项目」', ghost.ok === false && /没有这个项目/.test(ghost.error || ''), ghost.error)
const noPath = arch.archForProject('nopath')
check('★ 没登记仓库路径 → 明说缺什么', noPath.ok === false && /仓库路径/.test(noPath.error || ''), noPath.error)

console.log('\n== ⑤ SVG / 导出 HTML：离线、自带样式、带证据 ==')
const svg = S.renderArchSvg(graph)
check('SVG 里每个节点都有 data-node（点得中）', graph.nodes.every((n) => svg.indexOf('data-node="' + n.id + '"') >= 0))
check('★ SVG 连线数 = 图上的边数', (svg.match(/class="archd-edge /g) || []).length === graph.edges.length,
  `${(svg.match(/class="archd-edge /g) || []).length} / ${graph.edges.length}`)
check('★ 高亮态能只亮相关边（active 传节点 id）', (() => {
  const s = S.renderArchSvg(graph, { active: 'src/renderer' })
  return /archd-edge [a-z]+ on/.test(s) && /archd-node on/.test(s) && /archd-edge [a-z]+ dim/.test(s)
})(), '没有 on/dim')
const html = S.renderArchHtml(graph)
check('★★ 导出的 HTML 是自包含的（没有外链样式 / 脚本 / 网络）',
  !/<link\b/i.test(html) && !/<script\s+src=/i.test(html) && !/fetch\(/.test(html) && !/https?:\/\/(?!www\.w3\.org)/.test(html),
  (html.match(/https?:\/\/[^\s"']+/g) || []).join(','))
check('导出 HTML 带标题 / 组件明细 / 证据', html.indexOf(graph.title) >= 0 && html.indexOf('组件明细') >= 0 && html.indexOf('证据') >= 0)
check('空图的导出不假装有图（写明缺项）', S.renderArchHtml(emptyGraph).indexOf('缺什么') >= 0)
const missingHtml = S.renderArchHtml({ ...graph, missing: [{ what: 'X', why: '没有 X 就没法 Y' }] })
check('★ 有缺项时 HTML 里逐条列出（what + why 都在）', missingHtml.indexOf('X') >= 0 && missingHtml.indexOf('没有 X 就没法 Y') >= 0)

console.log('\n== ⑥ 源码守卫（改了实现就红）==')
/** 源码守卫先剥注释：注释里写「没有 fetch / http / LLM」是解释，不是调用。
 *  （方寸的老规矩：判据先剥注释行，否则守的是文档不是代码。） */
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const scannerCode = stripComments(read('desktop/src/main/services/projectArch.ts'))
check('★★ 扫描器里没有任何写盘调用（只读的硬保证）',
  !/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync|renameSync|cpSync|createWriteStream)\b/.test(scannerCode),
  (scannerCode.match(/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync|renameSync|cpSync|createWriteStream)\b/g) || []).join(','))
check('★★ 扫描器不联网、不调模型',
  !/\bfetch\s*\(|\bhttp\.|\bhttps\.|axios|openai|\bLLM\b/.test(scannerCode))
check('★ 不把图写进 task-data（契约：不污染数据目录）', !/task-data/.test(scannerCode + read('desktop/src/shared/archSvg.ts')))
check('★ 导出的写盘只在 IPC 里、且由用户选路径（services 里没有写）',
  /arch:export/.test(read('desktop/src/main/ipc.ts')) && /showSaveDialog/.test(read('desktop/src/main/ipc.ts')))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
