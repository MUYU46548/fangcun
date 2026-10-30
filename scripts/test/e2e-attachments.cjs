#!/usr/bin/env node
/**
 * 大附件清单与删除 —— 真文件断言（2026-10-30，卡 task-20261018-004）
 *
 * 判据三条（卡上原文的「附件治理」）：
 *  ① 只列**附件目录**里超过阈值的单文件（不是全盘扫描，也不把目录合计当单文件）；
 *  ② 删除必须由用户点，且主进程再校验路径 —— `../` 逃逸、符号链接、目录、目录外文件一律拒绝；
 *  ③ 列出这个动作本身**不改任何文件**（大小与 mtime 一个不动）。
 *
 * 运行：node scripts/test/e2e-attachments.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, path.join(DATA, 'task-data'), USERDATA]) fs.mkdirSync(d, { recursive: true })

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const ART = path.join(DIST, 'main', 'services', 'attachments.js')
if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）')
  console.log('RESULT 0 / 1')
  process.exit(1)
}

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
fs.writeFileSync(path.join(DATA, 'registry.yaml'), 'members:\n  - 测试\nprojects:\n  - id: demo\n    name: 演示\n', 'utf8')
data.setDataDir(DATA)

const ATT = require(ART)
const ROOT = path.join(DATA, 'docs', '执行日志', '_attachments')
fs.mkdirSync(path.join(ROOT, 'log-a'), { recursive: true })
fs.mkdirSync(path.join(ROOT, 'log-b'), { recursive: true })
// 真文件：一个 11MB（超阈值）、一个 1MB（不列）、一个正好 10MB（等于阈值 → 列）
fs.writeFileSync(path.join(ROOT, 'log-a', 'bundle.bin'), Buffer.alloc(11 * 1024 * 1024, 1))
fs.writeFileSync(path.join(ROOT, 'log-a', 'small.txt'), Buffer.alloc(1024, 2))
fs.writeFileSync(path.join(ROOT, 'log-b', 'exact.bin'), Buffer.alloc(10 * 1024 * 1024, 3))
// 目录外的"诱饵"：任何情况下都不许被删
const OUTSIDE = path.join(TMP, 'secret.txt')
fs.writeFileSync(OUTSIDE, 'do not delete', 'utf8')

const snap = () => {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { const st = fs.statSync(p); out.push(path.relative(DATA, p) + ':' + st.size + ':' + st.mtimeMs) }
    }
  }
  walk(ROOT)
  return out.sort().join('|')
}

console.log('== ① 只列附件目录里超过阈值的单文件 ==')
const before = snap()
const rep = ATT.listBigAttachments(10)
const after = snap()
check('★ 目录正确（数据目录下 docs/执行日志/_attachments）', path.resolve(rep.root) === path.resolve(ROOT), rep.root)
check('★★ 只列 ≥ 阈值的：11MB 与正好 10MB 都在，1MB 不在',
  rep.rows.length === 2 && rep.rows.some((r) => /bundle\.bin$/.test(r.rel)) && rep.rows.some((r) => /exact\.bin$/.test(r.rel)),
  JSON.stringify(rep.rows.map((r) => r.rel)))
check('按体积降序（最大的先看）', rep.rows[0].bytes >= rep.rows[1].bytes)
check('★ 阈值是单文件，不是目录合计（11MB 那份没被算成 21MB）',
  rep.rows.some((r) => Math.abs(r.mb - 11) < 0.2), JSON.stringify(rep.rows.map((r) => r.mb)))
check('scannedFiles 数的是全部附件文件（3 个）', rep.scannedFiles === 3, String(rep.scannedFiles))
check('★★ 列出这个动作不改文件（大小 / mtime 一个不动）', before === after)
check('阈值调大到 20MB → 一个都不列（阈值真的生效）', ATT.listBigAttachments(20).rows.length === 0)
check('没附件目录时返回空清单，不报错', (() => {
  const empty = path.join(TMP, 'empty-data')
  fs.mkdirSync(path.join(empty, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(empty, 'registry.yaml'), 'projects: []\n', 'utf8')
  const prev = DATA
  data.setDataDir(empty)
  const r = ATT.listBigAttachments(10)
  data.setDataDir(prev)
  return r.rows.length === 0 && r.scannedFiles === 0 && !r.error
})())

console.log('\n== ② 删除的硬闸：只许附件目录内的单个真实文件 ==')
check('★ 目录外文件：拒绝', (() => {
  const r = ATT.resolveAttachmentPath(OUTSIDE)
  return r.ok === false && /只允许删除附件目录/.test(r.error || '')
})(), JSON.stringify(ATT.resolveAttachmentPath(OUTSIDE)))
check('★ `../` 逃逸：拒绝（解析后仍在校验范围内判定）', (() => {
  const r = ATT.resolveAttachmentPath('docs/执行日志/_attachments/../../../../secret.txt')
  return r.ok === false
})(), JSON.stringify(ATT.resolveAttachmentPath('docs/执行日志/_attachments/../../../../secret.txt')))
check('★ 目录本身：拒绝（只删单个文件）', (() => {
  const r = ATT.resolveAttachmentPath(path.join(ROOT, 'log-a'))
  return r.ok === false && /单个文件/.test(r.error || '')
})(), JSON.stringify(ATT.resolveAttachmentPath(path.join(ROOT, 'log-a'))))
check('★ 不存在的文件：明说"可能已经被删了"', (() => {
  const r = ATT.resolveAttachmentPath('docs/执行日志/_attachments/nope.bin')
  return r.ok === false && /不存在|已经/.test(r.error || '')
})(), JSON.stringify(ATT.resolveAttachmentPath('docs/执行日志/_attachments/nope.bin')))
check('★★ 目录外文件被拒后**真的还在**（拒绝不是嘴上说说）', fs.existsSync(OUTSIDE))

console.log('\n== ③ 真删：只删那一个 ==')
const target = rep.rows.find((r) => /bundle\.bin$/.test(r.rel))
const del = ATT.deleteAttachment(target.rel)
check('★ 删除调用成功并报告释放体积', del.ok === true && del.freedMb > 10, JSON.stringify(del))
check('★★ 目标文件没了', !fs.existsSync(path.join(ROOT, 'log-a', 'bundle.bin')))
check('★★ 邻居文件还在（1MB 的 small.txt 与 10MB 的 exact.bin 都不许被连带）',
  fs.existsSync(path.join(ROOT, 'log-a', 'small.txt')) && fs.existsSync(path.join(ROOT, 'log-b', 'exact.bin')))
check('★ 删完再列：只剩那个 10MB', (() => {
  const r2 = ATT.listBigAttachments(10)
  return r2.rows.length === 1 && /exact\.bin$/.test(r2.rows[0].rel)
})())
check('★★ 目录外文件仍然完好（整轮没被碰过）', fs.readFileSync(OUTSIDE, 'utf8') === 'do not delete')

console.log('\n== ④ 源码守卫 ==')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf-8')
const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const src = strip(read('desktop/src/main/services/attachments.ts'))
check('★★ 删除前必须过 realpath 校验（防 ../ 与符号链接）', /realpathSync/.test(read('desktop/src/main/services/attachments.ts')))
check('★ 扫描器不联网、不调模型', !/\bfetch\s*\(|\bhttp\.|openai|\bLLM\b/.test(src))
check('★ 界面入口存在，且删除有二次确认', (() => {
  // 2026-10-30 拆分第一刀后，「大附件」这块在 components/DataHygienePanel.vue
  const ui = read('desktop/src/renderer/App.vue') + read('desktop/src/renderer/components/DataHygienePanel.vue')
  return /scanBigAttachments/.test(ui) && /deleteBigAttachment/.test(ui) && /confirm\(/.test(ui)
})())

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
