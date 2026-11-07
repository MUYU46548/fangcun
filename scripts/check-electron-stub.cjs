#!/usr/bin/env node
/**
 * 测试桩对账：`scripts/test/electron-stub.cjs` 与真身（electron.d.ts）之间，
 * **主进程代码用到的每一个成员，桩里都得有**。
 *
 * 为什么要有它（盘点工程债 #8）：
 *   2026-11-06 `skillInstaller.autoCheckSkills()` 要写 `app.getVersion()`，桩里没有 →
 *   `e2e-agent-targets` 直接 TypeError **崩在"测试自身异常"**，整份测试一条断言都没跑。
 *   那种"看起来绿了 / 或者红得莫名其妙"的亏已经吃过多次，病的根子是**桩靠人记着同步**。
 *
 * 判据（只报真阳性）：
 *   ① 从 `desktop/src/main/**` 扫出 `<模块>.<成员>` 的实际用法；
 *   ② 成员在真身 d.ts 里有、桩里没有 → **红**（就是 getVersion 那类）；
 *   ③ 真身 d.ts 里也找不到 → 只提示（可能是扫描误命中，也可能是源码打错字），不判红；
 *   ④ 明确不加载的入口 / 不该进测试的模块 → `ALLOW` 登记 **原因**，逐条打印（硬约束③：显式跳过 + 打印原因）。
 *
 * 用法：node scripts/check-electron-stub.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC_MAIN = path.join(ROOT, 'desktop', 'src', 'main')
const DTS = path.join(ROOT, 'desktop', 'node_modules', 'electron', 'electron.d.ts')

/** 桩里已有的模块 → 真身 d.ts 里的声明名 */
const WATCH = {
  app: 'App',
  safeStorage: 'SafeStorage',
  BrowserWindow: 'BrowserWindow',
  Notification: 'Notification',
  shell: 'Shell',
  ipcMain: 'IpcMain',
  powerMonitor: 'PowerMonitor',
  dialog: 'Dialog',
}

/**
 * 显式豁免：桩里没有、但测试本来就不该加载的东西。
 * ⚠ 每条都要写**为什么**，不许只写名字（否则豁免池会变成垃圾桶）。
 */
const ALLOW = {
  'app.whenReady': '只在 desktop/src/index.ts 的启动链里用；e2e 从不加载真入口（那是 GUI 启动）',
  'app.on': '同上：入口装事件监听，测试里由夹具自己驱动',
  'app.quit': '同上：入口退出逻辑',
  'app.requestSingleInstanceLock': '同上：单实例锁，只在入口',
  'app.setAppUserModelId': '同上：Windows 通知身份，只在入口',
  'app.disableHardwareAcceleration': '同上：入口启动参数',
  'app.commandLine': '同上：入口启动参数',
  'app.whenReadySync': '不存在的方法名占位（防有人把 whenReady 写成同步版）',
  'dialog.showMessageBox': '主进程确认框由真机验；测试里脚本化返回值没有意义（会变成"测桩"）',
  'dialog.showMessageBoxSync': '同上',
  'dialog.showSaveDialog': '同上',
}

/** 逐行读源码（CRLF 本机别踩：统一成 \n 再处理） */
function readText(p) {
  return fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')
}

/** 去掉注释（保留字符串原样）—— 注释里写 `app.asar`、`dialog.showOpenDialog` 会把对账吵成噪音。
 *  按字符走一遍、跟踪引号，比正则可靠（正则会把 'https://…' 里的 // 当注释）。 */
function stripComments(text) {
  let out = ''
  let i = 0
  let q = ''       // 当前字符串引号
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (q) {
      out += c
      if (c === '\\') { out += text[i + 1] || ''; i += 2; continue }
      if (c === q) q = ''
      i++
      continue
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n'   // 保住行号
        i++
      }
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') q = c
    out += c
    i++
  }
  return out
}

/** 递归收集 main 下的 ts */
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** 从 d.ts 里抠某个 interface/class 的成员名（够用即可：只用来判"真身有没有"） */
function realMembers(declName) {
  const src = readText(DTS)
  // 声明可能是 `interface App extends … {` / `class BrowserWindow extends … {` / `namespace Shell {`
  const re = new RegExp(`(?:interface|class|namespace)\\s+${declName}\\b[^{]*\\{`, 'g')
  const m = re.exec(src)
  if (!m) return null
  // 花括号配平，取出整块
  let i = m.index + m[0].length
  let depth = 1
  const start = i
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  const body = src.slice(start, i - 1)
  const names = new Set()
  // 成员声明：行首缩进 + 名字 + ( 或 : 或 <
  for (const line of body.split('\n')) {
    const mm = /^\s{2,}(?:readonly\s+|static\s+)?([A-Za-z_$][\w$]*)\s*(?:[?]?\s*[(<:]|\s*[?]?\s*$)/.exec(line)
    if (mm) names.add(mm[1])
  }
  return names
}

function main() {
  if (!fs.existsSync(DTS)) {
    console.log(`⚠ 没有 electron.d.ts（${DTS}）—— 没装依赖就跳过对账（这不等于通过）`)
    process.exit(0)
  }
  const stub = require(path.join(__dirname, 'test', 'electron-stub.cjs'))

  const files = walk(SRC_MAIN)
  console.log(`扫描 ${files.length} 个主进程源码文件，对账 ${Object.keys(WATCH).length} 个模块\n`)

  const used = new Map() // 'app.getVersion' → [file:line]
  for (const f of files) {
    const text = stripComments(readText(f))
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    for (const mod of Object.keys(WATCH)) {
      // 只扫真的从 electron 引入过这个模块的文件，避免 `dialog.calls` 之类的假命中
      const imported = new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${mod}\\b[^}]*\\}\\s+from\\s+'electron'`).test(text)
      if (!imported) continue
      const re = new RegExp(`\\b${mod}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')
      let m
      while ((m = re.exec(text))) {
        // 剔除 `'…app.asar/dist…'` 这类**字符串里的路径**（asar 就被这么误命中过）：
        // 成员名后面紧跟 `/` 或前面是引号，基本可判为路径而非 API 调用
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1)
        const before = text.slice(Math.max(0, m.index - 1), m.index)
        if (after === '/' || /["'`]/.test(before)) continue
        const key = `${mod}.${m[1]}`
        const line = text.slice(0, m.index).split('\n').length
        if (!used.has(key)) used.set(key, [])
        used.get(key).push(`${rel}:${line}`)
      }
    }
  }

  const stubKeys = Object.keys(stub)
  const red = []
  const allowHit = []
  const unknown = []
  const ok = []

  for (const [key, where] of [...used.entries()].sort()) {
    const [mod, member] = key.split('.')
    const holder = stub[mod]
    const inStub = holder != null && (member in holder || typeof holder[member] === 'function')
    if (inStub) { ok.push(key); continue }
    if (ALLOW[key]) { allowHit.push([key, where]); continue }
    const real = realMembers(WATCH[mod])
    if (real && real.has(member)) red.push([key, where])
    else unknown.push([key, where])
  }

  // 桩里有、但源码没人用的模块（提示即可：可能是历史遗留，别急着删）
  const unusedMods = Object.keys(WATCH).filter((m) => stubKeys.includes(m) && ![...used.keys()].some((k) => k.startsWith(m + '.')))

  console.log(`✓ 桩已覆盖：${ok.length} 处用法`)
  if (allowHit.length) {
    console.log(`\n— 显式豁免（${allowHit.length}，每条都写了原因，不是静默跳过）：`)
    for (const [k, where] of allowHit) console.log(`  · ${k}  —— ${ALLOW[k]}\n      用在 ${where.slice(0, 3).join(', ')}${where.length > 3 ? ` 等 ${where.length} 处` : ''}`)
  }
  if (unknown.length) {
    console.log(`\n? 真身 d.ts 里也没找到（只提示，不判红 —— 可能是我扫错了，也可能是源码打错字）：`)
    for (const [k, where] of unknown) console.log(`  · ${k}  @ ${where.slice(0, 2).join(', ')}`)
  }
  if (unusedMods.length) {
    console.log(`\n· 桩里有但主进程没用到：${unusedMods.join(', ')}（留着无害，别当成"必须删"）`)
  }

  if (red.length) {
    console.log(`\n✗ 真身有、桩没有 —— 这些方法一被调用，测试就崩在"测试自身异常"，等于那批功能没被测到：`)
    for (const [k, where] of red) console.log(`  · ${k}  用在 ${where.slice(0, 3).join(', ')}${where.length > 3 ? ` 等 ${where.length} 处` : ''}`)
    console.log(`\n修：给 scripts/test/electron-stub.cjs 补上这些成员；补不了的写进本文件的 ALLOW 并说明原因。`)
    process.exit(1)
  }
  console.log('\n桩与真身对账通过（源码用到的成员桩里都有）。')
}

main()
