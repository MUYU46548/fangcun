#!/usr/bin/env node
/**
 * JSON 输出体检 · 纯函数（2026-11-07）
 *
 * 由来：`docs/投入产出-第一条真事实-20261107.md` 第三条 —— 方寸自己的 10 次 AI 调用 5 次失败，
 * 全死在"模型没给 JSON"。过去文案只有一句"生成失败"，于是重试只能盲目重试；
 * 现在分四类，**每类的重试指令不同**（截断要"少画点"，不是"注意格式"）。
 *
 * 运行：node scripts/test/e2e-json-repair.cjs
 */
const path = require('path')

const DIST = path.resolve(__dirname, '../../desktop/dist')
const { inspectJson, jsonRetryNudge } = require(path.join(DIST, 'shared', 'jsonRepair.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

console.log('== ① 四种形状各归各位 ==')
{
  check('空串 → no_content', inspectJson('').kind === 'no_content')
  check('只有空白 → no_content', inspectJson('  \n\t ').kind === 'no_content')

  const prose = '好的，我来分析一下这个项目。它主要分为三层……后面省略很多字'
  const rProse = inspectJson(prose)
  check('★★ 满篇散文 → not_json（并报出字符数，别只说"失败"）',
    rProse.kind === 'not_json' && rProse.message.indexOf(String(prose.length)) >= 0,
    rProse.kind + ' / ' + rProse.message)

  const cut = '{"stages":[{"id":"P1","title":"地基","what":"先做'
  const rCut = inspectJson(cut)
  check('★★ 说到一半断掉 → truncated（不是 not_json、更不是 invalid）', rCut.kind === 'truncated', rCut.kind)

  const broken = '{"stages":[{"id":"P1",}]}'
  const rBroken = inspectJson(broken)
  check('★ 括号对得上但内容坏 → invalid', rBroken.kind === 'invalid', rBroken.kind)

  check('★ 合法 JSON → kind 为空串，body 是那段', (() => {
    const x = inspectJson('前言\n{"a":1}\n后记')
    return x.kind === '' && JSON.parse(x.body).a === 1
  })())

  check('★ ```json 围栏被剥掉（模型最爱加）', (() => {
    const x = inspectJson('```json\n{"a":2}\n```')
    return x.kind === '' && JSON.parse(x.body).a === 2
  })())
}

console.log('\n== ② 重试指令按类型给（这是分型的全部意义）==')
{
  const n = (k) => jsonRetryNudge(k)
  const all = ['no_content', 'not_json', 'truncated', 'invalid'].map(n)
  check('★★ 四类指令互不相同（写成同一句 = 等于没分型）',
    new Set(all).size === 4, JSON.stringify(all.map((s) => s.slice(0, 12))))
  check('★ truncated 的指令要求"减少条目"，不是"注意格式"',
    /减少/.test(n('truncated')) && !/减少/.test(n('not_json')), n('truncated'))
  check('★ not_json 的指令要求"只输出 JSON"，不要解释文字',
    /只输出/.test(n('not_json')) && /不要解释/.test(n('not_json')), n('not_json'))
  check('★ 未知类型回落到最保守的那句（不许抛异常）', typeof n('whatever') === 'string' && n('whatever').length > 0)
}

console.log('\n== ③ 反例：边界输入不许崩 ==')
{
  check('反例：null / undefined 当空串处理', inspectJson(undefined).kind === 'no_content' && inspectJson(null).kind === 'no_content')
  check('反例：只有左括号 → truncated（不是抛错）', inspectJson('{').kind === 'truncated')
  check('反例：只有右括号 → not_json（找不到起点）', inspectJson('}').kind === 'not_json')
  check('反例：数组（不是对象）也能 parse，交给调用方判结构', inspectJson('[1,2]').kind === 'not_json')
}

console.log('')
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  · ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
