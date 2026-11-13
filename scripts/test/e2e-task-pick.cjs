#!/usr/bin/env node
/**
 * 「挑一张卡」的检索 —— 唯一真源（2026-11-13 · 卡 `日志关联任务候选搜索是单串-includ-2b1e3d59`）
 *
 * 为什么这套断言必须存在：
 *   暮雨跨 5 天说了 5 次「日志关联任务筛选约等于无 / 依旧找不到需要的东西 / 抄本项目的东西都抄不好」。
 *   前四次的"修复"改的都是**包装**（按项目过滤 / 多选 / 按需展开 / 分组），
 *   一次都没碰**匹配** —— 因为这件事没有单一真源，每个入口都从零写一遍 `includes`。
 *
 * 所以这里钉的不是"能搜出东西"，而是**三件会让它退回去的事**：
 *   ① 多词是 AND 而不是整串子串（「日志 筛选」必须能查到分开写着这两个词的卡）；
 *   ② 有词就按相关度排，且回车选的就是**画面上第一行**；
 *   ③ 「另有 N 张没显示」与切档后实际条数**恒等**（同一屏不许两个答案）。
 *
 * 每条判据都配**反例自证**：把实现改回旧的错法，必须精确变红 —— 否则这条断言只是装饰。
 *
 * 运行：node scripts/test/e2e-task-pick.cjs   （需先 cd desktop && npm run build）
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'taskPick.js')

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
const {
  taskPick, taskPickHiddenByStatus, taskPickFirst, taskPickMatches,
  taskPickRank, normalizeQuery, defaultIsDone, TASK_PICK_FIELD_RANK,
} = require(ART)

// ── 夹具：真实形状（project 单值/数组/写坏成 '- x'，tags 数组/串，状态中文）──────
const T = (id, title, project, status, extra) => Object.assign({
  id, title, project, status, tags: [],
}, extra || {})

const POOL = [
  // 这一张故意放在**最前面**，且目标词只出现在**标签**里（标题里一个都没有）——
  // 用来验"标题命中要排到标签命中之前"：不做相关度排序时它会抢到第一行。
  T('card-j', '这个词只在标签里', 'sitian', '待办', { tags: ['真源'], updated: '2026-11-01T00:00:00Z' }),
  // 「日志」在标签里、「筛选」在标题里 —— 专测"两个词命中不同字段"的 AND
  T('card-a', '关联任务候选：筛选要能多词', 'fangcun-base', '待办', { tags: ['日志', '检索'], updated: '2026-11-12T00:00:00Z' }),
  T('card-b', '把筛选能力收到单一真源', 'fangcun-base', '进行中', { tags: ['重构'], updated: '2026-11-11T00:00:00Z' }),
  T('card-c', '绒花墨坊：素材管线要停下来问', 'project-2', '待办', { tags: ['管线'], updated: '2026-11-10T00:00:00Z' }),
  T('card-d', '已做完的那张（终态）', ['fangcun-base'], '完成', { tags: [], updated: '2026-11-09T00:00:00Z' }),
  T('card-e', '被驳回的那张（终态）', 'fangcun-base', '驳回', { tags: [], updated: '2026-11-08T00:00:00Z' }),
  // 写坏的项目字段：YAML 块式列表被当标量读进来（实测本仓有 8 张这样，永远搜不到）
  T('card-f', '项目字段写坏的那种卡', '- fangcun-base', '待办', { tags: [], updated: '2026-11-07T00:00:00Z' }),
  T('card-g', '标签里才有"验收"两个字', 'sitian', '待验收', { tags: ['验收', '阈值'], updated: '2026-11-06T00:00:00Z' }),
  // 同 rank 并列的两张：用来验"并列时保持入参顺序"，不许因 sort 不稳定而乱跳
  T('card-h', '并列用的：第一张', 'fangcun-base', '待办', { tags: [], updated: '2026-11-05T00:00:00Z' }),
  T('card-i', '并列用的：第二张', 'fangcun-base', '待办', { tags: [], updated: '2026-11-04T00:00:00Z' }),
]
const PROJ_NAME = { 'fangcun-base': '方寸', 'project-2': '绒花墨坊', 'sitian': '司天' }
const projName = (id) => PROJ_NAME[id] || ''

console.log('== 挑卡检索：唯一真源 ==')

// ── ① 空输入 / 坏输入 ────────────────────────────────────────────────
check('空数组 → 空结果', taskPick([]).length === 0)
check('null / undefined → 空结果（不抛）',
  taskPick(null).length === 0 && taskPick(undefined).length === 0)
check('空查询词 = 全命中（不做任何过滤）',
  taskPick(POOL, { query: '' }).length === POOL.length)
check('normalizeQuery：全角空格 / 制表 / 多余空格都拆干净',
  JSON.stringify(normalizeQuery('  日志\u3000 筛选 \t')) === '["日志","筛选"]')

// ── ② 多词 AND（本卡的第一条病根治）────────────────────────────────
console.log('\n-- 多词 AND（旧实现整串 includes → 多词必死）--')
check('★ 旧错法自证：整串 includes 查「日志 筛选」= 0 条（这是当初的现场）',
  POOL.filter(t => `${t.id} ${t.title} ${t.project}`.toLowerCase().includes('日志 筛选')).length === 0)
const multi = taskPick(POOL, { query: '日志 筛选', status: 'all' })
check('★★ 「日志 筛选」现在能命中（两个词分别在标题/标签里，AND 成立）',
  multi.length > 0 && multi.some(r => r.task.id === 'card-a'),
  JSON.stringify(multi.map(r => r.task.id)))
check('★ 多词 AND 不是"任一命中"：只命中一个词的不许进来',
  multi.every(r => {
    const hay = `${r.task.id} ${r.task.title} ${r.task.project} ${(r.task.tags || []).join(' ')}`.toLowerCase()
    return '日志'.includes('日志') && hay.includes('日志') && hay.includes('筛选')
  }), JSON.stringify(multi.map(r => r.task.id)))
check('词序无关：「筛选 日志」与「日志 筛选」命中同一批',
  JSON.stringify(taskPick(POOL, { query: '筛选 日志' }).map(r => r.task.id).sort())
  === JSON.stringify(taskPick(POOL, { query: '日志 筛选' }).map(r => r.task.id).sort()))

// ── ③ 匹配面：标签 / 状态 / 项目名（不只是 id + 标题）─────────────────
console.log('\n-- 匹配面（旧实现只有 id + 标题 + 项目）--')
check('★ 能按**标签**找到卡（旧实现查不到）',
  taskPick(POOL, { query: '阈值' }).some(r => r.task.id === 'card-g'),
  JSON.stringify(taskPick(POOL, { query: '阈值' }).map(r => r.task.id)))
check('★ 能按**项目显示名**找到卡（人记的是"绒花墨坊"，不是 project-2）',
  taskPick(POOL, { query: '绒花墨坊', projectName: projName }).some(r => r.task.id === 'card-c'))
check('★ 写坏的项目字段（`- fangcun-base`）也能按项目搜到',
  taskPick(POOL, { query: 'fangcun-base', projectName: projName }).some(r => r.task.id === 'card-f'),
  JSON.stringify(taskPick(POOL, { query: 'fangcun-base', projectName: projName }).map(r => r.task.id)))
check('按状态也能搜（"待验收"三个字）',
  taskPick(POOL, { query: '待验收' }).some(r => r.task.id === 'card-g'))

// ── ④ 相关度排序（旧实现按"最近更新"，与查询无关）────────────────────
console.log('\n-- 相关度排序 --')
const ranked = taskPick(POOL, { query: '真源', status: 'all' })
check('★ 标题命中的排在标签/项目命中之前（card-j 入参在前但只命中标签）',
  ranked.length > 0 && ranked[0].task.id === 'card-b',
  JSON.stringify(ranked.map(r => [r.task.id, r.rank])))
check('★ 反例自证：不排序时排第一的**不是** card-b（否则上面那条是空转断言）',
  POOL.filter(t => '真源'.split(' ').every(w => `${t.id} ${t.title} ${(t.tags || []).join(' ')}`.includes(w)))[0].id === 'card-j'
  && ranked[0].task.id !== 'card-j')
check('rank 字段是具体字段名（界面靠它解释"为什么在第一行"）',
  ranked[0].rank === 'title', String(ranked[0].rank))
check('同 rank 保持入参顺序（不因 sort 不稳定而乱跳）',
  JSON.stringify(taskPick(POOL, { query: '并列用的' }).map(r => r.task.id))
  === JSON.stringify(['card-h', 'card-i']))
check('无查询词时**不排序**（原样返回，调用方自己按更新时间排）',
  JSON.stringify(taskPick(POOL).map(r => r.task.id)) === JSON.stringify(POOL.map(t => t.id)))
check('TASK_PICK_FIELD_RANK：标题在最前、状态在最后',
  TASK_PICK_FIELD_RANK.title === 0 && TASK_PICK_FIELD_RANK.status === 4)

// ── ⑤ 回车 = 画面上第一行 ───────────────────────────────────────────
console.log('\n-- 回车选中的是"渲染顺序第一行" --')
check('★ taskPickFirst 返回的正是排序后的第 1 条',
  taskPickFirst(POOL, { query: '真源', status: 'all' })?.id === 'card-b')
check('旧错法自证：按更新时间取第 1 条 ≠ 相关度第 1（当初"回车挂错卡"的现场）',
  POOL.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0].id === 'card-a'
  && taskPickFirst(POOL, { query: '真源', status: 'all' })?.id !== 'card-a')
check('没有候选 → null（不许返回 undefined 让模板炸）',
  taskPickFirst(POOL, { query: '绝对搜不到的词xyz' }) === null)

// ── ⑥ 状态档与"另有 N 张"必须同一个口径 ─────────────────────────────
console.log('\n-- 「另有 N 张」与切档后实际条数恒等 --')
const openCount = taskPick(POOL, { status: 'open' }).length
const doneCount = taskPick(POOL, { status: 'done' }).length
const allCount = taskPick(POOL, { status: 'all' }).length
check('open + done = all（两档加起来没有漏也没有重）', openCount + doneCount === allCount,
  `${openCount}+${doneCount} vs ${allCount}`)
check('★ 提示的 N 与"切到 done 档后实际能看到的张数"**恒等**',
  taskPickHiddenByStatus(POOL, { status: 'open' }) === doneCount,
  `提示 ${taskPickHiddenByStatus(POOL, { status: 'open' })} vs 实际 ${doneCount}`)
check('★★ 带查询词时也恒等（旧实现的病根：提示只比 id+标题，主匹配还比项目名）',
  taskPickHiddenByStatus(POOL, { status: 'open', query: 'fangcun-base', projectName: projName })
  === taskPick(POOL, { status: 'done', query: 'fangcun-base', projectName: projName }).length,
  `提示 ${taskPickHiddenByStatus(POOL, { status: 'open', query: 'fangcun-base', projectName: projName })}`
  + ` vs 实际 ${taskPick(POOL, { status: 'done', query: 'fangcun-base', projectName: projName }).length}`)
check('★ 旧口径自证：只比 id+标题 时「fangcun-base」搜不到项目名 → 提示会说 0 张（当初的现场）',
  POOL.filter(t => defaultIsDone(t) && `${t.id} ${t.title}`.toLowerCase().includes('方寸')).length === 0)
check('all 档没有"被藏起来的"（N 恒为 0）', taskPickHiddenByStatus(POOL, { status: 'all' }) === 0)
check('defaultIsDone：完成 / 驳回算终态，空状态算未完成',
  defaultIsDone(T('x', 'x', 'p', '完成')) === true
  && defaultIsDone(T('x', 'x', 'p', '驳回')) === true
  && defaultIsDone(T('x', 'x', 'p', '')) === false)

// ── ⑦ 范围 / 上限 ───────────────────────────────────────────────────
console.log('\n-- 范围与上限 --')
check('project 过滤：只留这个项目的',
  taskPick(POOL, { project: 'fangcun-base' }).every(r => String(r.task.project).includes('fangcun-base')))

// ⚠ 项目隔离必须是**精确相等**，不是子串比。首跑被 e2e-renderer-web 当场抓到：
//   `'demo2'.includes('demo')` 为真 → 选「本项目 demo」却把 demo2 的卡也列进来了。
//   项目是天然的隔离单元（暮雨原话），隔离靠相等，不靠"看起来像"。
const PROJ_POOL = [
  T('p1', 'demo 自己的卡', 'demo', '待办'),
  T('p2', 'demo2 的卡（不许串进 demo）', 'demo2', '待办'),
  T('p3', '前缀更长的卡', 'demo-extra', '待办'),
  T('p4', '多项目卡（含 demo）', ['demo', 'sitian'], '待办'),
]
const onlyDemo = taskPick(PROJ_POOL, { project: 'demo' }).map(r => r.task.id)
check('★★ 项目隔离是精确相等：选 demo 时 demo2 / demo-extra 都不许进来',
  JSON.stringify(onlyDemo.sort()) === JSON.stringify(['p1', 'p4']), JSON.stringify(onlyDemo))
check('★ 反例自证：旧的子串比写法确实会把 demo2 放进来（这就是首跑那条红）',
  PROJ_POOL.filter(t => JSON.stringify(t.project).includes('demo')).map(t => t.id).indexOf('p2') >= 0)
check('project 传数组 = 属于其中任一',
  taskPick(PROJ_POOL, { project: ['sitian'] }).map(r => r.task.id).join(',') === 'p4')
check('limit 真的截断（不是"全给了再切"）',
  taskPick(POOL, { limit: 3 }).length === 3)
check('limit:0 = 不限', taskPick(POOL, { limit: 0 }).length === POOL.length)
check('★ 有词时 limit 截断的是**相关度最高的前 N**（不是文件里前 N 个）',
  taskPick(POOL, { query: '真源', status: 'all', limit: 1 })[0].task.id === 'card-b')

// ── ⑧ 纯函数纪律 ────────────────────────────────────────────────────
console.log('\n-- 纯函数纪律 --')
const before = JSON.stringify(POOL)
taskPick(POOL, { query: '日志 筛选' })
taskPickHiddenByStatus(POOL, { status: 'open' })
check('不改传入的数组 / 对象（逐字节断言）', JSON.stringify(POOL) === before)
check('返回的是包了 task 的行对象，不是裸 task（界面要 rank 才能解释排序）',
  typeof taskPick(POOL, { query: '日志' })[0].task === 'object'
  && 'rank' in taskPick(POOL, { query: '日志' })[0])

// ── ⑨ 源码守卫：三处入口必须都走单一真源（不许再各写一套）──────────────
console.log('\n-- 源码守卫：三处入口都调 shared/taskPick --')
function readSrc(rel) {
  const p = path.join(REPO, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
}
const openSrc = readSrc('desktop/src/renderer/composables/useLogEditorOpen.ts')
const appSrc = readSrc('desktop/src/renderer/App.vue')
const calSrc = readSrc('desktop/src/renderer/views/CalendarView.vue')

check('日志关联任务：调 taskPick（不再自己写匹配）',
  /from ['"]\.\.\/\.\.\/shared\/taskPick['"]/.test(openSrc) && /\btaskPick\(/.test(openSrc))
check('App 阻塞选择器：调 taskPick', /import \{ taskPick \}/.test(appSrc) && /taskPick\(list/.test(appSrc))
check('日历未排期：调 taskPick',
  /from ['"]\.\.\/\.\.\/shared\/taskPick['"]/.test(calSrc) && /\btaskPick\(/.test(calSrc))

// 反例：旧实现的那条病根特征（整串 includes + 只比 id/标题）
// ⚠ 必须先剥注释再扫 —— 注释里写着"这里以前是裸 hay.includes(q)"是**解释**，不是重犯。
//   本仓的守卫已经吃过这个亏（源码守卫把注释里的反例说明当成实现扫进去了）。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
const openCode = stripComments(openSrc)
check('★ 日志编辑器里不再有裸 `hay.includes(q)` 那种整串子串比（已剥注释）',
  !/hay\.includes\(q\)/.test(openCode),
  '还在: ' + (openCode.match(/hay\.includes\(q\)/g) || []).length)
check('⛔ 守卫自证：剥注释前那条注释确实会被扫到（说明这条守卫真的在扫内容）',
  /hay\.includes\(q\)/.test(openSrc) && !/hay\.includes\(q\)/.test(openCode))
check('★ 「另有 N 张」不再自己再写一遍匹配（调用 taskPickHiddenByStatus）',
  /taskPickHiddenByStatus\(/.test(openSrc) && !/const hay = `\$\{t\.id\} \$\{t\.title \|\| ''\}`/.test(openSrc))
check('★ App 里旧的阻塞搜索 `q.split(/\\s+/).every` 已消失（收口了）',
  !/q\.split\(\/\\s\+\/\)\.every/.test(appSrc))
check('★ 日历里旧的 `q.split(/\\s+/).every` 已消失（收口了）',
  !/q\.split\(\/\\s\+\/\)\.every/.test(calSrc))

// ── ⑩ 界面侧（渲染层）必须真按搜索态平铺，而不是还按项目分组 ────────────
console.log('\n-- 界面侧：搜索态平铺 / 空态话术 --')
const modalSrc = readSrc('desktop/src/renderer/components/LogEditModal.vue')
check('LogEditModal 有平铺容器 .log-task-flat（不复用 .log-task-groups）',
  /class="log-task-flat"/.test(modalSrc))
check('★ 平铺块与分组块是 **v-if / v-else-if 互斥**（搜索时不分组）',
  /v-if="logTaskSearching"/.test(modalSrc) && /v-else-if="logTaskGroups\.length"/.test(modalSrc))
check('行内有命中字段标签（解释"为什么它在第一行"）', /lto-hit/.test(modalSrc) && /hitFieldName/.test(modalSrc))
check('⛔ 反例守卫：平铺行**不许**复用组头 class（.lt-group-head 只该出现在分组块里）',
  (modalSrc.match(/lt-group-head/g) || []).length === 1,
  '出现次数: ' + (modalSrc.match(/lt-group-head/g) || []).length)
check('空态话术说清"多词会按都要命中找"',
  /多个词用空格/.test(modalSrc))

const cssSrc = readSrc('desktop/src/renderer/styles/app.css')
check('CSS 里 .log-task-flat 有独立样式（不用 .log-task-groups 的）',
  /\.log-task-flat\s*\{/.test(cssSrc) && /\.lto-hit\s*\{/.test(cssSrc))

// ── 汇总 ────────────────────────────────────────────────────────────
console.log('\n' + (fail ? '❌ ' : '✅ ') + `RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(fail ? 1 : 0)
