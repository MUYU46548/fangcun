#!/usr/bin/env node
/**
 * Vue SFC 引用完整性检查器 —— 抓「在用了、但从没定义」的标识符。
 *
 * ① 模板绑定：模板引用了、`<script setup>` 未声明
 * ② 脚本调用：`<script setup>` 体内**调用了**、但文件里没有任何声明的函数名
 * ③ 死函数：`function foo()` 定义了但全文件零引用（漏接入口）
 * ⑧ ref 裸用当布尔（2026-09-28 加）：脚本里写 `if (someRef)` —— 判断的是 ref 对象，恒为真
 *
 * 为什么需要（2026-09-22）：
 *   ① 启动台「+ 添加应用」按钮被反复报修六次，历次修复都在改 CSS / dialog / 原子写。
 *      真因是 `editApp_` 从未声明 —— 点一下立刻 ReferenceError，界面毫无反应；
 *      模板里的 `v-if="editApp_"` 也恒为 undefined，模态永不出现。
 *   ② `loadBlockerChains()` 在 `loadViewData()` 里被调用、却从未定义 —— 点「阻塞」页签
 *      直接 `Uncaught ReferenceError`，页面停在上一个视图。
 *      ①只扫模板，抓不到"函数体内调用未定义函数"，所以补 ②。
 *   ⑧ 2026-09-28 实战抓到：看板悬停提示的「拖拽中不弹」守卫写成 `if (draggingId) return`
 *      （`draggingId` 是 ref）→ 条件恒真 → **浮层永不出现**；tsc 认为"对象当布尔"完全合法。
 *
 *   现有防线全部抓不到这几类：
 *     · vite build / tsc 不报（模板里的未知标识符被当作全局引用；
 *       函数体里的未定义名要等**运行到那一行**才抛；`Ref<T>` 当布尔是合法 TS）
 *     · stub e2e 不解析 SFC
 *     · IPC 三方对账只管通道
 *   所以单列一个检查。
 *
 * 运行：node scripts/test/check-template-bindings.cjs [文件…]
 * 退出码：存在未声明标识符 / 死函数 / ref 裸用 → 1
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [path.join(ROOT, 'desktop/src/renderer/App.vue')]

// 语言关键字 / 运行时全局 / 浏览器 API —— 模板里出现是正常的
const GLOBALS = new Set([
  'true', 'false', 'null', 'undefined', 'this', 'new', 'typeof', 'instanceof', 'in', 'of',
  'void', 'delete', 'if', 'else', 'return', 'await', 'async', 'function', 'const', 'let', 'var',
  'yield', 'throw', 'try', 'catch', 'switch', 'case', 'break', 'continue', 'default',
  'Math', 'Date', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Map', 'Set',
  'Promise', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'console', 'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'alert', 'confirm', 'prompt', 'Blob', 'URL', 'FileReader', 'File', 'FormData',
  'Event', 'DragEvent', 'KeyboardEvent', 'MouseEvent', 'HTMLElement', 'Element', 'Node',
  'Error', 'Symbol', 'BigInt', 'Infinity', 'NaN', 'structuredClone', 'queueMicrotask', 'Intl',
])

// 语句关键字里带括号的写法（`if (` / `for (` / `catch (`…）会被误当成函数调用
const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'new', 'function',
  'do', 'else', 'case', 'of', 'in', 'delete', 'void', 'await', 'async', 'super', 'import', 'export',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'RegExp', 'Promise', 'Symbol', 'Error',
])

/**
 * ③ 死了的函数：`function foo()` 定义了但全文件只出现这一次（零引用）。
 * 这不是"风格问题"—— 2026-09-22 就是靠它抓出两处真缺陷：
 *   · `openReview` 零引用 ⇒ 「验收裁决」弹窗**根本没有入口**（后端通道、弹窗、
 *     accept/reject 逻辑全都写好了，就是没人调用）
 *   · `openBackupFolder` 零引用 ⇒ 一个写好的"打开最近备份所在目录"功能从未接线
 * 纪律同 check-ipc-parity：豁免项必须写明原因，且每次运行都打印出来。
 */
const DEAD_FN_EXEMPT = {
  // '函数名': '为什么允许它没有被调用',
}

function identifiers(expr) {
  // 先抹掉字符串/模板串内容，避免把里面的词当标识符
  const clean = expr
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    // 剔除对象字面量的 key：`:class="{ on: x, done: y }"` 里的 on/done 是 CSS 类名不是变量。
    // 只匹配紧跟在 { 或 , 之后的 ident:，不会误伤三元 `a ? b : c`（b 前面不是 { 或 ,）
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1')
  const out = new Set()
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(clean))) out.add(m[2])
  return out
}

function collectDeclared(script) {
  const declared = new Set()
  let m
  const push = (raw) => {
    const t = String(raw || '').trim().replace(/^\.\.\./, '').split(/\s+as\s+/).pop().trim()
    if (/^[A-Za-z_$][\w$]*$/.test(t)) declared.add(t)
  }
  // ⚠ 空白一律用 [ \t]，别用 \s —— \s 会吃掉换行，于是
  //   `const PRIORITIES = [...] as const` 换行后接 `const taskFieldSpecs = ...` 时，
  //   行尾那个 `const` 会被当成下一条声明的「名字」捕获，真正的 taskFieldSpecs 反被跳过
  //   （实测踩过：本检查器自己误报 taskFieldSpecs 未声明）。
  const declRe = /\b(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/g
  while ((m = declRe.exec(script))) push(m[1])
  // 解构：const { a, b: c } = … / const [a, b] = …
  const destrRe = /\b(?:const|let|var)[ \t]*[\[{]([^\]}]*)[\]}][ \t]*=/g
  while ((m = destrRe.exec(script))) m[1].split(',').forEach(part => push(part.split(':').pop()))
  const fnRe = /\bfunction[ \t]+([A-Za-z_$][\w$]*)/g
  while ((m = fnRe.exec(script))) push(m[1])
  // import { a, b as c } from '…' / import x from '…' / import * as ns
  const impRe = /import[ \t]+([^'"]+?)[ \t]+from/g
  while ((m = impRe.exec(script))) m[1].replace(/[{}]/g, ' ').split(',').forEach(push)
  // 类型/接口与形参也算「名字已被占用」，否则 `type Foo = ...` 后 `Foo(x)` 会被误报
  const ifaceRe = /\b(?:interface|type|class|enum)[ \t]+([A-Za-z_$][\w$]*)/g
  while ((m = ifaceRe.exec(script))) push(m[1])
  return declared
}

/** 收集形参名：function(a, b) / (a, b) => / a => / catch (e) */
function collectParams(script) {
  const params = new Set()
  const addAll = (raw) => {
    for (const part of String(raw || '').split(',')) {
      let t = part.trim().replace(/^\.\.\./, '')
      t = t.split(/[:=]/)[0].trim().replace(/^[\[{]|[\]}]$/g, '')
      if (/^[A-Za-z_$][\w$]*$/.test(t)) params.add(t)
    }
  }
  let m
  const fnRe = /\bfunction[ \t]*[A-Za-z_$]*[ \t]*\(([^)]*)\)/g
  while ((m = fnRe.exec(script))) addAll(m[1])
  const arrowRe = /\(([^()]*)\)[ \t]*=>/g
  while ((m = arrowRe.exec(script))) addAll(m[1])
  const singleArrowRe = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)[ \t]*=>/g
  while ((m = singleArrowRe.exec(script))) addAll(m[1])
  const catchRe = /\bcatch[ \t]*\(([^)]*)\)/g
  while ((m = catchRe.exec(script))) addAll(m[1])
  return params
}

/**
 * 抹掉注释与字符串内容，但**保留模板串 ${} 里的代码**。
 * 只用于"找调用点"，所以宁可漏掉几个也不要把字符串里的词当成调用。
 */
function stripNoise(code) {
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i], c2 = code[i + 1]
    if (c === '/' && c2 === '/') { while (i < n && code[i] !== '\n') i++; continue }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue }
    if (c === '"' || c === "'") {
      const q = c
      out += ' '
      i++
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === q) { i++; break }
        i++
      }
      continue
    }
    if (c === '`') {
      out += ' '
      i++
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === '`') { i++; break }
        if (code[i] === '$' && code[i + 1] === '{') {
          i += 2
          let depth = 1
          const s = i
          while (i < n && depth > 0) {
            if (code[i] === '{') depth++
            else if (code[i] === '}') { depth--; if (depth === 0) break }
            i++
          }
          out += ' ' + code.slice(s, i) + ' '
          i++
          continue
        }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** 找「被调用」的名字：name( 且前面不是 . （排除对象方法调用） */
function collectCalled(stripped) {
  const called = new Map() // name -> 行号
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)[ \t]*\(/g
  let m
  while ((m = re.exec(stripped))) {
    const name = m[2]
    if (/^[A-Z]/.test(name)) continue // 构造器/组件：不作为"未定义函数"报（误报率高）
    if (!called.has(name)) called.set(name, stripped.slice(0, m.index).split('\n').length)
  }
  return called
}

/** ③ 定义了但全文件零引用的函数 */
function collectDeadFunctions(src) {
  const names = [...src.matchAll(/^(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(/gm)].map(m => m[1])
  const dead = []
  for (const n of names) {
    const re = new RegExp('(?<![\\w$])' + n.replace(/[$]/g, '\\$') + '(?![\\w$])', 'g')
    const count = (src.match(re) || []).length
    if (count <= 1) dead.push(n)
  }
  return dead
}

/**
 * ⑧ ref 裸用当布尔（2026-09-28 新增，实战抓到过真 bug）
 *
 * 症状：`const draggingId = ref<string|null>(null)` 之后写 `if (draggingId) return` ——
 *   判断的是**那个 ref 对象本身**，恒为真，于是这条守卫把整条路径全挡掉。
 *   实例：看板卡片悬停轻提示的「拖拽中不弹」守卫就写成了 `if (draggingId) return`，
 *   结果浮层**永远不出现**（用户 2026-09-28 实测「②看不见」）。
 *
 * ⚠ 这一层 tsc / vite / 桩 e2e / IPC 对账**全都抓不到**：
 *   类型上 `Ref<T>` 就是个对象，"对象当布尔"是合法 TS。
 *
 * 判据（只在 `<script setup>` 体内，且只认高信噪比形状）：
 *   `if (X)` / `if (!X)` / `X ?`（不是类型注解的 `X?:`）/ `&& X` / `|| X`
 *   —— 其中 X 是 `ref/computed/shallowRef/toRef` 声明的名字。
 * `X.value`、声明行、类型注解都会被排除；模板里的裸用是**正确**的（模板自动解包），所以不扫模板。
 */
function collectBareRefs(strippedScript) {
  const declRe = /(?:^|\n)[ \t]*(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]*)?=[ \t]*(?:ref|computed|shallowRef|toRef)\b/g
  const names = new Set()
  let m
  while ((m = declRe.exec(strippedScript))) names.add(m[1])
  const out = []
  for (const name of names) {
    const e = name.replace(/[$]/g, '\\$')
    const pats = [
      new RegExp('if[ \\t]*\\([ \\t]*' + e + '[ \\t]*\\)', 'g'),
      new RegExp('if[ \\t]*\\([ \\t]*![ \\t]*' + e + '[ \\t]*\\)', 'g'),
      new RegExp('(?:^|[=(,;[ \\t])' + e + '[ \\t]*\\?(?![.:])', 'g'),
      new RegExp('&&[ \\t]*' + e + '[ \\t]*(?![.\\w$(])', 'g'),
      new RegExp('\\|\\|[ \\t]*' + e + '[ \\t]*(?![.\\w$(])', 'g'),
    ]
    for (const p of pats) {
      const hit = p.exec(strippedScript)
      if (!hit) continue
      out.push({ name, line: strippedScript.slice(0, hit.index).split('\n').length, shape: hit[0].trim().slice(0, 28) })
      break
    }
  }
  return out
}

function checkFile(file) {
  const src = fs.readFileSync(file, 'utf-8')
  const tplM = src.match(/<template>([\s\S]*)<\/template>/)
  const scrM = src.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)
  if (!tplM || !scrM) return { file, skipped: true, missing: [], missingCalls: [] }

  const tpl = tplM[1]
  // 声明来源扫整个 SFC：模板引用的变量必然在同一文件里声明；
  // 而 `<script setup>` 块可能被内容中出现的 </script> 字样提前截断（实测如此），
  // 扫全文更稳，也顺带覆盖同文件的普通 <script> 块。
  const declared = collectDeclared(src)

  // v-for 引入的局部变量（模板自有作用域）
  const locals = new Set()
  let m
  const vforRe = /v-for\s*=\s*"\(?([^)"']*?)\)?\s+(?:in|of)\s+/g
  while ((m = vforRe.exec(tpl))) m[1].split(',').forEach(s => locals.add(s.trim().replace(/^\.\.\./, '')))

  // 收集所有模板表达式
  const exprs = []
  const mustache = /\{\{([\s\S]*?)\}\}/g
  while ((m = mustache.exec(tpl))) exprs.push(m[1])
  const attrRe = /(?:v-if|v-else-if|v-show|v-for|v-model(?::[\w-]+)?|:[\w.-]+|@[\w.-]+|v-bind(?::[\w.-]+)?)\s*=\s*"([^"]*)"/g
  while ((m = attrRe.exec(tpl))) exprs.push(m[1])

  const missing = new Set()
  for (const e of exprs) {
    for (const id of identifiers(e)) {
      if (id.startsWith('$')) continue            // $event / $slots 等 Vue 内置
      if (/^[A-Z]/.test(id)) continue             // 组件名 / 构造器
      if (GLOBALS.has(id) || locals.has(id) || declared.has(id)) continue
      missing.add(id)
    }
  }

  // ② 脚本体内「调用了但没定义」—— 模板检查抓不到这一层
  const body = scrM[1]
  const known = new Set([...declared, ...collectParams(body), ...GLOBALS, ...CALL_KEYWORDS])
  const missingCalls = []
  for (const [name, line] of collectCalled(stripNoise(body))) {
    if (known.has(name)) continue
    if (name.startsWith('$')) continue
    if (locals.has(name)) continue
    missingCalls.push({ name, line })
  }

  return { file, skipped: false, missing: [...missing].sort(), missingCalls, bareRefs: collectBareRefs(stripNoise(body)) }
}

let fail = 0
let pass = 0
for (const t of targets) {
  const abs = path.isAbsolute(t) ? t : path.join(ROOT, t)
  if (!fs.existsSync(abs)) {
    console.log(`FAIL  文件不存在: ${t}`)
    fail++
    continue
  }
  const r = checkFile(abs)
  const rel = path.relative(ROOT, abs)
  if (r.skipped) {
    console.log(`SKIP  ${rel}（无 <template> + <script setup> 组合）`)
    continue
  }
  const problems = []
  if (r.missing.length) {
    problems.push(`① 模板引用了但未声明（${r.missing.length}）：` + r.missing.join(', '))
  }
  if (r.missingCalls.length) {
    problems.push(`② 调用了但未定义（${r.missingCalls.length}）：` +
      r.missingCalls.map(c => `${c.name}()`).join(', '))
  }
  const deadFns = collectDeadFunctions(fs.readFileSync(abs, 'utf-8'))
    .filter(n => !(n in DEAD_FN_EXEMPT))
  if (deadFns.length) {
    problems.push(`③ 定义了但零引用（${deadFns.length}）：` + deadFns.map(n => `${n}()`).join(', ') +
      ` —— 要么接线到界面，要么删掉；确属有意保留请加进 DEAD_FN_EXEMPT 并写明原因`)
  }
  if (r.bareRefs && r.bareRefs.length) {
    problems.push(`⑧ ref 裸用当布尔（${r.bareRefs.length}）：` +
      r.bareRefs.map(b => `${b.name}（第 ${b.line} 行 ${b.shape}）`).join('、') +
      ` —— ref 对象恒为真。脚本里必须写 .value；模板里裸用才是对的`)
  }
  if (!problems.length) {
    pass++
    console.log(`PASS  ${rel} —— 模板标识符 / 脚本内调用 / 函数引用全部自洽`)
  } else {
    fail++
    console.log(`FAIL  ${rel}`)
    for (const p of problems) console.log(`        · ${p}`)
  }
}

const exempted = Object.entries(DEAD_FN_EXEMPT)
if (exempted.length) {
  console.log('\n豁免（有意保留的死函数，非缺陷）：')
  for (const [k, v] of exempted) console.log(`  · ${k}() —— ${v}`)
}

console.log('')
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
