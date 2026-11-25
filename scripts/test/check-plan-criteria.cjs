#!/usr/bin/env node
/**
 * 阶段卡判据守卫（2026-11-25 · 卡 `p0-1 收口 · 规划与决策`）
 *
 * ## 它守的是 P4 闸门的**数据侧**那一半
 *
 * 闸门本身（`shared/stageGate.ts`）早就是「四类判据全过才放行；unknown 也算挡；空清单不算通过」。
 * 但闸门再对，**数据里写坏的判据**照样会让某一格永久推不动 —— 而那种卡看上去完全正常。
 *
 * 卡 `eca9a98a` 的原话：
 *   「口径取 **认 cmd / str / num / file 四类，unknown 一律拦（fail-closed）**
 *     …… 修法是把这 3 条改成 file: 或给出文件路径的 num:，是 20 分钟的活」
 *
 * 所以本守卫把那条口径**变成可复跑的判据**（不是写在方针卡里就完事）：
 *
 *   ① 每一张阶段卡都必须**有判据**（没有判据的格永远推不动，且界面上看不出为什么）
 *   ② 判据里 `unknown` 必须为 **0**，除非在 `UNKNOWN_ALLOW` 里**逐条登记**（连原文一起钉住）
 *   ③ 登记**只许变短**：某条被修好了，登记没删 → 红（防"登记了就当没事"）
 *
 * ## 为什么用 `desktop/dist/shared/checkSpec.js`
 *
 * 因为那是**界面和闸门自己用的那份解析器**（`checkSpec.ts` 编译产物）。
 * 另写一份"统计用"的正则，就会重演本仓反复出现的病：**一份口径两处实现**。
 *
 * 用法：node scripts/test/check-plan-criteria.cjs
 */
'use strict'
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const SPEC = path.join(REPO, 'desktop', 'dist', 'shared', 'checkSpec.js')
const DIR = path.join(REPO, 'task-data', 'plans')

/**
 * 已登记、且**已知为什么**的 unknown 判据（只许变短）。
 *
 * 每条必须写：哪份计划哪一格 + 原文 + 解析器给的原因 + 为什么今天不修/谁来修。
 * 修好一条就要删一条 —— 守卫会抓「登记了但数据里已经没有这一条」。
 */
const UNKNOWN_ALLOW = [
  {
    where: 'sitian.md P1',
    raw: 'num: 生成地形里 hot_desert 群系格数 >= 1',
    why: '2026-11-25 · 解析器原话「num: 只认<相对路径> <指标> <比较> <数字>」。缺的是**文件路径**；'
      + '改成 file: 会改变语义（查群系是否存在 ≠ 查某文件有没有那行），所以要先问过司天那边再动。'
      + '卡 eca9a98a 的 S1 题在等用户裁决。',
  },
  {
    where: 'sitian.md P1',
    raw: 'num: 生成地形里 savanna 群系格数 >= 1',
    why: '同上（同一格里的第二条）。',
  },
  {
    where: 'sitian.md P3',
    raw: 'num: 对比图文件数 >= 2',
    why: '2026-11-25 · 解析器原话「num: 目标文件要写相对路径（拿到的是"对比图文件数"）」。'
      + '同样等 S1 裁决；改法是把"对比图"落成具体路径。',
  },
]

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? '   → ' + detail : ''}`) }
}

console.log('== 阶段卡判据（P4 闸门的数据侧）==')
console.log('')

if (!fs.existsSync(SPEC)) {
  console.error('找不到 ' + SPEC)
  console.error('先 `cd desktop && npm run build`（守卫要用**界面与闸门同一份**解析器，不另写一份正则）')
  process.exit(2)
}
if (!fs.existsSync(DIR)) {
  console.error('找不到计划目录 ' + DIR)
  process.exit(2)
}
const spec = require(SPEC)

/** 取某张阶段卡的判据行：从 `- 判据:` 起，收后续缩进的 `- ` 条目 */
function criteriaOf(body) {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => /^-\s*判据[:：]/.test(l))
  if (start < 0) return null
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^###/.test(l) || /^##\s/.test(l)) break
    if (/^-\s*\S/.test(l)) break
    const m = /^\s+-\s*(.+)$/.exec(l)
    if (m) { out.push(m[1].trim()); continue }
    if (l.trim() === '') continue
    if (/^\s+\S/.test(l)) continue
    break
  }
  return out
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()
const stages = []
const unknown = []

for (const f of files) {
  const t = fs.readFileSync(path.join(DIR, f), 'utf8')
  const parts = t.split(/^###\s*(P\d+)/m)
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i]
    const lines = criteriaOf(parts[i + 1] || '')
    if (lines === null) continue                 // 不是阶段卡（没有判据段）
    stages.push({ f, id, n: lines.length })
    for (const l of lines) {
      let kind = 'unknown'
      let reason = ''
      try {
        const r = spec.parseCheckLine(l)
        kind = (r && r.kind) || 'unknown'
        reason = (r && r.reason) || ''
      } catch (e) { kind = 'unknown'; reason = String(e.message || e) }
      if (kind === 'unknown') unknown.push({ f, id, raw: l, reason })
    }
  }
}

// ── ① 扫到了东西（扫到 0 格 = 扫描器坏了，不是"没有"）──────────────────
check('★ 扫到了阶段卡（0 格 = 扫描器坏了，不是"没有"）', stages.length > 0, 'stages=' + stages.length)

// ── ② 每一格都必须有判据（没有 = 永远推不动，且界面上看不出为什么）─────
const empty = stages.filter((s) => s.n === 0)
check('★★ 每一张阶段卡都有判据（没有判据的格永远推不动）', empty.length === 0,
  empty.map((s) => s.f + ' ' + s.id).join(' | '))

// ── ③ unknown 必须与登记**逐条**对得上（多一条 = 新写坏了；少一条 = 登记过期）──
const allowKeys = new Set(UNKNOWN_ALLOW.map((a) => a.where + ' || ' + a.raw))
const actualKeys = new Set(unknown.map((u) => u.f + ' ' + u.id + ' || ' + u.raw))

const newOnes = unknown.filter((u) => !allowKeys.has(u.f + ' ' + u.id + ' || ' + u.raw))
check('★★★ 没登记的 unknown = 0（新写坏的判据当场红）', newOnes.length === 0,
  newOnes.map((u) => `${u.f} ${u.id} :: ${u.raw}  [${u.reason}]`).join(' | '))

const fixedButRegistered = UNKNOWN_ALLOW.filter((a) => !actualKeys.has(a.where + ' || ' + a.raw))
check('★★ 登记只许变短：修好了的条目必须从 UNKNOWN_ALLOW 删掉（防"登记了就当没事"）',
  fixedButRegistered.length === 0,
  fixedButRegistered.map((a) => a.where + ' :: ' + a.raw).join(' | '))

// ── 汇总（给人看的口径）──────────────────────────────────────────────
const total = stages.reduce((a, s) => a + s.n, 0)
console.log('')
console.log(`阶段卡 ${stages.length} 张 · 判据 ${total} 条 · unknown ${unknown.length} 条（已登记 ${UNKNOWN_ALLOW.length}）`)
if (UNKNOWN_ALLOW.length) {
  console.log('')
  console.log('已登记的 unknown（每次运行都打印，登记 ≠ 藏起来）：')
  for (const a of UNKNOWN_ALLOW) console.log(`  · ${a.where} :: ${a.raw}`)
  console.log('  → 这些格在闸门里**一律拦**（fail-closed）：改了也不会被放行，直到判据写成解析器认的形式。')
}

console.log('')
console.log(`RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
