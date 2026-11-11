#!/usr/bin/env node
/**
 * 计划生成器 e2e（0.6.0 P6，2026-11-01）
 *
 * 真跑**编译产物** `dist/main/llm/planDraft.js`（模型调用用注入的假函数，不联网）。
 * 判据一句话：**生成物只能落“待裁决”，每条建议必须引出依据** ——
 *   · 没引用 / 引用不存在的依据 → 不进草案（missingCitations 计数如实）；
 *   · 生成物出现“已冻结”→ 红；
 *   · 一次生成在 ai-trace.jsonl 留一条含 total_tokens 的记录；
 *   · 没有可引用依据时**不编**，直接拒绝。
 *
 * 运行：node scripts/test/e2e-plan-draft.cjs
 */
const fs = require('fs')
const { mkTmp, mkTmpPath } = require('./_tmp.cjs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'main', 'llm', 'planDraft.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

function finish() {
  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log(' - ' + f)) }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail ? 1 : 0)
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}

const TEST_ROOT = mkTmpPath('fc-plan-draft-')
process.env.FC_TEST_USERDATA = path.join(TEST_ROOT, '.userdata')
fs.mkdirSync(process.env.FC_TEST_USERDATA, { recursive: true })
fs.mkdirSync(path.join(TEST_ROOT, 'task-data', 'plans'), { recursive: true })
fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'members: []\nprojects: []\n', 'utf-8')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return path.join(__dirname, 'electron-stub.cjs')
  return origResolve.call(this, request, ...args)
}
const data = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'index.js'))
data.setDataDir(TEST_ROOT)
const { setTraceFilePathForTest } = require(path.join(REPO, 'desktop', 'dist', 'main', 'llm', 'trace.js'))
const plans = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'plans.js'))
const {
  allowedCitations, buildPlanDraftPrompt, parsePlanDraftPayload, validateDraftStages,
  generatePlanDraft,
} = require(ART)

const LEDGER = {
  days: 30,
  note: '口径：ai-trace 只记方寸自己发起的调用；外部 agent 的花销不在这一格。',
  emptyText: '三格都取不到',
  cells: [
    { key: 'spend', label: '花了多少（近 30 天）', value: '¥0.0123 · 1,234 tokens', caveat: '它证明不了什么：…' },
    { key: 'output', label: '产出了什么（近 30 天）', value: '12 次提交 · 3 张卡完成', caveat: '它证明不了什么：…' },
    { key: 'rejected', label: '哪几条被否', value: '2 张', caveat: '它证明不了什么：…' },
  ],
}
const INPUT = {
  project: 'demo',
  projectName: '演示项目',
  definition: '让方寸对任意项目产出一份可裁决的作战计划卡。',
  ledger: LEDGER,
  tasks: [
    { id: 't1', title: '收口判据执行器', status: '进行中' },
    { id: 't2', title: '投入产出账', status: '完成' },
  ],
  git: { commits: 12, since: '30 天' },
}
const ALLOWED = ['task:t1', 'task:t2', 'ledger:spend', 'ledger:output', 'ledger:rejected', 'git:commits']

// ── 同步部分 ──────────────────────────────────────────────────────────
console.log('== ① 依据清单 + 提示词：模型只能从真凭据里挑 ==')
{
  const a = allowedCitations(INPUT)
  check('★ 依据 id = 任务 / 账三格 / git 事实', a.join(',') === ALLOWED.join(','), a.join(','))
  check('★ 没有 git 提交时不产出 git:commits', !allowedCitations({ ...INPUT, git: { commits: 0 } }).includes('git:commits'))
  const p = buildPlanDraftPrompt(INPUT)
  check('★ 提示词带产品定义与项目名', /让方寸对任意项目/.test(p.user) && /演示项目/.test(p.user))
  check('★★ 提示词逐条列出可引用依据（task:t1 / ledger:spend / git:commits）',
    /\[task:t1\]/.test(p.user) && /\[ledger:spend\]/.test(p.user) && /\[git:commits\]/.test(p.user))
  check('★★ 硬规则写死：只输出 JSON / 每条必须引用 / 不许写“已冻结”',
    /只输出一个 JSON/.test(p.system) && /cites 至少 1 个/.test(p.system) && /已冻结/.test(p.system))
}

console.log('\n== ② 解析：容忍围栏，坏 JSON 明确报错 ==')
{
  const ok = parsePlanDraftPayload('```json\n{"stages":[{"title":"A","approach":["x"]}]}\n```')
  check('★ ```json 围栏能剥', !ok.error && ok.stages.length === 1 && ok.stages[0].title === 'A')
  const noisy = parsePlanDraftPayload('好的，草案如下：{"stages":[]} 请过目')
  check('★ 前后废话能剥', !noisy.error && Array.isArray(noisy.stages))
  check('★ 坏 JSON → 明确报错（不静默当空草案）', /不完整|解析失败/.test(parsePlanDraftPayload('{oops').error || ''))
  check('★ 缺 stages → 明确报错', /缺少 stages/.test(parsePlanDraftPayload('{"x":1}').error || ''))
}

console.log('\n== ③ 校验：引不出依据的建议一律不进草案 ==')
{
  const good = {
    id: 'P0', title: '收口判据执行器', what: '四类判据真跑', approach: ['主进程 runner'],
    copy: [['CI checks', '判据结果', '并行调度', '四类各一条真跑']],
    criteria: ['cmd: node scripts/test/e2e-checks.cjs 退出码 0'],
    cites: ['task:t1', 'ledger:spend'],
  }
  const v = validateDraftStages([
    good,
    { title: '没依据', approach: ['x'], copy: [['a', 'b', 'c', 'd']], criteria: ['cmd: node x.js'], cites: [] },
    { title: '编来源', approach: ['x'], copy: [['a', 'b', 'c', 'd']], criteria: ['cmd: node x.js'], cites: ['task:nope'] },
    { title: '没机检判据', approach: ['x'], copy: [['a', 'b', 'c', 'd']], criteria: ['看起来不错'], cites: ['ledger:spend'] },
    { title: '已冻结违规', what: '这一格已冻结', approach: ['x'], copy: [['a', 'b', 'c', 'd']], criteria: ['cmd: node x.js'], cites: ['ledger:spend'] },
    { title: '照抄点空', approach: ['x'], copy: [], criteria: ['cmd: node x.js'], cites: ['ledger:spend'] },
  ], ALLOWED)
  check('★ 只有依据真实 + 判据可机检 + 照抄点非空的留下', v.stages.length === 1 && v.stages[0].title === '收口判据执行器')
  check('★★ 没引用 / 引用不存在 → missingCitations 如实计数（2）', v.missingCitations === 2, String(v.missingCitations))
  check('★ 每条被丢的都有人话原因（不是静默消失）',
    v.dropped.length === 5 && v.dropped.every((d) => typeof d.reason === 'string' && d.reason.length > 4),
    JSON.stringify(v.dropped))
  check('★ 留下那条的 cites 原样保留', v.stages[0].cites.join(',') === 'task:t1,ledger:spend')
}

// ── 异步部分 ──────────────────────────────────────────────────────────
async function main() {
  console.log('\n== ④ 生成：只落 _drafts / 状态恒待裁决 / 带证据 + 花销留痕 ==')
  let tracedCount = 0
  const traceFile = path.join(TEST_ROOT, 'ai-trace.jsonl')
  fs.writeFileSync(traceFile, '', 'utf-8')
  setTraceFilePathForTest(traceFile)

  const payload = {
    // 2026-11-10：宪法页 + 本轮要先问的问题 是硬要求（H2 三件套 / V1 机器版）
    constitution: [
      { kind: '已定', text: '判据必须能机检', cites: ['task:t1'] },
      { kind: '待定', text: '未知前缀算不算通过', cites: ['ledger:rejected'] },
    ],
    asks: [{ ask: '未知前缀要不要算 unknown？', why: '它决定执行器判红还是判不了' }],
    stages: [
      {
        id: 'P0', title: '判据执行器收口', what: '把四类前缀真跑起来',
        approach: ['main/checks/runner.ts 真执行', '未知前缀归 unknown'],
        copy: [['CI checks', '单条判据结果', '并行调度', '四类各一条真跑']],
        criteria: ['cmd: node scripts/test/e2e-checks.cjs 退出码 0', "str: desktop/src/shared/checkSpec.ts 含 'parseCheckLine'"],
        cites: ['task:t1', 'ledger:spend'],
      },
      { title: '无依据的凑数建议', approach: ['x'], copy: [['a', 'b', 'c', 'd']], criteria: ['cmd: node x.js'], cites: [] },
      { title: '乱引来源', approach: ['x'], copy: [['a', 'b', 'c', 'd']], criteria: ['cmd: node x.js'], cites: ['task:ghost'] },
      { title: '想自动冻结', approach: ['已冻结'], copy: [['a', 'b', 'c', 'd']], criteria: ['cmd: node x.js'], cites: ['ledger:output'] },
    ],
  }
  const result = await generatePlanDraft(INPUT, {
    now: '2026-11-01T00:00:00.000Z',
    callLlm: async () => ({ text: '```json\n' + JSON.stringify(payload) + '\n```', usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 }, model: 'fake-model' }),
    appendTrace: (rec) => { tracedCount++; fs.appendFileSync(traceFile, JSON.stringify(rec) + '\n', 'utf-8') },
  })
  check('★ 生成成功', result.ok === true, result.error)
  check('★ 只保留有依据的一条，其余如实列进 dropped', result.stages.length === 1 && result.dropped.length === 3,
    JSON.stringify({ stages: result.stages.length, dropped: result.dropped.length }))
  check('★★ 文件落在 task-data/plans/_drafts/<project>-<date>.md（不覆盖正式计划卡）',
    !!result.file && result.file.indexOf(path.join('task-data', 'plans', '_drafts')) >= 0
    && /demo-2026-11-01\.md$/.test(result.file), result.file)
  const text = fs.readFileSync(result.file, 'utf-8')
  check('★★ 生成物状态恒为“待裁决”', /^- 状态: 待裁决$/m.test(text), text.split('\n').slice(0, 6).join(' | '))
  check('★★ 生成物里不出现“已冻结”（出现即红）', !/已冻结/.test(text))
  check('★ 每张阶段卡都带 `- 依据:` 且引用真实 id', /^- 依据: task:t1 · ledger:spend$/m.test(text),
    (text.match(/^- 依据:.*$/m) || [''])[0])
  check('★ 五段齐全（范围 / 交付物 / 验收标准 / 里程碑 / 除外责任）',
    ['## 范围', '## 交付物', '## 验收标准', '## 里程碑', '## 除外责任'].every((h) => text.indexOf(h) >= 0))
  check('★★ 宪法页在草案里（一页结论，带类型与依据）',
    /## 宪法（一页结论）/.test(text) && /已定 \| 判据必须能机检/.test(text), text.slice(0, 500))
  check('★★ 本轮要先问的问题写进草案（V1 的机器版）',
    /## 本轮要先问的问题/.test(text) && /未知前缀要不要算/.test(text))
  check('★ 判据写成机器前缀（cmd/str）', /- cmd: node scripts\/test\/e2e-checks\.cjs/.test(text) && /- str:/.test(text))

  const tmpName = '_e2e-draft.md'
  fs.copyFileSync(result.file, path.join(TEST_ROOT, 'task-data', 'plans', tmpName))
  const doc = plans.readPlan(tmpName)
  check('★ 计划卡解析器读得懂草案（1 张卡 / 状态待裁决 / 判据 2 条）',
    !!doc && doc.stages.length === 1 && doc.stages[0].status === '待裁决' && doc.stages[0].criteria.length === 2,
    JSON.stringify(doc && doc.stages.map((s) => ({ st: s.status, n: s.criteria.length }))))
  fs.unlinkSync(path.join(TEST_ROOT, 'task-data', 'plans', tmpName))

  const traceLines = fs.readFileSync(traceFile, 'utf-8').split('\n').filter(Boolean)
  const rec = traceLines.map((l) => JSON.parse(l)).find((r) => r.trigger === 'plan-draft:demo')
  check('★★ 一次生成在 ai-trace.jsonl 留一条含 total_tokens 的记录',
    !!rec && rec.ok === true && rec.total_tokens === 300 && rec.prompt_tokens === 100 && rec.completion_tokens === 200,
    JSON.stringify(rec))
  check('★ 留痕恰好一条（不和 chatDetailed 的重复计费）', tracedCount === 1 && traceLines.length === 1, String(tracedCount))
  check('★ 用量的模型名在记录里（花销可归因）', !!rec && rec.model === 'fake-model', rec && rec.model)

  console.log('\n== ⑤ 不编：没有依据 / 全部引不出 → 拒绝，不生成 ==')
  let called = 0
  const r1 = await generatePlanDraft({ project: 'empty', tasks: [], ledger: null, git: null }, {
    callLlm: async () => { called++; return { text: '{"stages":[]}' } },
  })
  check('★★ 没有任何依据 → 直接拒绝，不调用模型（不编）',
    r1.ok === false && /没有可引用的依据/.test(r1.error || '') && called === 0,
    JSON.stringify({ ok: r1.ok, called }))

  const r2 = await generatePlanDraft(INPUT, {
    callLlm: async () => ({
      text: JSON.stringify({
        constitution: [{ kind: '已定', text: '有依据才进草案', cites: ['task:t1'] }],
        asks: [], asksNote: '现有决策已覆盖',
        stages: [{ title: 'A', approach: ['x'], copy: [['a', 'b', 'c', 'd']], criteria: ['cmd: node x.js'], cites: [] }],
      }),
      usage: { totalTokens: 5 },
    }),
    appendTrace: () => { /* 留痕失败不该影响判定 */ },
  })
  check('★★ 所有建议都引不出依据 → 整体拒绝（不是落一份空草案）',
    r2.ok === false && r2.missingCitations === 1, JSON.stringify({ ok: r2.ok, missing: r2.missingCitations }))

  console.log('\n== ⑦ 三条新硬闸：宪法页 / 必须先问 / 判据现状已满足 ==')
  {
    const stageOk = {
      id: 'P0', title: '有依据的阶段', what: '为什么现在做', approach: ['x'],
      copy: [['a', 'b', 'c', 'd']], criteria: ['cmd: node scripts/test/e2e-checks.cjs'], cites: ['task:t1'],
    }
    const cons = [{ kind: '已定', text: '先有依据再动手', cites: ['task:t1'] }]

    const noCons = await generatePlanDraft(INPUT, {
      callLlm: async () => ({ text: JSON.stringify({ asks: [], asksNote: '没有', stages: [stageOk] }) }),
      appendTrace: () => {},
    })
    check('★★ 没有宪法页 → 整份不合格（H2 三件套）',
      noCons.ok === false && /宪法/.test(noCons.error || ''), noCons.error)

    const noSettled = await generatePlanDraft(INPUT, {
      callLlm: async () => ({
        text: JSON.stringify({
          constitution: [{ kind: '待定', text: '还没定的事', cites: ['task:t1'] }],
          asks: [], asksNote: '没有', stages: [stageOk],
        }),
      }),
      appendTrace: () => {},
    })
    check('★★ 宪法里没有一条「已定」→ 不合格（那是待办清单，不是旗帜）',
      noSettled.ok === false && /已定/.test(noSettled.error || ''), noSettled.error)

    const noAsks = await generatePlanDraft(INPUT, {
      callLlm: async () => ({ text: JSON.stringify({ constitution: cons, stages: [stageOk] }) }),
      appendTrace: () => {},
    })
    check('★★ 没有「本轮要先问的问题」这一段 → 不合格',
      noAsks.ok === false && /先问/.test(noAsks.error || ''), noAsks.error)

    const emptyNoReason = await generatePlanDraft(INPUT, {
      callLlm: async () => ({ text: JSON.stringify({ constitution: cons, asks: [], stages: [stageOk] }) }),
      appendTrace: () => {},
    })
    check('★★ 没有新问题又不说理由 → 不合格',
      emptyNoReason.ok === false && /理由/.test(emptyNoReason.error || ''), emptyNoReason.error)

    // 判据现状体检：文件现在就存在 = 这条判据不构成验收
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-green-'))
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'docs', 'done.md'), '# 早就存在\n', 'utf-8')
    const g1 = validateDraftStages(
      [{ ...stageOk, criteria: ['file: docs/done.md'] }], ALLOWED, { repoRoot: repo })
    check('★★ 判据现状就已全部满足 → 该阶段被丢（不是留一张会假绿的卡）',
      g1.stages.length === 0 && g1.alreadyGreen === 1, JSON.stringify(g1.dropped))
    const g2 = validateDraftStages(
      [{ ...stageOk, criteria: ['file: docs/还没做.md'] }], ALLOWED, { repoRoot: repo })
    check('★ 文件还不存在 → 判据不算已满足（阶段留下）', g2.stages.length === 1, JSON.stringify(g2.dropped))
    const g3 = validateDraftStages(
      [{ ...stageOk, criteria: ['cmd: node scripts/test/e2e-checks.cjs'] }], ALLOWED, { repoRoot: repo })
    check('★ cmd 判据不跑（起草器不许执行任意命令）→ 不判“已满足”', g3.stages.length === 1)
    fs.rmSync(repo, { recursive: true, force: true })
  }

  console.log('\n== ⑥ 接线/边界守卫 ==')
  {
    const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')
    const SRC = read('desktop/src/main/llm/planDraft.ts')
    check('★ 草案只落 _drafts（不覆盖正式计划卡）', /plans', '_drafts'/.test(SRC) && /_drafts/.test(SRC))
    // 2026-11-02：改成走降级链 —— 主通道挂了自动换备用（chatWithFallback 内部仍调 chatDetailed）
    check('★ 走既有 BYOK 降级链（chatWithFallback + noTrace，自己写带 total_tokens 的留痕）',
      /chatWithFallback\(/.test(SRC) && /noTrace: true/.test(SRC) && /total_tokens/.test(SRC))
    check('★ 生成器没有"通过/冻结"能力（源码里没有 advanceStage / writePlanVerdict）',
      !/advanceStage|writePlanVerdict/.test(SRC))
    check('★ 状态只写“待裁决”（源码里不写 `状态: 已冻结`）', !/状态:\s*已冻结/.test(SRC))
    check('★ 引用校验只认真实存在的依据（allowed 集合，不许自由编）',
      /allowedCitations/.test(SRC) && /!allow\.has\(c\)/.test(SRC))
    check('★★ 三条新硬闸在源码里（宪法 / 先问 / 判据现状体检）',
      /validateConstitution/.test(SRC) && /asksNote/.test(SRC) && /evaluateCriteriaNow/.test(SRC))
    check('★★ 生成口超时放宽到 240s（实测 58.7s / 配置 60s，卡边界）',
      /timeout: 240/.test(SRC))
    check('★ 草案自我介绍不再硬编码“按产品定义 + 投入产出账…”（写真正进过上下文的来源）',
      /srcs\.join/.test(SRC) && !/方寸按“产品定义 \+ 投入产出账 \+ 现有卡与 git 事实”起草/.test(SRC))
    // 2026-11-10：agent 当大脑、方寸当闸 —— plan_submit 必须复用同一条管道与同一个闸
    const TOOLS = read('desktop/src/main/mcp/tools.ts')
    check('★★ plan_submit 存在，且复用 gateForDeck + generatePlanDraft（同一条管道，不另写一套校验）',
      /case 'plan_submit'/.test(TOOLS) && /gateForDeck\(deck, proj\)/.test(TOOLS) && /model: 'agent'/.test(TOOLS))
    check('★★ 生成口不再有“关思考”开关（reasoning 参数已删）', !/reasoning:\s*'off'/.test(SRC) && !/reasoning\?:/.test(read('desktop/src/main/llm/chat.ts')))
  }

  finish()
}

main().catch((e) => {
  console.error('FAIL  测试驱动异常：' + ((e && e.stack) || e))
  process.exit(1)
})
