/**
 * 收卡机检（ADR-003 一期 · 外部 agent 交单的收卡侧，2026-11-02）
 *
 * 判据一句话：**东西交进来那一刻就要能判，判不过也不许把东西弄丢。**
 *   · 四类判据全部真跑：str / count / format / file；
 *   · unknown ≠ pass（未知前缀、cmd:、坏正则都算未判定，挡住"全过"）；
 *   · 没写判据 = 收不了（不是"没东西要验"）；
 *   · **不阻挡落卡**：机检不过照样建卡（落“草稿”+ 正文红标 + 逐条留痕），
 *     全过才落“待审批”（REV-009）。
 *
 * 运行：node scripts/test/e2e-intake.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')
const ROOT = path.join(os.tmpdir(), 'fc-intake-' + Date.now())
process.env.FC_TEST_USERDATA = path.join(ROOT, 'userdata')
fs.mkdirSync(path.join(ROOT, 'task-data'), { recursive: true })
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'docs', 'real.md'), '# 真文件\n', 'utf-8')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')) }
}

const intake = require(path.join(DIST, 'shared', 'intake.js'))
const { checkDeliverable, checkIntakeLine, renderIntakeSection, countOccurrences } = intake

const DELIV = [
  '# 交付物 · 示例',
  '',
  '| 英雄 | 阵营 |',
  '|---|---|',
  '| 林雪 | 北境 |',
  '| 韩青 | 南疆 |',
  '',
  '证据：scripts/test/e2e-intake.cjs 退出码 0',
].join('\n')

;(async () => {
  console.log('== ① 四类判据各真跑（pass 与 fail 都要有）==')
  const r1 = checkIntakeLine("str: '林雪'", DELIV)
  check('str: 命中 → pass', r1.kind === 'str' && r1.state === 'pass', r1.detail)
  const r1b = checkIntakeLine("str: '不存在的人'", DELIV)
  check('str: 不命中 → fail', r1b.state === 'fail', r1b.detail)

  const r2 = checkIntakeLine("count: '林雪' == 1", DELIV)
  check('count: 数得准（林雪出现 1 次）→ pass', r2.state === 'pass', r2.detail)
  const r2b = checkIntakeLine("count: '英雄' >= 2", DELIV)
  check('count: 支持 >=（实际 1 次，要求 ≥2）→ fail', r2b.state === 'fail', r2b.detail)
  check('countOccurrences 不重叠计数', countOccurrences('aaa', 'aa') === 1, String(countOccurrences('aaa', 'aa')))

  const r3 = checkIntakeLine('format: /^# 交付物/', DELIV)
  check('format: 正则命中 → pass', r3.state === 'pass', r3.detail)
  const r3b = checkIntakeLine('format: /^## 不存在的标题/', DELIV)
  check('format: 正则不命中 → fail', r3b.state === 'fail', r3b.detail)
  const r3c = checkIntakeLine('format: /([unclosed/', DELIV)
  check('★★ 坏正则 → unknown（绝不判成 fail：那会冤枉合格交付物）', r3c.state === 'unknown', r3c.detail)

  const exists = (rel) => fs.existsSync(path.join(ROOT, rel))
  const r4 = checkIntakeLine('file: docs/real.md 存在', DELIV, { exists })
  check('file: 真存在 → pass', r4.state === 'pass', r4.detail)
  const r4b = checkIntakeLine('file: docs/nope.md 存在', DELIV, { exists })
  check('file: 不存在 → fail', r4b.state === 'fail', r4b.detail)
  const r4c = checkIntakeLine('file: docs/real.md 存在', DELIV)
  check('★ 没注入存在性检查 → unknown（不猜）', r4c.state === 'unknown', r4c.detail)

  console.log('\n== ② 未判定事项一律不算通过 ==')
  const u1 = checkIntakeLine('cmd: node scripts/test/e2e-x.cjs 退出码 0', DELIV)
  check('★★ cmd: 在收卡时是 unknown（跑套件归“待验收”，收卡不起进程）',
    u1.state === 'unknown' && /待验收/.test(u1.detail), u1.detail)
  const u2 = checkIntakeLine('foo: 随便写的', DELIV)
  check('未知前缀 → unknown', u2.state === 'unknown', u2.detail)
  const u3 = checkIntakeLine('随便一句没有前缀', DELIV)
  check('没有前缀 → unknown', u3.state === 'unknown', u3.detail)
  const u4 = checkIntakeLine("str: 没引号的原文", DELIV)
  check('str: 不带引号 → unknown（不拿整句去搜）', u4.state === 'unknown', u4.detail)

  console.log('\n== ③ 整体报告：全过才 ok，缺判据就是收不了 ==')
  const allPass = checkDeliverable(DELIV, [
    "str: '林雪'", "count: '林雪' == 1", 'format: /^# 交付物/', 'file: docs/real.md 存在',
  ], { exists })
  check('★★ 四类全过 → ok=true、4/4', allPass.ok === true && allPass.passed === 4 && allPass.total === 4,
    JSON.stringify({ ok: allPass.ok, p: allPass.passed, t: allPass.total }))
  check('  全过时 summary 说“全过”', /全过/.test(allPass.summary), allPass.summary)

  const mixed = checkDeliverable(DELIV, [
    "str: '林雪'", "str: '查无此人'", 'file: docs/absent.md 存在', 'cmd: echo hi',
  ], { exists })
  check('★★ 1 过 / 2 不过 / 1 未判定 → ok=false', mixed.ok === false
    && mixed.passed === 1 && mixed.failed === 2 && mixed.unknown === 1,
    JSON.stringify({ p: mixed.passed, f: mixed.failed, u: mixed.unknown }))
  check('★★ 红标逐条给原文 + 实际值', mixed.redFlags.length === 3
    && mixed.redFlags.every((r) => /“.+”→/.test(r)), mixed.redFlags.join(' | '))

  const noCriteria = checkDeliverable(DELIV, [])
  check('★★ 没写判据 → ok=false（没判据就验不了，不是"没东西要验"）',
    noCriteria.ok === false && noCriteria.total === 0 && /没写判据/.test(noCriteria.summary), noCriteria.summary)

  const emptyDeliv = checkDeliverable('', ["str: '林雪'", 'file: docs/real.md 存在'], { exists })
  // file 判据与交付物内容无关（文件在就是在），所以只断言"内容类判据"必须不过
  check('★★ 空交付物 → 内容类判据全不过（不是 pass）',
    emptyDeliv.ok === false
    && emptyDeliv.rows.filter((r) => r.kind === 'str').every((r) => r.state === 'fail'),
    JSON.stringify(emptyDeliv.rows.map((r) => r.kind + ':' + r.state)))

  console.log('\n== ④ 留痕：报告能渲染成卡正文的一节 ==')
  const sec = renderIntakeSection(mixed, { at: '2026-11-02T00:00:00.000Z', agent: 'quanzhan', model: 'm' })
  check('★ 含“收卡机检”节与时间/交单人', /^## 收卡机检/m.test(sec) && /quanzhan/.test(sec) && /2026-11-02/.test(sec))
  check('★★ 含红标节且逐条列出不过项', /⚠ 红标/.test(sec) && /查无此人/.test(sec), sec.slice(0, 200))
  check('★ 明写“不阻挡落卡”的口径（读卡的人知道这是红标不是拒收）', /不阻挡落卡/.test(sec))

  console.log('\n== ⑤ MCP intake_task 端到端（真落卡）==')
  const data = require(path.join(DIST, 'main', 'data', 'index.js'))
  data.setDataDir(ROOT)
  const { MCP_TOOLS, handleMCPToolCall } = require(path.join(DIST, 'main', 'mcp', 'tools.js'))
  check('★ MCP 工具清单里有 intake_task', MCP_TOOLS.some((t) => t.name === 'intake_task'))

  const okRes = handleMCPToolCall('intake_task', {
    title: '收卡 · 全过的那一份',
    project: 'fangcun-base',
    deliverable: DELIV,
    criteria: ["str: '林雪'", "count: '林雪' == 1", 'format: /^# 交付物/', 'file: docs/real.md 存在'],
    agent: 'quanzhan',
  })
  const okBody = JSON.parse(okRes.content[0].text)
  check('★★ 全过 → 落“待审批”（REV-009 口径）', okBody.ok === true && okBody.status === '待审批',
    JSON.stringify({ ok: okBody.ok, status: okBody.status }))
  const okTask = data.loadTasks().find((t) => t.id === okBody.id)
  check('★ 卡真的落盘了', !!okTask)
  check('★★ 卡正文带交付物 + 收卡机检一节', !!okTask && /## 交付物/.test(okTask.body)
    && /## 收卡机检/.test(okTask.body) && /林雪/.test(okTask.body))

  const badRes = handleMCPToolCall('intake_task', {
    title: '收卡 · 有不过的那一份',
    project: 'fangcun-base',
    deliverable: DELIV,
    criteria: ["str: '林雪'", "str: '查无此人'", 'file: docs/absent.md 存在'],
    agent: 'quanzhan',
  })
  const badBody = JSON.parse(badRes.content[0].text)
  check('★★ 有不过 → 落“草稿”（不进待审批，但卡照样建）',
    badBody.ok === true && badBody.status === '草稿', JSON.stringify({ ok: badBody.ok, status: badBody.status }))
  check('★★ 不阻挡：卡真的存在（东西没丢）',
    !!data.loadTasks().find((t) => t.id === badBody.id))
  const badTask = data.loadTasks().find((t) => t.id === badBody.id)
  check('★★ 正文里红标逐条列出不过项（用户打开卡就看得见）',
    !!badTask && /⚠ 红标/.test(badTask.body) && /查无此人/.test(badTask.body) && /absent\.md/.test(badTask.body),
    badTask ? badTask.body.slice(0, 160) : '(没有卡)')
  check('★ 返回体里也带 redFlags（agent 据此返工）',
    Array.isArray(badBody.intake.redFlags) && badBody.intake.redFlags.length === 2,
    JSON.stringify(badBody.intake.redFlags))
  check('★ 返回体给出下一步（全过/不过两种话术不同）',
    /待审批/.test(okBody.next) && /返工/.test(badBody.next),
    okBody.next + ' || ' + badBody.next)

  const emptyRes = handleMCPToolCall('intake_task', {
    title: '收卡 · 交单方啥都没交', project: 'fangcun-base', deliverable: '', criteria: ["str: 'x'"],
  })
  const emptyBody = JSON.parse(emptyRes.content[0].text)
  check('★★ 空交付物也照样落卡（拒收 = 丢东西，这里明令不许）',
    emptyBody.ok === true && !!data.loadTasks().find((t) => t.id === emptyBody.id))

  console.log('\n== ⑥ 越界路径：file: 不许读机器上任意文件 ==')
  const svc = require(path.join(DIST, 'main', 'services', 'intake.js'))
  check('★ file: ../../ 逃逸 → false', svc.repoFileExists('../../etc/passwd', ROOT) === false)
  check('★ file: 绝对路径 → false', svc.repoFileExists('C:/Windows/win.ini', ROOT) === false)
  check('★ file: 仓内真实文件 → true', svc.repoFileExists('docs/real.md', ROOT) === true)

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) { console.log('\n失败项：'); for (const f of failures) console.log('  · ' + f) }
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2) })
