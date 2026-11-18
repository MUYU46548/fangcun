/**
 * 组合视图 · 自洽性守卫（2026-11-15）
 *
 * 为什么需要：`scripts/project-portfolio.py` 把四份数据 join 起来，
 * 而它**错了也照样出文件**。本轮写它时连栽两次，两次都是同一个病：
 *   ① 需求池按 `eid` / `origin` / `verdict` 读 → 真身是中文键 `标题`/`来源`/`拍板`
 *      → **"全池 0 条"，看起来像"还没有需求"**；
 *   ② `- 拍板: `（空值）后面换行，`\s*(.*)` 把**下一行** `- 决策id:` 吃成拍板值
 *      → **"已决定 11 条"，而真身 0 条**。
 * 两次输出都长得完全正常。所以这套断言钉**与真身对账**，不钉"能不能生成"。
 *
 * 运行：node scripts/test/e2e-portfolio.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'project-portfolio.py')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function runPy(args = []) {
  return execFileSync('python', [SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    timeout: 120000,
  })
}

/** task-data 全量指纹（证明脚本只读） */
function fingerprint() {
  const out = new Map()
  const walk = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.md') && !e.name.endsWith('.json')) continue
      const st = fs.statSync(p)
      out.set(path.relative(ROOT, p), st.size + ':' + st.mtimeMs)
    }
  }
  walk(path.join(ROOT, 'task-data'))
  return out
}

console.log('== 组合视图 · 自洽性守卫 ==')

const before = fingerprint()
const md = runPy()
const after = fingerprint()

// ── ① 只读 ─────────────────────────────────────────────────────────────
{
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed = [...before.keys()].filter((k) => after.has(k) && before.get(k) !== after.get(k))
  check('★★ 组合视图是**只读**的（task-data 一个文件都不许动）',
    added.length === 0 && removed.length === 0 && changed.length === 0,
    `新增=${added.length} 删除=${removed.length} 改动=${changed.length}`)
}

// ── ② 与真身对账：需求池条数必须等于 rice-pool.md 里的 `## ` 块数 ──────────
{
  const rp = path.join(ROOT, 'task-data', 'rice-pool.md')
  const txt = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf-8') : ''
  const want = (txt.match(/^##\s+/gm) || []).length
  const m = /全池 \*\*(\d+)\*\* 条/.exec(md)
  const got = m ? Number(m[1]) : -1
  check('★★ 需求池条数与 rice-pool.md 真身一致（防"读错键 → 0 条"）',
    want === got && want > 0, `真身=${want} 报告=${got}`)
}
// ⚠ 这条是 ② 的加强版：0 条也能"一致"，所以**必须再钉一条"不许是 0"**。
{
  const m = /全池 \*\*(\d+)\*\* 条/.exec(md)
  check('★ 需求池不为 0（真身有 11 条；0 条说明键名又读错了）',
    !!m && Number(m[1]) > 0, m ? m[1] : '没匹配到')
}

// ── ③ 已决定数必须与真身「拍板」非空条数一致 ────────────────────────────
{
  const rp = path.join(ROOT, 'task-data', 'rice-pool.md')
  const txt = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf-8') : ''
  const blocks = txt.split(/^##\s+/m).slice(1)
  // 真身口径：`- 拍板: ` 后面**同一行**有非空内容才算已决定
  const want = blocks.filter((b) => /^-\s*拍板[:：][ \t]*\S/m.test(b)).length
  const m = /已决定 \*\*(\d+)\*\*/.exec(md)
  const got = m ? Number(m[1]) : -1
  check('★★ 已决定条数与真身一致（防"空值吃掉下一行 → 全判成已决定"）',
    want === got, `真身=${want} 报告=${got}`)
}

// ── ④ 层级：tiers 里每个项目都要出现在表里 ──────────────────────────────
{
  const tp = path.join(ROOT, 'task-data', 'project-tiers.json')
  let want = []
  if (fs.existsSync(tp)) {
    try {
      const j = JSON.parse(fs.readFileSync(tp, 'utf-8'))
      for (const t of (j.tiers || [])) want.push(...(t.items || []))
    } catch { /* ignore */ }
  }
  const missing = want.filter((pid) => !md.includes('`' + pid + '`'))
  check('★★ project-tiers.json 里每个项目都出现在表中（少一个 = 少一行资源账）',
    want.length > 0 && missing.length === 0, `层级里=${want.length} 缺=${missing.join(',') || '无'}`)
}

// ── ⑤ 「缺就说缺」：token 段必须显式报未归因 ─────────────────────────────
{
  check('★★ 未归因 token 单独列出（未归因 ≠ 没花，不许并进合计里糊过去）',
    md.includes('未归因'), '输出里没找到「未归因」')
  check('★ 局限段存在且说了「完成是自报」',
    md.includes('这张表证明不了什么') && md.includes('自报'),
    '没找到局限段')
}

// ── ⑥ 不许把缺值写成 0 ─────────────────────────────────────────────────
{
  // 需求池列现在只能是 `—`（因为 origin 不含项目）；写成 0 就是撒谎。
  //
  // ⚠ 这条断言第一版**自己错了**：`l.split('|')` 的 0 号是**行首空串**
  //   （`| a | b |` → ['', ' a ', ' b ', '']），所以需求池列是下标 **5** 不是 4。
  //   按下标 4 取到的是「已完成卡」列 → 把 9 行正常的 0 判成了违规。
  //   是这条断言自己红了一次才发现的 —— 别信"我数过列数"。
  const sec1 = md.slice(md.indexOf('## 1. 组合总表'), md.indexOf('## 2. 需求池'))
  const rows = sec1.split('\n').filter((l) => /^\| .*`[^`]+`/.test(l))
  const bad = []
  for (const l of rows) {
    const cells = l.split('|').map((x) => x.trim())
    // ['', 层级, 项目, 未完成, 已完成, 需求池, 调用, token, 多久没动, '']
    if (cells.length < 9) continue
    if (cells[5] === '0') bad.push(cells[2] || l.slice(0, 30))
  }
  check('★★ 需求池列不许写 0（拆不到项目时只能写 —，0 会被读成"真的没有需求"）',
    bad.length === 0, `有 ${bad.length} 行写了 0：${bad.slice(0, 3).join(',')}`)
  // 防"列取错 → 永远空 → 这条断言永远绿"：需求池列必须真的有 — 值
  const dash = rows.filter((l) => {
    const c = l.split('|').map((x) => x.trim())
    return c.length >= 9 && c[5] === '—'
  })
  check('★ 需求池列确实有 — 值（防"列下标取错 → 这条断言永远绿"）',
    dash.length > 0, `— 值行数=${dash.length} / 总行数=${rows.length}`)
}

// ── ⑦ 缓存读取必须与总量拆开（2026-11-15 暮雨纠正后补）────────────────
//
// 起因：我第一版看到未归因 50 亿，**随口判成"坏记录"**。
// 暮雨当场质疑：「有没有可能真的用了 50 亿？上个月总用量 80 亿以上」。
// 查完他是对的：372 条记录、中位数 476 万/轮、**99.1% 是 cache_read**。
// 教训：**「看起来不像真的」不等于「不是真的」**。
// 所以表里必须有「缓存读取 / 实际新算」两列 —— 否则读者会把缓存当烧掉的钱。
{
  const sec3 = md.slice(md.indexOf('## 3. token 归因'), md.indexOf('## 4. '))
  check('★★ token 表把「缓存读取」与「实际新算」拆成两列（不许只报一个总数）',
    sec3.includes('缓存读取') && sec3.includes('实际新算'),
    '缺「缓存读取」或「实际新算」列')
  check('★ 明确写了「缓存不是烧掉的钱」（防读者把 50 亿当成本）',
    sec3.includes('不是烧掉的钱'), '没写这句')
  // 真身对账：ai-trace 里 external 记录的 cache_read 占比要 > 50%（真数据确实如此）
  // 若某天这个比例掉下来，说明口径变了，这条会红 —— 那是"该重新看"的信号，不是"断言写错"。
  const trace = path.join(ROOT, 'ai-trace.jsonl')
  if (fs.existsSync(trace)) {
    let tot = 0, cache = 0
    for (const line of fs.readFileSync(trace, 'utf-8').split('\n')) {
      if (!line.trim().startsWith('{')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (!String(o.trigger || '').startsWith('external')) continue
      const t = Number(o.total_tokens)
      if (!Number.isFinite(t)) continue
      tot += t
      const m = /cache_read=(\d+)/.exec(String(o.note || ''))
      if (m) cache += Number(m[1])
    }
    const pct = tot ? cache / tot : 0
    check('★ 真身里 external 记录的 cache_read 占比 > 50%（低于此说明口径变了，该重新看）',
      pct > 0.5, `占比=${(pct * 100).toFixed(1)}% 合计=${tot} 缓存=${cache}`)
  }
}

// ── ⑧ 需求池按项目归因（2026-11-15 第二轮补）────────────────────────────
//
// 起因：第一版说"拆不了，得给 rice-pool 加 `项目:` 字段"——**那是懒**。
// 真身里 `来源: task:<卡id>` 反查 `task-data/*.md` 就够了（9/11 能查到）。
// 而且建索引时**必须同时用 frontmatter 的 `id:` 和文件名**：
// 有的卡没写 `id:` 字段，只按 frontmatter 建索引会 11 条全归不到。
{
  const sec2 = md.slice(md.indexOf('## 2. 需求池'), md.indexOf('## 3. token'))
  check('★★ 需求池按项目归因（不再是"全部归不到"）',
    /`[a-z][a-z0-9-]+` \| \d+ \|/.test(sec2),
    '没找到任何「`项目` | N |」行')

  // 真身对账：能反查到的条数 + 归不到的 = 全池
  const rp = path.join(ROOT, 'task-data', 'rice-pool.md')
  const txt = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf-8') : ''
  const blocks = txt.split(/^##\s+/m).slice(1)
  // 建索引：frontmatter id + 文件名
  const c2p = new Map()
  const td = path.join(ROOT, 'task-data')
  for (const f of fs.readdirSync(td).filter((x) => x.endsWith('.md'))) {
    const full = path.join(td, f)
    const raw = fs.readFileSync(full, 'utf-8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
    const fm = m ? m[1] : ''
    const proj = (/^项目:\s*(.+)$/m.exec(fm) || [])[1] || ''
    const id = (/^id:\s*(.+)$/m.exec(fm) || [])[1]
    if (id) c2p.set(id.trim(), proj.trim())
    c2p.set(f.replace(/\.md$/, ''), proj.trim())
  }
  let attributable = 0
  for (const b of blocks) {
    const src = (/^-\s*来源[:：][ \t]*([^\n]*)$/m.exec(b) || [])[1]
    if (!src) continue
    const cid = src.includes(':') ? src.split(':').slice(1).join(':').trim() : ''
    if (c2p.get(cid)) attributable++
  }
  const gotAttr = [...sec2.matchAll(/^\| `[^`]+` \| (\d+) \|/gm)]
    .reduce((a, m) => a + Number(m[1]), 0)
  check('★★ 能归因的条数与真身一致（防"索引建错 → 全归不到"）',
    gotAttr === attributable,
    `真身可归=${attributable} 报告=${gotAttr}`)
  check('★ 确实有能归因的（防这条断言永远绿）', attributable > 0, `可归=${attributable}`)
}

// ── ⑨ 按卡归因必须真的能归（2026-11-17 补 · 卡 46834830）───────────────
//
// 起因：`load_tokens()` 用英文键 `d.get("project")` 读任务卡 frontmatter，
// 而真身键是**中文 `项目`**（见脚本自己的 `_quick_fm` 文档）。
// 于是 351 张卡的索引**全是空串**，按卡归因一条都归不去 ——
// 而 11-15 那份产物里「核心 project-2 / sitian **0 token**」被读成了「零调用」。
//
// **为什么 ①–⑧ 全绿也没抓到**：它们钉的是只读性、需求池真身对账、层级可见、
// 未归因单列 —— **没有一条检查按卡归因的非零性**。
// 输出照样成型、行数照样对、exit code 0。这正是本文件开头骂的那个病。
{
  // 真身：能建出 `卡号 → 项目` 索引的卡数（中文键；英文兜底）
  const c2p = new Map()
  const td = path.join(ROOT, 'task-data')
  for (const f of fs.readdirSync(td).filter((x) => x.endsWith('.md'))) {
    const raw = fs.readFileSync(path.join(td, f), 'utf-8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
    const fm = m ? m[1] : ''
    const proj = ((/^项目:[ \t]*(.*)$/m.exec(fm) || [])[1] || '').trim()
    const id = ((/^id:[ \t]*(.*)$/m.exec(fm) || [])[1] || '').trim()
    if (proj) {
      if (id) c2p.set(id, proj)
      c2p.set(f.replace(/\.md$/, ''), proj)
    }
  }
  check('★ 真身里确实有卡能归到项目（否则下面两条没有意义）',
    c2p.size > 0, `可归卡片=${c2p.size}`)

  // 报告里「归因到项目」的调用数
  const sec3 = md.slice(md.indexOf('## 3. token 归因'), md.indexOf('## 4. '))
  const att = /^\| 归因到项目 \| (\d+) \|/m.exec(sec3)
  const attCalls = att ? Number(att[1]) : -1

  // 「只可能来自 card 的归因」= trigger 不是 plan-draft/arch 那几种、但 card 可归的记录。
  // ⚠ 这条是反例⑦逼出来的：只断言「归因调用数 > 0」时，**按卡整段断掉也能过**
  //   —— 因为 `plan-draft:<项目id>` 那条 trigger 路径还会剩 23 条，
  //   23 > 0 照样绿。必须把「只靠 card 才能归」的那部分单独量出来。
  const TRIG_PROJ = /^(?:plan-draft|plan_draft|arch|archGenerate):([A-Za-z0-9_-]+)/
  const trace = path.join(ROOT, 'ai-trace.jsonl')
  let cardOnly = 0
  if (fs.existsSync(trace)) {
    for (const line of fs.readFileSync(trace, 'utf-8').split('\n')) {
      if (!line.trim().startsWith('{')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (!String(o.trigger || '').startsWith('external')) continue
      if (TRIG_PROJ.test(String(o.trigger || ''))) continue   // 这条靠 trigger 就能归，不算 card 的功劳
      const card = String(o.card || '') || ((/(?:^|\s)card=([^\s]+)/.exec(String(o.note || '')) || [])[1] || '')
      if (card && card !== '(未归因)' && c2p.has(card)) cardOnly++
    }
  }
  check('★ 真身里存在「只能靠 card 归因」的记录（前提）',
    cardOnly > 0, `只靠 card=${cardOnly}`)
  check('★★ 按卡归因真的能归（防"键名读错 → 归因整段失效"）',
    cardOnly === 0 || attCalls >= cardOnly,
    `只靠 card 的可归=${cardOnly}，报告归因调用=${attCalls < 0 ? '—' : attCalls}`)
  check('★★ 归因调用数必须 > 0（连一条都归不到 = 整段没接上）',
    attCalls > 0, att ? `归因调用=${att[1]}` : '没匹配到「归因到项目」行')
}

// ── ⑩ 主指标必须是「新输入 / 输出」，不是 total（2026-11-17 · 暮雨定口径）──
//
// 暮雨 2026-11-17：「按新输入 tokens / 输出 tokens 算，金额反正也算不准暂时不搞。
// 比如我走订阅是包月内额度算的」。
// 而 total 里 99% 是缓存重读 —— 拿它排名就是按「谁的会话最长」排名。
{
  const sec1 = md.slice(md.indexOf('## 1. 组合总表'), md.indexOf('## 2. 需求池'))
  // ⚠ 只看表头行本身（`| 层级 | ...`）。原来用 `sec1.includes('新输入')` ——
  //   整个 §1 里还有「按层级排；同层内**新输入多的在前**」这句说明文字，
  //   于是把表头里的「新输入」改名后这句照样命中，断言**永远绿**（反例⑧ 抓到的）。
  const header = (sec1.split('\n').find((l) => l.startsWith('| 层级 |')) || '')
  const cols = header.split('|').map((x) => x.trim())
  check('★★ 总表有「新输入」与「输出」两列',
    cols.includes('新输入') && cols.includes('输出'),
    header ? `实际表头=${cols.filter(Boolean).join(' / ')}` : '没找到表头行')
  check('★ total 被降为副列（表头写明）',
    cols.some((c) => c.startsWith('total（副列）')), `表头=${cols.filter(Boolean).join(' / ')}`)
  check('★★ 局限段写明「金额不算」而不是默默省略',
    md.includes('金额') && md.includes('不折算金额'),
    '局限段没说金额口径')
}

// ── ⑪「没用量」不许被写成 0（2026-11-17 补）──────────────────────────────
//
// 本仓红线（`shared/waste.ts`）：「取不到就整格不渲染 —— 不填 0」。
// 实测 517 条留痕里 14 条 total/prompt 全是 None（失败调用没有用量），
// 而 7 条是供应商**真报了 0**。两者混在一起算，表上就是
// 「调用 90 次、新输入 0」—— 把「没数据」说成「真值 0」。
{
  const sec1 = md.slice(md.indexOf('## 1. 组合总表'), md.indexOf('## 2. 需求池'))
  const header = (sec1.split('\n').find((l) => l.startsWith('| 层级 |')) || '')
  const cols = header.split('|').map((x) => x.trim())
  check('★★ 总表有「没用量」列（没用量 ≠ 用量是 0）',
    cols.includes('没用量'), header ? `表头=${cols.filter(Boolean).join(' / ')}` : '没找到表头行')

  const rows = sec1.split('\n').filter((l) => /^\| .*`[^`]+`/.test(l))
  // 每行：['', 层级, 项目, 未完成, 已完成, 需求池, 调用, 没用量, 新输入, 输出, total, 多久没动, '']
  const zeroCall = []   // 零调用 → 用量列必须都是 —
  const nouOnly = []    // 有调用但全没用量 → 新输入必须 —，不能写 0
  for (const l of rows) {
    const c = l.split('|').map((x) => x.trim())
    if (c.length < 12) continue
    const name = c[2]
    if (c[6] === '0' && (c[8] !== '—' || c[9] !== '—')) zeroCall.push(`${name}(${c[8]}/${c[9]})`)
    if (c[7] !== '—' && Number(c[7]) === Number(c[6]) && c[8] !== '—') nouOnly.push(name)
  }
  check('★★ 零调用的项目，用量列写 `—` 而不是 0',
    zeroCall.length === 0, `写错 ${zeroCall.length} 行：${zeroCall.slice(0, 3).join(',')}`)
  check('★★ 有调用但全没用量时，新输入写 `—`（不许拿 0 顶）',
    nouOnly.length === 0, `写错 ${nouOnly.length} 行：${nouOnly.slice(0, 3).join(',')}`)
  check('★ 确实存在「有调用但没用量」的行（防这条断言永远绿）',
    rows.some((l) => { const c = l.split('|').map((x) => x.trim()); return c.length >= 12 && c[7] !== '—' }),
    '没有任何行填了「没用量」')
}

// ── ⑫ 用量分布：只描述，不判定（暮雨 2026-11-17 拍板）────────────────────
//
// 暮雨：「限额阈值多少我根本定不了，缺乏足够的信息无法判断。」
// → 「限额」改成「相对历史对比」。节内**不许出现任何"超标/超阈值/告警"字样**：
//   实测单轮用量全距 23.9 万倍、日用量全距 10 倍，任何固定阈值都会把长会话判成烧多了。
// 这条断言存在的意义：以后谁想在产物里偷偷加回一个"超标"判定，会当场红。
{
  const i4 = md.indexOf('## 4. 用量分布')
  const i5 = md.indexOf('## 5. ')
  check('★★ 有「用量分布」一节', i4 >= 0 && i5 > i4, `i4=${i4} i5=${i5}`)
  if (i4 >= 0 && i5 > i4) {
    const sec4 = md.slice(i4, i5)
    // ⚠ 只查**声明性**字样，不查正文里出现的「长会话」等词
    const banned = ['超标', '超阈值', '告警', '限额', '超过预算']
    const hit = banned.filter((w) => sec4.includes(w))
    check('★★ 用量分布节内不许有任何"超标/限额"判定（基准不存在，造一个就是骗人）',
      hit.length === 0, `出现了：${hit.join('、')}`)
    check('★★ 必须写明「不需要你定任何数字」（否则用户又得凭空拍一个）',
      sec4.includes('不需要') && sec4.includes('定任何数字'), '没写这句')
    check('★ 必须有「相对平常一天」的倍数（这是用户平时看不到的基准感）',
      /相对平常一天/.test(sec4) && /[0-9]+\.[0-9]x/.test(sec4), '缺倍数列')
    check('★ 必须说明单轮离群 ≠ 烧多了（长上下文会话）',
      sec4.includes('长上下文') || sec4.includes('缓存重读'),
      '没解释单轮 total 为什么大')
  }
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
