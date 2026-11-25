#!/usr/bin/env node
/**
 * MCP 日志「只读」契约（2026-11-24 重写）
 *
 * ⚠ 这个文件前一版（2026-10-29 写的）验的是「MCP **有** 日志写口」——
 *   create_log / update_log / set_log_status / attach_log_files 都在。
 *   而那四个口 **2026-11-19 就按暮雨拍板整体移除了**（日志是他的私人笔记本，
 *   AI 不写）。于是这一套从此**一直是红的（16/31）**，却没人知道它红着 ——
 *   一个永远红的测试等于没有测试，还会让后来的人以为"产品坏了"。
 *
 *   现在改成钉**现行契约**：写口必须**没有**，而且必须**教会 agent 该写哪里**。
 *   暮雨 2026-11-24 原话：「该写任务的不写，跑去写日志污染我。
 *   方寸应该自己教会 AI 怎么用，而不是给我瞎搞」。
 *
 * 判据分三层：
 *   ① **门关着**：四个写工具一个都不许在工具表里；调用必须失败且不落盘；
 *   ② **说了走哪扇门**：握手 instructions 与工具描述里必须写清「写卡不写日志」；
 *   ③ **读口与合并口仍在**：list/get/search/inject 不许被一并砍掉。
 *
 * 真跑编译产物 dist/main（不是源码字符串比对），临时数据目录，不碰真实任务卡。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const { mkTmp } = require('./_tmp.cjs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const TMP = mkTmp('mcp-logs-')
const DATA = path.join(TMP, 'data')
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'),
  'members: []\nprojects:\n  - id: fm-demo\n    name: 契约演示\nreleased: []\n', 'utf-8')

const DRIVER = `
const D = ${JSON.stringify(path.join(REPO, 'desktop'))}
const out = []
const check = (name, cond, detail) => out.push({ name, pass: !!cond, detail: String(detail || '').slice(0, 300) })
const fs = require('fs')

const tools = require(D + '/dist/main/mcp/tools.js')
const handler = require(D + '/dist/main/mcp/handler.js')
const data = require(D + '/dist/main/data/index.js')
const DATA_DIR = ${JSON.stringify(DATA)}
data.setDataDir(DATA_DIR)

const callRaw = (name, args) => tools.handleMCPToolCall(name, args || {})
const call = (name, args) => {
  const r = callRaw(name, args || {})
  const txt = r && r.content && r.content[0] && r.content[0].text
  try { return JSON.parse(txt) } catch (e) { return { __raw: txt, __err: String(e).slice(0, 160) } }
}
const names = (tools.MCP_TOOLS || []).map(t => t.name)
const LOGDIR = DATA_DIR + '/docs/执行日志'

// ══ ① 门关着：四个写口一个都不许在 ══════════════════════════════════
check('★★★ MCP 没有任何日志写工具（create_log / update_log / set_log_status / attach_log_files 全没有）',
  !['create_log', 'update_log', 'set_log_status', 'attach_log_files'].some(n => names.includes(n)),
  names.join(','))

// 真调一次：必须失败，且**一个文件都不许多**
const before = fs.existsSync(LOGDIR) ? fs.readdirSync(LOGDIR).length : 0
for (const [n, a] of [
  ['create_log', { userAsked: true, title: '不该存在的日志', project: 'fm-demo', content: 'X' }],
  ['update_log', { id: 'log_any', nextSteps: 'X' }],
  ['set_log_status', { id: 'log_any', action: 'archive' }],
  ['attach_log_files', { id: 'log_any', paths: ['C:/nope.png'] }],
]) {
  const r = callRaw(n, a)
  check('★★ 调用 ' + n + ' 真的失败（不是悄悄成功）', !!r && r.isError === true,
    JSON.stringify(r).slice(0, 160))
}
const after = fs.existsSync(LOGDIR) ? fs.readdirSync(LOGDIR).length : 0
check('★★★ 四个写口被拒之后，日志目录**一个文件都没多**（不许报了错还偷偷落盘）',
  after === before, 'before=' + before + ' after=' + after)

// ══ ② 说了走哪扇门（2026-11-24 新增：光关门不教 = 它只能凭直觉）════════
{
  const resp = handler.handleMCPRequest(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, {})
  const instr = String((resp && resp.result && resp.result.instructions) || '')
  check('★ 握手 instructions 说得出来（拿不到就等于没教）', instr.length > 200, instr.slice(0, 100))
  check('★★★ 握手 instructions 里写明「执行日志对 agent 只读」', /执行日志对 agent 只读/.test(instr),
    instr.slice(0, 160))
  check('★★★ 握手 instructions 里写明「干完活要写的是任务卡」（不是只说"别写日志"）',
    /干完活要写的是任务卡/.test(instr) && /待验收/.test(instr))
  check('★★ 握手 instructions 里写明「日志欠账 → 落成卡 + 标 处置：@序号」',
    /处置：@<序号> 已转卡/.test(instr))
}

// 工具描述：agent 选路时读的是这个，不是 instructions
const descOf = (name) => {
  const t = (tools.MCP_TOOLS || []).find(x => x.name === name)
  return t ? String(t.description || '') : ''
}
check('★★ create_task 的描述点明「写卡不写日志」',
  /日志/.test(descOf('create_task')) && /任务卡/.test(descOf('create_task')), descOf('create_task').slice(0, 120))
check('★★ update_task 的描述说明「收工回写走这里」',
  /收工回写/.test(descOf('update_task')), descOf('update_task').slice(0, 120))
check('★★ move_status 的描述说明「完成/驳回是用户签字、会被拒」',
  /签字/.test(descOf('move_status')) && /拒/.test(descOf('move_status')), descOf('move_status').slice(0, 120))

// ══ ③ 读口与合并口不许被一并砍掉 ══════════════════════════════════════
check('★★ 日志读口仍在（list_logs / search_logs / get_log / inject_logs）',
  ['list_logs', 'search_logs', 'get_log', 'inject_logs'].every(n => names.includes(n)), names.join(','))
{
  // 造一条真日志（走界面那套 services/logs，不走 MCP —— 这正是"只有界面能写"的口径）
  const logsSvc = require(D + '/dist/main/services/logs.js')
  const mk = logsSvc.createLog('契约夹具主日志', 'fm-demo', '主日志正文 MAIN', undefined,
    { nextSteps: '下一步 FIRST' })
  check('  前置：用界面那套 API 造出了日志（三条读口的夹具）', mk.ok === true && /^log_/.test(String(mk.data && mk.data.id)),
    JSON.stringify(mk).slice(0, 160))
  const mainId = String((mk.data && mk.data.id) || '')

  const got = call('get_log', { id: mainId })
  check('★★ get_log 读到正文（读口没被连带弄坏）', /MAIN/.test(JSON.stringify(got)), JSON.stringify(got).slice(0, 200))

  const lst = call('list_logs', { project: 'fm-demo' })
  check('★★ list_logs 列得到它', JSON.stringify(lst).indexOf(mainId) >= 0, JSON.stringify(lst).slice(0, 200))

  const raw = callRaw('inject_logs', { ids: [mainId] })
  const bundle = String((raw.content && raw.content[0] && raw.content[0].text) || '')
  check('★★ inject_logs 仍能把日志拼成开工单（主日志在前）', bundle.indexOf('MAIN') >= 0, bundle.slice(0, 200))

  const miss = callRaw('inject_logs', { ids: ['log_nope_x'] })
  check('★ 一条都不存在时明确报错（不许回空串假装成功）', miss.isError === true)

  // 拼接口只有一处实现（界面「开工单」与 MCP 共用）
  const r2 = logsSvc.injectLogs([mainId, 'log_nope_y'])
  check('★★ services/logs.injectLogs 是唯一拼接实现（found/missing 都如实回）',
    r2 && r2.found.length === 1 && r2.missing.length === 1, JSON.stringify({ f: r2 && r2.found, m: r2 && r2.missing }))
}

// ══ ④ 任务侧的正确出口还在（写口没了，总得有地方写）═════════════════════
{
  const nt = call('create_task', { title: '收口权限测试卡', project: 'fm-demo', status: '待办' })
  const tid = String(nt.id || '')
  check('  前置：任务建得出来（写口关了，写卡这条路必须通）', !!tid, JSON.stringify(nt).slice(0, 160))
  const mvDone = call('move_status', { id: tid, status: '完成' })
  check('★★★ move_status → 完成 被拒（完成是用户验收签字）',
    mvDone.ok === false && /只能由用户/.test(String(mvDone.error || '')) && mvDone.suggested === '待验收',
    JSON.stringify(mvDone).slice(0, 200))
  const mvReview = call('move_status', { id: tid, status: '待验收' })
  check('★★ move_status → 待验收 允许（agent 的唯一正确出口）', mvReview.ok === true,
    JSON.stringify(mvReview).slice(0, 160))
}

// ══ ⑤ 源码守卫 ═══════════════════════════════════════════════════════
{
  const src = fs.readFileSync(D + '/src/main/mcp/tools.ts', 'utf-8')
  check('★★ 源码守卫：四个日志写口的分支确实已删（不是只在工具表里藏起来）',
    !/case 'create_log'|case 'update_log'|case 'set_log_status'|case 'attach_log_files'/.test(src))
  check('★★ 源码守卫：MCP inject_logs 走 services（不在 tools 里另拼一份）', (() => {
    const i = src.indexOf("case 'inject_logs'")
    return i >= 0 && src.slice(i, i + 500).indexOf('logs.injectLogs(') >= 0
  })(), 'not found')
  check('★ 源码守卫：get_log 的附件回绝对路径（调 resolveAttachment）',
    /case 'get_log'[\\s\\S]{0,1200}?resolveAttachment\\(/.test(src))
}

console.log(JSON.stringify(out))
`

const driverPath = path.join(TMP, 'driver.js')
fs.writeFileSync(driverPath, DRIVER, 'utf-8')

const r = spawnSync('node', [driverPath], { encoding: 'utf-8', timeout: 120000 })

let pass = 0
let fail = 0
const lines = []
const check = (name, cond, detail) => {
  if (cond) { pass++; lines.push('PASS  ' + name) }
  else { fail++; lines.push('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

if (r.status !== 0) {
  check('MCP 日志只读契约驱动能跑通', false, `exit=${r.status} ${String(r.stderr || '').slice(0, 1200)}`)
} else {
  let res
  try { res = JSON.parse(String(r.stdout || '').trim().split('\n').pop()) } catch (e) { res = null }
  if (!Array.isArray(res)) {
    check('驱动输出可解析', false, String(r.stdout || '').slice(-300))
  } else {
    for (const t of res) check(t.name, t.pass, t.detail)
  }
}

console.log(lines.join('\n'))
console.log(`RESULT ${pass}/${fail}`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail === 0 ? 0 : 1)
