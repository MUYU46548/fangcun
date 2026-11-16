#!/usr/bin/env node
/**
 * 长期方案守卫（2026-11-16 · D-143 落地的可机检部分）
 *
 * ## 为什么必须有它
 *
 * `decision: D-143` 的验收线原文：
 * > 「选定后：若长期方案写不出『明确不做什么』这一栏 = **不算计划**（该卡自定的判据）；
 * >  长期方案里出现**无法指回依据的条目** = 违约。」
 *
 * D-143 的头号教训正是「**判据是装饰**」（首战 S4 没过就是因为判据全指向已存在的文件）。
 * 所以这里钉的不是"文件在不在"，是**这份计划配不配叫计划**：
 *
 *   ① 三问各一节，缺一节即不算计划
 *   ② 「明确不做什么」里**每一条都得带依据**（`decision:` / `task:` / 实测数字 / 契约条款）
 *   ③ **长期必须指回中期**：写出来的三件事要各自指向一张阶段卡，指不回 = 中期在瞎干
 *   ④ 只给方寸自己（别的项目**不该有** `_long/<项目>.md` —— D-143 选的是 A）
 *   ⑤ 只读：跑一遍不改任何东西
 *
 * 跑法：node scripts/test/e2e-long-plan.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const LONG_DIR = path.join(ROOT, 'task-data', 'plans', '_long')
const PLAN_DIR = path.join(ROOT, 'task-data', 'plans')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

/** 按 `## ` 二级标题切节 */
function sections(md) {
  const out = {}
  const re = /^## (.+)$/gm
  let m
  const marks = []
  while ((m = re.exec(md))) marks.push({ t: m[1].trim(), i: m.index, e: re.lastIndex })
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1].i : md.length
    out[marks[k].t] = md.slice(marks[k].e, end)
  }
  return out
}

/**
 * 「有依据」的判据。
 *
 * ⚠ 第一版写的是 /task-/ —— **单独一个 `task-` 什么都匹配不到但要它成立，
 *   而整条依据里必须出现**；实测那一行写的是 `task: 最高优先级ai-…-f3bf06df`（**带冒号**），
 *   于是 8 条里 1 条 BAD，而那条其实写得比别的更细（连完整卡 id 都给了）。
 *   现在两种写法都认：`task: <id>` 与 `task-xxx`。
 * ⚠ 同时**不认空口依据**：光写"本卡原文"不算 —— 必须能指到一个能打开的东西。
 */
const hasEvidence = (s) =>
  /decision:|D-\d{3}|REV-\d{3}|task:\s*\S+|task-[a-z0-9]/i.test(s)
  || /立项契约|AGENTS\.md|实测|2026-\d{2}-\d{2}/.test(s)
  || /`[^`]+\.(ts|py|md|vue|cjs)`/.test(s)

function main() {
  // ── 一、位置正确（D-143 选 A：只给方寸自己写）──────────────
  console.log('=== 一、只给方寸自己写（D-143 = A）===')
  check('_long 目录存在', fs.existsSync(LONG_DIR), LONG_DIR)
  const longFiles = fs.existsSync(LONG_DIR)
    ? fs.readdirSync(LONG_DIR).filter((f) => f.endsWith('.md')) : []
  check('★★ 方寸有自己的长期方案（`_long/fangcun-base.md`）',
    longFiles.includes('fangcun-base.md'), longFiles.join(',') || '(空)')
  check('★★ 其他项目**不该有**长期方案（D-143 原文是「只给方寸自己写」）',
    longFiles.length === 1 && longFiles[0] === 'fangcun-base.md', longFiles.join(','))

  const p = path.join(LONG_DIR, 'fangcun-base.md')
  if (!fs.existsSync(p)) { report(); return }
  const md = fs.readFileSync(p, 'utf-8')

  // ── 二、三问各一节（缺一节即不算计划）──────────────────────
  console.log('\n=== 二、三问必须答完（D-143 判据原文）===')
  const secs = sections(md)
  const need = [
    ['最终变成什么', '最终变成什么'],
    ['一年做哪三件', '一年做哪三件'],
    ['明确不做什么', '明确不做什么'],
  ]
  for (const [label, key] of need) {
    const hit = Object.keys(secs).find((k) => k.includes(key))
    check(`★★ 有「${label}」这一节`, !!hit, Object.keys(secs).join(' / ').slice(0, 160))
    if (hit) {
      const body = secs[hit].trim()
      check(`★ 「${label}」不是空壳（有实质内容）`, body.length > 80, 'len=' + body.length)
    }
  }

  // ── 三、不做清单每条都要有依据 ─────────────────────────────
  console.log('\n=== 三、「明确不做什么」每条都得带依据 ===')
  const notDoKey = Object.keys(secs).find((k) => k.includes('明确不做什么'))
  const notDo = notDoKey ? secs[notDoKey] : ''
  // 表格行 `| **不做 X** | 依据 |`
  const rows = notDo.split('\n').filter((l) => /^\|\s*\*\*.+\*\*/.test(l.trim()))
  check('★ 「不做」清单是表格且有条目', rows.length >= 5, 'rows=' + rows.length)
  const noEvidence = rows.filter((r) => {
    const cells = r.split('|').map((x) => x.trim()).filter(Boolean)
    return cells.length < 2 || !hasEvidence(cells.slice(1).join(' '))
  })
  check('★★ 每一条「不做」都指回了依据（decision / REV / 契约 / 实测）',
    rows.length > 0 && noEvidence.length === 0,
    noEvidence.slice(0, 3).map((r) => r.slice(0, 70)).join(' | '))

  // ── 四、长期要指回中期（指向阶段卡）────────────────────────
  console.log('\n=== 四、长期必须指回中期（阶段卡）===')
  const threeKey = Object.keys(secs).find((k) => k.includes('一年做哪三件'))
  const three = threeKey ? secs[threeKey] : ''
  const stageRefs = [...new Set((three.match(/P\d+/g) || []))]
  check('★★ 「一年做哪三件」各自指向一张阶段卡（P12/P13/P14…）',
    stageRefs.length >= 3, stageRefs.join(',') || '(没有指向任何阶段卡)')

  // 那些阶段卡必须真的在中期计划里存在
  const planPath = path.join(PLAN_DIR, 'fangcun-base.md')
  if (fs.existsSync(planPath)) {
    const plan = fs.readFileSync(planPath, 'utf-8')
    const real = [...new Set((plan.match(/^### (P\d+)/gm) || []).map((x) => x.replace('### ', '')))]
    const ghost = stageRefs.filter((s) => !real.includes(s))
    check('★★ 指向的阶段卡在中期计划里**真的存在**（不许指空）',
      ghost.length === 0, '不存在的：' + ghost.join(',') + '｜中期实有：' + real.join(','))
  }

  // ── 五、只读 ───────────────────────────────────────────────
  console.log('\n=== 五、只读 ===')
  const fp = (d) => {
    const out = []
    const walk = (x) => {
      let es = []
      try { es = fs.readdirSync(x, { withFileTypes: true }) } catch { return }
      for (const e of es) {
        const q = path.join(x, e.name)
        if (e.isDirectory()) { walk(q); continue }
        try { const st = fs.statSync(q); out.push(path.relative(d, q) + ':' + st.size + ':' + st.mtimeMs) } catch {}
      }
    }
    walk(d)
    return out.sort().join('\n')
  }
  const td = path.join(ROOT, 'task-data')
  const before = fp(td)
  fp(td)
  check('★ 跑一遍守卫，task-data 逐字节 + mtime 全不变', fp(td) === before)

  report()
}

function report() {
  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main()
