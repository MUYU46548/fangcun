#!/usr/bin/env node
/**
 * 老格式方针卡 + savePolicy 的字节保真回归（2026-11-08 · 联测 P2-3 / 卡 task-20261108-004）
 *
 * 背景：`policies/memory-sanctuary.md` 与 `policies/bianjishi.md` 是**早期四节格式**，
 * 连「## 结构地图」都没有。而结构地图落地（`smap_apply`）走的是 `savePolicy()`，
 * 它是**整份重新拼装**（四节 + 结构地图 + `preserveSections` 兜住的未知节）。
 *
 * 所以这张卡的判据不是“能写进去”，而是**只改该改的**：
 *   · 四节正文逐字节不变；
 *   · 新增「## 结构地图」且带真实日期；
 *   · 老文件里的**非标准段落**（preserveSections 兜底那一类）不许丢、不许被塞进别的节；
 *   · `# 项目方针:` 标题只许有一个；
 *   · 第二次保存**不传** structureMap 时，已有地图**不被骨架覆盖**（这条是 029 的硬规则）。
 *
 * 跑法：node scripts/test/e2e-smap-apply-old-format.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const TMP = mkTmp('smap-old-')
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, path.join(DATA, 'task-data'), path.join(DATA, 'policies'), USERDATA]) {
  fs.mkdirSync(d, { recursive: true })
}

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)
const policies = require(path.join(DIST, 'services', 'policies.js'))

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

/** 按 `## 标题` 切节，返回 { 节名: 正文(去首尾空行) }（正文里保留内部空行与缩进） */
function sections(text) {
  const out = {}
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  let cur = null
  let buf = []
  const flush = () => {
    if (cur !== null) out[cur] = buf.join('\n').replace(/^\n+|\n+$/g, '')
  }
  for (const l of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(l)
    if (m) { flush(); cur = m[1]; buf = [] } else if (cur !== null) buf.push(l)
  }
  flush()
  return out
}

const ID = 'oldfmt'
const FILE = path.join(DATA, 'policies', ID + '.md')
// 早期四节格式：没有「## 结构地图」，另有一个非标准段落（老文件里真实存在的那类）
const OLD = [
  '# 项目方针：oldfmt',
  '',
  '> 更新: 2026-09-01T00:00:00.000Z',
  '> 用途: 派活时随任务书下发，或直接粘给 agent 作为项目背景。',
  '',
  '## 使命',
  '把老项目的边界写清楚。',
  '',
  '## 当前目标',
  '先别加新功能。',
  '',
  '## 应用场景',
  '只在本地跑。',
  '',
  '## 方针边界',
  '不写别人的仓库。',
  '',
  '## 遗留提醒',
  '这一节不是标准四节之一 —— 重写出错就会丢。',
  '',
  '- 保留我',
  '  - 缩进也保留',
  '',
].join('\n')
fs.writeFileSync(FILE, OLD, 'utf-8')

const before = sections(OLD)
const NOT_STD = Object.keys(before).filter((k) => !['使命', '当前目标', '应用场景', '方针边界', '结构地图'].includes(k))
check('夹具里确实有非标准段落（否则这条用例证明不了什么）', NOT_STD.includes('遗留提醒'), NOT_STD.join('|'))

console.log('---- 1. 落一次结构地图（走 savePolicy，与 smap_apply 同一条写路径）----')
const MAP = '> 最后核实：2026-11-08\n\n- 模块清单：main/ 数据层 + services/\n- 主数据流：task-data → services → 渲染层'
const r = policies.savePolicy({
  projectId: ID,
  mission: before['使命'],
  goal: before['当前目标'],
  scenario: before['应用场景'],
  boundary: before['方针边界'],
  structureMap: MAP,
  updatedAt: new Date().toISOString(),
})
check('savePolicy 返回 ok', !!r.ok)
const after1 = sections(fs.readFileSync(FILE, 'utf-8'))

check('★ 使命一节逐字节未变', after1['使命'] === before['使命'], JSON.stringify([before['使命'], after1['使命']]))
check('★ 当前目的一节逐字节未变', after1['当前目标'] === before['当前目标'])
check('★ 应用场景一节逐字节未变', after1['应用场景'] === before['应用场景'])
check('★ 方针边界一节逐字节未变', after1['方针边界'] === before['方针边界'])
check('★★ 新增「结构地图」且带真实日期', !!after1['结构地图'] && /最后核实：2026-11-08/.test(after1['结构地图']), after1['结构地图'] && after1['结构地图'].slice(0, 60))
check('★★ 非标准段落「遗留提醒」还在（兜底没吞）', !!after1['遗留提醒'], Object.keys(after1).join('|'))
check('★★ 非标准段落内容逐字节未变（含缩进）', after1['遗留提醒'] === before['遗留提醒'],
  JSON.stringify([before['遗留提醒'], after1['遗留提醒']]))
const raw1 = fs.readFileSync(FILE, 'utf-8')
check('`# 项目方针:` 标题只有一个（没被拼出两份文件）',
  (raw1.match(/^# 项目方针：/gm) || []).length === 1, String((raw1.match(/^# 项目方针：/gm) || []).length))
check('四节顺序照旧（使命 → 当前目标 → 应用场景 → 方针边界）', (() => {
  const order = ['## 使命', '## 当前目标', '## 应用场景', '## 方针边界'].map((h) => raw1.indexOf(h))
  return order.every((x) => x >= 0) && order.join(',') === order.slice().sort((a, b) => a - b).join(',')
})(), ['## 使命', '## 当前目标', '## 应用场景', '## 方针边界'].map((h) => raw1.indexOf(h)).join(','))

console.log('---- 2. 第二次保存不传 structureMap：已有地图不许被骨架抹掉 ----')
policies.savePolicy({
  projectId: ID,
  mission: before['使命'],
  goal: before['当前目标'],
  scenario: before['应用场景'],
  boundary: before['方针边界'],
  updatedAt: new Date().toISOString(),
})
const after2 = sections(fs.readFileSync(FILE, 'utf-8'))
check('★★ 地图还在（没退化成“待填”）', after2['结构地图'] === MAP.slice(0, after2['结构地图'].length) || /最后核实：2026-11-08/.test(after2['结构地图']),
  after2['结构地图'] && after2['结构地图'].slice(0, 80))
check('★ 它没被骨架覆盖（不出现“待填 —— 填完写日期”）', !/待填/.test(after2['结构地图'] || ''))

console.log('---- 3. 反例：把“保留未知节”关掉，必须精确变红 ----')
{
  // 直接构造一次“只保留四节”的重写，证明**上面那条断言真的能抓到丢节**
  const stripped = ['# 项目方针：oldfmt', '', '## 使命', before['使命'], '', '## 当前目标', before['当前目标'], '',
    '## 应用场景', before['应用场景'], '', '## 方针边界', before['方针边界'], '', '## 结构地图', MAP, ''].join('\n')
  const s2 = sections(stripped)
  check('丢节的重写会被“遗留提醒还在”这条抓住', !s2['遗留提醒'])
}

console.log('')
console.log(`通过 ${PASS} / 失败 ${FAILS.length}`)
if (FAILS.length) { console.log('失败项：'); FAILS.forEach((f) => console.log(' - ' + f)); process.exit(1) }
console.log(`RESULT ${PASS} / 0`)
