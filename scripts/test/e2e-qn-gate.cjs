#!/usr/bin/env node
/**
 * 澄清闸 e2e（2026-11-09）
 *
 * 暮雨拍板：「不过澄清问卷的规划草稿 / 阶段卡 / 施工单，锁状态、进不了队列」。
 * 本套只测闸本身（纯数据层），以及与写路径的接线：
 *   ① 没带卷 → 拒；
 *   ② 卷没答完（未答 / 跳过 / 反问）→ 拒，并点名是哪几题；
 *   ③ 卷没批准 / 全是否决作废 → 拒（“真草稿不存在零含糊”）；
 *   ④ 答完且批准 → 放行；
 *   ⑤ 项目对不上 → 拒（别拿 A 项目的答案当 B 项目的依据）；
 *   ⑥ 写路径真的在用它：plans.ts 调 gateForDeck，MCP 的 plan_draft 也调。
 *
 * 运行：node scripts/test/e2e-qn-gate.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('qn-gate-')
const DATA = path.join(TMP, 'data')
const QDIR = path.join(DATA, 'task-data', 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, path.join(DATA, 'task-data'), QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))
const gate = require(path.join(DIST, 'main', 'data', 'qnGate.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

function deck(name, lines) {
  fs.writeFileSync(path.join(QDIR, name + '.md'), lines.join('\n'), 'utf-8')
}

const Q1 = [
  '## G1 形状', '做一件还是两件？',
  '- **A. 甲**——代价甲', '- **B. 乙**——代价乙',
  '【验收线】出现反例即违约', '',
]
const Q2 = [
  '## G2 顺序', '先做哪件？',
  '- **A. 先甲**——代价甲', '- **B. 先乙**——代价乙',
  '【验收线】顺序颠倒即违约', '',
]

deck('没答', ['# 没答卷', ...Q1])
deck('跳过', ['# 跳过卷', ...Q1, ...Q2])
deck('反问', ['# 反问卷', ...Q1, ...Q2])
deck('草稿', ['# 草稿卷', ...Q1])
deck('答完', ['# 答完卷', ...Q1])
deck('全否', ['# 全否卷', ...Q1])
deck('别家', ['# 别家卷', '**项目**：fangcun-base', ...Q1])
deck('答完-司天', ['# 司天卷', '**项目**：sitian', ...Q1])

const now = new Date().toISOString()
// 跳过：一题打勾、一题跳过（跳过 = 下次还问）
store.writeAnswers('跳过', { answers: { G1: { kind: 'pick', k: 'A' }, G2: { kind: 'skip' } } })
store.approveDeck('跳过')
// 反问：一题打勾、一题反问（反问 = 这题问错了）
store.writeAnswers('反问', { answers: { G1: { kind: 'pick', k: 'A' }, G2: { kind: 'askback', text: '这题问错了' } } })
store.approveDeck('反问')
// 草稿：答了但没批准
store.writeAnswers('草稿', { answers: { G1: { kind: 'pick', k: 'A' } } })
// 全否：直接写 approvedAt 绕开“空卷不许批准”（模拟别处批准过的卷）
store.writeAnswers('全否', { answers: { G1: { kind: 'reject' } }, approvedAt: now })
store.writeAnswers('答完', { answers: { G1: { kind: 'pick', k: 'A' } } })
store.approveDeck('答完')
store.writeAnswers('答完-司天', { answers: { G1: { kind: 'pick', k: 'A' } } })
store.approveDeck('答完-司天')

console.log('== ① 没带卷 ==')
check('★★ 没带卷 → 拒（不是“默认放行”）',
  gate.gateForDeck('', 'fangcun-base').ok === false)
check('★ 错误话说清“必须附澄清问卷”',
  /澄清问卷/.test(gate.gateForDeck('', 'fangcun-base').error || ''))

console.log('== ② 没答完 / 跳过 / 反问 ==')
{
  const r = gate.gateForDeck('没答', 'x')
  check('★★ 整卷没答 → 拒，点名题号', !r.ok && r.open.length === 1 && r.open[0].id === 'G1', JSON.stringify(r))
  const s = gate.gateForDeck('跳过', 'x')
  check('★★ 跳过 = 没定（下次还问）→ 拒', !s.ok && /没定/.test(s.error || ''), s.error)
  const a = gate.gateForDeck('反问', 'x')
  check('★★ 反问 = 这题问错了 → 拒（先重出题）', !a.ok && /没定/.test(a.error || ''), a.error)
}

console.log('== ③ 没批准 / 全是否决作废 ==')
{
  const d = gate.gateForDeck('草稿', 'x')
  check('★★ 答案没批准 → 拒（草稿不算数）', !d.ok && /还没批准/.test(d.error || ''), d.error)
  const c = gate.gateForDeck('全否', 'x')
  check('★★ 全是否决/作废 = 等于没问 → 拒', !c.ok && c.allClosed === true, c.error)
}

console.log('== ④ 答完且批准 → 放行 ==')
{
  const r = gate.gateForDeck('答完', 'x')
  check('★★ 答完 + 批准 → 放行', r.ok === true, r.error)
  check('★ 回传卷名与题数（调用方要能记账）', r.deck === '答完' && r.total === 1, JSON.stringify(r))
}

console.log('== ⑤ 项目对不上 ==')
{
  const r = gate.gateForDeck('答完-司天', 'fangcun-base')
  check('★★ 拿 A 项目的卷当 B 项目的依据 → 拒', !r.ok && /属于/.test(r.error || ''), r.error)
  const ok = gate.gateForDeck('答完-司天', 'sitian')
  check('★ 同名项目放行', ok.ok === true, ok.error)
}

console.log('== ⑥ 写路径真的接了闸（源码守卫）==')
{
  const plans = fs.readFileSync(path.join(REPO, 'desktop/src/main/data/plans.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  check('★★ plans.ts 的 proposeStage 调 gateForDeck', /gateForDeck\s*\(/.test(plans))
  const tools = fs.readFileSync(path.join(REPO, 'desktop/src/main/mcp/tools.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  check('★★ plan_draft 调 gateForDeck（不是只靠界面）', /case 'plan_draft'[\s\S]*?gateForDeck\s*\(/.test(tools))
  check('★★ stage_plan_propose 把 deck 传下去', /deck:\s*args\.deck/.test(tools))
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
