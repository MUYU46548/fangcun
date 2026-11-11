#!/usr/bin/env node
/**
 * 打包搬运逻辑单测（2026-11-11）
 *
 * 为什么有这一套：0.6.19 那次打包日志写着「已保留 16 个旧版安装包」，下一次打包只剩 6 个 ——
 * 0.6.11–0.6.16 六个安装包永久丢失（它们从没发布过 GitHub，本地是唯一副本）。
 * 事后查明不是“没挑出来”，而是**搬过去以后没人核对**：复制失败被 catch 吞掉，
 * 旧目录又被整份删掉 —— 两件“各自都有理由”的事叠在一起，就是静默丢东西。
 *
 * 本套钉两件：
 *   ① 挑哪些要带走：只认安装包 / 块图，排除当前版本；
 *   ② 带过去以后**必须核对**（同名同字节数），缺一个都要报出来（调用方据此不删旧目录）。
 *
 * 运行：node scripts/test/check-pack-carry.cjs
 */
const fs = require('fs')
const path = require('path')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const { pickCarried, verifyCarried, INSTALLER_RE } = require(path.join(REPO, 'scripts', 'lib', 'packCarry.cjs'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

console.log('== ① 挑哪些旧安装包要带走 ==')
{
  const names = [
    'Fangcun-Setup.0.6.11.exe', 'Fangcun-Setup.0.6.11.exe.blockmap',
    'Fangcun-Setup.0.6.20.exe', 'Fangcun-Setup.0.6.20.exe.blockmap',
    'latest.yml', 'builder-debug.yml', 'win-unpacked', 'some-other.exe',
  ]
  const picked = pickCarried(names, '0.6.20')
  check('★★ 只挑安装包与块图（latest.yml / 目录 / 别的 exe 都不算）',
    picked.length === 2 && picked.every((n) => INSTALLER_RE.test(n)), JSON.stringify(picked))
  check('★★ 当前版本自己不带走（它刚要生成）', !picked.some((n) => n.includes('0.6.20')), JSON.stringify(picked))
  check('★ 结果稳定排序（同一输入两次一样）', JSON.stringify(pickCarried(names, '0.6.20')) === JSON.stringify(picked))
  check('★ 空目录 → 空数组（不炸）', pickCarried([], '0.6.20').length === 0)
  check('★ 非法输入不炸', pickCarried(null, '0.6.20').length === 0)
}

console.log('== ② 搬过去以后必须核对 ==')
{
  const tmp = mkTmp('pack-carry-')
  const oldDir = path.join(tmp, 'pkg'); const outDir = path.join(tmp, 'pkg.new')
  fs.mkdirSync(oldDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true })
  const a = 'Fangcun-Setup.0.6.11.exe'
  const b = 'Fangcun-Setup.0.6.18.exe'
  fs.writeFileSync(path.join(oldDir, a), Buffer.alloc(1024, 1))
  fs.writeFileSync(path.join(oldDir, b), Buffer.alloc(2048, 2))
  // 只搬过去一个（模拟“复制失败被吞”）
  fs.copyFileSync(path.join(oldDir, a), path.join(outDir, a))
  const v1 = verifyCarried(fs, path, oldDir, outDir, [a, b])
  check('★★ 少搬一个 → 核对不过，并点名是哪一个', v1.ok === false && v1.missing.length === 1 && v1.missing[0].name === b,
    JSON.stringify(v1.missing))
  check('★ 缺的原因说得出来（不是空话）', /读不到/.test(v1.missing[0].why), v1.missing[0].why)

  // 大小不一致也算没搬对（半截文件）
  fs.writeFileSync(path.join(outDir, b), Buffer.alloc(10, 2))
  const v2 = verifyCarried(fs, path, oldDir, outDir, [a, b])
  check('★★ 半截文件（大小不一致）也算没搬对', v2.ok === false && /大小不一致/.test(v2.missing[0].why), JSON.stringify(v2.missing))

  // 全部搬对
  fs.copyFileSync(path.join(oldDir, b), path.join(outDir, b))
  const v3 = verifyCarried(fs, path, oldDir, outDir, [a, b])
  check('★★ 全搬对 → ok，且不误报', v3.ok === true && v3.missing.length === 0, JSON.stringify(v3))

  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('== ③ 源码守卫：pack.cjs 真的在用核对结果决定删不删旧目录 ==')
{
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'pack.cjs'), 'utf-8')
  check('★ pack.cjs 引入 packCarry（挑 + 核对不是各写一遍）', /require\('\.\/lib\/packCarry\.cjs'\)/.test(src))
  check('★★ 核对不过 → 保留旧目录（不许无条件 emptyDir(oldDir)）',
    /oldDir && !carryOk/.test(src) && /const v = verifyCarried\(/.test(src))
  check('★ 复制失败不再静默吞（注释明写“下面统一核对时点名”）',
    !/catch \{ \/\* 旧包拷不回来不该挡住本轮 \*\/ \}/.test(src))
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
