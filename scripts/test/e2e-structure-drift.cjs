#!/usr/bin/env node
/**
 * 「结构大改就标记过期」—— 2026-11-08 两版：先按暮雨拍板做，再按他的追问改。
 *
 * 原话 ①：“阈值不用收窄，只加‘结构大改就标记过期’。”
 * 追问 ②：“源文件增删 ≥ 25 会不会导致每天过期，甚至一天内过期几十次？”
 *
 * ②的答案是“会”：实测方寸自己 10-25 起有 7 天单日增删 ≥ 25 个文件（10-31 单日新增 61 个）。
 * 所以现在**只有目录级增删算结构变动**，文件数只写进理由做说明。
 *
 * 本套钉住：
 *   ① 纯判断：目录增/删 → 过期；只改实现（哪怕 200 个文件）→ 不过期，但理由要说清动了多少；
 *   ② 噪声（node_modules / dist / docs / .github / fixtures / 锁文件）不计；
 *   ③ 真 git：只改实现不过期；新增模块目录过期并点名；核实日推到未来则不过期；
 *   ④ 兜底：没日期 / 不是仓库 / 仓库在核实日之前没有提交，各自给明确状态；
 *   ⑤ 缓存：同一 (仓库, 核实日) 第二次调用命中缓存（不再跑 git）。
 *
 * 跑法：node scripts/test/e2e-structure-drift.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const pure = require(path.join(DIST, 'shared', 'structureDrift.js'))
const drift = require(path.join(DIST, 'main', 'services', 'structureDrift.js'))

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

console.log('---- 1. 纯判断：只有目录增删算结构变动 ----')
check('★ 新增一个目录 → 过期', pure.judgeStructureDrift({ added: ['src/newmod/a.ts'], deleted: [], newDirs: ['src/newmod'] }).stale)
check('★ 删掉一个目录 → 过期', pure.judgeStructureDrift({ added: [], deleted: ['src/old/a.ts'], removedDirs: ['src/old'] }).stale)
check('★★ 只增删文件、目录没变（3 个）→ 不过期',
  !pure.judgeStructureDrift({ added: ['src/a.ts', 'src/b.ts'], deleted: ['src/c.ts'] }).stale)
// ↑ 这条就是暮雨追问的核心：文件数不再当触发器
const many = Array.from({ length: 200 }, (_, i) => `src/main/f${i}.ts`)
const manyVerdict = pure.judgeStructureDrift({ added: many, deleted: [] })
check('★★ 200 个文件全在已有目录里 → 仍然不过期（否则地图天天红）', !manyVerdict.stale, manyVerdict.reason)
check('  但理由里必须把“动了多少”说出来', /200/.test(manyVerdict.reason), manyVerdict.reason)
check('  且理由明说“模块目录没变”', /模块目录没变|实现层改动/.test(manyVerdict.reason), manyVerdict.reason)

console.log('---- 2. 噪声路径不计 ----')
const noise = [
  'node_modules/x/index.js', 'desktop/dist/main/a.js', 'desktop/pkg/app.asar',
  'release-0.6.9/win-unpacked/a.exe', 'docs/执行日志/log.md', 'scripts/test/fixtures/big.md',
  '.github/workflows/ci.yml', 'package-lock.json', 'q.log', 'task-data/.trash/x.md',
  '__pycache__/a.pyc', 'references/原型.png',
]
check('噪声文件全部被剔除', noise.every((p) => !pure.isStructuralPath(p)), noise.filter((p) => pure.isStructuralPath(p)).join('|'))
check('真源码文件不会被误剔', ['src/main/index.ts', 'scripts/test/e2e-x.cjs', 'tegula/cli.py'].every((p) => pure.isStructuralPath(p)))
check('噪声再多也不判过期（30 个 docs 文件）', !pure.judgeStructureDrift({
  added: Array.from({ length: 30 }, (_, i) => `docs/a${i}.md`), deleted: [],
}).stale)

console.log('---- 3. 真 git：只改实现 vs 新增模块 ----')
const TMP = mkTmp('drift-')
const G = (args, env) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
  cwd: TMP, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env,
})
const write = (rel, body) => {
  const p = path.join(TMP, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body, 'utf-8')
}
const OLD = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00' }
const commit = (msg, env) => G(['commit', '-m', msg, '-q'], env)
// ⚠ 核实日取 01-02：`rev-list --before` 是**不含**当天的，用 01-01 会取不到基线（status=no-base）
const MAPDAY = '2026-01-02'

G(['init', '-q'])
G(['config', 'user.email', 'test@local'])
G(['config', 'user.name', 'test'])
write('src/main/index.ts', 'console.log(1)\n')
write('src/main/data/a.ts', 'export const a = 1\n')
G(['add', '-A'])
commit('init', OLD)

const clean = drift.structureDrift(TMP, MAPDAY, { fresh: true })
check('核实日之后什么都没变 → 不过期', clean.status === 'ok' && !clean.stale, JSON.stringify(clean))

// 只改实现：同目录里加 30 个文件（> 旧判据的 25 阈值，用来证明它现在不再触发）
for (let i = 0; i < 30; i++) write(`src/main/data/f${i}.ts`, `export const f${i} = 1\n`)
G(['add', '-A'])
commit('impl only', process.env)
const implOnly = drift.structureDrift(TMP, MAPDAY, { fresh: true })
check('★★ 同目录里加了 30 个文件 → 不过期（这正是暮雨担心的“每天过期”）', !implOnly.stale, JSON.stringify(implOnly))
check('  理由里说清“动了 30 个文件、目录没变”', /30/.test(implOnly.reason) && /模块目录没变/.test(implOnly.reason), implOnly.reason)

// 新增模块目录
write('src/newmod/index.ts', 'export const n = 1\n')
G(['add', '-A'])
commit('new module', process.env)
const withNewDir = drift.structureDrift(TMP, MAPDAY, { fresh: true })
check('★★ 新增了 src/newmod 目录 → 过期', withNewDir.stale, JSON.stringify(withNewDir))
check('★★ 理由点名了那个新目录', /src\/newmod/.test(withNewDir.reason), withNewDir.reason)
check('★★ 反例：核实日推到未来（之后没有任何提交）→ 不过期，判据跟日期走', (() => {
  const t = new Date(Date.now() + 2 * 86400000)
  const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  return !drift.structureDrift(TMP, d, { fresh: true }).stale
})())

console.log('---- 4. 缓存：同一 (仓库, 核实日) 第二次不再跑 git ----')
drift.clearStructureDriftCache()   // 前面 fresh:true 那几次也会写缓存，先清掉再验命中
const a1 = drift.structureDrift(TMP, MAPDAY)
const a2 = drift.structureDrift(TMP, MAPDAY)
check('★ 第二次命中缓存（cached=true）', a1.cached !== true && a2.cached === true, JSON.stringify([a1.cached, a2.cached]))
check('★ 缓存结果是同一个判定', a2.stale === a1.stale && a2.files === a1.files)
drift.clearStructureDriftCache()

console.log('---- 5. 兜底：没日期 / 不是仓库 / 没有基线 ----')
check('没写“最后核实”日期 → status=no-date，且不假装没问题',
  drift.structureDrift(TMP, '', { fresh: true }).status === 'no-date')
const plain = mkTmp('drift-nogit-')
fs.mkdirSync(path.join(plain, 'src'), { recursive: true })
fs.writeFileSync(path.join(plain, 'src', 'a.ts'), 'x\n', 'utf-8')
check('不是 git 仓库 → status=no-git', drift.structureDrift(plain, '2026-01-01', { fresh: true }).status === 'no-git')
check('仓库路径不存在 → status=no-repo', drift.structureDrift(path.join(plain, 'nope'), '2026-01-01', { fresh: true }).status === 'no-repo')
check('核实日早于首个提交 → status=no-base（并说明“地图写成截至今天即可”）',
  (() => { const r = drift.structureDrift(TMP, '2025-12-01', { fresh: true }); return r.status === 'no-base' && /截至今天/.test(r.reason) })(),
  JSON.stringify(drift.structureDrift(TMP, '2025-12-01', { fresh: true })))

console.log('')
// ── 6. 异步版（2026-11-17）：产品路径不许再同步 spawn git ────────────────
// 暮雨报「刷新要 5000ms 以上」「点记忆页几乎整个方寸卡死，狂点好几下才进去」。
// 根因不在界面：`policy:driftAll` 用 `execFileSync` 同步问 git，16 个项目 × 5 次 ≈ 3.5–4.7 秒，
// **在主进程里**跑，事件循环整个冻住 —— 期间任何 IPC（点页签、读记忆）都只能排队。
// 这一节钉两件事：① 异步版判定必须与同步版逐字段一致（不能"为了不卡就改了口径"）；
//                ② 产品路径（ipc.ts 的 driftAll）不许再出现同步 spawn。
// ⚠ 上面那个分号不能省：不加时下一行会被 ASI 拼成 `console.log('')(async …)()`
//   → `TypeError: console.log(...) is not a function`（实测踩到）。
;(async () => {
  console.log('---- 6. 异步版：与同步版判定一致，且产品路径不再同步 spawn ----')

  // ① 判定一致：同一个真仓库，两条腿结论必须逐字段相同
  drift.clearStructureDriftCache()
  const syncR = drift.structureDrift(TMP, MAPDAY, { fresh: true })
  drift.clearStructureDriftCache()
  const asyncR = await drift.structureDriftAsync(TMP, MAPDAY, { fresh: true })
  check('★★ 异步版与同步版判定完全一致（stale / reason / files / newDirs / removedDirs）',
    syncR.stale === asyncR.stale && syncR.reason === asyncR.reason
    && syncR.files === asyncR.files
    && JSON.stringify(syncR.newDirs) === JSON.stringify(asyncR.newDirs)
    && JSON.stringify(syncR.removedDirs) === JSON.stringify(asyncR.removedDirs),
    JSON.stringify({ sync: syncR.reason, async: asyncR.reason }))

  // 同一个兜底态也要一致（不存在的仓库 → no-repo，两边同话术）
  drift.clearStructureDriftCache()
  const sNo = drift.structureDrift(path.join(TMP, 'nope'), '2026-01-01', { fresh: true })
  drift.clearStructureDriftCache()
  const aNo = await drift.structureDriftAsync(path.join(TMP, 'nope'), '2026-01-01', { fresh: true })
  check('★ 兜底态（仓库不存在）两边 status 与话术一致',
    sNo.status === aNo.status && sNo.reason === aNo.reason,
    JSON.stringify({ sync: sNo, async: aNo }))

  // ② 异步版缓存同样生效（第二轮不跑 git）
  drift.clearStructureDriftCache()
  const w1 = await drift.structureDriftAsync(TMP, MAPDAY)
  const w2 = await drift.structureDriftAsync(TMP, MAPDAY)
  check('★ 异步版第二次命中缓存（cached=true）—— 日常刷新不该每次都跑 git',
    w1.cached !== true && w2.cached === true, JSON.stringify([w1.cached, w2.cached]))

  // ③ 批量版形状（policy:driftAll 的返回契约）
  drift.clearStructureDriftCache()
  const batch = await drift.structureDriftAllAsync([
    { project: 'p-ok', repo: TMP, since: MAPDAY },
    { project: 'p-missing', repo: path.join(TMP, 'nope'), since: '2026-01-01' },
  ])
  check('★ 批量版逐条返回 {project,status,stale,reason}，且顺序与入参一致',
    batch.length === 2 && batch[0].project === 'p-ok' && batch[1].project === 'p-missing'
    && typeof batch[0].stale === 'boolean' && typeof batch[0].reason === 'string',
    JSON.stringify(batch))
  check('★ 批量版一条坏掉不拖垮另一条（各自 status）',
    batch[0].status === 'ok' && batch[1].status === 'no-repo',
    JSON.stringify(batch.map((b) => b.status)))

  // ④ 源码守卫：产品路径不许同步 spawn git
  //    判据：ipc.ts 的 driftAll 分支里不许出现同步版 structureDrift( / execFileSync。
  //    ⚠ 先剥注释再扫 —— 注释里写着"别改回同步版"是解释，不是调用（本仓同类守卫栽过）。
  const ipcSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'ipc.ts'), 'utf-8')
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const ipc = stripComments(ipcSrc)
  const at = ipc.indexOf("guardedHandle('policy:driftAll'")
  const body = at < 0 ? '' : ipc.slice(at, ipc.indexOf('guardedHandle(', at + 20))
  check('★★ 源码守卫：policy:driftAll 走异步版（structureDriftAllAsync）',
    body.length > 0 && /structureDriftAllAsync/.test(body), body.slice(0, 200))
  check('★★ 源码守卫：policy:driftAll 里没有同步 structureDrift( / execFileSync / spawnSync',
    body.length > 0 && !/[^c]structureDrift\(/.test(body.replace(/structureDriftAllAsync/g, 'X'))
    && !/execFileSync|spawnSync/.test(body), body.slice(0, 300))

  console.log('')
  console.log(`通过 ${PASS} / 失败 ${FAILS.length}`)
  if (FAILS.length) { console.log('失败项：'); FAILS.forEach((f) => console.log(' - ' + f)); process.exit(1) }
  console.log(`RESULT ${PASS} / 0`)
})()

