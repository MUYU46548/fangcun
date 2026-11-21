#!/usr/bin/env node
/**
 * 问卷待答 → 通知中心 e2e（2026-11-11 · 暮雨：「有新问卷完全无提示，也没有和现成的通知系统联动」）
 *
 * 判据（卡 c6f169e1 的机检部分）：
 *   ① 落一卷待答卷 → 下一次 `scanOnce` 产生一条 `questionnaire-pending`，sourceId = 卷名；
 *   ② 重复扫描不许重复弹（去重靠 notifications 的 key）；
 *   ③ 卷被批准 / 作废 / 归档 / 被取代 → 通知自动消解（不留僵尸条目）；
 *   ④ 卷被扩题（题数变了）→ 允许再提示一次（那确实是新活）。
 *
 * 运行：node scripts/test/e2e-qn-notify.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('qn-notify-')
const DATA = path.join(TMP, 'data')
const TASK_DIR = path.join(DATA, 'task-data')
const QDIR = path.join(TASK_DIR, 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, TASK_DIR, QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'), 'projects:\n  - id: fangcun-base\n    name: 方寸\n    repo: .\n', 'utf-8')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))
const notifier = require(path.join(DIST, 'main', 'services', 'notifier.js'))
const notifications = require(path.join(DIST, 'main', 'services', 'notifications.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}
const Q = (tag) => [
  `## A1 ${tag}`, `${tag}怎么做？`, '- **A. 甲**——代价甲', '- **B. 乙**——代价乙', `【验收线】${tag}反例即违约`, '',
]
const deck = (name, lines) => fs.writeFileSync(path.join(QDIR, name + '.md'), lines.join('\n'), 'utf-8')
const rows = () => notifications.listNotifications().filter((n) => n.type === 'questionnaire-pending')
const scan = () => notifier.scanOnce(new Date())

deck('待答卷', ['# 待答卷', '**项目**：fangcun-base', ...Q('待答')])
scan()
const r1 = rows()
check('★★ 待答卷 → 下一次扫描就出一条通知', r1.length === 1, JSON.stringify(r1.map((n) => [n.type, n.sourceId])))
check('★★ 通知点名是哪一卷（sourceId = 卷名）', r1[0] && r1[0].sourceId === '待答卷', r1[0] && r1[0].sourceId)
check('★ 通知里说清后果（不是只说“有问卷”）', /批准之前/.test((r1[0] && r1[0].body) || ''), r1[0] && r1[0].body)

const beforeIds = new Set(r1.map((n) => n.id))
scan()
const afterSame = rows().filter((n) => beforeIds.has(n.id)).length
check('★★ 重复扫描不许轰炸（同一条，不新建）', rows().length === 1 && afterSame === 1, String(rows().length))

// 答完但还没批准 → 标题必须改成“答完了，等你批准”，不能再写“待你答”
store.writeAnswers('待答卷', { answers: { A1: { kind: 'pick', k: 'A' } } })
scan()
const answeredRow = rows().find((n) => n.sourceId === '待答卷')
check('★★ 答完未批准 → 标题改成“答完了，等你批准”（不再写“待你答”）',
  !!answeredRow && /答完了，等你批准/.test(String(answeredRow.title)) && !/待你答/.test(String(answeredRow.title)),
  answeredRow && answeredRow.title)
check('★ 答完未批准正文说明“批准前仍出不来”（不是已经生效）',
  !!answeredRow && /批准前/.test(String(answeredRow.body)), answeredRow && answeredRow.body)

// 批准后 → 自动消解
store.approveDeck('待答卷')
scan()
check('★★ 批准后通知自动消解（不留僵尸条目）', rows().length === 0, JSON.stringify(rows().map((n) => n.sourceId)))

// 作废卷 / 归档卷不提示
deck('作废卷', ['# 作废卷', '**项目**：fangcun-base', ...Q('作废')])
store.writeAnswers('作废卷', { answers: { A1: { kind: 'pick', k: 'A' } } })
store.approveDeck('作废卷')
store.voidDeck('作废卷', '需求变了')
deck('归档卷', ['# 归档卷', '**项目**：fangcun-base', ...Q('归档')])
store.writeAnswers('归档卷', { answers: { A1: { kind: 'pick', k: 'A' } }, approvedAt: new Date(Date.now() - 60 * 86400_000).toISOString() })
store.archiveDeck('归档卷')
scan()
check('★★ 作废 / 归档的卷不提示（只提示“待你答”）', rows().length === 0, JSON.stringify(rows().map((n) => n.sourceId)))

// 扩题 → 允许再提示一次
deck('扩题卷', ['# 扩题卷', '**项目**：fangcun-base', ...Q('扩题')])
scan()
const r2 = rows()
check('★ 新卷再次提示', r2.length === 1 && r2[0].sourceId === '扩题卷', JSON.stringify(r2.map((n) => n.sourceId)))
deck('扩题卷', ['# 扩题卷', '**项目**：fangcun-base', ...Q('扩题'),
  '## A2 加一道', '再加一问？', '- **A. 是**——代价', '- **B. 否**——代价', '【验收线】加题反例', ''])
scan()
check('★ 卷被扩题（题数变了）→ 再提示一次（确实是新活）', rows().filter((n) => n.sourceId === '扩题卷').length === 2,
  String(rows().filter((n) => n.sourceId === '扩题卷').length))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
