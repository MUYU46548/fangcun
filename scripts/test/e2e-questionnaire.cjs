#!/usr/bin/env node
/**
 * 问卷解析 · 端到端（2026-11-05）
 *
 * 判据不是“能解析”，而是**拿他真实用过的 4 份问卷跑，逐题对得上** ——
 * 这 4 份在 `references/问卷样本/`（暮雨 11-04 手写、AI 写、他亲手答过）。
 * 只要有一道题认丢了、或者选项少认一个，界面上就会出现“0 题”或“选项不全”的假象。
 *
 * 覆盖：
 *  ① 4 份真样本的题数 / 题号 / 选项数逐份核对；
 *  ② 题干可以缺席（墨坊 M1 直接跟选项）；
 *  ③ 破折号三种写法都吃；
 *  ④ 表格类 `##`（入口总表 / 裁决层预埋）不许被当成题；
 *  ⑤ 空文件 / 格式不对 → **显式报错**，不许静默返回空卷。
 *
 * 运行：node scripts/test/e2e-questionnaire.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'questionnaire.js')
const SAMPLES = path.join(REPO, 'references', '问卷样本')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1'); process.exit(1)
}
const { parseQuestionnaire } = require(ART)

const read = (f) => fs.readFileSync(path.join(SAMPLES, f), 'utf8').replace(/\r\n/g, '\n')

console.log('== 四份真样本逐份核对 ==')

// ── 司天 · 宪法层：S1–S7，共 7 题 ──────────────────────────────
{
  const d = parseQuestionnaire(read('问卷-司天-宪法层-20261104.md'))
  check('司天·宪法层：认出 7 题（S1–S7）', d.questions.length === 7, String(d.questions.length))
  check('  题号逐个对上', d.questions.map((q) => q.id).join(',') === 'S1,S2,S3,S4,S5,S6,S7',
    d.questions.map((q) => q.id).join(','))
  check('  层名从标题认出来', d.layer === '宪法层', d.layer)
  check('  使用边界收下来了（不是丢字段）', /打勾|否决|改一句/.test(d.boundary), d.boundary.slice(0, 40))
  const s1 = d.questions[0]
  check('  S1 题干 = “司天做一件还是两件？”', s1.ask.indexOf('司天做一件还是两件') >= 0, s1.ask)
  check('  S1 三个选项、标题与说明分开',
    s1.options.length === 3 && s1.options[0].k === 'A'
      && /生成器/.test(s1.options[0].t) && /Gaea/.test(s1.options[0].d),
    JSON.stringify(s1.options[0]))
  check('  S1 出处 / 验收线都在',
    /四问总表/.test(s1.src) && /打回/.test(s1.line), s1.src + ' | ' + s1.line)
  check('  S2 有 4 个选项（D 档“三件同批开工”）', d.questions[1].options.length === 4,
    String(d.questions[1].options.length))
  const s5 = d.questions[4]
  check('★★ S5 是“已答过”的题 —— 界面要标成预填，不许让人重答一遍',
    s5.prefilled === true && /已答过|预填/.test(s5.prefilledNote), JSON.stringify({ p: s5.prefilled, n: s5.prefilledNote }))
}

// ── 司天 · 裁决层 A：S8–S16，共 9 题 + 入口总表 8 行 ────────────
{
  const d = parseQuestionnaire(read('问卷-司天-裁决层A-20261104.md'))
  check('司天·裁决层A：认出 9 题（S8–S16）', d.questions.length === 9, String(d.questions.length))
  check('  题号从 S8 开始、到 S16 结束',
    d.questions[0].id === 'S8' && d.questions[8].id === 'S16',
    d.questions[0].id + '…' + d.questions[8].id)
  check('★★ 「看一眼·入口总表」被认成表，**不是**一道题',
    d.lookTable.length === 8 && !d.questions.some((q) => /入口总表/.test(q.nav)),
    'lookTable=' + d.lookTable.length)
  check('  表里三列都对（名字 / 人话 / 入口）',
    d.lookTable[0].nm === 'WorldPainter' && /桌面手绘/.test(d.lookTable[0].ds) && /worldpainter/.test(d.lookTable[0].url),
    JSON.stringify(d.lookTable[0]))
  check('★★ 「摊不开的（B 类）」被认成预埋表，也不是题',
    d.parked.length >= 2 && !d.questions.some((q) => /摊不开|预埋/.test(q.nav)),
    'parked=' + d.parked.length)
  check('  S15 的选项里有“都试过再答”和“都不是我要的”（4 个）',
    d.questions.find((q) => q.id === 'S15').options.length === 4,
    String(d.questions.find((q) => q.id === 'S15').options.length))
}

// ── 墨坊 · 宪法层：M1–M7 ──────────────────────────────────────
{
  const d = parseQuestionnaire(read('问卷-墨坊-宪法层-20261104.md'))
  check('墨坊·宪法层：认出 7 题（M1–M7）', d.questions.length === 7, String(d.questions.length))
  check('  题号 M1–M7', d.questions.map((q) => q.id).join(',') === 'M1,M2,M3,M4,M5,M6,M7',
    d.questions.map((q) => q.id).join(','))
  check('★★ 题干缺席也能认（M1 是 `## M1 …` 直接跟选项）',
    d.questions[0].id === 'M1' && d.questions[0].options.length >= 3,
    JSON.stringify({ id: d.questions[0].id, n: d.questions[0].options.length, ask: d.questions[0].ask.slice(0, 20) }))
  check('  每题都有出处与验收线（样本里一条不漏）',
    d.questions.every((q) => q.src.length > 0 && q.line.length > 0),
    d.questions.filter((q) => !q.src || !q.line).map((q) => q.id).join(','))
}

// ── 墨坊 · 裁决层 A：M8–M12 ──────────────────────────────────
{
  const d = parseQuestionnaire(read('问卷-墨坊-裁决层A-20261104.md'))
  check('墨坊·裁决层A：认出 5 题（M8–M12）', d.questions.length === 5, String(d.questions.length))
  check('  层名认成「裁决层」', d.layer === '裁决层', d.layer)
}

console.log('\n== 容错与边界 ==')
{
  // 破折号三种写法
  const md = [
    '# 测试卷·宪法层', '',
    '## T1 破折号三连', '题干写在选项上面',
    '- **A. 两个 em dash**——说明甲',
    '- **B. 一个 em dash**—说明乙',
    '- **C. 两个半角**--说明丙', '',
    '【出处】无', '【验收线】无',
  ].join('\n')
  const d = parseQuestionnaire(md)
  check('★★ 破折号 `——` / `—` / `--` 三种写法都能把标题与说明分开',
    d.questions.length === 1 && d.questions[0].options.length === 3
      && d.questions[0].options[0].d === '说明甲'
      && d.questions[0].options[1].d === '说明乙'
      && d.questions[0].options[2].d === '说明丙',
    JSON.stringify(d.questions[0] && d.questions[0].options))
}
{
  const d = parseQuestionnaire('')
  check('★★ 空文件 → 显式报错（不许静默返回“0 题的卷子”）', !!d.error && d.questions.length === 0, d.error)
}
{
  const d = parseQuestionnaire('# 乱七八糟\n\n这里没有任何题目格式')
  check('★★ 格式全不对 → 也报错，并提示正确写法', !!d.error && /## S1|选项/.test(d.error), d.error)
}
{
  const d = parseQuestionnaire(['# 残卷·宪法层', '', '## X1 只有一个选项', '- **A. 唯一**——说明'].join('\n'))
  check('★ 选项少于 2 个 → 报出来（多半是写法不对，不是“真的只有一个选项”）',
    !!d.error && /X1/.test(d.error), d.error)
}
{
  // 解析结果必须是纯数据（能过桥、能存档）
  const d = parseQuestionnaire(read('问卷-司天-宪法层-20261104.md'))
  let ok = true
  try { JSON.parse(JSON.stringify(d)) } catch { ok = false }
  check('★ 结果能 JSON 往返（要过 IPC 桥、要落盘草稿）', ok)
}

console.log('== 【意见】字段：卷子必须带判断，不能只给选项 ==')
// 2026-11-15 暮雨：「不要只是给我看不懂的问题，这是方寸本身也存在的问题」。
// 病根不是"题目问得不好"，是**只给选项、不给判断** —— 出一份问卷就等于把决策成本
// 原样转嫁回用户，看起来在帮忙，其实只是把题目排整齐了。
{
  const deck = parseQuestionnaire([
    '# 测试卷（裁决层）', '',
    '## S1 该怎么选', '',
    '这题该怎么选？', '',
    '- **A. 甲**——代价甲', '- **B. 乙**——代价乙', '- **C. 丙**——代价丙', '',
    '【意见】B：乙最省事，且不堵后面的路。', '',
    '## S2 另一题', '',
    '这题呢？', '',
    '- **A. 甲**——代价甲', '- **B. 乙**——代价乙', '',
    '【意见】不好说，两边各有各的代价。', '',
  ].join('\n'))
  const s1 = deck.questions.find((q) => q.id === 'S1')
  const s2 = deck.questions.find((q) => q.id === 'S2')
  check('★★ 【意见】能解析出来（卷子可以带我的判断）',
    !!s1 && /乙最省事/.test(s1.opinion), s1 ? JSON.stringify(s1.opinion) : '没有 S1')
  check('★★ 意见里点名的档位认出来了（recommend=B）',
    !!s1 && s1.recommend === 'B', s1 ? s1.recommend : '没有 S1')
  check('★★ 认不出推荐时**留空**，不许瞎指一个',
    !!s2 && s2.recommend === '', s2 ? '"' + s2.recommend + '"' : '没有 S2')
  check('★ 没写【意见】的题 opinion 是空串（不是 undefined，界面才好判断）',
    !!s1 && typeof s1.opinion === 'string')
}

console.log('== recommendOf 的边界（认错比没有更糟）==')
{
  const R = require(ART).recommendOf
  check('★ 开头字母 + 冒号', R('B：理由') === 'B')
  check('★ 开头字母 + 句点', R('C. 理由') === 'C')
  check('★ 「选 B」形态', R('我倾向这个，选 B 吧') === 'B')
  check('★★ 只是**提到**的字母不算推荐（"不比 A 差"不许被判成推荐 A）',
    R('这个方案不比 A 差，但…') === '', '"' + R('这个方案不比 A 差，但…') + '"')
  check('★ 空意见给空串', R('') === '')
  check('★ 非字符串不炸', R(null) === '')
}

console.log('')
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  · ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
