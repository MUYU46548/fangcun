/**
 * 看板分组纯逻辑测试（2026-09-25 用户反馈「像没有尽头的单子」）
 *
 * 为什么单独测：分组标题显示内部 id（fangcun-base）、跨项目计数错、未归属任务丢分组 ——
 * 这些在界面上都只表现为「看起来乱」，肉眼看不出对错。grouping.ts 不依赖 Vue/DOM，
 * 所以能用 tsc 编出来直接在 Node 里断言（同 calendar.ts 的路子）。
 *
 * 运行：node scripts/test/e2e-grouping.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const SRC = path.join(DESKTOP, 'src', 'shared', 'grouping.ts')
const OUT = path.join(os.tmpdir(), 'fc-grp-' + Date.now())

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
  const js = path.join(OUT, 'grouping.js')
  if (!fs.existsSync(js)) throw new Error('编译产物不存在: ' + js)
  return require(js)
}

function main() {
  const g = compile()

  // ── A. firstProject：项目字段可能是数组（多归属）────────────────────
  check('A1 数组取第一个', g.firstProject(['fangcun-base', 'other']) === 'fangcun-base')
  check('A2 字符串原样', g.firstProject('sitian') === 'sitian')
  check('A3 null/undefined → 空串', g.firstProject(null) === '' && g.firstProject(undefined) === '')
  check('A4 空数组 → 空串', g.firstProject([]) === '')

  // ── B. 分组与计数 ───────────────────────────────────────────────────
  const tasks = [
    { id: 'a1', project: 'fangcun-base' },
    { id: 'a2', project: ['fangcun-base'] },
    { id: 'a3', project: 'fangcun-base' },
    { id: 'b1', project: 'sitian' },
    { id: 'n1' },
    { id: 'n2', project: '' },
  ]
  const names = { 'fangcun-base': '方寸', sitian: '司天' }
  const nameOf = (id) => names[id]
  const groups = g.buildProjectGroups(tasks, nameOf)

  const byKey = Object.fromEntries(groups.map(x => [x.key, x]))
  check('B1 分组数正确（2 个项目 + 未归属）', groups.length === 3, JSON.stringify(groups.map(x => x.key)))
  check('B2 计数正确', byKey['fangcun-base'].tasks.length === 3 && byKey['sitian'].tasks.length === 1,
    JSON.stringify(groups.map(x => [x.key, x.tasks.length])))
  check('B3 标签解析成项目名（不是内部 id）', byKey['fangcun-base'].label === '方寸', byKey['fangcun-base'].label)
  check('B4 未归属任务进同一个桶', byKey['__none__'] && byKey['__none__'].tasks.length === 2,
    JSON.stringify(byKey['__none__'] && byKey['__none__'].tasks.length))
  check('B5 未归属桶有可读标签', byKey['__none__'].label === '未归属', byKey['__none__'].label)
  check('B6 任务多的组在前', groups[0].key === 'fangcun-base', JSON.stringify(groups.map(x => x.key)))
  check('B7 不丢任务（总数守恒）', groups.reduce((s, x) => s + x.tasks.length, 0) === tasks.length)

  // ── C. 名字解析的健壮性 ─────────────────────────────────────────────
  const noName = g.buildProjectGroups([{ id: 'x', project: 'unknown-proj' }], () => '')
  check('C1 查不到名字 → 回退显示 id（不留空标题）', noName[0].label === 'unknown-proj', noName[0].label)
  const throwingName = g.buildProjectGroups([{ id: 'x', project: 'p1' }], () => { throw new Error('boom') })
  check('C2 nameOf 抛异常 → 回退 id，不把整块板子拖崩', throwingName[0].label === 'p1', throwingName[0].label)
  check('C3 空列表 → 空分组数组', g.buildProjectGroups([], nameOf).length === 0)
  const custom = g.buildProjectGroups([{ id: 'x' }], nameOf, '无项目')
  check('C4 未归属标签可定制', custom[0].label === '无项目', custom[0].label)

  // ── D. 折叠状态 ─────────────────────────────────────────────────────
  let keys = []
  keys = g.toggleCollapsed(keys, 'fangcun-base')
  check('D1 折叠后含该键', g.isCollapsed(keys, 'fangcun-base') === true)
  keys = g.toggleCollapsed(keys, 'sitian')
  check('D2 可同时折叠多个', g.isCollapsed(keys, 'sitian') === true && keys.length === 2)
  keys = g.toggleCollapsed(keys, 'fangcun-base')
  check('D3 再点一次 = 展开', g.isCollapsed(keys, 'fangcun-base') === false && keys.length === 1)
  check('D4 返回新数组（不原地改，Vue 才能感知）', (() => {
    const before = ['a']
    const after = g.toggleCollapsed(before, 'b')
    return before.length === 1 && after.length === 2
  })())
  const pruned = g.pruneCollapsed(['sitian', '已删除的项目'], ['sitian'])
  check('D5 陈旧分组键被清理（不留幽灵折叠）', pruned.length === 1 && pruned[0] === 'sitian', JSON.stringify(pruned))

  // ── E. 接线（源码断言，防漂移）─────────────────────────────────────
  const vue = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'App.vue'), 'utf8')
  check('E1 App.vue 引用了 shared/grouping', /from '\.\.\/shared\/grouping'/.test(vue))
  check('E2 按项目分支走 buildProjectGroups', /return buildProjectGroups\(filtered as any, projectNameOf\)/.test(vue))
  check('E3 有项目名解析函数', /function projectNameOf\(id: string\)/.test(vue))
  check('E4 分组标题可点击折叠', /@click="toggleGroup\(col\.key\)"/.test(vue))
  check('E5 折叠时卡片隐藏', /v-show="!groupCollapsed\(col\.key\)"/.test(vue))
  check('E6 折叠列有独立样式类', /'collapsed-col': groupCollapsed\(col\.key\)/.test(vue) && /\.col\.collapsed-col \{/.test(vue))
  check('E7 有一键折叠/展开', /setAllCollapsed\(true\)/.test(vue) && /setAllCollapsed\(false\)/.test(vue))
  check('E8 折叠状态与分组方式持久化到 prefs', /saveUiPref\('fc_collapsed_groups'/.test(vue) && /saveUiPref\('fc_board_group_mode'/.test(vue))
  check('E9 启动时与真身对齐', /syncBoardPrefs\(\)/.test(vue))

  console.log('─'.repeat(50))
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); process.exitCode = 1 }
  console.log(`RESULT ${pass} / ${fail}`)
}

try { main() } catch (e) { console.error('测试框架异常：', e); process.exitCode = 1; console.log('RESULT 0 / 1') }
