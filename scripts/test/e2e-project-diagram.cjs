#!/usr/bin/env node
/**
 * 项目结构图断言（2026-10-29 暮雨第 2 条 / 卡 20261029-002）
 *
 * 真跑**编译产物** `dist/shared/projectDiagram.js`（纯逻辑，不需要 electron、不起子进程）。
 * 判据不是"画得好看"，而是**这张图说了什么、没说谎什么**：
 *   ① 层顺序 = 项目 → 在途 → 已完成 → 执行日志（空层不画）；
 *   ② 在途按优先级排（高→中→低），超出的**必须写出来**（…还有 N 张），不许静默截断；
 *   ③ note 必须把界线说死：这是任务/日志结构，**不是代码架构图**（否则用户拿它当架构图使）；
 *   ④ 没任务/没日志时也只画项目那一层，不许出一张空图或崩掉。
 */

const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'projectDiagram.js')

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
const P = require(ART)

const T = (title, status, priority) => ({ title, status, priority })
const L = (title, status) => ({ title, status })
const PROJ = { id: 'fangcun-base', name: '方寸', status: '开发中' }

console.log('== ① 层与顺序 ==')
{
  const r = P.buildProjectDiagram({
    project: PROJ,
    tasks: [T('做甲', '进行中', '高'), T('做乙', '待办', '低'), T('已完成丙', '完成', ''), T('驳回丁', '驳回', '')],
    logs: [L('这一轮干了什么', '进行中')],
  })
  const names = r.spec.lanes.map((l) => l.name)
  check('★★ 层顺序 = 项目 → 在途 → 已完成 → 执行日志', names.join('>') === '项目>在途>已完成>执行日志', names.join('>'))
  check('项目层只有一张卡（项目身份 + 状态）',
    r.spec.lanes[0].cards.length === 1 && r.spec.lanes[0].cards[0].sub === '开发中',
    JSON.stringify(r.spec.lanes[0].cards))
  check('★ 驳回的卡不进「在途」也不进「已完成」', r.counts.open === 2 && r.counts.done === 1,
    JSON.stringify(r.counts))
  check('★ 层间标签数 = 层数 - 1（多给会被忽略，少给就少一行说明）',
    r.spec.between.length === r.spec.lanes.length - 1, JSON.stringify(r.spec.between))
}

console.log('\n== ② 在途排序与截断 ==')
{
  const many = []
  for (let i = 0; i < 9; i++) many.push(T('低优先' + i, '待办', '低'))
  many.push(T('高优先A', '待办', '高'), T('高优先B', '进行中', '高'))
  const r = P.buildProjectDiagram({ project: PROJ, tasks: many, logs: [] })
  const lane = r.spec.lanes.find((l) => l.name === '在途')
  check('★★ 在途按优先级排：高的先进图', /高优先/.test(lane.cards[0].label) && /高优先/.test(lane.cards[1].label),
    lane.cards.map((c) => c.label).join('|'))
  // 夹具共 11 张在途（9 低 + 2 高）→ 画 6 张 + 一张「还有 5 张」。数字现算，不写死。
  const EXPECT_OPEN = many.length
  const MAX_IN_VIEW = 6
  check('★★ 画不下就说出来（…还有 N 张），不许静默截断',
    lane.cards.length === MAX_IN_VIEW + 1 && lane.cards[MAX_IN_VIEW].label.indexOf('还有') >= 0
    && r.counts.hiddenOpen === EXPECT_OPEN - MAX_IN_VIEW,
    JSON.stringify([lane.cards.length, lane.cards[MAX_IN_VIEW].label, r.counts.hiddenOpen]))
  check('计数与图一致：图上 6 张真卡 + 1 张"还有"，且总数是全部在途',
    r.counts.open === EXPECT_OPEN && r.counts.hiddenOpen === EXPECT_OPEN - MAX_IN_VIEW,
    JSON.stringify(r.counts))
}

console.log('\n== ③ 界线必须写在图上 ==')
{
  const r = P.buildProjectDiagram({ project: PROJ, tasks: [T('甲', '待办', '中')], logs: [L('日志一', '待处理')] })
  check('★★ note 明写「不是代码架构图」（否则用户会拿它当架构图使）',
    r.note.indexOf('不是代码架构图') >= 0, r.note)
  check('★ note 指路 archify（要看代码架构去那边生成再导入）', r.note.indexOf('archify') >= 0, r.note)
  check('★ note 带真实计数（不是一句空话）',
    r.note.indexOf('1 张在途') >= 0 && r.note.indexOf('1 条日志') >= 0, r.note)
}

console.log('\n== ④ 空数据的退化 ==')
{
  const r = P.buildProjectDiagram({ project: PROJ, tasks: [], logs: [] })
  check('★★ 没任务没日志也只画项目层（不出空图、不抛）',
    r.spec.lanes.length === 1 && r.spec.lanes[0].name === '项目', JSON.stringify(r.spec.lanes.map((l) => l.name)))
  check('  空层不画（不造"这里本该有东西"的空框）', r.spec.lanes.every((l) => l.cards.length > 0))
  check('  计数全 0', r.counts.open === 0 && r.counts.done === 0 && r.counts.logs === 0, JSON.stringify(r.counts))
}

console.log('\n== ⑤ 渲染得出来（真跑 buildLayerDiagram）==')
{
  const LD = require(path.join(REPO, 'desktop', 'dist', 'shared', 'layerDiagram.js'))
  const r = P.buildProjectDiagram({
    project: PROJ,
    tasks: [T('做甲', '进行中', '高'), T('已完成丙', '完成', '')],
    logs: [L('这一轮干了什么', '进行中')],
  })
  let svg = ''
  try { svg = LD.buildLayerDiagram(r.spec) } catch (e) { svg = 'ERR:' + e.message }
  check('★★ 出得了 SVG（spec 与渲染器口径对得上）', svg.startsWith('<svg'), svg.slice(0, 80))
  check('  图上真带项目名与卡标题', svg.indexOf('方寸') >= 0 && svg.indexOf('做甲') >= 0)
}

console.log(`\nRESULT ${pass} / ${fail ? pass + fail : pass}` + (fail ? `  (${fail} 条失败)` : ''))
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
