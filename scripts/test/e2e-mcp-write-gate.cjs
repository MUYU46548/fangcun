#!/usr/bin/env node
/**
 * MCP 写口闸 + 写侧留痕 e2e（2026-11-11 · 卡《MCP 写口无闸》）
 *
 * 判据（卡上原文）：
 *   · 反例：档位在「只读」时调 create_task → 被拒，且说清为什么被拒；
 *   · 反例：在「读写」档调 delete_task（非读写+破坏性）→ 被拒；
 *   · 开关改档本身留痕（谁、何时、从哪档到哪档）；
 *   · 界面上能看到“最近 N 次由 agent 写入”的清单（工具 / 时间 / 落了什么）。
 * 另外钉住两件容易做成假绿灯的事：
 *   · **读**不做成要开闸（只读工具在只读档照常可用）；
 *   · 留痕**不抄正文**（正文折成长度）——否则审计日志把密钥/私事再存一遍。
 *
 * 运行：node scripts/test/e2e-mcp-write-gate.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('mcp-write-')
const DATA = path.join(TMP, 'data')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, path.join(DATA, 'task-data'), process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'), 'projects:\n  - id: fangcun-base\n    name: 方寸\n    repo: .\n', 'utf-8')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const tools = require(path.join(DIST, 'main', 'mcp', 'tools.js'))
const gate = require(path.join(DIST, 'main', 'mcp', 'writeGate.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}
function call(name, args, client = 'DSH') {
  const r = tools.handleMCPToolCall(name, args || {}, { client })
  const text = String((r && r.content && r.content[0] && r.content[0].text) || '')
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { raw: r, isError: !!(r && r.isError), text, json }
}
const logRaw = () => { try { return fs.readFileSync(gate.writeLogPath(), 'utf-8') } catch { return '' } }

console.log('== ① 默认档位 = 读写（写放行、破坏性关）==')
{
  check('★★ 默认档位是 write（不是 read —— 别把存量 agent 一夜锁死）', gate.getWriteMode() === 'write', gate.getWriteMode())
  const c = call('create_task', { title: '写口闸测试卡', body: '不该出现在审计里的正文' })
  check('★★ 读写档：create_task 放行', c.isError === false && c.json && c.json.ok === true, c.text)
  const d = call('delete_task', { id: c.json.id })
  check('★★ 读写档：delete_task 被拒（破坏性默认关）', d.isError === true && /破坏性/.test(d.json?.error || d.text), d.text)
  check('★ 拒因说清当前档位与怎么改', /读档位|档位/.test(d.json?.error || '') && /设置/.test(d.json?.error || ''), d.text)
  const r = call('rice_pool_upsert', { items: [] })
  check('★★ 读写档：rice_pool_upsert（改分）也被拒', r.isError === true && /破坏性/.test(r.json?.error || r.text), r.text)
}

console.log('== ② 只读档：写一律拒，读照常 ==')
{
  const set = gate.setWriteMode('read', 'test')
  check('★ 改档成功且回读一致', set.ok === true && set.mode === 'read' && set.previous === 'write', JSON.stringify(set))
  const c = call('create_task', { title: '只读档不该落卡' })
  check('★★ 只读档：create_task 被拒', c.isError === true && /只读/.test(c.json?.error || c.text), c.text)
  const u = call('update_task', { id: 'x', fields: { title: 'y' } })
  check('★★ 只读档：update_task 也被拒', u.isError === true && /只读/.test(u.json?.error || u.text), u.text)
  const l = call('list_tasks', {})
  check('★★ 只读档：读工具照常（不给“看一眼”也设闸）', l.isError === false, l.text.slice(0, 120))
  const g = call('get_task', { id: 'nope' })
  check('★ 只读档：get_task 走到业务层（返回 not found 而不是被闸拦）', g.isError === true && /not found|Task not found/i.test(g.text), g.text)
}

console.log('== ③ 读写+破坏性档：删卡放行 ==')
{
  gate.setWriteMode('destructive', 'test')
  const c = call('create_task', { title: '待删除卡' })
  const d = call('delete_task', { id: c.json.id })
  check('★★ 破坏性档：delete_task 放行', d.isError === false && d.json && d.json.ok === true, d.text)
  gate.setWriteMode('write', 'test')
}

console.log('== ④ 写侧留痕（含被拒、含客户端名、不抄正文）==')
{
  // 清一份干净的留痕：换 dataDir 不现实，直接把文件截断
  try { fs.writeFileSync(gate.writeLogPath(), '', 'utf-8') } catch { /* ignore */ }
  call('create_task', { title: '留痕卡', body: '不该出现在审计里的正文', project: 'fangcun-base' }, 'Hermes')
  gate.setWriteMode('read', 'test')
  call('create_task', { title: '被拒的卡' }, 'Cursor')
  const raw = logRaw()
  check('★★ 留痕文件落在数据根 task-data 下', gate.writeLogPath().replace(/\\/g, '/').endsWith('data/.mcp-writes.jsonl'))
  check('★★ 成功写下的一条有客户端名', /"client":"Hermes"/.test(raw), raw.slice(0, 300))
  check('★★ 被拒的尝试也留痕（谁想写、被拦在哪个工具）', /"client":"Cursor"[\s\S]{0,200}"ok":false/.test(raw) && /被拒的卡/.test(raw), raw.slice(-600))
  check('★★ 正文折成长度，不进审计（不抄第二遍）', !/不该出现在审计里的正文/.test(raw) && /chars/.test(raw), raw.slice(-500))
  const rows = gate.listWrites(50).rows
  check('★ 清单按时间倒序、带工具名', rows.length >= 2 && rows[0].via === 'create_task', JSON.stringify(rows.slice(0, 2)))
  const modeRows = rows.filter((r) => r.via === 'mcp.writeMode')
  check('★★ 改档本身留痕（from/to）', modeRows.length > 0 && !!modeRows[0].args && ('from' in modeRows[0].args), JSON.stringify(modeRows[0] || null))
}

console.log('== ⑤ 只登记不猜：未知工具按写处理 ==')
{
  check('★ 未登记的工具不是 read（默认收紧）', gate.tierOf('some_new_tool', {}) === 'write')
  check('★ 读工具白名单认得出', gate.tierOf('list_tasks', {}) === 'read' && gate.tierOf('qn_list', {}) === 'read')
  check('★ 替用户签字（update_task 改驳回/完成）算破坏性', gate.tierOf('update_task', { fields: { status: '驳回' } }) === 'destructive')
  check('★ move_status 到完成/驳回 不算“开档就能用”（那条是无条件硬拒，档位管不着）',
    gate.tierOf('move_status', { status: '驳回' }) === 'write')
}

console.log('== ⑥ 接线守卫（闸在入口、客户端名从 initialize 来、界面能改档）==')
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const t = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/mcp/tools.ts'), 'utf-8'))
  check('★★ 闸在 handleMCPToolCall 入口（不是散在各 case）',
    /export function handleMCPToolCall[\s\S]{0,400}checkMcpWrite\(/.test(t))
  check('★★ 被拒也走 recordWrite', /!decision\.ok[\s\S]{0,300}recordWrite\(/.test(t))
  const ss = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/mcp/socket-server.ts'), 'utf-8'))
  check('★★ 客户端名按连接从 initialize 的 clientInfo 取', /clientInfo/.test(ss) && /handleMCPRequest\(req, \{ client: clientName \}\)/.test(ss))
  const ipc = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/ipc.ts'), 'utf-8'))
  check('★★ 设置页三条通道都在主进程注册',
    /mcp:writeMode'/.test(ipc) && /mcp:writeModeSet'/.test(ipc) && /mcp:writes'/.test(ipc))
  const pre = strip(fs.readFileSync(path.join(REPO, 'desktop/src/preload/index.ts'), 'utf-8'))
  check('★★ preload 真有这三条（否则界面点了没反应）',
    /mcpWriteMode:/.test(pre) && /mcpSetWriteMode:/.test(pre) && /mcpWrites:/.test(pre))
  const ui = strip(fs.readFileSync(path.join(REPO, 'desktop/src/renderer/components/settings/AgentSettings.vue'), 'utf-8'))
  check('★★ 设置页能改档、能看清单',
    /mcpSetWriteMode\(/.test(ui) && /mcpWrites\(/.test(ui) && /最近/.test(ui))
  // 评审抓到：清单里的「落点」只看 args，而新卡 id 只存在留痕的 result 里 → 恒显示「—」
  check('★★ 清单“落点”会看留痕的 result（否则 create_task 永远显示 —）',
    /w\.result|w\?\.result/.test(ui))
}

console.log('== ⑦ gate_list 读同一个盘文件（评审抓到：桌面 MCP 曾恒回 []）==')
{
  const gates = {
    'g-1': { title: '门一', items: ['a'], status: 'open', conclusion: null },
    'g-2': { title: '门二', items: ['b'], status: 'closed', conclusion: 'closed' },
  }
  fs.writeFileSync(path.join(DATA, 'task-data', '.gates.json'), JSON.stringify(gates), 'utf-8')
  const g = call('gate_list', {})
  const rows = (() => { try { return JSON.parse(g.text) } catch { return null } })()
  check('★★ 桌面 MCP 的 gate_list 读得到 Python 落的 .gates.json',
    Array.isArray(rows) && rows.length === 2 && rows.some((r) => r && r.title === '门一'), g.text.slice(0, 200))
  // 文件不存在 → 空数组（不是“读不到”那种错误）
  fs.unlinkSync(path.join(DATA, 'task-data', '.gates.json'))
  const g2 = call('gate_list', {})
  check('★ 没有门控文件 → 空数组（不是错误）', g2.isError === false && String(g2.text).trim() === '[]', g2.text)
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
