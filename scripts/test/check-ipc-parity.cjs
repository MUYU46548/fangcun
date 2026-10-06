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
 * 用法：node scripts/test/check-ipc-parity.cjs [--json] [--all]
 *        --all 把 ④ 孤儿通道 / ⑤ 死通道的清单**全部列出**（默认各只列前 12 条）——
 *        「死通道」那份清单是用来圈选要不要删的，只给 12 条没法用。
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
  // 死通道（第 ⑤ 类，2026-10-06 卡 004 新增）：preload 暴露 + 主进程注册，
  // 但渲染层从不调用。⚠ 只当**信息**报，不当缺陷 —— 「渲染层不调」可能是合法的
  // （留给 e2e / 数据迁移 / 未来版本的兼容口）。要红灯的请在此登记明确理由。
  dead: {},
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
    // ⚠ 2026-10-06（卡 004）修正：原正则只认 `window.tegula.X`，**漏掉 `(window as any).tegula.X`**
    //   —— 而渲染层大量使用后者（带 `?.` 的容错写法，如 `(window as any).tegula?.prefsSet?.()`）。
    //   后果：用这种写法调一个 preload 没暴露的 API，本扫描器**完全看不见** —— 第 ① 类有盲区。
    //   先把两种写法与可选链归一成统一形状再匹配（替换不跨行，行号仍准）。
    const src = read(f)
      .replace(/\(\s*window\s+as\s+any\s*\)\s*\.\s*tegula/g, 'window.tegula')
      .replace(/window\s*\.\s*tegula\s*\?\./g, 'window.tegula.')
    const lines = src.split(/\r?\n/)

    // ⚠ 2026-10-06 第二处修正（**上一轮的第 ⑤ 类清单因此有大量假阳性**）：
    //   渲染层还有一种**间接调用**写法 ——
    //       const t = (window as any).tegula
    //       await t.notificationsListMuted()
    //   归一化后 `const t = window.tegula`，把 `t` 当别名、把 `t.xxx(` 也算作调用。
    //   不认它的话，`notificationsScannerStatus` / `applogWrite` / `updateCheck` 这类
    //   明明在用的通道会被误报成"死通道"（第一版报了 66 个，其中十几个是假的）。
    //   ⚠ 别名扫描**只在 `<script>` 段内**做：模板里的 `v-for="t in tasks"` 会有大量 `t.title`，
    //      在模板段扫别名会造出一堆假僵尸按钮。
    const si = f.endsWith('.vue') ? src.indexOf('<script') : -1
    const scriptFrom = si >= 0 ? src.slice(0, si).split(/\r?\n/).length - 1 : 0

    const push = (name, idx) => {
      const where = `${path.relative(ROOT, f)}:${idx + 1}`
      if (!calls.has(name)) calls.set(name, [])
      calls.get(name).push(where)
    }
    const directRe = /window\s*\.\s*tegula\s*\.\s*([A-Za-z_$][\w$]*)/g
    // ⚠ 别名窗口只能"近似"：`t` 这个别名在 App.vue 里有 21 处 `const t =`，其中只有 11 处是 tegula
    //   （其余是 `cardTip.value` / `Date.parse(s)` / 函数参数…）。按"整文件生效"会让 `t.title`、
    //   `t.fm` 这类**任务对象字段**被算成 IPC 调用 → 一口气报 10 个假僵尸按钮（试过，见 2026-10-06 记录）。
    //   所以改成：只在**赋值点之后的窗口内**认它，遇到同名重赋值就停。
    const ALIAS_WINDOW = 25
    const aliasRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*window\s*\.\s*tegula\b/g
    lines.forEach((ln, idx) => {
      let m
      directRe.lastIndex = 0
      while ((m = directRe.exec(ln))) push(m[1], idx)
      if (idx < scriptFrom) return          // 模板段不扫别名（v-for="t in …" 会有满屏 t.xxx）
      aliasRe.lastIndex = 0
      while ((m = aliasRe.exec(ln))) {
        const name = m[1]
        // ⚠ `\\??` = 「0 或 1 个问号」（可选链）。写成 `\\?` 是**字面问号** —— 那样
        //   `t.foo()` 匹配不上、只有 `t?.foo()` 能匹配，别名识别会静默失效
        //   （第一版就这么写的：`notificationsScannerStatus` 明明在用却仍被报成死通道）。
        const re = new RegExp('\\b' + name + '\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)', 'g')
        const reassign = new RegExp('(?:const|let|var)\\s+' + name + '\\s*(?::[^=\\n]+)?=')
        for (let i = idx; i < Math.min(lines.length, idx + ALIAS_WINDOW); i++) {
          if (i > idx && reassign.test(lines[i])) break      // 同名换了来源 → 后面不再算
          re.lastIndex = 0
          let mm
          while ((mm = re.exec(lines[i]))) push(mm[1], i)
        }
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

// ── ⑥ IPC 载荷收口（2026-10-06 卡 005）────────────────────────────────
//
// 为什么必须有：渲染层把 **Vue 响应式代理**（`xxx.value` 里的数组/对象、v-for 元素）
// 直接当 IPC 载荷时，contextBridge 在「页面世界 → 隔离世界」这一跳就抛
// `An object could not be cloned` —— **报文连 preload 都进不去**，主进程日志一片空白，
// 排查时极易误判成「主进程没重启」。这个坑已经踩了三次：
//   ① 2026-09-25 启动台无法启动任何应用（修了 6 次才定位）② 2026-09-30 日志创建按钮全炸
//   ③ 2026-10-05 在途一屏勾选被清空（写盘从未成功 → 读回判定「从没做过选择」）
// 三次都只在**出事的那个点**打补丁，从未收口。
//
// 判据（比"含 .value 就报"精确得多）：实测渲染层 12 处 `.value` 实参**全是字符串/数字/布尔**，
// 直接禁 `.value` 会 12 处全误报、最后被人加豁免淹掉。真正危险的是
// **数组 / 对象型 ref** —— 那就把本文件里 `ref<X[]>` / `ref<Record<…>>` / `ref([])` 这类
// 声明先收集出来，再看 IPC 调用行里有没有裸传它们的 `.value`。
//
// 已知局限（写在这里，别当它万能）：
//   · 只按行看，跨行拼接的实参抓不到；
//   · 识别不了 `reactive({...})` 与 v-for 元素这类**非 ref 的代理**；
//   · 间接调用（`const t = window.tegula; t.foo(proxy)`）不看。
//   —— 所以 e2e 侧假 preload 的 `structuredClone` 校验仍是主力防线，本类只是"静态拦一道"。
function scanRiskyIpcPayloads() {
  const hits = []
  let riskyTotal = 0
  for (const f of walk(path.join(SRC, 'renderer'), ['.vue', '.ts', '.js'])) {
    const src = read(f)
      .replace(/\(\s*window\s+as\s+any\s*\)\s*\.\s*tegula/g, 'window.tegula')
      .replace(/window\s*\.\s*tegula\s*\?\./g, 'window.tegula.')
    const risky = new Set()
    const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ref\s*(?:<([^>]*)>)?\s*\(/g
    let m
    while ((m = declRe.exec(src))) {
      const name = m[1]
      const generic = (m[2] || '').trim()
      const isArr = /\[\s*\]$/.test(generic) || /^Array\s*</.test(generic)
      const isRecord = /^Record\s*</.test(generic) || /^\{/.test(generic)
      if (isArr || isRecord) risky.add(name)
    }
    if (!risky.size) continue
    riskyTotal += risky.size
    src.split(/\r?\n/).forEach((ln, idx) => {
      if (!/window\s*\.\s*tegula\s*\./.test(ln)) return
      if (ln.includes('toPlain(')) return                   // 已过门面（或已展开成裸数组）
      for (const name of risky) {
        // ⚠ 两个负向断言缺一不可（首版漏了 → 9 处误报全是这两种形态）：
        //   `xxx.value = await window.tegula.foo()`  —— ref 在**左值**，是接结果，不是传参；
        //   `window.tegula.bar(obj.value.id)`        —— 取的是子属性（字符串），不是整个代理。
        if (new RegExp('\\b' + name + '\\s*\\.\\s*value\\b(?!\\s*\\.)(?!\\s*=(?!=))').test(ln)) {
          hits.push({ file: path.relative(ROOT, f), line: idx + 1, name, src: ln.trim().slice(0, 130) })
        }
      }
    })
  }
  return { hits, riskyTotal }
}

// ── 对账 ─────────────────────────────────────────────────────────────

function main() {
  const calls = scanRendererCalls()
  const { keys: exposed, file: preloadFile, missing: noPreload } = scanPreload()
  const regs = scanMainRegistrations()
  const { entry, reachable } = scanReachable()
  const { hits: riskyPayloads, riskyTotal } = scanRiskyIpcPayloads()

  const norm = (rel) => rel.replace(/\\/g, '/')
  const exempted = { buttons: [], channels: [], unwired: [], orphan: [], dead: [] }

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

  // ⑤ 死通道：preload 暴露 + 主进程注册，但渲染层从不调用（2026-10-06 卡 004）
  //    为什么值钱：桌面「派活链」（dispatchPreview / dispatchExecute）整条是死代码，
  //    而当时没有任何守卫能发现它 —— 是人工读代码才挖出来的。这里把这一类变成可查项。
  //    信息级：不作 fail（合法保留的口子很多），但每次把清单打出来供圈选。
  const deadChannels = []
  for (const [name, ch] of exposed) {
    if (calls.has(name)) continue
    if (!ch || !regs.has(ch)) continue          // 僵尸通道已由 ② 报过
    if (EXEMPTIONS.dead[name]) { exempted.dead.push({ name, reason: EXEMPTIONS.dead[name] }); continue }
    deadChannels.push({ name, channel: ch })
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
  const listLimit = process.argv.includes('--all') ? Infinity : 12
  if (orphan.length === 0) pass++, console.log('PASS  ④ 无孤儿通道')
  else {
    pass++
    console.log(`INFO  ④ ${orphan.length} 个孤儿通道（主进程注册但 preload 未暴露，CLI/内部使用可能合法）`)
    orphan.slice(0, listLimit).forEach(o => console.log(`        · ${o.channel}  ← ${o.where}`))
    if (orphan.length > listLimit) console.log(`        … 另有 ${orphan.length - listLimit} 个（加 --all 看全）`)
  }

  // ⑤ 仅信息（卡 004）
  if (deadChannels.length === 0) pass++, console.log('PASS  ⑤ 无死通道（preload 暴露的每一项渲染层都在用）')
  else {
    pass++
    console.log(`INFO  ⑤ ${deadChannels.length} 个死通道（preload 暴露 + 主进程注册，但渲染层从不调用 —— 已退休功能残留，或给 e2e/未来的兼容口）`)
    deadChannels.slice(0, listLimit).forEach(d => console.log(`        · ${d.name}  → ${d.channel}`))
    if (deadChannels.length > listLimit) console.log(`        … 另有 ${deadChannels.length - listLimit} 个（加 --all 看全）`)
  }

  // ⑥ IPC 载荷：裸传数组/对象型 ref = Vue 代理过 contextBridge 必抛
  if (riskyPayloads.length === 0) ok(`⑥ IPC 载荷无裸传的数组/对象 ref（本仓识别到这类 ref ${riskyTotal} 个，全部没裸传）`)
  else riskyPayloads.forEach(p => bad(`⑥ IPC 裸传数组/对象 ref：${p.name}.value 直接进 IPC —— Vue 代理过 contextBridge 必抛「could not be cloned」（${p.file}:${p.line}）｜ ${p.src}`))

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
