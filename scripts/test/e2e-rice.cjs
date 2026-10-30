#!/usr/bin/env node
/**
 * 需求矩阵（RICE）断言（2026-10-28）
 *
 * 真跑**编译产物**：`dist/shared/rice.js`（纯逻辑）+ `dist/main/data/rice.js`（数据层）
 * + **临时数据目录**（不碰真实 task-data / decisions.md）。
 *
 * 判据来自两份施工输入：
 *   ·《方寸-RICE打分口径-20261024.md》v1.1
 *   ·《方寸-RICE格式闸结论-全栈-20261024.md》schema v1 + 验收线两条
 *
 * 最硬的四条（少了就等于没实装）：
 *   ① **总分不落盘**：池文件里只有 R/I/C/E，读出来才算总分；
 *   ② **幂等**：同 eid 连灌两遍条目数不变，且保留已存在的 拍板/决策id；
 *   ③ **取值域硬校验**：I/C/证据非法逐条拒，不拒整批；
 *   ④ **来源不许是幽灵**：task/idea/todo 引用不存在 → 拒该条。
 *
 * 运行：node scripts/test/e2e-rice.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, path.join(DATA, 'task-data'), USERDATA]) fs.mkdirSync(d, { recursive: true })

// electron 桩：本进程注入（不 spawn —— 本机 spawnSync 一律 EBUSY）
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const SHARED = path.join(DIST, 'shared', 'rice.js')
const RICE = path.join(DIST, 'main', 'data', 'rice.js')
if (!fs.existsSync(SHARED) || !fs.existsSync(RICE)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）')
  console.log('RESULT 0 / 1')
  process.exit(1)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const R = require(SHARED)
const rice = require(RICE)
const tasks = require(path.join(DIST, 'main', 'data', 'tasks.js'))
const decisions = require(path.join(DIST, 'main', 'data', 'decisions.js'))

let pass = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else {
    failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf-8')

console.log('== ① 解析 / 渲染（节式，两端逐字节兼容）==')

const sample = [
  '# 需求矩阵评估池（RICE）',
  '',
  '> 月预算（元）: 500',
  '',
  '## rice-task-T-042 关窗行为开关',
  '- 标题: 设置页加「关窗行为」开关（默认真退出）',
  '- 来源: task:task-T-042',
  '- R: 5',
  '- I: 1',
  '- C: 0.85',
  '- E天: 2',
  '- E元: 0',
  '- 证据: 实测踩过',
  '- 打分: 全栈 2026-10-24',
  '- 备注: 病灶 A1',
  '不该被认成新字段',
  '- 拍板:',
  '- 决策id:',
  '- 自定义列: 值A',
  '',
  '## rice-ext-x1 外部清单条目',
  '- 标题: 外部条目',
  '- 来源: external:code-audit-1',
  '- R: 2',
  '- I: 0.5',
  '- C: abc',
  '- E天: 1.5',
  '- E元: 12',
  '- 证据: agent推断',
  '- 打分: 全栈 2026-10-25',
  '- 备注: 手改坏数字',
  '- 拍板: CUT',
  '- 决策id: D-009',
  '',
].join('\n')

{
  const p = R.parseRicePool(sample)
  check('预算解析', p.budget === 500, String(p.budget))
  check('两条条目', p.items.length === 2, String(p.items.length))
  const a = p.items[0]
  check('四维原始分读对（R/I/C/E）', a.R === 5 && a.I === 1 && a.C === 0.85 && a.E_days === 2, JSON.stringify([a.R, a.I, a.C, a.E_days]))
  check('E元 旁注读对', a.E_cost === 0, String(a.E_cost))
  check('证据 / 打分 / 拍板空值', a.evidence === '实测踩过' && a.by === '全栈 2026-10-24' && a.verdict === '', JSON.stringify([a.evidence, a.by, a.verdict]))
  check('多行备注拼回上一字段（不是新字段）', a.note.includes('病灶 A1') && a.note.includes('不该被认成新字段'), JSON.stringify(a.note))
  check('未知字段进 extra（不丢）', (a.extra || []).some((x) => x.k === '自定义列' && x.v === '值A'), JSON.stringify(a.extra))
  const b = p.items[1]
  check('★ 坏数字原样保留在 raw（不静默清空）', b.raw && b.raw.C === 'abc', JSON.stringify(b.raw))
  check('CUT 读成 CUT，决策id 保留', b.verdict === 'CUT' && b.decisionId === 'D-009', JSON.stringify([b.verdict, b.decisionId]))
}

{
  const p = R.parseRicePool('')
  check('空文件 → 0 条不抛', p.items.length === 0 && p.budget === 0)
  const text = R.renderRicePool({ budget: 300, items: [] })
  check('渲染含月预算行', text.includes('月预算（元）: 300'), text.slice(0, 120))
  check('渲染含说明头（总分不落盘）', text.includes('总分由页签现算（不落盘）'))
}

{
  // round-trip：parse → render → parse，值不变（含多行备注 / extra / raw）
  const p1 = R.parseRicePool(sample)
  const t1 = R.renderRicePool(p1)
  const p2 = R.parseRicePool(t1)
  const a = p2.items[0]
  const b = p2.items[1]
  check('round-trip 条数一致', p2.items.length === 2, String(p2.items.length))
  check('round-trip 多行备注不丢', a.note === p1.items[0].note, JSON.stringify(a.note))
  check('round-trip 未知字段不丢', (a.extra || []).some((x) => x.k === '自定义列'))
  check('round-trip 坏数字原文不丢', b.raw && b.raw.C === 'abc', JSON.stringify(b.raw))
  check('★ round-trip 二次渲染逐字节稳定', R.renderRicePool(p2) === t1)
}

console.log('\n== ② 评分 / 等级（现算，不落盘）==')
{
  const it = (o) => ({ eid: 'e', title: 't', origin: 'external:x', R: 0, I: 1, C: 1, E_days: 1, E_cost: 0, evidence: '纯直觉', by: '', note: '', verdict: '', decisionId: '', ...o })
  check('RICE = R×I×C÷E（四舍五入 2 位）', R.scoreOf(it({ R: 5, I: 1, C: 0.85, E_days: 2 })) === 2.13, String(R.scoreOf(it({ R: 5, I: 1, C: 0.85, E_days: 2 }))))
  check('E=0 → NaN（不假装算得出）', Number.isNaN(R.scoreOf(it({ E_days: 0 }))))
  check('缺项 → NaN', Number.isNaN(R.scoreOf(it({ R: NaN }))))

  const items = [
    it({ eid: 'a', R: 10, I: 3, C: 0.95, E_days: 1 }), // 28.5
    it({ eid: 'b', R: 5, I: 1, C: 0.85, E_days: 2 }),   // 2.13
    it({ eid: 'c', R: 2, I: 0.5, C: 0.6, E_days: 3 }),  // 0.2
    it({ eid: 'd', R: 1, I: 1, C: 0.7, E_days: 1, verdict: 'CUT' }),
  ]
  const lv = R.levelOfMap(items)
  check('3 条可算 → P0/P1/P2 各一档', lv.a === 'P0' && lv.b === 'P1' && lv.c === 'P2', JSON.stringify(lv))
  check('★ 已拍板 CUT 恒 CUT（分再高也不进 P0）', lv.d === 'CUT', lv.d)
  const tie = R.levelOfMap([
    it({ eid: 'x', R: 1, I: 1, C: 1, E_days: 1 }),
    it({ eid: 'y', R: 1, I: 1, C: 1, E_days: 1 }),
    it({ eid: 'z', R: 1, I: 1, C: 1, E_days: 3 }),
  ])
  check('同分共享档位（不被腰斩成两档）', tie.x === tie.y, JSON.stringify(tie))

  check('证据→C 映射四档逐字', JSON.stringify(R.RICE_EVIDENCE_TO_C) === JSON.stringify({ 亲口要: 0.95, 实测踩过: 0.85, agent推断: 0.7, 纯直觉: 0.6 }), JSON.stringify(R.RICE_EVIDENCE_TO_C))
  check('I 五档 / C 四档', JSON.stringify(R.RICE_IMPACT_VALUES) === JSON.stringify([0.25, 0.5, 1, 2, 3]) && JSON.stringify(R.RICE_CONFIDENCE_VALUES) === JSON.stringify([0.95, 0.85, 0.7, 0.6]))
}

console.log('\n== ③ 校验（拒该条不拒整批）==')
{
  const good = { eid: 'rice-task-1', title: 't', origin: 'task:task-1', R: 5, I: 1, C: 0.85, E_days: 2, evidence: '实测踩过' }
  check('合法条目通过', R.validateRiceInput(good).ok)
  check('I 非法拒', !R.validateRiceInput({ ...good, I: 0.9 }).ok)
  check('C 非法拒', !R.validateRiceInput({ ...good, C: 0.5 }).ok)
  check('证据非法拒', !R.validateRiceInput({ ...good, evidence: '大家都说好' }).ok)
  check('E天 0 拒', !R.validateRiceInput({ ...good, E_days: 0 }).ok)
  check('E天 非整数拒', !R.validateRiceInput({ ...good, E_days: 1.5 }).ok)
  check('R 负数拒', !R.validateRiceInput({ ...good, R: -1 }).ok)
  check('origin 无 type 拒', !R.validateRiceInput({ ...good, origin: 'task-1' }).ok)
  check('origin 未知 type 拒', !R.validateRiceInput({ ...good, origin: 'bug:1' }).ok)
  check('eid 含空白拒', !R.validateRiceInput({ ...good, eid: 'rice task 1' }).ok)
  const derived = R.validateRiceInput({ ...good, C: undefined })
  check('★ C 省略 → 按证据等级推', derived.ok && derived.item.C === 0.85, JSON.stringify(derived.item && derived.item.C))
  const mismatch = R.validateRiceInput({ ...good, C: 0.6 })
  check('C 与证据不一致 → 收下但给 warning（不替你改）', mismatch.ok && mismatch.warnings.length === 1, JSON.stringify(mismatch.warnings))
  const meta = R.mergeRiceUpsert({ budget: 0, items: [] }, [{ ...good, origin: 'external:x', eid: 'rice-ext-1' }], { originExists: () => false })
  check('external 不查来源存在性', meta.added.length === 1 && meta.rejected.length === 0, JSON.stringify(meta.rejected))
}

console.log('\n== ④ 散点几何 / 汇总 ==')
{
  const it = (o) => ({ eid: 'e', title: 't', origin: 'external:x', R: 0, I: 1, C: 1, E_days: 1, E_cost: 0, evidence: '纯直觉', by: '', note: '', verdict: '', decisionId: '', ...o })
  const g = R.riceGeometry([
    it({ eid: 'a', R: 10, E_days: 1, I: 3, C: 0.95 }),
    it({ eid: 'b', R: 1, E_days: 4, I: 1, C: 0.6 }),
    it({ eid: 'bad', E_days: 0 }),
  ])
  check('只画算得出的（E=0 不画）', g.points.length === 2, String(g.points.length))
  check('气泡大小随频次 R（R 大的半径大）', g.points[0].r > g.points[1].r, JSON.stringify(g.points.map((p) => p.r)))
  check('点都在画布内', g.points.every((p) => p.x >= 0 && p.x <= 720 && p.y >= 0 && p.y <= 320), JSON.stringify(g.points))
  check('分割线 = 成本/得分中位', Number.isFinite(g.splitX) && Number.isFinite(g.splitY), JSON.stringify([g.splitX, g.splitY]))
  check('四象限文案齐全', ['优先做', '要想清楚', '顺手', '别做'].every((q) => [0, 1].some((i) => [0, 1].some((j) => R.quadrantLabel(i ? 9 : 1, j ? 9 : 1, 5, 5) === q))))
  const s0 = R.riceSummary({ budget: 0, items: [it({ eid: 'a', R: 1, I: 1, C: 1, E_days: 1, E_cost: 10 })] })
  check('★ 预算未设置 → budgetRatio=null（不说成 0%）', s0.budgetRatio === null && s0.text.includes('未设置'), JSON.stringify(s0))
  const s1 = R.riceSummary({ budget: 100, items: [it({ eid: 'a', R: 1, I: 1, C: 1, E_days: 1, E_cost: 10 })] })
  check('预算设置 → P0 花费/占用比', s1.p0Cost === 10 && s1.budgetRatio === 0.1, JSON.stringify(s1))
}

// ── 原型里「分数之外」的四件（2026-10-29 暮雨第 1 条）──────────────────────
console.log('\n== ④b 容量护栏 / 立场句 / 为什么做为什么砍 / 重评触发 ==')
{
  const it2 = (o) => ({ eid: 'e', title: 't', origin: 'external:x', R: 1, I: 1, C: 1, E_days: 1, E_cost: 0, evidence: '纯直觉', by: '', note: '', verdict: '', decisionId: '', ...o })
  const mk = (cost, days) => ({ budget: 100, items: [it2({ eid: 'p0', E_cost: cost, E_days: days, R: 100, I: 3, C: 0.95 })] })

  const unset = R.riceSummary({ budget: 0, items: [it2({ E_cost: 10 })] })
  check('★★ 没设预算 → guard=unset，且话说清「别读成没超支」',
    unset.guard === 'unset' && unset.guardText.indexOf('没超支') >= 0, unset.guardText)
  const okS = R.riceSummary(mk(10, 3))
  check('★ 占 10% → guard=ok，文案给余量', okS.guard === 'ok' && okS.headroom === 90, JSON.stringify([okS.guard, okS.headroom]))
  const tight = R.riceSummary(mk(85, 10))
  check('★★ 占 85% → guard=tight（原型：排满等于一次故障就让整季延期）',
    tight.guard === 'tight' && tight.guardText.indexOf('线上故障') >= 0, tight.guardText)
  const over = R.riceSummary(mk(120, 10))
  check('★★ 超支 → guard=over，余量是负数且文案说超了多少',
    over.guard === 'over' && over.headroom === -20 && over.guardText.indexOf('超预算') >= 0, over.guardText)
  check('★ P0 合计人天现算（预算没设时唯一能看的容量口径）',
    R.riceSummary({ budget: 0, items: [it2({ eid: 'a', E_days: 7, R: 100, I: 3, C: 0.95 })] }).p0Days === 7)

  check('★★ 立场句是独立常量（不许只混在五条局限里）',
    typeof R.RICE_STANCE === 'string' && R.RICE_STANCE.indexOf('不替你做决定') >= 0, R.RICE_STANCE)
  check('★★ 重评触发写死成一句（容量变动 20%）',
    typeof R.RICE_RECHECK === 'string' && R.RICE_RECHECK.indexOf('20%') >= 0, R.RICE_RECHECK)

  const pool2 = { budget: 0, items: [
    it2({ eid: 'k1', title: '要做的', verdict: '有效', note: '每周省 3 次手工' }),
    it2({ eid: 'k2', title: '没写理由就做了', verdict: '有效', note: '' }),
    it2({ eid: 'c1', title: '被砍的', verdict: 'CUT', note: '听起来很酷，但没人要' }),
    it2({ eid: 'p1', title: '还没拍板', verdict: '' }),
  ] }
  const why = R.riceWhyReview(pool2)
  check('★★ 做/砍分两栏（分数只是入口，理由逐条）', why.keep.length === 2 && why.cut.length === 1,
    JSON.stringify([why.keep.length, why.cut.length]))
  check('★★ 拍板了但没写理由 → 点名（说不清为什么就是没拍板）', why.missingWhy === 1, String(why.missingWhy))
  check('  未拍板的单独计数', why.pending === 1, String(why.pending))
  check('  文案同时说三件事（拍板数 / 缺理由 / 未拍板）',
    why.text.indexOf('已拍板 3') >= 0 && why.text.indexOf('没写理由') >= 0 && why.text.indexOf('没拍板') >= 0, why.text)
  check('  空池 → 说「还没有拍板记录」，不吐空串',
    R.riceWhyReview({ budget: 0, items: [] }).text === '还没有拍板记录')
}


console.log('\n== ⑤ 数据层：幂等 upsert（临时数据目录）==')
const made = tasks.createTask({ title: '关窗行为开关', project: 'fangcun-base', status: '待办', priority: '中' })
const tid = made.id
const base = {
  eid: 'rice-task-' + tid, title: '关窗行为开关', origin: 'task:' + tid,
  R: 5, I: 1, C: 0.85, E_days: 2, E_cost: 0, evidence: '实测踩过', note: '病灶 A1',
}
{
  const r1 = rice.upsertRiceItems([base], { by: '全栈', batch: 'b1', date: '2026-10-24' })
  check('首次 upsert 成功并新增 1 条', r1.ok && r1.added.length === 1, JSON.stringify(r1))
  const file = fs.readFileSync(rice.ricePoolPath(), 'utf-8')
  check('★ 池文件里有四个原始分、没有「- 总分:」列', file.includes('- R: 5') && file.includes('- E天: 2') && !/- 总分:/.test(file), file.slice(0, 400))
  check('打分列 = by + date', file.includes('- 打分: 全栈 2026-10-24'), file.match(/- 打分:.*/)?.[0])

  const r2 = rice.upsertRiceItems([{ ...base, R: 9 }], { by: '全栈', batch: 'b1', date: '2026-10-24' })
  const p = R.parseRicePool(fs.readFileSync(rice.ricePoolPath(), 'utf-8'))
  check('★★ 同 eid 再灌 → 条目数不变（幂等实证）', p.items.length === 1 && r2.updated.length === 1 && r2.added.length === 0, JSON.stringify({ n: p.items.length, r2 }))
  check('分数被覆盖', p.items[0].R === 9, String(p.items[0].R))

  rice.upsertRiceItems([{ ...base, R: 9, note: '新备注' }], { by: '全栈' })
  const p2 = R.parseRicePool(fs.readFileSync(rice.ricePoolPath(), 'utf-8'))
  check('传 note → 备注被覆盖', p2.items[0].note === '新备注', p2.items[0].note)
  rice.upsertRiceItems([{ ...base, R: 9, note: undefined }], { by: '全栈' })
  const p3 = R.parseRicePool(fs.readFileSync(rice.ricePoolPath(), 'utf-8'))
  check('不传 note → 保留旧备注', p3.items[0].note === '新备注', p3.items[0].note)
  check('title/origin 不被洗掉', p3.items[0].title === '关窗行为开关' && p3.items[0].origin === 'task:' + tid)
}

console.log('\n== ⑥ 来源校验：幽灵条目拒收 ==')
{
  const ok = rice.upsertRiceItems([{ ...base, eid: 'rice-task-ghost', origin: 'task:task-不存在' }], { by: 'agent' })
  check('来源不存在 → 拒该条', ok.ok && ok.rejected.length === 1 && /来源不存在/.test(ok.rejected[0].error), JSON.stringify(ok.rejected))
  const p = R.parseRicePool(fs.readFileSync(rice.ricePoolPath(), 'utf-8'))
  check('★ 被拒的条目没落盘', !p.items.some((x) => x.eid === 'rice-task-ghost'))
  const batch = rice.upsertRiceItems([
    { ...base, eid: 'rice-task-ghost2', origin: 'task:task-不存在' },
    { ...base, eid: 'rice-ext-1', origin: 'external:audit-1', title: '外部条目' },
    { ...base, eid: 'rice-bad-I', origin: 'external:audit-2', I: 0.9 },
  ], { by: 'agent' })
  check('★★ 拒该条不拒整批（另两条照常）', batch.rejected.length === 2 && batch.added.includes('rice-ext-1'), JSON.stringify(batch))
}

console.log('\n== ⑦ 拍板：落 decisions.md + 回填池（幂等）==')
{
  const r = rice.recordRiceDecisions([{ eid: base.eid, 状态: '有效' }], { batch: 'rice-export-t', date: '2026-10-24' })
  check('拍板落账成功', r.ok && r.results[0].ok, JSON.stringify(r))
  const ds = decisions.loadDecisions()
  check('decisions.md 新增一条', ds.length === 1, String(ds.length))
  check('内容默认取标题、项目来自卡、出处带批次', ds[0].内容 === '关窗行为开关' && ds[0].项目 === 'fangcun-base' && ds[0].出处.includes('rice-export-t'), JSON.stringify(ds[0]))
  check('备注默认带 RICE 计算式', /RICE=.*R\d+×I1×C0\.85÷E2/.test(ds[0].备注), ds[0].备注)
  const p = R.parseRicePool(fs.readFileSync(rice.ricePoolPath(), 'utf-8'))
  const it = p.items.find((x) => x.eid === base.eid)
  check('池条目回填 拍板=有效 + 决策id', it.verdict === '有效' && it.decisionId === ds[0].id, JSON.stringify([it.verdict, it.decisionId]))

  const again = rice.recordRiceDecisions([{ eid: base.eid, 状态: '有效' }], { batch: 'rice-export-t', date: '2026-10-24' })
  check('★ 再拍同一条 → 幂等（exists，不新增决策）', again.results[0].ok && again.results[0].exists === true && decisions.loadDecisions().length === 1, JSON.stringify(again.results[0]))

  rice.upsertRiceItems([{ ...base, R: 7 }], { by: 'agent' })
  const p2 = R.parseRicePool(fs.readFileSync(rice.ricePoolPath(), 'utf-8'))
  const it2 = p2.items.find((x) => x.eid === base.eid)
  check('★★ 再灌分 → 保留已存在的 拍板/决策id', it2.verdict === '有效' && it2.decisionId === ds[0].id && it2.R === 7, JSON.stringify(it2))

  const cut = rice.recordRiceDecisions([{ eid: 'rice-ext-1', 状态: '已撤销', 内容: '砍掉外部条目' }], { batch: 'rice-export-t', date: '2026-10-24' })
  const p3 = R.parseRicePool(fs.readFileSync(rice.ricePoolPath(), 'utf-8'))
  const cutIt = p3.items.find((x) => x.eid === 'rice-ext-1')
  check('CUT → 池里 verdict=CUT（留痕不删）', cut.ok && cutIt.verdict === 'CUT', JSON.stringify(cutIt))
  check('CUT → decisions.md 状态=已撤销', decisions.loadDecisions().some((d) => d.内容 === '砍掉外部条目' && d.状态 === '已撤销'))

  const ghost = rice.recordRiceDecisions([{ eid: 'rice-nope', 状态: '有效' }], {})
  check('eid 不在池 → 拒，且不产生决策', !ghost.ok && ghost.results[0].ok === false && decisions.loadDecisions().length === 2, JSON.stringify(ghost.results))
  const badStatus = rice.recordRiceDecisions([{ eid: base.eid, 状态: '已合并' }], {})
  check('非法拍板状态被拒', !badStatus.ok && /已合并/.test(badStatus.results[0].error), JSON.stringify(badStatus.results))
}

console.log('\n== ⑧ 月预算（容量护栏）==')
{
  const r = rice.setRiceBudget(300)
  check('预算落盘', r.ok && R.parseRicePool(fs.readFileSync(rice.ricePoolPath(), 'utf-8')).budget === 300)
  check('负数预算拒绝', rice.setRiceBudget(-1).ok === false)
  const p = R.parseRicePool(fs.readFileSync(rice.ricePoolPath(), 'utf-8'))
  check('改预算不动条目', p.items.length === 2, String(p.items.length))
}

console.log('\n== ⑨ MCP 三件（agent 的真入口）==')
{
  const tools = require(path.join(DIST, 'main', 'mcp', 'tools.js'))
  const call = (name, args) => {
    const r = tools.handleMCPToolCall(name, args || {})
    const txt = r && r.content && r.content[0] && r.content[0].text
    try { return JSON.parse(txt) } catch { return { __raw: txt } }
  }
  const up = call('rice_pool_upsert', {
    batch: 'e2e-mcp',
    by: 'agent',
    items: [{ eid: 'rice-ext-mcp', title: 'MCP 写入条目', origin: 'external:mcp', R: 3, I: 2, E_days: 3, evidence: 'agent推断' }],
  })
  check('rice_pool_upsert 经 MCP 真写入（C 按证据推 0.7）',
    up.ok === true && up.added.includes('rice-ext-mcp') && up.items.some((x) => x.eid === 'rice-ext-mcp' && x.C === 0.7), JSON.stringify(up).slice(0, 260))
  const list = call('rice_pool_list', {})
  check('rice_pool_list 读回现算分数/等级', list.ok === true && list.items.some((x) => x.eid === 'rice-ext-mcp' && x.score === 1.4 && x.level), JSON.stringify(list).slice(0, 260))
  const toolNames = (tools.MCP_TOOLS || []).map((t) => t.name)
  check('★★ decision_record 已从 MCP 移除（决策是用户拍板，AI 不代表决；界面 rice:decide 仍在）',
    !toolNames.includes('decision_record'), toolNames.join(','))
  const bad = call('rice_pool_upsert', { items: [{ eid: 'rice-bad', title: 'x', origin: 'external:x', R: 1, I: 0.9, E_days: 1, evidence: '纯直觉' }] })
  check('MCP 侧同样逐条拒非法 I（不整批失败）', bad.ok === true && bad.rejected.length === 1, JSON.stringify(bad).slice(0, 200))
}

console.log('\n== ⑩ 源码守卫（接不上就白做）==')
{
  const view = read('desktop/src/renderer/views/RiceMatrixView.vue')
  check('页签只走 rice* IPC', /riceGet/.test(view) && /riceUpsert/.test(view) && /riceDecide/.test(view) && /riceSetBudget/.test(view))
  check('★ 页签零网络（没有 fetch / http / axios）', !/\bfetch\s*\(/.test(view) && !/https?:\/\//.test(view) && !/axios/.test(view))
  check('页签展示池文件路径（防"找不到在哪"）', /池文件/.test(view) && /poolPath/.test(view))
  check('页签常驻局限（R7：只有数字没有局限=不合格）', /RICE_LIMITS/.test(view) && /这页证明不了什么/.test(view))
  check('★ 界面文案不带 Markdown 标记（Vue 不解析 **）', R.RICE_LIMITS.every((s) => !s.includes('**') && !s.includes('`')) && !R.RICE_EMPTY_TEXT.includes('**'))
  checks()
}

function checks() {
  const app = read('desktop/src/renderer/App.vue')
  check('项目页第 7 种摆法注册（PV_VIEWS 含 rice）', /\['tiles', 'overview', 'master', 'trip', 'tier', 'mismatch', 'rice'\]/.test(app))
  check('★ 持久化白名单含 rice（忘了就会重启退回项目墙）', /fc_pv_view === 'rice'/.test(app))
  check('视图选项有入口 + 文案', /v: 'rice', label: '▦ 需求矩阵'/.test(app))

  const preload = read('desktop/src/preload/index.ts')
  check('preload 暴露 riceGet/riceUpsert/riceDecide/riceSetBudget',
    /riceGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('rice:get'\)/.test(preload)
    && /riceUpsert:/.test(preload) && /riceDecide:/.test(preload) && /riceSetBudget:/.test(preload))

  const ipc = read('desktop/src/main/ipc.ts')
  check('主进程注册 rice:get/upsert/decide/setBudget',
    /guardedHandle\('rice:get'/.test(ipc) && /guardedHandle\('rice:upsert'/.test(ipc)
    && /guardedHandle\('rice:decide'/.test(ipc) && /guardedHandle\('rice:setBudget'/.test(ipc))

  const tools = read('desktop/src/main/mcp/tools.ts')
  check('MCP 只剩两件：rice_pool_list / rice_pool_upsert（decision_record 已移除）',
    /name: 'rice_pool_list'/.test(tools) && /name: 'rice_pool_upsert'/.test(tools) && !/name: 'decision_record'/.test(tools))
  check('MCP 工具真的接了实现（不是只写 schema）',
    /case 'rice_pool_upsert'/.test(tools) && /case 'rice_pool_list'/.test(tools) && !/case 'decision_record'/.test(tools))

  const py = read('tegula/core.py')
  check('Python 侧有池解析/渲染（双腿）', /def load_rice_pool/.test(py) && /def _render_rice_pool/.test(py) && /RICE_POOL_PATH/.test(py))
  const cli = read('tegula/cli.py')
  check('Python CLI 有只读 rice 命令', /def cmd_rice/.test(cli) && /sub\.add_parser\("rice"/.test(cli))
}

console.log(`\nRESULT ${pass} / ${failures.length ? pass + failures.length : pass}` + (failures.length ? `  (${failures.length} 条失败)` : ''))
if (failures.length) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
