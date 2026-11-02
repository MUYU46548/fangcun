#!/usr/bin/env node
/**
 * 拆分后组件自检：模板里引用的每个标识符，必须能在组件内解析
 * （自己的 script、import、或 `ctl.xxx` / props）。
 *
 * 为什么必须有这个（2026-11-02 实抓到）：
 *   把 App.vue 的弹窗模板搬进组件时，`@click="browseWizardDir"` 这种**裸名字**不会报错 ——
 *   Vue 模板在运行期才解析，build 只查 script。于是"全绿打包 → 用户一点向导里的『浏览』就炸"。
 *   `check-template-bindings` 抓到了 App.vue 侧"定义了但零引用"，反向漏掉的正是组件侧这条。
 *
 * 判据：
 *   ① 模板里出现的标识符，若不在本组件 script 里声明 / 没 import / 不是 v-for 局部变量 /
 *      不是 `ctl.` 前缀访问 → 报红。
 *   ② 反过来：组件里 `ctl.xxx` 用到的键，App.vue 的对应控制器必须真的有那个键。
 *
 * 运行：node scripts/test/check-split-components.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const DIR = path.join(REPO, 'desktop/src/renderer/components')
const APP = path.join(REPO, 'desktop/src/renderer/App.vue')

const appSrc = fs.readFileSync(APP, 'utf8')

/** 从 App.vue 里找某个控制器块里的键名（含 getter/setter 的属性名） */
function ctlKeys(ctlName) {
  const at = appSrc.indexOf('const ' + ctlName + ' = reactive({')
  if (at < 0) return null
  const start = appSrc.indexOf('{', at)
  let depth = 0
  let i = start
  while (i < appSrc.length) {
    if (appSrc[i] === '{') depth++
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break }
    i++
  }
  const body = appSrc.slice(start + 1, i)
  const keys = new Set()
  for (const m of body.matchAll(/(?:^|\n)\s*(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/g)) keys.add(m[1])
  for (const m of body.matchAll(/(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/gm)) keys.add(m[1])
  for (const m of body.matchAll(/(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*:/gm)) keys.add(m[1])
  return keys
}

// Vue / 模板语法自带的名字
const BUILTIN = new Set([
  'true', 'false', 'null', 'undefined', 'this', 'in', 'of', 'typeof', 'new', 'void',
  'item', 'index', 'key', 'value', 'event', 'e', 'Math', 'JSON', 'String', 'Number',
  'Array', 'Object', 'Date', 'parseInt', 'parseFloat', '$event',
])

let pass = 0
let fail = 0
const check = (n, ok, d) => {
  if (ok) { pass++; console.log('PASS  ' + n) }
  else { fail++; console.log('FAIL  ' + n + (d ? '\n      ' + d : '')) }
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.vue'))
const CTL_COMPONENTS = files.filter((f) => {
  const s = fs.readFileSync(path.join(DIR, f), 'utf8')
  return /defineProps<\{\s*ctl:\s*any\s*\}>\s*\(\)/.test(s)
})
check('找到用 ctl 模式的组件（>0）', CTL_COMPONENTS.length > 0, CTL_COMPONENTS.join(', '))

for (const f of CTL_COMPONENTS) {
  const full = path.join(DIR, f)
  const s = fs.readFileSync(full, 'utf8')
  const tplEnd = s.indexOf('</template>')
  const tpl = s.slice(s.indexOf('<template>') + 10, tplEnd)
  const scr = s.slice(s.indexOf('<script setup'))

  // 组件 script 里声明的名字
  const declared = new Set()
  for (const m of scr.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  // 解构式：`const { a, b } = ctl` 或 `= props.ctl`（LogPurgeModal 用的是前者）
  for (const m of scr.matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*(?:props\.)?ctl\b/g)) {
    for (const id of (m[1].match(/[A-Za-z_$][\w$]*/g) || [])) declared.add(id)
  }
  for (const m of scr.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]/g)) {
    for (const id of (m[1].match(/[A-Za-z_$][\w$]*/g) || [])) declared.add(id)
  }
  for (const m of scr.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  // v-for 局部变量
  // v-for 的局部变量：`x in xs` / `(x, i) in xs` / `x of xs` 三种写法都认
  for (const m of tpl.matchAll(/v-for="\(?([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\)?\s+(?:in|of)\s+/g)) {
    declared.add(m[1]); if (m[2]) declared.add(m[2])
  }

  // 模板里的标识符：去掉 ctl.xxx（那是 props 访问）与字符串/属性值外的部分
  const cleaned = tpl
    .replace(/"[^"]*"/g, '""')     // 所有属性值（含表达式）先抹掉，下面单独取
    .replace(/<!--[\s\S]*?-->/g, '')
  // 取属性值里的表达式（:xxx="expr" / @xxx="expr" / v-if / v-model / {{ }}）
  const exprs = []
  for (const m of tpl.matchAll(/(?::|@|v-if=|v-else-if=|v-show=|v-model[.\w]*=)[\w.:-]*="([^"]*)"/g)) exprs.push(m[1])
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) exprs.push(m[1])
  // 字符串字面量里的词不是标识符（'fresh' / "import" / 'Python' 这些），单双引号都要抹
  for (let i = 0; i < exprs.length; i++) {
    exprs[i] = exprs[i].replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
  }

  const unknown = new Set()
  for (const e of exprs) {
    // 去掉整条 ctl 访问链（ctl.a.b[0].c 一起抹），否则 a/b/c 会被当成裸名字（第一版就是这么假红一片）
    const noCtl = e.replace(/\bctl\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])*/g, ' ')
    // `{ selected: cond }` 这种对象字面量的**键**是 CSS 类名/字段名，不是变量
    const noKeys = noCtl
      .replace(/\{\s*([A-Za-z_$][\w$]*)\s*:/g, '{').replace(/,\s*([A-Za-z_$][\w$]*)\s*:/g, ',')
      // 箭头函数参数：`list.find(p => p.id)` —— p 是局部参数，不是模板变量
      .replace(/\(?([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\)?\s*=>/g, '=>')
    // 只认"独立变量位置"：前后都不是 `.` 或标识符字符 —— 这样 `x.id` 的 id、`s.trim()` 的 trim 都不算
    for (const m of noKeys.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?![.\w$])/g)) {
      const id = m[1]
      if (BUILTIN.has(id) || declared.has(id)) continue
      // 属性名 / 关键字 / 方法链后面那个（如 `x.trim` 的 trim）
      if (/^(if|else|return|typeof|new|in|of|and|or|not)$/.test(id)) continue
      unknown.add(id)
    }
  }
  check(
    '★★ ' + f + ' 模板里的裸名字都能解析',
    unknown.size === 0,
    unknown.size ? '未定义：' + [...unknown].join(', ') + '（应改成 ctl.xxx，或在本组件声明）' : ''
  )

  // 反向：ctl.xxx 的键必须真的在 App.vue 的控制器里
  const ctlNames = [...s.matchAll(/defineProps<\{\s*ctl:\s*any\s*\}>\s*\(\)/g)].length
  const ctlVar = (s.match(/const (\w+Ctl)\b/) || [])[1]
  if (!ctlVar) {
    // 组件侧没写控制器变量名，跳过反向检查（由 App.vue 侧保证）
    continue
  }
  const appCtlKeys = ctlKeys(ctlVar)
  if (!appCtlKeys) { check('★ ' + f + ' 对应的 ' + ctlVar + ' 在 App.vue 里存在', false, '找不到 ' + ctlVar); continue }
  const used = new Set([...tpl.matchAll(/\bctl\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
  const missing = [...used].filter((k) => !appCtlKeys.has(k))
  check(
    '★★ ' + f + ' 用到的 ctl 键在 ' + ctlVar + ' 里都存在',
    missing.length === 0,
    missing.length ? '控制器里没有：' + missing.join(', ') : ''
  )
}

console.log('\nRESULT ' + pass + ' / ' + fail)
process.exit(fail === 0 ? 0 : 1)
