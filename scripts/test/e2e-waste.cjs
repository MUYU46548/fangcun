#!/usr/bin/env node
/**
 * 投入产出账 e2e（0.6.0 P5，2026-11-01）
 *
 * 真跑**编译产物** `dist/shared/waste.js` + `dist/main/usage/ledger.js`。
 * 判据一句话：**数字离开口径就是假话** ——
 *   · 三格任一取不到 → **整格不渲染**（不拿 0 / “—”冒充）；
 *   · 每个数字旁必须有“它证明不了什么”；
 *   · 页面必须声明 ai-trace 只记方寸自己发起的调用，外部 agent 的花销不在内；
 *   · ai-trace 的 external 记录不许混进方寸的花销。
 *
 * 运行：node scripts/test/e2e-waste.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '../..')
const WASTE_ART = path.join(REPO, 'desktop', 'dist', 'shared', 'waste.js')
const LEDGER_ART = path.join(REPO, 'desktop', 'dist', 'main', 'usage', 'ledger.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}
function skip(name, why) { console.log(`SKIP  ${name}（${why}）`) }

for (const art of [WASTE_ART, LEDGER_ART]) {
  if (!fs.existsSync(art)) {
    console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + art)
    console.log('RESULT 0 / 1')
    process.exit(1)
  }
}
const { buildWasteLedger, sanitizeWasteLedger } = require(WASTE_ART)

const NOW = '2026-11-01T04:00:00.000Z'
const TRACE = [
  { ts: '2026-11-01T03:00:00.000Z', cost: '0.00120000', total_tokens: 1000 },
  { ts: '2026-11-01T03:10:00.000Z', origin: 'external', cost: '9.99999999', total_tokens: 99999 },
  { ts: '2026-11-01T03:20:00.000Z', prompt_tokens: 200, completion_tokens: 34 },
  { ts: '2026-11-01T03:30:00.000Z' }, // 只有字符数：计调用、不计 token/金额
  { ts: '2026-09-01T00:00:00.000Z', cost: '5.00000000', total_tokens: 500000 }, // 窗口外
]
const TASKS = [
  { id: 't1', title: '完成甲', status: '完成', updated: '2026-11-01T01:00:00.000Z' },
  { id: 't2', title: '完成乙（窗口外）', status: '完成', updated: '2026-09-01T01:00:00.000Z' },
  { id: 't3', title: '被否甲', status: '驳回', updated: '2026-10-01T01:00:00.000Z' },
  { id: 't4', title: '被否乙', status: '驳回', updated: '2026-10-02T01:00:00.000Z' },
]
const COMMITS = ['aaa1111', 'bbb2222', 'ccc3333']

console.log('== ① 三格都有：数字 + 口径 + 局限 ==')
{
  const l = buildWasteLedger({ days: 30, now: NOW, trace: TRACE, commits: COMMITS, tasks: TASKS })
  check('★ 三格齐全（花了多少 / 产出了什么 / 哪几条被否）',
    l.cells.length === 3 && l.cells.map((c) => c.key).join(',') === 'spend,output,rejected',
    JSON.stringify(l.cells.map((c) => c.key)))
  const spend = l.cells.find((c) => c.key === 'spend')
  check('★★ 花销只算 origin=local，external 一律排除（9.99 不许混进来）',
    !!spend && spend.value.indexOf('0.0012') >= 0 && spend.value.indexOf('9.99') < 0,
    spend && spend.value)
  check('★ token 只加有 token 的记录（1000+200+34=1234，旧记录/外部不算）',
    !!spend && spend.value.indexOf('1,234 tokens') >= 0, spend && spend.value)
  check('★ 构成说明如实：3 次调用 / 2 笔未折算 / 排除 1 条外部',
    !!spend && /3 次调用/.test(spend.detail) && /2 笔未折算/.test(spend.detail) && /1 条外部/.test(spend.detail),
    spend && spend.detail)
  const output = l.cells.find((c) => c.key === 'output')
  check('★ 产出 = 提交数 + 窗口内完成卡数（窗口外的完成卡不算）',
    !!output && output.value === '3 次提交 · 1 张卡完成', output && output.value)
  const rejected = l.cells.find((c) => c.key === 'rejected')
  check('★ 被否 = 当前状态为驳回的卡（列出名字）',
    !!rejected && rejected.value === '2 张' && /被否甲/.test(rejected.detail), JSON.stringify(rejected))
  check('★★ 每个数字都带“它证明不了什么”',
    l.cells.every((c) => typeof c.caveat === 'string' && c.caveat.indexOf('它证明不了什么') >= 0),
    l.cells.map((c) => c.caveat).join(' | '))
  check('★★ 页面口径声明点名 ai-trace + 外部 agent',
    /ai-trace/.test(l.note) && /外部 agent/.test(l.note), l.note)
}

console.log('\n== ② 取不到：整格不渲染，不拿 0 / — 冒充 ==')
{
  const onlyTasks = buildWasteLedger({ days: 30, now: NOW, trace: null, commits: null, tasks: TASKS })
  check('★ trace 读不到 → 没有“花了多少”这一格（不是 ¥0.00）',
    !onlyTasks.cells.some((c) => c.key === 'spend') && onlyTasks.cells.length === 2,
    JSON.stringify(onlyTasks.cells.map((c) => c.key)))
  const noTraceNoCommits = buildWasteLedger({ days: 30, now: NOW, trace: null, commits: null, tasks: null })
  check('★★ 三个来源都读不到 → 0 格 + 明确空态（不许画空格子）',
    noTraceNoCommits.cells.length === 0 && /三格都取不到/.test(noTraceNoCommits.emptyText),
    noTraceNoCommits.emptyText)
  check('★ 空态里点名不拿 0 / “—”冒充', /不拿 0/.test(noTraceNoCommits.emptyText) && /—/.test(noTraceNoCommits.emptyText))
  const emptyData = buildWasteLedger({ days: 30, now: NOW, trace: [], commits: [], tasks: [] })
  check('★ 数据真的为空（[]）≠ 读不到：0 次提交/0 张完成 是**真值**，照常显示',
    emptyData.cells.some((c) => c.key === 'output' && /0 次提交/.test(c.value))
    && emptyData.cells.some((c) => c.key === 'rejected' && /没有被否/.test(c.value)),
    JSON.stringify(emptyData.cells.map((c) => c.value)))
  const noTasks = buildWasteLedger({ days: 30, now: NOW, trace: TRACE, commits: COMMITS, tasks: null })
  check('★ 任务读不到 → 被否那格不渲染；产出只剩提交（不说 0 张卡）',
    !noTasks.cells.some((c) => c.key === 'rejected')
    && noTasks.cells.some((c) => c.key === 'output' && c.value === '3 次提交'),
    JSON.stringify(noTasks.cells.map((c) => c.value)))
}

console.log('\n== ③ 删掉 caveat → 该格不显示（精确红）==')
{
  const l = buildWasteLedger({ days: 30, now: NOW, trace: TRACE, commits: COMMITS, tasks: TASKS })
  const broken = JSON.parse(JSON.stringify(l))
  broken.cells[0].caveat = ''
  const fixed = sanitizeWasteLedger(broken)
  check('★★ 缺“它证明不了什么”的格子被丢掉（不是留一个没有前提的数字）',
    fixed.cells.length === 2 && !fixed.cells.some((c) => c.key === 'spend'),
    JSON.stringify(fixed.cells.map((c) => c.key)))
  check('★ 正常账过 sanitize 不掉格', sanitizeWasteLedger(l).cells.length === 3)
}

console.log('\n== ④ 取数：真读 ai-trace 文件 + 真跑 git ==')
{
  const TMP = path.join(os.tmpdir(), 'fc-waste-' + Date.now())
  fs.mkdirSync(TMP, { recursive: true })
  process.env.FC_TEST_USERDATA = path.join(TMP, '.userdata')
  fs.mkdirSync(process.env.FC_TEST_USERDATA, { recursive: true })
  fs.writeFileSync(path.join(TMP, 'registry.yaml'), 'members: []\nprojects: []\n', 'utf-8')
  fs.mkdirSync(path.join(TMP, 'task-data'), { recursive: true })

  const origResolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...args) {
    if (request === 'electron') return path.join(__dirname, 'electron-stub.cjs')
    return origResolve.call(this, request, ...args)
  }
  const data = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'index.js'))
  data.setDataDir(TMP)
  const { setTraceFilePathForTest } = require(path.join(REPO, 'desktop', 'dist', 'main', 'llm', 'trace.js'))
  const { collectWasteLedger } = require(LEDGER_ART)

  const traceFile = path.join(TMP, 'ai-trace.jsonl')
  fs.writeFileSync(traceFile, [
    JSON.stringify({ ts: '2026-11-01T03:00:00.000Z', trigger: 'x', model: 'm', prompt_chars: 1, completion_chars: 1, duration_ms: 1, ok: true, stream: false, cost: '0.00250000', total_tokens: 42 }),
    JSON.stringify({ ts: '2026-11-01T03:00:00.000Z', trigger: 'y', model: 'm', prompt_chars: 1, completion_chars: 1, duration_ms: 1, ok: true, stream: false, origin: 'external', cost: '7.00000000', total_tokens: 7000 }),
  ].join('\n') + '\n', 'utf-8')
  setTraceFilePathForTest(traceFile)
  const l1 = collectWasteLedger({ days: 30, now: NOW, repo: TMP }, {
    commits: () => ['a', 'b'],
    tasks: () => TASKS,
  })
  const spend1 = l1.cells.find((c) => c.key === 'spend')
  check('★★ 真读 ai-trace：external 那条不混进方寸花销',
    !!spend1 && spend1.value.indexOf('0.0025') >= 0 && spend1.value.indexOf('7.0000') < 0,
    spend1 && spend1.value)
  check('★ 真读 ai-trace：token 只算 local（42）', !!spend1 && /42 tokens/.test(spend1.value), spend1 && spend1.value)

  // 真 git：临时仓库提交一次，默认 commits 能数到
  const repo = path.join(TMP, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo, timeout: 20000 })
    execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: repo, timeout: 20000 })
    execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: repo, timeout: 20000 })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: repo, timeout: 20000 })
    execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: repo, timeout: 20000 })
    const l2 = collectWasteLedger({ days: 30, now: NOW, repo }, { trace: () => null, tasks: () => null })
    check('★★ 真 git 仓库：提交数从 git log 数出来（默认取数路径可用）',
      l2.cells.some((c) => c.key === 'output' && /1 次提交/.test(c.value)),
      JSON.stringify(l2.cells.map((c) => c.value)))
  } catch (e) {
    skip('真 git 仓库取数', 'git 起不来：' + ((e && e.message) || e))
  }

  const none = collectWasteLedger({ days: 30, now: NOW, repo: '' }, {
    trace: () => null, commits: () => null, tasks: () => null,
  })
  check('★★ 三个来源都空 → 0 格（collect 层也不填 0）', none.cells.length === 0)
}

console.log('\n== ⑤ 接线守卫 ==')
{
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')
  const PLANVIEW = read('desktop/src/renderer/views/PlanView.vue')
  check('★ 计划页有投入产出账块（三格 + 口径声明）',
    /class="waste-block"/.test(PLANVIEW) && /class="waste-cell"/.test(PLANVIEW)
    && /wasteLedger\.note/.test(PLANVIEW))
  check('★★ 每个数字节点都渲染 caveat（删掉这行 → 本条精确红）',
    /class="waste-caveat">\{\{ c\.caveat \}\}/.test(PLANVIEW))
  const IPC = read('desktop/src/main/waste-ipc.ts')
  // 2026-11-02 把跨渠道 token 对比（channels:get）并进了同一文件 —— 两个都是**只读口**。
  // 旧断言按“恰好 1 个”数，于是 P5 的 cmd 判据一直红、真卡被误判“未完成”。
  check('★ 只读口恰好两个（waste:get / channels:get），没有写口',
    (IPC.match(/guardedHandle\('/g) || []).length === 2 && /waste:get/.test(IPC) && /channels:get/.test(IPC))
  check('★ IPC 真注册了（index.ts）', /registerWasteIpcHandlers\(\)/.test(read('desktop/src/index.ts')))
  check('★ preload 暴露 wasteGet', /wasteGet: \(opts\?/.test(read('desktop/src/preload/index.ts')))
  check('★ 界面不自己算账（只调 wasteGet，不从 ai-trace/git 拼数字）',
    /api\.wasteGet\(/.test(read('desktop/src/renderer/composables/useWasteLedger.ts'))
    && !/readTrace|execFileSync/.test(read('desktop/src/renderer/composables/useWasteLedger.ts')))
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log(' - ' + f)) }
process.exit(fail ? 1 : 0)
