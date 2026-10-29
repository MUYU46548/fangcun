#!/usr/bin/env node
/**
 * MCP 日志写口 + 附件绝对路径（2026-10-29 暮雨第 6 / 7 / 9 条②）
 *
 * 三条被真机反馈打出来的事实，这个套件就是钉住它们：
 *   ① **MCP 此前只有读日志三件**（list/search/get）—— agent 说"我改不了状态，只能你在界面上点"
 *      是对的。现在补 create_log / update_log / set_log_status / attach_log_files。
 *   ② `get_log` 只回正文，日志里的 `![](…)` 对 agent 就是一行相对路径文本 ——
 *      "贴了一堆图"被读成"只有文字"。现在回 attachments[].abs（绝对路径）+ 一句人话提示。
 *   ③ 真实用法长出来的需求：**主日志带多条副日志一起进开工单**（inject_logs）——
 *      只灌主日志，并行的另一半就丢了。
 *
 * ⚠ 真跑编译产物 dist/main（不是源码字符串比对），临时数据目录，不碰真实 task-data。
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-logs-'))
const DATA = path.join(TMP, 'data')
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'),
  'members: []\nprojects:\n  - id: fm-demo\n    name: 契约演示\nreleased: []\n', 'utf-8')
// 一张真 PNG（8 字节签名足够验"文件真在盘上"）
const SHOT = path.join(TMP, '截图契约.png')
fs.writeFileSync(SHOT, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

const DRIVER = `
const D = ${JSON.stringify(path.join(REPO, 'desktop'))}
const out = []
const check = (name, cond, detail) => out.push({ name, pass: !!cond, detail: String(detail || '').slice(0, 260) })
const fs = require('fs')

const tools = require(D + '/dist/main/mcp/tools.js')
const data = require(D + '/dist/main/data/index.js')
const DATA_DIR = ${JSON.stringify(DATA)}
data.setDataDir(DATA_DIR)

const callRaw = (name, args) => tools.handleMCPToolCall(name, args || {})
const call = (name, args) => {
  const r = callRaw(name, args || {})
  const txt = r && r.content && r.content[0] && r.content[0].text
  try { return JSON.parse(txt) } catch (e) { return { __raw: txt, __err: String(e).slice(0, 160) } }
}

// ── 工具表里有这五件（对外契约） ─────────────────────────────────────
const names = (tools.MCP_TOOLS || []).map(t => t.name)
check('★★ MCP 有了日志写口（create_log / update_log / set_log_status / attach_log_files）',
  ['create_log', 'update_log', 'set_log_status', 'attach_log_files'].every(n => names.includes(n)),
  names.join(','))
check('★★ 有多日志合并入口 inject_logs（主日志带副日志一起灌）',
  names.includes('inject_logs'), names.join(','))

// ── 建主日志 ────────────────────────────────────────────────────────
const created = call('create_log', {
  title: '契约夹具主日志', project: 'fm-demo',
  content: '主日志正文 MAIN', nextSteps: '下一步 FIRST', priority: '高', agentName: '契约测试',
})
check('★★ create_log 真的建了日志并回 id', created.ok === true && /^log_/.test(String(created.id || '')),
  JSON.stringify(created).slice(0, 200))
const mainId = String(created.id || '')

const control = callRaw('get_log', { id: mainId })
check('  新建的日志能被 get_log 读回来（同一套落盘路径）', !control.isError)

// ── 挂附件 → 绝对路径 ───────────────────────────────────────────────
const att = call('attach_log_files', { id: mainId, paths: [${JSON.stringify(SHOT)}] })
check('★★ attach_log_files 挂上了（文件复制进数据目录，源文件不动）',
  att.ok === true && Number(att.count) === 1, JSON.stringify(att).slice(0, 220))
check('  回传的 abs 指向真文件', att.attachments && att.attachments[0] && fs.existsSync(att.attachments[0].abs),
  JSON.stringify(att.attachments || []).slice(0, 200))
check('  源文件还在原处（复制不是剪切）', fs.existsSync(${JSON.stringify(SHOT)}))

const got = call('get_log', { id: mainId })
const a0 = (got.attachments || [])[0] || {}
check('★★ get_log 回 attachments[].abs **绝对路径**（修复前：只有正文，agent 只看到一行相对路径文本）',
  String(a0.abs || '').indexOf(':') > 0 && fs.existsSync(a0.abs),
  JSON.stringify(a0).slice(0, 200))
check('  标了 kind=image（agent 才知道这是图、该用看图工具读）', a0.kind === 'image', JSON.stringify(a0).slice(0, 160))
check('★★ 有一句人话说明「N 个附件没随文本返回」', /1 个附件/.test(String(got.attachmentsHint || '')),
  JSON.stringify(String(got.attachmentsHint || '')).slice(0, 200))
check('  没有 base64 内联（token 会爆）', !/base64,[A-Za-z0-9+/]{40}/.test(JSON.stringify(got)))

// ── 改正文 ──────────────────────────────────────────────────────────
const upd = call('update_log', { id: mainId, nextSteps: '下一步 SECOND' })
check('★ update_log 改得动（此前 agent 完全改不了日志）', upd.ok === true, JSON.stringify(upd).slice(0, 200))
check('  改完 get_log 读回新值', /SECOND/.test(String(call('get_log', { id: mainId }).nextSteps || '')))

// ── 并行副日志 + 合并注入 ───────────────────────────────────────────
const side = call('create_log', { title: '并行副日志', project: 'fm-demo', content: '副日志正文 SIDE' })
const sideId = String(side.id || '')
check('  副日志建好', side.ok === true && !!sideId, JSON.stringify(side).slice(0, 160))
const raw = callRaw('inject_logs', { ids: [mainId, sideId] })
const bundle = String((raw.content && raw.content[0] && raw.content[0].text) || '')
check('★★ inject_logs 把主日志和副日志拼成一份（主在前）',
  bundle.indexOf('MAIN') >= 0 && bundle.indexOf('SIDE') >= 0
  && bundle.indexOf('MAIN') < bundle.indexOf('SIDE'),
  bundle.slice(0, 200))
check('★★ 副日志被标成「并行日志」而不是续写（否则 agent 会当成同一轮的回头路）',
  /并行日志/.test(bundle), bundle.slice(0, 260))
check('  主日志不带那个标记（只有第二条起才有）',
  bundle.indexOf('并行日志') > bundle.indexOf('MAIN'))
const miss = callRaw('inject_logs', { ids: ['log_nope_x'] })
check('  一条都不存在时明确报错（不许回空串假装成功）', miss.isError === true)

// ── 状态流转 ────────────────────────────────────────────────────────
const arc = call('set_log_status', { id: mainId, action: 'archive' })
check('★★ set_log_status archive → 归档（此前只能用户在界面上点）',
  arc.ok === true && /已归档/.test(String(arc.status || '')), JSON.stringify(arc).slice(0, 200))
const reo = call('set_log_status', { id: mainId, action: 'reopen' })
check('★ reopen 能撤回来（状态是单行道就没人敢用）',
  reo.ok === true && /待处理/.test(String(reo.status || '')), JSON.stringify(reo).slice(0, 200))
const run = call('set_log_status', { id: mainId, action: 'running' })
check('  running 置「进行中」', run.ok === true && /进行中/.test(String(run.status || '')), JSON.stringify(run).slice(0, 160))
const bad = call('set_log_status', { id: mainId, action: 'nope' })
check('  非法 action 明确报错（不静默什么都不做）', bad.__raw !== undefined || bad.ok === false)

// ── 界面「⧉ 开工单」与 MCP 共用同一段拼接（2026-10-29 第 6 条）────────────
// 两处各拼一次是最容易分叉的地方（界面改了文案、MCP 没跟上），所以这里直接钉：
// services/logs.injectLogs 是唯一实现，MCP 的 inject_logs 只是它的出口。
{
  const logsSvc = require(D + '/dist/main/services/logs.js')
  const r = logsSvc.injectLogs([mainId, 'log_nope_y', sideId])
  check('★★ services/logs.injectLogs 是唯一拼接实现（found/missing 都如实回）',
    r && r.found.length === 2 && r.missing.length === 1 && r.found[0] === mainId,
    JSON.stringify({ found: r && r.found, missing: r && r.missing }))
  check('★ 缺的那条在文本里点出来（不许静默少一段）', /未找到/ .test(String(r && r.text)) && String(r.text).indexOf('log_nope_y') >= 0,
    String(r && r.text).slice(-80))
}
// ── 源码守卫 ────────────────────────────────────────────────────────
const src = fs.readFileSync(D + '/src/main/mcp/tools.ts', 'utf-8')
check('源码守卫：写口走 services/logs（不新开第二套写路径）',
  /case 'create_log'[\\s\\S]{0,200}?logs\\.createLog\\(/.test(src))
check('源码守卫：MCP inject_logs 走 services（不在 tools 里另拼一份）', (() => {
  const i = src.indexOf("case 'inject_logs'")
  return i >= 0 && src.slice(i, i + 400).indexOf('logs.injectLogs(') >= 0
})(), 'not found')
check('源码守卫：get_log 的附件不再只回相对路径（必须调 resolveAttachment）',
  /case 'get_log'[\\s\\S]{0,900}?resolveAttachment\\(/.test(src))

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
  check('MCP 日志写口驱动能跑通', false, `exit=${r.status} ${String(r.stderr || '').slice(0, 1200)}`)
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
