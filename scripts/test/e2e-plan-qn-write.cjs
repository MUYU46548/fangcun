#!/usr/bin/env node
/**
 * 写口回归：作战计划「新增阶段」+ 问卷「出卷」（2026-11-08）
 *
 * 这两条是暮雨 11-08 反馈里最硬的两个功能缺口：
 *   · “作战计划能折叠了，然后呢？**怎么让 AI 写入新的**？” —— 此前 `stage_plan_get` 只读，
 *     agent 手里根本没有写入口；
 *   · “**方寸依然不会主动发问卷**，怎么让 AI 出问卷？” —— 问卷一直是 agent 写的，
 *     但 agent 没通道、也没人告诉它格式。
 *
 * 所以本套验的不是“能写进去”，而是**写进去的东西必须可裁决、且不许毁掉已存在的内容**：
 *   ① 缺块（技术方案 / 照抄点 / 判据）的提议**一个字节都不写** —— 落进去也永远冻结不了；
 *   ② 判据没有 cmd:/str:/num:/file: 前缀 → 拒（闸门恒 unknown，等于永久卡死）；
 *   ③ 已有阶段逐字节不变、修订记录多一行、新卡排在 `## 除外责任` 之前；
 *   ④ 问卷：选项缺代价 / 题目缺验收线 → 零写入；同名卷不覆盖；写回能解析回同样题数。
 *
 * 跑法：node scripts/test/e2e-plan-qn-write.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const TMP = mkTmp('plan-qn-')
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, path.join(DATA, 'task-data'), path.join(DATA, 'task-data', 'plans'), USERDATA]) {
  fs.mkdirSync(d, { recursive: true })
}

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)
const plans = require(path.join(DIST, 'data', 'plans.js'))
const qn = require(path.join(DIST, 'data', 'questionnaires.js'))
const qnSpec = require(path.join(REPO, 'desktop', 'dist', 'shared', 'qnDeckSpec.js'))
const { parseQuestionnaire } = require(path.join(REPO, 'desktop', 'dist', 'shared', 'questionnaire.js'))

// 2026-11-09 硬闸夹具：一张答完并批准的澄清卷。没有它，proposeStage 一律拒写。
// 不写 `**项目**`，让闸的项目检查对 fixture / minimal 两个计划文件都放行；
// 项目不匹配的反例在 e2e-qn-gate.cjs 里单独测。
const QDIR = path.join(DATA, 'task-data', 'questionnaires')
fs.mkdirSync(QDIR, { recursive: true })
fs.writeFileSync(path.join(QDIR, '闸卷.md'), [
  '# 闸卷（夹具）', '',
  '## G1 形状', '夹具闸卷：形状选哪种？',
  '- **A. 甲**——代价甲', '- **B. 乙**——代价乙',
  '【验收线】出现反例即违约', '',
].join('\n'), 'utf-8')
qn.writeAnswers('闸卷', { answers: { G1: { kind: 'pick', k: 'A' } } })
qn.approveDeck('闸卷')

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

const PLAN = 'fixture.md'
const PLAN_PATH = path.join(DATA, 'task-data', 'plans', PLAN)
const FIXTURE = [
  '# 夹具计划',
  '',
  '## 阶段卡',
  '',
  '### P0 起手',
  '- 状态: 完成',
  '- 做什么: 起手那一格',
  '- 技术方案:',
  '  - 手写，不靠工具',
  '- 照抄点:',
  '| 项 | 来源 | 原文 |',
  '| --- | --- | --- |',
  '| 起手 | 旧项目 | 照抄一段 |',
  '- 判据:',
  '  - cmd: python verify.py',
  '  - str: 手写占位不许自动丢',
  '',
  '### P1 第二步',
  '- 状态: 待裁决',
  '- 技术方案:',
  '  - 第二步怎么做',
  '- 照抄点:',
  '| 项 | 来源 | 原文 |',
  '| --- | --- | --- |',
  '| 二 | 二来源 | 二原文 |',
  '- 判据:',
  '  - num: 通过数 >= 3',
  '',
  '## 修订记录',
  '',
  '- 2026-11-01 · 建卡',
  '',
  '## 除外责任',
  '',
  '- 不做别人的计划铺设',
  '',
].join('\n')
fs.writeFileSync(PLAN_PATH, FIXTURE, 'utf-8')

function slice(fileText, from, to) {
  const i = fileText.indexOf(from)
  const j = to ? fileText.indexOf(to) : fileText.length
  return i < 0 ? '' : fileText.slice(i, j < 0 ? fileText.length : j)
}

;(() => {
  console.log('---- 1. 缺块 / 无前缀 / 重复 id：一律拒且不写盘 ----')
  const before = fs.readFileSync(PLAN_PATH, 'utf-8')
  const noApproach = plans.proposeStage({
    file: PLAN, title: '空方案', approach: [], copyRows: [['a', 'b', 'c']], criteria: ['cmd: x'],
  })
  check('缺技术方案 → 拒', !noApproach.ok && /技术方案/.test(noApproach.error || ''), noApproach.error)
  const noCopy = plans.proposeStage({
    file: PLAN, title: '没照抄点', approach: ['怎么做'], copyRows: [], criteria: ['cmd: x'],
  })
  check('缺照抄点 → 拒', !noCopy.ok && /照抄点/.test(noCopy.error || ''), noCopy.error)
  const noCrit = plans.proposeStage({
    file: PLAN, title: '没判据', approach: ['怎么做'], copyRows: [['a', 'b', 'c']], criteria: [],
  })
  check('缺判据 → 拒', !noCrit.ok && /判据/.test(noCrit.error || ''), noCrit.error)
  const badPrefix = plans.proposeStage({
    file: PLAN, title: '判据无前缀', approach: ['怎么做'], copyRows: [['a', 'b', 'c']], criteria: ['做了就算过'],
  })
  check('判据没有前缀 → 拒（否则闸门恒 unknown）', !badPrefix.ok && /前缀/.test(badPrefix.error || ''), badPrefix.error)
  const dup = plans.proposeStage({
    file: PLAN, stageId: 'P0', title: '撞号', approach: ['x'], copyRows: [['a', 'b', 'c']], criteria: ['cmd: y'],
  })
  check('阶段号已存在 → 拒', !dup.ok && /已存在/.test(dup.error || ''), dup.error)
  check('四次拒收后文件逐字节未变', fs.readFileSync(PLAN_PATH, 'utf-8') === before)

  console.log('---- 2. 正常提议：落待裁决，已有内容一字不动 ----')
  const beforeGate = fs.readFileSync(PLAN_PATH, 'utf-8')
  const noDeck = plans.proposeStage({
    file: PLAN, title: '没附卷', approach: ['x'], copyRows: [['a', 'b', 'c']], criteria: ['cmd: y'],
  })
  check('★★ 没附澄清问卷 → 拒（2026-11-09 硬锁）', !noDeck.ok && /澄清问卷/.test(noDeck.error || ''), noDeck.error)
  check('★★ 拒后文件逐字节未变', fs.readFileSync(PLAN_PATH, 'utf-8') === beforeGate)

  const r = plans.proposeStage({
    file: PLAN,
    deck: '闸卷',
    title: '第三格：结构地图写口',
    what: '让 agent 提议、用户签字',
    approach: ['先落 待裁决 卡', '冻结仍由用户点'],
    copyRows: [['结构地图', 'policies/rosa-rag.md', '提议 → 签字 → 落地']],
    criteria: ['cmd: node scripts/test/e2e-plan-qn-write.cjs', 'str: 缺块不许通过'],
    agent: 'hermes',
  })
  check('提议成功', !!r.ok, r.error)
  check('自动编号取下一个空号 = P2', r.stage && r.stage.id === 'P2', r.stage && r.stage.id)
  check('落进来的状态是「待裁决」（不是完成）', r.stage && String(r.stage.status).trim() === '待裁决', r.stage && r.stage.status)
  check('三块都被解析出来了（技术方案/照抄点/判据）', !!r.stage && r.stage.missing.length === 0, r.stage && JSON.stringify(r.stage.missing))
  const after = fs.readFileSync(PLAN_PATH, 'utf-8')
  const p0Before = slice(before, '### P0 起手', '### P1 第二步')
  const p0After = slice(after, '### P0 起手', '### P1 第二步')
  check('已有 P0 段逐字节未变', p0Before === p0After)
  const p1Before = slice(before, '### P1 第二步', '## 修订记录')
  const p1After = slice(after, '### P1 第二步', '### P2')
  check('已有 P1 段逐字节未变', p1Before === p1After, JSON.stringify({ a: p1Before.slice(-40), b: p1After.slice(-40) }))
  check('新阶段排在「## 除外责任」之前（没被塞到文末）',
    after.indexOf('### P2') > 0 && after.indexOf('### P2') < after.indexOf('## 除外责任'))
  check('修订记录多了一行', /P2 新增待裁决（hermes 提议）/.test(after))
  check('读回来是 3 格', (plans.readPlan(PLAN) || { stages: [] }).stages.length === 3)
  check('提议人落进了卡面', /- 提议人: hermes/.test(after))

  console.log('---- 3. 没有「## 阶段卡」小节的文件也能写（接在文末） ----')
  const bare = 'minimal.md'
  fs.writeFileSync(path.join(DATA, 'task-data', 'plans', bare), '# 裸计划\n\n随便一段。\n', 'utf-8')
  const rb = plans.proposeStage({
    file: bare, deck: '闸卷', title: '裸文件新增', approach: ['x'], copyRows: [['a', 'b', 'c']], criteria: ['file: a.md'],
  })
  check('无 阶段卡 小节也能提议', !!rb.ok, rb.error)
  check('落在文末且能读回', rb.ok && (plans.readPlan(bare) || { stages: [] }).stages.length === 1)

  console.log('---- 4. 问卷：规格机检 ----')
  const good = {
    title: '夹具问卷·裁决层A',
    project: 'has-card',
    questions: [{
      id: 'S1', nav: '最终形态', ask: '做一件还是两件？',
      options: [
        { k: 'A', t: '分两件', d: '抄业界主流；代价是联调成本翻倍' },
        { k: 'B', t: '合一件', d: '上手快；代价是后期拆不动' },
      ],
      src: '四问总表§一', line: '跨形态派单的任务卡一律打回',
    }],
  }
  check('合格规格无问题', qnSpec.validateDeckSpec(good).length === 0, JSON.stringify(qnSpec.validateDeckSpec(good)))
  const noCost = JSON.parse(JSON.stringify(good))
  noCost.questions[0].options[0].d = ''
  check('选项缺代价 → 报出来', qnSpec.validateDeckSpec(noCost).some((i) => /代价/.test(i.msg)))
  const noLine = JSON.parse(JSON.stringify(good))
  noLine.questions[0].line = ''
  check('题目缺验收线 → 报出来', qnSpec.validateDeckSpec(noLine).some((i) => /验收线/.test(i.msg)))
  const oneOpt = JSON.parse(JSON.stringify(good))
  oneOpt.questions[0].options = [oneOpt.questions[0].options[0]]
  check('只有 1 个选项 → 报出来', qnSpec.validateDeckSpec(oneOpt).some((i) => /至少 2 个/.test(i.msg)))
  const badId = JSON.parse(JSON.stringify(good))
  badId.questions[0].id = '第1题'
  check('题号不是字母+数字 → 报出来', qnSpec.validateDeckSpec(badId).some((i) => /题号/.test(i.msg)))
  const md = qnSpec.buildDeckMarkdown(good)
  const parsed = parseQuestionnaire(md)
  check('生成的 md 能被解析器读回 1 题', parsed.questions.length === 1, parsed.error)
  check('读回的选项带代价', (parsed.questions[0].options[0].d || '').includes('代价'))
  check('读回的验收线在', (parsed.questions[0].line || '').includes('一律打回'))

  console.log('---- 5. 问卷落盘：不合格零写入 / 不覆盖同名 ----')
  const qdir = path.join(DATA, 'task-data', 'questionnaires')
  const bad = qn.createDeck({ spec: noCost })
  check('不合格规格 → 拒', !bad.ok && Array.isArray(bad.issues) && bad.issues.length > 0, bad.error)
  check('不合格规格一个文件都没写（没长出“夹具问卷”的任何文件）',
    !fs.existsSync(qdir) || fs.readdirSync(qdir).every((f) => !f.startsWith('夹具问卷')))
  const c1 = qn.createDeck({ spec: good })
  check('合格规格写盘成功', !!c1.ok, c1.error)
  check('写盘后读回题数一致', c1.ok && c1.questions === 1)
  check('文件真的在', c1.ok && fs.existsSync(c1.path))
  const bytes1 = fs.readFileSync(c1.path, 'utf-8')
  const c2 = qn.createDeck({ spec: good })
  check('同名卷不许覆盖', !c2.ok && /已存在/.test(c2.error || ''), c2.error)
  check('拒覆盖后文件逐字节未变', fs.readFileSync(c1.path, 'utf-8') === bytes1)
  const listed = qn.listDecks()
  check('列卷里能看见它', listed.decks.some((d) => d.deck === c1.deck), JSON.stringify(listed.decks.map((d) => d.deck)))
  check('出卷提示词包含 qn_propose 与两条硬要求', (() => {
    const p = require(path.join(REPO, 'desktop', 'dist', 'shared', 'qnPrompts.js')).buildDeckAuthoringPrompt()
    return /qn_propose/.test(p) && /代价/.test(p) && /验收线/.test(p)
  })())

  console.log('')
  console.log(`通过 ${PASS} / 失败 ${FAILS.length}`)
  if (FAILS.length) { console.log('失败项：'); FAILS.forEach((f) => console.log(' - ' + f)); process.exit(1) }
  console.log(`RESULT ${PASS} / 0`)
})()
