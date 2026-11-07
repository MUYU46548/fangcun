#!/usr/bin/env node
/**
 * 问卷三条补丁 · 端到端（2026-11-07）
 *
 * 暮雨 11-05 认可的四条补充，这里守其中三条：
 *   ① **没写代价的选项不许进卷** —— 只点名不删项（删了他想选就选不到），出口是重出题补代价；
 *   ② **答案要能被反驳** —— 事后校验：仍成立 / 已被推翻（推翻必须给证据，并连带撤决策卡）；
 *   ③ **作废机制** —— 整卷作废 / 单题作废，作废必须写原因，且**不许悄悄复活**。
 *
 * 每条都配反例（断言只增不减 + 新增断言必须做反例，记忆纪律）。
 * 拿两份真问卷（司天宪法层 / 墨坊裁决层）跑，不手搓格式 —— 解析器是照它们写的。
 *
 * 运行：node scripts/test/e2e-questionnaire-lifecycle.cjs
 */
const fs = require('fs')
const { mkTmp } = require('./_tmp.cjs')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const STUB = path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
const TMP = mkTmp('fc-q-life-')
const DATA = path.join(TMP, 'data')
const QDIR = path.join(DATA, 'task-data', 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, path.join(DATA, 'task-data'), QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...rest)
}

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))
const decisions = require(path.join(DIST, 'main', 'data', 'decisions.js'))
const parser = require(path.join(DIST, 'shared', 'questionnaire.js'))
const prompts = require(path.join(DIST, 'shared', 'qnPrompts.js'))

// 两份真样本
const SAMPLE_A = path.join(REPO, 'references', '问卷样本', '问卷-司天-宪法层-20261104.md')
const SAMPLE_B = path.join(REPO, 'references', '问卷样本', '问卷-墨坊-裁决层A-20261104.md')
fs.writeFileSync(path.join(QDIR, '司天-宪法层.md'), fs.readFileSync(SAMPLE_A, 'utf-8'), 'utf-8')

// 一份"工整"的合成卷：选项全带代价、每题都有验收线 —— 用来做反例（不该报缺代价）
fs.writeFileSync(path.join(QDIR, '工整卷.md'), [
  '# 工整卷（合成，仅测试用）', '',
  '## Z1 形状',
  '做一件还是两件？',
  '- **A. 分两件**——各管一段，代价是要维护两个入口',
  '- **B. 单件**——上手快，代价是两件事挤在一个界面里',
  '【出处】测试夹具',
  '【验收线】出现跨形态派单就打回',
  '',
].join('\n'), 'utf-8')

// 一份"没验收线"的卷：校验时必须被拒（没有判据就没法校验）
fs.writeFileSync(path.join(QDIR, '无验收线.md'), [
  '# 无验收线卷（合成，仅测试用）', '',
  '## N1 随便问问',
  '一个问题？',
  '- **A. 选这个**——代价是甲',
  '- **B. 选那个**——代价是乙',
  '【出处】测试夹具',
  '',
].join('\n'), 'utf-8')

console.log('== ① 没写代价的选项（只点名、不删项）==')
{
  const d = parser.parseQuestionnaire(fs.readFileSync(SAMPLE_A, 'utf-8'))
  const gaps = parser.costGaps(d)
  const keys = gaps.map((g) => `${g.id}.${g.k}`)
  check('★★ 真样本里抓出缺代价的选项（不是空集 —— 空集上 every 恒真，必须非空才说明抓到）',
    gaps.length > 0, JSON.stringify(keys))
  check('★ 点名到具体题号+选项键（出卷人要知道补哪个，不能只报个数）',
    keys.includes('S3.B'), JSON.stringify(keys))
  check('★ 有代价的选项不被误报（反例）：S1.A 有说明 → 不在清单里',
    !keys.includes('S1.A'), JSON.stringify(keys))

  const tidy = parser.parseQuestionnaire(fs.readFileSync(path.join(QDIR, '工整卷.md'), 'utf-8'))
  check('★★ 反例：整卷都写了代价 → 清单为空', parser.costGaps(tidy).length === 0,
    JSON.stringify(parser.costGaps(tidy)))

  const l = store.listDecks()
  const briefA = l.decks.find((x) => x.deck === '司天-宪法层')
  const briefZ = l.decks.find((x) => x.deck === '工整卷')
  check('★ 列卷摘要带上缺代价数（界面黄条不用自己再解析一遍）',
    briefA && briefA.costGaps === gaps.length && briefZ && briefZ.costGaps === 0,
    JSON.stringify({ a: briefA && briefA.costGaps, z: briefZ && briefZ.costGaps }))

  check('★ 重出题提示词里点名缺代价（纯函数，与数据层同一口径）',
    (() => {
      const t = prompts.buildRewritePrompt({
        deck: 'x', title: 'x', questions: tidy.questions, answers: {},
      })
      return t === ''   // 工整卷既无反问也无缺代价 → 空串，不许编假提示词
    })())
}

console.log('\n== ② 作废（整卷 / 单题）==')
{
  // 先答两题并批准，制造"有决策卡"的现场
  store.writeAnswers('司天-宪法层', {
    answers: { S1: { kind: 'pick', k: 'A' }, S3: { kind: 'pick', k: 'B' } },
  })
  const ap = store.approveDeck('司天-宪法层')
  check('★ 前情：批准建出 2 张决策卡', ap.ok === true && ap.cards === 2, `cards=${ap.cards} err=${ap.error}`)
  const before = decisions.loadDecisions().filter((d) => d.出处.indexOf('问卷 司天-宪法层') === 0)
  check('★ 前情：决策卡按「问卷 <卷> · <题号>」可回查', before.length === 2, JSON.stringify(before.map((d) => d.出处)))

  const noReason = store.voidDeck('司天-宪法层', '  ')
  check('★★ 反例：作废不写原因 → 拒（三个月后没人知道为什么推翻）',
    noReason.ok === false && /原因/.test(noReason.error || ''), noReason.error)

  const v = store.voidDeck('司天-宪法层', '需求改成单件了，宪法层这一版作废')
  check('★ 整卷作废成功，并连带撤下决策卡', v.ok === true && v.revoked === 2, `revoked=${v.revoked} err=${v.error}`)
  const afterVoid = decisions.loadDecisions().filter((d) => d.出处.indexOf('问卷 司天-宪法层') === 0)
  check('★★ 作废后决策卡状态全变「已撤销」（否则界面说"作废"、决策卡还写"有效"）',
    afterVoid.length === 2 && afterVoid.every((d) => d.状态 === '已撤销'),
    JSON.stringify(afterVoid.map((d) => [d.出处, d.状态])))

  const gv = store.getDeck('司天-宪法层')
  check('★ 卷本身带上作废标记与原因', gv.voidedAt && /单件/.test(gv.voidReason || ''), `${gv.voidedAt} / ${gv.voidReason}`)

  const ap2 = store.approveDeck('司天-宪法层')
  check('★★ 反例：作废的卷不许再批准（要显式"恢复"才行，不许点一下批准就复活）',
    ap2.ok === false && /作废/.test(ap2.error || ''), ap2.error)

  // 存草稿不许把作废标记洗掉（"没传 ≠ 清空" —— 与 savePolicy 同一个坑）
  // ⚠ 这里只传 answers（不带 voidedAt）—— 正好验"没传 ≠ 清空"。
  //   但答案本身要传全，否则下一步"重新批准"会少一题（我第一版就漏了 S3，断言假红）
  store.writeAnswers('司天-宪法层', { answers: { S1: { kind: 'pick', k: 'A' }, S3: { kind: 'pick', k: 'B' } } })
  const gv2 = store.getDeck('司天-宪法层')
  check('★★ 存草稿不许洗掉作废标记（没传 ≠ 清空）', !!gv2.voidedAt, JSON.stringify({ voidedAt: gv2.voidedAt }))

  const re = store.reopenDeck('司天-宪法层')
  check('★ 恢复这卷后标记清空', re.ok === true && !store.getDeck('司天-宪法层').voidedAt)
  const stillRevoked = decisions.loadDecisions().filter((d) => d.出处.indexOf('问卷 司天-宪法层') === 0)
  check('★★ 恢复只是清标记 —— 决策卡不许自己悄悄复活（要重新批准）',
    stillRevoked.every((d) => d.状态 === '已撤销'), JSON.stringify(stillRevoked.map((d) => d.状态)))

  const ap3 = store.approveDeck('司天-宪法层')
  check('★ 重新批准 → 决策卡复活并计数（revived）', ap3.ok === true && ap3.revived === 2, `revived=${ap3.revived}`)
  check('★ 复活后决策卡回到「有效」',
    decisions.loadDecisions().filter((d) => d.出处.indexOf('问卷 司天-宪法层') === 0).every((d) => d.状态 === '有效'))

  // 单题作废
  const vs = store.voidAnswer('司天-宪法层', 'S3', '像素基线这条路不走了')
  check('★ 单题作废：写进答案并撤掉该题决策卡', vs.ok === true && vs.revoked === 1, `revoked=${vs.revoked} err=${vs.error}`)
  const gs3 = store.getDeck('司天-宪法层')
  check('★ 单题作废后该题为 void（不是"否决"—— 语义不同：曾经成立过）',
    gs3.answers.S3 && gs3.answers.S3.kind === 'void' && /基线/.test(gs3.answers.S3.text || ''),
    JSON.stringify(gs3.answers.S3))
  check('★★ 反例：作废不存在的题 → 明确报错（不静默成功）',
    store.voidAnswer('司天-宪法层', 'S99', '随便写').ok === false)
  const log = store.getDeck('司天-宪法层')
  const logText = store.buildDecisionLog(log.parsed, log.answers, '司天-宪法层', '2026-11-07')
  check('★ 导出里单题作废写「作废」并保留原因（历史不许被抹掉）',
    /~~作废~~/.test(logText) && /基线/.test(logText), logText.split('\n').filter((l) => l.indexOf('S3') >= 0).join(' | ').slice(0, 160))
}

console.log('\n== ③ 事后校验（答案要能被反驳）==')
{
  const noLine = store.auditAnswer('无验收线卷', 'N1', 'ok', '')
  check('★★ 反例：没有答案时不给校验', noLine.ok === false, noLine.error)

  store.writeAnswers('无验收线卷', { answers: { N1: { kind: 'pick', k: 'A' } } })
  const noLine2 = store.auditAnswer('无验收线卷', 'N1', 'ok', '')
  check('★★ 反例：没写验收线 → 不许校验（没有判据的"成立"是自欺）',
    noLine2.ok === false && /验收线/.test(noLine2.error || ''), noLine2.error)

  const noEv = store.auditAnswer('司天-宪法层', 'S1', 'refuted', '')
  check('★★ 反例：判「被推翻」不写证据 → 拒（只说"不成立了"跟没说一样）',
    noEv.ok === false && /证据/.test(noEv.error || ''), noEv.error)

  const ok1 = store.auditAnswer('司天-宪法层', 'S1', 'ok', '代码里两件仍然是分开的')
  check('★ 判「仍成立」成功', ok1.ok === true, ok1.error)
  const g1 = store.getDeck('司天-宪法层')
  check('★ 校验结论落盘（可按题取）', g1.audits && g1.audits.S1 && g1.audits.S1.verdict === 'ok',
    JSON.stringify(g1.audits && g1.audits.S1))

  const ref = store.auditAnswer('司天-宪法层', 'S1', 'refuted', '实际上只有一个入口，第二件从来没建')
  check('★★ 判「被推翻」连带撤决策卡（导出写推翻、决策卡写有效 = 两张表互相打脸）',
    ref.ok === true && ref.revoked === 1, JSON.stringify(ref))
  const dS1 = decisions.loadDecisions().find((d) => d.出处 === '问卷 司天-宪法层 · S1')
  check('★ 被推翻后决策卡状态 = 已撤销', !!dS1 && dS1.状态 === '已撤销', dS1 && dS1.状态)

  const g2 = store.getDeck('司天-宪法层')
  const text2 = store.buildDecisionLog(g2.parsed, g2.answers, '司天-宪法层', '2026-11-07', { audits: g2.audits })
  check('★ 导出里出现「已被推翻」段落（拿这份 md 给 agent 时它知道别再用这条）',
    /已被推翻/.test(text2) && /已被推翻的答案/.test(text2),
    text2.split('\n').filter((l) => l.indexOf('推翻') >= 0).join(' | ').slice(0, 160))

  // 校验队列
  const q = store.auditQueue(Date.now())
  const rows = q.rows
  check('★ 校验队列非空（空集上 every 恒真，先断言非空）', rows.length > 0, `rows=${rows.length}`)
  check('★★ 队列只收「有答案 + 有验收线」：无验收线卷整卷不进队列',
    rows.every((r) => r.deck !== '无验收线卷'), JSON.stringify([...new Set(rows.map((r) => r.deck))]))
  check('★ 队列里带着验收线（判据要跟着走，不能只给题号）',
    rows.every((r) => !!r.line), JSON.stringify(rows.slice(0, 2).map((r) => r.line)))
  check('★ 已判「被推翻」的排在队首（要先处理）', rows[0].refuted === true, JSON.stringify(rows[0]))

  // 作废的卷不进队列 —— 拿墨坊那份做现场（放进去、答、批准、作废）
  fs.writeFileSync(path.join(QDIR, '墨坊-裁决层.md'), fs.readFileSync(SAMPLE_B, 'utf-8'), 'utf-8')
  const dp = parser.parseQuestionnaire(fs.readFileSync(SAMPLE_B, 'utf-8'))
  const firstId = dp.questions[0].id
  store.writeAnswers('墨坊-裁决层', { answers: { [firstId]: { kind: 'pick', k: (dp.questions[0].options[0] || { k: 'A' }).k } } })
  store.approveDeck('墨坊-裁决层')
  const qBefore = store.auditQueue(Date.now()).rows.some((r) => r.deck === '墨坊-裁决层')
  store.voidDeck('墨坊-裁决层', '这卷的前提没了，整卷作废')
  const qAfter = store.auditQueue(Date.now()).rows.some((r) => r.deck === '墨坊-裁决层')
  check('★★ 作废的卷不进校验队列（否则天天提醒你去验一堆不作数的答案）',
    qBefore === true && qAfter === false, JSON.stringify({ qBefore, qAfter }))
}

console.log('')
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  · ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
