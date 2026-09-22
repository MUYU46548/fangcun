#!/usr/bin/env node
/**
 * Vue SFC 模板绑定检查器 —— 抓「模板/函数在用、但 script setup 从未声明」的标识符。
 *
 * 为什么需要（2026-09-22）：
 *   启动台「+ 添加应用」按钮被反复报修六次，历次修复都在改 CSS / dialog / 原子写。
 *   真因是 `editApp_` 从未声明 —— 点一下立刻 ReferenceError，界面毫无反应；
 *   模板里的 `v-if="editApp_"` 也恒为 undefined，模态永不出现。
 *
 *   现有防线全部抓不到它：
 *     · vite build / tsc 不报（模板里的未知标识符被当作全局引用）
 *     · stub e2e 不解析 SFC 模板，只测主进程与逻辑
 *     · IPC 三方对账只管通道，不管模板变量
 *   所以单列一个检查。
 *
 * 运行：node scripts/test/check-template-bindings.cjs [文件…]
 * 退出码：存在未声明标识符 → 1
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
  return declared
}

function checkFile(file) {
  const src = fs.readFileSync(file, 'utf-8')
  const tplM = src.match(/<template>([\s\S]*)<\/template>/)
  const scrM = src.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)
  if (!tplM || !scrM) return { file, skipped: true, missing: [] }

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
  return { file, skipped: false, missing: [...missing].sort() }
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
  if (!r.missing.length) {
    pass++
    console.log(`PASS  ${rel} —— 模板引用的标识符全部有声明`)
  } else {
    fail++
    console.log(`FAIL  ${rel} —— ${r.missing.length} 个标识符在模板里被使用、但 script setup 中未声明：`)
    r.missing.forEach(x => console.log(`        · ${x}`))
  }
}

console.log('')
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
