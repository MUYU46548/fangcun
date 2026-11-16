/**
 * 会话记录 · 只读捞取器（2026-11-16）
 *
 * 由来：暮雨 2026-11-16：
 *   「"上千处"有很多可能都随着会话记录永久消失了，或者藏在某个日志里，被归档或删除了。」
 *   「"上千处"必须捞，不捞更惨。」
 *
 * 事实先摆清楚（本轮实测）：
 *   · DSH 会话存放在 `~/.dsh/sessions/<项目目录>/<session-id>/session.v4.jsonl.zstd`
 *   · **184 个文件、250 MB**，按项目分目录
 *   · 每个文件是 **zstd 多帧拼接**（一个 5 MB 文件里有 3407 帧）——
 *     Node 的 `zstdDecompressSync` / stream 都**只解第一帧**（第一个帧只有 205 字符的会话头），
 *     所以直接读会以为"会话是空的"。必须**逐帧解**。
 *   · 一个会话解压后 6145 行 / 1670 万字符，含 61 条 `user/message`。
 *
 * 这个脚本只做一件事：**把「用户说过的话」捞出来**，因为那才是需求源头。
 * 不捞 assistant 的话 —— 那是 AI 说的，捞出来只会又变成"AI 提的东西"（正是危机本体）。
 *
 * 三条纪律：
 *  ① **只读**：只读 `~/.dsh/sessions`，不写、不改、不删任何会话文件；
 *  ② **缺就说缺**：解不开的帧 / 读不动的文件**逐条报**，不静默跳过；
 *  ③ **不猜**：只输出原文，不做摘要、不判断"这条是否已做" —— 那是下一步的事。
 *
 * 用法：
 *   node scripts/harvest-sessions.cjs --list                    # 有哪些会话、多大
 *   node scripts/harvest-sessions.cjs --project fangcun         # 捞某项目的用户发言
 *   node scripts/harvest-sessions.cjs --project fangcun --out docs/捞-会话-方寸.md
 *   node scripts/harvest-sessions.cjs --all --outdir docs/捞-会话
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

const HOME = process.env.USERPROFILE || os.homedir()
const ROOT = path.join(HOME, '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MAX_TEXT = 1200 // 单条用户消息最多带多少字

/**
 * 「打着 user 旗号、其实不是人打的」的那几类。默认丢掉，`--raw` 才保留。
 *
 * 2026-11-16 实测：方寸一个项目过滤到 208 条后，里面还有 21 块是这类注入 ——
 * 最典型的是**方寸自己的交接日志被塞成一条 user 消息**（`## 上次执行日志…`），
 * 它的正文包含表格、代码、甚至别人说的话。不过滤的话，捞出来的"用户发言"
 * 一半是方寸自己写的东西 —— 那正好又变成「AI 提的东西」。
 */
const INJECT_PATTERNS = [
  /^##\s*上次执行日志/, /^<system-reminder>/, /^The approval policy changed/,
  /^<goal_round>/, /^<goal_complete>/,
  /^This is an automatically generated checkpoint/,
  /^background job /, /^Agent .* sent a message:/,
  /^Parallel log /, /^以下是并行日志/,
]

function isInjectedText(t) {
  const s = String(t || '').trim()
  return INJECT_PATTERNS.some((re) => re.test(s))
}

/** 逐帧解压。zstd 多帧拼接，Node 的 API 只解第一帧 —— 这是本文件存在的技术原因。 */
function decompressAll(buf) {
  const positions = []
  let idx = 0
  while (true) {
    const i = buf.indexOf(MAGIC, idx)
    if (i < 0) break
    positions.push(i)
    idx = i + 4
  }
  if (!positions.length) return { text: '', frames: 0, failed: 0, bytes: 0 }

  const outs = []
  let failed = 0
  let start = positions[0]
  let i = 1
  let guard = 0
  while (start < buf.length && guard++ < 100000) {
    let got = null
    let end = buf.length
    for (; i <= positions.length; i++) {
      const candidate = i < positions.length ? positions[i] : buf.length
      try {
        got = zlib.zstdDecompressSync(buf.subarray(start, candidate))
        end = candidate
        break
      } catch { /* 这帧跨过了这个 magic，继续往后找 */ }
    }
    if (!got) { failed++; break }
    outs.push(got)
    start = end
    i = i + 1
  }
  const total = Buffer.concat(outs)
  return { text: total.toString('utf-8'), frames: outs.length, failed, bytes: total.length }
}

function listSessions() {
  if (!fs.existsSync(ROOT)) return { ok: false, error: `找不到会话目录：${ROOT}` }
  const out = []
  for (const proj of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const pd = path.join(ROOT, proj.name)
    let files = []
    try {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) walk(p)
          else if (e.name.endsWith('.zstd')) files.push(p)
        }
      }
      walk(pd)
    } catch { /* 读不动就跳过，下面会报总数对不上 */ }
    let bytes = 0
    for (const f of files) { try { bytes += fs.statSync(f).size } catch {} }
    out.push({ project: proj.name, files: files.length, bytes })
  }
  out.sort((a, b) => b.bytes - a.bytes)
  return { ok: true, root: ROOT, sessions: out }
}

/** 从解压后的 jsonl 里抽用户发言 + 会话元信息。 */
function extractUserMessages(text) {
  const msgs = []
  let meta = null
  let unparsed = 0
  for (const ln of text.split('\n')) {
    if (!ln.trim()) continue
    let o
    try { o = JSON.parse(ln) } catch { continue }
    if (o.type === 'session' && !meta) {
      meta = {
        id: o.id, createdAt: o.createdAt, cwd: o.cwd,
        parentSession: o.parentSession || '', origin: o.origin || '',
        delegationDepth: o.delegationDepth,
      }
      continue
    }
    if (o.type !== 'user/message') continue
    // 真身形状（2026-11-16 实测）：
    //   { type:'user/message', seq, time, data:{ content:[{type:'text',text:'…'}],
    //                                            source:{kind:'user-approval'|…}, role:'user' } }
    // ⚠ 第一版按 o.content / o.message.content 取，**全部取空** —— 于是捞出来 0 条，
    //   而报告上看起来"这个会话没有用户发言"。这正是本仓反复踩的形状：
    //   解析路径错了，输出是"0 条"而不是报错。所以下面宁可多试几种，取不到就明说。
    const d = o.data || o
    let s = ''
    const c = d.content !== undefined ? d.content : d.message && d.message.content
    if (typeof c === 'string') s = c
    else if (Array.isArray(c)) {
      s = c.map((x) => (typeof x === 'string' ? x : (x && (x.text || '')) || '')).join('')
    } else if (c && typeof c === 'object') {
      s = String(c.text || '')
    }
    if (!s && typeof d.text === 'string') s = d.text
    s = s.trim()
    if (!s) {
      unparsed++
      continue
    }
    const src = (d.source && d.source.kind) || ''
    // 系统注入的（审批策略变更、定时任务、上一个会话的交接日志）不算"用户说的话"，
    // 但**不能直接丢** —— 交接日志里常常有用户原话。所以标记出来，默认仍然收录。
    msgs.push({ ts: o.time || '', text: s, source: src })
  }
  return { meta, msgs, unparsed }
}

function projectMatches(dirName, want) {
  if (!want) return true
  // 目录名是路径转义过的：`--E-CODE-CangKu-fangcun--`
  return dirName.toLowerCase().includes(String(want).toLowerCase())
}

function harvest(wantProject) {
  const l = listSessions()
  if (!l.ok) return { ok: false, error: l.error }
  const picked = l.sessions.filter((s) => projectMatches(s.project, wantProject))
  const results = []
  for (const s of picked) {
    const pd = path.join(ROOT, s.project)
    const files = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.zstd')) files.push(p)
      }
    }
    try { walk(pd) } catch { continue }
    for (const f of files) {
      let buf
      try { buf = fs.readFileSync(f) } catch (e) {
        results.push({ file: f, error: '读不动：' + e.message })
        continue
      }
      const d = decompressAll(buf)
      const { meta, msgs, unparsed } = extractUserMessages(d.text)
      results.push({
        file: path.relative(ROOT, f),
        project: s.project,
        meta, msgs,
        frames: d.frames, failedFrames: d.failed, bytes: d.bytes, unparsed,
      })
    }
  }
  return { ok: true, root: ROOT, scanned: picked.length, results }
}

/**
 * 只留**真人说的话**。两道筛子，缺一条就会把系统注入当成用户需求：
 *
 * ① **只留主会话**（`delegationDepth === 0` 且没有 `parentSession`）——
 *    子 agent 的派工提示也是 `source: 'user'`（实测：15 条里 1 条），
 *    不过滤的话「你是 Spec 轴评审员…」会被当成暮雨说的需求。
 * ② **只留 `source.kind === 'user'`** ——
 *    一轮对话里用户真正输入的那条是 `user`；其余 `runtime-context` / `time-context` /
 *    `agent-instructions` / `skill-catalog` / `goal` / `tool-jobs` / `compact-checkpoint`
 *    全是系统每轮重发的。实测：一个项目 2544 条 user/message 里，**只有 208 条是真人说的**。
 */
function filterHumanMessages(results, keepInjected = false) {
  const out = []
  for (const r of results) {
    if (r.error) continue
    const depth = (r.meta && r.meta.delegationDepth) || 0
    const hasParent = !!(r.meta && r.meta.parentSession)
    if (depth > 0 || hasParent) continue // 子 agent 会话
    const msgs = r.msgs.filter((m) => m.source === 'user' && (keepInjected || !isInjectedText(m.text)))
    if (!msgs.length) continue
    out.push({ ...r, msgs })
  }
  return out
}

function fmtTs(ts) {
  if (!ts) return ''
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts))
  if (!Number.isFinite(ms)) return String(ts).slice(0, 19)
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function main() {
  const args = process.argv.slice(2)
  const has = (k) => args.includes(k)
  const val = (k) => {
    const i = args.indexOf(k)
    return i >= 0 ? args[i + 1] : ''
  }

  if (args.length === 0 || has('--help')) {
    console.log('node scripts/harvest-sessions.cjs --list')
    console.log('node scripts/harvest-sessions.cjs --project fangcun [--out 文件.md]')
    console.log('node scripts/harvest-sessions.cjs --all --outdir docs/捞-会话')
    return 0
  }

  if (has('--list')) {
    const l = listSessions()
    if (!l.ok) { console.log('✗ ' + l.error); return 1 }
    console.log('# 会话存档 · ' + l.root)
    console.log('')
    console.log('| 项目目录 | 文件数 | 大小 |')
    console.log('|---|---:|---:|')
    let tf = 0, tb = 0
    for (const s of l.sessions) {
      tf += s.files; tb += s.bytes
      console.log(`| \`${s.project}\` | ${s.files} | ${(s.bytes / 1048576).toFixed(1)} MB |`)
    }
    console.log(`| **合计** | **${tf}** | **${(tb / 1048576).toFixed(1)} MB** |`)
    return 0
  }

  const want = has('--all') ? '' : val('--project')
  const h = harvest(want)
  if (!h.ok) { console.log('✗ ' + h.error); return 1 }
  // 两道筛子（见 filterHumanMessages 的注释）：只留主会话、只留 source=user
  const allCount = h.results.reduce((s, r) => s + (r.msgs ? r.msgs.length : 0), 0)
  h.results = filterHumanMessages(h.results, has('--raw'))

  const outPath = val('--out')
  const outdir = val('--outdir')
  const L = []
  L.push('# 会话记录里捞到的「用户说过的话」')
  L.push('')
  L.push('- 生成：' + fmtTs(Date.now()))
  L.push('- 来源：`' + h.root + '`（**只读**，一个字没改）')
  L.push('- 范围：' + (want ? '`' + want + '`' : '全部项目') + ' · 扫了 ' + h.scanned + ' 个项目目录')
  L.push('- 原始 user/message：**' + allCount + '** 条 → 过滤后真人发言：**' +
    h.results.reduce((s, r) => s + r.msgs.length, 0) + '** 条')
  L.push('')
  L.push('> ⚠ 两道筛子：① **只留主会话**（子 agent 的派工提示也是 `source:user`，不过滤会把')
  L.push('> 「你是某某评审员…」当成用户说的需求）；② **只留 `source.kind === user`** ——')
  L.push('> 每轮重发的 `runtime-context` / `time-context` / `goal` / `tool-jobs` 全不是人说的。')
  L.push('>')
  L.push('> ⚠ 只捞 `user/message`，**不捞 assistant** —— AI 说的话是危机本体（"AI 提的东西活得比人提的久"）。')
  L.push('> 每条都是原文，没有摘要、没有判断"这条做没做"。')
  L.push('')

  let totalMsgs = 0
  let badFiles = 0
  for (const r of h.results) {
    if (r.error) { badFiles++; L.push('## ⚠ ' + r.file + '\n\n' + r.error + '\n'); continue }
    const m = r.meta || {}
    if (!r.msgs.length) continue
    totalMsgs += r.msgs.length
    L.push(`## ${m.id || r.file}`)
    L.push('')
    L.push(`- 时间：${fmtTs(m.createdAt)} · 项目：\`${m.cwd || '?'}\`` +
      (m.parentSession ? ` · 续接：\`${m.parentSession}\`` : '') +
      (m.delegationDepth ? ` · 子 agent 深度 ${m.delegationDepth}` : ''))
    L.push(`- 文件：\`${r.file}\` · ${(r.bytes / 1048576).toFixed(1)} MB 解压 · ${r.frames} 帧` +
      (r.failedFrames ? ` · **${r.failedFrames} 帧解不开**` : ''))
    L.push(`- 用户发言：**${r.msgs.length}** 条`)
    L.push('')
    for (const msg of r.msgs) {
      const t = msg.text.length > MAX_TEXT
        ? msg.text.slice(0, MAX_TEXT) + `…（原文 ${msg.text.length} 字，已截断）`
        : msg.text
      const one = t.replace(/\n/g, '\n> ')
      L.push(`> ${one}`)
      L.push('')
    }
  }

  L.push('---')
  L.push('')
  L.push(`合计捞到 **${totalMsgs}** 条用户发言` + (badFiles ? `，${badFiles} 个文件读不动` : ''))

  const text = L.join('\n')
  if (outPath) {
    fs.writeFileSync(outPath, text + '\n', 'utf-8')
    const back = fs.readFileSync(outPath, 'utf-8')
    console.log(`已写 ${Buffer.byteLength(back, 'utf-8')} 字节 → ${outPath}`)
    console.log(`用户发言 ${totalMsgs} 条`)
    return 0
  }
  if (outdir) {
    fs.mkdirSync(outdir, { recursive: true })
    const p = path.join(outdir, (want || 'all') + '.md')
    fs.writeFileSync(p, text + '\n', 'utf-8')
    console.log(`已写 → ${p}（用户发言 ${totalMsgs} 条）`)
    return 0
  }
  console.log(text)
  return 0
}

if (require.main === module) process.exit(main())
module.exports = { decompressAll, extractUserMessages, listSessions, harvest, filterHumanMessages }
