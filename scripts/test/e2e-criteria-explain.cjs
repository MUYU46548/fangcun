/**
 * 判据「人说」纯逻辑断言（2026-11-15 暮雨第 1 条）
 *
 * 为什么单跑这一套：判据翻译是**用户能不能看懂的唯一一道闸**，而它最容易出的不是崩溃，
 * 是"翻得很顺但翻错了"——例如把 `num: 行数 >= 10` 译成"不少于 10 个字节"、
 * 把没跑过的判据说成"没过"。这类错在界面上看起来完全正常，只能靠断言钉。
 *
 * 真跑编译产物 `dist/shared/criteriaExplain.js`（与主进程/渲染层同一份代码），
 * 不另写一套翻译来"对拍自己"。
 *
 * 运行：node scripts/test/e2e-criteria-explain.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { mkTmpPath } = require('./_tmp.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const OUT = mkTmpPath('fc-cri-')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function build() {
  fs.mkdirSync(OUT, { recursive: true })
  const ts = path.join(DESKTOP, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(process.execPath, [
    ts,
    path.join(DESKTOP, 'src', 'shared', 'criteriaExplain.ts'),
    path.join(DESKTOP, 'src', 'shared', 'checkSpec.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'ES2020',
    '--strict', 'false', '--skipLibCheck',
  ], { cwd: DESKTOP, stdio: 'pipe' })
  const js = path.join(OUT, 'criteriaExplain.js')
  if (!fs.existsSync(js)) throw new Error('编译产物不存在：' + js)
  return require(js)
}

console.log('== 判据「人说」纯逻辑 ==')
const M = build()

// ── ① 四种机器语法都要能翻成人话，且翻的**是那一句** ─────────────────────
{
  const s = M.explainCriteria("str: docs/免责声明.md 含 '决策担保'")
  check('★★ str: 译成「<文件> 里必须出现「<原文>」」',
    s.plain === 'docs/免责声明.md 里必须出现「决策担保」', s.plain)
  check('★ str: 原文保留（用户要能核对译的到底是不是这句）',
    s.raw.indexOf("str:") === 0, s.raw)

  const n = M.explainCriteria('num: docs/x.md 行数 >= 10')
  check('★★ num: 指标译对（行数 → 「行」，不是字节/字符）',
    n.plain === 'docs/x.md 的行数不少于 10', n.plain)
  check('★★ num: 比较符译对（>= → 「不少于」）', n.plain.indexOf('不少于') >= 0, n.plain)
  const n2 = M.explainCriteria('num: docs/x.md 字符数 <= 500')
  check('★ num: <= → 「不多于」，单位跟着指标走',
    n2.plain === 'docs/x.md 的字符数不多于 500', n2.plain)

  const c = M.explainCriteria('cmd: node scripts/test/x.cjs')
  check('★★ cmd: 译成「跑通这条命令：<命令>」',
    c.plain === '跑通这条命令：node scripts/test/x.cjs', c.plain)
  check('★ cmd: 讲清判据口径（退出码 0）', c.basis.indexOf('退出码 0') >= 0, c.basis)

  const f = M.explainCriteria('file: docs/x.md 存在')
  check('★ file: 存在 → 「<文件> 得存在」', f.plain === 'docs/x.md 得存在', f.plain)
  const f2 = M.explainCriteria("file: docs/x.md 存在且含 '落地'")
  check('★★ file: 「存在且含」两件事都译出来（不是只译存在）',
    f2.plain === 'docs/x.md 存在，且里面有「落地」', f2.plain)
  const f3 = M.explainCriteria("file: docs/logs.md 存在且每行含 'OK'")
  check('★★ file: 「每行含」与「含」不是一回事（逐行 vs 任意一行）',
    f3.plain.indexOf('每一行都含') >= 0 && f2.plain.indexOf('每一行都含') < 0, f3.plain)
}

// ── ② 判不了就说判不了，**不许**翻成"没问题" ────────────────────────────
{
  const u = M.explainCriteria('这条判据我随手写的')
  check('★★ 没前缀 → 明说「机器判不了 —— 需要人来判」',
    u.plain === '这条机器判不了 —— 需要人来判', u.plain)
  check('★★ 判不了时把原因摆出来（不许只说“格式错误”）',
    u.basis.length > 4 && u.basis.indexOf('前缀') >= 0, u.basis)
  check('★ 判不了的类型标签是「需人看」', u.kindLabel === '需人看', u.kindLabel)

  const hum = M.explainCriteria("human: '看着舒服'")
  check('★ human: 也归「需人看」，且说清它是人来验不是机检',
    hum.kindLabel === '需人看' && hum.basis.indexOf('人') >= 0, hum.basis)

  const bad = M.explainCriteria("str: 本文件 含 'x'")
  check('★★ str: 指代「本文件」→ 判不了（不许猜成某个路径）',
    bad.state === '' && bad.plain.indexOf('判不了') >= 0, bad.plain)
}

// ── ③ 没跑过 ≠ 没过（这是用户最容易被误导的一处）────────────────────────
{
  const notRun = M.explainCriteria('file: docs/x.md 存在')
  check('★★ 没跑过 → 「还没跑」，不是「没过」也不是「过」',
    notRun.verdict === '还没跑' && notRun.state === '', notRun.verdict)
  const passd = M.explainCriteria('file: docs/x.md 存在', { state: 'pass' })
  check('★ 跑过了且过 → 「过」', passd.verdict === '过')
  const failed = M.explainCriteria('num: docs/x.md 行数 >= 10', { state: 'fail', actual: '实际 6 行' })
  check('★★ 没过时带出实际值（用户要知道差多少，不是只知道“没过”）',
    failed.verdict === '没过（实际 6 行）', failed.verdict)
  const unk = M.explainCriteria('file: docs/x.md 存在', { state: 'unknown' })
  check('★★ 机检 unknown → 「机器判不了」（不许当成通过）',
    unk.verdict === '机器判不了', unk.verdict)
  // 反例自证：把"没跑过"当成"过"这条判据会被咬住
  check('   反例自证：notRun.verdict 不等于「过」', notRun.verdict !== '过')
}

// ── ④ 批量翻译与标量一致（同下标对应，缺项 = 没跑过）───────────────────
{
  const list = M.explainCriteriaList(
    ['file: a.md 存在', 'file: b.md 存在'],
    [{ state: 'pass' }, null],
  )
  check('★ 批量：第 1 条过、第 2 条没跑（结果按下标对应，不串行）',
    list.length === 2 && list[0].verdict === '过' && list[1].verdict === '还没跑',
    JSON.stringify(list.map((x) => x.verdict)))
  check('★ 批量：结果缺项不给假值（null → 没跑过）', list[1].state === '')
  check('★ 空输入不炸（返回空数组）', M.explainCriteriaList([]).length === 0)
  check('★ 非数组输入不炸（返回空数组）', M.explainCriteriaList(null).length === 0)
}

// ── ⑤ 折叠：一次铺 20 条就是"一坨"，≤3 条全展开 ─────────────────────────
{
  const few = M.foldPlan(['a', 'b', 'c'])
  check('★ ≤3 条全展开，不给"还有 N 条"的空话', few.rest.length === 0 && few.moreLine === '')
  const many = M.foldPlan(['a', 'b', 'c', 'd', 'e'])
  check('★★ 超过 3 条只展开前 3 条（默认不铺满）',
    many.head.length === 3 && many.rest.length === 2, JSON.stringify(many))
  check('★★ 折叠不是隐藏：写明还有几条（用户知道自己漏了什么）',
    many.moreLine === '还有 2 条（点开看全部）', many.moreLine)
  check('★ 空条目被剔掉（空白不算一条判据）',
    M.foldPlan(['a', '  ', '', 'b']).head.length === 2)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
try { fs.rmSync(OUT, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0)
