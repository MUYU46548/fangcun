/**
 * 装完一键验收清单（2026-11-21）
 *
 * 打包后自动生成 `desktop/pkg/RELEASE-CHECKLIST.md`：本版所有「待验收」卡的判据原文。
 * 起因：P0-1 打包与发版 26 条里 13 条都是“装 X 后点三处”，全靠用户自己记；
 * 而方寸每次打包都有一批待验收卡，装完到底该点哪儿，从来没有一份东西回答。
 *
 * 纪律：
 *   · 版本号只从 `desktop/package.json` 读，不许手写；
 *   · 只收活跃区 `task-data/*.md` 且状态=待验收，归档/已签的不进；
 *   · 判据原文照抄（`## 判据` / `## 验收` / `## 验收线` / `## 验收判据` 段），
 *     没有就写“卡上没写判据段”，不替卡编判据；
 *   · 只读任务文件，不改任何东西。
 */
const fs = require('fs')
const path = require('path')

/** 极简 frontmatter 读取：只要标题/项目/状态/更新，够清单用；不引 yaml（打包脚本保持零依赖） */
function readFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text || ''))
  if (!m) return { fm: {}, body: String(text || '') }
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([^:：]+)[:：]\s*(.*)$/.exec(line)
    if (!mm) continue
    let v = mm[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    fm[mm[1].trim()] = v
  }
  return { fm, body: String(text).slice(m[0].length) }
}

/** 取判据段原文；没有就空串（调用方必须如实说“没写”，不能编） */
function pickCriteria(body) {
  const text = String(body || '').replace(/\r\n/g, '\n')
  const heads = ['## 判据', '## 验收', '## 验收线', '## 验收判据', '## 验收标准']
  let start = -1
  let headLen = 0
  for (const h of heads) {
    const i = text.indexOf(h)
    if (i >= 0 && (start < 0 || i < start)) { start = i; headLen = h.length }
  }
  if (start < 0) return ''
  const rest = text.slice(start + headLen)
  const next = rest.search(/\n##\s/)
  return (next >= 0 ? rest.slice(0, next) : rest).trim()
}

function loadPendingCards(taskDir) {
  if (!fs.existsSync(taskDir)) return []
  const out = []
  for (const name of fs.readdirSync(taskDir)) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue
    const p = path.join(taskDir, name)
    let text = ''
    try { text = fs.readFileSync(p, 'utf-8') } catch { continue }
    const { fm, body } = readFrontmatter(text)
    if (String(fm['状态'] || fm.status || '').trim() !== '待验收') continue
    out.push({
      id: String(fm['id'] || fm.id || name.replace(/\.md$/, '')),
      title: String(fm['标题'] || fm.title || name.replace(/\.md$/, '')),
      project: String(fm['项目'] || fm.project || ''),
      updated: String(fm['更新'] || fm.updated || ''),
      criteria: pickCriteria(body),
      file: name,
    })
  }
  out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.title.localeCompare(b.title))
  return out
}

function buildChecklist({ version, cards, generatedAt = new Date().toISOString() }) {
  const lines = [
    `# 方寸 ${version} 装完验收清单`,
    '',
    `生成时间：${generatedAt}`,
    '',
    `本版共 **${cards.length}** 张「待验收」卡。装完后逐条核对，每张卡点开 →「通过」或「驳回」。`,
    '清单里的判据是卡上原文；卡上没写判据段会如实标出，不替你编。',
    '',
  ]
  if (!cards.length) {
    lines.push('本版没有待验收卡。')
  } else {
    cards.forEach((c, i) => {
      lines.push(`## ${i + 1}. ${c.title}`)
      lines.push('')
      lines.push(`- 卡 id：\`${c.id}\``)
      if (c.project) lines.push(`- 项目：${c.project}`)
      if (c.updated) lines.push(`- 最后更新：${c.updated}`)
      lines.push('')
      if (c.criteria) {
        lines.push('**判据原文：**')
        lines.push('')
        lines.push(c.criteria)
      } else {
        lines.push('> 这张卡没有「## 判据 / ## 验收 / ## 验收线」段 —— 按卡正文里写的做，或先补判据。')
      }
      lines.push('')
    })
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function writeReleaseChecklist({ repoRoot, outDir, version, generatedAt }) {
  const cards = loadPendingCards(path.join(repoRoot, 'task-data'))
  const text = buildChecklist({ version, cards, generatedAt })
  const out = path.join(outDir, 'RELEASE-CHECKLIST.md')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(out, text, 'utf-8')
  return { path: out, cards: cards.length }
}

module.exports = { readFrontmatter, pickCriteria, loadPendingCards, buildChecklist, writeReleaseChecklist }
