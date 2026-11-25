/**
 * P16 验收 · 7 条机器判据一把跑（2026-11-25 · P16.6）
 *
 * 判据不是"我跑过几条命令"，而是**这 7 条全绿**才算 P16 收口：
 *  ① `scripts/test/check-memory-tools.cjs` 退出码 0（插件与 MCP 的记忆口契约）
 *  ② `scripts/test/e2e-memory-lifecycle.cjs` 退出码 0（搜→读→写→批→注入）
 *  ③ `python scripts/memory.py --check` 退出码 0
 *  ④ `memory/claims/*.md` 文件数 >= 45
 *  ⑤ `memory/README.md` 含 `scope`
 *  ⑥ `desktop/src/shared/memoryRank.ts` 含 `lastAccessed`
 *  ⑦ `memory/usage.jsonl` 存在
 *
 * 运行：node scripts/test/check-memory-v3-criteria.cjs
 */
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const REPO = path.resolve(__dirname, '..', '..')
let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

function runNode(rel) {
  const r = spawnSync(process.execPath, [path.join(REPO, rel)], { cwd: REPO, encoding: 'utf-8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

console.log('== P16 七条机器判据 ==')

const c1 = runNode('scripts/test/check-memory-tools.cjs')
check('① 契约 check-memory-tools.cjs 退出码 0', c1.code === 0, `exit=${c1.code}`)

const c2 = runNode('scripts/test/e2e-memory-lifecycle.cjs')
check('② 生命周期 e2e-memory-lifecycle.cjs 退出码 0', c2.code === 0, `exit=${c2.code}`)

const py = spawnSync('python', ['scripts/memory.py', '--check'], { cwd: REPO, encoding: 'utf-8' })
check('③ memory.py --check 退出码 0', py.status === 0, `exit=${py.status} ${(py.stdout || '').trim().split('\n').slice(-1)[0] || ''}`)

const claimsDir = path.join(REPO, 'memory', 'claims')
const claimCount = fs.existsSync(claimsDir) ? fs.readdirSync(claimsDir).filter((f) => f.endsWith('.md')).length : 0
check('④ memory/claims/*.md 文件数 >= 45', claimCount >= 45, `n=${claimCount}`)

const readme = fs.readFileSync(path.join(REPO, 'memory', 'README.md'), 'utf-8')
check('⑤ memory/README.md 含 scope', readme.includes('scope'))

const rank = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'shared', 'memoryRank.ts'), 'utf-8')
check('⑥ memoryRank.ts 含 lastAccessed', rank.includes('lastAccessed'))

check('⑦ memory/usage.jsonl 存在', fs.existsSync(path.join(REPO, 'memory', 'usage.jsonl')))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
