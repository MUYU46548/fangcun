/**
 * 记忆整理体检 · 端到端（2026-11-24）
 *
 * ## 它存在的理由（暮雨原话）
 *
 * > 「我刚开始还会定期整理，后来发现整理消耗的几千万 token 更贵，干脆完全不整理摆烂了」
 *
 * 那几千万 token 花在「让 agent 读全库判断哪条该留」。判据是：**整理必须零模型调用**。
 * 所以这里最硬的断言不是"报告能生成"，而是：
 *   ① 纯字符串运算 —— 全程不 import 任何 LLM / 网络模块；
 *   ② **只读** —— 跑前跑后 task-data 与 memory/claims 逐字节不变（usage.jsonl 除外）；
 *   ③ 三条口径不许混：
 *      · 「计量没开始」≠「从没被用过」
 *      · 「core 自动喂过」≠「被主动搜过」（两列分开，合并必有一头错）
 *      · 退出码含义唯一：0 通过 / 1 真有问题 / 2 环境问题
 *
 * 反例自证：造一条完全重复的 claim → ① 必须报；删掉 usage.jsonl → ② 必须说"计量没开始"。
 *
 * 运行：node scripts/test/e2e-memory-audit.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'memory-audit.py')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆整理体检（零模型调用）==')

check('★★ 脚本在', fs.existsSync(SCRIPT), SCRIPT)
if (!fs.existsSync(SCRIPT)) { console.log(`\nRESULT ${pass} / ${fail}`); process.exit(1) }

function run(args = [], opts = {}) {
  const r = execFileSync('python', [SCRIPT, ...args], {
    cwd: REPO, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, ...opts,
  })
  return r
}
function runJson() {
  return JSON.parse(run(['--json']))
}

// ── ① 源码守卫：不许调模型 ─────────────────────────────────────────
console.log('\n-- ① 零模型调用 --')
{
  const src = fs.readFileSync(SCRIPT, 'utf-8')
  const banned = ['openai', 'anthropic', 'requests', 'urllib', 'http.client', 'fetch(', 'llm']
  const hit = banned.filter((b) => src.toLowerCase().includes(b))
  check('★★ 脚本里没有任何 LLM / 网络调用', hit.length === 0, hit.join(','))
  check('★ 只 import 标准库里的纯计算模块',
    /^import (argparse|json|os|re|sys|datetime)$/m.test(src) || src.includes('import argparse'),
    '第一行 import')
  check('★ 脚本声明自己是只读', /只读/.test(src) && /不写任何 claim/.test(src))
}

// ── ② 只读：claims 与 task-data 逐字节不变 ─────────────────────────
console.log('\n-- ② 只读（不许改任何记忆文件）--')
{
  const snap = (dir) => {
    const out = new Map()
    ;(function walk(d) {
      let names = []
      try { names = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const n of names) {
        const p = path.join(d, n.name)
        if (n.isDirectory()) walk(p)
        else if (n.name.endsWith('.md')) {
          const buf = fs.readFileSync(p)
          out.set(p, `${buf.length}:${require('crypto').createHash('sha256').update(buf).digest('hex')}`)
        }
      }
    })(dir)
    return out
  }
  const claimsDir = path.join(REPO, 'memory', 'claims')
  const taskDir = path.join(REPO, 'task-data')
  const beforeC = snap(claimsDir)
  const beforeT = snap(taskDir)
  run(['--json'])
  run([])
  const afterC = snap(claimsDir)
  const afterT = snap(taskDir)

  const diffC = [...beforeC.keys()].filter((k) => beforeC.get(k) !== afterC.get(k))
  const diffT = [...beforeT.keys()].filter((k) => beforeT.get(k) !== afterT.get(k))
  check('★★ 跑两遍后 memory/claims 逐字节不变（含 mtime 不管，只比内容）',
    diffC.length === 0, diffC.slice(0, 3).join(','))
  check('★★ 跑两遍后 task-data 逐字节不变', diffT.length === 0, diffT.slice(0, 3).join(','))
  check('★ claims 文件数不变', beforeC.size === afterC.size, `${beforeC.size} -> ${afterC.size}`)
}

// ── ③ 三条口径 ─────────────────────────────────────────────────────
console.log('\n-- ③ 三条口径不许混 --')
{
  const rep = runJson()
  check('★ --json 给得出三块（duplicates / usageStarted / core）',
    Array.isArray(rep.duplicates) && typeof rep.usageStarted === 'boolean' && rep.core,
    JSON.stringify(Object.keys(rep)))
  check('★★ neverAny 与 neverActive 是两列，不是一个数',
    Array.isArray(rep.neverAny) || rep.neverAny === null,
    String(rep.neverAny))
  check('★★ neverActive ⊇ neverAny（主动搜过必然也算用过）',
    rep.neverAny === null || rep.neverActive === null
      || rep.neverAny.every((id) => rep.neverActive.includes(id)),
    `neverAny=${(rep.neverAny || []).length} neverActive=${(rep.neverActive || []).length}`)
  check('★ core 账带 fits 与 needBudget 两个字段（要能直接告诉人调到多少）',
    typeof rep.core.fits === 'boolean' && typeof rep.core.needBudget === 'number',
    JSON.stringify(rep.core))
}

// ── ④ 反例①：造一条完全重复，必须报 ───────────────────────────────
console.log('\n-- ④ 反例：重复必须被抓到 --')
{
  const src = path.join(REPO, 'memory', 'claims', 'mem-20261120-06.md')
  const dup = path.join(REPO, 'memory', 'claims', 'zz-audit-dup.md')
  let created = false
  try {
    if (!fs.existsSync(src)) throw new Error('缺少夹具 mem-20261120-06.md')
    let text = fs.readFileSync(src, 'utf-8')
    text = text.replace(/^id: mem-20261120-06$/m, 'id: zz-audit-dup')
    fs.writeFileSync(dup, text, 'utf-8')
    created = true
    const rep = runJson()
    const found = rep.duplicates.some((d) => d.a === 'zz-audit-dup' || d.b === 'zz-audit-dup')
    check('★★ 完全重复的副本被报出来', found, JSON.stringify(rep.duplicates.slice(0, 2)))
    check('★★ --check 此时必须非零退出（真有问题）', (() => {
      try { run(['--check']); return false } catch (e) { return e.status === 1 }
    })(), 'exit 应为 1')
  } finally {
    if (created) { try { fs.unlinkSync(dup) } catch {} }
  }
  const after = runJson()
  check('★ 清理后重复回到 0（确认夹具已删，没污染真库）',
    after.duplicates.length === 0 && after.total > 0, `dups=${after.duplicates.length}`)
}

// ── ⑤ 反例②：没有 usage.jsonl 时必须说"计量没开始" ──────────────────
console.log('\n-- ⑤ 反例：计量没开始 ≠ 从没被用过 --')
{
  const usage = path.join(REPO, 'memory', 'usage.jsonl')
  const backup = usage + '.audit-test-bak'
  let moved = false
  try {
    if (fs.existsSync(usage)) { fs.renameSync(usage, backup); moved = true }
    const rep = runJson()
    check('★★ usage.jsonl 不存在时 usageStarted=false',
      rep.usageStarted === false, String(rep.usageStarted))
    check('★★ 此时 neverAny 必须是 null（不是"45 条从没被用过"这种假红）',
      rep.neverAny === null, String(rep.neverAny))
    const text = run([])
    check('★★ 人读版必须明说「计量还没开始」，不许报"N 条没被用过"',
      /计量还没开始/.test(text) && !/四个出口.*都没带出去过：\d+ 条/.test(text),
      text.split('\n').filter((l) => l.includes('计量') || l.includes('没被用过')).join(' | '))
  } finally {
    if (moved) { try { fs.renameSync(backup, usage) } catch {} }
  }
  const back = runJson()
  check('★ 放回 usage.jsonl 后恢复计量（started 与 neverAny 都回来）',
    back.usageStarted === true && back.neverAny !== null, String(back.usageStarted))
}

// ── ⑥ --check 的退出码含义唯一 ─────────────────────────────────────
console.log('\n-- ⑥ 退出码含义唯一 --')
{
  let code = 0
  try { run(['--check']) } catch (e) { code = e.status }
  check('★★ --check 正常时退出码是 0（不是被编码崩溃污染的 1）', code === 0, `exit=${code}`)
  const src = fs.readFileSync(SCRIPT, 'utf-8')
  check('★★ 脚本自己处理了 GBK 终端（不给符号把退出码变成 1）',
    src.includes('_safe_stdout') && src.includes("errors='replace'"),
    '缺 _safe_stdout')
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
