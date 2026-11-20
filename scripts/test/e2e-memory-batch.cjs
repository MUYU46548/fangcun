/**
 * 记忆 · 项目/全局筛选 + 批量改字段 · 端到端（2026-11-20）
 *
 * 暮雨：强化记忆条目可筛选性和批量编辑性（如按项目分类、全局类）。
 * 判据不是“接口存在”，而是：
 *   ① 按项目 / 全局 / 状态筛得准，概览给真计数；
 *   ② 批量只改 frontmatter 的分类/标签/参数，**claim / 证据 / 状态一个字不动**；
 *   ③ 空项目 = 全局；非法类型 / 越界路径整条失败，不静默改；
 *   ④ 文件数不变（撤销≠删除、批量改也不删）。
 *
 * 全程临时数据根，不碰真记忆。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mem-batch-'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆 · 筛选 / 批量改字段 · 端到端 ==')
const memPath = path.join(DIST, 'services', 'memory.js')
check('★★ 编译产物在（先跑 build）', fs.existsSync(memPath), memPath)
if (!fs.existsSync(memPath)) {
  console.log(`\nRESULT ${pass} / ${fail}`); process.exit(1)
}

const data = require(path.join(DIST, 'data', 'index.js'))
fs.mkdirSync(path.join(TEMP, 'task-data'), { recursive: true })
if (typeof data.setDataDir === 'function') data.setDataDir(TEMP)
const mem = require(memPath)

const base = { type: '教训', evidence: '原文逐字，批量改不许碰。', source: 'e2e 批量' }
const a = mem.createMemory({ ...base, claim: 'A 项目独有：夜里三次强杀进程，打断了施工轮次。', project: 'proj-a' })
const b = mem.createMemory({ ...base, claim: 'B 项目独有：部署脚本把测试库当成正式库清空。', project: 'proj-b', type: '纪律' })
const g = mem.createMemory({ ...base, claim: '全局规矩：动手前先报目标路径，不许凭名字猜。', project: '' })
const p = mem.createMemory({ ...base, claim: '待审批提案：这条要通过后才算数，测试用。', project: 'proj-a' }, { pending: true })
check('★ 四条都建出来了', [a, b, g, p].every((x) => x && x.ok), JSON.stringify([a, b, g, p]))
mem.setMemoryStatus(a.file, '已撤销', '端到端撤销')

const claimsDir = path.join(TEMP, 'memory', 'claims')
const beforeFiles = fs.readdirSync(claimsDir).filter((n) => n.endsWith('.md')).sort()

// ── ① 筛选：项目 / 全局 / 状态 ───────────────────────────────────────
const ov = mem.memoryOverview()
check('★★ 概览有 byProject，且空项目记「通用 / 全局」',
  ov.byProject && ov.byProject['proj-a'] === 2 && ov.byProject['proj-b'] === 1
  && ov.byProject['通用 / 全局'] === 1,
  JSON.stringify(ov.byProject))
check('★ 概览有 projects 清单（不含全局）',
  Array.isArray(ov.projects) && ov.projects.includes('proj-a') && ov.projects.includes('proj-b')
  && !ov.projects.includes('通用 / 全局'), JSON.stringify(ov.projects))
check('★ 概览有 byStatus / pendingLatest',
  ov.byStatus && ov.byStatus['待审批'] === 1 && ov.pendingLatest && ov.pendingLatest.claim.indexOf('待审批提案') >= 0,
  JSON.stringify({ byStatus: ov.byStatus, latest: ov.pendingLatest }))
check('★★ 按项目筛：proj-a 只回它的（含已撤销时 2 条）',
  mem.searchMemory({ project: 'proj-a', includeRevoked: true, includePending: true }).total === 2,
  String(mem.searchMemory({ project: 'proj-a', includeRevoked: true, includePending: true }).total))
check('★★ 只筛全局：project 为空的那条',
  mem.searchMemory({ global: true, includeRevoked: true, includePending: true }).total === 1,
  String(mem.searchMemory({ global: true, includeRevoked: true, includePending: true }).total))
check('★★ 直接按状态筛「待审批」：includePending 不开也能看见',
  mem.searchMemory({ status: '待审批' }).total === 1,
  String(mem.searchMemory({ status: '待审批' }).total))
check('★ 按状态筛「已撤销」：includeRevoked 不开也能看见',
  mem.searchMemory({ status: '已撤销' }).total === 1,
  String(mem.searchMemory({ status: '已撤销' }).total))

// ── ② 批量改：分类/标签/参数变了，claim/证据/状态没动 ────────────────
const batchFiles = [a.file, b.file, g.file, p.file]
const r1 = mem.batchUpdateMemory(batchFiles, {
  project: 'proj-b', type: '纪律', tags: ['事故', '批量'], importance: 5, confidence: 0.9, pinned: true,
})
check('★★ 批量改 4 条成功', r1.ok === true && r1.updated === 4, JSON.stringify(r1))
check('★ 文件数不变（批量改不删文件）',
  fs.readdirSync(claimsDir).filter((n) => n.endsWith('.md')).length === beforeFiles.length,
  `${beforeFiles.length} → ${fs.readdirSync(claimsDir).filter((n) => n.endsWith('.md')).length}`)

function read(f) { return fs.readFileSync(path.join(TEMP, f), 'utf-8') }
const aText = read(a.file)
check('★★ claim 一个字没动', aText.includes('A 项目独有：夜里三次强杀进程，打断了施工轮次。'), aText.slice(0, 120))
check('★★ 证据一个字没动', aText.includes('原文逐字，批量改不许碰。'), aText.slice(0, 160))
check('★★ 状态没被批量改（撤销的那条还是已撤销、待审批的还是待审批）',
  /状态:\s*已撤销/.test(aText) && /状态:\s*待审批/.test(read(p.file)),
  aText.match(/状态:.*/)?.[0] + ' / ' + read(p.file).match(/状态:.*/)?.[0])
check('★★ 项目/类型/标签/重要度都写进去了',
  /项目:\s*proj-b/.test(aText) && /类型:\s*纪律/.test(aText)
  && /tags:\s*\['事故', '批量'\]/.test(aText) && /重要度:\s*5/.test(aText),
  aText.slice(0, 220))
check('★ 钉住 true / 可信度 0.9 也写进去了',
  /钉住:\s*true/.test(aText) && /可信度:\s*0\.9/.test(aText), aText.slice(0, 200))

// ── ③ 清空项目 = 全局；非法输入整条失败 ─────────────────────────────
const r2 = mem.batchUpdateMemory([b.file], { project: '' })
check('★★ 项目改成空串 → 归入「通用 / 全局」',
  r2.ok === true && mem.searchMemory({ global: true, includeRevoked: true, includePending: true })
    .rows.some((x) => x.file === b.file),
  JSON.stringify(r2))
const bBefore = read(b.file)
const r3 = mem.batchUpdateMemory([b.file], { type: '随便什么' })
check('★★ 非法类型整条失败，且文件零改动',
  r3.ok === false && r3.updated === 0 && read(b.file) === bBefore,
  JSON.stringify({ ok: r3.ok, updated: r3.updated, err: r3.error }))
const r4 = mem.batchUpdateMemory(['../escape.md'], { project: 'x' })
check('★★ 越界路径拒绝（不改 memory/ 外的文件）',
  r4.ok === false && r4.failed.length === 1 && /memory\//.test(r4.failed[0].error),
  JSON.stringify(r4))

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
