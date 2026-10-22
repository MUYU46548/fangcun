#!/usr/bin/env node
/**
 * 认领字段的**跨语言往返**（2026-10-22）
 *
 * 为什么要单独一个测试：认领是 Python CLI 写、桌面读、桌面也会写回去的字段。
 * 任一侧漏一处（受管键没输出 / 别名表没映射 / FM_ORDER 没列）都会**静默丢字段** ——
 * 表现是"卡又变没人领了，下一个 agent 再干一遍"，而界面上一切正常。
 *
 * 这个文件只钉一件事：**Python 写的认领，桌面读得到、改别的字段时不丢、写回去 Python 还认得。**
 * 认领的机制语义（租约/原子/交回校验）在 scripts/smoke_claim.py 里。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-field-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.mkdirSync(USERDATA, { recursive: true })

const orig = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return orig.call(this, request, ...rest)
}

const CARD = path.join(DATA, 'task-data', 'task-20261022-001.md')
const CLAIM_AT = '1792650000'
fs.writeFileSync(CARD, [
  '---',
  'id: task-20261022-001',
  '标题: 带认领的卡',
  '项目: [demo]',
  '状态: 进行中',
  '优先级: 中',
  // Python 侧 tegula next --claim hermes 写出来的就是这两行（中文键）
  '认领人: hermes',
  `认领时间: ${CLAIM_AT}`,
  '---',
  '',
  '## 方案',
  '- [ ] x',
  '',
].join('\n'), 'utf-8')

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)
const tasksData = require(path.join(DIST, 'data', 'tasks.js'))

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

console.log('---- 1. Python 写的认领，桌面读得到 ----')
const list = data.loadTasks('active')
check('卡被读到（认领字段若导致解析失败，这里会是 0 张 —— 卡直接隐身）',
  list.length === 1, String(list.length))
const t = list[0] || { fm: {} }
check('★★ 中文键「认领人」→ claimed_by（别名表映射生效）',
  t.fm.claimed_by === 'hermes', String(t.fm.claimed_by))
check('★★ 「认领时间」→ claimed_at', String(t.fm.claimed_at) === CLAIM_AT, String(t.fm.claimed_at))
check('★ 没掉进未知字段里（未知字段会被原样透传，但界面/逻辑读不到）',
  !(t.fm['认领人']), String(t.fm['认领人']))

console.log('\n---- 2. 桌面改别的字段，认领不丢 ----')
tasksData.updateTask('task-20261022-001', { title: '改了个标题' })
let raw = fs.readFileSync(CARD, 'utf-8')
// ⚠ 注意别把这句写成"FM_ORDER 里必须有它" —— 实测：只从 FM_ORDER 删掉**不会丢**，
//   renderTask 后面还有"剩余未知字段原样输出"兜着。真正决定的是别名表的中文键映射。
check('★★ 改标题之后认领人还在（写回去必须是中文键，否则 Python 侧读不到）',
  /认领人:\s*hermes/.test(raw), raw.split('\n').filter((l) => /认领/.test(l)).join(' | '))
check('★★ 认领时间也还在（漏一个就等于把租约起点清了）',
  new RegExp('认领时间:\\s*' + CLAIM_AT).test(raw))
check('  标题确实改了（证明这次写盘真发生了，不是"没动所以没丢"）',
  /标题:\s*改了个标题/.test(raw), raw.split('\n').filter((l) => /标题/.test(l)).join(' | '))

console.log('\n---- 3. 桌面改「状态」这类会走另一条分支的字段，认领还是不丢 ----')
tasksData.updateTask('task-20261022-001', { status: '待验收' })
raw = fs.readFileSync(CARD, 'utf-8')
check('★ 改状态后认领仍在（状态迁移不该顺手把认领导致丢失）',
  /认领人:\s*hermes/.test(raw) && new RegExp('认领时间:\\s*' + CLAIM_AT).test(raw),
  raw.split('\n').filter((l) => /认领|状态/.test(l)).join(' | '))

console.log('\n---- 4. 桌面把整张卡读出来再写回去（renderTask 往返） ----')
const back = data.loadTasks('active')[0]
if (back) {
  // 只改一个无关字段，触发整张卡的 renderTask 重写
  tasksData.updateTask(back.id, { priority: '高' })
  raw = fs.readFileSync(CARD, 'utf-8')
  check('★★ 整卡重写之后两个认领字段都还在（这是"受管键漏输出"最容易露馅的路径）',
    /认领人:\s*hermes/.test(raw) && new RegExp('认领时间:\\s*' + CLAIM_AT).test(raw),
    raw.split('\n').filter((l) => /认领/.test(l)).join(' | '))
} else {
  check('整卡重写', false, '卡读不到了')
}

console.log('\n---- 5. 没有认领的卡，写回不许凭空多两行 ----')
const CARD2 = path.join(DATA, 'task-data', 'task-20261022-002.md')
fs.writeFileSync(CARD2, [
  '---', 'id: task-20261022-002', '标题: 没人领的卡', '项目: [demo]',
  '状态: 待办', '优先级: 中', '---', '', '## 方案', '- [ ] y', '',
].join('\n'), 'utf-8')
tasksData.updateTask('task-20261022-002', { title: '改一下' })
const raw2 = fs.readFileSync(CARD2, 'utf-8')
check('★ 旧卡（从来没有认领）写回后仍然没有「认领人」这行',
  !/认领人/.test(raw2) && !/认领时间/.test(raw2), raw2.slice(0, 160))
const t2 = data.loadTasks('active').find((x) => x.id === 'task-20261022-002')
check('  读出来 claimed_by 是空（不是 undefined 挂着一个假值）',
  t2 && !t2.fm.claimed_by, t2 && String(t2.fm.claimed_by))

console.log(`\n==== ${PASS} 通过 / ${FAILS.length} 失败 ====`)
if (FAILS.length) { FAILS.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1) }
