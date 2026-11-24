#!/usr/bin/env node
/**
 * 日志文件健康（2026-11-24 · 事故后加）
 *
 * ## 事故经过（必须记住，这是我自己造成的）
 *
 * 暮雨：「日志怎么少了一条进行中？你偷签完成了吗」
 *
 * 我用 PowerShell `Set-Content -Encoding utf8` 批量改日志「下一步」的处置标记。
 * **PowerShell 的 `-Encoding utf8` 会写 UTF-8 BOM**（3 字节 `EF BB BF`）。
 * 于是文件第一行从 `---` 变成 `\uFEFF---`，而产品解析器的正则是 `/^---/`
 * —— **匹配失败 → 整份 frontmatter 读不出来 → 所有字段全丢**。
 *
 * 后果正是用户看到的：**一条「进行中」从客户端消失了**（它还在文件里，
 * 但 `running: true` 已经不是字段，而是块标量正文里的一行字）。
 *
 * 证据：18 个带 BOM 的日志，**mtime 全是当天**；`.backup` 里 1149 份历史备份
 * **0 个**带 BOM。所以 100% 是我改出来的，不是历史问题。
 *
 * ## 这个守卫钉什么
 *
 *   ① **文件不许带 UTF-8 BOM**（第一条最要命：它会让整份 frontmatter 失效）
 *   ② frontmatter 必须能被 `^---` 配对（有头有尾）
 *   ③ `running` / `status` 这类生命周期字段**不许漏进正文**
 *      （漏进去 = 字段还在但读不到，比没有更骗人）
 *   ④ 用**产品自己的解析器**回读一遍，`running` 要与文件里的声明一致
 *      （只查文本不够 —— 文本对、解析器读不到，照样是客户端少一条）
 *
 * 运行：node scripts/test/check-log-files.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const LOGS = path.join(REPO, 'docs', '执行日志')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(LOGS)) {
  console.log('SKIP  没有 docs/执行日志 目录')
  console.log('RESULT SKIP')
  process.exit(0)
}

const files = fs.readdirSync(LOGS).filter((f) => f.endsWith('.md'))
  .filter((f) => fs.statSync(path.join(LOGS, f)).isFile())

console.log('== 日志文件健康 ==')
console.log('   扫描', files.length, '份日志')

// ── ① BOM（最要命）──────────────────────────────────────────────────────
const withBom = []
for (const f of files) {
  const b = fs.readFileSync(path.join(LOGS, f))
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) withBom.push(f)
}
check('★★★ 没有任何日志带 UTF-8 BOM（BOM 会让整份 frontmatter 读不出来 → 客户端少一条）',
  withBom.length === 0, withBom.slice(0, 8).join(' | '))

// ── ② frontmatter 成对 ──────────────────────────────────────────────────
const noClose = []
for (const f of files) {
  const lines = fs.readFileSync(path.join(LOGS, f), 'utf-8').split(/\r?\n/)
  if (lines[0].trim() !== '---') { noClose.push(f + '(首行不是 ---)'); continue }
  let closed = false
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { closed = true; break }
  if (!closed) noClose.push(f + '(没有收口 ---)')
}
check('★★ 每份日志的 frontmatter 都有头有尾', noClose.length === 0, noClose.slice(0, 8).join(' | '))

// ── ③ 产品正则能匹配（这才是客户端读得到的充要条件）───────────────
//
// ⚠ 我第一版这条判据写错了：它去查"`running:` 是否出现在「收口行之后」"，
//   而**正常格式**恰恰长这样（`renderLog` 的产出）：
//     _next_steps: |-         ← 块标量开始
//       1. 第一条
//     session_id: null        ← 块结束、回到顶格，**仍在 frontmatter 内**
//     running: true
//     ---                     ← 收口
//   我当时把"第一个缩进 ---（正文里的表格分隔线）"当成了收口，于是误判。
//
// 真正该钉的是：**产品的解析正则能不能匹配**。
// 能匹配 = 客户端读得到；匹配不上 = 整条日志在客户端消失（这次事故的样子）。
const RE_FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
const unparsable = []
for (const f of files) {
  const c = fs.readFileSync(path.join(LOGS, f), 'utf-8')
  if (!RE_FM.test(c)) unparsable.push(f)
}
check('★★★ 每份日志都能被产品解析正则匹配（匹配不上 = 客户端整条消失）',
  unparsable.length === 0, unparsable.slice(0, 8).join(' | '))

// ── ④ 用产品自己的解析器回读（文本对 ≠ 解析得到）──────────────────────
if (fs.existsSync(path.join(DIST, 'services', 'logs.js'))) {
  try {
    const data = require(path.join(DIST, 'data', 'index.js'))
    data.setDataDir(REPO)
    const logs = require(path.join(DIST, 'services', 'logs.js'))
    const parsed = logs.listLogs({})
    const byId = new Map(parsed.map((l) => [l.id, l]))

    // 每份文件里声明 running: true 的，解析器也必须读到 true
    const mismatch = []
    for (const f of files) {
      const txt = fs.readFileSync(path.join(LOGS, f), 'utf-8')
      const lines = txt.split(/\r?\n/)
      if (lines[0].trim() !== '---') continue
      let end = -1
      for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break }
      if (end < 0) continue
      const fm = lines.slice(1, end)
      const declared = fm.some((l) => /^running:\s*true\s*$/.test(l.trim()))
      if (!declared) continue
      const id = f.replace(/\.md$/, '')
      const got = byId.get(id)
      if (!got) { mismatch.push(`${f}(解析器没读到这条)`); continue }
      if (got.running !== true) mismatch.push(`${f}(文件说 true，解析器读到 ${got.running})`)
    }
    check('★★★ 文件声明 running:true 的，产品解析器也必须读到 true',
      mismatch.length === 0, mismatch.slice(0, 6).join(' | '))
    console.log(`     解析器读到 ${parsed.length} 份日志 / ${
      parsed.filter((l) => l.running === true).length} 份进行中`)
  } catch (e) {
    check('用产品解析器回读', false, String(e && e.message).slice(0, 160))
  }
} else {
  console.log('SKIP  编译产物不在（先 cd desktop && npm run build）—— 第 ④ 条跳过')
}

console.log(`\nRESULT ${pass} / ${pass + fail}`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
