#!/usr/bin/env node
/**
 * 在途一屏（Q2 · 立项契约 ② 验收线之①）数据层测试
 *
 * 真跑编译产物 `dist/main/services/tripBoard.js` + **临时数据目录**（不碰真实 task-data / prefs）。
 *
 * 覆盖的要害（每条都能挂上"改了会怎样"）：
 *   · 契约文件六字段解析（标题带 ①② 序号也认）；缺契约 → exists=false 且字段为空
 *   · 四种判据各自命中谁（cards / cards_or_commit / cards_or_log / manual）
 *   · **current 回落到执行日志**（0 卡项目如司天的唯一数据源）
 *   · **缺值给空串而不是默认值**（界面负责显示「未填」，数据层不许编）
 *   · 健康度：机器默认 + **用户覆盖（locked）**
 *   · repoOfProject 只认 registry 登记路径（非法 id 不产出路径 → 防任意路径打开）
 *   · contractTemplate 含六字段
 *
 * ⚠ 不用 spawnSync 起子进程（本机一律 EBUSY）：electron 桩在**本进程**注入，
 *   再直接 require 编译产物。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-board-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
const repoA = path.join(TMP, 'repoA')
const repoB = path.join(TMP, 'repoB')
const repoC = path.join(TMP, 'repoC')
const repoD = path.join(TMP, 'repoD')

process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, USERDATA, repoA, repoB, repoC, repoD]) fs.mkdirSync(d, { recursive: true })

// electron 桩：本进程注入（避免 spawnSync）
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

// ── 夹具 ────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.mkdirSync(path.join(DATA, 'docs', '执行日志'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'), [
  'members: []',
  'projects:',
  '  - id: has-card',
  '    name: 有卡项目',
  `    repo: ${repoA.replace(/\\/g, '/')}`,
  '  - id: no-card',
  '    name: 无卡项目',
  `    repo: ${repoB.replace(/\\/g, '/')}`,
  '  - id: quiet',
  '    name: 安静项目',
  `    repo: ${repoC.replace(/\\/g, '/')}`,
  '  - id: empty-one',
  '    name: 空项目',
  `    repo: ${repoD.replace(/\\/g, '/')}`,
  'released: []',
  '',
].join('\n'), 'utf-8')

// repoA 带契约（标题用 ①② 序号，验证宽松匹配）
fs.writeFileSync(path.join(repoA, '立项契约.md'), [
  '# 立项契约 · 样例',
  '',
  '## ① 终态形态',
  '桌面客户端为主产品。',
  '',
  '## ② 验收线',
  '一屏可见。',
  '',
  '## ③ 不要什么',
  '不做重型表单。',
  '',
  '## ④ 选型定死',
  '真源在各 repo。',
  '',
  '## ⑤ 现状底数',
  '零。',
  '',
  '## ⑥ 下一队列',
  'Q2。',
  '',
].join('\n'), 'utf-8')

// repoB 无契约（exists=false 路径）

const mkTask = (id, title, project, status, priority, assignee) => [
  '---',
  `id: ${id}`,
  `标题: ${title}`,
  `项目: [${project}]`,
  `状态: ${status}`,
  `优先级: ${priority}`,
  `指派: ${assignee}`,
  '验收: 暮雨',
  '---',
  '## 方案',
  '- [ ] 做点事',
  '',
].join('\n')

fs.writeFileSync(path.join(DATA, 'task-data', 't-doing.md'),
  mkTask('t-doing', '正在做的事', 'has-card', '进行中', '高', 'hermes'), 'utf-8')
fs.writeFileSync(path.join(DATA, 'task-data', 't-todo.md'),
  mkTask('t-todo', '要做的下一件', 'has-card', '待办', '中', 'hermes'), 'utf-8')

fs.writeFileSync(path.join(DATA, 'docs', '执行日志', 'log_fixture_1.md'), [
  '---',
  'type: execution-log',
  'id: log_fixture_1',
  'project: no-card',
  'title: 进度日志1001',
  'status: active',
  "created: '2026-10-04T02:00:00.000Z'",
  'tags: []',
  'tasks: []',
  '---',
  '断点已记。',
  '',
].join('\n'), 'utf-8')

const setPrefs = (obj) => {
  fs.writeFileSync(path.join(USERDATA, 'prefs.json'), JSON.stringify(obj, null, 2), 'utf-8')
}
setPrefs({})

// ── 载入被测模块 ────────────────────────────────────────────────────────
const data = require(path.join(DIST, 'data', 'index.js'))
const tb = require(path.join(DIST, 'services', 'tripBoard.js'))

data.setDataDir(DATA)

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

// ⚠ 从这一行起包在 async IIFE 里：6b 那段要 await warmBoardGit()，而 CJS 没有顶层 await。
;(async () => {
console.log('---- 1. 契约文件解析 ----')
const c1 = tb.readContractFile(repoA)
check('契约：六字段全部解析出（标题带 ①② 序号也认）',
  c1.exists && c1.endState === '桌面客户端为主产品。' && c1.acceptLine === '一屏可见。'
  && c1.notWant === '不做重型表单。' && c1.choice === '真源在各 repo。',
  JSON.stringify(c1).slice(0, 120))
const c2 = tb.readContractFile(repoB)
check('契约：文件不存在 → exists=false，四字段全空串（不编）',
  c2.exists === false && !c2.endState && !c2.acceptLine && !c2.notWant && !c2.choice)
check('契约：路径拼接用仓库根 + 立项契约.md', c1.path.endsWith('立项契约.md'))

// ── 1b. 契约读取的三个真机修正（2026-10-11 用户：「绒花墨坊怎么还在说内容未填？已经有内容了啊？」）──
// 真因：只认标准六节名 → 用自定义小节名写的契约（① 终态三段 / ⑥ 验收锚点 …）六个字段全空，
// 界面写「文件已建 · 内容未填」。**把"小节名对不上"说成"未填"就是界面说假话**，比空白更糟。
const repoE = path.join(TMP, 'repo-alias')
const repoF = path.join(TMP, 'repo-placeholder')
fs.mkdirSync(repoE, { recursive: true })
fs.mkdirSync(repoF, { recursive: true })
fs.writeFileSync(path.join(repoE, '立项契约.md'), [
  '# 立项契约 · 绒花墨坊式（自定义小节名）',
  '',
  '## ① 终态三段（产线）',
  '前段产坯 → 人工精修 → 后段审校',
  '',
  '## ② 原料边界',
  '- 负向：游戏文案类永不进来',
  '',
  '## ⑥ 验收锚点',
  '- D0：扫一眼确认',
  '',
  '## ③ 产线本质',
  'AI 管结构，文字归人',
  '',
].join('\n'), 'utf-8')
const ca = tb.readContractFile(repoE)
check('★★ 契约（别名匹配）：自定义小节名也要读出来 —— 「① 终态三段」算终态、「⑥ 验收锚点」算验收线、'
  + '「② 原料边界」算不要什么（老实现这三节全判成未填）',
  String(ca.endState).startsWith('前段产坯') && String(ca.acceptLine).startsWith('- D0')
  && String(ca.notWant).startsWith('- 负向'), JSON.stringify(ca).slice(0, 140))
check('★ 契约（原因分类）：「对不上的小节名」进 unmatched、命中的进 filled、sections 逐条给「小节名 → 字段」',
  ca.unmatched.includes('③ 产线本质')
  && ca.filled.slice().sort().join(',') === ['不要什么', '终态形态', '验收线'].sort().join(',')
  && ca.sections.some(s => s.name === '① 终态三段（产线）' && s.field === '终态形态')
  && ca.sections.some(s => s.name === '③ 产线本质' && s.field === null),
  JSON.stringify({ unmatched: ca.unmatched, filled: ca.filled }))

fs.writeFileSync(path.join(repoF, '立项契约.md'), [
  '## ① 终态形态',
  '（一句话：我一开始想要的就是 ___。用户原话直录，不改写。）',
  '',
  '---',
  '',
  '## ② 验收线',
  '（「完整投入真实使用」的判据链。）',
  '',
].join('\n'), 'utf-8')
const cp = tb.readContractFile(repoF)
check('★★ 契约（占位识别）：整段被括号包住的是**模板骨架不是内容** → 两节都算「占位没填」'
  + '（老实现把骨架当正文，司天那种空表反而显示成「填了」—— 另一种假话）',
  cp.filled.length === 0 && cp.placeholderFields.slice().sort().join(',') === ['终态形态', '验收线'].sort().join(','),
  JSON.stringify({ filled: cp.filled, ph: cp.placeholderFields }))
check('★ 契约（分隔线剥离）：小节之间用 `---` 分隔时正文不带 `---`（占位判定也就不被它破坏）',
  cp.endState === '' && cp.acceptLine === '', JSON.stringify(cp.endState) + '/' + JSON.stringify(cp.acceptLine))

// 跨语言同口径：TS 别名表必须与 Python 逐字一致（否则会出现"CLI 读得到、桌面说未填"）
const PY_SRC = fs.readFileSync(path.join(REPO, 'tegula', 'core.py'), 'utf-8')
const TS_SRC = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'tripBoard.ts'), 'utf-8')
const pyAlias = (PY_SRC.match(/CONTRACT_ALIASES\s*=\s*\{([\s\S]*?)\n\}/) || [])[1] || ''
const tsAlias = (TS_SRC.match(/const CONTRACT_ALIASES[^=]*=\s*\{([\s\S]*?)\n\}/) || [])[1] || ''
const grab = (block) => (block.match(/["']?([\u4e00-\u9fa5]+)["']?\s*[:=]\s*\[([^\]]*)\]/g) || [])
  .map(s => {
    const k = /([\u4e00-\u9fa5]+)/.exec(s)[1]
    const vs = /\[([^\]]*)\]/.exec(s)[1].split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    return k + ':' + vs.join('|')
  }).sort().join(' ; ')
check('★★ 契约：TS 侧别名表必须与 Python 侧**逐字一致**（两侧各写一份迟早分叉）',
  !!pyAlias && !!tsAlias && grab(pyAlias) === grab(tsAlias),
  'py=' + grab(pyAlias) + ' | ts=' + grab(tsAlias))

console.log('\n---- 2. 判据（默认 = 有未完结卡 或 30 天内有提交）----')
let board = tb.buildTripBoard()
check('默认判据：有卡项目入屏', board.rows.some(r => r.id === 'has-card'))
check('默认判据：无卡无提交项目不入屏（no-card 只有日志）', !board.rows.some(r => r.id === 'no-card'),
  board.rows.map(r => r.id).join(','))
check('默认判据：空项目不入屏', !board.rows.some(r => r.id === 'empty-one'))
check('默认判据值回传正确', board.criteria === 'cards_or_commit' && board.mode === 'auto', board.criteria)

console.log('\n---- 3. current 回落到执行日志（0 卡项目的数据源）----')
setPrefs({ fc_trip_criteria: 'cards_or_log' })
board = tb.buildTripBoard()
const nc = board.rows.find(r => r.id === 'no-card')
check('cards_or_log：无卡但有日志的项目入屏', !!nc, board.rows.map(r => r.id).join(','))
check('★ 无卡项目 current 来自日志且标了 from=log',
  nc && nc.current.from === 'log' && nc.current.text === '进度日志1001', nc && JSON.stringify(nc.current))
check('★ 无卡项目「下一步」给空串（不编「—」这种界面话术）',
  nc && nc.next.text === '' && nc.next.from === '')

console.log('\n---- 4. 缺值不填默认 ----')
setPrefs({})
board = tb.buildTripBoard()
const hc = board.rows.find(r => r.id === 'has-card')
check('有卡项目 current 来自任务卡（from=task）', hc && hc.current.from === 'task' && hc.current.text === '正在做的事')
check('下一步 = 待办里优先级最高那张', hc && hc.next.text === '要做的下一件' && hc.next.sub.includes('1 张待办'))
check('计数正确（1 进行 / 1 待办 / 0 待验 / 0 日志）',
  hc && hc.counts.doing === 1 && hc.counts.todo === 1 && hc.counts.review === 0 && hc.counts.logs === 0,
  hc && JSON.stringify(hc.counts))
check('有契约 → contract.exists=true 且终态首行可读',
  hc && hc.contract.exists === true && String(hc.contract.endState).startsWith('桌面'))

console.log('\n---- 5. 健康度：机器默认 + 用户覆盖 ----')
check('健康度默认：有进行中的卡 → active', hc && hc.health.value === 'active' && hc.health.locked === false,
  hc && JSON.stringify(hc.health))
setPrefs({ fc_health_overrides: { 'has-card': 'paused' } })
board = tb.buildTripBoard()
const hc2 = board.rows.find(r => r.id === 'has-card')
check('★ 健康度用户覆盖生效且标 locked', hc2 && hc2.health.value === 'paused' && hc2.health.locked === true,
  hc2 && JSON.stringify(hc2.health))
setPrefs({ fc_health_overrides: { 'has-card': 'not-a-real-value' } })
board = tb.buildTripBoard()
const hc3 = board.rows.find(r => r.id === 'has-card')
check('健康度：非法覆盖值被忽略，回落机器默认（白名单校验）',
  hc3 && hc3.health.value === 'active' && hc3.health.locked === false, hc3 && JSON.stringify(hc3.health))

console.log('\n---- 6. 手动指定（裁断权在人）----')
setPrefs({ fc_trip_mode: 'manual', fc_trip_projects: ['quiet'] })
board = tb.buildTripBoard()
check('★ manual 模式：只收用户勾的项目（零硬编码清单）',
  board.mode === 'manual' && board.rows.length === 1 && board.rows[0].id === 'quiet',
  board.rows.map(r => r.id).join(','))
check('无契约项目 → contract.exists=false（界面负责显示「未填」，数据层不编）',
  board.rows[0] && board.rows[0].contract.exists === false)

// ── 6b. 2026-10-05 用户实测「一屏是空的」的真因（必须在数据层钉死）──────
// 真因链：prefs 里写着 `fc_trip_mode=manual`，而 `fc_trip_projects` 键**根本不存在**
//        （写盘只落了两个字符串键，两个数组键丢了）→ 手动清单为空 → 15 个项目全部出局
//        → 一屏空白，且下面那句统一文案还写着"它们没有未完结任务"（方寸自己有几十张卡 = 假话）。
console.log('\n---- 6b. 「手动指定」的两个边界 ----')
setPrefs({ fc_trip_mode: 'manual' })  // ⚠ 故意不写 fc_trip_projects（模拟旧包只落了字符串键）
board = tb.buildTripBoard()
check('★ manual 但 fc_trip_projects 键不存在 → 兜底回自动（绝不空屏）',
  board.mode === 'auto' && board.modeFallback === true && board.rows.length > 0,
  `mode=${board.mode} fallback=${board.modeFallback} rows=${board.rows.length}`)

setPrefs({ fc_trip_mode: 'manual', fc_trip_projects: [] })  // 键存在 = 用户真做过选择
board = tb.buildTripBoard()
check('★ 键存在但为空数组 → 尊重用户选择、不回退（界面负责给「改回自动」出口）',
  board.mode === 'manual' && board.modeFallback === false && board.rows.length === 0,
  `mode=${board.mode} fallback=${board.modeFallback} rows=${board.rows.length}`)
check('★ manual 下未勾的项目，原因必须说「手动指定」而**不是**「没有未完结任务」',
  board.hidden.length > 0
  && board.hidden.every(h => h.kind === 'not-picked' && h.reason.indexOf('手动指定') >= 0),
  board.hidden[0] && `${board.hidden[0].kind} / ${board.hidden[0].reason}`)

console.log('\n---- 6b. 加载反馈：git 缓存并发预热（2026-10-11 用户「每次进都要卡一下」）----')
check('★ warmBoardGit 存在且是 async（把逐项目同步 spawn 换成并发等待）',
  typeof tb.warmBoardGit === 'function' && tb.warmBoardGit.constructor.name === 'AsyncFunction')
let warmOk = false
try { await tb.warmBoardGit(); warmOk = true } catch { warmOk = false }
check('★ warmBoardGit 不抛（git 不在/不是仓库都必须安静跳过 —— 界面不能因为读不到 git 就崩）', warmOk)
tb.clearGitCache()
const t0 = Date.now()
await tb.warmBoardGit()
const warmMs = Date.now() - t0
const t1 = Date.now()
tb.buildTripBoard()
const buildMs = Date.now() - t1
check('★★ 预热之后 buildTripBoard 命中缓存（同步路径不该再等 git）',
  buildMs <= Math.max(50, warmMs), `warm=${warmMs}ms build=${buildMs}ms`)

const IPCSRC = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'ipc.ts'), 'utf-8')
check('★★ 源码守卫：trip:board 必须**先预热再聚合**（少了这步优化就等于没做）',
  /guardedHandle\('trip:board',\s*async[\s\S]{0,200}warmBoardGit\(\)[\s\S]{0,200}buildTripBoard\(\)/.test(IPCSRC),
  IPCSRC.slice(IPCSRC.indexOf("trip:board"), IPCSRC.indexOf("trip:board") + 200).replace(/\n/g, ' '))

const APPSRC = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue'), 'utf-8')
check('★ 源码守卫：读取中要有**小提示**（按钮文案 + 屏上提示），不许让用户对着不动的旧表猜',
  /tripLoading \? '⟳ 读取中…'/.test(APPSRC) && /trip-refreshing/.test(APPSRC)
  && /tripLoading && !tripRows\.length/.test(APPSRC))

console.log('\n---- 7. 路径安全与模板 ----')
setPrefs({})
check('repoOfProject：按登记 id 取路径', tb.repoOfProject('has-card') === repoA.replace(/\\/g, '/') || tb.repoOfProject('has-card') === repoA)
check('repoOfProject：未登记 id → 空串（不产出可打开路径）',
  tb.repoOfProject('nope') === '' && tb.repoOfProject('../../etc') === '' && tb.repoOfProject('') === '')
const tpl = tb.contractTemplate('has-card')
check('契约模板：含六字段小节 + 机制条款',
  ['① 终态形态', '② 验收线', '③ 不要什么', '④ 选型定死', '⑤ 现状底数', '⑥ 下一队列']
    .every(k => tpl.includes(k)) && tpl.includes('⑤ 现状底数') && tpl.includes('五条机制条款'))

console.log('\n---- 8. 未进这一屏的项目要说出来 + 建档只建不覆盖 ----')
setPrefs({})
board = tb.buildTripBoard()
check('★ 判据没命中的项目被回传（2026-10-05 用户「加了项目刷新几遍看不到」——界面必须说出来）',
  Array.isArray(board.hidden) && board.hidden.some((h) => h.id === 'quiet')
  && board.hidden.some((h) => h.id === 'empty-one'),
  JSON.stringify(board.hidden.map((h) => h.id)))
check('回传里带人话原因', board.hidden.every((h) => h.reason && h.reason.length > 4))
check('已进屏的项目不在 hidden 里', !board.hidden.some((h) => h.id === 'has-card'))

const init1 = tb.initContractFile('no-card')
check('★ 建档：在还没有契约的项目里创建成功', init1.ok && fs.existsSync(path.join(repoB, '立项契约.md')), init1.error)
check('★ 建档：内容含六字段小节（不是空文件）',
  fs.readFileSync(path.join(repoB, '立项契约.md'), 'utf-8').includes('① 终态形态'))
const init2 = tb.initContractFile('no-card')
check('★ 建档：文件已存在 → **拒绝且不覆盖**（第二次调用必须失败）',
  init2.ok === false && /已经存在/.test(init2.error || ''), init2.error)
check('建档：未登记的项目 → 显式报错（不产出路径）', tb.initContractFile('nope').ok === false)

console.log(`\n通过 ${PASS} / 失败 ${FAILS.length}`)
if (FAILS.length) {
  console.log('失败项：' + FAILS.join('、'))
  process.exit(1)
}
console.log('全部通过。')
})()
