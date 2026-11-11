#!/usr/bin/env node
/**
 * 进队列锁 e2e（2026-11-11 · 卡《进队列锁只落了一半》）
 *
 * 规格单 §3.1 的**第二个时点**：卡 / 阶段「可派」前必须查澄清卷。
 * 出厂闸（plan_draft / stage_plan_propose 必带 deck）此前已落；本套钉的是：
 *   ① 声明了澄清卷的卡 → 卷没过闸就**改不成「待办」**（moveStatus / updateTask / createTask 同一道闸）；
 *   ② 拒的时候**一个字节都不写**（不是先写再回滚）；
 *   ③ 没声明 `澄清` 的普通卡 → 不拦（过渡口径，理由见 qnQueueGate.ts）；
 *   ④ 阶段卡：提案必写 `- 澄清:`；通过（= 冻结 = 可派）时再查一次 —— 卷在提案后作废要当场拦；
 *   ⑤ 认卷三种写法同一入口（frontmatter 中/英 + 正文小节 / 行内）——
 *      问卷落卡写的是**没有冒号**的 `## 澄清问卷` + 下一行，界面此前认不出（真 bug）。
 *
 * 运行：node scripts/test/e2e-qn-queue.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('qn-queue-')
const DATA = path.join(TMP, 'data')
const TASK_DIR = path.join(DATA, 'task-data')
const QDIR = path.join(TASK_DIR, 'questionnaires')
const PDIR = path.join(TASK_DIR, 'plans')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, TASK_DIR, QDIR, PDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'),
  'projects:\n  - id: fangcun-base\n    name: 方寸\n    repo: .\n', 'utf-8')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const tasks = require(path.join(DIST, 'main', 'data', 'tasks.js'))
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))
const plans = require(path.join(DIST, 'main', 'data', 'plans.js'))
const { clarifyOf } = require(path.join(DIST, 'shared', 'clarify.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}
const taskFiles = () => fs.readdirSync(TASK_DIR).filter((f) => f.endsWith('.md')).length
const bytesOf = (p) => fs.readFileSync(p)
const eq = (a, b) => Buffer.compare(a, b) === 0

// ── 卷 ────────────────────────────────────────────────────────────────
const Q1 = [
  '## G1 形状', '做一件还是两件？',
  '- **A. 甲**——代价甲', '- **B. 乙**——代价乙',
  '【验收线】出现反例即违约', '',
]
function deck(name, lines) {
  fs.writeFileSync(path.join(QDIR, name + '.md'), lines.join('\n'), 'utf-8')
}
deck('未批', ['# 未批卷', ...Q1])                 // 有未答题
deck('已批准', ['# 已批准卷', ...Q1])             // 答完 + 批准
deck('全否', ['# 全否卷', ...Q1])                 // 全是否决（等于没问）
store.writeAnswers('已批准', { answers: { G1: { kind: 'pick', k: 'A' } } })
store.approveDeck('已批准')
store.writeAnswers('全否', { answers: { G1: { kind: 'reject' } }, approvedAt: new Date().toISOString() })

console.log('== ① 认卷：三种写法同一入口 ==')
{
  check('★★ frontmatter 英文键 clarify', clarifyOf({ fm: { clarify: '卷A' } }) === '卷A')
  check('★ frontmatter 中文键 澄清', clarifyOf({ fm: { '澄清': '卷B' } }) === '卷B')
  check('★★ 正文小节形态（问卷落卡写的，没有冒号）',
    clarifyOf({ body: '## 验收线\n文字\n\n## 澄清问卷\n方寸-某卷（已批准）\n' }) === '方寸-某卷',
    JSON.stringify(clarifyOf({ body: '## 澄清问卷\n方寸-某卷（已批准）\n' })))
  check('★★ 行内形态（必须带冒号，标题不被误认）',
    clarifyOf({ body: '说明\n澄清问卷：另一卷\n' }) === '另一卷')
  check('★ 没有卷 → 空串（不是「缺卷」这种假值）', clarifyOf({ fm: {}, body: '普通正文' }) === '')
}

console.log('== ② 普通卡（没声明卷）照常进队列 ==')
{
  const t = tasks.createTask({ title: '买个键盘', status: '草稿' })
  const moved = tasks.moveStatus(t.id, '待办')
  check('★★ 没声明澄清卷 → 不拦（过渡口径）', !!moved && moved.fm.status === '待办')
}

console.log('== ③ 声明了卷但没过闸 → 改不成待办，且文件不变 ==')
{
  const t = tasks.createTask({ title: '未批卷的卡', status: '草稿', clarify: '未批' })
  const f = path.join(TASK_DIR, t.id + '.md')
  const before = bytesOf(f)
  let err = ''
  try { tasks.moveStatus(t.id, '待办') } catch (e) { err = String(e.message || e) }
  check('★★ 改待办被拒（抛错，不是静默放行）', /进队列被拦/.test(err), err)
  check('★★ 拒因点名卷名', /未批/.test(err), err)
  check('★★ 拒的时候一个字节都没写', eq(before, bytesOf(f)))
  check('★ 状态仍是草稿', String(tasks.readTask(t.id).fm.status) === '草稿')

  let err2 = ''
  try { tasks.updateTask(t.id, { status: '待办' }) } catch (e) { err2 = String(e.message || e) }
  check('★★ 同一条闸也管 updateTask（不是只在 moveStatus）', /进队列被拦/.test(err2), err2)
  check('★★ updateTask 拒后也不写盘', eq(before, bytesOf(f)))

  const okField = tasks.updateTask(t.id, { priority: '高' })
  check('★ 改非状态字段不受影响', !!okField && String(okField.fm.priority) === '高')
}

console.log('== ④ 新建即待办也过闸（没有后门）==')
{
  const n0 = taskFiles()
  let err = ''
  try { tasks.createTask({ title: '直接建待办', status: '待办', clarify: '全否' }) } catch (e) { err = String(e.message || e) }
  check('★★ createTask(status=待办) 卷不过 → 拒', /进队列被拦/.test(err), err)
  check('★★ 拒的时候没有半张卡落盘', taskFiles() === n0)

  let err2 = ''
  let tc = null
  try {
    tc = tasks.createTask({ title: '正文带卷标记', status: '草稿', body: '## 澄清问卷\n未批（已批准）\n' })
  } catch (e) { err2 = String(e.message || e) }
  check('★ 正文标记的卡建草稿不拦（只在进队列时判）', err2 === '', err2)
  let err3 = ''
  try { tasks.moveStatus(tc.id, '待办') } catch (e) { err3 = String(e.message || e) }
  check('★★ 正文里的卷也认（问卷落的卡改不了待办）', /进队列被拦/.test(err3), err3)
}

console.log('== ⑤ 卷过了 → 放行，并把卷名写进文件 ==')
{
  const t = tasks.createTask({ title: '已批准的卡', status: '草稿', clarify: '已批准' })
  const moved = tasks.moveStatus(t.id, '待办')
  check('★★ 卷已批准且无待答 → 放行', !!moved && moved.fm.status === '待办')
  const raw = fs.readFileSync(path.join(TASK_DIR, t.id + '.md'), 'utf-8')
  check('★★ 澄清卷落进 frontmatter（中文键，Python 侧也认）', /^澄清: 已批准$/m.test(raw), raw.slice(0, 300))
  check('★ 状态写进文件', /^状态: 待办$/m.test(raw))
}

console.log('== ⑤b 题目级澄清：`<卷>#<题号>` ==')
{
  // 两题只答一题就批准（产品里允许：approveDeck 只拦“一道都没答”）
  const Q2 = ['## G2 顺序', '先做哪件？', '- **A. 先甲**——代价甲', '- **B. 先乙**——代价乙', '【验收线】顺序颠倒即违约', '']
  deck('部分答', ['# 部分答卷', ...Q1, ...Q2])
  store.writeAnswers('部分答', { answers: { G1: { kind: 'pick', k: 'A' } }, approvedAt: new Date().toISOString() })

  const t1 = tasks.createTask({ title: '只押 G1 的卡', status: '草稿', project: 'fangcun-base', clarify: '部分答#G1' })
  const m1 = tasks.moveStatus(t1.id, '待办')
  check('★★ 题目级澄清：那一题答了 → 放行（整卷还有别的题没答也不拦）', !!m1 && m1.fm.status === '待办')

  const t2 = tasks.createTask({ title: '押未答的 G2', status: '草稿', clarify: '部分答#G2' })
  let err2 = ''
  try { tasks.moveStatus(t2.id, '待办') } catch (e) { err2 = String(e.message || e) }
  check('★★ 题目级澄清：那一题没答 → 拒，并点名是哪一题', /进队列被拦/.test(err2) && /G2/.test(err2), err2)

  const t3 = tasks.createTask({ title: '整卷押（不带题号）', status: '草稿', clarify: '部分答' })
  let err3 = ''
  try { tasks.moveStatus(t3.id, '待办') } catch (e) { err3 = String(e.message || e) }
  check('★★ 不带题号 = 整卷押：还有题没答 → 拒（两种澄清不是一回事）', /进队列被拦/.test(err3), err3)

  const t4 = tasks.createTask({ title: '押不存在的题', status: '草稿', clarify: '部分答#G9' })
  let err4 = ''
  try { tasks.moveStatus(t4.id, '待办') } catch (e) { err4 = String(e.message || e) }
  check('★ 题号对不上 → 拒（不当作整卷放行）', /没有题 G9/.test(err4), err4)
}

console.log('== ⑥ 阶段卡：提案写澄清卷，通过时再查 ==')
{
  const planFile = 'fangcun-base.md'
  fs.writeFileSync(path.join(PDIR, planFile), [
    '# 作战计划 · 方寸', '', '## 阶段卡', '',
    '### P1 旧阶段', '- 状态: 待裁决', '- 技术方案:', '  - 旧做法',
    '- 照抄点:', '| 项 | 来源 | 原文 |', '|---|---|---|', '| a | b | c |',
    '- 判据:', '  - str: 旧判据', '',
    '## 修订记录', '- 2026-11-01 · 初始', '',
  ].join('\n'), 'utf-8')
  deck('阶段卷', ['# 阶段卷', '**项目**：fangcun-base', ...Q1])
  store.writeAnswers('阶段卷', { answers: { G1: { kind: 'pick', k: 'A' } } })
  store.approveDeck('阶段卷')

  const r = plans.proposeStage({
    file: planFile, stageId: 'P2', title: '新阶段',
    approach: ['做一件事'],
    copyRows: [['项', '来源', '原文'], ['a', 'b', 'c']],
    criteria: ['str: 有结果'],
    deck: '阶段卷', agent: 'test',
  })
  check('★ 带卷提案 → 落盘', r.ok === true, r.error)
  const raw = fs.readFileSync(path.join(PDIR, planFile), 'utf-8')
  check('★★ 阶段块写了 `- 澄清: <卷>`', /### P2 新阶段\n- 状态: 待裁决\n- 澄清: 阶段卷/.test(raw), raw.match(/### P2[\s\S]{0,80}/))
  check('★ 阶段解析读得到澄清卷', (r.stage && r.stage.clarify) === '阶段卷', JSON.stringify(r.stage && r.stage.clarify))

  const pass1 = plans.writePlanVerdict({ file: planFile, stageId: 'P2', action: 'pass' })
  check('★★ 卷仍有效 → 通过（冻结）', pass1.ok === true, pass1.error)

  // 时间差：提案之后把这卷的答案全作废（= 等于没问）
  store.writeAnswers('阶段卷', { answers: { G1: { kind: 'void', text: '需求变了' } } })
  const r2 = plans.proposeStage({
    file: planFile, stageId: 'P3', title: '第三阶段',
    approach: ['再做一件事'], copyRows: [['项', '来源', '原文'], ['a', 'b', 'c']],
    criteria: ['str: 有结果'], deck: '阶段卷',
  })
  check('★ 卷作废后出厂闸就拒（提案零写入）', r2.ok === false && /没定|全|作废|等于没问/.test(r2.error || ''), r2.error)

  // 老阶段块（没有 `- 澄清`）不拦：存量计划不该被一刀锁死
  const p1 = plans.writePlanVerdict({ file: planFile, stageId: 'P1', action: 'pass' })
  check('★★ 老阶段块没有澄清行 → 不拦（过渡口径）', p1.ok === true, p1.error)
}

console.log('== ⑦ 写路径汇合点（源码守卫）==')
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const t = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/data/tasks.ts'), 'utf-8'))
  check('★★ moveStatus / updateTask / createTask 走同一个 assertQueueGate',
    (t.match(/assertQueueGate\(/g) || []).length >= 4, String((t.match(/assertQueueGate\(/g) || []).length))
  check('★★ 闸函数本身来自 qnQueueGate（不是界面各写一遍）', /queueGateForTask/.test(t))
  const p = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/data/plans.ts'), 'utf-8'))
  check('★★ 阶段通过时查闸', /action === 'pass'[\s\S]{0,400}queueGateForStage\(/.test(p))
  check('★★ 提案把卷名写进块里', /- 澄清: \$\{/.test(p))
  const tools = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/mcp/tools.ts'), 'utf-8'))
  check('★★ MCP move_status 把闸的错原样回给 agent', /case 'move_status'[\s\S]{0,900}catch \(e/.test(tools))
  const app = strip(fs.readFileSync(path.join(REPO, 'desktop/src/renderer/App.vue'), 'utf-8'))
  check('★★ 界面认卷走 shared/clarify（不再自己写正则）', /clarifyOf\(\{/.test(app))
  const idx = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/data/index.ts'), 'utf-8'))
  check('★★ 澄清字段进 FIELD_MAP + FM_ORDER（否则写回丢卷名）',
    /'澄清': 'clarify'/.test(idx) && /'attribution', 'clarify'/.test(idx))
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
