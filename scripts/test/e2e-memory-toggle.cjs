/**
 * 记忆开关 · MCP 出口（2026-11-20 v2）
 *
 * 判据不是"设置页有个勾"，而是：
 *   ① 缺省开（键不存在 = 开），显式 false 才关；
 *   ② 关掉后 **五个 agent 出口**（core / search / read / briefing / write）全部说"已关闭"，
 *      不说"没有记忆"，也不假装 core.md 没写；
 *   ③ 关掉时写口真的不落盘；
 *   ④ 读 prefs 失败时按"开"处理（不能把启动/测试搞挂）。
 *
 * ⚠ 用 monkeypatch 改 `prefs.getPref`，不碰真实 prefs.json / 用户数据。
 */
const path = require('path')
const fs = require('fs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const TOOLS = path.join(DIST, 'mcp', 'tools.js')
const PREFS = path.join(DIST, 'services', 'prefs.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆开关 · MCP 出口 ==')
check('★★ 编译产物在（先跑 tsc -p tsconfig.main.json）',
  fs.existsSync(TOOLS) && fs.existsSync(PREFS))

let tools, prefs, originalGetPref
try {
  const data = require(path.join(DIST, 'data', 'index.js'))
  if (typeof data.setDataDir === 'function') data.setDataDir(REPO)
  prefs = require(PREFS)
  originalGetPref = prefs.getPref
  tools = require(TOOLS)
} catch (e) {
  console.log('FAIL 加载失败：' + (e && e.message))
  process.exit(1)
}

/** 模拟 prefs.json 里的 memoryEnabled；undefined = 键不存在 */
function setEnabled(v) {
  prefs.getPref = (k) => (k === 'memoryEnabled' ? v : originalGetPref(k))
}
function restore() { prefs.getPref = originalGetPref }
function call(name, args = {}) {
  const res = tools.handleMCPToolCall(name, args, {})
  const text = res && res.content && res.content[0] && res.content[0].text
  try { return JSON.parse(text || '{}') } catch { return { raw: text } }
}

const claimDir = path.join(REPO, 'memory', 'claims')
const claimCount = () => {
  try { return fs.readdirSync(claimDir).filter((f) => f.endsWith('.md')).length } catch { return 0 }
}

// ① 缺省开
setEnabled(undefined)
const on = call('memory_core')
check('★★ 键不存在 = 开（缺省开）', on.enabled === true && String(on.text || '').includes('D1'),
  JSON.stringify({ enabled: on.enabled, budget: on.budget }))
check('★ 开的时候 budget=800，pinnedCount≥8',
  Number(on.budget) === 800 && Number(on.pinnedCount) >= 8,
  JSON.stringify({ budget: on.budget, pinnedCount: on.pinnedCount }))

setEnabled(true)
check('★ 显式 true = 开', call('memory_core').enabled === true)

// ② 关：五个出口都说"已关闭"
setEnabled(false)
const offCore = call('memory_core')
check('★★ 关掉后 core 返回 enabled:false，且明说"已关闭"',
  offCore.enabled === false && String(offCore.text || '').includes('记忆开关已关闭'),
  JSON.stringify(offCore).slice(0, 200))
check('★★ 关掉后 core 不假装"没写"（missing !== true），仍报归档数',
  offCore.missing === false && Number(offCore.archived) > 0,
  JSON.stringify({ missing: offCore.missing, archived: offCore.archived }))

const offSearch = call('memory_search', { q: 'kill' })
check('★★ 关掉后 memory_search 返回 enabled:false（不是 error，也不是空结果）',
  offSearch.enabled === false && String(offSearch.hint || '').includes('已关闭'),
  JSON.stringify(offSearch).slice(0, 200))

const offRead = call('memory_read', { file: 'memory/claims/mem-20261120-06.md' })
check('★★ 关掉后 memory_read 不返回正文，只说已关闭',
  offRead.enabled === false && !String(offRead.text || '').includes('## 记忆'),
  JSON.stringify(offRead).slice(0, 200))

const offBrief = call('memory_briefing', { project: 'fangcun-base' })
check('★★ 关掉后 memory_briefing 返回 enabled:false',
  offBrief.enabled === false, JSON.stringify(offBrief).slice(0, 200))

const beforeCount = claimCount()
const offWrite = call('memory_write', {
  type: '教训', claim: '开关测试：关掉时不该落盘', evidence: '如果落盘了说明闸没生效', source: 'e2e-toggle',
})
const afterCount = claimCount()
check('★★ 关掉后 memory_write 拒绝，且真的没有落盘',
  offWrite.enabled === false && beforeCount === afterCount,
  JSON.stringify({ enabled: offWrite.enabled, before: beforeCount, after: afterCount }))

// ③ 恢复 = 开
setEnabled(true)
const back = call('memory_search', { q: 'kill' })
check('★★ 重新打开后 search 正常（不是永久关死）',
  back.ok === true && Array.isArray(back.items) && back.items.some((x) => x.id === 'mem-20261120-06'),
  JSON.stringify({ ok: back.ok, returned: back.items && back.items.length }))

// ④ 读 prefs 抛错 → 按开处理（只让 memoryEnabled 这一路抛；writeGate 还要读别的键）
prefs.getPref = (k) => {
  if (k === 'memoryEnabled') throw new Error('prefs.json 坏了')
  return originalGetPref(k)
}
const failSafe = call('memory_core')
check('★★ 读 prefs 失败按"开"处理（不把记忆层搞挂）', failSafe.enabled === true,
  JSON.stringify({ enabled: failSafe.enabled }).slice(0, 120))
restore()

// ⑤ 源码守卫：五个分支都得有记忆闸
const src = fs.readFileSync(TOOLS, 'utf-8')
const offCalls = (src.match(/memoryOff\(\)/g) || []).length
check('★★ 源码里五个记忆分支都调用 memoryOff（不是只写文档）', offCalls >= 5, 'calls=' + offCalls)

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
