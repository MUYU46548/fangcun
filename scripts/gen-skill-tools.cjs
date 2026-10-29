#!/usr/bin/env node
/**
 * 把 MCP 工具清单从 **真源** 同步进接线卡（2026-10-29 暮雨第 9 条）。
 *
 * 病根：卡里写着「工具清单现场读 tools.ts 是唯一真源」，于是每个 agent 每次干活都要
 * 去 grep 一遍源码才知道有哪些工具、叫什么、参数长什么样 —— 这就是「每次都查一堆东西、
 * 极度浪费 token」的机械成因。清单写死在卡里又会漂移（历史上就滞后过）。
 *
 * 解法：卡里放一段**生成块**（`<!-- MCP-TOOLS:BEGIN -->` … `<!-- MCP-TOOLS:END -->`），
 * 由这个脚本从 `desktop/src/main/mcp/tools.ts` 抽出名字 + 描述首句重写。
 *   · 改工具 → `node scripts/gen-skill-tools.cjs`（`--check` 只核对不写，可进 CI）
 *   · 卡与真源不一致时 `check-skills.cjs` 不会红（它管版本号），所以这里自带 --check
 */

const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..')
const TOOLS_TS = path.join(REPO, 'desktop', 'src', 'main', 'mcp', 'tools.ts')
const CARDS = [
  path.join(REPO, 'skills', 'fangcun-bridge', 'SKILL.md'),
  path.join(REPO, 'docs', 'agents', 'fangcun-bridge', 'SKILL.md'),
]
const BEGIN = '<!-- MCP-TOOLS:BEGIN -->'
const END = '<!-- MCP-TOOLS:END -->'

/** 从 tools.ts 里按出现顺序抽 `name: 'x'` + 紧随的 description 首句。 */
function readTools() {
  const src = fs.readFileSync(TOOLS_TS, 'utf-8')
  const out = []
  const re = /\{\s*\n\s*name:\s*'([a-z_]+)',\s*\n\s*description:\s*\n?(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
  let m
  while ((m = re.exec(src))) {
    const name = m[1]
    const desc = (m[2] || m[3] || '').replace(/\\'/g, "'").replace(/\s+/g, ' ').trim()
    // 首句：到第一个句号/分号/破折号为止，最长 110 字
    const first = desc.split(/(?<=[.;])\s|—/)[0].slice(0, 110)
    out.push({ name, first })
    if (out.length > 200) break
  }
  return out
}

function block(tools) {
  const lines = []
  lines.push(BEGIN)
  lines.push('')
  lines.push(`> 由 \`scripts/gen-skill-tools.cjs\` 从 \`desktop/src/main/mcp/tools.ts\` 生成，共 **${tools.length}** 个。`)
  lines.push('> **不要手改这一段**，改工具后跑一次生成脚本。**也不用去读源码** —— 这张表就是现场。')
  lines.push('')
  lines.push('| 工具 | 干什么 |')
  lines.push('|---|---|')
  for (const t of tools) lines.push(`| \`${t.name}\` | ${t.first.replace(/\|/g, '\\|')} |`)
  lines.push('')
  lines.push(END)
  return lines.join('\n')
}

const tools = readTools()
if (!tools.length) {
  console.error('没从 tools.ts 抽到任何工具 —— 解析规则可能和源码写法对不上了，先修脚本')
  process.exit(1)
}
const newBlock = block(tools)
const checkOnly = process.argv.includes('--check')
let bad = 0

for (const card of CARDS) {
  if (!fs.existsSync(card)) { console.log(`跳过（不存在）：${path.relative(REPO, card)}`); continue }
  const src = fs.readFileSync(card, 'utf-8')
  const i = src.indexOf(BEGIN)
  const j = src.indexOf(END)
  if (i < 0 || j < 0) {
    console.log(`跳过（没有生成块）：${path.relative(REPO, card)}`)
    continue
  }
  const next = src.slice(0, i) + newBlock + src.slice(j + END.length)
  if (next === src) { console.log(`已是最新：${path.relative(REPO, card)}`); continue }
  if (checkOnly) { bad++; console.log(`落后于真源：${path.relative(REPO, card)}`); continue }
  fs.writeFileSync(card, next, 'utf-8')
  console.log(`已更新：${path.relative(REPO, card)}（${tools.length} 个工具）`)
}

if (checkOnly && bad) process.exit(1)
