/**
 * 记忆导入 / 一键整理 · 端到端（2026-11-20 问卷 M5 A + M1 B）
 *
 * 判据不是“按钮能点”，而是四条硬规矩：
 *   ① 导入和整理都只落「待审批」，默认检索看不到；
 *   ② 每一条都带来源；缺来源的拒绝；
 *   ③ 重复默认跳过，**不覆盖已有文件**（逐字节不变）；
 *   ④ 一键整理只接受候选里真实存在的 source；模型编的 source 一律拒。
 *
 * 全程临时数据根，不碰 task-data / 真记忆。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mem-import-'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆导入 / 一键整理 · 端到端 ==')
const memPath = path.join(DIST, 'services', 'memory.js')
check('★★ 编译产物在（先跑 build）', fs.existsSync(memPath), memPath)
if (!fs.existsSync(memPath)) {
  console.log(`\nRESULT ${pass} / ${fail}`); process.exit(1)
}

const data = require(path.join(DIST, 'data', 'index.js'))
fs.mkdirSync(path.join(TEMP, 'task-data'), { recursive: true })
if (typeof data.setDataDir === 'function') data.setDataDir(TEMP)
const mem = require(memPath)

function listClaimFiles() {
  const dir = path.join(TEMP, 'memory', 'claims')
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.md')) } catch { return [] }
}
function readClaim(files, needle) {
  for (const n of files) {
    const p = path.join(TEMP, 'memory', 'claims', n)
    const t = fs.readFileSync(p, 'utf-8')
    if (t.includes(needle)) return { file: n, text: t }
  }
  return null
}

// ── ① JSON 导入：2 条成功，重复/缺来源/缺原文各拒一条 ────────────────
const json = JSON.stringify([
  { claim: 'JSON 导入的一条', evidence: '原文 A', source: '旧笔记 A', type: '教训', importance: 4 },
  { claim: 'JSON 导入的第二条', evidence: '原文 B', source: '旧笔记 B', type: '纪律' },
  { claim: 'JSON 导入的一条', evidence: '重复', source: '旧笔记 C' },
  { claim: '缺来源的一条', evidence: '原文 D' },
  { claim: '缺原文的一条', source: '旧笔记 E' },
])
const r1 = mem.importMemories({ text: json, format: 'auto' })
check('★★ JSON 导入：2 条成功 / 3 条被拒', r1.ok === true && r1.imported === 2 && r1.skipped === 3,
  JSON.stringify({ ok: r1.ok, imported: r1.imported, skipped: r1.skipped, errors: r1.errors }))
check('★ 缺来源 / 缺原文 / 重复都有明确原因', r1.errors.length >= 3 && /来源|原文|重复/.test(r1.errors.join('|')),
  r1.errors.join(' | '))
check('★★ 导入的条目默认检索看不到（只落待审批）',
  mem.searchMemory({}).total === 0 && mem.searchMemory({ includePending: true }).total === 2,
  JSON.stringify({ def: mem.searchMemory({}).total, pending: mem.searchMemory({ includePending: true }).total }))
const f1 = readClaim(listClaimFiles(), 'JSON 导入的一条')
check('★★ 文件里写着「状态: 待审批」和来源', !!f1 && /状态:\s*待审批/.test(f1.text) && /来源:\s*旧笔记 A/.test(f1.text),
  f1 ? f1.text.slice(0, 160) : 'not found')

// ── ② Markdown 导入：v2 frontmatter + 两段；来源回退 ─────────────────
const md = [
  '---',
  '类型: 事故',
  '来源: 旧事故记录 2026-10',
  '项目: fangcun-base',
  '可信度: 0.9',
  '重要度: 5',
  "tags: ['导入', '事故']",
  '---',
  '## 记忆',
  'Markdown 导入的一条。',
  '## 证据',
  '这是 Markdown 里的原文。',
].join('\n')
const r2 = mem.importMemories({ text: md, format: 'md' })
check('★★ Markdown：1 条成功且来源来自 frontmatter', r2.ok === true && r2.imported === 1 && r2.skipped === 0,
  JSON.stringify(r2))
const f2 = readClaim(listClaimFiles(), 'Markdown 导入的一条')
check('★ Markdown 的 claim / 证据 / 来源都落了盘',
  !!f2 && /Markdown 导入的一条/.test(f2.text) && /这是 Markdown 里的原文/.test(f2.text) && /旧事故记录 2026-10/.test(f2.text),
  f2 ? f2.text.slice(0, 200) : 'not found')

const mdNoSource = md.replace('来源: 旧事故记录 2026-10\n', '').replace('Markdown 导入的一条', '没来源的 Markdown 条')
const beforeNoSource = listClaimFiles().length
const r3 = mem.importMemories({ text: mdNoSource, format: 'md' })
check('★★ Markdown 缺来源 → 拒绝，零写入', r3.ok === false && listClaimFiles().length === beforeNoSource,
  JSON.stringify({ ok: r3.ok, error: r3.error, before: beforeNoSource, after: listClaimFiles().length }))

const mdFallback = mdNoSource.replace('没来源的 Markdown 条', '用导入框来源的 Markdown 条')
const r4 = mem.importMemories({ text: mdFallback, format: 'md', source: '导入框来源' })
check('★ 表单来源可回退（每条仍带来源）', r4.ok === true && r4.imported === 1, JSON.stringify(r4))
const f4 = readClaim(listClaimFiles(), '用导入框来源的 Markdown 条')
check('★ 回退来源真写进文件', !!f4 && /来源:\s*导入框来源/.test(f4.text), f4 ? f4.text.slice(0, 160) : 'not found')

// ── ③ 重复不覆盖：同一份 Markdown 再导一次，文件字节不变 ─────────────
const existing = readClaim(listClaimFiles(), 'Markdown 导入的一条')
const bytes = existing ? existing.text : ''
const countBeforeDup = listClaimFiles().length
const r5 = mem.importMemories({ text: md, format: 'md' })
const afterDup = readClaim(listClaimFiles(), 'Markdown 导入的一条')
check('★★ 重复导入 → 跳过，不新增文件', r5.ok === false && r5.skipped === 1 && listClaimFiles().length === countBeforeDup,
  JSON.stringify({ ok: r5.ok, skipped: r5.skipped, before: countBeforeDup, after: listClaimFiles().length }))
check('★★ 重复导入不覆盖已有文件（逐字节不变）', !!afterDup && afterDup.text === bytes,
  existing && afterDup ? `len ${bytes.length} -> ${afterDup.text.length}` : 'missing')

// ── ④ 一键整理：生成给 DSH 的整理包；不调模型、不写盘 ───────────────
;(async () => {
const sources = [
  { id: 'log:test-1', project: 'fangcun-base', title: '测试日志', text: '用户说：不要在没报告 PID 前杀进程。实际发生了一次误杀。' },
  { id: 'task:test-2', project: '', title: '测试任务', text: '结论：先读文件再改。' },
]
const beforeOrg = listClaimFiles().length
const org = mem.organizeMemories({}, { sources })
check('★★ 一键整理只生成整理包（不调模型、不写盘）',
  org.ok === true && org.mode === 'handoff' && org.count === 2,
  JSON.stringify({ ok: org.ok, mode: org.mode, count: org.count, error: org.error }))
check('★★ 整理包列出候选 source，并要求逐字匹配',
  /log:test-1/.test(org.prompt) && /task:test-2/.test(org.prompt) && /source 必须逐字/.test(org.prompt),
  String(org.prompt).slice(0, 300))
check('★★ 整理包要求走 memory_write 且只能落「待审批」',
  /memory_write/.test(org.prompt) && /待审批/.test(org.prompt),
  String(org.prompt).slice(0, 300))
check('★★ 整理包不改任何文件（零写入）', listClaimFiles().length === beforeOrg,
  `${beforeOrg} -> ${listClaimFiles().length}`)

// ── ⑤ 没候选：直接说没有，不生成空包 ─────────────────────────────────
const none = mem.organizeMemories({}, { sources: [] })
check('★ 没有候选来源 → 直接说没有，不生成空包',
  none.ok === false && /没有可整理/.test(String(none.error || '')), JSON.stringify(none))

try { fs.rmSync(TEMP, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exitCode = 1 }
})()