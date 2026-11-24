#!/usr/bin/env node
/**
 * 问卷题量的口径（2026-11-24 · 暮雨：「问卷会不会太短了？项目规划这种非常重的任务，
 * 问个五六十题都不过分」）
 *
 * ## 先证伪一个前提
 *
 * 「问卷太短」**不是系统拦的**。实测量过：
 *   · `validateDeckSpec` **没有题数上限**；
 *   · 60 道合法题 `createDeck` 返回 `ok: true, questions: 60`；
 *   · 界面有左栏跳题 + 进度条，60 题可正常答。
 *
 * 所以这一轮改的不是"把上限调大"，而是**原来那条提示对规划卷开错药**。
 *
 * ## 原来的毛病
 *
 * `Q_BATCH_MAX = 6` 一刀切：超过 6 题就报「建议拆批或拆层」。
 * 那个 6 来自 Typeform 的**营销问卷**完成率调研 —— 而规划类问卷不是营销问卷：
 * 它是判断题，且**越后面越值钱**（前面边界题好答，后面取舍题才值钱）。
 * 对着 60 题的规划卷说"超过 6 题建议拆批"，是**错的建议**。
 *
 * ## 这个守卫钉什么
 *
 *   ① **裁决类**超 6 题才提（那个 6 对它是对的）；
 *   ② **规划类**按"每层"算、不按总数 —— 30 题分 3 层（每层 10）**不该报**；
 *   ③ **认不出题型就不提**（不猜、不给错建议）；
 *   ④ `deckIssues` 里除了题量，别的检查（代价 / 验收线）**一个字都不许变**；
 *   ⑤ 题量**永远只是提示**，不许变成拦落盘的闸。
 *
 * 运行：node scripts/test/e2e-deck-size.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'questionnaire.js')
const SPEC = path.join(REPO, 'desktop', 'dist', 'shared', 'qnDeckSpec.js')

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
  console.log('FAIL  编译产物存在（先 cd desktop && npm run build）')
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const q = require(ART)
const spec = require(SPEC)

console.log('== 问卷题量：按题型给建议，不一刀切 ==')

const mk = (asks) => asks.map((ask, i) => ({ id: 'S' + (i + 1), nav: '', ask, options: [], line: 'l' }))

// ── ① 裁决类：那个 6 对它是对的 ─────────────────────────────────────────
console.log('\n-- ① 裁决类：超 6 才提 --')
{
  const small = mk(['做不做这个？', '选哪个方案？', '要不要现在做？'])
  check('3 题裁决类不提（别加噪音）', q.deckSizeHint(small).noteworthy === false)
  const big = mk(Array.from({ length: 12 }, () => '做不做这个？要不要那个？'))
  const h = q.deckSizeHint(big)
  check('★★ 12 题裁决类要提', h.noteworthy === true, JSON.stringify(h))
  check('★ 提示里给出裁决类的建议区间', /3–8/.test(h.advice), h.advice)
  check('★ 说出代价（题越多后面越容易随口答）', /随口答/.test(h.advice), h.advice)
}

// ── ② 规划类：教的必须是"分层"，不是"拆批" ────────────────────────────
console.log('\n-- ② 规划类：教的是"分层"，绝不是"超过 6 题" --')
{
  // ⚠ 我第一版这条断言写错了：以为"30 题的规划卷（分层形态）不该报"。
  //   但**单卷 30 题就是该报** —— 系统看不见你有没有真的分三层，
  //   它只能看见"这是 30 题的规划卷，请确认按层出、答完一层再出下一层"。
  //   真正该钉的不是"报不报"，而是**报的是哪种话**：
  //   必须是"分层/分卷"，绝不能是"超过 6 题建议拆批"（那句对规划卷是错建议，正是本轮要修的）。
  const plan30 = mk(Array.from({ length: 30 }, (_, i) => `基于上面的结论，第 ${i + 1} 步怎么定？`))
  const h30 = q.deckSizeHint(plan30)
  check('题型被认成 plan（靠"基于上面"这类依赖词）',
    q.deckShape(plan30) === 'plan', q.deckShape(plan30))
  check('★★ 30 题规划卷会提醒（系统不知道你有没有真分层，只能提醒）', h30.noteworthy === true)
  check('★★★ 但提醒的是「分层」，**不是**"超过 6 题/批"',
    /分层/.test(h30.advice) && !/6 题/.test(h30.advice), h30.advice)
  check('★ 分层提醒带出具体每层上限', /每层 12 题/.test(h30.advice), h30.advice)

  const plan50 = mk(Array.from({ length: 50 }, (_, i) => `基于前面，第 ${i + 1} 步怎么定？`))
  const h50 = q.deckSizeHint(plan50)
  check('★ 50 题规划卷同样被认出来（"基于前面"也算依赖词）',
    q.deckShape(plan50) === 'plan', q.deckShape(plan50))
  check('★ 50 题要提', h50.noteworthy === true, JSON.stringify(h50))
  check('★★ 而且给的是"分卷 / 分层"，**不是**"超过 6 题建议拆批"',
    /分卷|分层/.test(h50.advice) && !/6 题/.test(h50.advice), h50.advice)

  // 关键反例：规划卷绝不许被那句 6 题的话术击中
  const anyPlan = q.deckSizeHint(mk(Array.from({ length: 20 }, () => '取决于上面怎么选，这步做不做？')))
  check('★★★ 规划卷永远不会收到"超过 6 题/批"这种建议',
    !/6 题/.test(anyPlan.advice || ''), anyPlan.advice || '(无建议)')

  // 小规划卷不该被噪音打扰
  check('8 题规划卷不提（低于每层上限）',
    q.deckSizeHint(mk(Array.from({ length: 8 }, () => '基于上面，这步怎么定？'))).noteworthy === false)
}

// ── ③ 认不出题型就不猜 ──────────────────────────────────────────────────
console.log('\n-- ③ 认不出就不给建议（宁可不提，也不给错） --')
{
  const vague = mk(Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 个事项的具体情况是什么？`))
  const h = q.deckSizeHint(vague)
  check('★ 认不出题型 → kind=unknown', q.deckShape(vague) === 'unknown', q.deckShape(vague))
  check('★★ unknown 时**不提**题量（不瞎建议）', h.noteworthy === false, JSON.stringify(h))
  check('空卷安全', q.deckShape([]) === 'unknown' && q.deckSizeHint([]).noteworthy === false)
}

// ── ④ 收拾旧账 ──────────────────────────────────────────────────────────
console.log('\n-- ④ 收拾旧账：10–20 题 --')
{
  const cl = mk(Array.from({ length: 25 }, (_, i) => `第 ${i + 1} 条应该归到哪一类？`))
  check('题型认成 cleanup', q.deckShape(cl) === 'cleanup', q.deckShape(cl))
  const h = q.deckSizeHint(cl)
  check('25 题要提，且给出 10–20 的建议', h.noteworthy === true && /10–20/.test(h.advice), h.advice)
  const ok = mk(Array.from({ length: 15 }, (_, i) => `第 ${i + 1} 条属于哪一类？`))
  check('15 题不提', q.deckSizeHint(ok).noteworthy === false)
}

// ── ⑤ deckIssues 里别的检查一个字都不许变 ───────────────────────────────
console.log('\n-- ⑤ 代价/验收线检查没被顺手改坏 --')
{
  const deck = {
    deck: 'x', title: 'x',
    questions: [
      { id: 'S1', nav: '', ask: '做不做？', options: [{ k: 'A', t: 'a', d: '' }, { k: 'B', t: 'b', d: 'd' }], line: 'l' },
      { id: 'S2', nav: '', ask: '要不要？', options: [{ k: 'A', t: 'a', d: 'd' }, { k: 'B', t: 'b', d: 'd' }], line: '' },
    ],
  }
  const issues = q.deckIssues(deck)
  check('★ 没写代价仍被报出来（noCost）', issues.some((i) => i.kind === 'noCost'), JSON.stringify(issues))
  check('★ 没写验收线仍被报出来（noLine）', issues.some((i) => i.kind === 'noLine'), JSON.stringify(issues))
  check('★ 小卷不该有 tooMany', !issues.some((i) => i.kind === 'tooMany'), JSON.stringify(issues))
}

// ── ⑥ 题量永远只是提示，不许变成闸 ──────────────────────────────────────
console.log('\n-- ⑥ 题量不许变成拦落盘的闸 --')
{
  // 60 题全合法的 spec 必须过机检（这条就是暮雨那个"问五六十题"的正面回答）
  const big = {
    deck: '六十题', title: '六十题',
    questions: Array.from({ length: 60 }, (_, i) => ({
      id: 'S' + (i + 1), nav: '', ask: '基于上面，第 ' + (i + 1) + ' 步怎么定？',
      options: [{ k: 'A', t: '甲', d: '代价甲' }, { k: 'B', t: '乙', d: '代价乙' }],
      line: '选甲后不许出现乙',
    })),
  }
  check('★★★ 60 道合法题**必须**通过 validateDeckSpec（题量不是闸）',
    spec.validateDeckSpec(big).length === 0, JSON.stringify(spec.validateDeckSpec(big).slice(0, 3)))
  // 而它照样会被"提醒一句"
  check('★ 60 题仍会得到一句分层提醒（提示≠拦）',
    q.deckSizeHint(big.questions).noteworthy === true)
}

// ── ⑦ 源码守卫：6 这个数只许留在裁决类那一支 ────────────────────────────
console.log('\n-- ⑦ 源码守卫 --')
{
  const src = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'shared', 'questionnaire.ts'), 'utf8')
  check('★★ `Q_BATCH_MAX` 不再直接出现在 deckIssues 的一刀切判断里',
    !/d\.questions\.length > Q_BATCH_MAX/.test(src), '又回到一刀切了')
  check('★ 三档常量都在（裁决 / 每层 / 整卷）',
    /Q_BATCH_MAX = 6/.test(src) && /Q_PLAN_PER_LAYER = 12/.test(src) && /Q_PLAN_TOTAL_MAX = 40/.test(src))
}

console.log(`\nRESULT ${pass} / ${pass + fail}`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
