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
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const STUB = path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-q-store-'))
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

console.log('')
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  · ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
