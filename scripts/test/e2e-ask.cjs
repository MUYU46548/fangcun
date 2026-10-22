#!/usr/bin/env node
/**
 * 「随问」结构化查询测试（2026-10-22 · 施工单包 03 任务一）
 *
 * 真跑编译产物 `dist/main/services/ask.js` + **临时数据目录**
 * （不碰真实 registry / task-data / ai-trace；git 预热在临时目录里读不到仓库不影响断言）。
 *
 * 这套要钉死的是**03 单的成本红线**，不是"能问出话来"：
 *   ★ 10 个典型问题 ≥8 个零 LLM —— 这里真跑全部 10 类，逐条断言 `needsLlm === false`
 *   ★ **只有**含糊到结构化确实算不出来的句子才 needsLlm=true（反例：这类必须恰好为 true）
 *   ★ 数字必须与夹具**真身**对得上（不写死期望值 —— 从夹具算）
 *   ★ 取不到就是取不到：没填状态的卡不许被写成"活跃"，没截止日的不进逾期口径
 *   ★ 零副作用：跑完 registry.yaml 逐字节不变、task-data 文件清单不变、ai-trace 不被追加
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-e2e-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
const repoA = path.join(TMP, 'repoA')
const repoB = path.join(TMP, 'repoB')
const repoC = path.join(TMP, 'repoC')

process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, USERDATA, repoA, repoB, repoC]) fs.mkdirSync(d, { recursive: true })
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.mkdirSync(path.join(DATA, 'docs', '执行日志'), { recursive: true })

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

// ── 夹具 ────────────────────────────────────────────────────────────────
const SEC = (ms) => String(Math.floor(ms / 1000))
const now = Date.now()
const DAY = 86400000
const daysAgoSec = (n) => SEC(now - n * DAY)
const daysAheadSec = (n) => SEC(now + n * DAY)

const REG = path.join(DATA, 'registry.yaml')
const REG_YAML = [
  'members:',
  '  - hermes',
  '  - 暮雨',
  '',
  'projects:',
  '  - id: fc-demo',
  '    name: 方寸演示',
  '    tasks: ""',
  '    repo: ' + repoA.replace(/\\/g, '/'),
  '    tools: []',
  '    sources: []',
  '    状态: 活跃开发中（演示夹具）',
  '    路线图: 跑通第一单',
  '    说明: 欠着：①第一件欠账 ②第二件欠账',
  '  - id: second',
  '    name: 第二个项目',
  '    tasks: ""',
  '    repo: ' + repoB.replace(/\\/g, '/'),
  '    tools: []',
  '    sources: []',
  '    状态: 内容创作期',
  '    说明: 欠着：只有这一条',
  '  - id: cold',
  '    name: 冷项目',
  '    tasks: ""',
  '    repo: ' + repoC.replace(/\\/g, '/'),
  '    tools: []',
  '    sources: []',
  '    状态: 停在很久以前',
  '',
  'released:',
  '  - id: old-one',
  '    name: 老项目',
  '    tasks: ""',
  '    repo: ""',
  '    tools: []',
  '    sources: []',
  '    状态: 已稳定、无后续开发计划',
  '',
].join('\n')
fs.writeFileSync(REG, REG_YAML, 'utf-8')

/** 一张卡（只写必要字段；中文键 → parseTask 会映射成 fm 的英文键） */
function card(file, fm, body) {
  const lines = ['---']
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`)
  lines.push('---', body || '## 方案', '', '## 结果记录', '')
  fs.writeFileSync(path.join(DATA, 'task-data', file), lines.join('\n'), 'utf-8')
}

const T = (n) => daysAgoSec(n)
// alpha（方寸演示）6 张：进行中 1 / 待办 2 / 待验收 1 / 被挡 1 / 完成 1
card('a-doing.md', { id: 'a-doing', 标题: '正在做的活', 项目: '[fc-demo]', 状态: '进行中', 优先级: '中', 创建: T(2), 更新: T(1), 来源: 'human', 指派: 'hermes', 验收: '暮雨', 阻塞: '[]' })
card('a-todo-hi.md', { id: 'a-todo-hi', 标题: '高优先级待办', 项目: '[fc-demo]', 状态: '待办', 优先级: '高', 创建: T(3), 更新: T(3), 来源: 'human', 指派: '', 验收: '', 阻塞: '[]' })
card('a-todo-mid.md', { id: 'a-todo-mid', 标题: '中优先级待办', 项目: '[fc-demo]', 状态: '待办', 优先级: '中', 创建: T(4), 更新: T(4), 来源: 'human', 指派: '', 验收: '', 阻塞: '[]' })
card('a-review.md', { id: 'a-review', 标题: '等验收的活', 项目: '[fc-demo]', 状态: '待验收', 优先级: '中', 创建: T(2), 更新: T(1), 来源: 'human', 指派: 'hermes', 验收: '暮雨', 阻塞: '[]' })
card('a-blocked.md', { id: 'a-blocked', 标题: '被挡住的活', 项目: '[fc-demo]', 状态: '待办', 优先级: '低', 创建: T(5), 更新: T(2), 来源: 'human', 阻塞: '[a-doing]' })
card('a-done.md', { id: 'a-done', 标题: '已经做完的活', 项目: '[fc-demo]', 状态: '完成', 优先级: '中', 创建: T(9), 更新: T(1), 来源: 'human', 阻塞: '[]' })
// beta（第二个项目）：一张逾期 + 一张两天后到期
card('b-overdue.md', { id: 'b-overdue', 标题: '拖了很久的活', 项目: '[second]', 状态: '待办', 优先级: '高', 创建: T(30), 更新: T(30), 来源: 'human', 截止: daysAgoSec(19) })
card('b-soon.md', { id: 'b-soon', 标题: '快到期了', 项目: '[second]', 状态: '待办', 优先级: '中', 创建: T(1), 更新: T(1), 来源: 'human', 截止: daysAheadSec(2) })
// gamma（冷项目）：有未完成卡，但 60 天没动 → health=dormant
card('c-cold.md', { id: 'c-cold', 标题: '两个月没动的活', 项目: '[cold]', 状态: '待办', 优先级: '低', 创建: T(70), 更新: T(60), 来源: 'human' })

// ai-trace 夹具（token 数刻意各不相同，断言按名称合计，不写死总数）
const TRACE = path.join(TMP, 'ai-trace.jsonl')
const TRACE_ROWS = [
  { ts: new Date(now - 2 * DAY).toISOString(), trigger: 'desktop.draftProjectBrief', model: 'deepseek-flash', prompt_chars: 100, completion_chars: 50, duration_ms: 1200, ok: true, stream: false, total_tokens: 1200 },
  { ts: new Date(now - 1 * DAY).toISOString(), trigger: 'desktop.chat', model: 'deepseek-flash', prompt_chars: 200, completion_chars: 80, duration_ms: 900, ok: true, stream: false, total_tokens: 800 },
  { ts: new Date(now - 1 * DAY).toISOString(), trigger: 'desktop.chat', model: 'mimo-7b', prompt_chars: 300, completion_chars: 0, duration_ms: 300, ok: false, stream: false, error: 'boom' },
]
fs.writeFileSync(TRACE, TRACE_ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')

// ── 加载产物 ────────────────────────────────────────────────────────────
const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)
const trace = require(path.join(DIST, 'llm', 'trace.js'))
trace.setTraceFilePathForTest(TRACE)
const ask = require(path.join(DIST, 'services', 'ask.js'))

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const REG_BEFORE = sha(fs.readFileSync(REG))
const TASK_FILES_BEFORE = fs.readdirSync(path.join(DATA, 'task-data')).sort().join(',')
const TRACE_BEFORE = sha(fs.readFileSync(TRACE))

// 从夹具真身算期望值（**不写死条数** —— 夹具一改就得跟着改的断言是定时炸弹）
const allTasks = data.loadAllTasksRaw('active')
const openOf = (pid) => allTasks.filter((t) => {
  const s = String(t?.fm?.status || '')
  const p = Array.isArray(t?.fm?.project) ? t.fm.project : [t?.fm?.project]
  return p.includes(pid) && s !== '完成' && s !== '驳回'
})
const EXPECT_ALPHA_OPEN = openOf('fc-demo').length
const EXPECT_TOTAL_OPEN = allTasks.filter((t) => {
  const s = String(t?.fm?.status || '')
  return s !== '完成' && s !== '驳回'
}).length
const EXPECT_TOKENS = TRACE_ROWS.reduce((s, r) => s + (typeof r.total_tokens === 'number' ? r.total_tokens : 0), 0)

console.log('---- 0. 夹具自检 ----')
check('夹具起点：3 个 projects + 1 个 released', data.parseRegistry(true).length === 4)
check('方寸演示有未完成卡（期望值从夹具算）', EXPECT_ALPHA_OPEN >= 4, String(EXPECT_ALPHA_OPEN))

console.log('\n---- 1. 十个典型问题：全部零 LLM ----')
const CASES = [
  ['progress', '方寸演示到哪了', '方寸演示', 'fc-demo'],
  ['next', '下一步该做什么', null, null],
  ['who', '谁在等谁', null, null],
  ['owe', '欠着什么', null, null],
  ['blocked', '卡在哪', null, null],
  ['due', '哪些逾期了', null, null],
  ['dormant', '哪些项目停着', null, null],
  ['counts', '还有多少没做完', null, null],
  ['tasks', '方寸演示有哪些任务', '方寸演示', 'fc-demo'],
  ['cost', '本月烧了多少钱', null, null],
]
const ZERO_LLM = []
for (const [kind, q, , pid] of CASES) {
  const a = ask.answer(q)
  const okKind = a.kind === kind
  const okLlm = a.needsLlm === false
  const okPid = pid ? a.projectId === pid : true
  check(`「${q}」→ kind=${kind} 且零 LLM`, okKind && okLlm && okPid,
    `kind=${a.kind} needsLlm=${a.needsLlm} projectId=${a.projectId} title=${a.title}`)
  if (a.needsLlm === false) ZERO_LLM.push(q)
}
check('★★ 10 个典型问题 ≥8 个不走 LLM（03 单验收线）', ZERO_LLM.length >= 8, `${ZERO_LLM.length}/10`)

console.log('\n---- 2. 数字必须与夹具真身对得上 ----')
const aCounts = ask.answer('方寸演示还有多少没做完')
check('★ 未完成张数 = 夹具真算（不是写死的）',
  aCounts.title.indexOf(`${EXPECT_ALPHA_OPEN} 张未完成`) >= 0, aCounts.title)
const aTotal = ask.answer('还有多少没做完')
check('★ 全局未完成张数 = 夹具真算',
  aTotal.title.indexOf(`${EXPECT_TOTAL_OPEN} 张未完成`) >= 0, aTotal.title)
check('  已完成的卡不进未完成统计（a-done 不该出现在按状态分组的行里）',
  !aTotal.rows.some((r) => r.k === '完成'), JSON.stringify(aTotal.rows))
const aCost = ask.answer('本月烧了多少钱')
check('★ token 总数 = ai-trace 真身合计', aCost.title.indexOf(EXPECT_TOKENS.toLocaleString()) >= 0, `${aCost.title} / 期望 ${EXPECT_TOKENS}`)
check('  失败调用单独计数（不混进"成功"里）', aCost.title.indexOf('失败 1') >= 0, aCost.title)
check('★ 没报 usage 的那次不折算成 token（只算 2 次有 token 的）',
  aCost.lines.some((l) => l.indexOf('2 次供应商报了 usage') >= 0), JSON.stringify(aCost.lines))
check('  来源写清了（ai-trace）', aCost.source.indexOf('ai-trace') >= 0, aCost.source)

console.log('\n---- 3. 各意图的内容正确性 ----')
const aProg = ask.answer('方寸演示到哪了')
check('★ 指名项目的 progress 用的是**手写状态**（registry 三字段之一）',
  aProg.title.indexOf('活跃开发中（演示夹具）') >= 0, aProg.title)
check('  同时给出任务级实况（当前步骤/下一步/卡在谁/计数）',
  aProg.lines.some((l) => l.indexOf('当前步骤') >= 0) && aProg.lines.some((l) => l.indexOf('卡在谁') >= 0),
  JSON.stringify(aProg.lines))
const aWho = ask.answer('谁在等谁')
check('★ 有「待验收」卡 → 等验收人（暮雨）',
  aWho.rows.some((r) => r.v.indexOf('暮雨') >= 0 && r.sub.indexOf('验收') >= 0), JSON.stringify(aWho.rows))
const aNext = ask.answer('方寸演示下一步')
check('★ 下一步取待办里优先级最高的那张（高）',
  aNext.title.indexOf('高优先级待办') >= 0, aNext.title)
const aBlocked = ask.answer('卡在哪')
check('★ 被挡的卡认得出来，并说清被谁挡',
  aBlocked.rows.some((r) => r.k === '被挡住的活' && r.v.indexOf('正在做的活') >= 0), JSON.stringify(aBlocked.rows))
check('  源卡已完成的**不算**挡路（这里只该有 1 条）', aBlocked.rows.length === 1, String(aBlocked.rows.length))
const aDue = ask.answer('哪些逾期了')
check('★ 逾期张数 = 夹具里那个拖了 19 天的（1 张）',
  aDue.title.indexOf('逾期 1 张') >= 0, aDue.title)
check('★ 逾期卡被点名，且天数按 shared/time.daysSinceDue 算（19 上下）',
  aDue.rows.some((r) => r.k === '拖了很久的活' && /逾期 \d+ 天/.test(r.v)), JSON.stringify(aDue.rows))
check('  两天后到期的进「三天内」那一档',
  aDue.rows.some((r) => r.k === '快到期了' && r.v.indexOf('天后到期') >= 0), JSON.stringify(aDue.rows))
check('★ 没填截止日的卡不进逾期口径（不拿「没填」当「没逾期」也不算它逾期）',
  !aDue.rows.some((r) => r.k === '正在做的活'), JSON.stringify(aDue.rows.map((r) => r.k)))
const aDormant = ask.answer('哪些项目停着')
check('★ 60 天没动的项目被判「休眠」',
  aDormant.rows.some((r) => r.k === '冷项目' && r.v === '休眠'), JSON.stringify(aDormant.rows))
const aOwe = ask.answer('欠着什么')
check('★ 欠着读的是 registry「说明」字段，逐项目列出',
  aOwe.rows.some((r) => r.k === '方寸演示' && r.v.indexOf('第一件欠账') >= 0), JSON.stringify(aOwe.rows))
check('  没写说明的项目不硬凑一行（冷项目不该出现）',
  !aOwe.rows.some((r) => r.k === '冷项目'), JSON.stringify(aOwe.rows.map((r) => r.k)))
const aOweOne = ask.answer('第二个项目欠着什么')
check('★ 指名项目只回答那一个', aOweOne.projectId === 'second' && aOweOne.rows.length === 1, JSON.stringify(aOweOne))
const aTasks = ask.answer('方寸演示有哪些任务')
check('★ 任务列表按优先级排（高在第一个）',
  aTasks.rows[0] && aTasks.rows[0].k === '高优先级待办', JSON.stringify(aTasks.rows.map((r) => r.k)))
check('  已完成的卡不出现在任务列表里',
  !aTasks.rows.some((r) => r.k === '已经做完的活'), JSON.stringify(aTasks.rows.map((r) => r.k)))

console.log('\n---- 4. 反例：含糊句才 needsLlm=true（且只此一类） ----')
const aVague = ask.answer('你觉得这个方向对不对')
check('★★ 结构化算不出来的含糊句 → needsLlm=true（这是唯一该烧 token 的情形）',
  aVague.needsLlm === true, `kind=${aVague.kind} needsLlm=${aVague.needsLlm}`)
check('  并且**没有**假装给出答案（title 明说答不了）',
  aVague.title.indexOf('答不了') >= 0, aVague.title)
check('  提示了成本红线（AI 只进模糊问答/批次出单两处）',
  aVague.lines.join(' ').indexOf('两种') >= 0 && aVague.lines.join(' ').indexOf('批次出单') >= 0,
  JSON.stringify(aVague.lines))
// 反例之二：一句判断题里带「接下来」—— 不许被 next 认领（2026-10-22 实测踩过）
const aJudge = ask.answer('你觉得我接下来该不该砍掉它')
check('★★ 「接下来该不该…」是判断题，不许被当成 next 答成"下一步做哪张卡"',
  aJudge.kind === 'unmatched', `kind=${aJudge.kind} title=${aJudge.title}`)
const aEmpty = ask.answer('   ')
check('空输入 → 教一句怎么问，且**不**烧 token', aEmpty.needsLlm === false && aEmpty.title.indexOf('问一句') >= 0, aEmpty.title)
const aNameOnly = ask.answer('冷项目是什么')
check('只点了项目名、没命中意图 → 退化成该项目实况（不是"我不懂"）',
  aNameOnly.needsLlm === false && aNameOnly.projectId === 'cold',
  `kind=${aNameOnly.kind} needsLlm=${aNameOnly.needsLlm} projectId=${aNameOnly.projectId}`)

console.log('\n---- 5. 零副作用：问十遍一个字节都不许动 ----')
for (const [, q] of CASES) ask.answer(q)
check('★ registry.yaml 逐字节不变', sha(fs.readFileSync(REG)) === REG_BEFORE)
check('★ task-data 文件清单不变（没被"顺手"归档/改写）',
  fs.readdirSync(path.join(DATA, 'task-data')).sort().join(',') === TASK_FILES_BEFORE)
check('★ ai-trace 没被追加（查询不算一次模型调用）', sha(fs.readFileSync(TRACE)) === TRACE_BEFORE)

console.log('\n---- 6. 常用问题快捷点选（界面不许自己写文案） ----')
check('预设非空且每条都能被结构化接住（没有一条落到 unmatched）', (() => {
  const bad = []
  for (const p of ask.ASK_PRESETS) {
    const a = ask.answer(p.q)
    if (a.kind === 'unmatched' || a.needsLlm) bad.push(`${p.label}:${a.kind}`)
  }
  return bad.length === 0 && ask.ASK_PRESETS.length >= 8
})(), JSON.stringify(ask.ASK_PRESETS.map((p) => p.label)))
check('项目选项从 registry 现读（含 released 段，不硬编码）',
  ask.askProjectOptions().length === 4 && ask.askProjectOptions().some((x) => x.id === 'old-one'),
  JSON.stringify(ask.askProjectOptions()))

console.log(`\n==== ${PASS} 通过 / ${FAILS.length} 失败 ====`)
if (FAILS.length) { FAILS.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1) }
