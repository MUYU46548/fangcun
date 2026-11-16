#!/usr/bin/env node
/**
 * 反向提问出口守卫（2026-11-16 · P14 · D-142 / D-098 / REV-011 ④）
 *
 * ## 钉的是什么
 *
 * 暮雨 2026-11-12：「差在我说不清的地方 —— **你先问我几个反向问题**」（D-098）。
 * 2026-11-15 追问条数，选 **D-142 = C「不设固定条数，由方寸自己判断哪几条真会影响计划」**。
 *
 * 验收线原文（D-142 备注）：
 * > 「若选 A 而我某次问了超过 3 条 = 违约；**任何一条问题缺【意见】= 违约（REV-011 ④ 硬性）**。」
 *
 * 选 C 的必然后果：不设条数 ⇔ **必须有"该不该问"的判据**，否则等于没有约束。
 *
 * ## 所以这里钉的是判据，不是"能不能跑"
 *
 *   ① **答不改就不问**：不影响任何阶段卡的题，必须进 `dropped` 并写明原因
 *   ② **缺【意见】不许出卷**（REV-011 ④ 硬性）→ 进 dropped 且原因点明
 *   ③ **答过的不再问**（病③：同一个问题问两遍）
 *   ④ **不设条数**：既不许写死上限，也不许为了凑数硬塞（asked 可以是 0）
 *   ⑤ **每条都带代价**：选项 ≥2 且每个选项都有 cost
 *   ⑥ **纯函数**：不读盘、不写盘
 *
 * ⚠ 反例自证（`check-ask-back-mutations.py`）是这套的必需品：
 *   "asked 可以是 0" 这种设计，守卫本身也可能永远绿。
 *
 * 跑法：node scripts/test/e2e-ask-back.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'desktop', 'src', 'main', 'llm', 'askBack.ts')
// 编译产物优先（真跑）；没有就现场 tsc 到一个临时目录
const DIST = path.join(ROOT, 'desktop', 'dist', 'main', 'llm', 'askBack.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function load() {
  if (!fs.existsSync(SRC)) return null
  if (fs.existsSync(DIST)) return require(DIST)
  // 现场编译（不落仓库：输出到临时目录）
  //
  // ⚠ 2026-11-16 实测踩到：这里原先写 `execFileSync('npx', ['tsc', …])` ——
  //   本机 `npx` 是 **.ps1 包装**，`execFileSync` 直接 spawn 它必然 ENOENT，
  //   而错误被上面的 `if (!m) { report(); return }` 吞成"只跑了 3 条就结束"，
  //   **看起来像"守卫通过"**。这正是本仓反复记的"静默跳过冒充通过"。
  //   现在直接调 `desktop/node_modules/typescript/bin/tsc`（不受 shell 包装影响）。
  const os = require('os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-askback-'))
  const tsc = path.join(ROOT, 'desktop', 'node_modules', 'typescript', 'bin', 'tsc')
  let lastErr = ''
  const tries = [
    [tsc, ['--outDir', tmp, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck', SRC]],
    ['node', [tsc, '--outDir', tmp, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck', SRC]],
  ]
  for (const [cmd, args] of tries) {
    try {
      execFileSync(cmd, args, { cwd: path.join(ROOT, 'desktop'), encoding: 'utf-8', timeout: 180000, stdio: 'pipe' })
      lastErr = ''
      break
    } catch (e) {
      lastErr = String((e && (e.stderr || e.message)) || e)
    }
  }
  // tsc 可能把输出摊平或放进子目录，两个位置都找
  const cands = [
    path.join(tmp, 'askBack.js'),
    path.join(tmp, 'src', 'main', 'llm', 'askBack.js'),
    path.join(tmp, 'main', 'llm', 'askBack.js'),
  ]
  for (const f of cands) if (fs.existsSync(f)) return require(f)
  console.log('!! 编译产物没找到，最后一次错误：' + lastErr.slice(0, 400))
  console.log('   临时目录内容：' + (fs.readdirSync(tmp).join(',') || '(空)'))
  return null
}

function main() {
  console.log('=== 一、文件与接口 ===')
  check('★★ askBack.ts 存在（P14 的第一条判据）', fs.existsSync(SRC), SRC)
  if (!fs.existsSync(SRC)) { report(); return }

  const src = fs.readFileSync(SRC, 'utf-8')
  check('★★ 源码里写着「答不改就不问」（D-142 的收窄判据，原文）',
    src.indexOf('答不改就不问') >= 0)
  check('★ 有「缺【意见】不许出卷」的硬拦（REV-011 ④）',
    src.indexOf('REV-011') >= 0 && /缺【意见】|不许出卷/.test(src))

  const m = load()
  if (!m) { report(); return }
  check('★★ 导出了 affectsPlan / buildAskBack（纯函数，不依赖 electron）',
    typeof m.affectsPlan === 'function' && typeof m.buildAskBack === 'function')

  // ── 二、答不改就不问（核心判据）─────────────────────────────
  console.log('\n=== 二、答不改就不问（D-142 选 C 的必然后果）===')
  const base = {
    stages: [
      { id: 'P1', title: '产出口径', status: '已冻结', criteria: [] },              // 没判据
      { id: 'P2', title: '界面重做', status: '已冻结', criteria: ['cmd: a', 'cmd: b'] }, // 有判据
      { id: 'P3', title: '已完成', status: '完成', criteria: [] },                  // 做完了
    ],
    constRows: [{ kind: '冲突', text: '外观按 D-077 还是 D-140', cites: ['decision:D-077'] }],
    decided: [{ id: 'D-140', text: '外观整站重做' }],
  }

  check('★★ 点了"没判据"的那格 → 该问，原因是"写这一格的判据"',
    (() => {
      const r = m.affectsPlan({ ask: 'P1 这一格怎么验收？' }, { ...base, openQuestions: [] })
      return r && r.kind === '没有判据' && r.stage === 'P1'
    })())
  check('★★ 什么都点不到的题 → 不该问（返回 null）',
    m.affectsPlan({ ask: '今天天气怎么样' }, { ...base, openQuestions: [] }) === null)
  check('★★ 点名了**已完成**那格 → 不该问（做完的格子再问=纯打扰）',
    m.affectsPlan({ ask: 'P3 要不要再改改' }, { ...base, openQuestions: [] }) === null)

  // ── 三、缺意见 / 已答过 / 重复 —— 都要进 dropped 并写明原因 ──
  console.log('\n=== 三、丢弃的每一类都要说清原因 ===')
  const input = {
    ...base,
    openQuestions: [
      { fp: 'f1', ask: 'P1 这一格怎么验收？', project: 'fangcun-base' },   // 无意见（但它会影响计划）
      // ⚠ 这条夹具改过：原来写「界面整站重做要不要做？」—— 它**没点名任何阶段卡**，
      //   于是先被「答不改就不问」拦下，根本走不到"已被定过"那条分支。
      //   现在点名 P2（已冻结、有判据）让它先过 affectsPlan，才好测去重。
      { fp: 'f2', ask: 'P2 界面整站重做要不要做？' },
      { fp: 'f3', ask: '今天天气怎么样' },                                  // 不改计划
      { fp: 'f3', ask: '今天天气怎么样' },                                  // 重复
    ],
  }
  const r = m.buildAskBack(input)
  check('★ asked 可以是 0（没有题会改变计划时就该闭嘴，不凑数）',
    r.questions.length === 0, 'asked=' + r.questions.length)
  const whys = r.dropped.map((d) => d.why).join(' | ')
  check('★★ 无意见的那条：原因点明「缺【意见】」（REV-011 ④）', /缺【意见】/.test(whys), whys.slice(0, 120))
  check('★★ 已被定过的那条：原因点明是哪条决策', /定过|D-\d{3}/.test(whys), whys.slice(0, 120))
  check('★★ 不改计划的那条：原因点明「答不改就不问」', /答不改就不问/.test(whys), whys.slice(0, 120))
  check('★ 重复的题也被点出来', /重复/.test(whys), whys.slice(0, 160))

  // ⚠ 2026-11-16 反例自证抓到的守卫缺口：上面几条测的都是「原因文案」，
  //   而**没有任何一条断言"不该问的那题真的没被问出来"**。于是把 buildAskBack
  //   里的收窄闸整块删掉，也只红 1 条（文案没了），扣不住产品行为。
  check('★★ 不该问的题**真的没出现在 questions 里**（不是只写在 dropped 里）',
    !r.questions.some((q) => /今天天气/.test(q.ask)),
    'questions=' + JSON.stringify(r.questions.map((q) => q.ask)))
  check('★★ 统计口径自洽：considered = asked + dropped',
    r.stats.considered === r.stats.asked + r.stats.dropped,
    JSON.stringify(r.stats))

  // ── 四、合格的题必须带：≥2 互斥选项 + 每个选项有代价 + 意见 ──
  console.log('\n=== 四、合格题的形状（REV-011 ④）===')
  const good = {
    ...base,
    openQuestions: [{
      fp: 'g1', ask: 'P1 这一格怎么验收？',
      __opinion: { pick: 'A', why: '判据里已经有 cmd', confidence: '中' },
      __options: [
        { k: 'A', text: '只认 cmd', cost: '要去掉两条 str 判据' },
        { k: 'B', text: '原样保留', cost: '这一格继续拖着' },
      ],
      __cites: ['decision:D-141'],
    }],
  }
  const rg = m.buildAskBack(good)
  check('★★ 合格的题真的出了（不是所有题都被丢掉）', rg.questions.length === 1, 'n=' + rg.questions.length)
  const q0 = rg.questions[0] || {}
  check('★★ 出了的题带【意见】+ 理由 + 把握', !!(q0.opinion && q0.opinion.pick && q0.opinion.why && q0.opinion.confidence))
  check('★★ 选项 ≥2 且**每个都有代价**',
    (q0.options || []).length >= 2 && (q0.options || []).every((o) => o.cost && o.cost.length > 2),
    JSON.stringify((q0.options || []).map((o) => o.k)))
  check('★★ 出了的题必须说清它改变哪一格的哪个动作', !!(q0.affects && q0.affects.stage && q0.affects.action))

  // ── 五、不设条数（既无上限也无下限）────────────────────────
  console.log('\n=== 五、不设固定条数（D-142 选 C）===')
  const many = {
    ...base,
    openQuestions: [1, 2, 3, 4, 5, 6, 7].map((i) => ({
      fp: 'm' + i, ask: `P1 第 ${i} 件事怎么验收？`,
      __opinion: { pick: 'A', why: 'x', confidence: '中' },
      __options: [{ k: 'A', text: 'a', cost: 'c1' }, { k: 'B', text: 'b', cost: 'c2' }],
      __cites: [],
    })),
  }
  const rm = m.buildAskBack(many)
  check('★★ 7 条都该问时，不人为截断到 3 条（D-142 上限已废）',
    rm.questions.length > 3, 'asked=' + rm.questions.length)
  check('★ 源码里没有写死条数上限（`MAX_ASKS` / `< 3` 之类）',
    !/MAX_ASKS|maxAsks|slice\(0,\s*3\)/.test(src))

  // ── 六、纯函数：不读盘不写盘 ────────────────────────────────
  console.log('\n=== 六、纯函数（不读盘不写盘）===')
  const body = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  check('★★ 源码不 import fs / electron / 不写盘',
    !/require\(['"]fs|from ['"]fs|from ['"]electron|writeFileSync/.test(body))

  report()
}

function report() {
  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main()
