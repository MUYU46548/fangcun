/**
 * Electron 引擎基线守卫 —— 卡 task-20261018-003
 *
 * 起因：2026-10-18 立卡时引擎还是 `electron ^28.0.0`（Chromium 120，上游已停安全更新），
 * 而桌面端是方寸**唯一**产品形态 —— 用一个 EOL 的运行时跑用户的全部任务数据，是长期风险。
 * 10-22 升到 44，但卡里那条「补一条断言：electron 主版本 ≥ 受支持线，且**失败即红**」没做。
 * 没有断言的升级会被后人无意退回：把 `^44.0.0` 改回 `^28.0.0` 不会有任何东西响。
 *
 * 判据：Electron 官方只维护**最近 3 个大版本**（44 是当前线，41 已到维护末期）。
 * 这里取 40 作保守下限 —— 低于它就不是"可能有问题"，是"确定缺安全补丁"。
 *
 * 运行：node scripts/test/check-electron-version.cjs
 */
const path = require('path')
const fs = require('fs')

const DESKTOP = path.resolve(__dirname, '../../desktop')
const MIN_MAJOR = 40

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

/** 从 `^44.0.0` / `~28.1.2` / `44` 里抠主版本；取不到给 NaN（NaN 比较恒为 false → 判红） */
function majorOf(spec) {
  const m = String(spec == null ? '' : spec).match(/(\d+)/)
  return m ? Number(m[1]) : NaN
}

console.log('== Electron 引擎基线守卫（卡 20261018-003）==')

const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf-8'))
const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
const spec = all.electron
const maj = majorOf(spec)

check('desktop/package.json 里能读到 electron 版本', typeof spec === 'string' && spec.length > 0,
  `spec=${JSON.stringify(spec)}`)
check(`electron 主版本 ${Number.isNaN(maj) ? '?' : maj} ≥ ${MIN_MAJOR}（EOL 的 28 不许再出现）`,
  maj >= MIN_MAJOR, `spec=${JSON.stringify(spec)}`)
check('electron-builder 仍在依赖里（打包链路没断）', !!all['electron-builder'],
  `spec=${JSON.stringify(all['electron-builder'])}`)

// ── 反例自证：判定函数真的会红，而不是"看起来在守" ──────────────────────
check('反例：「28.0.0」判红', !(majorOf('28.0.0') >= MIN_MAJOR), '')
check('反例：「^28.0.0」判红', !(majorOf('^28.0.0') >= MIN_MAJOR), '')
check('反例：「~28.3.1」判红', !(majorOf('~28.3.1') >= MIN_MAJOR), '')
check('反例：空串 / undefined 不会误判为通过',
  !(majorOf('') >= MIN_MAJOR) && !(majorOf(undefined) >= MIN_MAJOR), '')
check('反例：「^44.0.0」判绿（证明不是恒红）', majorOf('^44.0.0') >= MIN_MAJOR, '')

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('\n失败项：'); for (const f of failures) console.log(' -', f) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
