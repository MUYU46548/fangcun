#!/usr/bin/env node
/**
 * 阶段推进闸门 e2e（0.6.0 P4，2026-11-01）
 *
 * 真跑**编译产物**：`dist/shared/stageGate.js`（判定）+ `dist/main/data/plans.js`（写回）。
 * 临时数据目录里造计划卡，本机可跑；不碰真实计划卡（只在最后一节做只读/拒绝验证）。
 *
 * 判据一句话：**判据不过就不许跨格** ——
 *   · 任何一条 fail / unknown 都挡住（unknown 不是通过）；
 *   · 没判据也挡住（没判据 = 没验过）；
 *   · 被挡时状态只能停在「未完成」，且打回理由必须同时含**判据原文 + 实际值**；
 *   · 全过才写「完成」+ 一条证据引用。
 *
 * 运行：node scripts/test/e2e-stage-gate.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const GATE_ART = path.join(REPO, 'desktop', 'dist', 'shared', 'stageGate.js')
const PLANS_ART = path.join(REPO, 'desktop', 'dist', 'main', 'data', 'plans.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

for (const art of [GATE_ART, PLANS_ART]) {
  if (!fs.existsSync(art)) {
    console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + art)
    console.log('RESULT 0 / 1')
    process.exit(1)
  }
}
const { evaluateStageGate } = require(GATE_ART)

const TEST_ROOT = path.join(os.tmpdir(), 'fc-stage-gate-' + Date.now())
process.env.FC_TEST_USERDATA = path.join(TEST_ROOT, '.userdata')
fs.mkdirSync(path.join(TEST_ROOT, 'task-data', 'plans'), { recursive: true })
fs.mkdirSync(process.env.FC_TEST_USERDATA, { recursive: true })
fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'members: []\nprojects: []\n', 'utf-8')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return path.join(__dirname, 'electron-stub.cjs')
  return origResolve.call(this, request, ...args)
}
const data = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'index.js'))
data.setDataDir(TEST_ROOT)
const plans = require(PLANS_ART)
const PLAN_FILE = path.join(TEST_ROOT, 'task-data', 'plans', 'demo.md')

const PASS_CMD = { raw: 'cmd: node -e "process.exit(0)"', state: 'pass', detail: '退出码 0' }
const FAIL_NUM = {
  raw: 'num: docs/x.md 行数 >= 4', state: 'fail',
  detail: '行数 = 2，要求 >= 4', evidence: { actual: 2 },
}
const UNKNOWN_STR = {
  raw: "str: docs/x.md 含 'abc'", state: 'unknown', detail: '文件不存在',
}

console.log('== ① 闸门纯逻辑：全过才放行 ==')
{
  const ok = evaluateStageGate([PASS_CMD, { ...PASS_CMD, raw: 'str: a/b.md 含 \'x\'', state: 'pass' }])
  check('★ 全部 pass → canAdvance=true', ok.canAdvance === true && ok.passed === 2 && ok.failed === 0 && ok.unknown === 0)
  check('★ 全过时 diff 为空（没有可打回的东西）', ok.diff === '')
  check('★ reason 说清"可以完成这一格"', /可以完成/.test(ok.reason), ok.reason)

  const bad = evaluateStageGate([PASS_CMD, FAIL_NUM])
  check('★★ 一条 fail → canAdvance=false', bad.canAdvance === false && bad.failed === 1, JSON.stringify(bad))
  check('★ fail 进 blocked，且带原文', bad.blocked.length === 1 && bad.blocked[0].raw === FAIL_NUM.raw)
  check('★★ diff 同时含判据原文与实际值（打回带 diff）',
    bad.diff.includes(FAIL_NUM.raw) && /实际值\s*2/.test(bad.diff), bad.diff)

  const unk = evaluateStageGate([PASS_CMD, UNKNOWN_STR])
  check('★★ unknown 也挡住（未知不是通过）', unk.canAdvance === false && unk.unknown === 1, JSON.stringify(unk))
  check('★ 未判定与实际值分开说', /未判定/.test(unk.diff) && /未判定/.test(unk.reason), unk.diff)

  const empty = evaluateStageGate([])
  check('★★ 空判据 = 不许跨格（没判据 ≠ 验过了）',
    empty.canAdvance === false && /没有判据/.test(empty.reason), empty.reason)
  check('★ 空判据的 diff 不编实际值，只说原因', /没判据/.test(empty.diff) && empty.blocked.length === 0)

  const mixed = evaluateStageGate([FAIL_NUM, UNKNOWN_STR, PASS_CMD])
  check('★ 1 未过 + 1 未判定 + 1 通过 → 计数与阻塞行都清楚',
    mixed.total === 3 && mixed.passed === 1 && mixed.failed === 1 && mixed.unknown === 1
    && mixed.blocked.length === 2, JSON.stringify({ t: mixed.total, p: mixed.passed, f: mixed.failed, u: mixed.unknown }))
  check('★ 不修改传入数组（纯函数）', [FAIL_NUM, UNKNOWN_STR, PASS_CMD].map((c) => c.state).join(',') === 'fail,unknown,pass')
}

// ── 造一张计划卡（P4 已冻结，P5 待裁决）────────────────────────────────
const PLAN_TEXT = `# 测试计划

## 阶段卡

### P4 · 闭环测试

- 状态: 已冻结
- 做什么: 把闸门跑一遍
- 判据:

  - num: docs/x.md 行数 >= 4
  - cmd: node -e "process.exit(0)"

### P5 · 还没裁决

- 状态: 待裁决
- 做什么: 不该被推进

## 修订记录

- 2026-11-01 · 初始

---
`
fs.writeFileSync(PLAN_FILE, PLAN_TEXT, 'utf-8')

console.log('\n== ② 被挡：状态只能停在「未完成」+ 打回理由带 diff ==')
let rejected = 0
{
  const gate = evaluateStageGate([FAIL_NUM, PASS_CMD])
  const r = plans.advanceStage({ file: 'demo.md', stageId: 'P4', gate, now: '2026-11-01T00:00:00.000Z' })
  if (!r.advanced) rejected++
  check('★★ 注入一条未过判据 → 跨格尝试被拒（计数 = 1）', rejected === 1 && r.advanced === false, JSON.stringify({ rejected, advanced: r.advanced }))
  check('★ 返回可读原因', /判据未过/.test(r.error || ''), r.error)
  const text = fs.readFileSync(PLAN_FILE, 'utf-8')
  check('★★ 状态只能停在「未完成」，写不进「完成」',
    /^- 状态: 未完成$/m.test(text) && !/^- 状态: 完成$/m.test(text), text.split('\n').filter((l) => l.startsWith('- 状态')).join(' | '))
  const reasonLine = (text.match(/^- 打回理由: (.*)$/m) || [])[1] || ''
  check('★★ 打回理由同时含「判据原文」与「实际值」',
    reasonLine.includes(FAIL_NUM.raw) && /实际值\s*2/.test(reasonLine), reasonLine)
  check('★ 打回理由是一行（不把多行 diff 撑进 frontmatter 结构）', !!reasonLine && reasonLine.indexOf('\n') < 0)
  check('★ 修订记录多一条 P4 打回', /P4 打回：1 未过 \/ 0 未判定/.test(text), text.split('\n').filter((l) => l.includes('P4 打回')).join(' | '))
  check('★ 行级就地改：无关行与标题原样还在',
    /- 做什么: 把闸门跑一遍/.test(text) && /### P5 · 还没裁决/.test(text) && /## 修订记录/.test(text))
}

console.log('\n== ③ 重试全过：写「完成」+ 证据引用 ==')
{
  const gate = evaluateStageGate([{ ...FAIL_NUM, state: 'pass', detail: '行数 = 4，要求 >= 4', evidence: { actual: 4 } }, PASS_CMD])
  check('前置：闸门放行', gate.canAdvance === true)
  const r = plans.advanceStage({
    file: 'demo.md', stageId: 'P4', gate,
    evidenceRef: 'node scripts/test/e2e-stage-gate.cjs',
    now: '2026-11-02T01:02:03.000Z',
  })
  check('★ 全部通过 → advanced=true', r.ok === true && r.advanced === true, JSON.stringify({ ok: r.ok, err: r.error }))
  const text = fs.readFileSync(PLAN_FILE, 'utf-8')
  check('★★ 该格真的变成「完成」', /^- 状态: 完成$/m.test(text), text.split('\n').filter((l) => l.startsWith('- 状态')).join(' | '))
  const evidenceLine = (text.match(/^- 证据: (.*)$/m) || [])[1] || ''
  check('★★ 带一条证据引用（报告/命令）+ 通过数',
    evidenceLine.includes('node scripts/test/e2e-stage-gate.cjs') && evidenceLine.includes('2/2 判据通过'), evidenceLine)
  check('★ 修订记录多一条「判据全过 → 完成」', /P4 判据全过 → 完成（2\/2）/.test(text))
  check('★ 重新读计划卡，evidence 字段解析得到', (() => {
    const doc = plans.readPlan('demo.md')
    const s = doc && doc.stages.find((x) => x.id === 'P4')
    return !!s && s.status === '完成' && /e2e-stage-gate/.test(s.evidence)
  })())
}

console.log('\n== ④ 防御：未裁决的卡、坏闸门、unknown ==')
{
  const before = fs.readFileSync(PLAN_FILE, 'utf-8')
  const passing = evaluateStageGate([PASS_CMD])
  const r = plans.advanceStage({ file: 'demo.md', stageId: 'P5', gate: passing })
  check('★★ 待裁决的格子即使闸门放行也不许推进（还没批准）',
    r.advanced === false && /还没裁决/.test(r.error || ''), r.error)
  check('  P5 文件一字未动', fs.readFileSync(PLAN_FILE, 'utf-8') === before)

  const bad = plans.advanceStage({ file: 'demo.md', stageId: 'P4', gate: { canAdvance: true, total: 2, passed: 1, failed: 1, unknown: 0, blocked: [], diff: '', reason: '' } })
  check('★★ 闸门自相矛盾（说放行但没全过）→ 拒绝，不写盘',
    bad.advanced === false && /自相矛盾/.test(bad.error || ''), bad.error)
  check('  矛盾输入没改文件', fs.readFileSync(PLAN_FILE, 'utf-8') === before)

  const noGate = plans.advanceStage({ file: 'demo.md', stageId: 'P4', gate: null })
  check('★ 没跑判据（gate=null）→ 拒绝', noGate.advanced === false && /闸门结果缺失/.test(noGate.error || ''))
}

console.log('\n== ⑤ 真卡：未裁决的 P4 不许被误推进（只读验证）==')
{
  const real = path.join(REPO, 'task-data', 'plans', 'fangcun-base.md')
  if (!fs.existsSync(real)) {
    console.log('SKIP  真实计划卡不在场')
  } else {
    // 切回真实数据根（只读验证完再切回临时根，别影响后面的断言）
    data.setDataDir(REPO)
    const beforeText = fs.readFileSync(real, 'utf-8')
    const beforeStat = fs.statSync(real)
    const gate = evaluateStageGate([PASS_CMD]) // 假装全过
    const r = plans.advanceStage({ file: 'fangcun-base.md', stageId: 'P4', gate })
    check('★★ 真卡 P4 还是「待裁决」→ 即使判据全过也拒绝推进',
      r.advanced === false && /还没裁决/.test(r.error || ''), r.error)
    check('★ 真卡零改动（字节 + mtime 都不变）',
      fs.readFileSync(real, 'utf-8') === beforeText && fs.statSync(real).mtimeMs === beforeStat.mtimeMs)
    data.setDataDir(TEST_ROOT)
  }
}

console.log('\n== ⑥ 接线/边界守卫 ==')
{
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')
  const GATE = read('desktop/src/shared/stageGate.ts')
  check('★ 闸门是纯逻辑（不 import fs / child_process / electron）',
    !/from 'fs'|from 'child_process'|from 'electron'/.test(GATE))
  const PLANVIEW = read('desktop/src/renderer/views/PlanView.vue')
  check('★ 计划页会显示 `- 证据:`（完成依据看得见）',
    /s\.evidence/.test(PLANVIEW) && /plan-evidence/.test(PLANVIEW))
  const IPC = read('desktop/src/main/plan-ipc.ts')
  check('★ 没有为了推进偷偷加第三个 IPC 口（仍是 plans:get / plans:verdict）',
    (IPC.match(/guardedHandle\('/g) || []).length === 2)
  const PLANS_SRC = read('desktop/src/main/data/plans.ts')
  check('★ 推进写回仍走 plans.ts（不开第二套计划卡写路径）',
    /export function advanceStage/.test(PLANS_SRC) && /writePlanVerdict/.test(PLANS_SRC))
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log(' - ' + f)) }
try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
