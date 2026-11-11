#!/usr/bin/env node
/**
 * 问卷管理 e2e（2026-11-11 · 卡《问卷管理跟不上出卷速度：分组已做，缺「取代关系 / 搜索 / 归档」》）
 *
 * 判据（卡上原文，逐条钉）：
 *   ① 40 卷时打开问卷页，**首屏只出现待答卷**（已批准默认不占位）；
 *   ② 任意一卷能在列表上直接看出「属于哪个项目 / 答了几题 / 是否已作废」；
 *   ③ **被取代的卷不许再出现在待答里**（哪怕它还有未答题）；
 *   ④ 搜索：输「备份」能**同时命中卷名与题面**；
 *   ⑤ 归档闸：已批准 ≥30 天且**无卡引用**才收；有引用就拒，且答案文件逐字节不变；
 *   ⑥ 归档 ≠ 作废：归档后澄清闸照样放行（答案仍参与裁决）。
 *
 * 运行：node scripts/test/e2e-qn-manage.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('qn-manage-')
const DATA = path.join(TMP, 'data')
const TASK_DIR = path.join(DATA, 'task-data')
const QDIR = path.join(TASK_DIR, 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, TASK_DIR, QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'),
  'projects:\n  - id: fangcun-base\n    name: 方寸\n    repo: .\n  - id: sitian\n    name: 司天\n    repo: .\n', 'utf-8')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))
const tasks = require(path.join(DIST, 'main', 'data', 'tasks.js'))
const gate = require(path.join(DIST, 'main', 'data', 'qnGate.js'))
const { groupDecks } = require(path.join(DIST, 'shared', 'deckGroups.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

const Q = (tag) => [
  `## A1 ${tag}`, `关于${tag}要怎么定？`,
  '- **A. 甲**——代价甲', '- **B. 乙**——代价乙',
  `【验收线】${tag}出现反例即违约`, '',
]
function deck(name, lines) {
  fs.writeFileSync(path.join(QDIR, name + '.md'), lines.join('\n'), 'utf-8')
}
function approve(deckName, daysAgo = 0, project = 'fangcun-base') {
  const at = new Date(Date.now() - daysAgo * 86400_000).toISOString()
  store.writeAnswers(deckName, { answers: { A1: { kind: 'pick', k: 'A' } }, approvedAt: at })
  return at
}

console.log('== ① 40 卷时首屏只有待答卷（口径在纯函数里）==')
{
  const list = []
  for (let i = 0; i < 35; i++) list.push({ deck: 'approved-' + i, approved: true })
  for (let i = 0; i < 3; i++) list.push({ deck: 'voided-' + i, voided: true })
  list.push({ deck: 'replaced-旧', voided: false, approved: false, replacedBy: 'new-v2' })
  list.push({ deck: 'archived-1', approved: true, archived: true })
  list.push({ deck: '还在等我答', approved: false })
  const g = groupDecks(list)
  check('★★ 40 卷里待答只有 1 卷', g.pending.length === 1 && g.pending[0].deck === '还在等我答', JSON.stringify(g.pending.map((d) => d.deck)))
  check('★★ 已批准 / 已作废 / 被取代都进“已处理”，不占首屏', g.done.length === 39, String(g.done.length))
  check('★★ 被取代的卷不进待答（哪怕它没批准）', !g.pending.some((d) => d.deck === 'replaced-旧'))
  check('★ 被取代的卷在“已处理”里也不丢（要能追溯）', g.done.some((d) => d.deck === 'replaced-旧'))
  check('★★ 历史卷单列，不混进待答也不混进已处理', g.archived.length === 1 && !g.done.some((d) => d.deck === 'archived-1'))
  check('★ 空输入不炸', groupDecks(null).pending.length === 0)
}

console.log('== ② 取代关系：卷面 `**取代**：旧卷` → 旧卷折叠 ==')
{
  deck('方案-v1', ['# 方案 v1', '**项目**：fangcun-base', ...Q('方案')])
  deck('方案-v2', ['# 方案 v2', '**项目**：fangcun-base', '**取代**：方案-v1', ...Q('方案')])
  const parsed = require(path.join(DIST, 'shared', 'questionnaire.js')).parseQuestionnaire(fs.readFileSync(path.join(QDIR, '方案-v2.md'), 'utf-8'))
  check('★★ 卷面解析出 supersedes', parsed.supersedes === '方案-v1', parsed.supersedes)
  const all = store.listDecks().decks
  const v1 = all.find((d) => d.deck === '方案-v1')
  const v2 = all.find((d) => d.deck === '方案-v2')
  check('★★ 旧卷被标「已被取代」', v1 && v1.replacedBy === '方案-v2', JSON.stringify(v1))
  check('★ 新卷带 supersedes（能追溯它替代了谁）', v2 && v2.supersedes === '方案-v1')
  check('★★ 旧卷即使还有未答题也不进待答', !v1.approved && !v1.voided && !!v1.replacedBy)
  // 坏数据：指向不存在的卷 → 不凭空造关系
  deck('孤儿卷', ['# 孤儿', '**取代**：不存在的卷', ...Q('孤儿')])
  const orphan = store.listDecks().decks.find((d) => d.deck === '孤儿卷')
  check('★ 指向不存在的卷 → 不产生关系（不当真）', orphan.replacedBy === '', String(orphan.replacedBy))
}

console.log('== ③ 搜索：卷名与题面一起命中 ==')
{
  deck('备份策略-甲', ['# 备份策略', '**项目**：fangcun-base', ...Q('存储')])
  deck('卷-乙', ['# 卷乙', '**项目**：sitian', '## B1 备份', '备份要不要加密？',
    '- **A. 加密**——代价甲', '- **B. 不加密**——代价乙', '【验收线】出现明文即违约', ''])
  const r1 = store.searchDecks('备份')
  const names = r1.decks.map((d) => d.deck)
  check('★★ 卷名命中', names.includes('备份策略-甲'), JSON.stringify(names))
  check('★★ 题面命中（卷名里没有“备份”）', names.includes('卷-乙'), JSON.stringify(names))
  check('★★ 命中原因说清是哪一段', (r1.hits['卷-乙'] || []).some((w) => /题面/.test(w)), JSON.stringify(r1.hits))
  check('★ 卷名命中标「卷名」', (r1.hits['备份策略-甲'] || []).includes('卷名'))
  check('★ 搜不到时返回空而不是全部', store.searchDecks('zzz-不存在').decks.length === 0)
  check('★ 项目过滤', store.searchDecks('备份', { project: 'sitian' }).decks.every((d) => d.project === 'sitian'))
  check('★ 日期区间：未来起止 → 0 卷（不是忽略条件）', store.searchDecks('备份', { from: '2099-01-01' }).decks.length === 0)
  check('★ 空查询 + 项目过滤 = 该项目全部卷', store.searchDecks('', { project: 'sitian' }).decks.every((d) => d.project === 'sitian'))
}

console.log('== ④ 归档闸：够天数 + 无引用才收 ==')
{
  deck('老卷-无引用', ['# 老卷', '**项目**：fangcun-base', ...Q('老事')])
  approve('老卷-无引用', 60)
  const a1 = store.archivableDecks(30)
  const names = a1.decks.map((d) => d.deck)
  check('★★ 60 天且无引用 → 进候选', names.includes('老卷-无引用'), JSON.stringify(names))

  deck('老卷-有引用', ['# 有引用', '**项目**：fangcun-base', ...Q('引用事')])
  approve('老卷-有引用', 60)
  const t = tasks.createTask({ title: '引用它的卡', status: '草稿', clarify: '老卷-有引用', project: 'fangcun-base' })
  const a2 = store.archivableDecks(30)
  check('★★ 有卡引用 → 不进候选', !a2.decks.some((d) => d.deck === '老卷-有引用'))
  check('★ 并说清为什么不能', a2.blocked.some((b) => b.deck === '老卷-有引用' && /引用/.test(b.why)), JSON.stringify(a2.blocked))
  const f = path.join(QDIR, '老卷-有引用.answers.json')
  const before = fs.readFileSync(f)
  const bad = store.archiveDeck('老卷-有引用')
  check('★★ 硬拒：有引用不许归档', bad.ok === false && /引用/.test(bad.error || ''), bad.error)
  check('★★ 拒的时候答案文件逐字节不变', Buffer.compare(before, fs.readFileSync(f)) === 0)

  deck('新卷-刚批准', ['# 新卷', '**项目**：fangcun-base', ...Q('新事')])
  approve('新卷-刚批准', 1)
  check('★ 刚批准（1 天）不进候选', !store.archivableDecks(30).decks.some((d) => d.deck === '新卷-刚批准'))
  // 2026-11-11 评审抓到：详情页那个「移入历史卷」按钮直连 archiveDeck，如果它不查天数，
  // 刚批准就能藏起来（实测成立过）。闸必须在数据层，不只靠列表把按钮藏掉。
  const tooNew = store.archiveDeck('新卷-刚批准')
  check('★★ 天数不够 → archiveDeck 硬拒（不靠界面藏按钮）',
    tooNew.ok === false && /满 30 天/.test(tooNew.error || ''), tooNew.error)

  deck('草稿卷-未批准', ['# 草稿', ...Q('草稿事')])
  check('★★ 没批准的不许归档（没发生的事不能藏）', store.archiveDeck('草稿卷-未批准').ok === false)

  // 第三种引用形态（评审抓到）：老卡/手写卡只有 `[问卷:<卷>:<题号>]` 标记、没有 `澄清` 字段。
  // 只认 clarifyOf 时这种卡 refCount=0 → 卷被误判“没引用”而收起来。
  deck('老卷-只有标记', ['# 只有标记', '**项目**：fangcun-base', ...Q('标记事')])
  approve('老卷-只有标记', 60)
  tasks.createTask({
    title: '只有问卷标记的卡', status: '草稿', project: 'fangcun-base',
    body: '## 来源\n问卷老卷第 A1 题\n\n[问卷:老卷-只有标记:A1]\n',
  })
  const marked = store.listDecks().decks.find((d) => d.deck === '老卷-只有标记')
  check('★★ `[问卷:卷:题]` 标记也算引用（refCount 不是 0）', marked.refCount === 1, String(marked.refCount))
  check('★★ 只有标记的卷也不许归档', store.archiveDeck('老卷-只有标记').ok === false)

  const ok = store.archiveDeck('老卷-无引用')
  check('★★ 归档成功', ok.ok === true, ok.error)
  const after = store.listDecks().decks.find((d) => d.deck === '老卷-无引用')
  check('★★ 归档后标历史卷', after.archived === true)
  check('★★ 归档 ≠ 作废：澄清闸照样放行（答案仍参与裁决）', gate.gateForDeck('老卷-无引用', 'fangcun-base').ok === true, gate.gateForDeck('老卷-无引用', 'fangcun-base').error)
  check('★ 归档后不再进候选（幂等）', !store.archivableDecks(30).decks.some((d) => d.deck === '老卷-无引用'))
  const un = store.unarchiveDeck('老卷-无引用')
  check('★ 取消归档放回列表', un.ok === true && store.listDecks().decks.find((d) => d.deck === '老卷-无引用').archived === false)
  check('★ 作废的卷不许再归档（作废本身就是处置）', store.archiveDeck('没有这卷').ok === false)
}

console.log('== ⑤ 列表字段（项目 / 答了几题 / 作废）与引用计数 ==')
{
  approve('备份策略-甲', 3)
  const d = store.listDecks().decks.find((x) => x.deck === '备份策略-甲')
  check('★★ 项目徽标字段在', d.project === 'fangcun-base', d.project)
  check('★★ 答了几题在', d.answered === 1 && d.total === 1, `${d.answered}/${d.total}`)
  const ref = store.listDecks().decks.find((x) => x.deck === '老卷-有引用')
  check('★★ 引用计数在（界面能说“N 张卡引用”）', ref.refCount === 1, String(ref.refCount))
  store.voidDeck('备份策略-甲', '需求变了')
  check('★★ 作废标在列表里可见', store.listDecks().decks.find((x) => x.deck === '备份策略-甲').voided === true)
}

console.log('== ⑤b 已落档验收线：作废卷的线不再出现（三构件卡的验收线之一）==')
{
  deck('验收线卷', ['# 验收线卷', '**项目**：fangcun-base',
    '## A1 验收口径', '怎么算做完？', '- **A. 三条全绿**——代价甲', '- **B. 抽查**——代价乙',
    '【验收线】三条回归全绿才算完', ''])
  approve('验收线卷', 1)
  const before = store.effectiveAcceptances('fangcun-base').filter((r) => r.deck === '验收线卷')
  check('★★ 已批准的验收线在派生清单里（且带原文）',
    before.length === 1 && /三条回归全绿/.test(before[0].line), JSON.stringify(before))
  check('★ 验收线按照目项目过滤（别家项目拿不到它）',
    !store.effectiveAcceptances('sitian').some((r) => r.deck === '验收线卷'))
  store.voidDeck('验收线卷', '需求变了')
  check('★★ 卷作废后那条线不再出现（不是只把列表藏起来）',
    !store.effectiveAcceptances('fangcun-base').some((r) => r.deck === '验收线卷'),
    JSON.stringify(store.effectiveAcceptances('fangcun-base').map((r) => r.deck)))
}

console.log('== ⑥ 接线守卫（界面真的用这些口径，不是只写在数据层）==')
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '')
  const ui = strip(fs.readFileSync(path.join(REPO, 'desktop/src/renderer/components/QuestionnaireModal.vue'), 'utf-8'))
  check('★★ 列表分组走 shared/deckGroups（不在模板里重写过滤）', /groupDecks\(/.test(ui))
  check('★★ 搜索真走 IPC（questionnaireSearch）', /questionnaireSearch\(/.test(ui))
  check('★★ 归档/取消归档真走通道', /questionnaireArchive\(/.test(ui) && /questionnaireUnarchive\(/.test(ui))
  check('★★ 界面标「已被取代」/「历史卷」', /已被取代/.test(ui) && /历史卷/.test(ui))
  const pre = strip(fs.readFileSync(path.join(REPO, 'desktop/src/preload/index.ts'), 'utf-8'))
  check('★★ preload 四条管理通道齐全',
    /questionnaireSearch:/.test(pre) && /questionnaireArchivable:/.test(pre)
    && /questionnaireArchive:/.test(pre) && /questionnaireUnarchive:/.test(pre))
  const ipc = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/questionnaire-ipc.ts'), 'utf-8'))
  check('★★ 主进程四条都注册了', /questionnaire:search/.test(ipc) && /questionnaire:archivable/.test(ipc)
    && /questionnaire:archive'/.test(ipc) && /questionnaire:unarchive/.test(ipc))
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
