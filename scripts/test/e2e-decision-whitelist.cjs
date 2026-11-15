/**
 * 决策白名单 · 不许按喂料条数截断（2026-11-15 真 bug 的守卫）
 *
 * 修的什么：`effectiveDecisions()` 里 `sort(按日期).slice(0, 12)`，
 * 而同一批决策的**日期常常完全相同**（OB37 五卷 33 条全是 2026-11-15）→
 * 排序等于没排 → 砍掉的是**文件末尾**，最新拍板反而不可引。
 * 而 `allowedCitations()` 直接遍历同一个数组生成白名单 →
 * 按最新决策起草的格子被 `plan_submit` 判「引用了不存在的依据」整格丢弃。
 *
 * 修法：拆成两个集合 —— 白名单用**全量** id（`decisionIds`），证据行仍只喂 12 条。
 * 校验要宽、喂料要窄。
 *
 * 为什么必须真跑 `dist`：这是主进程逻辑，改源码不 build 时这条会当场暴露。
 *
 * 运行：node scripts/test/e2e-decision-whitelist.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..', '..')
const DIST_MAIN = path.join(ROOT, 'desktop', 'dist', 'main')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

if (!fs.existsSync(path.join(DIST_MAIN, 'llm', 'planDraft.js'))) {
  console.log('SKIP  编译产物不存在（先 cd desktop && npm run build）')
  console.log('RESULT 0 / 0')
  process.exit(0)
}

console.log('== 决策白名单 · 不许按喂料条数截断 ==')

// ── ① 纯函数层：allowedCitations 必须同时收 decisions 与 decisionIds ──────
{
  const pd = require(path.join(DIST_MAIN, 'llm', 'planDraft.js'))
  const input = {
    project: 'x',
    decisions: [{ id: 'D-1', 内容: 'a' }, { id: 'D-2', 内容: 'b' }],
    decisionIds: ['D-1', 'D-2', 'D-3', 'D-4'],
  }
  const allow = pd.allowedCitations(input)
  const got = allow.filter((x) => x.startsWith('decision:'))
  check('★★ 白名单收下 decisionIds 里的全量 id（不只 decisions 那几条）',
    got.includes('decision:D-3') && got.includes('decision:D-4'),
    `白名单=${got.join(',')}`)
  check('★ decisions 里的 id 也仍在（两条来源合并，不是替换）',
    got.includes('decision:D-1') && got.includes('decision:D-2'),
    got.join(','))
}

// ── ② 老调用方零破坏：不给 decisionIds 时行为不变 ───────────────────────
{
  const pd = require(path.join(DIST_MAIN, 'llm', 'planDraft.js'))
  const allow = pd.allowedCitations({ project: 'x', decisions: [{ id: 'D-9' }] })
  check('★ 不给 decisionIds 时退回 decisions（老调用方零破坏）',
    allow.includes('decision:D-9'), allow.filter((x) => x.startsWith('decision:')).join(','))
}

// ── ③ 真数据端到端：rosa 的 D-131 / D-132 / D-137 必须可引 ───────────────
{
  const dataDir = 'E:/CODE/CangKu/fangcun'
  if (!fs.existsSync(path.join(dataDir, 'task-data', 'decisions.md'))) {
    console.log('SKIP  真实数据目录不在本机，跳过端到端')
  } else {
    const dataMod = require(path.join(DIST_MAIN, 'data', 'index.js'))
    dataMod.setDataDir(dataDir)
    const pd = require(path.join(DIST_MAIN, 'llm', 'planDraft.js'))
    const pdi = require(path.join(DIST_MAIN, 'llm', 'planDraftInput.js'))
    // 同步读磁盘的入口（WithRepo 是异步的，这里只要 decisions 这一路）
    const input = pdi.buildPlanDraftInputFromDisk({ project: 'rosa-chuangzuo' })
    const allow = pd.allowedCitations(input).filter((x) => x.startsWith('decision:'))
    const want = ['D-131', 'D-132', 'D-137']
    const missing = want.filter((d) => !allow.includes(`decision:${d}`))
    check('★★ 真数据里同日签发的 33 条决策全部可引（D-131/D-132/D-137 在，这是原 bug 的现场）',
      missing.length === 0, `缺=${missing.join(',')} 白名单条数=${allow.length}`)
    check('★ 喂料仍然只有 12 条（校验要宽、喂料要窄 —— 别把上下文撑爆）',
      (input.decisions || []).length <= 12,
      `喂料=${(input.decisions || []).length}`)
    // 反向：白名单条数必须明显大于喂料条数（否则说明还在用同一个集合）
    check('★★ 白名单条数 > 喂料条数（证明两个集合真的拆开了）',
      allow.length > (input.decisions || []).length,
      `白名单=${allow.length} 喂料=${(input.decisions || []).length}`)
  }
}

// ── ④ 同日排序的 tie-break：不许再"按文件顺序" ───────────────────────────
{
  // 用临时数据根造三条同日、文件顺序与 id 顺序相反的数据
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dec-'))
  try {
    fs.mkdirSync(path.join(tmp, 'task-data'), { recursive: true })
    const mk = (id) => [
      `## ${id} 结论${id}`,
      '- 日期: 2026-11-15',
      '- 状态: 有效',
      '- 项目: p1',
      '- 出处: 测试',
      '',
    ].join('\n')
    // ⚠ 文件顺序必须与 id 顺序**相反**，否则测不出 tie-break：
    //   现代 V8 的 Array.sort 是稳定的，同日（比较返回 0）时会保持文件顺序。
    //   第一版我先写 D-300 再写 D-100（文件顺序恰好就是期望的降序）→
    //   去掉 tie-break 也能"通过"，**反例自证当场发现这是假绿**。
    fs.writeFileSync(path.join(tmp, 'task-data', 'decisions.md'),
      [mk('D-100'), mk('D-200'), mk('D-300')].join('\n'), 'utf-8')
    const dataMod = require(path.join(DIST_MAIN, 'data', 'index.js'))
    dataMod.setDataDir(tmp)
    const pdi = require(path.join(DIST_MAIN, 'llm', 'planDraftInput.js'))
    const input = pdi.buildPlanDraftInputFromDisk({ project: 'p1' })
    const ids = (input.decisions || []).map((d) => d.id)
    check('★★ 同日决策按 id 降序（最新在前），不是按文件顺序',
      ids[0] === 'D-300' && ids[1] === 'D-200' && ids[2] === 'D-100',
      `实际顺序=${ids.join(',')}`)
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
