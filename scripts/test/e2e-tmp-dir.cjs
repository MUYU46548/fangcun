/**
 * 测试临时目录入口的守卫（2026-11-22 · 卡 task-20261106-002）
 *
 * 这条守的是**C 盘不再被测试垃圾撑大**这件事本身：
 *   ① `mkTmp` / `mkTmpPath` 的测试根在**仓库同盘的 `.test-tmp/`**（不是 C 盘 %TEMP%）；
 *   ② `dropTmp` 删的是外层，不是只删 root；
 *   ③ 子进程正常退出后，外层目录**真的不在了**（不是“代码里写了清理”就算）；
 *   ④ 删不掉时必须写 `clean-fc-tmp.log`，不许再 `catch {}` 静默吞。
 *
 * 为什么不能只断言“有清理函数”：2026-11-12 实测过——清理代码跑了，但
 * `rmSync` 抛 EBUSY 被 `catch {}` 吞掉，目录照样留在 C 盘。断言必须看**目录还在不在**。
 * 2026-11-22 进一步实测：即使把 root 降一层、删外层也仍 EBUSY → 所以干脆不写 C 盘。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { mkTmp, mkTmpPath, dropTmp, BASE } = require('./_tmp.cjs')

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

const expectedBase = path.join(path.resolve(__dirname, '..', '..'), '.test-tmp')

// ① 根不在 C 盘：在 .test-tmp/<prefix>/root
const root = mkTmp('fc-tmpprobe-')
const outer = path.dirname(root)
check('★★ 测试根不在 %TEMP%（不再往 C 盘写）',
  path.resolve(root).indexOf(path.resolve(os.tmpdir())) !== 0,
  `root=${root} temp=${os.tmpdir()}`)
check('★ 测试根在仓库同盘的 .test-tmp/ 下',
  path.resolve(path.dirname(outer)) === path.resolve(expectedBase) && path.basename(root) === 'root',
  `root=${root} base=${BASE}`)
fs.writeFileSync(path.join(root, 'a.txt'), 'x')
dropTmp(root)
check('★★ dropTmp 真删掉外层（不是只删 root 留个空壳）', !fs.existsSync(outer), outer)

// ② mkTmpPath：同一套结构
const fixed = mkTmpPath('fc-tmpprobe-fixed-')
const fixedOuter = path.dirname(fixed)
check('★ mkTmpPath 也是 .test-tmp/<prefix>/root',
  path.resolve(path.dirname(fixedOuter)) === path.resolve(expectedBase) && path.basename(fixed) === 'root',
  fixed)
dropTmp(fixed)
check('★ mkTmpPath 的 dropTmp 也删外层', !fs.existsSync(fixedOuter), fixedOuter)

// ③ 子进程正常退出：exit 钩子必须把外层删掉
const tmpHelper = JSON.stringify(path.join(__dirname, '_tmp.cjs'))
const child = spawnSync(process.execPath, ['-e', `
  const { mkTmp } = require(${tmpHelper})
  const d = mkTmp('fc-tmpexit-')
  require('fs').writeFileSync(require('path').join(d, 'x.txt'), '1')
  process.exit(0)
`], { encoding: 'utf-8', windowsHide: true })
check('  子进程自己正常退出（前置）', child.status === 0, `status=${child.status} stderr=${(child.stderr || '').slice(0, 120)}`)
const leftovers = fs.readdirSync(BASE).filter((n) => /^fc-tmpexit-/.test(n))
check('★★ 子进程退出后 fc-tmpexit-* 一个不剩（exit 钩子真删了外层）',
  leftovers.length === 0, leftovers.join(','))
// 清掉这条测试自己的残留（如果上面失败，别把失败变成新的垃圾）
for (const n of leftovers) { try { fs.rmSync(path.join(BASE, n), { recursive: true, force: true }) } catch {} }

// ⑤ 24 小时清扫：启动时删旧残留，但不误删当次目录
const oldDir = path.join(BASE, 'fc-sweep-old-' + Date.now())
const freshDir = path.join(BASE, 'fc-sweep-fresh-' + Date.now())
fs.mkdirSync(oldDir, { recursive: true })
fs.mkdirSync(freshDir, { recursive: true })
fs.writeFileSync(path.join(oldDir, 'x.txt'), '1')
const oldT = new Date(Date.now() - 25 * 3600 * 1000)
fs.utimesSync(oldDir, oldT, oldT)
const sweepChild = spawnSync(process.execPath, ['-e', `require(${tmpHelper})`], { encoding: 'utf-8', windowsHide: true })
check('  清扫子进程正常退出（前置）', sweepChild.status === 0, `status=${sweepChild.status}`)
check('★★ 启动清扫删 24h 前的旧残留', !fs.existsSync(oldDir), oldDir)
check('★ 启动清扫不误删当次/新目录', fs.existsSync(freshDir), freshDir)
try { fs.rmSync(freshDir, { recursive: true, force: true }) } catch {}

// ④ 源码守卫：不许再静默吞删除失败；不许再拿 os.tmpdir() 当测试根
const src = fs.readFileSync(path.join(__dirname, '_tmp.cjs'), 'utf-8')
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check('★ 删不掉时有账可查（写 clean-fc-tmp.log，不是 catch {} 吞掉）',
  /clean-fc-tmp\.log/.test(src) && /logFailure\(/.test(src))
check('★ 清理走 exit 钩子（watchdog / 断言失败也能清）',
  /process\.on\('exit'/.test(src))
check('★ 临时根不再取 os.tmpdir()（C 盘；注释里的旧示例不算）',
  !/os\.tmpdir\(\)/.test(codeOnly) && /BASE/.test(codeOnly))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) process.exit(1)
