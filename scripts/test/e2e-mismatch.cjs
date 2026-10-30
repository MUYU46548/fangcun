#!/usr/bin/env node
/**
 * 「对不上」检测断言（2026-10-27，REV-008 一期 R4）
 *
 * 真跑**编译产物** `dist/shared/mismatch.js`（纯逻辑，不需要 electron、不起子进程 → 本机可跑）。
 * 判据一句话：**三类对不上的口径不能各说各话** ——
 * 状态过期要认三种日期写法、引用断裂要跨仓库找、完成的卡要有判据。
 *
 * 运行：node scripts/test/e2e-mismatch.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'mismatch.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const M = require(ART)

const TODAY = '2026-10-27'

console.log('== ① 状态日期解析 ==')

check('ISO 全日期能认', M.statusDateOf('v0.4.5 已发（2026-10-21）', TODAY) === '2026-10-21')
check('MM-DD 能认，年份补当年', M.statusDateOf('停在那（10-08）', TODAY) === '2026-10-08')
check('多个日期取最晚那个', M.statusDateOf('10-05 起 · 10-20 更新', TODAY) === '2026-10-20')
check('未来日期不算"上次核对"', M.statusDateOf('计划 12-31 交付', TODAY) === null)
check('没有日期 → null（不猜）', M.statusDateOf('一切正常', TODAY) === null)
check('空串 → null 不抛', M.statusDateOf('', TODAY) === null && M.statusDateOf(null, TODAY) === null)

console.log('\n== ① 状态过期（阈值边界）==')

const repo = (status, lastCommit) => ({ keys: ['p1'], path: '/x', status, lastCommit })

{
  const r = M.pickStale([repo('停在 10-21', '2026-10-27')], TODAY, 3)
  check('差 6 天 → 报过期', r.stale.length === 1 && r.stale[0].deltaDays === 6, JSON.stringify(r.stale))
}
{
  const r = M.pickStale([repo('停在 10-25', '2026-10-27')], TODAY, 3)
  check('差 2 天 → 不报（阈值默认 3）', r.stale.length === 0, JSON.stringify(r.stale))
}
{
  const r = M.pickStale([repo('停在 10-24', '2026-10-27')], TODAY, 3)
  check('差 3 天 → 正好到线，报', r.stale.length === 1)
}
{
  const r = M.pickStale([repo('一切正常', '2026-10-27')], TODAY, 3)
  check('没写日期 → 进 noDate，不进 stale', r.stale.length === 0 && r.noDate.length === 1)
}
{
  const r = M.pickStale([repo('停在 10-21', null)], TODAY, 3)
  check('不是 git 仓库 / 取不到提交 → 跳过（不猜）', r.stale.length === 0 && r.noDate.length === 0)
}
{
  const r = M.pickStale([repo('停在 10-21', '2026-10-27'), repo('停在 10-01', '2026-10-26')], TODAY, 3)
  check('多条按差距降序（越久越靠前）', r.stale[0].deltaDays >= r.stale[1].deltaDays)
}

console.log('\n== ② 引用路径清理 ==')

check('剥行号：ideas.ts:269 → ideas.ts', M.sanitizeRef('desktop/src/main/services/ideas.ts:269') === 'desktop/src/main/services/ideas.ts')
check('花括号通配 → 不可判（null）', M.sanitizeRef('scripts/nf-{plan,write}/SKILL.md') === null)
check('省略号 → 不可判（null）', M.sanitizeRef('docs/a/.../b.md') === null)
check('尾部标点被剥', M.sanitizeRef('docs/x.md）') === 'docs/x.md')
check('正常路径原样返回', M.sanitizeRef('task-data/project-tiers.json') === 'task-data/project-tiers.json')

console.log('\n== ② 引用断裂（跨仓库 + 归档）==')

const task = (name, text) => ({ name, text })

{
  const exists = () => false
  const r = M.pickBroken([task('a.md', '见 `task-data/project-order.json`')], exists)
  check('本仓没有 → 报断裂', r.broken.length === 1 && r.broken[0].ref === 'task-data/project-order.json')
}
{
  const exists = (p) => p === 'scripts/utils/handoff.py' ? false : false
  const altExists = (p) => p === 'scripts/utils/handoff.py'
  const reposOf = () => [{ name: '绒花墨坊', exists: altExists }]
  const r = M.pickBroken([task('账本.md', '见 `scripts/utils/handoff.py`')], exists, { reposOf })
  check('★反例：跨仓库命中 → 不报（不给 reposOf 就会误报）',
    r.broken.length === 0, JSON.stringify(r.broken))
  const r2 = M.pickBroken([task('账本.md', '见 `scripts/utils/handoff.py`')], exists)
  check('★反例对照：不注入 reposOf 时确实会误报（证明这条断言在咬）', r2.broken.length === 1)
}
{
  const exists = (p) => p === 'task-data/archive/old.md'
  const r = M.pickBroken([task('b.md', '承自 `task-data/old.md`')], exists)
  check('指向已归档的卡 → 进 moved，不进 broken', r.moved.length === 1 && r.broken.length === 0)
}
{
  const r = M.pickBroken([task('.backup-devlog.md', '见 `docs/nope.md`')], () => false)
  check('备份/隐藏文件不扫', r.broken.length === 0)
}
{
  const r = M.pickBroken([task('c.md', '见 `docs/x.md` 两次 `docs/x.md`')], () => false)
  check('同一路径只报一次', r.broken.length === 1)
}

console.log('\n== ③ 完成但没判据 ==')

{
  const r = M.pickNoCriteria([
    task('done1.md', '---\n状态: 完成\n标题: 做完了\n---\n就是做完了'),
    task('done2.md', '---\n状态: 完成\n标题: 有判据\n---\n验收标准：A 能跑'),
    task('todo.md', '---\n状态: 待办\n标题: 没做\n---\n'),
    task('done3.md', '---\n状态: 完成\n标题: 英文 DoD\n---\nDefinition of Done: 三项'),
  ])
  check('完成+无判据 → 报', r.some((x) => x.task === 'done1.md'))
  check('完成+有「验收标准」→ 不报', !r.some((x) => x.task === 'done2.md'))
  check('待办 → 不管（只看完成）', !r.some((x) => x.task === 'todo.md'))
  check('完成+英文 DoD → 不报', !r.some((x) => x.task === 'done3.md'))
  check('总数 = 1', r.length === 1, JSON.stringify(r))
}

console.log('\n== ④ 完成但找不到产出（2026-10-29 暮雨第 4 条 A 项）==')
{
  // 判据一句话：③ 问「写没写判据」，④ 问「东西在不在」。
  // RICE 那张卡写了「验收通过」却什么都没有 —— 这一组就是兜它的。
  const mk = (name, status, body, updated) => task(name,
    '---\n状态: ' + status + '\n标题: ' + name + '\n更新: ' + updated + '\n---\n' + body)
  const opts = (exists) => ({ todayISO: TODAY, exists, minAgeDays: 7 })

  const r1 = M.pickNoOutput([mk('bare.md', '完成', '做完了，验收通过。', '2026-10-10')], opts(() => false))
  check('★★ 完成 17 天、卡里没有任何产出 → 报（RICE 那一类）', r1.length === 1, JSON.stringify(r1))
  check('  报的时候带年龄（界面要能说「完成 N 天」）', r1[0] && r1[0].ageDays === 17, JSON.stringify(r1[0] || {}))

  const r2 = M.pickNoOutput([mk('path.md', '完成', '改了 `desktop/src/shared/rice.ts`。', '2026-10-10')],
    opts((rel) => rel === 'desktop/src/shared/rice.ts'))
  check('★★ 卡里提到的路径**真的存在** → 不报（有产出就先放过）', r2.length === 0, JSON.stringify(r2))

  const r3 = M.pickNoOutput([mk('ghost.md', '完成', '改了 `desktop/src/shared/ghost.ts`。', '2026-10-10')], opts(() => false))
  check('★ 提了路径但磁盘上没有 → 仍然报（正是「说明写了、东西不在」）', r3.length === 1, JSON.stringify(r3))

  const r4 = M.pickNoOutput([
    mk('cmt.md', '完成', '提交 d389741 之后验收通过。', '2026-10-10'),
    mk('url.md', '完成', '详见 https://example.com/pr/1 。', '2026-10-10'),
  ], opts(() => false))
  check('★ 带上下文的提交号 → 不报', !r4.some((x) => x.task === 'cmt.md'), JSON.stringify(r4))
  check('★ 带链接 → 不报', !r4.some((x) => x.task === 'url.md'), JSON.stringify(r4))

  const r5 = M.pickNoOutput([mk('fresh.md', '完成', '刚做完。', '2026-10-26')], opts(() => false))
  check('★★ 刚关的卡（1 天）不质疑 —— 门槛 7 天，否则全站刷屏', r5.length === 0, JSON.stringify(r5))

  const r6 = M.pickNoOutput([mk('todo2.md', '待办', '还没做。', '2026-10-10')], opts(() => false))
  check('  非完成态不管', r6.length === 0, JSON.stringify(r6))

  const r7 = M.pickNoOutput([mk('xrepo.md', '完成', '脚本在 scripts/gen.py 里。', '2026-10-10')],
    { todayISO: TODAY, exists: () => false, minAgeDays: 7,
      reposOf: () => [{ name: 'nf', exists: (rel) => rel === 'scripts/gen.py' }] })
  check('★★ 跨仓库也算产出（卡属于另一个项目时，别在方寸里找不到就报）', r7.length === 0, JSON.stringify(r7))

  const r8 = M.collectMismatch({
    repos: [], tasks: [mk('bare2.md', '完成', '做完了。', '2026-10-10')],
    todayISO: TODAY, exists: () => false,
  })
  check('★ collectMismatch 把这一组接进来了（total 含它）', r8.nooutput.length === 1 && r8.total >= 1, JSON.stringify(r8.total))
  check('★ 汇总文案点名这一组', M.mismatchSummary(r8).includes('完成了但找不到产出 1'), M.mismatchSummary(r8))
}

console.log('\n== 汇总与文案 ==')

{
  const r = M.collectMismatch({ repos: [], tasks: [], todayISO: TODAY, exists: () => true })
  check('空输入 → total 0，不抛', r.total === 0)
  check('空集文案不说"没问题"，说"没有需要提醒的地方"', M.mismatchSummary(r) === '没有需要提醒的地方')
}
{
  const r = M.collectMismatch({
    repos: [repo('停在 10-21', '2026-10-27')],
    tasks: [task('a.md', '见 `docs/nope.md`')],
    todayISO: TODAY,
    exists: () => false,
  })
  const s = M.mismatchSummary(r)
  check('文案带三类计数', s.includes('状态该更新了 1') && s.includes('引用的文件找不到了 1'), s)
  check('文案必须带「不阻挡任何操作」', s.includes('不阻挡'), s)
}

console.log(`\nRESULT ${pass} / ${fail ? pass + fail : pass}` + (fail ? `  (${fail} 条失败)` : ''))
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
