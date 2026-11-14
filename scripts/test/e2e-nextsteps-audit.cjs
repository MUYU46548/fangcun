#!/usr/bin/env node
/**
 * 日志「下一步」清点与处置标记（2026-11-14 · P0-1）
 *
 * 这套断言钉的不是"脚本能跑"，而是**处置口径不能被糊弄**：
 *   ① 写了处置标记的条目必须从欠账里消失（否则"降"这个数永远为 0，等于没做）；
 *   ② 没写标记的必须**仍然算欠账**（不能因为加了新字段就把 205 条悄悄洗白）；
 *   ③ 「有卡在接」和「已处置」是两个口径，不许混成一个数（混了就查不出是谁漏的）；
 *   ④ 标记要在**原文**里（日志是以后任何人翻的东西，处置结果不能只活在脚本内存里）。
 *
 * 反例自证：把 DISPOSE_RE 拆掉 → ② 立刻变红（205 条全成已处置）。
 *
 * 运行：node scripts/test/e2e-nextsteps-audit.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '../..')
const SCRIPT = path.join(REPO, 'scripts', 'audit-log-nextsteps.cjs')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

/**
 * 造一个**临时仓库**跑脚本：脚本的 ROOT 是 `__dirname/..`，所以在 tmp 里按同样结构摆一份。
 * 不碰真数据 —— 这是这套测试的底线（真 task-data 一个字节都不许被它改）。
 */
function mkFixture(logs, cards) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ns-'))
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs', '执行日志'), { recursive: true })
  fs.mkdirSync(path.join(root, 'task-data'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'audit-log-nextsteps.cjs'))
  for (const [name, body] of Object.entries(logs)) {
    fs.writeFileSync(path.join(root, 'docs', '执行日志', name + '.md'), body, 'utf-8')
  }
  for (const [name, body] of Object.entries(cards || {})) {
    fs.writeFileSync(path.join(root, 'task-data', name + '.md'), body, 'utf-8')
  }
  return root
}

function logFile(title, nextStep) {
  return [
    '---',
    'type: execution-log',
    'title: ' + title,
    'status: active',
    '---',
    '# ' + title,
    '',
    '## 执行内容',
    '做了点事。',
    '',
    '## 下一步',
    nextStep,
  ].join('\n')
}

function run(root, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'audit-log-nextsteps.cjs'), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

console.log('== 日志下一步：清点与处置标记 ==')

// ── ① 没写处置 → 算欠账 ──────────────────────────────────────────────
const G1 = mkFixture({
  log_a: logFile('甲', '把日志关联任务的检索修好'),
})
{
  const r = run(G1, ['--stats'])
  check('★ 没有任何处置标记时，欠账 = 全部（不会凭空变少）',
    /仍未接（欠账）:\s*1/.test(r.out), r.out.trim().split('\n').slice(-2).join(' | '))
}

// ── ② 写了处置 → 从欠账里划掉，但仍在"已处置"里可查 ────────────────────
const G2 = mkFixture({
  // ⚠ 用**单条目**日志：多条目时"处置标记"会盖住全部条目（这是已知口径，见 ⑩），
  //   这里要验的是"标记生效"，不是"标记覆盖多少条"。
  log_done: logFile('乙', '把日志关联任务的检索修好\n\n处置：已做 —— eec99d4 收了单一真源'),
})
{
  const r = run(G2, ['--stats'])
  check('★★ 写了「处置：已做」→ 该条从欠账里消失（这是判据"降到 0"的唯一实现路径）',
    /仍未接（欠账）:\s*0/.test(r.out), r.out.trim().split('\n').join(' | '))
  check('★ 但"已写处置标记"里要能数到它（处置过的不等于没发生）',
    /已写处置标记:\s*1/.test(r.out), r.out.trim().split('\n').join(' | '))
  check('★ 处置类别被认出来（已做=1）',
    /已做:\s*1/.test(r.out), r.out.trim().split('\n').join(' | '))
}

// ── ③ 三种处置类别都要认（不许只认"已做"）──────────────────────────────
// 同上：每条都是**单条目**日志，避免标记覆盖多条目干扰计数。
const G3 = mkFixture({
  l1: logFile('丙一', '这件事后来不做了（当初想做的那个东西）\n\n处置：已放弃 —— 后来发现没意义'),
  l2: logFile('丙二', '这个要变成一张正式的卡\n\n处置：已转卡 task-20260101-001'),
  l3: logFile('丙三', '这是司天项目的活要处理\n\n处置：非本项目 —— 属于 sitian'),
})
{
  const r = run(G3, ['--stats'])
  check('★★ 三类处置（已放弃 / 已转卡 / 非本项目）都从欠账里划掉',
    /仍未接（欠账）:\s*0/.test(r.out), r.out.trim().split('\n').join(' | '))
  check('★ 三类各自计数对得上（各 1 条，不是都算成"其他"）',
    /已放弃:\s*1/.test(r.out) && /已转卡:\s*1/.test(r.out) && /非本项目:\s*1/.test(r.out),
    r.out.trim().split('\n').slice(-8).join(' | '))
}

// ── ④ 全角冒号 / 前面带项目符号 / 前后有空格 都要认 ──────────────────────
const G4 = mkFixture({
  l1: logFile('丁一', '- 处置：已做 —— 全角冒号 + 项目符号'),
  l2: logFile('丁二', '  处置: 已做 — 半角冒号 + 前导空格'),
})
{
  const r = run(G4, ['--stats'])
  check('★★ 全角冒号 / 半角冒号 / 项目符号 / 前导空格 都认（要求格式完美 = 没人会写）',
    /仍未接（欠账）:\s*0/.test(r.out), r.out.trim().split('\n').join(' | '))
}

// ── ⑤ 有卡在接的老口径仍在（不许被新逻辑挤掉）──────────────────────────
const CARD = ['---', 'title: 把日志关联任务的检索修好', '状态: 待办', '---', '正文'].join('\n')
const G5 = mkFixture({
  log_c: logFile('戊', '把日志关联任务的检索修好'),
}, { 'task-20260101-001': CARD })
{
  const r = run(G5, ['--stats'])
  check('★ 有未完成卡在接 → 不算欠账（老口径没被新逻辑挤掉）',
    /有未完成卡在接:\s*1/.test(r.out) && /仍未接（欠账）:\s*0/.test(r.out),
    r.out.trim().split('\n').join(' | '))
}
// 反例：同一份日志，卡改成"完成" → 又变欠账（否则"完成"这个词就白写了）
const CARD_DONE = ['---', 'title: 把日志关联任务的检索修好', '状态: 完成', '---', '正文'].join('\n')
const G5b = mkFixture({
  log_c: logFile('戊', '把日志关联任务的检索修好'),
}, { 'task-20260101-001': CARD_DONE })
{
  const r = run(G5b, ['--stats'])
  check('★ 反例自证：卡一旦完成，同一条日志又变回欠账（"在接"是活的，不是一次性盖章）',
    /仍未接（欠账）:\s*1/.test(r.out), r.out.trim().split('\n').join(' | '))
}

// ── ⑥ 「有卡在接」与「已处置」必须是两个数，不许合并 ─────────────────────
// 夹具要点：l1 的下一步必须**和卡标题足够像**（脚本按前 14 个可比对字符判断"在接"）。
// ⚠ 两个都是**单条目**日志 —— 多条目时处置标记会盖住全部条目（见 ⑩ 的口径），
//   混在一起会让"已处置=1"变成"已处置=N"。
const G6 = mkFixture({
  l1: logFile('己一', '把日志关联任务的检索修好'),
  l2: logFile('己二', '另一件事要处理干净\n\n处置：已放弃 —— 不想做了'),
}, { 'task-20260101-001': CARD })
{
  const r = run(G6, ['--stats'])
  check('★★ 三个数分开报：在接 1 / 已处置 1 / 欠账 0（合并成一个数就查不出是谁漏的）',
    /有未完成卡在接:\s*1/.test(r.out) && /已写处置标记:\s*1/.test(r.out) && /仍未接（欠账）:\s*0/.test(r.out),
    r.out.trim().split('\n').join(' | '))
}

// ── ⑦ --check 的退出码（守卫靠它）────────────────────────────────────
{
  const bad = run(G1, ['--check'])
  check('★★ 还有欠账时 --check 非零退出（守卫能拦住）', bad.code !== 0, 'code=' + bad.code)
  const good = run(G2, ['--check'])
  check('★ 全部处置后 --check 退出 0', good.code === 0, 'code=' + good.code)
}

// ── ⑧ 只读纪律：跑十遍，日志与卡一个字节都不变 ─────────────────────────
{
  const before = {}
  for (const d of ['docs/执行日志', 'task-data']) {
    for (const f of fs.readdirSync(path.join(G2, d))) {
      const p = path.join(G2, d, f)
      if (!f.endsWith('.md') || !fs.statSync(p).isFile()) continue   // 只比文件，别踩目录
      // ⚠ 键必须是**完整路径**：`docs/执行日志` 里本身带斜杠，按 `/` 拆回去会错位
      //   （第一版就是这么炸的：EISDIR —— 把目录当文件读）。
      before[p] = fs.readFileSync(p, 'utf8')
    }
  }
  for (let i = 0; i < 10; i++) run(G2, ['--stats'])
  let same = true
  for (const p of Object.keys(before)) {
    if (fs.readFileSync(p, 'utf8') !== before[p]) same = false
  }
  check('★★ 清点脚本是只读的：跑十遍，日志与卡逐字节不变（它只负责让东西浮上来）',
    same && Object.keys(before).length > 0, '文件数=' + Object.keys(before).length)
}

// ── ⑨ 源码守卫：处置标记必须真写进日志（不是只存脚本内存）──────────────
{
  const src = fs.readFileSync(SCRIPT, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  check('★ 脚本里没有写日志的调用（不 writeFileSync 到日志目录）',
    !/writeFileSync\([^)]*执行日志/.test(src))
  check('★ 处置类别表含"非本项目"（别的项目的活不该被塞进方寸的卡）',
    /非本项目/.test(src))
}

// ── ⑩ 多条目必须**按条**出账（2026-11-14 · 这条是补上自己的一个失误）──────────
// 真事：第一版只取「下一步」第一句，于是 289 份日志里 41% 的多条目列表
// 每条只算了第 1 条 —— 933 条欠账被报成 205 条。数字小了，丢失伪装成了完成。
const G7 = mkFixture({
  log_multi: logFile('辛', [
    '1. 第一条：把日志检索修好',
    '2. 第二条：待审批卡要能驳回',
    '3. 第三条：转待办别丢正文',
  ].join('\n')),
})
{
  const r = run(G7, ['--stats'])
  check('★★ 一份日志写了 3 条 → 欠账算 **3** 条，不是 1 条（按条出账）',
    /仍未接（欠账）:\s*3/.test(r.out), r.out.trim().split('\n').join(' | '))
  check('★ 并报出"其中 N 份是多条目列表"，让人知道这个坑存在',
    /1 份日志是多条目列表/.test(r.out), r.out.trim().split('\n').slice(0, 2).join(' | '))
}
{
  const j = run(G7, ['--json'])
  let parsed = null
  try { parsed = JSON.parse(j.out) } catch { /* 忽略 */ }
  check('★★ --json 里 items 是**逐条**的（消费方能自己再筛，不靠脚本的粗结论）',
    !!parsed && Array.isArray(parsed.items) && parsed.items.length === 3,
    parsed ? 'items=' + parsed.items.length : 'json 解析失败')
  check('★ --json 带 multiItemLogs（这个数以后每次都要能看见）',
    !!parsed && parsed.multiItemLogs === 1, parsed ? 'multiItemLogs=' + parsed.multiItemLogs : '')
}
// 反例：单条目日志不许被拆成多条
const G8 = mkFixture({ log_one: logFile('壬', '只有一条诉求，没有列表符号') })
{
  const r = run(G8, ['--stats'])
  check('★ 反例自证：没有列表符号的单条日志只算 1 条（不是见换行就拆）',
    /仍未接（欠账）:\s*1/.test(r.out), r.out.trim().split('\n').join(' | '))
}
// 反例：处置标记盖住整份 —— 口径提醒必须在 stats 里说出来
{
  const G9 = mkFixture({
    log_multi2: logFile('癸', '1. 第一条要处理的东西\n2. 第二条要处理的东西\n\n处置：已做 —— 只做了第一条'),
  })
  const r = run(G9, ['--stats'])
  check('★★ 处置标记盖住多条目时，stats 必须**主动说出**这个口径风险（不许让人误以为逐条都看了）',
    /口径提醒/.test(r.out) && /不等于"每一条都有人看过"/.test(r.out),
    r.out.trim().split('\n').slice(-4).join(' | '))
}

// 清理临时目录
for (const g of [G1, G2, G3, G4, G5, G5b, G6]) {
  try { fs.rmSync(g, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log('\n' + (fail ? '❌ ' : '✅ ') + `RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(fail ? 1 : 0)
