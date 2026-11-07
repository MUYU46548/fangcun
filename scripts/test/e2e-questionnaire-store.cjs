#!/usr/bin/env node
/**
 * 问卷数据层 · 端到端（2026-11-05）
 *
 * 走真实链路：临时数据根 → 放一份**真问卷**（司天宪法层原文件）→
 * 列卷 / 打开 / 存草稿 / 批准 → 检查决策卡与导出文件。
 *
 * 判据里最要紧的两条：
 *  ① **批准才落库**：没批准时决策卡一条都不许多；
 *  ② **不写别人的仓库**：全部产物只能落在 `task-data/questionnaires/` 与 `task-data/decisions.md`，
 *     不许出现往项目 repo 写的路径（契约：对项目 repo 只读）。
 *
 * 运行：node scripts/test/e2e-questionnaire-store.cjs
 */
const fs = require('fs')
const { mkTmp, mkTmpPath } = require('./_tmp.cjs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const STUB = path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
const TMP = mkTmp('fc-q-store-')
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, path.join(DATA, 'task-data'), path.join(DATA, 'task-data', 'questionnaires'), USERDATA]) {
  fs.mkdirSync(d, { recursive: true })
}

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

// 放一份真问卷（司天宪法层，7 题）
const SAMPLE = path.join(REPO, 'references', '问卷样本', '问卷-司天-宪法层-20261104.md')
const src = fs.readFileSync(SAMPLE, 'utf-8')
fs.writeFileSync(path.join(DATA, 'task-data', 'questionnaires', '司天-宪法层.md'), src, 'utf-8')

console.log('== ① 列卷 / 打开 ==')
const l1 = store.listDecks()
check('列出一卷', l1.decks.length === 1, JSON.stringify(l1.decks.map((d) => d.deck)))
const brief = l1.decks[0]
check('★ 卷名 / 层 / 题数都对（7 题）',
  brief.deck === '司天-宪法层' && brief.layer === '宪法层' && brief.total === 7,
  JSON.stringify({ deck: brief.deck, layer: brief.layer, total: brief.total }))
check('★ 还没答、也没批准', brief.answered === 0 && brief.approved === false, JSON.stringify(brief))
check('★ 解析没有报错（选项写法对得上）', !brief.error, brief.error)

const g = store.getDeck('司天-宪法层')
check('打开能拿到题与题干', g.ok && g.parsed.questions.length === 7 && g.parsed.questions[0].ask.indexOf('一件还是两件') >= 0)
check('草稿初始为空', g.ok && Object.keys(g.answers || {}).length === 0)
check('★ 找不到的卷 → 明确报错并指出该放哪', (() => {
  const bad = store.getDeck('根本不存在的卷')
  return bad.ok === false && /questionnaires/.test(bad.error || '')
})(), store.getDeck('根本不存在的卷').error)

console.log('\n== ② 存草稿（没批准不许落库）==')
const cardsBefore = decisions.loadDecisions().length
store.writeAnswers('司天-宪法层', {
  answers: {
    S1: { kind: 'pick', k: 'A' },
    S2: { kind: 'skip' },
    S3: { kind: 'askback', text: '这题问错了：真正该问的是“地图最终给谁看”' },
    S5: { kind: 'pick', k: 'A' },
  },
})
const l2 = store.listDecks()
check('★ 存完草稿，列表里答了 5 题（S1/S2/S3/S5 + S5 预填同题不重复）',
  l2.decks[0].answered === 4, String(l2.decks[0].answered))
check('★★ 只是存草稿 → 决策卡一条都不许多', decisions.loadDecisions().length === cardsBefore,
  cardsBefore + ' → ' + decisions.loadDecisions().length)
check('★ 草稿写进了 .answers.json（关掉弹窗不丢）',
  fs.existsSync(path.join(DATA, 'task-data', 'questionnaires', '司天-宪法层.answers.json')))

console.log('\n== ③ 批准 ==')
const ap = store.approveDeck('司天-宪法层')
check('批准成功', ap.ok === true, ap.error)
check('★★ 决策卡按“打勾/改一句”的条数建出来（S1 + S5 = 2 张；跳过与反问不落决策）',
  ap.cards === 2, 'cards=' + ap.cards + ' existed=' + ap.existed)
const decisionsNow = decisions.loadDecisions()
check('★★ 反问**没有**变成决策卡（它是问题，不是决定）',
  !decisionsNow.some((d) => /这题问错了/.test(d.内容)), decisionsNow.map((d) => d.内容).join(' | ').slice(0, 120))
check('★ 决策卡的出处指回问卷题号（三个月后能查是怎么来的）',
  decisionsNow.some((d) => /问卷 司天-宪法层 · S1/.test(d.出处)),
  decisionsNow.map((d) => d.出处).join(' | '))
check('★ 导出的 decision-log 段落生成出来了',
  !!ap.exportPath && fs.existsSync(ap.exportPath), String(ap.exportPath))
const exp = fs.readFileSync(ap.exportPath, 'utf-8')
check('★★ 导出内容含逐题 + 反问段（贴进项目就能用）',
  /- \*\*S1\*\* —— A\./.test(exp) && /## 反问/.test(exp) && /地图最终给谁看/.test(exp),
  exp.slice(0, 100).replace(/\n/g, ' / '))
check('★ 批准时间记下来了（列表里能显示“已批准”）', !!store.readAnswers('司天-宪法层').approvedAt)
check('★ 列表里 approved 变 true', store.listDecks().decks[0].approved === true)

console.log('\n== ④ 幂等与边界 ==')
const ap2 = store.approveDeck('司天-宪法层')
check('★★ 再批一次不会长出新卡片（同内容 + 同日期去重）',
  ap2.cards === 0 && ap2.existed === 2 && decisions.loadDecisions().length === cardsBefore + 2,
  'cards=' + ap2.cards + ' existed=' + ap2.existed + ' total=' + decisions.loadDecisions().length)

const written = []
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p)
    else written.push(path.relative(DATA, p).replace(/\\/g, '/'))
  }
}
walk(DATA)
check('★★ 全部产物只在 task-data 内（不往任何项目 repo 写 —— 契约：对项目 repo 只读）',
  written.every((f) => !/^\.\./.test(f)) && written.some((f) => f.indexOf('task-data/questionnaires/') === 0),
  written.join(', '))
check('★ 问卷原文件没被改动（方寸只读它）',
  fs.readFileSync(path.join(DATA, 'task-data', 'questionnaires', '司天-宪法层.md'), 'utf-8') === src)

console.log('\n== ⑤ 验收线必须跟出来（2026-11-05 暮雨：别只躺在问卷里）==')
// 只写在问卷里的后果很具体：下次 agent 动工不知道“这条线在哪儿”，
// 而【验收线】正是事后校验的唯一依据（“跨形态派单的任务卡一律打回”这种话）。
{
  const q1 = g.parsed.questions.find((x) => x.id === 'S1')
  check('  前置：S1 原文里确实有【验收线】（不是空）', !!(q1 && q1.line), q1 && q1.line)
  check('★★ 导出里每题下面跟出「验收线：」（原来只有“选了什么”）',
    /- \*\*S1\*\*[\s\S]{0,200}?验收线：/.test(exp) && exp.indexOf('验收线：') > 0,
    exp.split('\n').filter((l) => l.indexOf('验收线') >= 0).slice(0, 2).join(' / '))
  check('★★ 末尾单列一份「验收线」清单（方便整段搬进相关卡的验收段）',
    /## 验收线/.test(exp) && /- \*\*S1\*\*：/.test(exp),
    exp.slice(-160).replace(/\n/g, ' / '))
  const d1 = decisionsNow.find((d) => /问卷 司天-宪法层 · S1/.test(d.出处 || ''))
  check('★★ 决策卡的备注里也带着验收线（三个月后翻卡片还看得见那条线）',
    !!d1 && /验收线：/.test(String(d1.备注 || '')), d1 && d1.备注)
  // 反例：没写验收线的题必须显式写“未给”，不能悄悄留空。
  // ⚠ 真样本每道题都写了验收线 —— 只拿它测，这条分支**永远走不到**。
  //   所以自己造一份没写【验收线】的卷，直接喂给导出的纯函数。
  const { parseQuestionnaire } = require(path.join(DIST, 'shared', 'questionnaire.js'))
  const fake = parseQuestionnaire([
    '# 反例卷', '',
    '## X1 没有验收线的题', '题干一句话',
    '- **A. 甲**——说明甲', '- **B. 乙**——说明乙', '',
  ].join('\n'))
  const fakeTxt = store.buildDecisionLog(fake, { X1: { kind: 'pick', k: 'A' } }, '反例卷', '2026-11-05')
  check('★★ 反例：没有验收线的题，导出显式写“未给”（不留白让人以为是漏了）',
    /验收线：未给/.test(fakeTxt), fakeTxt.split('\n').filter((l) => l.indexOf('验收线') >= 0).join(' / '))
  check('  同一份反例里也不该冒出“## 验收线”汇总段（没有一条验收线就别立空标题）',
    !/## 验收线/.test(fakeTxt), fakeTxt.slice(-80).replace(/\n/g, ' / '))
}

console.log('\n== ⑥ 出口提示词（反问 → 重出题；无反问才许出施工单）==')
{
  const build1 = store.buildPromptForDeck('司天-宪法层', 'build')
  check('★★ 还有反问时 **拒绝**出施工单（问题没定就出单，出的必然是错的）',
    build1.ok === false && /反问/.test(build1.error || ''), build1.error)
  check('★ 拒绝时把“有几道”说清（不是一句“不行”）', Number(build1.askbacks) === 1, JSON.stringify(build1.askbacks))

  const rw = store.buildPromptForDeck('司天-宪法层', 'rewrite')
  check('★★ 有反问 → 重出题提示词生成成功', rw.ok === true && !!rw.text, rw.error)
  check('★★ 提示词里带**反问原话**（否则 agent 不知道哪儿问错了）',
    !!rw.text && rw.text.indexOf('地图最终给谁看') >= 0, (rw.text || '').slice(0, 80))
  check('★★ 明说“只重写这几道，别把整卷重发”（否则白重答 6 题）',
    !!rw.text && /只重写/.test(rw.text) && /别把整卷重发|不要重发整卷/.test(rw.text))
  check('★ 带上原卷路径（让 agent 去读原卷，而不是靠摘要猜）',
    !!rw.text && /task-data[\\/]questionnaires/.test(rw.text))
  check('★ 带上格式模板（方寸要能解析下一卷，否则又白问一轮）',
    !!rw.text && /\*\*A\. /.test(rw.text) && /## S1 题名/.test(rw.text))
  check('★ 带上【验收线】要求（没这条的题不许出）',
    !!rw.text && /验收线/.test(rw.text) && /不许出/.test(rw.text))

  // 把反问改成打勾 → 现在才允许出施工单
  store.writeAnswers('司天-宪法层', {
    answers: {
      S1: { kind: 'pick', k: 'A' },
      S2: { kind: 'skip' },
      S3: { kind: 'pick', k: 'B' },
    },
  })
  // ⚠ 2026-11-07 语义变了：重出题的入口**不再只由反问触发** ——
  //   暮雨 11-05 认可的四条之一是「没写代价的选项不许进卷」，而补代价必须由出卷人做，
  //   所以「有缺代价选项」也开这一轮。样本里真实存在这类项（S3 的 B 等），
  //   于是这里不能断言"被拒"，要断言"被允许且点名缺代价的那几个"。
  const rw2 = store.buildPromptForDeck('司天-宪法层', 'rewrite')
  check('★★ 反问清零但有缺代价的选项 → 仍可重出题（补代价也是重出题的一轮）',
    rw2.ok === true && rw2.costGaps > 0 && /没写代价的选项/.test(rw2.text || ''),
    `ok=${rw2.ok} gaps=${rw2.costGaps} err=${rw2.error}`)
  check('★ 提示词里点名缺代价的选项（出卷人要知道补哪几个，不是笼统"补代价"）',
    !!rw2.text && rw2.text.includes('**S3**') && rw2.text.includes('B. '),
    (rw2.text || '').split('\n').filter((l) => l.indexOf('没写代价') >= 0 || /^- \*\*S\d/.test(l)).join(' | ').slice(0, 160))

  const build2 = store.buildPromptForDeck('司天-宪法层', 'build')
  check('★★ 反问清零 → 施工单提示词生成成功', build2.ok === true && !!build2.text, build2.error)
  check('★ 施工单里带“已定”的选择与验收线（照这个做，不要再问一遍）',
    !!build2.text && /已定/.test(build2.text) && /验收线/.test(build2.text))
  check('★★ 没答的题单列成“不许自己拍”（否则 agent 会替他决定跳过的那几题）',
    !!build2.text && /不许自己拍/.test(build2.text) && /S2/.test(build2.text),
    (build2.text || '').split('\n').filter((l) => l.indexOf('S2') >= 0).join(' / ').slice(0, 120))
}

console.log('')
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  · ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
