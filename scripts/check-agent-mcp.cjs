#!/usr/bin/env node
/**
 * 外部 agent ↔ 方寸 接入自检（2026-10-18）
 *
 * 用途：用户/agent 装完配置后，一条命令验证「这台机器上 Hermes / DSH 的方寸桥到底通不通」。
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
const lines = []
function ok(name, extra = '') { pass++; lines.push(`  ✅ ${name}${extra ? '  ' + extra : ''}`) }
function no(name, extra = '') { fail++; lines.push(`  ❌ ${name}${extra ? '  → ' + extra : ''}`) }

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

/** 从 DSH 的 cordis.patch.yml 里抠出 mcp-fangcun 的 command/args/env（格式固定，不引 yaml 依赖） */
function readDsh() {
  const p = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  if (!fs.existsSync(p)) return { found: false, path: p }
  const txt = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')
  const i = txt.indexOf('id: mcp-fangcun')
  if (i < 0) return { found: false, path: p, reason: '没有 mcp-fangcun 行' }
  const segLines = txt.slice(i, i + 1200).split('\n')
  const seg = segLines.join('\n')
  const cmd = /command:\s*(.+)$/m.exec(seg)
  const argsLine = /args:\s*\[(.+?)\]/m.exec(seg)
  const args = argsLine
    ? argsLine[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '').replace(/\\\\/g, '\\')).filter(Boolean)
    : []
  return {
    found: true, path: p,
    command: cmd ? cmd[1].trim().replace(/^["']|["']$/g, '').replace(/\\\\/g, '\\') : '',
    args,
    env: parseEnvFrom(segLines),
  }
}

/** 从 Hermes 的 config.yaml 里抠出 mcp_servers.fangcun */
function readHermes() {
  const p = path.join(os.homedir(), '.hermes', 'config.yaml')
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
    r5: replies[5], r6: replies[6],
  }
}

async function main() {
  console.log('== 外部 agent ↔ 方寸 接入自检 ==\n')

  const dsh = readDsh()
  const hermes = readHermes()

  for (const [name, cfg] of [['DSH', dsh], ['Hermes', hermes]]) {
    console.log(`── ${name}  ${cfg.path}`)
    if (!cfg.found) {
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
      }
    } else {
      no(`${name} 握手失败`, s.why)
    }
    console.log('')
  }

  console.log(lines.join('\n'))
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
