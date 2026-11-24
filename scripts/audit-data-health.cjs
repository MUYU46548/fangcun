#!/usr/bin/env node
/**
 * 全项目「数据文件健康」排查（2026-11-24 · 事故后加）
 *
 * ## 起因（暮雨的原话）
 *
 * > 「这又是一场非常严重的事故，差点永远留下而且永远没人发现。
 * >   包括方寸在内，各项目像这样被偷偷改坏的东西还有多少？」
 *
 * ## 这次事故是什么
 *
 * 我用 PowerShell `Set-Content -Encoding utf8` 批量改日志，**它写 UTF-8 BOM**。
 * 文件第一行从 `---` 变成 `\uFEFF---` → 产品解析正则 `/^---/` 匹配失败
 * → **整份 frontmatter 读不出来 → 所有字段全丢**（包括 `running: true`）。
 * 用户看到的就是「少了一条进行中」。
 *
 * 18 个文件被这么改坏，`.backup` 里 1149 份历史备份**零个**带 BOM —— 铁证是我改的。
 *
 * ## 为什么这场事故"差点永远没人发现"
 *
 * 因为它**不报错**。文件还在、内容还在、字数差不多，只有**解析器读不到**。
 * 而且症状是"某一条不见了"这种模糊现象，很容易被当成 UI 问题慢慢忘掉。
 *
 * ## 这个脚本干什么
 *
 * 把"数据文件被改坏"这件事变成**可机检**的，并且**跨项目扫**：
 *   ① 每个项目仓库里的 Markdown 数据文件：BOM / frontmatter 成对 / 能否用标准 YAML 解析
 *   ② 方寸自己的 task-data / policies / memory：同样四条
 *   ③ JSON / JSONL 文件：能否解析（坏一行就报行号）
 *
 * ⚠ 只读，不改任何文件。发现坏的就**如实列出来**，不自动修
 *   （自动修 = 又一次未经确认的写操作，正是这次事故的性质）。
 *
 * 跑法：node scripts/audit-data-health.cjs [--json]
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..')
const AS_JSON = process.argv.includes('--json')
const yaml = (() => { try { return require(path.join(REPO, 'desktop', 'node_modules', 'js-yaml')) } catch { return null } })()

const BOM = Buffer.from([0xEF, 0xBB, 0xBF])
const RE_FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

/**
 * 产品自己的解析器（按文件路径猜不到，只能按内容试两家）。
 * 存在的意义：**"标准 YAML 解析不了" ≠ "产品读不到"** ——
 * 产品的解析器各有容错读法（记忆的 `parseFrontmatter` 就是逐行 kv，不挑 YAML）。
 * 所以只有在**产品也读不到**时才算问题，否则是标准库太严。
 */
let _productParsers = null
function requireProductParser() {
  if (_productParsers !== null) return _productParsers
  try {
    const D = path.join(REPO, 'desktop', 'dist', 'main')
    const data = require(path.join(D, 'data', 'index.js'))
    data.setDataDir(REPO)
    const mem = require(path.join(D, 'services', 'memory.js'))
    _productParsers = (text) => {
      // 记忆口径：逐行 kv，能解出 id 就算读到
      const r = mem.parseFrontmatter(text)
      if (r && r.fm && r.fm.id) return r.fm
      throw new Error('product cannot read')
    }
  } catch {
    _productParsers = null
  }
  return _productParsers
}

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2]
}

/** 扫一棵树里的 .md，返回问题清单 */
function scanMdTree(root, opts = {}) {
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'release', '.test-tmp', '_attachments', '.trash'])
  const out = []
  let scanned = 0
  const walk = (dir, depth) => {
    if (depth > 6) return
    let names = []
    try { names = fs.readdirSync(dir) } catch { return }
    for (const n of names) {
      const p = path.join(dir, n)
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.isDirectory()) {
        if (skipDirs.has(n)) continue
        walk(p, depth + 1)
        continue
      }
      if (!n.endsWith('.md')) continue
      scanned++
      const buf = fs.readFileSync(p)
      const rel = path.relative(REPO, p).replace(/\\/g, '/')
      if (hasBom(buf)) out.push({ file: rel, kind: 'bom', detail: 'UTF-8 BOM（会让 ^--- 匹配失败）' })
      const text = buf.toString('utf-8').replace(/^\uFEFF/, '')
      // ⚠ 判据要准，别把普通 Markdown 当 frontmatter 文件误报（2026-11-24 实测踩到）：
      //   NovelForge 的 `prompts/*.md` 以 `---`（水平分割线）开头，但整份是**纯 Markdown**，
      //   本来就没有 frontmatter。把它报成"YAML 解析失败"是噪音 —— 噪音多了守卫就废了。
      //   判据：`---` 之后**必须出现 `key: value` 形状的行**才算 frontmatter 文件。
      if (text.startsWith('---')) {
        const lines = text.split('\n')
        let closed = -1
        for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { closed = i; break }
        if (closed < 0) {
          out.push({ file: rel, kind: 'fm-no-close', detail: 'frontmatter 没有收口 ---' })
        } else {
          const fmBody = lines.slice(1, closed)
          const looksLikeFm = fmBody.some((l) => /^[A-Za-z_][A-Za-z0-9_]*:\s*\S/.test(l))
            || fmBody.some((l) => /^[A-Za-z_][A-Za-z0-9_]*:\s*$/.test(l))
          if (looksLikeFm && yaml) {
            try { yaml.load(fmBody.join('\n')) } catch (e) {
              // 但如果**产品自己的解析器能读**，就不算问题（产品有容错读法）
              let productOk = false
              try {
                const mf = requireProductParser()
                if (mf) { mf(text); productOk = true }
              } catch { /* 读不了就如实报 */ }
              if (!productOk) {
                out.push({ file: rel, kind: 'fm-yaml', detail: String(e.message).split('\n')[0].slice(0, 120) })
              }
            }
          }
        }
      }
    }
  }
  walk(root, 0)
  return { scanned, issues: out }
}

/** 扫 JSON / JSONL */
function scanJsonTree(root) {
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'release', '.test-tmp', '_attachments', '.trash'])
  const out = []
  let scanned = 0
  const walk = (dir, depth) => {
    if (depth > 6) return
    let names = []
    try { names = fs.readdirSync(dir) } catch { return }
    for (const n of names) {
      const p = path.join(dir, n)
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.isDirectory()) { if (!skipDirs.has(n)) walk(p, depth + 1); continue }
      const isJson = n.endsWith('.json')
      const isJsonl = n.endsWith('.jsonl')
      if (!isJson && !isJsonl) continue
      // 跳过巨大的运行期产物
      if (st.size > 8 * 1024 * 1024) continue
      scanned++
      const rel = path.relative(REPO, p).replace(/\\/g, '/')
      const buf = fs.readFileSync(p)
      if (hasBom(buf)) out.push({ file: rel, kind: 'bom', detail: 'UTF-8 BOM（JSON.parse 会直接失败）' })
      const text = buf.toString('utf-8').replace(/^\uFEFF/, '')
      if (isJson) {
        try { JSON.parse(text) } catch (e) {
          out.push({ file: rel, kind: 'json', detail: String(e.message).slice(0, 120) })
        }
      } else {
        let ln = 0
        for (const line of text.split('\n')) {
          ln++
          const s = line.trim()
          if (!s) continue
          try { JSON.parse(s) } catch {
            out.push({ file: rel, kind: 'jsonl', detail: `第 ${ln} 行不是合法 JSON` })
            break
          }
        }
      }
    }
  }
  walk(root, 0)
  return { scanned, issues: out }
}

// ── 扫哪些地方 ──────────────────────────────────────────────────────────
const targets = [
  { name: '方寸 · 执行日志', dir: path.join(REPO, 'docs', '执行日志'), kind: 'md' },
  { name: '方寸 · 任务卡', dir: path.join(REPO, 'task-data'), kind: 'md' },
  { name: '方寸 · 方针卡', dir: path.join(REPO, 'policies'), kind: 'md' },
  { name: '方寸 · 记忆', dir: path.join(REPO, 'memory'), kind: 'md' },
  { name: '方寸 · docs', dir: path.join(REPO, 'docs'), kind: 'md' },
  { name: '方寸 · 数据区 JSON', dir: path.join(REPO, 'task-data'), kind: 'json' },
  { name: '方寸 · 记忆 JSON', dir: path.join(REPO, 'memory'), kind: 'json' },
]
// 兄弟项目仓库（只读扫，这就是"各项目像这样被改坏的东西还有多少"）
const SIBLINGS = ['dsh-fangcun', 'NovelForge', 'SiTian', 'MingJian', 'memory-sanctuary', 'review-workbench']
for (const s of SIBLINGS) {
  const d = path.join(path.dirname(REPO), s)
  if (fs.existsSync(d)) targets.push({ name: `兄弟项目 · ${s}`, dir: d, kind: 'md' })
}

const results = []
for (const t of targets) {
  if (!fs.existsSync(t.dir)) { results.push({ ...t, scanned: 0, issues: [], missing: true }); continue }
  const r = t.kind === 'md' ? scanMdTree(t.dir) : scanJsonTree(t.dir)
  results.push({ ...t, scanned: r.scanned, issues: r.issues })
}

if (AS_JSON) {
  console.log(JSON.stringify(results.map((r) => ({
    name: r.name, scanned: r.scanned, missing: !!r.missing, issues: r.issues,
  })), null, 2))
  process.exit(0)
}

console.log('== 数据文件健康 · 全项目排查 ==\n')
let totalIssues = 0
for (const r of results) {
  const tag = r.missing ? '（目录不存在）' : (r.issues.length ? `✗ ${r.issues.length} 个问题` : '✓ 健康')
  console.log(`${r.name}：扫 ${r.scanned} 个文件 → ${tag}`)
  for (const i of r.issues.slice(0, 10)) console.log(`     · ${i.file} :: ${i.kind} :: ${i.detail}`)
  if (r.issues.length > 10) console.log(`     … 另有 ${r.issues.length - 10} 个`)
  totalIssues += r.issues.length
}
console.log(`\n合计问题 = ${totalIssues}`)
console.log('⚠ 本脚本只读，**不自动修** —— 自动修就是又一次未经确认的写操作，正是这次事故的性质。')
process.exit(totalIssues > 0 ? 1 : 0)
