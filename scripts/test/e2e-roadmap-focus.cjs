#!/usr/bin/env node
/**
 * 路线图的决策视角 —— 纯逻辑断言（2026-10-31）
 *
 * 暮雨第 7 条：「阻塞、路线图、日历……它们从来都是有用且有必要存在的功能，只是没做好。」
 * 路线图服务的决策只有一句：**这个项目现在该推哪一批？**
 *
 * 真跑**编译产物** `dist/shared/roadmapFocus.js`（纯逻辑，不碰 electron、不起子进程 → 本机可跑）。
 * 这里钉的是口径，不是布局：
 *   ① 当前批次只能从「没做完的批次」里挑（active > blocked > pending），全收口 = 没有当前批次；
 *   ② 排序按"该先看谁"（进行中 > 被卡 > 未开始 > 全收口），同档里剩下的少的先；
 *   ③ 没有批次就**如实说**，不造一个「未分类」阶段；空的「未分类」不算一个阶段；
 *   ④ 一行结论必须点名项目与批次（界面直印，不重算）。
 *
 * 运行：node scripts/test/e2e-roadmap-focus.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'roadmapFocus.js')

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
const { focusOfProject, focusRoadmap, orderBatches } = require(ART)

const B = (name, status, done, total) => ({
  name, status, done, total,
  tasks: Array.from({ length: total }, (_, i) => ({
    id: `${name}-${i}`, title: `${name} 第 ${i + 1} 张`, status: i < done ? '完成' : '待办',
  })),
})
const P = (id, name, health, batches, nextActions = []) => ({ id, name, health, batches, nextActions })

console.log('== ① 当前批次：只能从没做完的里挑 ==')

const A = focusOfProject(P('a', '甲项目', 'active', [B('P0 核心', 'completed', 2, 2), B('P1 功能', 'active', 1, 3)]))
check('★★ 当前批次 = 正在推的那批（P1，不是已完成的 P0）',
  !!A.current && A.current.name === 'P1 功能', JSON.stringify(A.current && A.current.name))
check('★ 还剩几张 = total - done（3 - 1 = 2）', A.remaining === 2, String(A.remaining))
check('★ 进度百分比按 done/total 算（1/3 → 33）', A.percent === 33, String(A.percent))
check('★ 已收口批次数单独给出（1 个）', A.doneBatches === 1 && A.totalBatches === 2,
  `${A.doneBatches}/${A.totalBatches}`)

const blocked = focusOfProject(P('b', '乙项目', 'stuck', [B('P0', 'pending', 0, 2), B('P1', 'blocked', 0, 4)]))
check('★★ 没有进行中时，被卡的批次优先于没开始的（P1 而不是 P0）',
  !!blocked.current && blocked.current.name === 'P1', JSON.stringify(blocked.current && blocked.current.name))

const allDone = focusOfProject(P('c', '丙项目', 'idle', [B('P0', 'completed', 2, 2)]))
check('★★ 全收口 → 没有当前批次（不糊一个"最后一版"当当前）', allDone.current === null)
check('★ 全收口文案明说"该规划下一批"', /全部收口|该规划下一批/.test(allDone.text), allDone.text)

const noBatch = focusOfProject(P('d', '丁项目', 'idle', []))
check('★ 一张批次都没有 → 明说"还没排批"（不造一个阶段）',
  noBatch.current === null && /还没排批|还没有排批/.test(noBatch.text), noBatch.text)

console.log('\n== ② 空的「未分类」不算一个阶段 ==')

const unclassified = focusOfProject(P('e', '戊项目', 'idle', [B('未分类', 'pending', 0, 3)]))
check('★ 「未分类」且一张都没完成 → 不算批次（current 为空）', unclassified.current === null,
  JSON.stringify(unclassified.current && unclassified.current.name))
check('★ 但真有「未分类」的活时 totalBatches 仍如实算 0（那 3 张不算一个阶段）',
  unclassified.totalBatches === 0, String(unclassified.totalBatches))

console.log('\n== ③ 排序：该先看的在前 ==')

const ro = focusRoadmap([
  P('c', '丙项目', 'idle', [B('P0', 'completed', 2, 2)]),
  P('b', '乙项目', 'stuck', [B('P0', 'blocked', 0, 4)]),
  P('a', '甲项目', 'active', [B('P1 功能', 'active', 1, 3)]),
  P('d', '丁项目', 'idle', [B('P0', 'pending', 0, 2)]),
])
check('★★ 排序 = 进行中 > 被卡 > 未开始 > 全收口',
  ro.rows.map((r) => r.id).join(',') === 'a,b,d,c', ro.rows.map((r) => `${r.id}:${r.rank}`).join(','))
check('★ 计数分开给（在推 1 / 卡着 1）', ro.activeCount === 1 && ro.stuckCount === 1,
  `${ro.activeCount}/${ro.stuckCount}`)

const roTie = focusRoadmap([
  P('x', '只剩一张', 'active', [B('P1', 'active', 2, 3)]),
  P('y', '还剩五张', 'active', [B('P1', 'active', 0, 5)]),
])
check('★ 同档里"剩下的少的先"（再推两张就能收口的最值得先动）',
  roTie.rows[0].id === 'x', roTie.rows.map((r) => `${r.id}:${r.remaining}`).join(','))

console.log('\n== ④ 一行结论 & 脏输入 ==')

check('★★ 结论点名项目与批次（不只是一句"有几个项目"）',
  /甲项目/.test(ro.text) && /P1 功能/.test(ro.text) && /还剩 2 张/.test(ro.text), ro.text)
const empty = focusRoadmap([])
check('★ 没有项目 → 明说"还没有任何项目排过批次"，不报 0', /还没有任何项目/.test(empty.text), empty.text)
check('★ 脏输入不抛（null / 非数组）',
  focusRoadmap(null).rows.length === 0 && focusRoadmap('x').rows.length === 0)

console.log('\n== ⑤ 批次展示顺序：正在推 → 被卡 → 没开始 → 已完成 ==')

const ordered = orderBatches([B('P3', 'completed', 2, 2), B('P0', 'pending', 0, 2), B('P1', 'active', 0, 2)])
check('★ 批次顺序按状态排（active 第一，completed 最后）',
  ordered.map((b) => b.name).join(',') === 'P1,P0,P3', ordered.map((b) => b.name + ':' + b.status).join(','))
check('★ 纯函数：不修改传入数组', (() => {
  const raw = [B('P3', 'completed', 2, 2), B('P1', 'active', 0, 2)]
  const snap = JSON.stringify(raw)
  orderBatches(raw)
  return JSON.stringify(raw) === snap
})())

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
