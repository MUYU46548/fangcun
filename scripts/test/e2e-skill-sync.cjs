#!/usr/bin/env node
/**
 * 技能自动同步的两条判据（2026-11-05 · 暮雨问“更新后无法自动更新技能吗？完全断链吗？”）
 *
 * 结论不是断链，是三条缝。这条测试各钉一条：
 *   ① **清单写死**：技能 id 原来是 `SKILL_DIRS = ['fangcun-bridge','skill-management-policy']`，
 *      往 skills/ 加第三个技能，自动同步看不见它，且不报错 → 现在读 manifest；
 *   ② **同步没跑却看不出来**：升级后旧进程还在托盘，新实例被单实例锁顶掉，
 *      `autoCheckSkills` 从头到尾没执行 → 用「记录里的 appVersion ≠ 当前版本」判 stale；
 *   ③ 补跑点（second-instance / show）与手动通道必须真的在（源码守卫）。
 *
 * 真跑编译产物 `desktop/dist/shared/skillSync.js`（纯逻辑，不需要 electron）。
 * 运行：node scripts/test/e2e-skill-sync.cjs
 */
const fs = require('fs')
const { mkTmp, mkTmpPath } = require('./_tmp.cjs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'skillSync.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { readSkillIdsFromDir, judgeSkillSyncStale, FALLBACK_SKILL_DIRS } = require(ART)

const TMP = mkTmp('fc-skill-sync-')
function mkdir(name) { const p = path.join(TMP, name); fs.mkdirSync(p, { recursive: true }); return p }
function writeManifest(dir, ids) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '1.0.0', skills: ids.map((id) => ({ id })) }, null, 2))
}
function mkSkill(dir, id) {
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  fs.writeFileSync(path.join(dir, id, 'SKILL.md'), '# ' + id)
}

console.log('== 技能自动同步判据 ==')

// ── ① 清单来源：manifest，不是写死 ───────────────────────────────────
{
  const d = mkdir('src-three')
  writeManifest(d, ['fangcun-bridge', 'skill-management-policy', 'brand-new-skill'])
  mkSkill(d, 'fangcun-bridge'); mkSkill(d, 'skill-management-policy'); mkSkill(d, 'brand-new-skill')
  const ids = readSkillIdsFromDir(d)
  check('★★ manifest 里加第三个技能 → 清单里就有三个（此前写死两个，永远只同步两个）',
    ids.length === 3 && ids.indexOf('brand-new-skill') >= 0, ids.join(','))
  check('★★ 反例自证：写死的兜底里**没有** brand-new-skill（所以它出现只可能来自 manifest）',
    FALLBACK_SKILL_DIRS.indexOf('brand-new-skill') < 0, FALLBACK_SKILL_DIRS.join(','))
}
{
  const d = mkdir('src-dup')
  writeManifest(d, ['a', 'a', 'b'])
  check('★ manifest 里重复 id 去重（否则同一技能会被装两遍）',
    JSON.stringify(readSkillIdsFromDir(d)) === JSON.stringify(['a', 'b']), readSkillIdsFromDir(d).join(','))
}
{
  const d = mkdir('src-nomanifest')
  mkSkill(d, 'only-by-dir')
  check('★ manifest 缺失 → 退到目录扫描（带 SKILL.md 的目录）',
    readSkillIdsFromDir(d).length === 1 && readSkillIdsFromDir(d)[0] === 'only-by-dir', readSkillIdsFromDir(d).join(','))
}
{
  const d = mkdir('src-badmanifest')
  fs.writeFileSync(path.join(d, 'manifest.json'), '{ 这不是 JSON')
  mkSkill(d, 'from-dir')
  check('★ manifest 坏掉（非法 JSON）→ 不抛，退到目录扫描',
    readSkillIdsFromDir(d)[0] === 'from-dir', readSkillIdsFromDir(d).join(','))
}
{
  const d = mkdir('src-empty')
  check('★★ manifest 与目录都空 → 退回兜底两个（宁可装老的两个，也不能什么都不装）',
    JSON.stringify(readSkillIdsFromDir(d)) === JSON.stringify(FALLBACK_SKILL_DIRS.slice()),
    readSkillIdsFromDir(d).join(','))
  check('★ 目录根本不存在也不抛（返回兜底）',
    readSkillIdsFromDir(path.join(TMP, 'nope-does-not-exist')).length === FALLBACK_SKILL_DIRS.length)
}

// ── ② stale 判据：升级后没同步，必须能看出来 ─────────────────────────
{
  const v = judgeSkillSyncStale(null, '0.6.3')
  check('★★ 没有同步记录 → stale，且给出人话原因', v.stale === true && /没跑成过|还没有/.test(v.reason), v.reason)
  check('★ 记录里没有 appVersion（旧版本写的文件）→ 也当 stale，不假装作数',
    judgeSkillSyncStale({}, '0.6.3').stale === true)
  const same = judgeSkillSyncStale({ appVersion: '0.6.3' }, '0.6.3')
  check('★ 版本一致 → 不作数 stale，且原因为空（不吓人）',
    same.stale === false && same.reason === '', JSON.stringify(same))
  const diff = judgeSkillSyncStale({ appVersion: '0.6.2' }, '0.6.3')
  check('★★ 升级过（记录 0.6.2 / 当前 0.6.3）→ stale，原因里两个版本号都在',
    diff.stale === true && /0\.6\.2/.test(diff.reason) && /0\.6\.3/.test(diff.reason), diff.reason)
  check('★★ 反例自证：同一条记录换个"当前版本"就立刻不作数 —— 证明它真在比版本，不是恒 stale',
    judgeSkillSyncStale({ appVersion: '0.6.2' }, '0.6.2').stale === false)
}

// ── ③ 源码守卫：补跑点与手动通道必须真的在 ───────────────────────────
console.log('')
console.log('== 源码守卫（补跑点 / 手动通道 / 不再写死） ==')
// ⚠ 本机 core.autocrlf=true：先归一换行，否则带 `\n` 的判据全红（踩过）
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')
const idx = read('desktop/src/index.ts')
const installer = read('desktop/src/main/services/skillInstaller.ts')
const ipc = read('desktop/src/main/ipc.ts')
const preload = read('desktop/src/preload/index.ts')

check('★★ 安装器不再把技能 id 写死成唯一源（改走 shared/skillSync 的 readSkillIdsFromDir）',
  /readSkillIdsFromDir\(/.test(installer))
check('★★ 安装器里已经没有 `SKILL_DIRS = [` 这种硬编码赋值（只剩兜底常量且不在安装循环里用）',
  !/const\s+SKILL_DIRS\s*=/.test(installer))
check('★★ second-instance 里补跑同步（升级后再点一次图标 → 旧进程收到事件 → 同步到位）',
  /second-instance[\s\S]{0,400}syncSkillsSoon\('second-instance'\)/.test(idx))
check('★★ 窗口重新显示时补跑（从托盘点开就是"我现在要用它了"的时刻）',
  /mainWindow\.on\('show',[\s\S]{0,120}syncSkillsSoon\('show'\)/.test(idx))
check('★ 补跑有节流（不许每次切窗口都写一遍状态文件）',
  /SKILL_SYNC_MIN_MS/.test(idx) && /now - skillSyncedAt < SKILL_SYNC_MIN_MS/.test(idx))
check('★ 主进程有 skills:syncStatus 通道（界面才知道"上次同步还算不算数"）',
  /guardedHandle\('skills:syncStatus'/.test(ipc))
check('★ 主进程有 skills:syncNow 通道（不重启也能补一次）',
  /guardedHandle\('skills:syncNow'/.test(ipc))
check('★ preload 两方法都在（通道在而 preload 没接 = 界面永远调不到）',
  /skillsSyncStatus:\s*\(\)\s*=>/.test(preload) && /skillsSyncNow:\s*\(\)\s*=>/.test(preload))

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }

console.log('')
if (failures.length) {
  console.log('失败明细：')
  for (const f of failures) console.log('  · ' + f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
