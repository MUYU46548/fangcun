/**
 * 作战计划 P4 · 跑判据 / 推进一格的**界面入口**（2026-11-02）
 *
 * 为什么单独一套：`e2e-stage-gate` 测的是闸门纯逻辑、`e2e-checks` 测的是执行器，
 * 但 P4 真正要命的不是这两块，是**它们接起来之后写不写盘**：
 *   · 判据没过 → 卡上只能停在“未完成”，打回理由必须有原文 + 实际值；
 *   · 判据全过 → 才写得进“完成”+ 证据；
 *   · 跑判据本身**只读**（跑完计划卡一个字节都不变）。
 *
 * 而且这里是**唯一允许起进程**的地方（plan-run-ipc.ts）：
 * 打开计划卡走的是 plan-ipc.ts，那个文件里连 `runCriterion` 这个名字都不许出现。
 *
 * 运行：node scripts/test/e2e-plan-run.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── electron 桩注入（必须先于业务模块） ──
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const ROOT = path.join(os.tmpdir(), 'fc-plan-run-' + Date.now())
process.env.FC_TEST_USERDATA = path.join(ROOT, 'userdata')
fs.mkdirSync(process.env.FC_TEST_USERDATA, { recursive: true })

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')) }
}
function eq(name, actual, expected) { check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`) }

// ── 夹具：一份真计划卡 + 一个真文件 ──────────────────────────────
function writePlan(body) {
  const dir = path.join(ROOT, 'task-data', 'plans')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'test-plan.md'), body, 'utf-8')
}

function cards() {
  return [
    '# 测试计划', '', '- 状态: 已冻结', '',
    '## 范围', '夹具。', '',
    '## 交付物', '夹具。', '',
    '## 验收标准', '夹具。', '',
    '## 里程碑', '夹具。', '',
    '## 除外责任', '夹具。', '',
    '---', '', '## 阶段卡', '',
    '### P0 · 全过的那一格', '',
    '- 状态: 已冻结',
    '- 做什么: 判据全过',
    '- 技术方案:',
    '  - 用临时文件',
    '- 照抄点:', '',
    '| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |',
    '|---|---|---|---|',
    '| a | b | c | d |', '',
    '- 判据:', '',
    '  - cmd: node -e "process.exit(0)"',
    "  - str: fixtures/a.txt 含 'HELLO'",
    '  - num: fixtures/a.txt 行数 >= 2',
    '  - file: fixtures/a.txt 存在', '',
    '### P1 · 有未过判据', '',
    '- 状态: 已冻结',
    '- 做什么: 一条 fail 一条 pass',
    '- 技术方案:',
    '  - 不用',
    '- 照抄点:', '',
    '| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |',
    '|---|---|---|---|',
    '| a | b | c | d |', '',
    '- 判据:', '',
    '  - cmd: node -e "process.exit(3)"',
    "  - str: fixtures/a.txt 含 'NOT-THERE'", '',
    '### P2 · 有未判定', '',
    '- 状态: 已冻结',
    '- 做什么: 散文判据',
    '- 技术方案:',
    '  - 不用',
    '- 照抄点:', '',
    '| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |',
    '|---|---|---|---|',
    '| a | b | c | d |', '',
    '- 判据:', '',
    '  - foo: 这条机器判不了', '',
    '### P3 · 还没裁决', '',
    '- 状态: 待裁决',
    '- 做什么: 判据全过但不许推',
    '- 技术方案:',
    '  - 不用',
    '- 照抄点:', '',
    '| 抄哪块 | 落到哪 | 不抄什么 | 怎么算抄到位 |',
    '|---|---|---|---|',
    '| a | b | c | d |', '',
    '- 判据:', '',
    '  - cmd: node -e "process.exit(0)"', '',
  ].join('\n')
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'fixtures'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'fixtures', 'a.txt'), 'HELLO\nWORLD\n', 'utf-8')
  writePlan(cards())

  // ── 注册真 handler（把 ipcMain.handle 换成捕获器，之后像客户端一样 invoke） ──
  const stub = require(STUB)
  const handlers = new Map()
  stub.ipcMain.handle = (ch, fn) => { handlers.set(ch, fn) }
  const data = require(path.join(DIST, 'data', 'index.js'))
  data.setDataDir(ROOT)

  console.log('\n== ① handler 真的注册了两个通道 ==')
  require(path.join(DIST, 'plan-run-ipc.js')).registerPlanRunIpcHandlers()
  check('注册了 plans:checks', handlers.has('plans:checks'))
  check('注册了 plans:advance', handlers.has('plans:advance'))
  check('没有顺手多注册别的通道（就这两个）', handlers.size === 2, [...handlers.keys()].join(','))

  const checks = handlers.get('plans:checks')
  const advance = handlers.get('plans:advance')

  console.log('\n== ② 跑判据：四类真跑，结果与闸门 ==')
  const before = fs.readFileSync(path.join(ROOT, 'task-data', 'plans', 'test-plan.md'), 'utf-8')
  const r0 = await checks({}, { file: 'test-plan.md', stageId: 'P0', repo: ROOT })
  check('P0 通道 ok', r0.ok === true, r0.error)
  check('P0 四类判据逐条有结果', (r0.results || []).length === 4, String((r0.results || []).length))
  check('P0 全部 pass', (r0.results || []).every((r) => r.state === 'pass'),
    (r0.results || []).map((r) => r.state + ':' + r.kind).join(' '))
  check('P0 四类各出现一次（cmd/str/num/file）',
    ['cmd', 'str', 'num', 'file'].every((k) => (r0.results || []).some((r) => r.kind === k)))
  check('P0 闸门放行', r0.gate.canAdvance === true, JSON.stringify(r0.gate.blocked))
  const after = fs.readFileSync(path.join(ROOT, 'task-data', 'plans', 'test-plan.md'), 'utf-8')
  check('★★ 跑判据只读：计划卡一个字节都没变', before === after)

  const r1 = await checks({}, { file: 'test-plan.md', stageId: 'P1', repo: ROOT })
  check('P1 闸门不放行', r1.gate.canAdvance === false)
  eq('P1 未过 1 条 / 未判定 0 条', [r1.gate.failed, r1.gate.unknown], [2, 0])
  const b1 = (r1.gate.blocked || []).map((b) => b.raw + ' → ' + b.actual).join('\n')
  check('★★ 打回带 diff：每条被挡的判据都有原文 + 实际值',
    (r1.gate.blocked || []).length === 2 && /实际值/.test(b1) && /process\.exit\(3\)/.test(b1), b1)

  const r2 = await checks({}, { file: 'test-plan.md', stageId: 'P2', repo: ROOT })
  eq('P2 unknown 单独计数（不算 fail）', [r2.gate.failed, r2.gate.unknown], [0, 1])
  check('P2 unknown 的 detail 说人话（不是“未过”）',
    /未知前缀|判不了/.test(String(r2.results[0].detail)), String(r2.results[0].detail))
  check('P2 同样挡路（unknown 也挡）', r2.gate.canAdvance === false)

  console.log('\n== ③ 推进：判据全过才写得进“完成” ==')
  const a0 = await advance({}, { file: 'test-plan.md', stageId: 'P0', repo: ROOT })
  check('P0 推进成功', a0.ok === true && a0.advanced === true, JSON.stringify({ ok: a0.ok, advanced: a0.advanced, error: a0.error }))
  check('P0 没被标成 blocked（成功就不是挡下）', a0.blocked === false)
  const after0 = fs.readFileSync(path.join(ROOT, 'task-data', 'plans', 'test-plan.md'), 'utf-8')
  check('★★ 盘上真写了“- 状态: 完成”', /^- 状态: 完成$/m.test(after0))
  check('★★ 完成带一条证据引用', /^- 证据: .*4\/4 判据通过/m.test(after0), (after0.match(/^- 证据: .*$/m) || [''])[0])

  console.log('\n== ④ 推进：判据没过只能停“未完成”+ 打回理由 ==')
  const a1 = await advance({}, { file: 'test-plan.md', stageId: 'P1', repo: ROOT })
  check('P1 没推进', a1.advanced === false)
  check('★★ 被闸门挡下是正常业务结果：ok=true + blocked=true（不是通道失败）',
    a1.ok === true && a1.blocked === true, JSON.stringify({ ok: a1.ok, blocked: a1.blocked, error: a1.error }))
  const after1 = fs.readFileSync(path.join(ROOT, 'task-data', 'plans', 'test-plan.md'), 'utf-8')
  check('★★ 盘上只能写“- 状态: 未完成”', /^- 状态: 未完成$/m.test(after1))
  const reason = (after1.match(/^- 打回理由: (.*)$/m) || ['', ''])[1]
  check('★★ 打回理由含判据原文', reason.includes('process.exit(3)'), reason)
  check('★★ 打回理由含实际值', reason.includes('实际值'), reason)

  console.log('\n== ⑤ 未裁决的卡：判据全过也不许推 ==')
  const a3 = await advance({}, { file: 'test-plan.md', stageId: 'P3', repo: ROOT })
  check('P3 没推进', a3.advanced === false)
  check('P3 给的是“先裁决”而不是“判据没过”',
    /裁决|冻结/.test(String(a3.error)) && a3.blocked === false, String(a3.error))

  console.log('\n== ⑥ 坏入参：不抛、不写盘 ==')
  const snap = fs.readFileSync(path.join(ROOT, 'task-data', 'plans', 'test-plan.md'), 'utf-8')
  const bad1 = await checks({}, { file: 'nope.md', stageId: 'P0', repo: ROOT })
  check('不存在的卡 → ok:false + 可读原因', bad1.ok === false && /不存在/.test(String(bad1.error)), String(bad1.error))
  const bad2 = await checks({}, { file: 'test-plan.md', stageId: 'P9', repo: ROOT })
  check('不存在的阶段 → ok:false + 带阶段号', bad2.ok === false && /P9/.test(String(bad2.error)), String(bad2.error))
  const bad3 = await advance({}, { file: 'nope.md', stageId: 'P0' })
  check('advance 坏入参 → advanced:false（不假装成功）', bad3.ok === false && bad3.advanced === false)
  check('坏入参一个字节都没改计划卡', fs.readFileSync(path.join(ROOT, 'task-data', 'plans', 'test-plan.md'), 'utf-8') === snap)

  console.log('\n== ⑦ 结构守卫：执行器只能在 plan-run-ipc 里 ==')
  const runSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'plan-run-ipc.ts'), 'utf-8')
  const readSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'plan-ipc.ts'), 'utf-8')
  check('★★ 读口（plan-ipc.ts）里没有执行器 —— 打开计划卡不会跑命令',
    !/runCriterion|runCriteria|checks\/runner/.test(readSrc))
  check('执行器确实挂在运行口里', /runCriteria/.test(runSrc))
  check('运行口自己也不写文件（写回交给 data/plans.advanceStage）',
    !/writeFileSync|appendFileSync|createWriteStream/.test(runSrc))
  const indexSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'index.ts'), 'utf-8')
  check('★ 两个注册函数都在真实入口 index.ts 里调用（不是假入口）',
    /registerPlanIpcHandlers\(\)/.test(indexSrc) && /registerPlanRunIpcHandlers\(\)/.test(indexSrc))
  const preloadSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'preload', 'index.ts'), 'utf-8')
  check('★ preload 暴露了 plansChecks / plansAdvance（否则按钮是死的）',
    /plansChecks/.test(preloadSrc) && /plansAdvance/.test(preloadSrc))
  const viewSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'views', 'PlanView.vue'), 'utf-8')
  check('★ 界面真的调了这两个通道', /plansChecks\(/.test(viewSrc) && /plansAdvance\(/.test(viewSrc))
  check('★ 界面没有自己算闸门（不许再写一套准入逻辑）',
    !/canAdvance\s*:/.test(viewSrc) && !/passed\s*===\s*total/.test(viewSrc))

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) { console.log('\n失败项：'); for (const f of failures) console.log('  · ' + f) }
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('EXCEPTION', e); process.exit(2) })
