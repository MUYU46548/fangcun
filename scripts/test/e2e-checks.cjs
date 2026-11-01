#!/usr/bin/env node
/**
 * 判据执行器 e2e（0.6.0 P3，2026-11-01）
 *
 * 真跑**编译产物**：`dist/shared/checkSpec.js`（解析）+ `dist/main/checks/runner.js`（执行）。
 * 不起 Electron、不碰真实数据 —— 临时目录里造夹具，本机可跑。
 *
 * 判据一句话：**四类前缀必须真能判，判不了必须说 unknown，绝不当通过。**
 *   · cmd: 真跑进程，退出码 0 = 通过；超时 = unknown（不是 fail）
 *   · str: 文件里真出现那段原文
 *   · num: 真数行/条目/字节/字符，再比大小
 *   · file: 真查路径/glob/每行内容
 *   · 未知前缀 `foo:` / `human:` / 没写清 = unknown，passed 计数不增加（精确红）
 *
 * 最后两段是"别只测我自己编的"：
 *   · 真实计划卡 `task-data/plans/fangcun-base.md` 的 31 条判据逐条解析，一条都不许静默丢；
 *   · Python 只读镜像 `tegula/checks.py` 与 TS 解析器**逐行对拍**（同一批输入 → 同一份结构）。
 *
 * 运行：node scripts/test/e2e-checks.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '../..')
const SPEC_ART = path.join(REPO, 'desktop', 'dist', 'shared', 'checkSpec.js')
const RUN_ART = path.join(REPO, 'desktop', 'dist', 'main', 'checks', 'runner.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}
function skip(name, why) { console.log(`SKIP  ${name}（${why}）`) }

for (const art of [SPEC_ART, RUN_ART]) {
  if (!fs.existsSync(art)) {
    console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + art)
    console.log('RESULT 0 / 1')
    process.exit(1)
  }
}
const spec = require(SPEC_ART)
const runner = require(RUN_ART)
const { parseCheckLine, parseCheckLines } = spec
const {
  runCriterion, runCriteria, expandGlob,
  DEFAULT_CMD_TIMEOUT_MS, MAX_OUTPUT_CHARS, clampCmdTimeout,
} = runner

const ROOT = path.join(os.tmpdir(), 'fc-checks-' + Date.now())
function write(rel, text) {
  const p = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf-8')
  return p
}
fs.mkdirSync(ROOT, { recursive: true })
write('docs/sample.md', 'alpha\nbeta\n- one\n- two\n')          // 4 行 / 2 条目
write('docs/numeric.txt', 'a\nb\nc\n')                          // 3 行
write('docs/empty.txt', '')                                     // 0 行
write('docs/报告-2026.md', '需求id: A\n需求id: B\n')             // 每行含 需求id
write('docs/bad-report.md', '需求id: A\n这行没有\n')             // 反例
write('desktop/src/app.ts', 'export const x = 1 // nocriteria\n')
const RO = { root: ROOT }

console.log('== ① 解析：四类前缀 + 未知 ==')
const k = (line) => parseCheckLine(line).kind
check('四类前缀各解析成自己的 kind',
  k('cmd: node x.js') === 'cmd' && k("str: a/b.ts 含 'x'") === 'str'
  && k('num: a/b.md 行数 >= 1') === 'num' && k('file: a/b.md 存在') === 'file')
check('★★ 未知前缀 foo: → unknown（永不 pass）', k('foo: 随便') === 'unknown')
check('★★ human: → unknown（合法但不可机检）', k('human: 人工看一眼') === 'unknown')
check('★ 没有前缀的散文 → unknown', k('随便一句说明') === 'unknown')
check('★ 未知前缀的 reason 说清"只认四类"',
  /只认 cmd/.test(parseCheckLine('foo: x').reason || ''), parseCheckLine('foo: x').reason)

const cmd1 = parseCheckLine('cmd: `node scripts/test/e2e-checks.cjs` 退出码 0')
check('★ cmd: 反引号里的命令被取出（尾部说明丢掉）', cmd1.command === 'node scripts/test/e2e-checks.cjs', cmd1.command)
check('★ cmd: 不带反引号的「退出码 0」也丢掉', parseCheckLine('cmd: python scripts/x.py 退出码 0').command === 'python scripts/x.py')
check('★ cmd: 行尾 # 注释丢掉', parseCheckLine('cmd: node x.js # 退出码 0').command === 'node x.js')
check('★ cmd: 中途的反引号是 shell 替换，不许被剥',
  parseCheckLine('cmd: echo `date`').command === 'echo `date`', parseCheckLine('cmd: echo `date`').command)
check('★ cmd: 空命令 → unknown', k('cmd:') === 'unknown')

const s1 = parseCheckLine("str: desktop/src/app.ts 含 'nocriteria'")
check('★ str: 带引号的原文取出', s1.kind === 'str' && s1.path === 'desktop/src/app.ts' && s1.text === 'nocriteria',
  JSON.stringify(s1))
check('★ str: 单个词可以不帶引号（设计稿写法）',
  parseCheckLine('str: desktop/src/app.ts 含 nocriteria').text === 'nocriteria')
check('★★ str: 散文（原文没引号且含空格）→ unknown，不许拿整句去搜',
  k('str: desktop/src/app.ts 含 三种动作分支 且每支都有路径') === 'unknown')
check('★ str: 没写目标文件（本文件）→ unknown',
  k('str: 本文件含 范围 / 交付物 五个二级标题') === 'unknown')
check('★ str: 文案里没写「含」→ unknown', k('str: 无已冻结计划时显示提示语') === 'unknown')

check('★ num: ≥ / = 归一成 >= / ==',
  parseCheckLine('num: docs/x.md 行数 ≥ 3').op === '>=' && parseCheckLine('num: docs/x.md 行数 = 3').op === '==')
check('★ num: 认得四个指标', ['行数', '条目数', '字节数', '字符数'].every((m) => {
  const p = parseCheckLine(`num: docs/x.md ${m} >= 0`)
  return p.kind === 'num'
}))
check('★★ num: 认不出的指标 → unknown（不糊默认值）', k('num: docs/x.md 字数 >= 3') === 'unknown')
check('★ num: 散文 → unknown', k('num: 四类前缀各至少 1 条用例真跑通过（4/4）') === 'unknown')

check('★ file: 存在 / 且含 / 且每行含 三种形态都认',
  parseCheckLine('file: docs/x.md 存在').requireExists === true
  && parseCheckLine("file: docs/x.md 存在且含 'abc'").contains === 'abc'
  && parseCheckLine('file: docs/x.md 存在，且每行含 需求id').everyLineContains === '需求id')
check('★ file: glob 路径认', parseCheckLine('file: docs/自检报告-*.md 存在').pattern === 'docs/自检报告-*.md')
check('★★ file: 后面跟一段没法机检的说明 → unknown', k('file: 项目页摆法注册处含 plan，且摆法总数 = 8') === 'unknown')

check('★ 绝对路径一律 unknown（换台机器就失效）',
  k('str: E:/x/y.ts 含 \'a\'') === 'unknown' && k('file: C:\\x\\y.md 存在') === 'unknown')
check('空行不产生假结果（parseCheckLines 跳过）',
  parseCheckLines(['', '   ', 'cmd: node x.js']).length === 1)

console.log('\n== ② 执行：str / num / file ==')
;(async () => {
  let r = await runCriterion("str: desktop/src/app.ts 含 'nocriteria'", RO)
  check('★ str 命中 → pass', r.state === 'pass' && r.ok === true, r.detail)
  r = await runCriterion("str: desktop/src/app.ts 含 '不存在的词'", RO)
  check('★ str 未命中 → fail', r.state === 'fail' && r.ok === false, r.detail)
  r = await runCriterion("str: desktop/src/app.ts 含 'nocriteria'", { root: path.join(ROOT, 'nope') })
  check('★ str 目标文件不存在 → fail（不是 unknown）', r.state === 'fail', r.detail)

  r = await runCriterion('num: docs/sample.md 行数 >= 4', RO)
  check('★ num 行数 >= 4 → pass（实际 4）', r.state === 'pass' && r.evidence.actual === 4, r.detail)
  r = await runCriterion('num: docs/sample.md 行数 > 4', RO)
  check('★ num 行数 > 4 → fail（实际 4）', r.state === 'fail' && r.evidence.actual === 4, r.detail)
  r = await runCriterion('num: docs/sample.md 条目数 == 2', RO)
  check('★ num 条目数 = 2 → pass（只数 Markdown 列表项）', r.state === 'pass' && r.evidence.actual === 2, r.detail)
  r = await runCriterion('num: docs/empty.txt 行数 == 0', RO)
  check('★ num 空文件行数 = 0（不是 1）', r.state === 'pass' && r.evidence.actual === 0, r.detail)
  r = await runCriterion('num: docs/sample.md 字节数 >= 1', RO)
  check('★ num 字节数可算', r.state === 'pass' && r.evidence.actual > 0, r.detail)
  r = await runCriterion('num: docs/sample.md 字符数 >= 1', RO)
  check('★ num 字符数可算', r.state === 'pass' && r.evidence.actual > 0, r.detail)

  r = await runCriterion('file: docs/sample.md 存在', RO)
  check('★ file 存在 → pass', r.state === 'pass', r.detail)
  r = await runCriterion('file: docs/*.md 存在', RO)
  check('★ file glob 命中多个 → pass 且列出命中', r.state === 'pass' && (r.evidence.matched || []).length >= 2,
    JSON.stringify(r.evidence.matched))
  r = await runCriterion('file: docs/nope-*.md 存在', RO)
  check('★ file 一个都没命中 → fail', r.state === 'fail', r.detail)
  r = await runCriterion("file: docs/报告-*.md 存在且每行含 需求id", RO)
  check('★ file 每行都含 → pass', r.state === 'pass', r.detail)
  r = await runCriterion("file: docs/bad-report.md 存在且每行含 需求id", RO)
  check('★ file 有一行不含 → fail 且点名', r.state === 'fail' && /不含/.test(r.detail), r.detail)
  r = await runCriterion("file: docs/报告-2026.md 存在且含 '需求id: B'", RO)
  check('★ file 含某段原文 → pass', r.state === 'pass', r.detail)
  check('expandGlob: 不含通配符且文件存在 → 恰好一个',
    expandGlob(ROOT, 'docs/sample.md').length === 1)
  check('expandGlob: 目录不存在 → 空（不抛）', expandGlob(ROOT, 'nowhere/*.md').length === 0)

  console.log('\n== ③ 执行：cmd（真起进程）==')
  r = await runCriterion('cmd: node -e "process.exit(0)"', RO)
  check('★ cmd 退出码 0 → pass', r.state === 'pass' && r.ok === true, r.detail)
  r = await runCriterion('cmd: node -e "process.exit(3)"', RO)
  check('★ cmd 退出码 3 → fail（不是 unknown）', r.state === 'fail' && r.evidence.exitCode === 3, r.detail)
  r = await runCriterion('cmd: node -e "console.error(\'boom-xyz\'); process.exit(2)"', RO)
  check('★ cmd 失败保留 stderr 尾巴（排查用）',
    r.state === 'fail' && /boom-xyz/.test(r.evidence.stderrTail || ''), r.evidence.stderrTail)
  r = await runCriterion('cmd: node -e "process.stdout.write(\'x\'.repeat(20000))"', RO)
  check('★ cmd 输出有上限（不刷爆内存）',
    r.state === 'pass' && String(r.evidence.stdoutTail || '').length <= MAX_OUTPUT_CHARS + 1,
    String(String(r.evidence.stdoutTail || '').length))

  const t0 = Date.now()
  r = await runCriterion('cmd: node -e "setTimeout(function(){}, 5000)"', { root: ROOT, timeoutMs: 300 })
  const elapsed = Date.now() - t0
  check('★★ cmd 超时 → unknown（不是 fail）', r.state === 'unknown' && r.ok === false, r.detail)
  check('★ 超时真的很快返回（没等满 5 秒）', elapsed < 3000, elapsed + 'ms')
  check('★ 超时证据里 timedOut=true', r.evidence.timedOut === true)

  console.log('\n== ④ 汇总：passed 计数不许被 unknown 充数 ==')
  // P3 自己的判据：「四类前缀各至少 1 条用例真跑通过（4/4）」
  const four = await runCriteria([
    'cmd: node -e "process.exit(0)"',
    "str: desktop/src/app.ts 含 'nocriteria'",
    'num: docs/sample.md 行数 >= 4',
    'file: docs/sample.md 存在',
  ], RO)
  check('★★ P3 判据：四类前缀各至少 1 条用例**真跑**通过（4/4）',
    four.passed === 4 && four.results.map((x) => x.kind).join(',') === 'cmd,str,num,file',
    JSON.stringify(four.results.map((x) => ({ k: x.kind, s: x.state }))))
  const one = await runCriteria(['cmd: node -e "process.exit(0)"'], RO)
  const withFoo = await runCriteria(['cmd: node -e "process.exit(0)"', 'foo: 未知判据'], RO)
  check('★★ 加一条 foo: 后 passed 计数不增加（精确红）',
    withFoo.passed === one.passed && withFoo.passed === 1, JSON.stringify({ one: one.passed, withFoo: withFoo.passed }))
  check('★ 未知条进 unknown，且 total 如实 +1',
    withFoo.unknown === 1 && withFoo.total === 2, JSON.stringify(withFoo))
  check('★ 有 unknown 时 allPassed=false（fail-closed）', withFoo.allPassed === false)
  const allOk = await runCriteria(['cmd: node -e "process.exit(0)"', 'file: docs/sample.md 存在'], RO)
  check('★ 全部通过时 allPassed=true', allOk.allPassed === true && allOk.failed === 0 && allOk.unknown === 0)
  const empty = await runCriteria([], RO)
  check('★ 空判据清单：total=0 且 allPassed=false（没判据 ≠ 验过了）',
    empty.total === 0 && empty.allPassed === false)

  console.log('\n== ⑤ 超时常量：默认写死 60s，上限也 60s ==')
  check('★ DEFAULT_CMD_TIMEOUT_MS === 60000', DEFAULT_CMD_TIMEOUT_MS === 60000, String(DEFAULT_CMD_TIMEOUT_MS))
  check('★ 不传 → 60000', clampCmdTimeout(undefined) === 60000)
  check('★ 传小值（测试用）→ 原样', clampCmdTimeout(300) === 300)
  check('★★ 传大于 60s → 被夹回 60s（上限写死）', clampCmdTimeout(120000) === 60000)

  // ── ⑥ 真实计划卡：逐条解析，一条都不许静默丢 ────────────────────────
  console.log('\n== ⑥ 真实计划卡（task-data/plans/fangcun-base.md）==')
  const PLAN_MD = path.join(REPO, 'task-data', 'plans', 'fangcun-base.md')
  if (!fs.existsSync(PLAN_MD)) {
    skip('真实计划卡回归', '文件不在场')
  } else {
    process.env.FC_TEST_USERDATA = path.join(ROOT, '.userdata')
    fs.mkdirSync(process.env.FC_TEST_USERDATA, { recursive: true })
    const origResolve = Module._resolveFilename
    Module._resolveFilename = function (request, ...args) {
      if (request === 'electron') return path.join(__dirname, 'electron-stub.cjs')
      return origResolve.call(this, request, ...args)
    }
    const data = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'index.js'))
    data.setDataDir(REPO)
    const { readPlan } = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'plans.js'))
    const doc = readPlan('fangcun-base.md')
    const lines = (doc ? doc.stages : []).reduce((a, s) => a.concat(s.criteria || []), [])
    const parsed = parseCheckLines(lines)
    check('★ 真卡 8 张 / 全部判据逐条读得到（一条不丢）',
      !!doc && doc.stages.length === 8 && parsed.length === lines.length && lines.length >= 24,
      JSON.stringify({ stages: doc && doc.stages.length, criteria: parsed.length, lines: lines.length }))
    check('★ 每一条都有 kind（没有 undefined / 静默丢行）',
      parsed.every((p) => typeof p.kind === 'string' && p.kind.length > 0))
    check('★ 四类前缀的文字在真卡里都出现过（卡面确实按四类写）',
      ['cmd', 'str', 'num', 'file'].every((x) =>
        lines.some((l) => new RegExp('^\\s*(?:-\\s*)?' + x + '\\s*[:：]').test(l))))
    const kinds = parsed.reduce((m, p) => (m[p.kind] = (m[p.kind] || 0) + 1, m), {})
    check('★★ 真卡现状：8 条 cmd 是机器可执行写法；其余是散文 → unknown，绝不冒充 pass',
      kinds.cmd === 8 && kinds.unknown === parsed.length - 8,
      JSON.stringify(kinds))
    check('★ 8 条 cmd 全部指向仓库里的脚本（不是随手一句）',
      parsed.filter((p) => p.kind === 'cmd').every((p) => /^(?:python|node)\s+scripts\//.test(p.command)),
      parsed.filter((p) => p.kind === 'cmd').map((p) => p.command).join(' | '))
    check('★ unknown 的每一条都有可读 reason',
      parsed.filter((p) => p.kind === 'unknown').every((p) => typeof p.reason === 'string' && p.reason.length > 5))
    const p3 = doc && doc.stages.find((s) => s.id === 'P3')
    const p3cmd = (p3 ? p3.criteria : []).map((l) => parseCheckLine(l)).find((p) => p.kind === 'cmd')
    check('★ P3 自己的 cmd 判据解析成真命令（node scripts/test/e2e-checks.cjs）',
      !!p3cmd && p3cmd.command === 'node scripts/test/e2e-checks.cjs', p3cmd && p3cmd.command)
    check('★ 解析本身不跑命令、不读判据目标（只出结构）',
      parsed.every((p) => p.kind === 'unknown' || !('exitCode' in p)))
  }

  // ── ⑦ 边界守卫：P3 只出结果对象，不许顺手写盘 / 不许在加载计划卡时跑命令 ──
  console.log('\n== ⑦ 边界守卫（P3 不写回、不自动跑）==')
  const runnerSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'checks', 'runner.ts'), 'utf-8')
  check('★★ 执行器只读不写：源码里没有任何写文件调用（写回是 P4）',
    !/writeFileSync|writeFile\(|appendFileSync|createWriteStream|atomicWrite/.test(runnerSrc))
  const planIpcSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'plan-ipc.ts'), 'utf-8')
  check('★★ plans:get 没有接执行器（打开计划卡不许顺手跑命令）',
    !/checks\/runner|runCriteria|runCriterion/.test(planIpcSrc))

  // ── ⑧ 跨语言对拍：TS 解析 ≡ Python 只读镜像 ─────────────────────────
  console.log('\n== ⑧ Python 只读镜像对拍（tegula/checks.py）==')
  const FIXTURE = [
    'cmd: node x.js',
    'cmd: `node scripts/test/e2e-checks.cjs` 退出码 0',
    'cmd: node x.js # 退出码 0',
    'cmd: python scripts/x.py 退出码 0',
    'cmd: echo `date`',
    'cmd:',
    "str: desktop/src/app.ts 含 'nocriteria'",
    'str: desktop/src/app.ts 含 nocriteria',
    'str: desktop/src/app.ts 含 三种动作分支 且每支都有路径',
    'str: 本文件含 范围 / 交付物 五个二级标题',
    'str: 无已冻结计划时显示提示语',
    'num: docs/x.md 行数 >= 3',
    'num: docs/x.md 行数 ≥ 3',
    'num: docs/x.md 条目数 = 2',
    'num: docs/x.md 字数 >= 3',
    'num: 四类前缀各至少 1 条用例真跑通过（4/4）',
    'file: docs/x.md 存在',
    'file: docs/自检报告-*.md 存在',
    "file: docs/x.md 存在且含 'abc'",
    'file: docs/x.md 存在，且每行含 需求id',
    'file: 项目页摆法注册处含 plan，且摆法总数 = 8',
    'foo: 未知',
    'human: 人工看',
    '随便一句',
    '  - cmd: node y.js  ',
  ]
  const inFile = path.join(ROOT, 'parity-in.json')
  const outFile = path.join(ROOT, 'parity-out.json')
  fs.writeFileSync(inFile, JSON.stringify(FIXTURE), 'utf-8')
  const driver = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from tegula.checks import parse_criteria',
    'lines = json.load(open(sys.argv[2], encoding="utf-8"))',
    'out = parse_criteria(lines)',
    'json.dump(out, open(sys.argv[3], "w", encoding="utf-8"), ensure_ascii=False, indent=1)',
  ].join('\n')
  let py = null
  try {
    execFileSync('python', ['-X', 'utf8', '-c', driver, REPO, inFile, outFile], {
      cwd: REPO, encoding: 'utf-8', timeout: 60000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    py = JSON.parse(fs.readFileSync(outFile, 'utf-8'))
  } catch (e) {
    skip('跨语言对拍', 'Python 起不来：' + ((e && e.message) || e))
  }
  if (py) {
    const ts = FIXTURE.map((l) => parseCheckLine(l))
    check('★ Python 侧条数与 TS 一致', py.length === ts.length, `py=${py.length} ts=${ts.length}`)
    const norm = (o) => JSON.stringify(Object.keys(o).sort().reduce((m, key) => {
      m[key] = o[key] === undefined ? null : o[key]
      return m
    }, {}))
    check('★★ 逐行对拍：同一批判据行，TS 与 Python 解析出同一份结构',
      py.every((o, i) => norm(o) === norm(ts[i])),
      (() => {
        for (let i = 0; i < Math.min(py.length, ts.length); i++) {
          if (norm(py[i]) !== norm(ts[i])) return `第 ${i + 1} 行不一致：\n  py=${norm(py[i])}\n  ts=${norm(ts[i])}`
        }
        return ''
      })())
    check('★ Python 镜像只解析不执行（源码里没有 subprocess/os.system/exec）',
      !/subprocess|os\.system|os\.popen|\bexec\(|\bspawn/.test(
        fs.readFileSync(path.join(REPO, 'tegula', 'checks.py'), 'utf-8')))
  }

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log(' - ' + f)) }
  process.exit(fail ? 1 : 0)
})()
