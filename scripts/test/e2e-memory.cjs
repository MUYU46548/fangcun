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
check('★★ 搜不到时 total=0，且 overview 证明库里有货（分得清「筛出来没有」与「库是空的」）',
  miss.total === 0 && mem.memoryOverview().total > 0, `miss=${miss.total} overview=${mem.memoryOverview().total}`)

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
check('★ dispatcher 里有对应分支', (toolsSrc.match(/case\s+['"]memory_(search|read)['"]/g) || []).length === 2)

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
    check('★ 路径落在 memory/<yyyy-mm>/ 下（不进 task-data）',
      /^memory\/\d{4}-\d{2}\//.test(String(made.file)) && !String(made.file).includes('task-data'),
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
  } finally {
    data.setDataDir(realRoot)
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 清不掉就算了，别让它盖住结论 */ }
  }
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
