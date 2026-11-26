/**
 * 派单闸 e2e：**没有用户点击 → 不产生派单；真点一次 → 才产生一份**。
 *
 * 2026-11-19 · 卡「施工当前真点击 e2e：让 e2e-renderer 真开真点，SKIP 判失败」。
 *
 * 为什么单独一条命令：卡上的判据写的就是它 ——
 *   `node scripts/test/e2e-dispatch-click-only.cjs` 退出码 0
 * 它验两件事，缺一不可：
 *
 *   ① **运行时**（真 Electron + 真 DOM 点击，`FC_E2E_ONLY=dispatch` 只跑那 5 条）：
 *      启动后零点击 → `dispatchDsh` 调用数 0；打开项目详情但没点按钮 → 仍是 0；
 *      真点「发送给 DSH」→ 才 1 次（demo / kind=work）。不碰真实 `.dispatch-dsh/`。
 *   ② **静态**（源码守卫）：渲染层里对派单通道的**调用**只许出现在
 *      `App.vue` 的 `dispatchToDsh` 函数体里，且那个函数只许被模板的 `@click` 引用。
 *      脚本里任何别的地方出现 `dispatchToDsh(` / `dispatchDsh(` 都判失败 ——
 *      那正是"没人点也会派单"的形态（onMounted / watch / 定时器里顺手派一单）。
 *
 * ⚠ 失败即非零退出；**SKIP 不是通过**（与 e2e-renderer 同一口径）。
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')
const INDEX = path.join(DESKTOP, 'dist', 'renderer', 'index.html')
const MAIN = path.join(DESKTOP, 'test', 'renderer-main.cjs')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

// ── 一、静态守卫：渲染层不许有"无人点击"的派单调用点 ────────────────────
const RENDERER = path.join(DESKTOP, 'src', 'renderer')
const REF = /dispatch(?:ToDsh|Dsh)/

const files = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(vue|ts)$/.test(e.name)) files.push(p)
  }
})(RENDERER)

let templateSites = 0
const badSites = []
let sawDefinition = false
let sawChannelCall = false
/**
 * 脚本里除了 `dispatchToDsh` 定义体，**第二条合法入口**（2026-11-26）：
 * 规划弹窗的「发送规划」按钮 → `emit('send')` → `App#sendPlanDispatch` → `dispatchToDsh`。
 * 它是用户点击的第二跳，不是"无人点击就派单"；这里不靠注释放行，另加两条接线断言
 * （弹窗真有 `@click="send"` + `emit('send')`，App 真有 `@send="sendPlanDispatch"`），
 * 少一条就红 —— 否则这个白名单会把真正的自动派单也洗白。
 */
const ALLOW_CALL_FN = new Map([
  ['sendPlanDispatch', '规划派单弹窗：用户点「发送规划」才走到这里'],
])
let allowedCallSites = 0

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  const src = fs.readFileSync(f, 'utf8')
  // SFC 里 <template> 在前、<script> 在后；按最后一个 `<script` 切。
  const scriptAt = src.lastIndexOf('\n<script')
  const tpl = scriptAt >= 0 ? src.slice(0, scriptAt) : src
  const script = scriptAt >= 0 ? src.slice(scriptAt) : ''

  // ① 模板里：派单引用必须挂在 @click 上（"用户点才派"的唯一合法形态）
  tpl.split('\n').forEach((line, i) => {
    if (!REF.test(line)) return
    templateSites++
    if (!/@click/.test(line)) badSites.push(`${rel}:${i + 1} 模板里出现派单引用，但不在 @click 上`)
  })

  // ② 脚本里：只有 App.vue 的定义体是合法区；其余出现"调用"都判失败
  let defStart = -1
  let defEnd = -1
  if (rel.endsWith('/renderer/App.vue')) {
    // 允许的"第二跳"函数体范围（见 ALLOW_CALL_FN 注释；只为不让它被误判成自动派单）
    const allowedRanges = []
    for (const [name, why] of ALLOW_CALL_FN) {
      const start = script.indexOf(`async function ${name}(`)
      if (start < 0) continue
      const tail = script.slice(start).search(/\r?\n\}\r?\n/)
      allowedRanges.push({ start, end: tail >= 0 ? start + tail + 3 : script.length, name, why })
    }
    defStart = script.indexOf('async function dispatchToDsh(')
    if (defStart >= 0) {
      // ⚠ 本仓是 CRLF（Windows 工作区）：只找 '\n}\n' 会永远落空，
      // 回落成 script.length 后 "函数体" = 文件剩余全部 → 守卫变味。
      const tail = script.slice(defStart).search(/\r?\n\}\r?\n/)
      defEnd = tail >= 0 ? defStart + tail + 3 : script.length
      sawDefinition = true
      const body = script.slice(defStart, defEnd)
      // 源码守卫先剥注释再扫（注释里写"不 spawn"是解释，不是调用）
      const code = body.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      sawChannelCall = /tegula\.dispatchDsh\s*\(/.test(code)
      check('静态守卫 · 派单函数体确实调用主进程通道 tegula.dispatchDsh', sawChannelCall)
      check('静态守卫 · 派单函数体不 spawn / exec 进程（只落文件，不拉起会话）',
        !/child_process|spawn\s*\(|exec\s*\(/.test(code))
    }
    let off = 0
    script.split('\n').forEach((line, i) => {
      const lineStart = off
      off += line.length + 1
      if (!REF.test(line)) return
      if (lineStart >= defStart && lineStart <= defEnd) return // 定义体内部
      const allowed = allowedRanges.find((r) => lineStart >= r.start && lineStart <= r.end)
      if (allowed) { allowedCallSites++; return }
      // setup 暴露（`... dispatchToDsh, ...`）：不是调用，允许
      if (!/dispatchToDsh\s*[.(]/.test(line)) return
      badSites.push(`${rel}:${i + 1} 脚本里出现派单调用（定义/暴露之外）→ 可能无人点击就派单`)
    })
  } else {
    script.split('\n').forEach((line, i) => {
      if (REF.test(line)) badSites.push(`${rel}:${i + 1} 渲染层脚本里直接引用派单通道`)
    })
  }
}

check('静态守卫 · 找到了派单函数定义（否则本守卫是空转）', sawDefinition)
check('静态守卫 · 模板里至少有一处 @click 派单入口（否则守卫是空转）', templateSites >= 1, 'sites=' + templateSites)
check('静态守卫 · 没有任何"无人点击"的派单调用点', badSites.length === 0, badSites.join(' | '))

// 白名单不是"写个名字就放行"：它必须真被扫到，而且两跳接线都在。
{
  const appSrc = fs.readFileSync(path.join(RENDERER, 'App.vue'), 'utf8')
  const dlgSrc = fs.readFileSync(path.join(RENDERER, 'components', 'PlanDispatchDialog.vue'), 'utf8')
  check('★ 规划派单的第二跳真的被扫到（白名单不是空登记）', allowedCallSites >= 1, `sites=${allowedCallSites}`)
  check('★★ 第二跳确实由弹窗按钮触发（弹窗有 @click="send" + emit(send) + App 有 @send）',
    /@click="send"/.test(dlgSrc) && /emit\('send'/.test(dlgSrc) && /@send="sendPlanDispatch"/.test(appSrc))
}

const preloadSrc = fs.readFileSync(path.join(DESKTOP, 'test', 'renderer-preload.cjs'), 'utf8')
check('静态守卫 · 假 preload 记账 dispatchDsh（运行时断言才不是纸面事实）', /rec\('dispatchDsh'/.test(preloadSrc))

// ── 花钱动作的视觉提示：**按"那个按钮自己"判，不是按文件判** ──────────────
//
// ⚠⚠ 2026-11-23（卡 5c315cb7，用户原话「付费任务按钮特殊标识仅在部分地方实装」）：
//   第一版这里只 `readFileSync(ProjectsView.vue)` 数 `data-cost` 出现次数 —— 于是
//   日志页「发送给 DSH」和架构图「让 DSH 画图」**两个真花钱入口漏了 ¥ 角标，守卫一直是绿的**。
//
//   第二版改成"宿主文件里出现过 data-cost 就算过"——**仍然是假绿**：我把 `data-cost` 从按钮上
//   删掉做了反例，守卫照样 PASS，因为**注释里还留着一句"这里必须写 data-cost"**。
//   这正是本项目反复栽的同一个坑：判据钉在"文件里有没有这个字符串"，而不是"那个按钮有没有它"。
//
//   现在：剥注释 → 找**带派单调用的那个 `<Button …>` 标签本身** → 断言它自己带 data-cost。
//   反例已自证：删掉 `data-cost` → 精确红（见本文件末尾的注释）。
const stripComments = (s) => s
  .replace(/<!--[\s\S]*?-->/g, '')          // HTML 注释
  .replace(/\/\*[\s\S]*?\*\//g, '')         // 块注释
  .replace(/^\s*\/\/.*$/gm, '')             // 行注释

// 「会开 DSH 会话」的按钮识别：**三条路都要认**，缺一条就是假绿（反例自证过两次）。
//
//  ① 按钮上直接有调用：`@click="ctl.dispatchToDsh(...)"`
//  ② 按钮通过 `emit('xxx')` 往父组件抛，父组件再派单：
//     `ArchDiagram.vue` 的按钮是 `@click="emit('generate')"`，真正的 `archGenerate` 在 `App.vue`。
//     只认 ① 的话，架构图那个按钮**永远不会被检查**（这就是第一版反例假绿的原因）。
//  ③ `@click` 指向本地函数，函数体里再调用（如 `generateSelfArch`）。
//
// 判据不是"字符串出现过"，而是：**这个按钮的点击，最终会不会到达一个花钱的通道**。
// 实现上用两级解析：先收集本文件里"会派单的函数名"（含 emit 出去的），再看按钮 @click 命中哪个。
const PAID_VERB_RE = /(?:dispatchDsh|dispatchMessageDsh|dispatchToDsh|dispatchLogToDsh|archGenerate|runDocToDsh|dispatchArchToDsh|ctl\.runBatch)\s*\(/
// 父子组件契约：这些 emit 事件名最终由父组件里同名的 handler 派单（架构图 / 文档拆卡）
const PAID_EMIT = new Set(['generate', 'runDocToDsh'])

/** 从一个 .vue 源码里找出"会花钱"的本地函数名集合 */
function paidFnNames(src) {
  const code = stripComments(src)
  const names = new Set()
  // function xxx(...) { ... PAID ... }
  const re = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g
  let m
  while ((m = re.exec(code))) {
    // 取到函数体（粗略：找到下一个顶格 } ）
    const rest = code.slice(m.index)
    const body = rest.slice(0, Math.min(rest.length, 2000))
    if (PAID_VERB_RE.test(body)) names.add(m[1])
  }
  // 组合式：const xxx = async (...) => { ... }
  const re2 = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g
  while ((m = re2.exec(code))) {
    const rest = code.slice(m.index)
    const body = rest.slice(0, Math.min(rest.length, 2000))
    if (PAID_VERB_RE.test(body)) names.add(m[1])
  }
  return names
}

/**
 * 引号感知的标签扫描器。
 *
 * ⚠⚠ 为什么不能用正则 `<(Button|button)\b(...)>`（2026-11-23 实测踩到）：
 *   属性值里出现中文引号/单引号/换行时，`[^>"']` 与 `"..."` 的交替会错位，
 *   于是一个标签会把**后面好几个标签一起吞掉**（实测 `<button v-if="busy">` 的 attrs
 *   一路吞到下一个 `<Button class="archd-gen">`）。
 *   后果极隐蔽：**检查的还是第一个标签**，而真正的付费按钮从没被看过 —— 反例自证假绿两次都是它。
 *   所以这里手写状态机：只有**不在引号内**的 `>` 才算标签结束。
 */
function scanTags(text, tagName) {
  const out = []
  const needle = '<' + tagName
  let i = 0
  while ((i = text.indexOf(needle, i)) >= 0) {
    const after = text.charAt(i + needle.length)
    if (after && !/[\s>/]/.test(after)) { i += needle.length; continue } // <ButtonXxx 不算
    let j = i + needle.length
    let quote = ''
    for (; j < text.length; j++) {
      const ch = text[j]
      if (quote) { if (ch === quote) quote = ''; continue }
      if (ch === '"' || ch === "'") { quote = ch; continue }
      if (ch === '>') break
    }
    if (j >= text.length) break
    out.push({ attrs: text.slice(i + needle.length, j), index: i })
    i = j + 1
  }
  return out
}

const paidButtons = []    // { rel, tag, hasCost, why }
for (const f of files.filter((x) => x.endsWith('.vue'))) {
  const raw = fs.readFileSync(f, 'utf8')
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  const tpl = stripComments((raw.match(/<template>([\s\S]*)<\/template>/) || [])[1] || '')
  const fns = paidFnNames(raw)
  for (const b of scanTags(tpl, 'Button').concat(scanTags(tpl, 'button'))) {
    const attrs = b.attrs || ''
    const clickM = /@click(?:\.\w+)*\s*=\s*"([^"]*)"/.exec(attrs)
    if (!clickM) continue
    const handler = clickM[1]
    let why = ''
    if (PAID_VERB_RE.test(handler)) why = '直接调用'
    else {
      const emitM = /emit\(\s*['"]([^'"]+)['"]/.exec(handler)
      if (emitM && PAID_EMIT.has(emitM[1])) why = `emit('${emitM[1]}')`
    }
    if (!why) {
      // 看点名的本地函数（可能有 `foo()` 或多层）
      for (const fn of fns) {
        if (new RegExp('\\b' + fn.replace(/[$]/g, '\\$') + '\\s*\\(').test(handler)) { why = '本地函数 ' + fn; break }
      }
    }
    if (!why) continue
    paidButtons.push({
      rel,
      tag: (attrs.match(/class="([^"]*)"/) || [])[1] || '',
      hasCost: /\bdata-cost\b/.test(attrs),
      why,
    })
  }
}
check('静态守卫 · 扫到了「点击即开会话」的按钮（否则本条是空转）', paidButtons.length >= 5,
  `找到 ${paidButtons.length} 个：` + paidButtons.map((b) => b.rel.split('/').pop() + '[' + b.why + ']').join(', '))

const noCost = paidButtons.filter((b) => !b.hasCost)
check('★★ 静态守卫 · 每个「点击即开会话」的按钮**自己**带 data-cost（不看文件里别处写没写）',
  noCost.length === 0,
  noCost.length ? '缺标识：' + noCost.map((b) => `${b.rel} [${b.tag || '(无 class)'}]`).join(' | ') : '')

// 反向判据：只写剪贴板、不花钱的「打包给 DSH」不该带 ¥ —— 防以后一律乱标。
const askTpl = stripComments(fs.readFileSync(path.join(RENDERER, 'views', 'AskView.vue'), 'utf8'))
const pkgTag = (askTpl.match(/<Button[^>]*askToDshPackage[^>]*>/) || [])[0] || ''
check('静态守卫 · 「打包给 DSH（不调模型）」不花钱 → 不该带 data-cost（反向判据）',
  pkgTag !== '' && !/\bdata-cost\b/.test(pkgTag), pkgTag.slice(0, 100))

const cssSrc = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'styles', 'app.css'), 'utf8')
check('静态守卫 · app.css 有 button[data-cost] 的描边 + ¥ 角标规则',
  /button\[data-cost\]/.test(cssSrc) && /button\[data-cost\]::after/.test(cssSrc))

// ── 死类守卫：`<Button class="xxx">` 上的 class 必须有 CSS 规则 ─────────────
//
// ⚠ 2026-11-23（同卡）：`check-button-styles.cjs:348` 把 `<Button` 开头的标签整个 `continue` 掉了
//   （理由是"基座的几何在组件里"），但**没有补一条"那 class 自己有没有规则"**。
//   于是 `.log-dsh-btn`（日志页「发送给 DSH」）和 `.pf-mission-draft` 挂了半年死类，
//   没有任何守卫能发现 —— 用户看到的"同一个东西每处长得不一样"就是这么来的。
// 判据：<Button> 上出现的 class，必须能被 `app.css` 或该组件自己的 `<style>` 命中。
// Tailwind 工具类/任意值类不在本项目 class 命名空间里（由 cn()/tailwind 处理），白名单排除并打印。
const TW_UTIL = /^(?:[!-]?(?:flex|grid|inline|block|hidden|items-|justify-|gap-|px-|py-|p-|m[trblxy]?-|w-|h-|min-|max-|text-|font-|rounded|border|bg-|shrink|grow|cursor-|opacity-|leading-|whitespace-|outline-|transition|duration-|shadow|appearance|select-|overflow-|inset-|top-|right-|bottom-|left-|z-|order-|col-|row-|self-|place-|content-|space-|divide-|ring-|focus:|hover:|disabled:|group|peer))|^font-\[|^w-\[|^h-\[|^px-|^py-|^mr-|^ml-|^mt-|^mb-/

{
  // 全站样式（app.css）+ 每个 .vue 自己的 scoped <style>，都是"规则可能住的地方"
  let siteCss = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'styles', 'app.css'), 'utf8')
  const deadClasses = []   // { rel, cls }
  const twSkipped = []
  let checked = 0
  for (const f of files.filter((x) => x.endsWith('.vue'))) {
    const raw = fs.readFileSync(f, 'utf8')
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    const tpl = (raw.match(/<template>([\s\S]*)<\/template>/) || [])[1] || ''
    const style = (raw.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [])[1] || ''
    const css = siteCss + '\n' + style
    const re = /<Button\b([^>]*)>/g
    let m
    while ((m = re.exec(tpl))) {
      const cm = /class="([^"]*)"/.exec(m[1])
      if (!cm) continue
      for (const c of cm[1].split(/\s+/).filter(Boolean)) {
        if (TW_UTIL.test(c)) { twSkipped.push(c); continue }
        checked++
        const esc = c.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
        if (!new RegExp('\\.' + esc + '(?![\\w-])').test(css)) deadClasses.push({ rel, cls: c })
      }
    }
  }
  check('死类守卫 · 确实扫到了 <Button class="…">（否则本条是空转）', checked >= 20, `扫了 ${checked} 个 class`)
  const uniqDead = [...new Set(deadClasses.map((d) => '.' + d.cls))]
  check('★★ 死类守卫 · <Button> 上的每个 class 都有 CSS 规则命中（不许挂个没人管的类）',
    deadClasses.length === 0,
    deadClasses.length
      ? uniqDead.join(', ') + ' ← ' + [...new Set(deadClasses.map((d) => d.rel))].join(', ')
      : `排除 Tailwind 工具类 ${new Set(twSkipped).size} 个`)
}

const mainSrc = fs.readFileSync(MAIN, 'utf8')
check('静态守卫 · renderer-main 同时有「零点击不派单」与「真点一次才派单」两条断言',
  /启动后零点击/.test(mainSrc) && /真点一次「发送给 DSH」/.test(mainSrc))

if (fail) {
  console.log(`\n静态守卫失败 ${fail} 条 —— 不进入运行时。`)
  process.exit(1)
}

// ── 二、运行时：真 Electron，零点击 → 0 次；真点一次 → 1 次 ───────────────
if (!fs.existsSync(ELECTRON)) {
  console.log('FAIL  找不到 electron 可执行文件:', ELECTRON)
  process.exit(1)
}
if (!fs.existsSync(INDEX)) {
  console.log('FAIL  找不到渲染层构建产物:', INDEX, '—— 请先 npm run build')
  process.exit(1)
}

const args = ['--no-sandbox', '--disable-gpu', MAIN, '--hidden']
const env = { ...process.env, FC_E2E_RENDERER: '1', FC_E2E_ONLY: 'dispatch', FC_E2E_COST_CONFIRM: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
delete env.ELECTRON_RUN_AS_NODE

// 2026-11-25：windowsHide —— 无控制台的父进程下会闪一个黑窗（暮雨实测）。
// 对 GUI 程序它只抑制控制台分配，不影响 Electron 自己的窗口。
const child = spawn(ELECTRON, args, { cwd: DESKTOP, stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true })
let out = ''
child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d) })
child.stderr.on('data', (d) => {
  const s = d.toString()
  out += s
  if (!/DevTools|GPU|gpu_|cache|Vulkan|ERROR:gpu/.test(s)) process.stdout.write(s)
})

child.on('close', (code) => {
  if (/RESULT SKIP/.test(out)) {
    console.log('\nFAIL  派单闸 e2e 被跳过：本机开不起来 ≠ 通过（SKIP 判失败）')
    process.exit(1)
  }
  const m = out.match(/RESULT (\d+) \/ (\d+)/)
  if (!m) {
    console.log('\nFAIL  派单闸 e2e 未产出结果（Electron 中途退出，退出码 ' + code + '）')
    console.log('      tail: ' + out.trim().split('\n').slice(-4).join(' ⏎ '))
    process.exit(1)
  }
  const c = out.match(/CLICKS (\d+)/)
  const clicks = c ? Number(c[1]) : -1
  const runtimeFail = Number(m[2])
  const runtimePass = Number(m[1])
  check('运行时 · 派单闸断言全过（' + runtimePass + ' 条）', runtimeFail === 0, 'fail=' + runtimeFail)
  check('运行时 · 真的点了 DOM（CLICKS > 0）', clicks > 0, 'clicks=' + (clicks < 0 ? '缺失' : clicks))

  console.log(`\n派单闸 e2e 汇总：${pass} / ${fail} · 真点击 ${clicks < 0 ? '缺失' : clicks} 次`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  process.exit(fail ? 1 : 0)
})

setTimeout(() => {
  console.log('FAIL  派单闸 e2e 超时（90s）')
  try { child.kill() } catch { /* ignore */ }
  process.exit(1)
}, 90000)
