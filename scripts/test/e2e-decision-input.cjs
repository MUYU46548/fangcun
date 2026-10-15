#!/usr/bin/env node
/**
 * 决策「智能录入」解析器断言（开发清单第 5 条，2026-10-14）
 *
 * 真跑**编译产物** `dist/shared/decisionInput.js`（纯逻辑，不需要 electron、不起子进程 → 本机可跑）。
 * 判据一句话：**贴一句话，能把「日期 / 项目 / 出处」摘出来填进各自字段；
 *            而且摘的过程中正文一个字都不能丢。**
 *
 * 运行：node scripts/test/e2e-decision-input.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'decisionInput.js')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { parseDecisionLine } = require(ART)
check('导出 parseDecisionLine', typeof parseDecisionLine === 'function')

const PROJECTS = ['司天', '绒花墨坊', '方寸']
const TODAY = '2026-10-14'
const p = (s, extra) => parseDecisionLine(s, { projects: PROJECTS, today: TODAY, ...(extra || {}) })

// ── 1. 完整一句 ────────────────────────────────────────────────────────
{
  const r = p('10月12日 定：司天不发版，唯一目标=标注+导出真图（出自 10-12 群 09:42）')
  check('① 日期抽出来（只有月日 → 补今天那年）', r.日期 === '2026-10-12', r.日期)
  check('① 项目认得出', r.项目 === '司天', r.项目)
  check('① 出处抽出来（不含标记词、不裹括号）', r.出处 === '10-12 群 09:42', r.出处)
  check('① 内容里不再留「出自」那段（它本来就是尾注）', !r.内容.includes('出自'), r.内容)
  check('★ ① 正文没被摘残：决策本体原样在', r.内容.includes('司天不发版，唯一目标=标注+导出真图'), r.内容)
  check('① 命中清单说得出拆了哪几栏', r.命中.join(',') === '出处,日期,项目', r.命中.join(','))
}

// ── 2. 顺序：出处里的日期不能被当成「哪天定的」─────────────────────────
{
  const r = p('出自 10-12 群 09:42，定：司天改口径')
  check('★★ ② 出处里的 10-12 不会被偷成「日期」（先摘出处、再抽日期）', r.日期 === '', `日期=${r.日期}`)
  check('② 出处摘到句读为止，不带后面的句子', r.出处 === '10-12 群 09:42', r.出处)
  check('② 后半句留在内容里', r.内容.includes('司天改口径'), r.内容)
  check('② 没日期就没日期这一栏，不乱猜', r.命中.join(',') === '出处,项目', r.命中.join(','))

  // ⚠ 已知口径（钉住而不是假装没有）：出处后面**只用空格**接下一句时，后半句会被一起吃进出处。
  //   没为它加"空格+汉字就断"的启发式 —— 那会把「出自 暮雨当日亲口定」这类正常出处切坏。
  //   代价可接受：拆出来的是**预填**，保存前四栏都能改。
  const r2 = p('出自 10-12 群 09:42 定：司天改口径')
  check('②（已知口径）空格接句、无标点时，出处会把后半句一起带上 —— 断言锁住这个行为',
    r2.出处 === '10-12 群 09:42 定：司天改口径' && r2.日期 === '', r2.出处)
}

// ── 3. 各种日期写法 ────────────────────────────────────────────────────
check('③ ISO 日期', p('2026-09-24 定：X').日期 === '2026-09-24')
check('③ 斜杠日期', p('2026/09/24 定：X').日期 === '2026-09-24')
check('③ 中文年月日', p('2026年9月24日定：X').日期 === '2026-09-24')
check('③ 月-日', p('9-24 定：X').日期 === '2026-09-24')
check('③ 昨天', p('昨天定：X').日期 === '2026-10-13')
check('③ 前天', p('前天定：X').日期 === '2026-10-12')
check('★ ③ 非法月日不吃字（99-99 留着，不硬凑一个日期）',
  (() => { const r = p('99-99 定：X'); return r.日期 === '' && r.内容.includes('99-99') })(),
  JSON.stringify(p('99-99 定：X')))

// ── 4. 项目：认得出，但**不从正文里删** ────────────────────────────────
{
  const r = p('司天不发版')
  check('★★ ④ 认出项目但不删正文（删了「司天不发版」就变成「不发版」）',
    r.项目 === '司天' && r.内容 === '司天不发版', `${r.项目} / ${r.内容}`)
  const r2 = p('定：X', { projects: [] })
  check('④ 没给项目清单就不乱认项目', r2.项目 === '', r2.项目)
}

// ── 5. 出处：尾部括注式 ────────────────────────────────────────────────
{
  const r = p('定：墨坊模板开工（台账 #1）')
  check('⑤ 尾部括注里有「台账」→ 认作出处', r.出处 === '台账 #1', r.出处)
  check('⑤ 括注摘掉后内容干净', r.内容 === '定：墨坊模板开工', r.内容)
  const r2 = p('定：X（临时）再改 Y')
  check('★ ⑤ 末尾不是括注就**不许**乱吃（中间括号是正文）', r2.出处 === '' && r2.内容.includes('（临时）'), `${r2.出处} / ${r2.内容}`)
  const r3 = p('定：X（临时）')
  check('⑤ 尾部括注但没有出处样关键词 → 不吃', r3.出处 === '' && r3.内容.includes('（临时）'), r3.出处)
}

// ── 6. 什么都拆不出来时 ────────────────────────────────────────────────
{
  const r = p('以后都这么办')
  check('⑥ 拆不出东西 → 整句进内容、命中为空（界面据此说"没拆出别的字段"）',
    r.内容 === '以后都这么办' && r.日期 === '' && r.项目 === '' && r.出处 === '' && r.命中.length === 0,
    JSON.stringify(r))
  const r2 = p('')
  check('⑥ 空串不炸', r2.内容 === '' && r2.命中.length === 0, JSON.stringify(r2))
  const r3 = parseDecisionLine(null)
  check('⑥ null 不炸', r3.内容 === '', JSON.stringify(r3))
}

// ── 7. 纯函数：不吃入参、两次一致 ─────────────────────────────────────
{
  const src = '10月12日 定：司天不发版（出自 10-12 群 09:42）'
  const a = p(src)
  const b = p(src)
  check('⑦ 入参字符串没被改（它是不变的原始值，但同一串两次结果必须一致）',
    src === '10月12日 定：司天不发版（出自 10-12 群 09:42）' && JSON.stringify(a) === JSON.stringify(b))
  const projects = ['司天']
  p('司天', { projects })
  check('⑦ projects 数组没被改', projects.length === 1 && projects[0] === '司天')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
