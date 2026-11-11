#!/usr/bin/env node
/**
 * 结论集与收敛判据 e2e（2026-11-11 · P8 of 0.7.0 · 拍板 D-064）
 *
 * 拍板原话：「结论集连续 3 轮重算不变即收敛」。本套把“问够没问够”从感觉变成断言：
 *   ① 归一化：日期 / 出处 / 生效范围 / 括号 / 标点 都不该改变“结论是什么”；
 *   ② 结论集：只收有效决策、项目过滤（本项目 + 全局）、同内容去重；
 *   ③ 走一步：新增 >0 → 连续零新增归零；新增 = 0 → +1；连续 3 次 → converged；
 *   ④ 真数据端到端：真建卷 → 真 approveDeck → 真落 `task-data/decisions.convergence.json`；
 *   ⑤ 作废一卷 → 结论消失 → 计数归零（不许只加不减）。
 *
 * 运行：node scripts/test/e2e-qn-converge.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('qn-converge-')
const DATA = path.join(TMP, 'data')
const QDIR = path.join(DATA, 'task-data', 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, path.join(DATA, 'task-data'), QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'), 'projects:\n  - id: fangcun-base\n    name: 方寸\n    repo: .\n', 'utf-8')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))
const conv = require(path.join(DIST, 'shared', 'convergence.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

console.log('== ① 归一化：什么算“同一条结论” ==')
{
  const a = conv.normalizeDecisionContent('[2026-11-10] A. 甲 生效范围：本卷')
  const b = conv.normalizeDecisionContent('A. 甲')
  check('★★ 日期 / 生效范围 / 标点 不影响指纹', a === b && !!a, `${a} | ${b}`)
  const c = conv.normalizeDecisionContent('A. 甲（代价甲）')
  check('★ 括号旁注（代价）不算结论本身', c === a, c)
  const d = conv.normalizeDecisionContent('B. 乙')
  check('★★ 实质内容不同 → 指纹不同', conv.fingerprintOf(a) !== conv.fingerprintOf(d))
  check('★ 空白与全角标点等价', conv.normalizeDecisionContent('A．甲') === a, conv.normalizeDecisionContent('A．甲'))
}

console.log('== ② 结论集：只收有效 / 项目过滤 / 同内容去重 ==')
{
  const ds = [
    { id: 'D-1', 内容: 'A. 甲', 状态: '有效', 项目: 'fangcun-base' },
    { id: 'D-2', 内容: '[2026-11-10] A. 甲 生效范围：本卷', 状态: '有效', 项目: 'fangcun-base' },
    { id: 'D-3', 内容: 'C. 全局规矩', 状态: '有效', 项目: '' },
    { id: 'D-4', 内容: 'D. 别家项目的', 状态: '有效', 项目: 'sitian' },
    { id: 'D-5', 内容: 'E. 已被撤销的', 状态: '已撤销', 项目: 'fangcun-base' },
  ]
  const set = conv.conclusionSetOf(ds, 'fangcun-base')
  check('★★ 只收本项目 + 全局，且只收有效', set.total === 2, JSON.stringify(set.entries.map((e) => e.text)))
  check('★★ 同内容不同日期只算一条（去重）', set.entries.filter((e) => e.text === 'A甲').length === 1)
  check('★ 已撤销的结论不进集合', !set.entries.some((e) => e.text.includes('E')))
}

console.log('== ③ 走一步：新增归零 / 连续 3 次算收敛 ==')
{
  const set = (fps) => ({ algo: conv.CONVERGENCE_ALGO, total: fps.length, entries: [], fps })
  let prev = null
  let r = conv.stepConvergence({ prev, current: set(['aa', 'bb']), project: 'p' })
  check('★ 第一次（无快照）→ restarted，全部结论算本轮新增、连续计数从 0 起',
    r.restarted === true && r.added === 2 && r.snapshot.streak === 0, JSON.stringify(r.snapshot))
  prev = r.snapshot
  r = conv.stepConvergence({ prev, current: set(['aa', 'bb', 'cc']), project: 'p' })
  check('★★ 新增 1 条 → 连续零新增归零', r.added === 1 && r.snapshot.streak === 0, JSON.stringify(r.snapshot))
  prev = r.snapshot
  r = conv.stepConvergence({ prev, current: set(['aa', 'bb', 'cc']), project: 'p' })
  check('★★ 零新增 → 计数 +1', r.added === 0 && r.snapshot.streak === 1)
  prev = r.snapshot
  r = conv.stepConvergence({ prev, current: set(['aa', 'bb', 'cc']), project: 'p' })
  prev = r.snapshot
  r = conv.stepConvergence({ prev, current: set(['aa', 'bb', 'cc']), project: 'p' })
  check('★★ 连续 3 次零新增 → 判收敛（D-064 的 3）', r.converged === true && r.snapshot.streak === 3, String(r.snapshot.streak))
  check('★ 收敛后有一句人话（界面/CLI 同一口径）', /已收敛/.test(conv.describeConvergence(r.snapshot)), conv.describeConvergence(r.snapshot))
  const other = conv.stepConvergence({ prev: r.snapshot, current: set(['aa']), project: 'another' })
  check('★★ 换项目 → 重起炉灶（不拿 A 的进度套 B）', other.restarted === true && other.snapshot.streak === 0)
}

console.log('== ④ 真数据端到端：答完一卷 → 落快照 ==')
{
  const mkDeck = (name, tag) => {
    fs.writeFileSync(path.join(QDIR, name + '.md'), [
      '# ' + name, '**项目**：fangcun-base', '',
      '## A1 ' + tag, tag + '怎么做？',
      '- **A. 甲**——代价甲', '- **B. 乙**——代价乙', '【验收线】' + tag + '反例即违约', '',
    ].join('\n'), 'utf-8')
    store.writeAnswers(name, { answers: { A1: { kind: 'pick', k: 'A' } } })
    return store.approveDeck(name)
  }
  const r1 = mkDeck('方寸-收敛卷A', '第一问')
  const snapPath = path.join(DATA, 'task-data', 'decisions.convergence.json')
  check('★★ 批准一卷 → 自动落 decisions.convergence.json', fs.existsSync(snapPath), snapPath)
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'))
  check('★★ 快照里有 algo / project / streak / fps', snap.algo === conv.CONVERGENCE_ALGO
    && snap.project === 'fangcun-base' && typeof snap.streak === 'number' && Array.isArray(snap.fps),
    JSON.stringify(snap).slice(0, 200))
  check('★★ 第一轮新增 ≥1（这卷真贡献了结论）', r1.convergence.added >= 1, JSON.stringify(r1.convergence))
  check('★ 批准结果里带回人话进度', /连续不变|已收敛/.test(r1.convergence.summary || ''), r1.convergence.summary)

  // 同内容再答一卷（选项文字一模一样）→ 零新增
  const r2 = mkDeck('方寸-收敛卷B', '第一问')
  check('★★ 同内容的新卷 → 零新增（结论集不变）', r2.convergence.added === 0, JSON.stringify(r2.convergence.snapshot))
  check('★ 零新增 → 连续计数 1', r2.convergence.snapshot.streak === 1, String(r2.convergence.snapshot.streak))
  const r3 = mkDeck('方寸-收敛卷C', '第一问')
  const r4 = mkDeck('方寸-收敛卷D', '第一问')
  check('★★ 连续 3 卷零新增 → 判定收敛', r4.convergence.converged === true && r4.convergence.snapshot.streak === 3,
    JSON.stringify({ r3: r3.convergence.snapshot.streak, r4: r4.convergence.snapshot.streak }))
  check('★ 收敛写在 json 里（不是只在返回值里）',
    JSON.parse(fs.readFileSync(snapPath, 'utf-8')).streak >= 3)

  // 作废一卷 → 结论消失 → 归零
  store.voidDeck('方寸-收敛卷A', '需求变了')
  const after = JSON.parse(fs.readFileSync(snapPath, 'utf-8'))
  check('★★ 卷作废 → 结论集减掉、连续计数归零（不许只加不减）',
    after.streak === 0 && (after.lastRemoved >= 1 || after.lastAdded === 0), JSON.stringify(after))

  // 只读口
  const st = store.convergenceStatus('fangcun-base')
  check('★ 只读口给出一句话 + 需要几轮', typeof st.summary === 'string' && st.need === conv.CONVERGENCE_STREAK, JSON.stringify(st))
}

console.log('== ⑤ 接线守卫 ==')
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const qn = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/data/questionnaires.ts'), 'utf-8'))
  check('★★ approveDeck / voidDeck 都重算结论集', (qn.match(/recomputeConvergence\(/g) || []).length >= 2)
  const tools = strip(fs.readFileSync(path.join(REPO, 'desktop/src/main/mcp/tools.ts'), 'utf-8'))
  check('★★ qn_list 带回收敛进度（agent 看得见“问够没问够”）', /convergenceStatus\(project\)/.test(tools))
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
