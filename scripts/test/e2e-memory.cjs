/**
 * 记忆层 MCP 工具 · 端到端（2026-11-17）
 *
 * 暮雨：「界面和 MCP 工具必做」。
 *
 * 判据不是"工具能列出来"，而是：
 *  ① 真能检索到已录的事故（真数据，不是夹具）；
 *  ② 空条件 vs 有结果**分得清**（「筛出来 0 条」≠「库是空的」）；
 *  ③ `memory_read` 只认 memory/ 下的路径（`../` 逃逸必须被拒）；
 *  ④ **不碰 task-data/** —— 跑完 task-data 逐字节不变、不多出文件。
 */
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const DATA = REPO // 本机数据根就是仓库根

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== 记忆层 MCP 工具 · 端到端 ==')

const memPath = path.join(DIST, 'services', 'memory.js')
const toolsPath = path.join(DIST, 'mcp', 'tools.js')
check('★★ 编译产物在（先跑 tsc -p tsconfig.main.json）', fs.existsSync(memPath) && fs.existsSync(toolsPath), memPath)
if (!fs.existsSync(memPath) || !fs.existsSync(toolsPath)) {
  console.log(`\nRESULT ${pass} / ${fail}`); process.exit(1)
}

// 数据根锁定（纯 Node 下 setDataDir 会被 try/catch 吞，这里显式设一次）
try {
  const data = require(path.join(DIST, 'data', 'index.js'))
  if (typeof data.setDataDir === 'function') data.setDataDir(DATA)
} catch (e) {
  console.log('WARN setDataDir 不可用：' + (e && e.message))
}

const mem = require(memPath)

// ── task-data 快照（只读断言用）──────────────────────────────────────
function snapshot(dir) {
  const out = new Map()
  ;(function walk(d) {
    let names = []
    try { names = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const n of names) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (n.name.endsWith('.md')) out.set(p, fs.statSync(p).size + ':' + fs.statSync(p).mtimeMs)
    }
  })(dir)
  return out
}
const taskDir = path.join(DATA, 'task-data')
const before = snapshot(taskDir)

// ── ① 真数据检索 ─────────────────────────────────────────────────
const all = mem.searchMemory({})
check('★ 能扫到已录的记忆（真数据，不是夹具）', all.total > 0, `total=${all.total}`)

const incidents = mem.searchMemory({ type: '事故' })
check('★ 按类型「事故」能筛到', incidents.total > 0, `total=${incidents.total}`)

const byQ = mem.searchMemory({ q: 'kill' })
check('★★ 关键词能命中原义（停进程那条纪律）', byQ.total > 0, `total=${byQ.total}`)

const cross = mem.searchMemory({ scope: '跨项目' })
check('★★ scope=跨项目 能查到（字段写在 项目 里也要认）', cross.total > 0, `total=${cross.total}`)

const miss = mem.searchMemory({ q: '绝对不存在的关键词zzz' })
// ⚠ 2026-11-24 修：原断言的探针词是「绝对不存在的关键词zzz」，但它**不是真的不存在** ——
// 记忆层改「归一化加权和」后，一两个无关字命中也算分，这个探针会被 `量` / `测` 这类二字组蹭中。
// 改成把词表里一定不会出现的三个稀有 ASCII 串拼起来，才是真的"搜不到"。
const MISS_PROBE = 'zzq9x-jkw0v-mm42p'
const miss2 = mem.searchMemory({ q: MISS_PROBE })
check('★★ 搜不到时 total=0，且 overview 证明库里有货（分得清「筛出来没有」与「库是空的」）',
  miss2.total === 0 && mem.memoryOverview().total > 0, `miss=${miss2.total} overview=${mem.memoryOverview().total}`)

// ── v2 数据体检（2026-11-20 迁移后）────────────────────────────────
const health = mem.memoryCheck()
check('★★ 真数据体检：无 v1 / 无空证据 / 无重复 / core 不超预算',
  health.ok === true, JSON.stringify((health.issues || []).slice(0, 3)))
// ⚠ 2026-11-24 改：`pinned === 8` 是 v2 迁移当时的快照，写死就变成"每次加记忆都要改测试"。
// 现在断言的是**下限 + 真数据核对**，不是某个历史数字。
check('★ 迁移后 claim 至少 30 条、证据 14 篇、钉住 8 条（下限，不是快照）',
  health.counts.claims >= 30 && health.counts.evidence >= 14 && health.counts.pinned >= 8,
  JSON.stringify(health.counts))

// ── 固定核心 vs 归档（2026-11-19 抄 Letta core / Claude just-in-time）──
const core = mem.memoryCore()
check('★★ 固定核心存在、非空、≤800 字（这是唯一自动注入的记忆内容）',
  core.ok === true && core.missing === false && core.text.includes('D1') && core.chars <= core.budget,
  JSON.stringify({ ok: core.ok, missing: core.missing, chars: core.chars, budget: core.budget }))
check('★★ core.md 不被当成归档条目（不参与检索/计数）',
  !mem.searchMemory({}).rows.some((r) => /(^|\/)core\.md$/.test(String(r.file || '')))
    && mem.memoryOverview().total > 0,
  'overview=' + mem.memoryOverview().total)

// MCP 真调用：memory_core 必须返回固定核心，而不是归档列表
let mcpCore = {}
try {
  const tools = require(toolsPath)
  const res = tools.handleMCPToolCall('memory_core', {}, {})
  const body = res && res.content && res.content[0] && res.content[0].text
  mcpCore = JSON.parse(body || '{}')
} catch (e) {
  mcpCore = { ok: false, error: String((e && e.message) || e) }
}
check('★★ MCP memory_core 真返回固定核心（有 text/chars/budget，不塞归档）',
  mcpCore.ok === true && String(mcpCore.text || '').includes('D1')
    && Number(mcpCore.budget) === 800 && Number(mcpCore.archived) >= 0,
  JSON.stringify({ ok: mcpCore.ok, chars: mcpCore.chars, budget: mcpCore.budget, archived: mcpCore.archived }))

// ── ② 撤销语义 ───────────────────────────────────────────────────
const withRevoked = mem.searchMemory({ includeRevoked: true })
check('★ includeRevoked 能放宽（默认排除已撤销）', withRevoked.total >= all.total,
  `all=${all.total} withRevoked=${withRevoked.total}`)

// ── ③ read 的路径硬闸 ────────────────────────────────────────────
const good = mem.readMemory(all.rows[0].file)
check('★ 能读回原条目', good.ok === true && String(good.text).length > 0, good.error || '')

check('★★ 拒绝 ``../`` 逃逸', mem.readMemory('memory/../task-data/decisions.md').ok === false)
check('★★ 拒绝 memory/ 之外的路径', mem.readMemory('task-data/decisions.md').ok === false)
check('★★ 拒绝绝对路径', mem.readMemory('C:/Windows/win.ini').ok === false)
check('★ 不存在的文件如实报错（不静默返回空）',
  mem.readMemory('memory/不存在.md').ok === false)

// ── ④ 不碰 task-data ─────────────────────────────────────────────
const after = snapshot(taskDir)
let diff = 0
for (const [k, v] of before) if (after.get(k) !== v) diff++
for (const k of after.keys()) if (!before.has(k)) diff++
check('★★ 跑完 task-data 逐字节不变、不多出文件（记忆不许污染台账）', diff === 0, `差异 ${diff}`)

// ── ⑤ 工具定义真的注册了 ─────────────────────────────────────────
const toolsSrc = fs.readFileSync(toolsPath, 'utf-8')
check('★ 工具表里有 memory_search', /name:\s*['"]memory_search['"]/.test(toolsSrc))
check('★ 工具表里有 memory_read', /name:\s*['"]memory_read['"]/.test(toolsSrc))
check('★★ 工具表里有 memory_write（agent 写入口）', /name:\s*['"]memory_write['"]/.test(toolsSrc))
check('★★ 工具表里有 memory_core（固定核心）', /name:\s*['"]memory_core['"]/.test(toolsSrc))
check('★★ 工具表里有 memory_briefing（按需检索，不自动注入）', /name:\s*['"]memory_briefing['"]/.test(toolsSrc))
check('★ dispatcher 里有五个对应分支',
  (toolsSrc.match(/case\s+['"]memory_(search|read|write|briefing|core)['"]/g) || []).length === 5)
// agent 写入口必须强制待审批：源码里不能出现 "memory_write" 分支直接落有效
check('★★ memory_write 的 dispatcher 带 pending:true（不许自批）',
  /case\s+['"]memory_write['"][\s\S]{0,1600}?pending:\s*true/.test(toolsSrc))

// ══ ⑥ 写入（2026-11-18 暮雨：“记忆页必须开放写，不然出问题用户想改都改不了”）══
//
// ⚠⚠ **一律用临时数据根**，绝不在真数据目录里建记忆 ——
//   本仓有过一次"造数据缺失反例时真数据被换成空壳"的事故（check-promises 那轮）。
//   这里把 setDataDir 指到 mkdtemp 出来的目录，跑完删掉。
console.log('\n=== ⑥ 写入：建 / 改 / 撤销（临时数据根）===')
{
  const os = require('os')
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mem-'))
  // `setDataDir` 会校验"目标目录里得有 registry.yaml 或 task-data"（防手滑指到空目录把数据根换掉）——
  // 临时根必须先把这两个中的一个摆好，否则它当场抛错（这条校验本身是对的，别去绕它）。
  fs.writeFileSync(path.join(tmpRoot, 'registry.yaml'), 'projects: []\n', 'utf-8')
  fs.mkdirSync(path.join(tmpRoot, 'task-data'), { recursive: true })
  const data = require(path.join(DIST, 'data', 'index.js'))
  const realRoot = DATA
  try {
    data.setDataDir(tmpRoot)
    fs.mkdirSync(path.join(tmpRoot, 'memory'), { recursive: true })

    check('★★ setDataDir 真生效（临时根里一开始一条记忆都没有）',
      mem.memoryOverview().total === 0, 'total=' + mem.memoryOverview().total)

    // ① 正常建一条
    const made = mem.createMemory({
      type: '教训', title: '临时根里的一条', body: '原文逐字\n第二行也要在',
      source: 'e2e-memory（临时根）', project: 'fangcun-base', impact: '高',
    })
    check('★★ 能建一条记忆（返回 file 且真落盘）',
      made.ok === true && !!made.file && fs.existsSync(path.join(tmpRoot, made.file)),
      made.error || made.file)
    const ov1 = mem.memoryOverview()
    check('★ 建完 overview 里数得到（total=1）', ov1.total === 1, 'total=' + ov1.total)
    const hit = mem.searchMemory({ q: '临时根里的一条' })
    check('★ 建完能立刻搜到（索引确实重建了 / 或扫描是真身）', hit.total >= 1, 'total=' + hit.total)
    const text1 = fs.readFileSync(path.join(tmpRoot, made.file), 'utf-8')
    check('★★ 原文**逐字**落盘（不摘要、不裁行）',
      text1.includes('原文逐字') && text1.includes('第二行也要在'), text1.slice(0, 120))
    check('★ frontmatter 四件都写了（类型/来源/时间/状态）',
      /^类型: 教训$/m.test(text1) && /^来源: /m.test(text1) && /^时间: /m.test(text1) && /^状态: 有效$/m.test(text1))
    // 2026-11-19 实测抓到：createMemory 用 toISOString() 写 UTC，CLI 只截前 16 字符，
    // 本地 11:24 显示成 03:24。时间必须带本地偏移，和现有条目一致。
    check('★★ 时间写本地时区偏移（不是 UTC 的 Z）',
      /^时间: .*[+-]\d{2}:\d{2}$/m.test(text1), text1.split('\n').find((l) => l.startsWith('时间: ')) || '')
    check('★ 路径落在 memory/claims/ 下（不进 task-data）',
      /^memory\/claims\//.test(String(made.file)) && !String(made.file).includes('task-data'),
      String(made.file))

    // ② 必填项缺一个就得拒，而且要说清缺哪个
    for (const [k, label] of [['type', '类型'], ['title', '标题'], ['body', '原文'], ['source', '来源']]) {
      const bad = { type: '教训', title: 't', body: 'b', source: 's' }
      bad[k] = ''
      const r = mem.createMemory(bad)
      check(`★★ 缺「${label}」→ 拒绝并点名`, r.ok === false && String(r.error).indexOf(label) >= 0, r.error || 'ok')
    }
    const badType = mem.createMemory({ type: '随便写', title: 't', body: 'b', source: 's' })
    check('★★ 类型不在取值域 → 拒绝（否则界面那排筛选徽章永远命不中它）',
      badType.ok === false && /类型/.test(badType.error), badType.error)
    check('★ 被拒的没留下垃圾文件（临时根里仍只有 1 条 md）',
      (fs.readdirSync(path.join(tmpRoot, path.dirname(made.file))).filter((f) => f.endsWith('.md')).length) === 1,
      String(fs.readdirSync(path.join(tmpRoot, path.dirname(made.file)))))

    // ③ 改
    const upd = mem.updateMemory(made.file, {
      type: '事故', title: '改过的标题', body: '改过之后的原文', source: 'e2e-memory',
    })
    check('★★ 能改一条（改写成功）', upd.ok === true, upd.error || '')
    const text2 = fs.readFileSync(path.join(tmpRoot, made.file), 'utf-8')
    check('★★ 改完正文真变了，且**同一条文件**（不新增一条）',
      text2.includes('改过之后的原文') && ov1.total === 1, text2.slice(0, 100))
    check('★ 改完 id 不变（改内容不改身份）',
      (mem.parseFrontmatter(text2).fm || {}).id === mem.parseFrontmatter(text1).fm.id,
      String(mem.parseFrontmatter(text2).fm.id))
    const emptyBody = mem.updateMemory(made.file, { type: '事故', title: 'x', body: '', source: 's' })
    check('★★ 改成空正文 → 拒绝（"改着改着变空条目"比不改更糟）',
      emptyBody.ok === false && /原文/.test(emptyBody.error), emptyBody.error)
    check('  且被拒之后原文还在（拒绝不能留下半截）',
      fs.readFileSync(path.join(tmpRoot, made.file), 'utf-8').includes('改过之后的原文'))

    // ④ 撤销 / 恢复：撤销≠删除
    // ⚠ 搜索词必须是**真在标题里**的那个（'改过的标题'）。第一版我写成 '改过之后的标题' ——
    //   它既不在标题里也不在正文里，于是下面几条 `total === 0` 全部**假绿**
    //   （撤销/恢复两条根本验不到东西）。这是自己写出来的假绿，记在这儿防下次再犯。
    const TITLE_Q = '改过的标题'
    // ⚠ 前置必须放在**撤销之前**量：放到后面去量，被撤销的那条本来就该是 0，
    //   "前置能命中"就永远不成立（这条我第一版就放错了位置，当场变红抓出来）。
    check('★ 前置：撤销前这个搜索词能命中（否则后面 total===0 是假绿）',
      mem.searchMemory({ q: TITLE_Q }).total === 1, 'hit=' + mem.searchMemory({ q: TITLE_Q }).total)
    const rev = mem.setMemoryStatus(made.file, '已撤销')
    check('★★ 能撤销（改状态而不是删文件）',
      rev.ok === true && fs.existsSync(path.join(tmpRoot, made.file)), rev.error || '')
    check('★★ 撤销后**文件还在**、正文一个字没动',
      fs.readFileSync(path.join(tmpRoot, made.file), 'utf-8').includes('改过之后的原文'))
    // ⚠ 搜索词必须是**真在标题里**的那个（'改过的标题'）。第一版我写成 '改过之后的标题' ——
    //   它既不在标题里也不在正文里，于是下面三条 `total === 0` 全部**假绿**
    //   （撤销/恢复两条根本验不到东西）。这是自己写出来的假绿，记在这儿防下次再犯。
    check('★★ 撤销后默认检索排除它（口径生效）',
      mem.searchMemory({ q: TITLE_Q }).total === 0, 'hit=' + mem.searchMemory({ q: TITLE_Q }).total)
    check('★ 勾上"含已撤销"能找回它（撤销≠消失）',
      mem.searchMemory({ q: TITLE_Q, includeRevoked: true }).total === 1,
      'hit=' + mem.searchMemory({ q: TITLE_Q, includeRevoked: true }).total)
    const back = mem.setMemoryStatus(made.file, '有效')
    check('★ 能恢复成有效（所以界面上给的是"撤销/恢复"而不是"删除"）',
      back.ok === true && mem.searchMemory({ q: TITLE_Q }).total === 1,
      (back.error || '') + ' hit=' + mem.searchMemory({ q: TITLE_Q }).total)
    const badSt = mem.setMemoryStatus(made.file, '删了吧')
    check('★★ 非法状态值 → 拒绝（不许凭空造第四种状态）',
      badSt.ok === false && /状态/.test(badSt.error), badSt.error)

    // ⑤ 写入侧的路径硬闸
    check('★★ 改 memory/ 之外的路径 → 拒绝',
      mem.updateMemory('task-data/decisions.md', { type: '教训', title: 't', body: 'b', source: 's' }).ok === false)
    check('★★ 改 ``../`` 逃逸路径 → 拒绝',
      mem.updateMemory('memory/../task-data/x.md', { type: '教训', title: 't', body: 'b', source: 's' }).ok === false)
    check('★ 改一条不存在的 → 如实报错（不静默成功）',
      mem.updateMemory('memory/2026-11/mem-nope.md', { type: '教训', title: 't', body: 'b', source: 's' }).ok === false)

    // ⑥ 写入也不许污染 task-data
    const tb = snapshot(path.join(tmpRoot, 'task-data'))
    check('★★ 建/改/撤销全过程 task-data 里没多出任何文件', tb.size === 0, 'n=' + tb.size)

    // ⑦ 待审批（2026-11-19）：agent 提案 → 用户通过/驳回
    //
    // 判据不是"有个状态字段"，而是：**默认检索看不见、通过后才看见、驳回后仍可找回**。
    const pend = mem.createMemory({
      type: '纪律', title: '待审批的提案', body: '提案原文（未获批前不该算数）',
      source: 'e2e-memory（临时根）', project: 'fangcun-base', impact: '高',
    }, { pending: true })
    check('★★ agent 写入口能建「待审批」（返回文件且落盘）',
      pend.ok === true && !!pend.file && fs.existsSync(path.join(tmpRoot, pend.file)), pend.error || pend.file)
    const pendText = fs.readFileSync(path.join(tmpRoot, pend.file), 'utf-8')
    check('★★ 强制写成 状态: 待审批（不是有效）', /^状态: 待审批$/m.test(pendText), pendText.slice(0, 120))
    check('★★ 默认检索**看不见**待审批', mem.searchMemory({ q: '待审批的提案' }).total === 0,
      'hit=' + mem.searchMemory({ q: '待审批的提案' }).total)
    check('★ includePending=true 才看得见', mem.searchMemory({ q: '待审批的提案', includePending: true }).total === 1,
      'hit=' + mem.searchMemory({ q: '待审批的提案', includePending: true }).total)
    const ovPending = mem.memoryOverview()
    check('★★ overview 把待审批单独计数（effective 不把它算进去）',
      ovPending.pending === 1 && ovPending.effective === 1, JSON.stringify({
        pending: ovPending.pending, effective: ovPending.effective, total: ovPending.total,
      }))

    // 通过 → 有效
    const pass = mem.setMemoryStatus(pend.file, '有效')
    check('★★ 用户通过后变有效（默认检索可见）',
      pass.ok === true && mem.searchMemory({ q: '待审批的提案' }).total === 1,
      (pass.error || '') + ' hit=' + mem.searchMemory({ q: '待审批的提案' }).total)

    // 驳回 → 已撤销；文件仍在，正文未动
    // ⚠ 探针用唯一 ASCII 标记：中文二字组会把「要被驳回的提案原文」切碎，
    //   碎片（驳回 / 原文）会蹭到临时根里别的条目 → 假命中（2026-11-24 当场抓到）。
    const REJECT_TAG = 'zzrejectq'
    const pend2 = mem.createMemory({
      type: '教训', title: '要被驳回的提案 ' + REJECT_TAG, body: '驳回也要留原文',
      source: 'e2e-memory（临时根）', project: 'fangcun-base',
    }, { pending: true })
    const reject = mem.setMemoryStatus(pend2.file, '已撤销', '证据不足')
    check('★★ 驳回后变已撤销，文件还在、正文没动',
      reject.ok === true && fs.existsSync(path.join(tmpRoot, pend2.file))
        && fs.readFileSync(path.join(tmpRoot, pend2.file), 'utf-8').includes('驳回也要留原文'),
      reject.error || '')
    check('★★ 驳回理由写进「审批备注」，不是丢掉',
      fs.readFileSync(path.join(tmpRoot, pend2.file), 'utf-8').includes('审批备注: 证据不足'),
      fs.readFileSync(path.join(tmpRoot, pend2.file), 'utf-8').slice(0, 200))
    const upd2 = mem.updateMemory(pend2.file, {
      type: '教训', title: '驳回后改标题', body: '驳回后改正文', source: 'e2e-memory',
    })
    check('★★ 编辑驳回条目不会把「审批备注」重渲染掉',
      upd2.ok === true
        && fs.readFileSync(path.join(tmpRoot, pend2.file), 'utf-8').includes('审批备注: 证据不足'),
      upd2.error || '')
    const pendQ = '要被驳回的提案'
    // ⚠ 2026-11-24：这一段已经 setDataDir 到 tmpRoot，所以 searchMemory 查的就是临时根。
    // 原来失败是因为加权和上线后探针词会被别的条目蹭到 —— 用更长的精确短语做探针。
    check('★★ 驳回后默认检索与待审批视图都看不见（撤销≠待审）',
      mem.searchMemory({ q: REJECT_TAG }).total === 0
        && mem.searchMemory({ q: REJECT_TAG, includePending: true }).total === 0,
      'default=' + mem.searchMemory({ q: REJECT_TAG }).total)
    check('★ 含已撤销能找回它（撤销≠删除；改过标题也还在）',
      mem.searchMemory({ q: '驳回后改标题', includeRevoked: true }).total >= 1,
      'hit=' + mem.searchMemory({ q: '驳回后改标题', includeRevoked: true }).total)

    // ⑧ 开工简报：项目 + 跨项目、按影响排序、待审批/已撤销不进
    const pend3 = mem.createMemory({
      type: '教训', title: '简报里的待审批', body: '这条不该进简报',
      source: 'e2e-memory（临时根）', project: 'fangcun-base', impact: '严重',
    }, { pending: true })
    check('★ 简报用的待审批条目建成功', pend3.ok === true, pend3.error || '')
    const cross = mem.createMemory({
      type: '纪律', title: '跨项目简报条目', body: '跨项目原文',
      source: 'e2e-memory（临时根）', project: '跨项目', impact: '严重',
    })
    check('★ 跨项目条目建成功', cross.ok === true, cross.error || '')
    const brief = mem.memoryBriefing('fangcun-base', 5)
    check('★★ 简报含本项目 + 跨项目', brief.items.some((x) => x.title === '跨项目简报条目')
      && brief.items.some((x) => x.title === '待审批的提案'), JSON.stringify(brief.items.map((x) => x.title)))
    check('★★ 待审批与已撤销都不进简报',
      !brief.items.some((x) => x.title === '简报里的待审批')
        && !brief.items.some((x) => x.title === '要被驳回的提案'),
      JSON.stringify(brief.items.map((x) => x.title)))
    check('★★ 本项目优先：fangcun-base 的条目排在跨项目「严重」之前',
      brief.items[0] && brief.items[0].project === 'fangcun-base'
        && brief.items.some((x) => x.title === '跨项目简报条目'),
      JSON.stringify(brief.items.map((x) => `${x.project}/${x.title}`)))
    const brief1 = mem.memoryBriefing('fangcun-base', 1)
    check('★ limit 生效，且 truncated 说出来（不假装看全）',
      brief1.returned === 1 && brief1.truncated === true, JSON.stringify(brief1))

    // ⑧b v2：claim 是索引句，证据保留原文；摘要不再从正文第一段猜
    const sumEntry = mem.createMemory({
      type: '事故', claim: '摘要测试：claim 是索引句',
      evidence: '## 定级\n\n**严重** —— 原文仍然逐字保留在证据里。',
      source: 'e2e-memory（临时根）', project: 'fangcun-base',
    })
    const sumRow = mem.searchMemory({ q: '摘要测试' }).rows[0]
    check('★★ v2：claim 就是检索句，证据保留 Markdown 原文',
      sumEntry.ok && sumRow && sumRow.claim === '摘要测试：claim 是索引句'
        && String(sumRow.evidence || '').includes('**严重**'),
      JSON.stringify(sumRow && { claim: sumRow.claim, evidence: sumRow.evidence }))

    // ⑧c memory_read 有上限，且截断要明说
    const longBody = '长文'.repeat(2000) // 4000 字符
    const longEntry = mem.createMemory({
      type: '教训', title: '长文读取上限', body: longBody,
      source: 'e2e-memory（临时根）', project: 'fangcun-base',
    })
    const rd = mem.readMemory(longEntry.file, 1000)
    check('★★ memory_read 默认/指定上限生效，且 truncated 明说',
      longEntry.ok && rd.ok === true && rd.truncated === true
        && String(rd.text || '').length === 1000 && Number(rd.chars) > 1000,
      JSON.stringify({ ok: rd.ok, len: String(rd.text || '').length, chars: rd.chars, truncated: rd.truncated }))

    // ⑨ MCP 真调用：memory_write 只能落待审批
    let mcpWrite = null
    try {
      const tools = require(toolsPath)
      const res = tools.handleMCPToolCall('memory_write', {
        type: '事故', title: 'MCP 写入口提案', body: 'mcp 原文', source: 'e2e-memory（临时根）',
      }, {})
      if (res && typeof res.then !== 'function') mcpWrite = res
    } catch (e) {
      mcpWrite = { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) }] }
    }
    let mcpParsed = {}
    try { mcpParsed = JSON.parse((mcpWrite && mcpWrite.content && mcpWrite.content[0] && mcpWrite.content[0].text) || '{}') } catch { /* 下面断言会红 */ }
    check('★★ MCP memory_write 真落待审批（不是只写在源码里）',
      mcpParsed.ok === true && mcpParsed.status === '待审批'
        && !!mcpParsed.file && fs.existsSync(path.join(tmpRoot, mcpParsed.file)),
      JSON.stringify(mcpParsed))
    check('★★ MCP 写进去的默认检索看不见（要用户在记忆页通过）',
      mem.searchMemory({ q: 'MCP 写入口提案' }).total === 0
        && mem.searchMemory({ q: 'MCP 写入口提案', includePending: true }).total === 1)

    // ⑩ 规模预算：30 条也只是一屏 claim，不是把记忆全塞进上下文
    for (let i = 0; i < 30; i++) {
      mem.createMemory({
        type: '教训', title: `规模测试 ${i}`, body: `规模测试正文 ${i}`,
        source: 'e2e-scale', project: 'fangcun-base',
      })
    }
    const scale = mem.searchMemory({})
    check('★★ 默认检索最多 10 条（不是 50 条 / 全部）',
      scale.rows.length === 10 && scale.total >= 30,
      JSON.stringify({ returned: scale.rows.length, total: scale.total }))
    const scaleBrief = mem.memoryBriefing('fangcun-base', 5)
    check('★★ 开工简报最多 5 条（且 truncated 说出来）',
      scaleBrief.items.length === 5 && scaleBrief.truncated === true,
      JSON.stringify({ returned: scaleBrief.items.length, total: scaleBrief.total }))
  } finally {
    data.setDataDir(realRoot)
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 清不掉就算了，别让它盖住结论 */ }
  }
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
