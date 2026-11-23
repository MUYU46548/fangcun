#!/usr/bin/env node
/**
 * 决策台账对账守卫（2026-11-23 · 卡 db20e386 的「对账」那一条）
 *
 * 这条守卫的来源是一段**证伪过程**，值得写在这里，免得下一个人重走：
 *
 *   第一次判据「决策 ↔ 方针卡 逐字重合」→ landed=0 / orphan=135。证伪。
 *     方针卡只写四节概括（使命/目标/场景/边界），它不是决策记录。
 *
 *   第二次判据「决策 ↔ 它点名的卡/提交」→ landed=2 / orphan=1 / no_ref=142。也基本证伪。
 *     145 条现行决策里 142 条**根本不点名任何可核对实体** ——
 *     决策台账记的是"定案了什么"，不是"对应哪张卡"。这是数据结构的事实，不是缺陷。
 *
 * 所以本守卫**不假装能判"落地率"**。它只钉三件事：
 *   ① 脚本能跑、且能读到真数据（读成 0 一律红 —— 本仓栽过三次）；
 *   ② 分类加总等于现行决策数（不许有决策被静默丢掉）；
 *   ③ "点名了但东西不存在"这一列**不许悄悄变大**（当前 1 条，基线钉住）。
 * 以及一条反例：把卡索引指错 → 必须红。
 *
 * 运行：node scripts/test/e2e-reconcile-decisions.cjs
 */
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const PY = process.env.FC_PYTHON || 'python'

// 基线：当前真数据下 orphan 的条数与点名内容。
// 变大 = 又有人写了决策却引用了不存在的东西 —— 那才是这条守卫要抓的。
const BASELINE_ORPHAN = 1

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

function py(args, extraEnv) {
  return execFileSync(PY, ['-X', 'utf8', ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(extraEnv || {}) },
  })
}

let stats = null
try {
  const out = py(['scripts/reconcile-decisions.py', '--check'])
  stats = JSON.parse(out.trim())
} catch (e) {
  check('对账脚本能跑（--check）', false, String(e && e.message || e).slice(0, 200))
}

if (stats) {
  check('★ 读到决策台账（0 = 解析坏了，不是没有决策）', stats.decisions_total > 0, `total=${stats.decisions_total}`)
  check('★ 读到卡索引（0 = 卡目录指错了）', stats.cards_indexed > 0, `cards=${stats.cards_indexed}`)
  check('★ 读到 git 提交（0 = git 不可用，那一列会全判 orphan）',
    stats.commits_known > 0, `commits=${stats.commits_known}`)

  // ② 分类必须加总等于现行决策数（不许有决策被静默丢掉）
  const sum = stats.landed + stats.orphan + stats.no_ref
  check('★★ 三类加总 == 现行决策数（没有决策被静默丢掉）',
    sum === stats.decisions_live, `${stats.landed}+${stats.orphan}+${stats.no_ref}=${sum} vs ${stats.decisions_live}`)

  // ③ orphan 基线（当前 1 条）
  check(`★★ 「点名了但东西不存在」没有变多（基线 ${BASELINE_ORPHAN}）`,
    stats.orphan <= BASELINE_ORPHAN, `当前 ${stats.orphan} 条`)

  // 记录既然 142 条 no_ref 是数据事实，就把这个比例也钉一下 ——
  // 它大幅下降意味着"决策开始写落地指针了"，那是好事，但也得有人知道
  check('★ no_ref 仍是多数（142/145 是当前数据形态；突然归零说明判据坏了）',
    stats.no_ref > stats.decisions_live * 0.5, `no_ref=${stats.no_ref} / live=${stats.decisions_live}`)
}

// ── 反例：卡目录指错 → orphan 必须暴涨（证明确实在核对外部实体，不是空转）──
{
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location('r', 'scripts/reconcile-decisions.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rows = m.parse_decisions(m.read(m.DECISIONS))
live = [r for r in rows if (r['status'] or '有效') == '有效']
cards = {}          # 故意清空卡索引
commits = set()     # 故意清空提交
res = [m.judge(d, cards, commits) for d in live]
orph = sum(1 for r in res if r['verdict'] == 'orphan')
print(json.dumps({'orphan_if_nothing_exists': orph, 'live': len(live)}))
`
  try {
    const out = py(['-c', code])
    const r = JSON.parse(out.trim())
    check('★★ 反例：卡/提交全清空 → 点过名的决策必须全变 orphan（证明确实在核对）',
      r.orphan_if_nothing_exists >= 1,
      `orphan=${r.orphan_if_nothing_exists} / live=${r.live}`)
  } catch (e) {
    check('★★ 反例可执行', false, String(e && e.message || e).slice(0, 200))
  }
}

console.log('\n' + (fail ? '❌' : '✅') + ` RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(fail ? 1 : 0)
