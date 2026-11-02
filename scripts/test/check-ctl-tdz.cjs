#!/usr/bin/env node
/**
 * 拆分安全闸：检查 App.vue 里每个 `xxxCtl = reactive({...})` 控制器
 * 有没有引用**在它之前尚未声明**的标识符（TDZ）。
 *
 * 为什么需要这个：2026-11-02 拆浮层时踩过 ——
 *   `const aboutCtl = reactive({ bkOpenDir, ... })` 里 `bkOpenDir` 来自后面 `useBackup()` 的解构，
 *   属性简写会在**定义处立即求值** → 运行时 TDZ 报错，而 `tsc` 完全照过（它不模拟初始化顺序）。
 *   无头断言也可能根本没点开那个弹窗，于是"全绿"但一点就炸。
 *
 * 判据：控制器块内出现的每个裸标识符，必须在块开始之前已经出现在
 *       const/let/var/function/import/解构 里；否则报红。
 *
 * 运行：node scripts/test/check-ctl-tdz.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const FILE = path.join(REPO, 'desktop/src/renderer/App.vue')
let src = fs.readFileSync(FILE, 'utf8')

// 只分析 script 段（template 里的标识符由别的守卫管）
const scriptAt = src.indexOf('<script setup')
const script = scriptAt >= 0 ? src.slice(scriptAt) : src
const offset = src.slice(0, scriptAt).split('\n').length - 1

// 语言关键字 / 内置 / 字面量，直接跳过
const SKIP = new Set([
  'true', 'false', 'null', 'undefined', 'this', 'return', 'if', 'else', 'typeof', 'void',
  'get', 'set', 'async', 'await', 'function', 'const', 'let', 'var', 'new', 'in', 'of',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'window',
  'document', 'console', 'Promise', 'setTimeout', 'clearTimeout', 'parseInt', 'parseFloat',
  'ref', 'reactive', 'computed', 'watch', 'readonly', 'toRef', 'toRefs', 'inject', 'provide',
  'onMounted', 'onUnmounted', 'nextTick', 'defineProps', 'defineEmits', 'defineExpose',
])

/** 从脚本里收集"在某字符位置之前已经声明过的名字" */
function declaredBefore(text, pos) {
  const head = text.slice(0, pos)
  const names = new Set()
  // const / let / var 声明（含多行解构）
  const reDecl = /(?:const|let|var)\s+([\s\S]*?)(?==|;|\n(?=\s*(?:const|let|var|function|async|interface|type|\/\/|\/\*)))/g
  let m
  while ((m = reDecl.exec(head))) {
    const chunk = m[1]
    // 取所有类似标识符的片段（解构内的也算），排除 { } : , 之外的结构词
    const ids = chunk.match(/[A-Za-z_$][\w$]*/g) || []
    for (const id of ids) {
      // 解构里的 `a: b` 右侧是别名，两边都当已声明（保守）
      names.add(id)
    }
  }
  // function 声明
  const reFn = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g
  while ((m = reFn.exec(head))) names.add(m[1])
  // import 进来的
  const reImport = /import\s+([\s\S]*?)\s+from\s+['"]/g
  while ((m = reImport.exec(head))) {
    const ids = m[1].match(/[A-Za-z_$][\w$]*/g) || []
    for (const id of ids) names.add(id)
  }
  return names
}

let pass = 0
let fail = 0
const check = (n, ok, d) => {
  if (ok) { pass++; console.log('PASS  ' + n) }
  else { fail++; console.log('FAIL  ' + n + (d ? '\n      ' + d : '')) }
}

// 找所有 xxxCtl = reactive({ ... })
const reCtl = /const\s+([A-Za-z_$][\w$]*)\s*=\s*reactive\(\{/g
let m
const ctls = []
while ((m = reCtl.exec(script))) ctls.push({ name: m[1], at: m.index + m[0].length })

check('能找到拆分控制器（>0 个）', ctls.length > 0, '找到 ' + ctls.length + ' 个')

for (const c of ctls) {
  // 截到匹配的 }) —— 简单括号计数
  let depth = 1
  let i = c.at
  while (i < script.length && depth > 0) {
    if (script[i] === '{') depth++
    else if (script[i] === '}') depth--
    i++
  }
  const bodyRaw = script.slice(c.at, i - 1)
  // 去掉注释与字符串
  const body = bodyRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')

  // 取**属性简写**（只有这些是"定义处立即求值"，才可能 TDZ）
  // ⚠ getter/setter 里 return 的名字是**惰性**的 —— 后面声明也安全，这是本项目刻意用法，不判红
  //   （第一版没分清，报了一堆假红：closeQuickAdd / quickAddText 这些明明是函数声明或 getter 引用）
  const shorthand = []
  for (const raw of body.split('\n')) {
    const t = raw.trim()
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    if (/^(get|set)\s/.test(t)) continue
    const sm = /^([A-Za-z_$][\w$]*)\s*,?$/.exec(t)
    if (sm) shorthand.push(sm[1])
  }

  const declared = declaredBefore(script, c.at)
  // 函数声明提升 —— **扫整个 script 而不是只看前面**：同一作用域内 `function foo(){}` 写在使用点之后也照样可用
  const fnNames = new Set()
  for (const fm of script.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) fnNames.add(fm[1])

  const missing = shorthand.filter((id) => !declared.has(id) && !fnNames.has(id))
  const line = offset + script.slice(0, c.at).split('\n').length
  check(
    '★★ ' + c.name + '（App.vue:' + line + '）的属性简写都在此前声明过',
    missing.length === 0,
    missing.length ? '定义处立即求值但前面没有：' + missing.join(', ') + '（改成 getter，或把这个控制器挪到声明之后）' : ''
  )
}

console.log('\nRESULT ' + pass + ' / ' + fail)
process.exit(fail === 0 ? 0 : 1)
