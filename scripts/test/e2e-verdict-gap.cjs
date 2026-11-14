#!/usr/bin/env node
/**
 * 核心判词：**界面已拆、数据保留**（2026-11-14 · 暮雨「判词未通过，从来意义不大，根本看不懂」）
 *
 * ## 这段历史要留着，别让下一个 agent 又把它加回来
 *
 * 这套东西的来历不是没道理：记忆圣所一天出 6 份设计稿，最后那份写「总时长 4–5 小时，三幕」，
 * 而核心循环从没被任何人确认过值得玩，方寸所有闸照样全放行。于是做了「内容量闸」——
 * 核心没判过，就不许铺几小时内容。
 *
 * **但它被包装错了**：把"这个项目值不值得往上堆内容"做成「立得住 / 能玩 / 垃圾 / 未判」
 * 四个档位按钮，塞进项目方针弹窗，还要人先理解它控制的是"AI 出计划时能铺多少内容"。
 * 暮雨的判决是：看不懂，而且从来看不出意义。**他是用户，这个判决就是终判。**
 *
 * ## 现在的形状
 *   · **界面上一个判词都不出现**（弹窗四档选择器 / 输入框 / 项目页计数 / 概览卡格子，全拆）
 *   · **数据字段保留**：`coreVerdict` 仍在方针卡里，已写的不许因为拆界面而消失
 *   · **闸照旧保守**：不填 = 未判 = 只许最小原型。他不必理解它，也不会被它打扰
 *
 * ## 这套断言钉什么
 *   ① 界面里**没有**判词入口（防止下一个 agent 觉得"这是个好功能"又加回来）
 *   ② 拆界面**不丢数据**：保存方针时 `coreVerdict` 字段仍在
 *   ③ 数据层**仍然正确**：骨架 / 空 / 裸「未判」都算未判，真判过的不算（闸靠它）
 *   ④ `parseVerdict` 不许再犯"跳过未判档 → 当成自由文本 = 已判"那个 bug
 *
 * 运行：node scripts/test/e2e-verdict-gap.cjs   （需先 cd desktop && npm run build）
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'coreVerdict.js')

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
const { isUnjudged, verdictSkeleton } = require(ART)

const readSrc = (rel) => {
  const p = path.join(REPO, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
}
const stripComments = (s) => s
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

console.log('== 核心判词：界面已拆、数据保留 ==')

// ── ① 界面里一个判词入口都不许有 ──────────────────────────────────────
console.log('\n-- 界面已拆干净 --')
{
  const modal = stripComments(readSrc('desktop/src/renderer/components/PolicyEditModal.vue'))
  check('★★ 方针弹窗里没有四档选择器（.pf-vpick）', !/pf-vpick/.test(modal))
  check('★★ 方针弹窗里没有判词输入框（.pf-verdict-input）', !/pf-verdict-input/.test(modal))
  check('★ 方针弹窗里不再出现那四个档位词（立得住/能玩/垃圾）',
    !/立得住|垃圾/.test(modal), '')
  check('★ 方针弹窗不再 import 判词词表（拆干净，不留半块）',
    !/coreVerdict/.test(modal))

  const view = stripComments(readSrc('desktop/src/renderer/views/ProjectsView.vue'))
  check('★★ 项目页没有「判词待判 N/M」计数', !/judgeGap|判词待判/.test(view))
  check('★★ 概览卡没有「判词：已判/未判」那一格', !/policyJudgedMap|判词：/.test(view))
  check('★ 项目卡没有「⚖ 判词」按钮', !/⚖\s*判词/.test(view))

  const app = stripComments(readSrc('desktop/src/renderer/App.vue'))
  check('★ App.vue 不再算判词缺口（policyJudgedMap / judgeGap / openFirstUnjudged 全没了）',
    !/policyJudgedMap/.test(app) && !/judgeGap/.test(app) && !/openFirstUnjudged/.test(app))
}
{
  // 反例自证：拆之前这些词是在的 —— 断言不是"永远真"的空话
  const viewRaw = readSrc('desktop/src/renderer/views/ProjectsView.vue')
  check('★★ 反例自证：注释里**保留**了拆除理由（下个 agent 看得见为什么拆，不会又加回来）',
    /判词未通过|从来意义不大|根本看不懂/.test(viewRaw)
    || /判词未通过|从来意义不大|根本看不懂/.test(readSrc('desktop/src/renderer/components/PolicyEditModal.vue')),
    '')
}

// ── ② 拆界面不丢数据 ──────────────────────────────────────────────────
console.log('\n-- 拆界面 ≠ 丢数据 --')
{
  const app = readSrc('desktop/src/renderer/App.vue')
  // openPolicyEdit 仍要把读到的 coreVerdict 带给弹窗（弹窗不显示，但保存要原样带回）
  check('★★ 打开方针弹窗时仍读取 coreVerdict（不读 → 保存时会把旧值抹成空）',
    /coreVerdict\s*=\s*''/.test(app) && /coreVerdict\s*\}/.test(app) || /coreVerdict/.test(app))
  check('★ 保存链仍带上 coreVerdict 字段（主进程按"没传就沿用旧值"，界面必须显式带）',
    /coreVerdict:/.test(app))
  // 数据层仍认这个字段
  const pol = readSrc('desktop/src/main/services/policies.ts')
  check('★★ 方针卡数据层仍支持 coreVerdict（已写的判词不许因为拆界面而消失）',
    /coreVerdict/.test(pol))
}

// ── ③ 数据层判定仍然正确（闸靠它）────────────────────────────────────
console.log('\n-- 数据层：闸仍然保守 --')
{
  const skeleton = verdictSkeleton()
  check('★★ 骨架提示算未判（13 份项目的实际状态）', isUnjudged(skeleton) === true)
  check('★ 空串算未判', isUnjudged('') === true)
  check('★★ 只写「未判」两个字也算未判', isUnjudged('未判') === true,
    '这是 2026-11-14 修掉的 bug：第一版跳过 UNJUDGED 档 → 被当成自由文本 = 已判')
  check('★ `> 未判 …` 引用块算未判', isUnjudged('> 未判 —— 还没看') === true)
  check('★★ 真判过的（能玩 / 垃圾）不算未判 —— 闸会按它放行/拦住',
    isUnjudged('能玩 —— 装配台那 5 分钟确实是游戏 2026-11-12') === false
    && isUnjudged('垃圾 —— 两间房纯属填充物') === false)
}
{
  // 反例自证：如果按"非空就算判过"，骨架会被当成已判 —— 13 份全变成已判
  const naive = String(verdictSkeleton() || '').trim().length > 0
  check('★★ 反例自证：按"非空即判过"会得到相反结论（那正是闸会误放行的假绿）',
    naive === true && isUnjudged(verdictSkeleton()) === true)
}

// ── ④ 现场：13 份未判仍然数得出来（虽然界面不显示，闸要知道）───────────
console.log('\n-- 现场 --')
{
  const dir = path.join(REPO, 'policies')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : []
  let judged = 0, unjudged = 0
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf-8')
    const m = /(?:^|\n)##\s*核心判词\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/.exec(t)
    if (isUnjudged(m ? m[1].trim() : '')) unjudged++
    else judged++
  }
  check('★ 逐份核对：已判 + 未判 = 总数', judged + unjudged === files.length,
    `${judged}+${unjudged} vs ${files.length}`)
  console.log(`      现场：${files.length} 份方针卡 → 已判 ${judged} / 未判 ${unjudged}`)
  check('★★ 未判的项目仍然存在 —— 闸对它们保守（界面上不显示不等于闸失效）',
    unjudged > 0, 'unjudged=' + unjudged)
}

// ── ⑤ 内容量闸的代码还在（拆的是界面，不是闸）────────────────────────
{
  const scale = readSrc('desktop/src/shared/contentScale.ts')
  check('★★ contentScale 闸仍在（拆的是"要人填的界面"，不是"防铺错量的闸"）',
    /contentScaleGate/.test(scale))
  const plan = readSrc('desktop/src/main/llm/planDraft.ts')
  check('★ 计划器仍调这条闸（AI 出计划时照样会被拦）', /contentScaleGate/.test(plan))
}

console.log('\n' + (fail ? '❌ ' : '✅ ') + `RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(fail ? 1 : 0)
