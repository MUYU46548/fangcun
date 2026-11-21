#!/usr/bin/env node
/**
 * 装完验收清单（2026-11-21）
 *
 * 判据：
 *   ① 只收状态=待验收；完成/驳回/归档卡不进；
 *   ② 判据原文照抄（有「## 判据」就抄那段，没有就如实说“没写”，不编）；
 *   ③ 版本号来自调用方（pack.cjs 从 package.json 读），清单里不得手写别的版本；
 *   ④ 写成文件后能读回，且卡数与 loadPendingCards 一致。
 */
const fs = require('fs')
const path = require('path')
const { mkTmp } = require('./_tmp.cjs')
const lib = require('../lib/releaseChecklist.cjs')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

const TMP = mkTmp('release-checklist-')
const TASK = path.join(TMP, 'task-data')
const OUT = path.join(TMP, 'pkg')
fs.mkdirSync(TASK, { recursive: true })

const mk = (file, fm, body) => fs.writeFileSync(path.join(TASK, file), [
  '---', ...fm, '---', '', body || '',
].join('\n'), 'utf-8')

mk('a.md', ['id: task-a', '标题: 待验收有判据', '项目: [demo]', '状态: 待验收', '更新: 2026-11-21'], [
  '## 结果记录', '做完了', '', '## 判据', '- 点开卡能看到 A', '- 点通过后卡消失', '',
].join('\n'))
mk('b.md', ['id: task-b', '标题: 待验收没判据', '项目: [demo]', '状态: 待验收', '更新: 2026-11-20'],
  '## 方案\n随便写两句，没有判据段。\n')
mk('c.md', ['id: task-c', '标题: 已完成的卡', '项目: [demo]', '状态: 完成', '更新: 2026-11-21'],
  '## 判据\n- 这条不该进清单\n')
mk('d.md', ['id: task-d', '标题: 驳回的卡', '项目: [demo]', '状态: 驳回', '更新: 2026-11-21'],
  '## 判据\n- 这条也不该进\n')

const cards = lib.loadPendingCards(TASK)
check('★ 只收“待验收”：完成/驳回不进', cards.length === 2 && cards.every((c) => c.id !== 'task-c' && c.id !== 'task-d'),
  cards.map((c) => c.id).join(','))
const a = cards.find((c) => c.id === 'task-a')
const b = cards.find((c) => c.id === 'task-b')
check('★ 判据段原文抽出来了（含两条）', !!a && /点开卡能看到 A/.test(a.criteria) && /点通过后卡消失/.test(a.criteria),
  a && a.criteria)
check('★ 没有判据段就空串（不编）', !!b && b.criteria === '', b && b.criteria)

const md = lib.buildChecklist({ version: '0.7.5', cards })
check('★ 版本号来自参数，清单里就是它', /方寸 0\.7\.5 装完验收清单/.test(md), md.slice(0, 40))
check('★ 卡数写明', /本版共 \*\*2\*\* 张/.test(md), md.split('\n')[2])
check('★ 有判据的卡原文在清单里', md.includes('点开卡能看到 A') && md.includes('点通过后卡消失'))
check('★ 没判据的卡如实标“没有…段”（不是空着）', md.includes('没有「## 判据 / ## 验收 / ## 验收线」段'))

const r = lib.writeReleaseChecklist({ repoRoot: TMP, outDir: OUT, version: '0.7.5' })
check('★ 写成文件后能读回，卡数一致', fs.existsSync(r.path) && r.cards === 2 && fs.readFileSync(r.path, 'utf-8').includes('task-a'),
  JSON.stringify({ path: r.path, cards: r.cards }))

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
