#!/usr/bin/env node
/**
 * 顶部工具栏工作区 · 纯逻辑回归（2026-11-18）
 *
 * 暮雨：「提供 2-3 种预设工作区……另外留一个自定义模式，让用户自己排序或折叠
 *        （有最少按钮和最多按钮限制，防止按钮全被折叠找不到或按钮太多挤爆页面）。」
 *
 * 为什么单独测这份逻辑：拖拽画布最容易出的是**边界没夹住** ——
 * 拖到 6 个、拖到 13 个、把不存在的 id 塞进来。这些错在界面上只表现为
 * "拖了一下没反应"或"页签凭空少一个"，肉眼抓不住，也不会有任何报错。
 *
 * 钉住四件事：
 *   ① 上下限真的夹得住（MIN_VISIBLE=7 / MAX_VISIBLE=12），且**越界时给的是人话**
 *   ② 未知 id 一律丢弃，但**不许因为一个坏值就整体回落**（用户拖的成果不能被脏数据抹）
 *   ③ 预设数量自己就合法（这条能抓住"以后改预设改出 6 个"的手滑）
 *   ④ 顺序：用户排过的在前，没提到的按源码顺序跟在后面，不重不漏
 *
 * 跑法：node scripts/test/e2e-view-layout.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { mkTmpPath } = require('./_tmp.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const SRC = path.join(DESKTOP, 'src', 'shared', 'viewLayout.ts')
const OUT = mkTmpPath('fc-vlayout-')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function compile() {
  fs.mkdirSync(OUT, { recursive: true })
  execFileSync(process.execPath, [
    path.join(DESKTOP, 'node_modules', 'typescript', 'bin', 'tsc'),
    SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'ES2020',
    '--strict', 'false', '--skipLibCheck',
  ], { cwd: DESKTOP, stdio: 'pipe' })
  const js = path.join(OUT, 'viewLayout.js')
  if (!fs.existsSync(js)) throw new Error('编译产物不存在：' + js)
  return require(js)
}

const V = compile()

/** 与 App.vue 的 `views` 表同序的 17 个页签（这里独立写一份，防"实现改了测试跟着改"的自证循环） */
const ALL = ['active', 'ask', 'todos', 'ideas', 'memory', 'logs', 'projects', 'blockers',
  'roadmap', 'calendar', 'archive', 'trash', 'launchpad', 'decisions', 'skills',
  // 2026-11-20：插件单开一页（技能页瘦身的另一半）
  'plugins', 'services']

console.log('=== 一、常量口径 ===')
check('★ 下限是 7（2026-10-25 暮雨定的那条，不许悄悄改）', V.MIN_VISIBLE === 7, String(V.MIN_VISIBLE))
check('★ 上限是 15（2026-11-18；15 = 页签 17 个里至少留 2 个在「更多」里）',
  V.MAX_VISIBLE === 15, String(V.MAX_VISIBLE))
check('★ 上限 > 下限（写反了就是"怎么配都不合法"）', V.MAX_VISIBLE > V.MIN_VISIBLE)
check('★★ 上限不许低于默认布局的可见数 —— 否则默认值自己就越界（第一稿就是这样被抓出来的）',
  ALL.length - V.defaultLayout().hidden.length <= V.MAX_VISIBLE,
  '默认可见 ' + (ALL.length - V.defaultLayout().hidden.length) + ' vs 上限 ' + V.MAX_VISIBLE)
check('★★ 默认布局**不能顶到上限** —— 顶到上限就意味着"进自定义想加一个会被立刻拒绝"，那正是"太蠢"',
  ALL.length - V.defaultLayout().hidden.length < V.MAX_VISIBLE,
  '默认可见 ' + (ALL.length - V.defaultLayout().hidden.length) + ' vs 上限 ' + V.MAX_VISIBLE)

console.log('\n=== 二、三套预设自己就得合法 ===')
check('★ 恰好三套预设（暮雨说的"2-3 种"）', V.PRESETS.length >= 2 && V.PRESETS.length <= 3,
  'n=' + V.PRESETS.length)
for (const p of V.PRESETS) {
  const ids = p.visible.filter((x) => ALL.includes(x))
  check(`★ 预设「${p.label}」里全是真页签（没有凭空编的 id）`,
    ids.length === p.visible.length, '不认识的：' + p.visible.filter((x) => !ALL.includes(x)).join(','))
  check(`★ 预设「${p.label}」数量在 [${V.MIN_VISIBLE}, ${V.MAX_VISIBLE}] 内`,
    ids.length >= V.MIN_VISIBLE && ids.length <= V.MAX_VISIBLE, 'n=' + ids.length)
  check(`★ 预设「${p.label}」没有重复 id`, new Set(ids).size === ids.length)
  check(`  预设「${p.label}」有说明（用户要知道这套是给谁用的）`, !!p.desc && p.desc.length > 6)
}

console.log('\n=== 三、normalizeLayout：坏数据不许毁掉用户成果 ===')
{
  const d = V.normalizeLayout(null, ALL)
  check('★★ 默认布局自己就合法（可见数在 [MIN, MAX] 内）—— 默认值越界等于每次启动都在替用户做决定',
    ALL.length - d.hidden.length >= V.MIN_VISIBLE && ALL.length - d.hidden.length <= V.MAX_VISIBLE,
    '可见 ' + (ALL.length - d.hidden.length) + '，hidden=' + JSON.stringify(d.hidden))
  check('★★ 默认收起的一定包含暮雨 10-25 点名的那三个低频（启动台/技能/服务）+ 2026-11-20 新加的插件页',
    ['launchpad', 'skills', 'plugins', 'services'].every((x) => d.hidden.includes(x)),
    JSON.stringify(d.hidden))
  check('★★ 默认布局里「回收站」仍在外面 —— 2026-11-18 只在页签涨到 16 时多收了「归档」，不动别的高频页',
    !d.hidden.includes('trash') && !d.hidden.includes('decisions') && !d.hidden.includes('roadmap'),
    JSON.stringify(d.hidden))
  check('★ defaultLayout() 与"第一套预设"收起的是同一批（不许两处各定义一份默认）',
    (() => {
      const a = V.defaultLayout()
      const b = V.applyPreset(V.PRESETS[0].id, ALL)
      return b.ok && JSON.stringify([...a.hidden].sort()) === JSON.stringify([...b.layout.hidden].sort())
    })(), JSON.stringify(d.hidden))
  check('★★ 默认布局的 order 为空 —— 与"从没存过布局"算出来的是同一个对象',
    (() => {
      const a = JSON.stringify(V.defaultLayout())
      const b = JSON.stringify(V.normalizeLayout(null, ALL))
      return a === b
    })(), JSON.stringify(V.defaultLayout()) + ' vs ' + JSON.stringify(V.normalizeLayout(null, ALL)))
  check('★★ 兜底全集 ALL_DEFAULT_IDS 与真实页签表逐项一致（加页签漏改这里会当场红）',
    JSON.stringify([...V.ALL_DEFAULT_IDS].sort()) === JSON.stringify([...ALL].sort()),
    '只在一处有：' + JSON.stringify(V.ALL_DEFAULT_IDS.filter((x) => !ALL.includes(x)).concat(ALL.filter((x) => !V.ALL_DEFAULT_IDS.includes(x)))))

  const garbage = V.normalizeLayout({ order: [1, null, {}, 'nope', 'logs', 'logs'], hidden: 'x', preset: 42 }, ALL)
  check('★★ 垃圾值不抛异常，且 order 里只剩真页签且去重',
    JSON.stringify(garbage.order) === JSON.stringify(['logs']), JSON.stringify(garbage.order))
  check('★★ hidden 不是数组时不被当成"全收起"，而是回落到合法值',
    garbage.hidden.length >= Math.max(0, ALL.length - V.MAX_VISIBLE),
    'hidden=' + garbage.hidden.length)

  const oneBad = V.normalizeLayout({ order: ['nope', 'todos', 'active'], hidden: ['launchpad', 'skills', 'services'] }, ALL)
  check('★★ 一个坏 id 不许把整个布局打成默认（另两个真 id 必须保住）',
    JSON.stringify(oneBad.order) === JSON.stringify(['todos', 'active']), JSON.stringify(oneBad.order))

  const tooMany = V.normalizeLayout({ hidden: ALL.slice(0, 14) }, ALL)
  check(`★★ 藏了 14 个 → 必须夹到最多藏 ${ALL.length - V.MIN_VISIBLE} 个（下限 7）`,
    ALL.length - tooMany.hidden.length >= V.MIN_VISIBLE,
    '可见只剩 ' + (ALL.length - tooMany.hidden.length))

  const tooFew = V.normalizeLayout({ hidden: [] }, ALL)
  check(`★ 一个都不藏 → 必须补到最多 ${V.MAX_VISIBLE} 个可见（上限 12）`,
    ALL.length - tooFew.hidden.length <= V.MAX_VISIBLE,
    '可见 ' + (ALL.length - tooFew.hidden.length))

  const legacy = V.normalizeLayout(null, ALL, ['archive', 'trash'])
  check('★ 老键 fc_views_collapsed 仍能读（升级上来的用户不该被抹成默认）',
    legacy.hidden.includes('archive') && legacy.hidden.includes('trash'), JSON.stringify(legacy.hidden))
}

console.log('\n=== 四、toggleVisible：越界给人话，不是默默不改 ===')
{
  const base = V.normalizeLayout(null, ALL)
  // 收到下限
  let cur = base
  let errMsg = ''
  let guard = 0
  while (ALL.length - cur.hidden.length > V.MIN_VISIBLE && guard++ < 50) {
    const id = ALL.find((x) => !cur.hidden.includes(x))
    const r = V.toggleVisible(cur, id, ALL)
    if (r.ok) cur = r.layout
    else break
  }
  check(`★★ 一路收到下限 ${V.MIN_VISIBLE} 个后，再收一个必须被拒绝`,
    ALL.length - cur.hidden.length === V.MIN_VISIBLE, '现在 ' + (ALL.length - cur.hidden.length))
  const over = V.toggleVisible(cur, ALL.find((x) => !cur.hidden.includes(x)), ALL)
  check('★★ 拒绝时 ok=false 且给出人话（含下限数字），不是静默',
    over.ok === false && over.error.indexOf(String(V.MIN_VISIBLE)) >= 0, over.error)
  check('  被拒绝时布局一个字没动', JSON.stringify(over.layout) === JSON.stringify(cur))

  // 放到上限
  const few = V.normalizeLayout({ hidden: ALL.slice(0, ALL.length - 3) }, ALL)
  let up = few
  guard = 0
  while (ALL.length - up.hidden.length < V.MAX_VISIBLE && guard++ < 50) {
    const id = ALL.find((x) => up.hidden.includes(x))
    if (!id) break
    const r = V.toggleVisible(up, id, ALL)
    if (r.ok) up = r.layout
    else break
  }
  check(`★★ 一路放到上限 ${V.MAX_VISIBLE} 个后，再放一个必须被拒绝`,
    ALL.length - up.hidden.length === V.MAX_VISIBLE, '现在 ' + (ALL.length - up.hidden.length))
  const overMax = V.toggleVisible(up, ALL.find((x) => up.hidden.includes(x)), ALL)
  check('★★ 超上限时也给人话（含上限数字）',
    overMax.ok === false && overMax.error.indexOf(String(V.MAX_VISIBLE)) >= 0, overMax.error)

  const unknown = V.toggleVisible(base, 'nope', ALL)
  check('★ 操作一个不存在的页签 → 明确拒绝', unknown.ok === false && !!unknown.error, unknown.error)
  // ⚠ 用「收起决策页」做"动一下"的样本：默认已经 12 个可见（顶到上限），
  //   所以只能收、不能再放 —— 拿一个**当前可见**的 id 去 toggle 才走得通。
  const touched = V.toggleVisible(base, 'decisions', ALL)
  check('★ 动过一次之后 preset 变 custom（否则界面会假装还在"日常"）',
    touched.ok && touched.layout.preset === 'custom', touched.ok ? touched.layout.preset : touched.error)
}

console.log('\n=== 五、顺序：不重不漏，用户排的在前 ===')
{
  const seq = V.resolveOrder({ order: ['logs', 'active'], hidden: [], preset: 'custom' }, ALL)
  check('★★ 用户排过的在前、没提到的按源码顺序跟在后面',
    seq[0] === 'logs' && seq[1] === 'active' && seq[2] === 'ask', seq.slice(0, 4).join(','))
  check('★★ 结果不重不漏（长度等于全部页签数）', seq.length === ALL.length, seq.length + ' vs ' + ALL.length)
  check('  结果是全集的排列', new Set(seq).size === seq.length)

  const split = V.splitVisible({ order: ['logs'], hidden: ['skills'], preset: 'custom' }, ALL)
  check('★ splitVisible：两组加起来还是全集，且不重叠',
    split.visible.length + split.hidden.length === ALL.length
    && !split.visible.some((x) => split.hidden.includes(x)),
    `v=${split.visible.length} h=${split.hidden.length}`)
  check('  visible 的第一位是用户排的那个', split.visible[0] === 'logs', split.visible[0])

  const moved = V.moveView({ order: [], hidden: [], preset: 'custom' }, 'services', 0, ALL)
  check('★★ moveView 把块拖到第一位真的生效', moved.order[0] === 'services', moved.order[0])
  check('★★ moveView 之后仍然不重不漏', new Set(moved.order).size === ALL.length)
  const outOfRange = V.moveView({ order: [], hidden: [], preset: 'custom' }, 'ask', 999, ALL)
  check('★ 目标下标越界 → 夹到末尾而不是插进 undefined 里',
    outOfRange.order[outOfRange.order.length - 1] === 'ask', outOfRange.order.slice(-3).join(','))
  const unknownMove = V.moveView({ order: [], hidden: [], preset: 'custom' }, 'nope', 0, ALL)
  check('★ 拖一个不存在的块 → 布局原样返回，不抛', JSON.stringify(unknownMove.hidden) === '[]')
}

console.log('\n=== 六、applyPreset ===')
{
  for (const p of V.PRESETS) {
    const r = V.applyPreset(p.id, ALL)
    check(`★★ 套用「${p.label}」成功且可见数合法`,
      r.ok && (ALL.length - r.layout.hidden.length) >= V.MIN_VISIBLE,
      r.error || ('可见 ' + (ALL.length - r.layout.hidden.length)))
    check(`  套用「${p.label}」后 preset 记对了`, r.layout.preset === p.id, r.layout.preset)
  }
  const bad = V.applyPreset('nope', ALL)
  check('★ 套一件不存在的预设 → 明确拒绝且给人话', bad.ok === false && !!bad.error, bad.error)

  const tooSmall = V.applyPreset('tiny', ALL, [{ id: 'tiny', label: '假', desc: '只有五个', visible: ALL.slice(0, 5) }])
  check(`★★ 预设自己少于下限 ${V.MIN_VISIBLE} 个 → 拒绝（这条抓的是"以后改预设改出 6 个"的手滑）`,
    tooSmall.ok === false && tooSmall.error.indexOf(String(V.MIN_VISIBLE)) >= 0, tooSmall.error)
}

console.log('\n=== 七、describeLayout（两处共用一份文案）===')
{
  check('★ 自定义 → "自定义"', V.describeLayout({ order: [], hidden: [], preset: 'custom' }) === '自定义')
  const daily = V.describeLayout(V.defaultLayout())
  check('★ 默认 → 第一套预设的名字', daily === V.PRESETS[0].label, daily)
  const unknown = V.describeLayout({ order: [], hidden: [], preset: 'nope' })
  check('★ 认不出的 preset 不许印出 id 本身，回落"自定义"', unknown === '自定义', unknown)
  check('★ isDefaultLayout：默认布局认得出来',
    V.isDefaultLayout(V.defaultLayout()) === true)
  check('★ isDefaultLayout：动过一个页签就不算默认',
    V.isDefaultLayout({ order: [], hidden: ['archive'], preset: 'daily' }) === false)
  check('★ isDefaultLayout：只换了顺序也不算默认',
    V.isDefaultLayout({ order: ['logs'], hidden: V.DEFAULT_HIDDEN, preset: 'daily' }) === false)
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
