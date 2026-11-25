#!/usr/bin/env node
/**
 * 外部 agent ↔ 方寸 接入自检（2026-10-18）
 *
 * 用途：用户/agent 装完配置后，一条命令验证“这台机器上 Hermes / DSH 的方寸桥到底通不通”。
 * 它**读两家真实配置文件**取 command/args（不是照着代码猜），然后像客户端那样 spawn、握手、
 * 列工具、真写一张卡再删掉（写侧闭环），最后打印结果。
 *
 * 运行：node scripts/check-agent-mcp.cjs           # 全量（含写侧）
 *      node scripts/check-agent-mcp.cjs --readonly # 只读（不建卡）
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

const READONLY = process.argv.includes('--readonly')
const DESKTOP = path.resolve(__dirname, '../desktop')

let pass = 0
let fail = 0
/** 弱支持提示数（Hermes 那类：没配不算故障，不进 fail） */
let soft = 0
const lines = []
function ok(name, extra = '') { pass++; lines.push(`  ✅ ${name}${extra ? '  ' + extra : ''}`) }
function no(name, extra = '') { fail++; lines.push(`  ❌ ${name}${extra ? '  → ' + extra : ''}`) }
/**
 * 弱支持项：只提示，**不计失败**（2026-11-25 暮雨口径）。
 *
 * 「Hermes 可以接方寸，而且已经接了，以后是弱支持，偶尔维护，不保证可用性。
 *   DSH 那条和 Hermes 完全搭不上边。」
 *
 * 所以 Hermes 没配好**不是故障**，不该让这条自检变红 —— 以前它走 `no()`，
 * 于是用户看到一片 ❌ 会以为方寸坏了，其实主通道（DSH）好好的。
 */
function weak(name, extra = '') { soft++; lines.push(`  ⚠️ ${name}${extra ? '  ' + extra : ''}`) }

/** 解析 `env:` 块（缩进大于 env 行的 `KEY: "VAL"` 行） */
function parseEnvFrom(lines) {
  const out = {}
  const i = lines.findIndex(l => /^\s*env:\s*$/.test(l))
  if (i < 0) return out
  const baseIndent = lines[i].search(/\S/)
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k]
    if (!l.trim()) continue
    const ind = l.search(/\S/)
    if (ind <= baseIndent) break
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(l)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * 读 DSH 的 cordis.patch.yml 里 mcp-fangcun 的 command/args/env。
 *
 * 2026-11-08 修（联测 P0-2）：此前用正则 `command:\s*(.+)$` 抠，遇到**折行**的 YAML
 * （编辑器按 88 列折断是正常产物）就只截到 `…dist\ele` → 报“文件不存在 + 握手必失败”，
 * 而那两个路径其实都在（用 PyYAML 正式解析可证）。假红出现在**排查主入口**上，最坏。
 * 现在改用 js-yaml（桌面端已有该依赖），找不到依赖就明说 SKIP，不猜。
 */
function loadYaml() {
  const cands = [path.join(DESKTOP, 'node_modules', 'js-yaml'), 'js-yaml']
  for (const c of cands) {
    try { return require(c) } catch { /* 下一个 */ }
  }
  return null
}

/** 在任意嵌套结构里找 `id: mcp-fangcun` 的那一项 */
function findById(node, id, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null
  if (Array.isArray(node)) {
    for (const it of node) { const r = findById(it, id, depth + 1); if (r) return r }
    return null
  }
  if (node.id === id) return node
  for (const k of Object.keys(node)) {
    const r = findById(node[k], id, depth + 1)
    if (r) return r
  }
  return null
}

function readDsh() {
  const p = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  if (!fs.existsSync(p)) return { found: false, path: p }
  const yaml = loadYaml()
  if (!yaml) {
    return { found: false, path: p, reason: '没装 js-yaml（desktop/node_modules 里也没有），无法可靠解析折行 YAML —— 这是 SKIP，不是配置错' }
  }
  let doc
  try {
    doc = yaml.load(fs.readFileSync(p, 'utf-8'))
  } catch (e) {
    return { found: false, path: p, reason: `YAML 解析失败：${e.message}` }
  }
  const entry = findById(doc, 'mcp-fangcun')
  if (!entry) {
    // 2026-11-22：DSH 现在走**插件**（dsh-fangcun，插件工具直接由 DSH 提供），
    // 不再配 MCP。旧诊断只认 mcp-fangcun，于是把"插件已接、MCP 没配"报成
    // ❌「DSH 未配置方寸」—— 假红，而且出现在排查主入口上。
    // 插件在场就如实报"走插件"，不再要求 MCP 条目。
    const pluginPkg = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-fangcun', 'package.json')
    if (fs.existsSync(pluginPkg)) {
      let ver = ''
      try { ver = JSON.parse(fs.readFileSync(pluginPkg, 'utf-8')).version || '' } catch { /* 版本读不到不挡检测 */ }
      return {
        found: false, plugin: true, pluginVersion: ver, path: p,
        reason: `走插件 dsh-fangcun${ver ? ' v' + ver : ''}（DSH 侧不配 MCP 是正常的）`,
      }
    }
    return { found: false, path: p, reason: '解析后没有 id: mcp-fangcun 的条目，也没找到 dsh-fangcun 插件' }
  }
  const cfg = entry.config || {}
  const env = cfg.env && typeof cfg.env === 'object' ? Object.fromEntries(
    Object.entries(cfg.env).map(([k, v]) => [k, String(v)])
  ) : {}
  return {
    found: true, path: p,
    command: String(cfg.command || ''),
    args: Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [],
    env,
  }
}

/** Hermes 的 home：HERMES_HOME → %LOCALAPPDATA%\hermes → ~/.hermes（2026-10-31 修，见 mcpConnect.ts） */
function hermesHome() {
  const env = String(process.env.HERMES_HOME || '').trim()
  if (env) return env
  const la = String(process.env.LOCALAPPDATA || '').trim()
  if (la) {
    const p = path.join(la, 'hermes')
    if (fs.existsSync(p)) return p
  }
  return path.join(os.homedir(), '.hermes')
}

/** 从 Hermes 的 config.yaml 里抠出 mcp_servers.fangcun */
function readHermes() {
  const p = path.join(hermesHome(), 'config.yaml')
  if (!fs.existsSync(p)) return { found: false, path: p }
  const txt = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')
  // 取 `mcp_servers:` 段：从它开始，到下一个**顶格**键（或文件尾）
  const start = txt.search(/^mcp_servers:\s*$/m)
  if (start < 0) return { found: false, path: p, reason: '没有 mcp_servers 段' }
  const after = txt.slice(start).split('\n').slice(1)
  const segLines = []
  for (const l of after) {
    if (/^\S/.test(l) && l.trim()) break   // 顶格 = 下一个键
    segLines.push(l)
  }
  const seg = segLines.join('\n')
  if (!/^\s+fangcun:\s*$/m.test(seg)) return { found: false, path: p, reason: 'mcp_servers 里没有 fangcun' }
  const fLines = seg.slice(seg.search(/^\s+fangcun:\s*$/m)).split('\n')
  const fseg = fLines.join('\n')
  const cmd = /command:\s*(.+)$/m.exec(fseg)
  const args = []
  const ai = fLines.findIndex(l => /^\s+args:\s*$/.test(l))
  if (ai >= 0) {
    for (const l of fLines.slice(ai + 1)) {
      const mm = /^\s*-\s+(.+)$/.exec(l)
      if (!mm) break
      args.push(mm[1].trim().replace(/^["']|["']$/g, ''))
    }
  }
  return {
    found: true, path: p,
    command: cmd ? cmd[1].trim().replace(/^["']|["']$/g, '') : '',
    args,
    env: parseEnvFrom(fLines),
  }
}

/** 跑一次完整客户端流程，返回结果 */
function handshake(command, args, label, extraEnv) {
  return new Promise((resolve) => {
    const events = []
    let child
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // 配置里的 env 原样带上（ELECTRON_RUN_AS_NODE=1 决定方寸是以纯 node 还是 GUI 模式启动）
        env: { ...process.env, ...(extraEnv || {}) },
      })
    } catch (e) {
      resolve({ ok: false, why: `spawn 抛错：${e.message}`, events })
      return
    }
    let out = ''
    let err = ''
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n') } catch {} }

    // 写侧闭环：create 拿到 id 后立刻 delete（删到回收站），脚本结束再把回收站里这条清掉
    let createdId = ''
    child.stdout.on('data', d => {
      out += d.toString('utf-8')
      for (const l of out.split('\n')) {
        const t = l.trim()
        if (!t || !t.startsWith('{')) continue
        let o
        try { o = JSON.parse(t) } catch { continue }
        if (o.id === 5 && !createdId) {
          const txt = o.result && o.result.content && o.result.content[0] ? o.result.content[0].text : ''
          const m = /"id":\s*"([^"]+)"/.exec(txt || '')
          if (m) { createdId = m[1]; send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'delete_task', arguments: { id: createdId } } }) }
        }
      }
    })
    child.stderr.on('data', d => { err += d.toString('utf-8') })
    child.on('error', e => { events.push('spawn-error:' + e.message) })

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: label, version: '1' } } })
    setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 300)
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'ping' }), 500)
    setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), 700)
    setTimeout(() => send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_data_dir', arguments: {} } }), 900)
    if (!READONLY) {
      const title = `[自检] MCP 接入验证 ${label} ${new Date().toISOString()}`
      setTimeout(() => send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_task', arguments: { title, project: 'fangcun-base', body: 'check-agent-mcp 自动创建，本脚本会立即删除。' } } }), 1100)
    }

    setTimeout(() => {
      try { child.kill() } catch {}
      const replies = {}
      for (const l of out.split('\n')) {
        const t = l.trim()
        if (!t) continue
        try { const o = JSON.parse(t); if (o.id !== undefined) replies[o.id] = o } catch { events.push('bad-line:' + t.slice(0, 60)) }
      }
      resolve({ ok: true, replies, err, events, createdId })
    }, 2600)
  })
}

function summarize(r) {
  if (!r.ok) return { ok: false, why: r.why }
  const { replies, err } = r
  const problems = []
  if (!replies[1] || !replies[1].result) problems.push('initialize 无响应')
  if (!replies[2] || !replies[2].result) problems.push('ping 无响应')
  if (!replies[3] || !replies[3].result || !Array.isArray(replies[3].result.tools)) problems.push('tools/list 无工具')
  const dirText = replies[4] && replies[4].result && replies[4].result.content && replies[4].result.content[0]
    ? replies[4].result.content[0].text : ''
  if (!dirText) problems.push('get_data_dir 无返回')
  return {
    ok: problems.length === 0,
    why: problems.join('；') || (err ? err.split('\n')[0] : ''),
    tools: replies[3] && replies[3].result ? replies[3].result.tools.length : 0,
    dataDir: dirText,
    createdId: r.createdId,
    r5: replies[5], r6: replies[6],
  }
}

/**
 * 自检卡本地收拾（2026-11-11 写口闸之后需要）。
 *
 * 为什么不能只靠 `delete_task`：2026-11-11 起 MCP 写口分三档，「删卡」属于破坏性，
 * 默认「读写」档会**拒绝**——那是闸在正常工作，不是接入坏了。但自检脚本不该在用户看板上
 * 留一张垃圾卡，所以这里由**本地脚本**（不是 agent）把它移进回收站，与 delete_task 同一落点。
 */
function localTrash(dataDir, id) {
  if (!dataDir || !id) return false
  try {
    const td = path.join(String(dataDir).trim(), 'task-data')
    const src = path.join(td, id + '.md')
    if (!fs.existsSync(src)) return false
    const trash = path.join(td, '.trash')
    fs.mkdirSync(trash, { recursive: true })
    const dest = path.join(trash, path.basename(src))
    if (fs.existsSync(dest)) fs.unlinkSync(src)
    else fs.renameSync(src, dest)
    return true
  } catch {
    return false
  }
}

async function main() {
  console.log('== 外部 agent ↔ 方寸 接入自检 ==\n')

  const dsh = readDsh()
  const hermes = readHermes()

  for (const [name, cfg] of [['DSH', dsh], ['Hermes', hermes]]) {
    console.log(`── ${name}  ${cfg.path}`)
    if (!cfg.found) {
      if (cfg.plugin) {
        // 插件路线：不配 MCP 是正常形态，不是失败。
        ok(`DSH 走插件${cfg.pluginVersion ? ' v' + cfg.pluginVersion : ''}（不配 MCP 是正常的）`, cfg.reason)
        console.log('')
        continue
      }
      if (name === 'Hermes') {
        // 弱支持：已接、偶尔维护、不保证可用（2026-11-25 暮雨口径）。没配**不是故障**。
        weak('Hermes 未配置方寸（弱支持，不算故障 —— 主通道是 DSH，两条互不相干）',
          cfg.reason || '配置文件里找不到')
        console.log('')
        continue
      }
      no(`${name} 未配置方寸`, cfg.reason || '配置文件里找不到')
      console.log('')
      continue
    }
    if (!cfg.command) { no(`${name} 配置缺 command`); console.log(''); continue }
    const exeOk = fs.existsSync(cfg.command)
    if (!exeOk) no(`${name} 的 command 指向的文件不存在`, cfg.command)
    else ok(`${name} command 存在`, cfg.command)
    console.log(`      args: ${JSON.stringify(cfg.args)}`)
    console.log(`      env : ${JSON.stringify(cfg.env || {})}`)

    const s = summarize(await handshake(cfg.command, cfg.args, name, cfg.env))
    if (s.ok) {
      ok(`${name} 握手通过（${s.tools} 个工具）`, `数据根 ${s.dataDir}`)
      if (!READONLY) {
        const created = s.r5 && s.r5.result && s.r5.result.content && s.r5.result.content[0]
          ? s.r5.result.content[0].text : ''
        if (created && /"ok":\s*true/.test(created)) ok(`${name} 写侧：create_task 成功`)
        else no(`${name} 写侧：create_task 失败`, (created || '').slice(0, 120))
        // 写侧留痕（2026-11-11）：MCP 写入档位决定“删卡”能不能走。
        // 被闸拦下 = 闸生效（默认「读写」档不含破坏性），不是接入坏了 —— 但要如实说出来，
        // 并且由本地脚本把自检卡收进回收站（不留在用户看板上）。
        const del = s.r6 && s.r6.result && s.r6.result.content && s.r6.result.content[0]
          ? s.r6.result.content[0].text : ''
        if (s.createdId) {
          if (/"ok":\s*true/.test(del || '')) {
            ok(`${name} 写侧：自检卡已删除（进回收站）`)
          } else {
            const why = (/只读|破坏性/.test(del || '')) ? 'MCP 写入档位不含破坏性（闸生效）' : '删除失败'
            const trashed = localTrash(s.dataDir, s.createdId)
            ok(`${name} 写侧：delete_task 被拦（${why}）${trashed ? '，自检卡已由本地脚本移入回收站' : '，自检卡 ' + s.createdId + ' 需手动清理'}`)
          }
        }
      }
    } else {
      no(`${name} 握手失败`, s.why)
    }
    console.log('')
  }

  console.log(lines.join('\n'))
  console.log(`\n通过 ${pass} / 失败 ${fail}` + (soft ? ` / 弱支持提示 ${soft}（不计失败）` : ''))
  if (soft) {
    console.log('⚠ Hermes 是弱支持通道（2026-11-25 口径）：已接、偶尔维护、不保证可用。'
      + '它没配好不影响 DSH —— 两条通道互不相干。')
  }
  process.exit(fail ? 1 : 0)
}

main()
