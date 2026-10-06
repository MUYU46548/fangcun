/**
 * 界面文案守卫（2026-10-06）
 *
 * 为什么要有它：这类缺陷**反复出现**，而且每次都是人脸肉发现的 ——
 *   · `App.vue` 在途一屏的空屏提示里写了 `**主进程还是旧代码**`
 *   · 设置页「看板归档」的说明里写了 `**不删文件**`
 *   · `mcpConnect.ts` 的 howTo 里写了 `**原样追加**` / `**不猜、不代写**`
 *   · `chat.ts` 的鉴权失败提示里写了 `` `Bearer ` `` / `` `***` ``
 * Vue 模板与 `{{ }}` 都**不解析 Markdown** —— 用户看到的是字面的星号和反引号。
 *
 * 判据（只认「最终会以纯文本渲染给用户看」的位置，避免误伤有意为之的 Markdown）：
 *   A. `App.vue` 的 `<template>` 段（剥掉 HTML 注释）里不得出现 `**`；
 *   B. **界面文案行**的字符串字面量里不得出现 `**`：
 *      howTo: / showToast( / message: ' / label: ' / hint: ' / placeholder="
 *      —— 这些位置是「技能页说明 / toast / 错误条 / 下拉项 / 提示语」，一律纯文本渲染。
 *   C. 同一批位置里的**单/双引号**字符串不得含反引号（Markdown 行内代码）。
 *
 * 明确**不查**（有意放 Markdown，是给 AI 读的，不是给界面渲染的）：
 *   · `logs.ts injectLog()` —— 拼给 agent 看的日志注入块；
 *   · `mcpConnect.ts buildSelfInstallPrompt()` —— 贴给目标 agent 的自装指令；
 *   · `tripBoard.ts` 契约模板 / `shared/arsenal.ts` 派工单 —— 复制出去落盘的 Markdown。
 *   它们都走 `parts.push(...)` / 数组字面量，不命中上面的行级特征，天然不在检查范围。
 *
 * 掩码白名单：内容形如 `***`（纯星号）的字符串是密钥掩码，不是 Markdown ——
 * 用「除最后一位全是 ASCII 可打印且首位非空白」近似判断，避免误报。
 *
 * 运行：node scripts/test/check-ui-copy.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const SRC = path.join(REPO, 'desktop', 'src')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

/** 剥掉 HTML 注释：按**原长度**换成空格，行号不漂 */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
}

/** 只扫源文件，跳过 node_modules / 编译产物 */
function walk(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * 界面文案行：只查这几类位置。
 * ⚠ `placeholder=` 只在 .vue 属性里出现，命中 `placeholder="` 即可。
 */
const UI_LINE_RE = /(howTo\s*:|showToast\s*\(|\bmessage\s*:\s*['"`]|\blabel\s*:\s*['"`]|\bhint\s*:\s*['"`]|placeholder\s*=\s*")/
/** 含转义的字符串字面量（三种引号） */
const STR_RE = /(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g
/** 密钥掩码：内容全是星号（`***` / `****`） */
const PURE_MASK_RE = /^\*+$/

function rel(p) { return path.relative(REPO, p).replace(/\\/g, '/') }

/** B/C 两类：逐行找界面文案行里的字符串 */
function scanUiStrings(file) {
  const bold = []   // 含 ** 的
  const tick = []   // 单/双引号串里含反引号的
  const lines = fs.readFileSync(file, 'utf-8').split('\n')
  lines.forEach((line, i) => {
    if (!UI_LINE_RE.test(line)) return
    let m
    STR_RE.lastIndex = 0
    while ((m = STR_RE.exec(line))) {
      const quote = m[1]
      const body = m[2]
      if (PURE_MASK_RE.test(body)) continue          // `***` 掩码不是 Markdown
      if (body.includes('**')) bold.push(`${rel(file)}:${i + 1}  「${body.slice(0, 80)}」`)
      if (quote !== '`' && body.includes('`')) tick.push(`${rel(file)}:${i + 1}  「${body.slice(0, 80)}」`)
    }
  })
  return { bold, tick }
}

function main() {
  console.log('== 界面文案守卫（Markdown 标记不得漏进界面）==')

  const files = walk(SRC)
  check('扫到源文件', files.length > 0, 'n=' + files.length + ' @ ' + rel(SRC))

  // ── A. App.vue 模板段 ────────────────────────────────────────────────
  const appVue = path.join(SRC, 'renderer', 'App.vue')
  let tplHits = []
  let tplLen = 0
  if (fs.existsSync(appVue)) {
    const raw = fs.readFileSync(appVue, 'utf-8')
    const s = raw.indexOf('<template>')
    // ⚠ 必须取**最后一个**行首 `</template>`：模板内部还有 `<template v-if>` 的成对标签，
    //   用 indexOf 会切在第一个内部闭合标签上 —— 那样切片只剩一小段，**后面的模板根本不被检查**
    //   （首版就是这么写的，反例注入 `**` 竟然还是绿）。
    const e = raw.lastIndexOf('\n</template>')
    if (s >= 0 && e > s) {
      const lineOffset = raw.slice(0, s).split('\n').length - 1
      const tpl = stripHtmlComments(raw.slice(s, e))
      tplLen = tpl.length
      tpl.split('\n').forEach((line, i) => {
        if (/\*\*/.test(line)) tplHits.push(`App.vue:${lineOffset + i + 1}  「${line.trim().slice(0, 100)}」`)
      })
    }
  }
  // 守卫自身有效性：切片若是空的/被截断的，下面那条断言会"永远绿" = 假绿
  check('模板区切片有效（长度合理，不是被内部闭合标签截断的空壳）',
    tplLen > 20000, 'len=' + tplLen)
  check('★ App.vue 模板区没有 Markdown 粗体标记（Vue 不解析 Markdown —— 用户会看到字面星号）',
    tplHits.length === 0, tplHits.join(' | '))

  // ── B/C. 界面文案行里的字符串 ────────────────────────────────────────
  const boldHits = []
  const tickHits = []
  for (const f of files) {
    const r = scanUiStrings(f)
    boldHits.push(...r.bold)
    tickHits.push(...r.tick)
  }
  check('★ 界面文案（howTo / toast / 提示语）里没有 Markdown 粗体标记 `**`',
    boldHits.length === 0, boldHits.slice(0, 6).join(' | '))
  check('★ 界面文案的单引号字符串里没有反引号（Markdown 行内代码）',
    tickHits.length === 0, tickHits.slice(0, 6).join(' | '))

  // ── 反例自证：剥注释逻辑本身是有效的（注释里的 ** 不该被算进来）──────
  const probe = stripHtmlComments('<!-- **这是注释** -->\n<b>**这是文案**</b>')
  check('剥注释逻辑有效（注释里的 ** 不算，正文里的算）',
    probe.split('\n')[0].includes('**') === false && probe.split('\n')[1].includes('**') === true)

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
