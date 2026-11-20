#!/usr/bin/env node
/**
 * 把 MCP 工具清单从 **真源** 同步进接线卡（2026-10-29 暮雨第 9 条）。
 *
 * 病根：卡里写着“工具清单现场读 tools.ts 是唯一真源”，于是每个 agent 每次干活都要
 * 去 grep 一遍源码才知道有哪些工具、叫什么、参数长什么样 —— 这就是“每次都查一堆东西、
 * 极度浪费 token”的机械成因。清单写死在卡里又会漂移（历史上就滞后过）。
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

/**
 * 取一条描述的首句（2026-11-20 修）。
 *
 * 原写法 `desc.split(/(?<=[.;])\s|—/)[0]` 有两个毛病，实测都会露在卡上：
 *   ① **中文句号后面没有空格** → 中文描述从来切不断，只能靠 110 字硬截，
 *      于是表里出现「…本工具保留名称/参数以兼容旧脚本，」这种**断在半句**的行；
 *   ② 硬截之后不留任何标记 → 读的人分不清"这句话就这么短"还是"被截了"。
 * 现在：中文 。； / 英文句号（后跟空白）都认；真超长才截，截了补 `…`。
 */
function firstSentence(desc) {
  const d = desc.replace(/\s+/g, ' ').trim()
  // `e.g.` / `i.e.` 里的点在英文描述里很常见 —— 不先遮住，首句就会断在 "client (e.g." 上
  const shield = d.replace(/\be\.g\./gi, 'e-g').replace(/\bi\.e\./gi, 'i-e')
  const cut = shield.search(/[。；]|\.(?=\s)/)
  let s = cut >= 0 ? shield.slice(0, cut + 1) : shield
  s = s.replace(/e-g/g, 'e.g.').replace(/i-e/g, 'i.e.')
  // 破折号前半句就够用（后半句通常是补充说明）
  const dash = s.split('—')[0].trim()
  if (dash.length >= 8) s = dash
  if (s.length > 110) s = s.slice(0, 110).replace(/[，,：:；;、\s]+$/, '') + '…'
  return s
}

/**
 * 从 tools.ts 里按出现顺序抽 `name: 'x'` + 紧随的 description 首句。
 *
 * ⚠ 2026-11-20 修的第二处（比首句切分更要紧）：tools.ts 的描述**是字符串拼接**
 *   （`'第一段，' + '第二段。'` 跨好几行），旧正则只吃第一个字面量 ——
 *   于是卡上好几行都是「…兼容旧脚本，」这样的**半句**，而 `--check` 报"已是最新"，
 *   因为两边确实一致：一致地残缺。现在把整段表达式里的所有字面量拼起来再取首句。
 */
function readTools() {
  const src = fs.readFileSync(TOOLS_TS, 'utf-8')
  const out = []
  const re = /\{\s*\n\s*name:\s*'([a-z_]+)',\s*\n\s*description:\s*\n?([\s\S]*?)\n\s*inputSchema:/g
  let m
  while ((m = re.exec(src))) {
    const name = m[1]
    // 行注释不是描述（tools.ts 里常在拼接中间写一段 `// 2026-11-17 …`）
    const expr = m[2].replace(/\/\/[^\n]*/g, '')
    const parts = []
    const lit = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g
    let s
    while ((s = lit.exec(expr))) parts.push(s[1] !== undefined ? s[1] : s[2])
    const desc = (parts.length ? parts.join('') : expr).replace(/\\'/g, "'").replace(/\\n/g, ' ')
    out.push({ name, first: firstSentence(desc) })
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
