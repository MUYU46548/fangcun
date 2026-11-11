#!/usr/bin/env node
/**
 * 运行态识别 e2e（2026-11-11 · 卡 task-20261017-002）
 *
 * 暮雨原话：「绒花墨坊十三次试跑都爆炸在 AI 根本分不清客户端和开发态上，
 * 后续方寸如果引入 Agent 模式，务必做好确认。不要让 AI 乱改源码。」
 *
 * 本套钉四件：
 *   ① 态靠**可读信号**判（isPackaged / 应用路径 / 可执行文件 / 数据目录），不是猜；
 *   ② 客户端态与开发态都能判出来，且各带一句“能不能动源码”的明确说法；
 *   ③ agent 在握手时就被告知当前态（initialize.instructions），并能用只读工具 `app_mode` 复查；
 *   ④ 结构守卫：MCP 层**没有任何写文件的调用**，“客户端态不许改源码”不是靠弹窗，是靠没有入口。
 *
 * 运行：node scripts/test/e2e-app-mode.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('app-mode-')
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
const electron = require(path.join(REPO, 'scripts', 'test', 'electron-stub.cjs'))
const modeMod = require(path.join(DIST, 'main', 'services', 'appMode.js'))
const tools = require(path.join(DIST, 'main', 'mcp', 'tools.js'))
const { handleMCPRequest } = require(path.join(DIST, 'main', 'mcp', 'handler.js'))
const gate = require(path.join(DIST, 'main', 'mcp', 'writeGate.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}
const mcpCall = (name, args) => {
  const r = tools.handleMCPToolCall(name, args || {}, { client: 'e2e' })
  let json = null
  try { json = JSON.parse(String((r && r.content && r.content[0] && r.content[0].text) || '')) } catch { /* not json */ }
  return { raw: r, text: String((r && r.content && r.content[0] && r.content[0].text) || ''), json, isError: !!(r && r.isError) }
}

console.log('== ① 开发态（stub：isPackaged=false，路径在 desktop/）==')
{
  const m = modeMod.detectAppMode()
  check('★★ 判成开发态', m.mode === 'dev', JSON.stringify({ mode: m.mode, packaged: m.packaged, appPath: m.appPath }))
  check('★★ 判断依据逐条摊开（4 条：isPackaged / 应用路径 / 可执行文件 / 数据目录）',
    Array.isArray(m.signals) && m.signals.length === 4 && m.signals[0].key === 'app.isPackaged',
    JSON.stringify(m.signals && m.signals.map((s) => s.key)))
  check('★★ 开发态明确要求“改源码前先说明”', /改源码前.*说明/.test(m.summary), m.summary)
  check('★ 数据目录也一起给出来（不是只报一句态）', m.dataDir === DATA, m.dataDir)
}

console.log('== ② 客户端态（模拟打包：isPackaged=true）==')
{
  electron.app.isPackaged = true
  const m = modeMod.detectAppMode()
  check('★★ 判成客户端态', m.mode === 'client', JSON.stringify({ mode: m.mode, packaged: m.packaged }))
  check('★★ 客户端态明确说“不能改源码”且指出要切态',
    /不能改源码/.test(m.summary) && /切到开发态/.test(m.summary), m.summary)
  check('★ 依据里如实写“是打包版”', m.signals.some((s) => s.key === 'app.isPackaged' && s.value === 'true'))

  // 握手就交底（这是“AI 一进门就知道”的唯一可靠时机）
  const init = handleMCPRequest({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e' } },
  })
  const ins = String(init && init.result && init.result.instructions || '')
  check('★★ initialize 里带当前态（客户端态）', /客户端态/.test(ins), ins.slice(0, 120))
  check('★★ 并明说不要尝试改源码', /没有\*\*改源码的入口|不要尝试修改/.test(ins), ins.slice(0, 200))
  check('★ 同时给出可复查的工具名 app_mode', /app_mode/.test(ins))
  electron.app.isPackaged = false
}

console.log('== ③ app_mode 是只读工具（只读档下也能查）==')
{
  gate.setWriteMode('read', 'e2e')
  const r = mcpCall('app_mode', {})
  check('★★ 只读档下 app_mode 仍可用（否则 agent 连“我在哪”都查不了）', r.isError === false, r.text.slice(0, 120))
  check('★★ 返回里有 mode / signals / codeWriteTools', !!r.json && !!r.json.mode
    && Array.isArray(r.json.signals) && Array.isArray(r.json.codeWriteTools), r.text.slice(0, 200))
  check('★★ codeWriteTools 恒为空（MCP 层没有写源码的口）',
    Array.isArray(r.json.codeWriteTools) && r.json.codeWriteTools.length === 0,
    JSON.stringify(r.json && r.json.codeWriteTools))
  gate.setWriteMode('write', 'e2e')
}

console.log('== ④ 结构守卫：没有入口，才谈得上“禁止” ==')
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const t = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/mcp/tools.ts'), 'utf-8'))
  const writeCalls = t.match(/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|copyFileSync|mkdirSync|createWriteStream)\s*\(/g) || []
  check('★★ MCP 工具层没有任何写文件调用（写数据全走 data 层 + 写入档位）',
    writeCalls.length === 0, writeCalls.join('、'))
  check('★★ 源码写白名单恒为空（新增即须登记并回答“客户端态怎么办”）',
    Array.isArray(modeMod.MCP_CODE_WRITE_TOOLS) && modeMod.MCP_CODE_WRITE_TOOLS.length === 0)
  const names = (tools.MCP_TOOLS || []).map((x) => x.name)
  check('★ 工具表里没有“写源码”类工具', !names.some((n) => /code|source|write_file|patch/i.test(n)), names.join(','))
  const ui = strip(fs.readFileSync(path.join(REPO, 'desktop/src/renderer/components/settings/DiagSettings.vue'), 'utf-8'))
  check('★★ 设置·诊断页真的把态与依据摆出来（不是只存在数据层）',
    /appMode\(/.test(ui) && /signals/.test(ui) && /运行态/.test(ui))
  const pre = strip(fs.readFileSync(path.join(REPO, 'desktop/src/preload/index.ts'), 'utf-8'))
  check('★ preload 暴露 appMode', /appMode:\s*\(\)\s*=>/.test(pre))
  const ipc = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/ipc.ts'), 'utf-8'))
  check('★ 主进程注册 app:mode', /guardedHandle\('app:mode'/.test(ipc))
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
