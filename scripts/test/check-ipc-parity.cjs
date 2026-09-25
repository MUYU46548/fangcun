#!/usr/bin/env node
/**
 * IPC 三方对账扫描器 —— 抓「僵尸按钮」
 *
 * 背景：方寸已出现三次同类事故——
 *   ① 备份按钮全僵尸（registerBackupIpcHandlers 未在真入口调用）
 *   ② loadNotes 未定义（渲染层调用 4 次，函数从未存在）
 *   ③ batchDelete 数据层函数不存在（渲染层在调，后端空白）
 * 根因是「UI 先行、后端跟进时漏项」，而 stub e2e 只测已实现的函数，抓不到。
 *
 * 本扫描器做四组对账：
 *   ① 僵尸按钮  渲染层调用 ∌ preload 暴露      → 前端 undefined，点了必报错
 *   ② 僵尸通道  preload 暴露 ∌ 主进程注册      → invoke 抛错/挂起
 *   ③ 未接线   主进程注册但文件不可从真入口到达 → 整块功能哑火（①②的病根）
 *   ④ 孤儿通道  主进程注册 ∌ preload 暴露      → 信息级（CLI/内部调用可能合法）
 *
 * 退出码：①②③ 任一非空 → 1（可进 e2e）。
 * 用法：node scripts/test/check-ipc-parity.cjs [--json]
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const SRC = path.join(DESKTOP, 'src')
const JSON_OUT = process.argv.includes('--json')

// ── 显式豁免名单 ──────────────────────────────────────────────────────
// 纪律：只允许「有意为之 + 写明原因」的项，禁止用它掩盖真 bug。
// 扫描器每次都会把豁免清单打印出来，避免被悄悄遗忘成永久红灯。
const EXEMPTIONS = {
  // 僵尸按钮：渲染层调用名
  zombieButtons: {},
  // 僵尸通道：channel 名
  // ⚠ 2026-09-22 更正原因：这 5 个不是「未接线」，而是**主→渲染方向的推送通道**。
  // preload 用 ipcRenderer.on 订阅，主进程用 webContents.send 推送；
  // 本扫描器只统计 handle/handleOnce/on 三种注册写法，看不到 send，故仍列为豁免项。
  zombieChannels: {
    'update:available': '主→渲染推送通道（webContents.send），非 invoke；扫描器不统计 send',
    'update:not-available': '主→渲染推送通道（webContents.send）',
    'update:progress': '主→渲染推送通道（webContents.send）',
    'update:downloaded': '主→渲染推送通道（webContents.send）',
    'update:error': '主→渲染推送通道（webContents.send）',
  },
  // 未接线模块：文件路径（相对仓库根，正斜杠）
  // ⚠ 2026-09-22：入口探测修正为 src/index.ts 后，updater.ts **已达可达集**
  // （真入口确实 import 并调用 initUpdater/registerUpdaterIpc），本豁免项不再触发。
  // 保留此条仅作记录：自动更新尚未配置 build.publish，initUpdater 会被 boot() 捕获并落日志。
  unwired: {
    'desktop/src/main/updater.ts':
      '（已不触发）自动更新已接线，但 build.publish 未配置 —— checkForUpdates() 会抛，' +
      '现由 src/index.ts 的 boot() 包住并写入应用日志，不再静默。',
  },
  // 孤儿通道：channel 名
  orphan: {
    detectEvents: '主进程内部/CLI 用，无渲染层入口',
  },
}

// ── 工具 ──────────────────────────────────────────────────────────────

/** 递归列出文件（跳过 node_modules / dist） */
function walk(dir, exts, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, exts, acc)
    else if (exts.some(x => e.name.endsWith(x))) acc.push(full)
  }
  return acc
}

/** 保守剥注释：保留字符串内容，只去 // 与 /* *\/ （逐字符扫描，跟踪字符串状态） */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
    if (c === '/' && c2 === '/') {                     // 行注释
      while (i < n && src[i] !== '\n') i++
    } else if (c === '/' && c2 === '*') {              // 块注释
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
    } else if (c === "'" || c === '"' || c === '`') {  // 字符串 / 模板串
      const q = c
      out += c; i++
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue }
        out += src[i]
        if (src[i] === q) { i++; break }
        i++
      }
    } else { out += c; i++ }
  }
  return out
}

const read = f => stripComments(fs.readFileSync(f, 'utf-8'))

// ── ① 渲染层调用面：window.tegula.X ────────────────────────────────────

function scanRendererCalls() {
  const calls = new Map()   // name -> [相对文件:行]
  for (const f of walk(path.join(SRC, 'renderer'), ['.vue', '.ts', '.js'])) {
    const lines = read(f).split(/\r?\n/)
    lines.forEach((ln, idx) => {
      const re = /window\s*\.\s*tegula\s*\.\s*([A-Za-z_$][\w$]*)/g
      let m
      while ((m = re.exec(ln))) {
        const where = `${path.relative(ROOT, f)}:${idx + 1}`
        if (!calls.has(m[1])) calls.set(m[1], [])
        calls.get(m[1]).push(where)
      }
    })
  }
  return calls
}

// ── ② preload 暴露面 ─────────────────────────────────────────────────

function scanPreload() {
  const file = path.join(SRC, 'preload', 'index.ts')
  if (!fs.existsSync(file)) return { keys: new Map(), file, missing: true }
  const src = read(file)

  const head = src.indexOf('exposeInMainWorld')
  if (head < 0) return { keys: new Map(), file, missing: true }

  // 定位暴露的对象字面量的第一个 '{'
  let i = src.indexOf('{', head)
  if (i < 0) return { keys: new Map(), file, missing: true }

  const keys = new Map()  // key -> channel|null
  let depth = 0
  let atTop = false
  let pendingKey = null
  let segStart = -1

  const flush = (endIdx) => {
    if (pendingKey && segStart >= 0) {
      const seg = src.slice(segStart, endIdx)
      const ch = seg.match(/ipcRenderer\s*\.\s*(?:invoke|send|on|once|sendSync)\s*\(\s*['"`]([^'"`]+)['"`]/)
      keys.set(pendingKey, ch ? ch[1] : null)
    }
    pendingKey = null
    segStart = -1
  }

  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) { flush(i); break }
    }
    if (!atTop) { if (depth >= 1) atTop = true; continue }
    if (depth !== 1) continue

    // 顶层 key 形式：ident: / 'a:b': / "a": / 裸 ident,
    const rest = src.slice(i)
    const mk = rest.match(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(,|:)/)
    if (mk) {
      const afterKey = i + mk[0].length
      const key = mk[1] || mk[2] || mk[3]
      const isShorthand = mk[4] === ','
      // 避免把 `=>` 后的参数、对象属性误判：仅当处于段起点
      if (pendingKey !== null) flush(i)
      pendingKey = key
      segStart = afterKey
      i = afterKey - 1
      if (isShorthand) { flush(i + 1); pendingKey = null }
      continue
    }
    // 段结束（顶层逗号）
    if (c === ',' && pendingKey) flush(i)
  }
  flush(src.length)
  return { keys, file, missing: false }
}

// ── ③④ 主进程注册面 ──────────────────────────────────────────────────

function scanMainRegistrations() {
  const regs = new Map()   // channel -> [相对文件:行]
  for (const f of walk(path.join(SRC, 'main'), ['.ts'])) {
    const lines = read(f).split(/\r?\n/)
    lines.forEach((ln, idx) => {
      // ⚠ 2026-09-22：主进程统一改用 guardedHandle（见 main/guarded-ipc.ts，
      // 为 IPC 失败落日志）。只认 ipcMain.handle 会把它认成"全部僵尸通道"，
      // 所以两种写法都要认。
      const re = /(?:ipcMain\s*\.\s*(?:handle|handleOnce|on)|\bguardedHandle)\s*\(\s*['"`]([^'"`]+)['"`]/g
      let m
      while ((m = re.exec(ln))) {
        const where = `${path.relative(ROOT, f)}:${idx + 1}`
        if (!regs.has(m[1])) regs.set(m[1], [])
        regs.get(m[1]).push(where)
      }
    })
  }
  return regs
}

/**
 * 从 package.json main（dist/index.js）反推源码入口，并求 import 可达集。
 *
 * ⚠ 2026-09-22 修正：tsconfig.main.json 的 rootDir 是 ./src，
 * 所以 `dist/index.js` ← `src/index.ts`（真入口）。
 * 2026-09-25：`src/main/index.ts` 这个**从不被加载的假入口已删除**（它曾让备份 IPC 全成僵尸，
 * 还每次构建都往 dist/main/index.js 塞一份死代码）。下面第二个候选保留只为兼容旧检出，
 * 文件不存在时会自动落到真入口。
 */
function scanReachable() {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf-8'))
  const base = path.basename(pkg.main || 'dist/index.js').replace(/\.js$/, '.ts')
  const candidates = [
    path.join(SRC, base),                 // src/index.ts      ← 真入口
    path.join(SRC, 'main', base),         // src/main/index.ts ← 历史假入口
  ]
  const entry = candidates.find(c => fs.existsSync(c)) || candidates[1]

  const reachable = new Set()
  const queue = [entry]
  const resolve = (from, spec) => {
    if (!spec.startsWith('.')) return null
    const base = path.resolve(path.dirname(from), spec)
    for (const cand of [base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
      if (fs.existsSync(cand)) return cand
    }
    return null
  }
  while (queue.length) {
    const f = queue.pop()
    if (!f || reachable.has(f) || !fs.existsSync(f)) continue
    reachable.add(f)
    const src = read(f)
    const importRe = /(?:from|require\s*\()\s*['"]([^'"]+)['"]/g
    let m
    while ((m = importRe.exec(src))) {
      const r = resolve(f, m[1])
      if (r && !reachable.has(r)) queue.push(r)
    }
  }
  return { entry, reachable }
}

// ── 对账 ─────────────────────────────────────────────────────────────

function main() {
  const calls = scanRendererCalls()
  const { keys: exposed, file: preloadFile, missing: noPreload } = scanPreload()
  const regs = scanMainRegistrations()
  const { entry, reachable } = scanReachable()

  const norm = (rel) => rel.replace(/\\/g, '/')
  const exempted = { buttons: [], channels: [], unwired: [], orphan: [] }

  const zombieButtons = []   // ① 调用 ∌ 暴露
  for (const [name, where] of calls) {
    if (exposed.has(name)) continue
    if (EXEMPTIONS.zombieButtons[name]) { exempted.buttons.push({ name, reason: EXEMPTIONS.zombieButtons[name] }); continue }
    zombieButtons.push({ name, where })
  }

  const zombieChannels = []  // ② 暴露 ∌ 注册
  for (const [name, ch] of exposed) {
    if (!ch || regs.has(ch)) continue
    if (EXEMPTIONS.zombieChannels[ch]) { exempted.channels.push({ channel: ch, reason: EXEMPTIONS.zombieChannels[ch] }); continue }
    zombieChannels.push({ name, channel: ch })
  }

  // ③ 注册了但所在文件不可从真入口到达
  const unwired = []
  for (const [ch, where] of regs) {
    const files = [...new Set(where.map(w => w.split(':')[0]))]
    const unreachable = files.filter(rel => !reachable.has(path.resolve(ROOT, rel)))
    if (!unreachable.length || unreachable.length !== files.length) continue
    for (const rel of unreachable) {
      const key = norm(rel)
      if (EXEMPTIONS.unwired[key]) exempted.unwired.push({ file: key, channel: ch, reason: EXEMPTIONS.unwired[key] })
    }
    const real = unreachable.filter(rel => !EXEMPTIONS.unwired[norm(rel)])
    if (real.length) unwired.push({ channel: ch, files: real })
  }

  const orphan = []          // ④ 注册 ∌ 暴露
  const exposedChannels = new Set([...exposed.values()].filter(Boolean))
  for (const [ch, where] of regs) {
    if (exposedChannels.has(ch)) continue
    if (EXEMPTIONS.orphan[ch]) { exempted.orphan.push({ channel: ch, reason: EXEMPTIONS.orphan[ch] }); continue }
    orphan.push({ channel: ch, where: where[0] })
  }

  const result = {
    counts: {
      rendererCalls: calls.size,
      preloadKeys: exposed.size,
      mainChannels: regs.size,
      reachableFiles: reachable.size,
    },
    zombieButtons, zombieChannels, unwired, orphan, exempted,
  }

  if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); }

  let pass = 0, fail = 0
  const ok = (m) => { pass++; console.log(`PASS  ${m}`) }
  const bad = (m) => { fail++; console.log(`FAIL  ${m}`) }

  console.log('---- IPC 三方对账 ----')
  console.log(`入口: ${path.relative(ROOT, entry)}（可达 ${reachable.size} 个主进程文件）`)
  console.log(`面：渲染层调用 ${calls.size} · preload 暴露 ${exposed.size} · 主进程注册 ${regs.size}`)

  if (noPreload) { bad(`preload 文件不可解析: ${path.relative(ROOT, preloadFile)}`) }

  // ①
  if (zombieButtons.length === 0) ok('① 无僵尸按钮（渲染层每个调用都在 preload 有条目）')
  else zombieButtons.forEach(z => bad(`① 僵尸按钮 window.tegula.${z.name} —— preload 未暴露（${z.where[0]}${z.where.length > 1 ? ` 等 ${z.where.length} 处` : ''}）`))

  // ②
  if (zombieChannels.length === 0) ok('② 无僵尸通道（preload 每个 channel 都有主进程 handler）')
  else zombieChannels.forEach(z => bad(`② 僵尸通道 ${z.channel} —— 主进程未注册 handler（preload.${z.name}）`))

  // ③
  if (unwired.length === 0) ok('③ 无未接线模块（所有注册文件都能从真入口到达）')
  else {
    const byFile = new Map()
    for (const u of unwired) {
      const f = u.files[0]
      if (!byFile.has(f)) byFile.set(f, [])
      byFile.get(f).push(u.channel)
    }
    for (const [f, chs] of byFile) {
      bad(`③ 未接线模块 ${f} —— 注册了 ${chs.length} 个 channel 但真入口不可达（如 ${chs.slice(0, 3).join(', ')}${chs.length > 3 ? ' …' : ''}）`)
    }
  }

  // ④ 仅信息
  if (orphan.length === 0) pass++, console.log('PASS  ④ 无孤儿通道')
  else {
    pass++
    console.log(`INFO  ④ ${orphan.length} 个孤儿通道（主进程注册但 preload 未暴露，CLI/内部使用可能合法）`)
    orphan.slice(0, 8).forEach(o => console.log(`        · ${o.channel}  ← ${o.where}`))
    if (orphan.length > 8) console.log(`        … 另有 ${orphan.length - 8} 个`)
  }

  // 豁免清单：每次都打印，防止"豁免"变成永久红灯的遮羞布
  const exemptTotal = Object.values(exempted).reduce((a, b) => a + b.length, 0)
  if (exemptTotal > 0) {
    console.log('')
    console.log(`豁免 ${exemptTotal} 项（有意为之，非缺陷）：`)
    const uniqFiles = [...new Set(exempted.unwired.map(x => x.file))]
    for (const f of uniqFiles) console.log(`  · [未接线] ${f} —— ${EXEMPTIONS.unwired[f]}`)
    const uniqCh = [...new Set(exempted.channels.map(x => x.channel))]
    if (uniqCh.length) console.log(`  · [僵尸通道] ${uniqCh.join(', ')} —— ${exempted.channels[0].reason}`)
    const uniqBtn = [...new Set(exempted.buttons.map(x => x.name))]
    if (uniqBtn.length) console.log(`  · [僵尸按钮] ${uniqBtn.join(', ')}`)
    if (exempted.orphan.length) console.log(`  · [孤儿通道] ${exempted.orphan.map(x => x.channel).join(', ')}`)
  }

  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail === 0) console.log('三方对账一致。')
  process.exit(fail === 0 ? 0 : 1)
}

main()
