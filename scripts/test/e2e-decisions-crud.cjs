/**
 * 决策卡 CRUD 端到端（2026-10-17 暮雨第 5 条）
 *
 * 原话：「决策似乎并不能进行编辑和删除，也没有其他高级管理功能，给人失控感。」
 * 本测试钉住新增的「改」与「删」两条通道：
 *   ① 改：内容/日期/项目/出处/备注 能落盘、能读回；**没传的字段保持原值**（没传 ≠ 清空）；
 *      传空串才是清空；内容改成空 → 拒绝且文件一个字节不动。
 *   ② 删：从 decisions.md 消失；**留底**进 decisions-deleted.md（"删了还能捞回来"是实话）；
 *      删不存在的 id → 显式失败。
 *   ③ 改不碰状态：状态只有 setDecisionStatus 一条路（三态校验在那边），从 update 进不去。
 *
 * ⚠ 隔离：`FC_TEST_USERDATA` + `setDataDir(临时目录)` —— 否则会动真实 task-data。
 * 运行：node scripts/test/e2e-decisions-crud.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-dec-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'projects: []\n', 'utf-8')

const DIST = path.resolve(__dirname, '../../desktop/dist/main')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(TEST_ROOT)
const dec = require(path.join(DIST, 'data', 'decisions.js'))

const DEC_FILE = path.join(TEST_ROOT, 'task-data', 'decisions.md')
const DEL_FILE = path.join(TEST_ROOT, 'task-data', 'decisions-deleted.md')

function readDec() { return fs.readFileSync(DEC_FILE, 'utf-8') }
function byId(list, id) { return list.find((d) => d.id === id) }

console.log('== 决策卡 CRUD e2e ==')
console.log('root:', TEST_ROOT)

// ── 准备：两条决策 ──────────────────────────────────────────────────
const a = dec.addDecision({ 内容: '先做收口，不做全周期平台', 日期: '2026-10-12', 项目: 'fangcun-base', 出处: '10-12 群' })
const b = dec.addDecision({ 内容: 'LLM 层 BYOK', 日期: '2026-10-13', 项目: '', 出处: '' })
check('两条决策写入成功', a.ok === true && b.ok === true, JSON.stringify({ a, b }))

// ── 1. 改内容 ──────────────────────────────────────────────────────
let r = dec.updateDecision(a.id, { 内容: '先做任务收口，不做全周期管理平台' })
check('改内容 → ok', r.ok === true, JSON.stringify(r))
let list = dec.loadDecisions()
check('改内容 → 读回是新值', byId(list, a.id).内容 === '先做任务收口，不做全周期管理平台', byId(list, a.id).内容)

// ── 2. 没传的字段不许被清空（没传 ≠ 清空）────────────────────────────
check('没传的字段保持原值（项目）', byId(list, a.id).项目 === 'fangcun-base', byId(list, a.id).项目)
check('没传的字段保持原值（出处）', byId(list, a.id).出处 === '10-12 群', byId(list, a.id).出处)
check('没传的字段保持原值（日期）', byId(list, a.id).日期 === '2026-10-12', byId(list, a.id).日期)

// ── 3. 传空串才是清空 ──────────────────────────────────────────────
dec.updateDecision(a.id, { 项目: '' })
list = dec.loadDecisions()
check('传空串 → 真的清空', byId(list, a.id).项目 === '', byId(list, a.id).项目)

// ── 4. 内容改成空 → 拒绝，且文件零改动 ──────────────────────────────
const before = readDec()
r = dec.updateDecision(a.id, { 内容: '   ' })
const after = readDec()
check('内容改空 → ok:false', r.ok === false, JSON.stringify(r))
check('内容改空 → 文件一个字节不动', before === after)

// ── 5. 改不存在的 id ───────────────────────────────────────────────
r = dec.updateDecision('D-999', { 内容: 'x' })
check('改不存在的决策 → ok:false', r.ok === false && /不存在/.test(r.error || ''), JSON.stringify(r))

// ── 6. 状态不受 update 影响 ────────────────────────────────────────
dec.setDecisionStatus(b.id, '已撤销')
dec.updateDecision(b.id, { 内容: 'LLM 层 BYOK（端点自填）' })
list = dec.loadDecisions()
check('update 不碰状态（已撤销仍是已撤销）', byId(list, b.id).状态 === '已撤销', byId(list, b.id).状态)

// ── 7. 删除：消失 + 留底 ───────────────────────────────────────────
const delBefore = fs.existsSync(DEL_FILE) ? fs.readFileSync(DEL_FILE, 'utf-8') : ''
r = dec.deleteDecision(b.id)
check('删除 → ok', r.ok === true, JSON.stringify(r))
list = dec.loadDecisions()
check('删除 → decisions.md 里没有了', !byId(list, b.id), JSON.stringify(list.map((x) => x.id)))
const delAfter = fs.readFileSync(DEL_FILE, 'utf-8')
check('删除 → 留底文件新增了这一条', delAfter.length > delBefore.length && delAfter.includes('LLM 层 BYOK（端点自填）'))
check('删除 → 留底带被删时间与状态', /已删除 D-\d+（/.test(delAfter) && delAfter.includes('已撤销'), delAfter.slice(-200))

// 留底是**追加**，不是覆盖：删两次要两条
fs.writeFileSync(DEC_FILE, readDec() + '\n## D-900 第三条\n- 日期: 2026-10-14\n- 状态: 有效\n- 出处: \n', 'utf-8')
dec.deleteDecision('D-900')
const delFinal = fs.readFileSync(DEL_FILE, 'utf-8')
check('留底是追加（两条删除 = 两段，不是覆盖）', (delFinal.match(/## 已删除/g) || []).length === 2, String((delFinal.match(/## 已删除/g) || []).length))

// ── 8. 删不存在的 ─────────────────────────────────────────────────
r = dec.deleteDecision('D-999')
check('删不存在的决策 → ok:false', r.ok === false && /不存在/.test(r.error || ''), JSON.stringify(r))

// ── 9. 其它决策不受影响 ───────────────────────────────────────────
check('未被删的那条还在', !!byId(dec.loadDecisions(), a.id))

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log(' -', f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
