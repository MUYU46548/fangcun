#!/usr/bin/env node
/**
 * 上下文包里的材料"还算不算数"（2026-11-24 · 暮雨第 2 条）
 *
 * ## 原话
 *
 * > 「排给DSH的内容会不会太诡异了？会不会太浪费上下文？不过本来就是给AI看的，
 * >   我就没要求说人话。里面一堆不说人话的东西。也许AI能看懂？」
 *
 * ## 实测（这轮真跑，不是估）
 *
 * `buildContextPack('fangcun-base')` = **7789 字 / 186 行**，按节拆：
 * 契约 28.2% · 方针 25.2% · 硬约束 14.3%（它们是从契约/方针**复述**的）· 未完成卡 14.0% · 决策 12.2%
 *
 * 所以"太浪费"的答案不是"太长"，而是：**①②③⑦ 四节 = 67%，
 * 却都在回答同一个问题（这项目是什么 / 不能碰什么）**，而其中一整节（⑦）是复述。
 *
 * 但这一轮**只修真正会致错的那一半**：材料**过期**。
 * 实测契约原文里写着「一屏视图不存在」「6 个项目在方寸零任务卡」—— 两件都做完了。
 * 上下文包逐字照搬，每个开工的 agent 都会读到"一屏视图不存在"，然后可能去建一个已经有了的东西。
 * **模型不会怀疑上下文包，它只会照着做** —— 一份写错的包比没有包更糟。
 *
 * ## 这个守卫钉什么
 *
 *   ① 有锚 + 过期 → 必须明说"过时了，涉及'做没做'的去核"；
 *   ② **没锚 ≠ 过期** → 说"我判断不了"，不许说成"过时"也不许说成"新鲜"；
 *   ③ 取**最晚**的锚（一段材料里多处日期时，材料新旧由最新的那处决定）；
 *   ④ 预警**不许删原文**（删了就把"当时为什么这么想"也删了）；
 *   ⑤ 预警字数要小（这条是来省上下文的，不是来加篇幅的）。
 *
 * 运行：node scripts/test/e2e-context-freshness.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'contextFreshness.js')
const CP = path.join(REPO, 'desktop', 'src', 'main', 'services', 'contextPack.ts')

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
  console.log('FAIL  编译产物存在（先 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { judgeFreshness, freshnessNote, findLastVerified, STALE_DAYS } = require(ART)

const DAY = 86400000
const TODAY = new Date('2026-11-24T00:00:00Z')

console.log('== 上下文包 · 材料还算不算数 ==')

// ── ① 有锚且过期 ─────────────────────────────────────────────────────────
console.log('\n-- ① 过期要说"过时了" --')
const old = judgeFreshness('最后核实：2026-01-01\n- 模块清单…', TODAY)
check('★ 2026-01-01（327 天前）判过期', old.stale === true, JSON.stringify(old))
check('★ ageDays 算得出来', old.ageDays > 300, String(old.ageDays))
check('有锚时 unknownAge 必须是 false（别把"有日期"也说成判断不了）', old.unknownAge === false)
const oldNote = freshnessNote('这份契约', old)
check('★ 过期的话术点明"当现状不行"', /过时|当现状不行/.test(oldNote), oldNote)
check('★ 过期的话术给出该怎么做（去代码/看板核）', /核/.test(oldNote), oldNote)

// ── ② 没锚 ≠ 过期，也 ≠ 新鲜 ─────────────────────────────────────────────
console.log('\n-- ② 没日期就说判断不了（不许猜） --')
const noAnchor = judgeFreshness('## 终态形态\n\n做一件事。\n\n- 当前断点：一屏视图不存在', TODAY)
check('★★ 没锚 → unknownAge:true 且 stale:false（两者是不同结论）',
  noAnchor.unknownAge === true && noAnchor.stale === false, JSON.stringify(noAnchor))
const naNote = freshnessNote('这份契约', noAnchor)
check('★ 没锚的话术说的是"判断不了"，不是"过时"', /判断不了/.test(naNote), naNote)
check('★★ 没锚的话术**不许**出现"新鲜/是最新的"这类反向保证',
  !/新鲜|最新|还算数|没问题/.test(naNote), naNote)

// ── ③ 取最晚的锚 ─────────────────────────────────────────────────────────
console.log('\n-- ③ 多处日期取最晚 --')
const multi = '最后核实：2026-09-01\n…（2025-01-01 实跑）…\n最后核实：2026-11-20'
check('★★ 取最晚的那个，不是第一个', findLastVerified(multi) === '2026-11-20', findLastVerified(multi))
const multiJudge = judgeFreshness(multi, TODAY)
check('取最晚之后判为新鲜（不误报）', multiJudge.stale === false, JSON.stringify(multiJudge))
const onlyOld = '最后核实：2025-01-01'
check('对照组：只有一个旧日期就判过期', judgeFreshness(onlyOld, TODAY).stale === true)

// ── ④ 新鲜时不说废话 ─────────────────────────────────────────────────────
console.log('\n-- ④ 新鲜就别加噪音 --')
const fresh = judgeFreshness('最后核实：2026-11-20', TODAY)
check('新鲜时 note 是空串（不在包上添"一切正常"）', freshnessNote('这份契约', fresh) === '', JSON.stringify(fresh))

// ── ⑤ 阈值与仓库既有口径一致 ─────────────────────────────────────────────
console.log('\n-- ⑤ 阈值别另造一个数 --')
check('★ STALE_DAYS 就是 90（与 structureMapStale 同一口径）', STALE_DAYS === 90, String(STALE_DAYS))
check('恰好 90 天不算过期（>不是>=）', judgeFreshness('最后核实：2026-08-26', TODAY).stale === false,
  JSON.stringify(judgeFreshness('最后核实：2026-08-26', TODAY)))
check('91 天算过期', judgeFreshness('最后核实：2026-08-25', TODAY).stale === true,
  JSON.stringify(judgeFreshness('最后核实：2026-08-25', TODAY)))

// ── ⑥ 接线：真接进包，且不删原文 ─────────────────────────────────────────
console.log('\n-- ⑥ 真接进上下文包 --')
const cpSrc = fs.readFileSync(CP, 'utf8')
check('★★ 契约节接了新鲜度判定', /freshnessNote\('这份契约'/.test(cpSrc))
check('★★ 结构地图也接了（它最容易悄悄过期）', /freshnessNote\('这张结构地图'/.test(cpSrc))
check('判定走 shared 模块（不在包拼装里就地写 if）',
  /judgeFreshness/.test(cpSrc) && /from '\.\.\/\.\.\/shared\/contextFreshness'/.test(cpSrc))
// 原文照旧要留在包里 —— 预警是**加法**，不是替换
check('★ 契约四个字段仍原样落包（预警是加法，不是替换）',
  /\['终态形态', contract\.endState\]/.test(cpSrc) && /\['验收线', contract\.acceptLine\]/.test(cpSrc))
check('★ 结构地图原文仍原样落包', /pol\.structureMap\.trim\(\)/.test(cpSrc))

// ── ⑦ 真跑：字数涨得很少（这条是来省上下文的） ─────────────────────────
console.log('\n-- ⑦ 真跑一次，看它加了多少字 --')
try {
  const D = path.join(REPO, 'desktop')
  const data = require(path.join(D, 'dist', 'main', 'data', 'index.js'))
  const cpMod = require(path.join(D, 'dist', 'main', 'services', 'contextPack.js'))
  data.setDataDir(REPO)
  const r = cpMod.buildContextPack('fangcun-base')
  if (r && r.ok) {
    const lines = String(r.text || '').split('\n')
    const warns = lines.filter((l) => l.includes('⚠') && /核实|过时|判断不了/.test(l))
    check('★★ 真跑时包里确实出现了新鲜度预警', warns.length > 0, 'none')
    // 预警总字数必须很小 —— 它是来省上下文的，不许自己变成新的脂肪
    const warnChars = warns.reduce((n, l) => n + l.length, 0)
    check('★ 预警总字数 < 400（它是来省上下文的）', warnChars < 400, String(warnChars))
    // 原文没被删：契约节的四个标签还在
    check('★ 真跑时契约四个字段仍都在包里',
      ['终态形态', '验收线', '不要什么', '选型定死'].every((k) => r.text.includes(k)))
  } else {
    check('真跑 buildContextPack 成功', false, r && r.error)
  }
} catch (e) {
  check('真跑 buildContextPack 不抛', false, String(e && e.message).slice(0, 200))
}

console.log(`\nRESULT ${pass} / ${pass + fail}`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
