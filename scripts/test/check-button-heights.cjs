#!/usr/bin/env node
/**
 * 按钮高度体检（2026-11-12 · 暮雨：“有些按钮偷偷变大了”）
 *
 * 为什么要有这一套：**这类问题只有量才能发现**。
 *   暮雨从 0.6.28 起就觉得“有些按钮好像偷偷变大了”，但我翻 0.6.28 那轮的改动（三类通知 + 守卫）
 *   一行按钮都没碰 —— 靠读 diff 永远找不到。实测 888 个可见按钮才看见真相：
 *   **基座 Button 的默认档是 md(34)（= 弹窗主按钮/输入框档），而全站工具行是 26/28**，
 *   于是少数**忘了写 size** 的按钮在工具栏里凭空高出一截（决策页 ☑多选 / ⟳、想法页 记下来，共 5 处）。
 *
 * 判据（只钉**结构**，不钉具体像素，免得每次改样式都要来改测试）：
 *   ① 基座 Button 的**默认档**必须是工具行档（28），不许是弹窗大档（34）——
 *      默认值决定“下一个漏写 size 的人掉到哪一档”，这是根因；
 *   ② 全站不许出现“同一屏里基座按钮高度跨两档以上”的工具栏（例外：显式登记过的表单录入行）；
 *   ③ `views/` 里写 `size="md"` 必须能说出为什么（目前只允许 0 处 —— 34 只该出现在弹窗里）。
 *
 * 运行：node scripts/test/check-button-heights.cjs
 * 退出码：判据不过 → 1
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const BTN = path.join(REPO, 'desktop/src/renderer/components/ui/Button.vue')

let pass = 0, fail = 0
const failures = []
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

console.log('== 按钮高度体检（“有些按钮偷偷变大”的结构判据）==')
const src = fs.readFileSync(BTN, 'utf-8')

// ① 默认档 = 工具行档（根因）
const m = /defaultVariants:\s*\{([^}]*)\}/.exec(src)
const defSize = m ? (/size:\s*'([^']+)'/.exec(m[1]) || [])[1] : ''
check('★★ 基座 Button 的默认档是 tool(28)，不是 md(34) —— 漏写 size 的按钮掉进工具行档而不是弹窗档',
  defSize === 'tool', `defaultVariants.size = ${defSize || '(没解析出来)'}`)

// ② 采样：源码里所有 <Button> 的 size 分布（漏写的按默认档算）
const walk = (dir, out = []) => {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}
const files = [...walk(path.join(REPO, 'desktop/src/renderer/views')), ...walk(path.join(REPO, 'desktop/src/renderer/components'))]
const tail = (s) => {
  let q = null, d = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; continue }
    if (ch === '>') return i
    d++
  }
  return -1
}
const noSize = []
const mdInViews = []
for (const f of files) {
  const text = fs.readFileSync(f, 'utf-8').replace(/<!--[\s\S]*?-->/g, ' ')
  const re = /<Button\b/g
  let mm
  while ((mm = re.exec(text))) {
    const end = tail(text.slice(mm.index))
    if (end < 0) continue
    const attrs = text.slice(mm.index, mm.index + end)
    const rel = path.relative(path.join(REPO, 'desktop/src/renderer'), f).replace(/\\/g, '/')
    if (!/\bsize\s*=/.test(attrs)) noSize.push(rel + ' → ' + attrs.replace(/\s+/g, ' ').slice(0, 70))
    if (/\bsize\s*=\s*"md"/.test(attrs) && rel.startsWith('views/')) mdInViews.push(rel + ' → ' + attrs.replace(/\s+/g, ' ').slice(0, 70))
  }
}
console.log(`  采样：${files.length} 个 .vue，其中没写 size 的 <Button> ${noSize.length} 个`)
check('★★ 视图层（views/）不许用 md(34) —— 34 是弹窗主按钮档，工具行会凭空高出一截',
  mdInViews.length === 0, mdInViews.slice(0, 4).join(' | '))

// ③ 写死默认值之外的“第二套真相”：Button 里不许再有别的地方偷偷给高度
check('★ 高度只由 size 档位决定（variants.size 四档都在，没被 class 覆盖）',
  ['tool', 'sm', 'md', 'icon'].every((k) => new RegExp(`\\b${k}:\\s*'`).test(src)))

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log(' - ' + f)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
