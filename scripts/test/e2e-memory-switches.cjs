/**
 * 记忆层三处「文档写了、闸门里没有」的接线（2026-11-24）
 *
 * ## 存在的理由
 *
 * 暮雨 2026-11-24：「优先对整个记忆系统进行规划重制，记忆系统有重大问题。」
 * 核实时发现的三条不是"设计不对"，是**接线断了**：
 *
 *  ① `memoryInjectCore` / `memoryBriefing` 两个子开关只在设置页有两个复选框，
 *     后端 `getPref` 只读过 `memoryEnabled` 一个 —— 用户点掉它，什么都没变。
 *  ② `复核` 字段在规划 §3.3 写着「>180 天在简报里标待复核」，
 *     而代码里只解析、从没读它做判断。
 *  ③ 上面两条都有一个共同的失败形态：**"关"被说成"没有"**。
 *     本仓的四态混淆（关 / 空 / 读失败 / 没连上）栽过多次，这一套逐条钉住。
 *
 * ## 判据
 *   · 子开关关掉 → `enabled:true, subEnabled:false`，**必须有 hint 说明"数据还在"**；
 *   · `force:true` 能取一次（开关是"别自动喂我"，不是"不许我看"）；
 *   · 键不存在 = 开（升级用户不能被默认关掉）；
 *   · `reviewAgeDays` 认不出日期 → **null，绝不当 0**（0 会变成"1970 年 / 晾了 20000 天"）；
 *   · 超过 180 天 → `reviewOverdue:true` 且简报 hint 点名它。
 *
 * 反例自证：把子开关判定改成恒 true → 必须精确变红；
 * 把 null 改成 0 → "认不出"那条必须变红。
 *
 * 运行：node scripts/test/e2e-memory-switches.cjs
 */
const path = require('path')
const fs = require('fs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆层 · 子开关与复核接线 ==')

const memPath = path.join(DIST, 'services', 'memory.js')
const toolsPath = path.join(DIST, 'mcp', 'tools.js')
check('★★ 编译产物在（先跑 npm run build）', fs.existsSync(memPath) && fs.existsSync(toolsPath), memPath)
if (!fs.existsSync(memPath) || !fs.existsSync(toolsPath)) {
  console.log(`\nRESULT ${pass} / ${fail}`)
  process.exit(1)
}

// 数据根锁到仓库根（本机数据根就是仓库根）；prefs 用内存替身，**不碰真实 prefs.json**
const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(REPO)

// prefs 替身：在 require tools.js 之前塞进去
const prefsPath = path.join(DIST, 'services', 'prefs.js')
const prefs = require(prefsPath)
const PREFS = {}
const origGet = prefs.getPref
if (typeof prefs.getPref === 'function') {
  prefs.getPref = (k) => (k in PREFS ? PREFS[k] : undefined)
}

const tools = require(toolsPath)
const mem = require(memPath)

function callTool(name, args) {
  const t = tools.MCP_TOOLS.find((x) => x.name === name)
  if (!t) return { content: [{ type: 'text', text: JSON.stringify({ error: 'no such tool: ' + name }) }] }
  // ⚠ 签名是 handleMCPToolCall(name, args, meta) —— 传对象进去会得到 "Unknown tool: [object Object]"
  return tools.handleMCPToolCall(name, args || {}, {})
}

function payload(res) {
  try {
    return JSON.parse(res.content[0].text)
  } catch {
    return { raw: res && res.content && res.content[0] && res.content[0].text }
  }
}

// ── ① 纯函数：reviewAgeDays 的三态 ────────────────────────────────────
console.log('\n-- ① reviewAgeDays：认不出 ≠ 0 --')
check('★ reviewAgeDays 已导出', typeof mem.reviewAgeDays === 'function')
if (typeof mem.reviewAgeDays === 'function') {
  const now = new Date(2026, 10, 24).getTime() // 2026-11-24 本地
  check('★★ 空串 → null（未填复核日期，不是"刚复核过"）',
    mem.reviewAgeDays('', now) === null, String(mem.reviewAgeDays('', now)))
  check('★★ 认不出的写法 → null（绝不当 0）',
    mem.reviewAgeDays('不知道', now) === null, String(mem.reviewAgeDays('不知道', now)))
  check('★★ 190 天前 → 190（不是 0，也不是 undefined）',
    mem.reviewAgeDays('2026-05-18', now) === 190, String(mem.reviewAgeDays('2026-05-18', now)))
  check('★ 今天 → 0（这一条 0 才是对的）',
    mem.reviewAgeDays('2026-11-24', now) === 0, String(mem.reviewAgeDays('2026-11-24', now)))
  check('★ 未来日期不产生负数（钳到 0）',
    mem.reviewAgeDays('2027-01-01', now) === 0, String(mem.reviewAgeDays('2027-01-01', now)))
  check('★ REVIEW_DAYS 是 180（与规划 §3.3 一致）', mem.REVIEW_DAYS === 180, String(mem.REVIEW_DAYS))
}

// ── ② 简报带复核字段 ─────────────────────────────────────────────────
console.log('\n-- ② 简报条目带 review / reviewOverdue --')
const brief = mem.memoryBriefing('fangcun-base', 5)
check('★ 简报有 item（0 条时下面的断言是空转）', brief.items.length > 0, `items=${brief.items.length}`)
const withReview = brief.items.filter((x) => 'review' in x && 'reviewAgeDays' in x && 'reviewOverdue' in x)
check('★★ 每条都带 review / reviewAgeDays / reviewOverdue 三字段',
  withReview.length === brief.items.length, `${withReview.length}/${brief.items.length}`)
const badAge = brief.items.filter((x) => x.reviewAgeDays !== null && !(x.reviewAgeDays >= 0))
check('★★ reviewAgeDays 只能是 null 或非负数', badAge.length === 0, JSON.stringify(badAge.map((x) => x.reviewAgeDays)))
const overdueOk = brief.items.every((x) => {
  if (x.reviewAgeDays === null) return x.reviewOverdue === false  // 认不出 → 不许标待复核
  return x.reviewOverdue === (x.reviewAgeDays > 180)
})
check('★★ reviewOverdue 恒等于「age !== null && age > 180」', overdueOk,
  JSON.stringify(brief.items.map((x) => [x.reviewAgeDays, x.reviewOverdue])))

// ── ③ 子开关：关掉必须真关，且说清"数据还在" ──────────────────────────
console.log('\n-- ③ 子开关 memoryInjectCore --')
PREFS.memoryInjectCore = false
const coreOff = callTool('memory_core', {})
const coreOffBody = payload(coreOff)
check('★★ 关掉后 text 为空（不是照旧返回正文）', coreOffBody.text === '', JSON.stringify(coreOffBody.text).slice(0, 60))
check('★★ 关掉后 subEnabled === false 且 switch 点名',
  coreOffBody.subEnabled === false && coreOffBody.switch === 'memoryInjectCore', JSON.stringify(coreOffBody))
check('★★ 关掉 ≠ 没有：hint 必须说"还在"并给出条数',
  /还在/.test(String(coreOffBody.hint)) && /\d/.test(String(coreOffBody.hint)),
  String(coreOffBody.hint).slice(0, 120))
check('★★ 关掉后 enabled 仍是 true（总开关没关，别把两件事混说）', coreOffBody.enabled === true)

const coreForce = callTool('memory_core', { force: true })
const coreForceBody = payload(coreForce)
check('★★ force:true 能临时取一次（开关是"别自动喂我"，不是"不许我看"）',
  String(coreForceBody.text || '').length > 0, `chars=${coreForceBody.chars}`)

PREFS.memoryInjectCore = true
const coreOn = payload(callTool('memory_core', {}))
check('★ 开回来后正文照旧', String(coreOn.text || '').length > 0 && coreOn.subEnabled === true)

console.log('\n-- ④ 子开关 memoryBriefing --')
PREFS.memoryBriefing = false
const bOff = payload(callTool('memory_briefing', { project: 'fangcun-base' }))
check('★★ 关掉后不返回 items（不是照旧给简报）',
  bOff.items === undefined && bOff.subEnabled === false, JSON.stringify(bOff).slice(0, 120))
check('★★ 关掉 ≠ 没有：hint 说明是开关关的',
  /开关是关的|还在/.test(String(bOff.hint)), String(bOff.hint).slice(0, 120))
const bForce = payload(callTool('memory_briefing', { project: 'fangcun-base', force: true }))
check('★ force:true 能临时取一次', Array.isArray(bForce.items) && bForce.items.length > 0)
PREFS.memoryBriefing = true
const bOn = payload(callTool('memory_briefing', { project: 'fangcun-base' }))
check('★ 开回来后照旧有 items', Array.isArray(bOn.items) && bOn.items.length > 0)
check('★★ 简报顶层带 reviewOverdue 计数（0 也要有，不能缺字段）',
  typeof bOn.reviewOverdue === 'number', String(bOn.reviewOverdue))

// ── ⑤ 缺省语义：键不存在 = 开 ────────────────────────────────────────
console.log('\n-- ⑤ 键不存在 = 开（升级用户不能被默认关掉）--')
delete PREFS.memoryInjectCore
delete PREFS.memoryBriefing
delete PREFS.memoryEnabled
const dCore = payload(callTool('memory_core', {}))
const dBrief = payload(callTool('memory_briefing', { project: 'fangcun-base' }))
check('★★ prefs 里三个键都不存在 → core 照常返回正文',
  dCore.subEnabled === true && String(dCore.text || '').length > 0, JSON.stringify(dCore).slice(0, 100))
check('★★ prefs 里三个键都不存在 → 简报照常返回',
  dBrief.subEnabled === undefined || dBrief.subEnabled === true, JSON.stringify(dBrief).slice(0, 100))

// ── ⑥ 总开关仍然优先 ─────────────────────────────────────────────────
console.log('\n-- ⑥ 总开关关掉时，两个子开关都不许放行 --')
PREFS.memoryEnabled = false
PREFS.memoryInjectCore = true
const allOffCore = payload(callTool('memory_core', { force: true }))
check('★★ 总开关关 + force:true → 仍返回 enabled:false（force 不越总闸）',
  allOffCore.enabled === false, JSON.stringify(allOffCore).slice(0, 120))
PREFS.memoryEnabled = true

// ── ⑦ 源码守卫：状态恢复 ─────────────────────────────────────────────
prefs.getPref = origGet

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
