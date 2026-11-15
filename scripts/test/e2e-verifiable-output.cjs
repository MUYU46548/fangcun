/**
 * 可核实产出（2026-11-15 · 决策 D-141 / O1 选 A）
 *
 * 真跑编译产物 `dist/shared/verifiableOutput.js` + `dist/shared/waste.js` + `dist/shared/mismatch.js`。
 *
 * 这一套钉的不是"能算出数"，而是**口径不许退回自报**：
 *   ① `卡变完成` 再出现当作产出 = 红（产品定义明写"不算，那是自报"）
 *   ② 判不了（没接上路径判据）**不许**退回去数完成卡，也不许冒充"0 件"
 *   ③ `mismatch` 与 `waste` 必须引**同一份**判据（同一件事写两份是本仓反复犯的病）
 *   ④ 有反例自证：把旧口径装回去，必须精确变红
 *
 * 运行：node scripts/test/e2e-verifiable-output.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const V_ART = path.join(REPO, 'desktop', 'dist', 'shared', 'verifiableOutput.js')
const W_ART = path.join(REPO, 'desktop', 'dist', 'shared', 'waste.js')
const M_ART = path.join(REPO, 'desktop', 'dist', 'shared', 'mismatch.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

for (const art of [V_ART, W_ART, M_ART]) {
  if (!fs.existsSync(art)) {
    console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + art)
    console.log('RESULT 0 / 1')
    process.exit(1)
  }
}

const { hasVerifiableOutput, VERIFIABLE_CAVEAT } = require(V_ART)
const { buildWasteLedger, deriveWasteInsight } = require(W_ART)

const NOW = '2026-11-01T04:00:00.000Z'
const TRACE = [
  { ts: '2026-11-01T03:00:00.000Z', cost: '0.00120000', total_tokens: 1000 },
]

console.log('== ① 判据本体：三样可核实的东西各认一次 ==')
{
  const yes = { exists: (rel) => rel === 'docs/存在.md' }
  check('★★ 卡里有真实存在的路径 → 算可核实产出',
    hasVerifiableOutput({ body: '改了 `docs/存在.md` 的那段' }, yes))
  check('★ 路径不存在 → 不算',
    !hasVerifiableOutput({ body: '改了 `docs/不存在.md`' }, yes))
  check('★ 带上下文的提交号 → 算',
    hasVerifiableOutput({ body: '提交 653b1cc 修掉了' }, { exists: () => false }))
  check('★ http 链接 → 算',
    hasVerifiableOutput({ body: '见 https://github.com/x/y/pull/1' }, { exists: () => false }))
  check('★ 通配 / 省略号不是可判路径（不许拿 `*.md` 蒙过）',
    !hasVerifiableOutput({ body: '改了 `docs/*.md` 和 `a/.../b.md`' }, { exists: () => true }))
  check('★★ 空正文 → 不算（不许把"没正文"当"有产出"）',
    !hasVerifiableOutput({ body: '' }, { exists: () => true }))
  check('★ 跨仓库：本仓没有、项目仓有 → 算',
    hasVerifiableOutput({ body: '改了 `src/a.ts`' }, {
      exists: () => false,
      repos: [{ name: 'p', exists: (rel) => rel === 'src/a.ts' }],
    }))
}

console.log('\n== ② waste 产出格：不再数「卡完成」==')
{
  const TASKS = [
    // 完成 + 有可核实产出
    { id: 't1', title: '甲', status: '完成', updated: '2026-11-01T01:00:00.000Z', body: '落盘 `docs/存在.md`' },
    // 完成但正文啥都没有（典型自报）
    { id: 't2', title: '乙', status: '完成', updated: '2026-11-01T02:00:00.000Z', body: '做完了，验收通过' },
    // 完成但只在窗口外
    { id: 't3', title: '丙', status: '完成', updated: '2026-09-01T01:00:00.000Z', body: '落盘 `docs/存在.md`' },
    // 未完成
    { id: 't4', title: '丁', status: '待办', updated: '2026-11-01T03:00:00.000Z', body: '`docs/存在.md`' },
  ]
  const exists = (rel) => rel === 'docs/存在.md'
  const l = buildWasteLedger({ days: 30, now: NOW, trace: TRACE, commits: ['aaa'], tasks: TASKS, exists })
  const out = l.cells.find((c) => c.key === 'output')
  check('★★ 产出的 value 里**不再出现**「N 张卡完成」',
    !!out && !/张卡完成/.test(out.value), out && out.value)
  check('★★ 产出只数可核实的那一件（2 张完成，只有 1 张可核实）',
    !!out && out.value === '1 次提交 · 1 件可核实产出', out && out.value)
  check('★★ detail 必须说清「其余是自报完成，不算产出」—— 数字掉了要能查到原因',
    !!out && /自报完成/.test(out.detail) && /2 张/.test(out.detail), out && out.detail)
  check('★ raw.verified 走真分子，raw.done 只作对照',
    out && out.raw && out.raw.verified === 1 && out.raw.done === 2,
    out && JSON.stringify(out.raw))
  check('★★ 每格仍带「它证明不了什么」（缺了整格不产出）',
    !!out && out.caveat.indexOf('它证明不了什么') >= 0)
  check('★ 「可核实」的局限必须明写「不证明它有用」',
    !!out && /不证明它有用/.test(out.caveat), out && out.caveat)
  check('★ 口径常量与 witness 一致（VERIFIABLE_CAVEAT 就是那句）',
    !!VERIFIABLE_CAVEAT && out.caveat.indexOf(VERIFIABLE_CAVEAT) === 0)
}

console.log('\n== ③ 判不了 ≠ 0 件（没接上判据不许冒充）==')
{
  const TASKS = [
    { id: 't1', title: '甲', status: '完成', updated: '2026-11-01T01:00:00.000Z', body: '落盘 `docs/存在.md`' },
  ]
  const l = buildWasteLedger({ days: 30, now: NOW, trace: TRACE, commits: ['aaa'], tasks: TASKS })
  const out = l.cells.find((c) => c.key === 'output')
  check('★★ 没给 exists → 不数可核实产出，也不退回「张卡完成」',
    !!out && !/件可核实产出/.test(out.value) && !/张卡完成/.test(out.value), out && out.value)
  check('★★ detail 必须明说「判不了」，不许说成 0 件',
    !!out && /判不了/.test(out.detail) && !/0 张/.test(out.detail), out && out.detail)
  check('★ raw.verified 是 undefined（"判不了"不是 0）',
    out && out.raw && out.raw.verified === undefined, out && JSON.stringify(out.raw))
  const ins = deriveWasteInsight(l)
  check('★★ insight 判不了时不许拿完成卡当分母',
    ins.ok === false && /判不了/.test(ins.text) && !/张完成卡/.test(ins.text), ins.text)
}

console.log('\n== ④ insight 的分母是「可核实产出」，不是「完成卡」==')
{
  const TASKS = [
    { id: 't1', title: '甲', status: '完成', updated: '2026-11-01T01:00:00.000Z', body: '落盘 `docs/存在.md`' },
    { id: 't2', title: '乙', status: '完成', updated: '2026-11-01T02:00:00.000Z', body: '自报完成' },
    { id: 't3', title: '丙', status: '完成', updated: '2026-11-01T02:30:00.000Z', body: '自报完成' },
  ]
  const l = buildWasteLedger({
    days: 30, now: NOW, trace: TRACE, commits: ['aaa'], tasks: TASKS,
    exists: (rel) => rel === 'docs/存在.md',
  })
  const ins = deriveWasteInsight(l)
  check('★★ insight 用 1 件（可核实）而不是 3 张（完成卡）当分母',
    ins.ok === true && /可核实产出 1 件/.test(ins.text) && !/3 张/.test(ins.text), ins.text)
  check('★ insight 文案里不出现「每张完成卡」（那是旧口径的说法）',
    /每件/.test(ins.text) && !/每张完成卡/.test(ins.text), ins.text)
}

console.log('\n== ⑤ 可核实产出为 0 时明写算不出 ==')
{
  const TASKS = [
    { id: 't1', title: '甲', status: '完成', updated: '2026-11-01T01:00:00.000Z', body: '自报完成' },
  ]
  const l = buildWasteLedger({ days: 30, now: NOW, trace: TRACE, commits: ['aaa'], tasks: TASKS, exists: () => false })
  const out = l.cells.find((c) => c.key === 'output')
  check('★ 0 件可核实产出是**真值**，照常显示（不是"判不了"）',
    !!out && out.raw && out.raw.verified === 0, out && JSON.stringify(out.raw))
  const ins = deriveWasteInsight(l)
  check('★★ insight 明写算不出，并点出「有 1 张自报完成但一件都不可核实」',
    ins.ok === false && /可核实产出为 0/.test(ins.text) && /1 张自报完成/.test(ins.text), ins.text)
}

/**
 * 剥注释后再扫。
 *
 * 为什么必须剥：本仓踩过一次——守卫在注释里读到"没有 fetch/LLM"这句解释，
 * 把它当成真的调用了。解释不是调用，注释里的旧口径更不是旧实现。
 * 这里 waste.ts 的新注释**故意**写着「改动前实现的是「N 张卡完成」」来解释改了什么，
 * 不剥注释就会把这段解释判成"还没改"。
 */
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
}

console.log('\n== ⑥ 唯一真源：mismatch 与 waste 引同一份判据 ==')
{
  const m = require(M_ART)
  check('★ mismatch 仍然导出 hasVerifiableOutput（老调用方零破坏）',
    typeof m.hasVerifiableOutput === 'function')
  check('★★ mismatch 导出的就是 verifiableOutput 里的那一个（同一份实现）',
    m.hasVerifiableOutput === hasVerifiableOutput)
  const mSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'shared', 'mismatch.ts'), 'utf-8')
  check('★★ 源码守卫：mismatch 不许再自己写一套 URL / 提交号 / 路径三判据',
    !/RE_COMMIT_CTX\s*=/.test(mSrc) && !/PATH_BARE\s*=/.test(mSrc) && !/RE_URL\s*=/.test(mSrc),
    'mismatch.ts 里仍有自写的判据常量')
  check('★ 源码守卫：mismatch 显式 import verifiableOutput',
    /from '\.\/verifiableOutput'/.test(mSrc))
  const wSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'shared', 'waste.ts'), 'utf-8')
  check('★ 源码守卫：waste 引 verifiableOutput，不自己判路径',
    /from '\.\/verifiableOutput'/.test(wSrc) && !/PATH_BARE/.test(stripComments(wSrc)))
  check('★★ 源码守卫：waste 里不许再出现「张卡完成」这种自报口径（先剥注释再扫）',
    !/张卡完成/.test(stripComments(wSrc)), 'waste.ts 的**代码**里还有「张卡完成」')
}

console.log('\n== ⑦ 真数据：拿本仓真卡跑一遍（不是只为夹具写的）==')
{
  // 从真 task-data 里取若干完成卡，确认判据不把"有路径的"和"纯自述的"混为一谈
  const dir = path.join(REPO, 'task-data')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).slice(0, 400)
  let done = 0, withOut = 0
  const exists = (rel) => {
    try { return fs.existsSync(path.join(REPO, rel)) } catch { return false }
  }
  for (const f of files) {
    let txt = ''
    try { txt = fs.readFileSync(path.join(dir, f), 'utf-8') } catch { continue }
    const st = /^状态:\s*(.*)$/m.exec(txt)
    if (!st || st[1].trim() !== '完成') continue
    done++
    const body = txt.replace(/^---[\s\S]*?\n---/, '')
    if (hasVerifiableOutput({ body }, { exists })) withOut++
  }
  check('★ 真数据里确实有完成卡（这条断言不是为假想 scenario 写的）', done > 0, `完成卡 ${done} 张`)
  check('★★ 真数据里「完成」与「可核实产出」**不是一个数** —— 差的那些就是自报',
    done > withOut, `完成 ${done} / 可核实 ${withOut}（这正是不该拿自报当产出的证据）`)
  console.log(`      （真数据实测：完成卡 ${done} 张，其中可核实产出 ${withOut} 张）`)
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log(failures.map((x) => '  - ' + x).join('\n')) }
process.exit(fail ? 1 : 0)
