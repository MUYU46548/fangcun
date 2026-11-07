#!/usr/bin/env node
/**
 * 两条「半成品」的最后一公里 · 端到端（2026-11-07）
 *
 * 暮雨原话：「问卷还是半成品，继续做；想法也还是半成品，无法发挥任何实际作用」。
 * 两份同类调研（Spec Kit / Kiro / Linear / CrewAI）指向同一个缺口：
 *   **答案与念头都不能停在"记录"里 —— 没有卡就没人施工。**
 *
 * 本套守两条新通路：
 *   ① 已批准的答卷 → **真任务卡**（`deckToCards`）：护栏顺序、项目不许瞎猜、幂等、搬运不丢内容；
 *   ② 想法 → **真任务卡**（`promoteIdea({target:'task'})`）：全文进正文、可撤销、改过就不许撤。
 *
 * 全部走真数据根 + 真 registry + 真 task-data 文件，不 mock 存储。
 * 运行：node scripts/test/e2e-questionnaire-cards.cjs
 */
const fs = require('fs')
const { mkTmp } = require('./_tmp.cjs')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const STUB = path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
const TMP = mkTmp('fc-q-cards-')
const DATA = path.join(TMP, 'data')
const QDIR = path.join(DATA, 'task-data', 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, path.join(DATA, 'task-data'), QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })

// 最小 registry：项目 id + 名字（deckToCards 只认这两个字段）
fs.writeFileSync(path.join(DATA, 'registry.yaml'), [
  'projects:',
  '  - id: fangcun-base',
  '    name: 方寸',
  '  - id: sitian',
  '    name: 司天',
  '',
].join('\n'), 'utf-8')

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
const tasks = require(path.join(DIST, 'main', 'data', 'tasks.js'))
const ideas = require(path.join(DIST, 'main', 'services', 'ideas.js'))

// 真样本：司天宪法层（卷名前缀 = 司天 → 应能自动认出项目 sitian）
const SAMPLE = path.join(REPO, 'references', '问卷样本', '问卷-司天-宪法层-20261104.md')
fs.writeFileSync(path.join(QDIR, '司天-宪法层.md'), fs.readFileSync(SAMPLE, 'utf-8'), 'utf-8')

console.log('== ① 答卷 → 任务卡：三道护栏 ==')
{
  store.writeAnswers('司天-宪法层', { answers: { S1: { kind: 'pick', k: 'A' } } })
  const noApprove = store.deckToCards('司天-宪法层')
  check('★★ 反例：没批准 → 拒（草稿进施工 = 把没定的事当定了做）',
    noApprove.ok === false && /没批准/.test(noApprove.error || ''), noApprove.error)
  check('★ 拒的时候一张卡都没建', data.loadTasks('all').length === 0, String(data.loadTasks('all').length))

  // 反问未处理 → 拒
  store.writeAnswers('司天-宪法层', { answers: { S1: { kind: 'askback', text: '这题问错了，该问的是一件事还是两件事' } } })
  store.approveDeck('司天-宪法层')
  const withAsk = store.deckToCards('司天-宪法层')
  check('★★ 反例：还有反问 → 拒（问题没定，落下去的卡必然是错的）',
    withAsk.ok === false && /反问/.test(withAsk.error || ''), withAsk.error)
}

console.log('\n== ② 答卷 → 任务卡：项目不许瞎猜 ==')
{
  // 卷名前缀认不出项目 → needProject + 候选清单（不许悄悄落到"未归属"）
  fs.writeFileSync(path.join(QDIR, '无主卷.md'), [
    '# 无主卷（合成，仅测试用）', '',
    '## Z1 形状', '一问？',
    '- **A. 甲**——代价甲',
    '- **B. 乙**——代价乙',
    '【出处】测试夹具',
    '【验收线】当 A 时系统应甲',
    '',
  ].join('\n'), 'utf-8')
  store.writeAnswers('无主卷', { answers: { Z1: { kind: 'pick', k: 'A' } } })
  store.approveDeck('无主卷')
  const g0 = store.getDeck('无主卷')
  check('★ 打开卷就带项目候选（界面先给下拉，别让用户点一次失败才知道要选）',
    Array.isArray(g0.projects) && g0.projects.some((x) => x.id === 'fangcun-base'),
    JSON.stringify(g0.projects && g0.projects.map((x) => x.id)))

  const need = store.deckToCards('无主卷')
  check('★★ 认不出项目 → needProject 并回候选清单（不瞎猜归属）',
    need.ok === false && need.needProject === true && Array.isArray(need.projects) && need.projects.length === 2,
    JSON.stringify({ ok: need.ok, need: need.needProject, n: (need.projects || []).length }))

  const bad = store.deckToCards('无主卷', { project: '不存在的项目' })
  check('★★ 反例：指定的项目 registry 里没有 → 拒（卡不能落在不存在的项目上）',
    bad.ok === false && /registry/.test(bad.error || ''), bad.error)

  const okp = store.deckToCards('无主卷', { project: 'fangcun-base' })
  check('★ 显式指定合法项目 → 落卡成功', okp.ok === true && okp.created === 1 && okp.project === 'fangcun-base',
    JSON.stringify({ ok: okp.ok, created: okp.created, err: okp.error }))
}

console.log('\n== ③ 答卷 → 任务卡：内容搬运与幂等 ==')
{
  // 把反问清掉、答两题（打勾 + 改一句）、一题跳过、一题否决
  store.writeAnswers('司天-宪法层', {
    answers: {
      S1: { kind: 'pick', k: 'A' },
      S2: { kind: 'skip' },
      S3: { kind: 'amend', text: '两个都要，但先做画布，文本标注并进 B 卡' },
    },
  })
  store.approveDeck('司天-宪法层')
  const r = store.deckToCards('司天-宪法层')
  check('★★ 落卡成功，项目按卷名前缀自动认（司天 → sitian）',
    r.ok === true && r.project === 'sitian', JSON.stringify({ project: r.project, err: r.error }))
  check('★ 只给"打勾 / 改一句"的题落卡（跳过与未答不落，且逐条说明原因）',
    r.created === 2 && Array.isArray(r.omitted) && r.omitted.some((x) => x.qid === 'S2' && /跳过/.test(x.why)),
    JSON.stringify({ created: r.created, omitted: r.omitted }))

  // 样本文件名带「问卷-」前缀（`问卷-司天-宪法层-20261104`）—— 按首段认项目会认成"问卷"，
  // 所以这里专门验一次"卷名里包含项目名就算"的认法。
  fs.writeFileSync(path.join(QDIR, '问卷-司天-裁决层A.md'),
    fs.readFileSync(path.join(REPO, 'references', '问卷样本', '问卷-司天-裁决层A-20261104.md'), 'utf-8'), 'utf-8')
  {
    const d2 = store.getDeck('问卷-司天-裁决层A')
    const firstQ = d2.parsed.questions[0]
    store.writeAnswers('问卷-司天-裁决层A', { answers: { [firstQ.id]: { kind: 'pick', k: (firstQ.options[0] || { k: 'A' }).k } } })
    store.approveDeck('问卷-司天-裁决层A')
    const r2 = store.deckToCards('问卷-司天-裁决层A')
    check('★★ 带「问卷-」前缀的卷名也能认出项目（不靠首段猜）',
      r2.ok === true && r2.project === 'sitian', JSON.stringify({ project: r2.project, err: r2.error }))
  }

  const cards = data.loadTasks('all').filter((t) => String(t.body || '').includes('[问卷:司天-宪法层:'))
  check('★ 卡真落进 task-data，且能按项目筛出来', cards.length === 2 && cards.every((t) => t.fm.project === 'sitian'),
    JSON.stringify(cards.map((t) => [t.id, t.fm.project])))
  check('★ 标题带 `[问卷]` 前缀 + 题号（看板上一眼看出它是问卷来的）',
    cards.every((t) => /^\[问卷\] S\d/.test(String(t.fm.title))), JSON.stringify(cards.map((t) => t.fm.title)))
  const c1 = cards.find((t) => String(t.body).includes('[问卷:司天-宪法层:S1]'))
  check('★★ 搬运不丢内容：题干 / 选择 / 验收线 / 出处都在正文里',
    !!c1 && /## 定下来的/.test(c1.body) && /A\. /.test(c1.body)
    && /## 为什么问/.test(c1.body) && /## 验收线（问卷原文）/.test(c1.body)
    && /task-data\/questionnaires\/司天-宪法层\.md/.test(c1.body),
    (c1 && c1.body || '').slice(0, 160))
  const c3 = cards.find((t) => String(t.body).includes('[问卷:司天-宪法层:S3]'))
  check('★ "改一句"的答案原样进卡（自述不许被摘要掉）',
    !!c3 && c3.body.includes('两个都要，但先做画布，文本标注并进 B 卡'),
    (c3 && c3.body || '').slice(0, 120))

  const again = store.deckToCards('司天-宪法层')
  check('★★ 幂等：再点一次不重复建卡（skipped 计数，不是静默变 0）',
    again.ok === true && again.created === 0 && again.skipped === 2,
    JSON.stringify({ created: again.created, skipped: again.skipped }))
  check('★ 幂等后卡总数没变', data.loadTasks('all').filter((t) => String(t.body).includes('[问卷:司天-宪法层:')).length === 2)

  const log = store.getDeck('司天-宪法层')
  store.voidDeck('司天-宪法层', '需求变了')
  const afterVoid = store.deckToCards('司天-宪法层')
  check('★★ 反例：作废的卷不许再落卡（作废 = 不作数，不是"再落一遍"）',
    afterVoid.ok === false && /作废/.test(afterVoid.error || ''), afterVoid.error)
  check('★ 前情：作废前这卷是批准状态', !!log.approvedAt)
}

console.log('\n== ④ 想法 → 任务卡（不再是"立项即终点"）==')
{
  const longText = '想法第一行是标题\n第二行是正文，里面有一句很关键的话：标签要挂在图层上随地图一起缩放。\n第三行'
  const add = ideas.addIdea(longText)
  check('★ 前情：想法记下来了', add.ok === true, JSON.stringify(add))
  const id = (add.idea && add.idea.id) || ''

  const bad = ideas.promoteIdea(id, { target: 'task', project: '不存在的项目' })
  check('★★ 反例：项目不存在 → 拒（与答卷落卡同一判据）', bad.ok === false && /registry/.test(bad.error || ''), bad.error)

  const r = ideas.promoteIdea(id, { target: 'task' })
  check('★★ 想法立项成真任务卡（promoted.kind = task）',
    r.ok === true && !!r.taskId && r.idea.promoted && r.idea.promoted.kind === 'task',
    JSON.stringify({ ok: r.ok, taskId: r.taskId, promoted: r.idea && r.idea.promoted, err: r.error }))

  const card = data.loadTasks('all').find((t) => t.id === r.taskId)
  check('★ 卡在 task-data 里，标签带「想法」', !!card && (card.fm.tags || []).includes('想法'),
    JSON.stringify(card && card.fm.tags))
  check('★★ 全文进正文（第二行那句关键话一个字都没丢 —— 此前"立项即永久丢失"）',
    !!card && card.body.includes('标签要挂在图层上随地图一起缩放'), (card && card.body || '').slice(0, 160))
  check('★ 正文带幂等标记 `[想法:<id>]`', !!card && card.body.includes(`[想法:${id}]`))
  check('★ 标题只取第一行（卡 id 由标题生成，限长 60）',
    !!card && String(card.fm.title).length <= 60 && !String(card.fm.title).includes('\n'),
    JSON.stringify(card && card.fm.title))

  const twice = ideas.promoteIdea(id, { target: 'task' })
  check('★★ 反例：已立项的不能再立一次（不许长出第二张卡）', twice.ok === false && /已经立项/.test(twice.error || ''), twice.error)

  // 改过的卡不许被"撤销立项"删掉
  tasks.updateTask(r.taskId, { title: '[问卷] 改过的标题' })
  const afterEdit = ideas.unpromoteIdea(id)
  check('★★ 反例：卡被改过 → 撤销立项被拒（动过就是用户的东西）',
    afterEdit.ok === false && /改过/.test(afterEdit.error || ''), afterEdit.error)

  // 没改过的卡可以撤（删进回收站，想法退回"新记"）
  const add2 = ideas.addIdea('第二条想法：只测撤销')
  const p2 = ideas.promoteIdea(add2.idea.id, { target: 'task' })
  const back = ideas.unpromoteIdea(add2.idea.id)
  check('★ 没动过的卡 → 撤销立项成功、想法退回"新记"',
    p2.ok && back.ok === true && back.idea.status === '新记' && back.idea.promoted === null,
    JSON.stringify({ ok: back.ok, status: back.idea && back.idea.status }))
  check('★ 撤销后那张卡从活跃区消失（进回收站，可还原）',
    !data.loadTasks('active').some((t) => t.id === p2.taskId))
}

console.log('')
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  · ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
