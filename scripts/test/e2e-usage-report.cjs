#!/usr/bin/env node
/**
 * 报表口径 + 归因闸 e2e（W1 / W2 · 卡 task-20261107-002 / 003）
 *
 * 真跑**编译产物** `dist/main/llm/trace.js` 的 `usageStats` / `usageByMonth`，
 * 夹具写进临时 JSONL（不碰真实 ai-trace.jsonl）。
 *
 * 两条来自实测的硬事实（`docs/投入产出-第一条真事实-20261107.md`）：
 *   · 账上 total_tokens 有 99.3% 是 cache_read → 拿 total 排名 = 量上下文长度；
 *   · 217 条外部调用只有 4 条带 card（1.8%）→ "花在哪"必须先把"未归因"显式摆出来。
 *
 * 反例（每条都要能精确变红）：
 *   ① 只报 total、没报 prompt 的记录 → **不许**拿 total 顶替新输入；
 *   ② cache == prompt（全重读）→ 新输入必须是 0；
 *   ③ `(未归因)` 不许混进按卡排行；
 *   ④ 显式 card 优先于 note 里的老写法；
 *   ⑤ 每个指标都要有 proves / cannot，且不许复读同一句。
 *
 * 运行：node scripts/test/e2e-usage-report.cjs
 */
const fs = require('fs')
const path = require('path')
const { mkTmpPath } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'main', 'llm', 'trace.js')
const UR = path.join(REPO, 'desktop', 'dist', 'shared', 'usageReport.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}
if (!fs.existsSync(ART) || !fs.existsSync(UR)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）')
  console.log('RESULT 0 / 1')
  process.exit(1)
}

const TEST_ROOT = mkTmpPath('fc-usage-report-')
const TRACE = path.join(TEST_ROOT, 'ai-trace.jsonl')
const T = require(ART)
const U = require(UR)
T.setTraceFilePathForTest(TRACE)

/** 用"今天"造时间戳，避开滚动窗口过滤；月报用本地自然月 */
const now = new Date()
const iso = (d) => d.toISOString()
const today = iso(now)
const rec = (o) => Object.assign({ ts: today, ok: true, model: 'fake', trigger: 'test' }, o)
function setRows(rows) {
  fs.writeFileSync(TRACE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
  T.setTraceFilePathForTest(TRACE)   // 重指一次，确保没有旧缓存
}

async function main() {
  // ── ① 主指标：新输入 = prompt − cache_read ────────────────────────
  console.log('== ① 口径：total 降副列，新输入只认报了 prompt 的记录 ==')
  {
    setRows([
      rec({ origin: 'external', prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, note: 'cache_read=900 card=task-A' }),
      rec({ origin: 'external', prompt_tokens: 500, completion_tokens: 10, total_tokens: 510, card: 'task-A' }),
      rec({ origin: 'external', prompt_tokens: 300, completion_tokens: 5, total_tokens: 305, note: 'cache_read=300' }),
      rec({ origin: 'external', total_tokens: 777777 }),                       // 只有 total
      rec({ origin: 'local', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
      rec({ origin: 'external', prompt_tokens: 200, completion_tokens: 0, total_tokens: 200, note: 'cache_read=200 card=(未归因)' }),
    ])
    const st = T.usageStats(30)
    // 新输入 = (1000-900)+(500-0)+(300-300)+0(只有total不算)+100(本地)+(200-200) = 700
    check('★★ 新输入 = 700（prompt − cache_read），不是 total 的 779,962',
      st.new_input_tokens === 700, String(st.new_input_tokens))
    check('★★ 反例①：只报 total 的 777777 不许顶替新输入',
      st.new_input_tokens < 1000 && st.total_tokens > 777777, `new=${st.new_input_tokens} total=${st.total_tokens}`)
    check('★ 缓存重读 = 1400，单列出来（不是藏在 total 里）',
      st.cache_read_tokens === 1400, String(st.cache_read_tokens))
    check('★ 输出 = 85，主指标②独立可见', st.output_tokens === 85, String(st.output_tokens))
    check('★ total 保留为副列（不许悄悄删掉老字段）', st.total_tokens === 779962, String(st.total_tokens))
    check('★ 每个指标带 proves / cannot，且不是同一句复读',
      Object.keys(st.metrics).length >= 5
      && Object.values(st.metrics).every((m) => m && m.proves && m.cannot)
      && new Set(Object.values(st.metrics).map((m) => m.cannot)).size === Object.keys(st.metrics).length,
      JSON.stringify(Object.keys(st.metrics)))
    check('★ total 的 cannot 明确说"证明不了干了多少活"',
      /证明不了/.test(st.metrics.total_tokens.cannot), st.metrics.total_tokens.cannot)
  }

  // ── ② 全 cache 的记录 → 新输入 0 ─────────────────────────────────
  console.log('\n== ② 反例：全 cache（cache == prompt）→ 新输入必须是 0 ==')
  {
    setRows([rec({ origin: 'external', prompt_tokens: 200, completion_tokens: 1, total_tokens: 201, note: 'cache_read=200 card=X' })])
    const st = T.usageStats(30)
    check('★★ 新输入为 0（不是 200，更不是 201）', st.new_input_tokens === 0, String(st.new_input_tokens))
    check('★ 缓存重读 = 200，与 prompt 对得上', st.cache_read_tokens === 200, String(st.cache_read_tokens))
  }

  // ── ③ 归因闸：未归因显式可见、不进排行 ──────────────────────────
  console.log('\n== ③ 归因闸：照常入账，但「未归因」单独算、不进按卡排行 ==')
  {
    setRows([
      rec({ origin: 'external', prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, note: 'cache_read=900 card=task-A' }),
      rec({ origin: 'external', prompt_tokens: 500, completion_tokens: 10, total_tokens: 510, card: 'task-A' }),
      rec({ origin: 'external', prompt_tokens: 300, completion_tokens: 5, total_tokens: 305 }),       // 未归因
      rec({ origin: 'external', total_tokens: 777777 }),                                             // 未归因且只报 total
      rec({ origin: 'external', prompt_tokens: 200, completion_tokens: 0, total_tokens: 200, note: 'cache_read=200 card=(未归因)' }),
      rec({ origin: 'local', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),         // 本地：不进归因分母
    ])
    const st = T.usageStats(30)
    check('★★ 外部 5 条里 3 条归不到卡 → 按条数 60%', st.unattributed_calls === 3 && st.unattributed_pct === 60,
      `${st.unattributed_calls} / ${st.unattributed_pct}%`)
    check('★★ 本地调用不算"未归因"（分母只有 external）', st.unattributed_calls === 3, String(st.unattributed_calls))
    check('★ 按 token 的未归因占比也算出来（不是只给条数）',
      st.unattributed_tokens === 778282 && st.unattributed_token_pct > 99,
      `${st.unattributed_tokens} / ${st.unattributed_token_pct}%`)
    check('★★ 反例③：`(未归因)` 不许混进 byCard',
      st.byCard.length === 1 && st.byCard[0].card === 'task-A' && !st.byCard.some((c) => c.card.includes('未归因')),
      JSON.stringify(st.byCard))
    check('★ 按卡汇总带次数与 token', st.byCard[0].calls === 2 && st.byCard[0].total_tokens === 1520,
      JSON.stringify(st.byCard))

    // 上报构造（buildExternalUsageRecord）：没 card 也照常入账
    const r1 = U.buildExternalUsageRecord({ client: 'dsh', total_tokens: 10 }, today)
    check('★★ 没归因的上报**照常入账**（丢账比丢归因更糟），card 标 (未归因)',
      r1.ok === true && r1.record.card === '(未归因)', JSON.stringify(r1.ok && r1.record.card))
  }

  // ── ④ 显式 card 优先于 note ──────────────────────────────────────
  console.log('\n== ④ 反例：显式 card 优先于 note 里的老写法 ==')
  {
    setRows([rec({ origin: 'external', prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, card: 'task-C', note: 'card=task-B' })])
    const st = T.usageStats(30)
    check('★★ 归到 task-C（不是 note 里的 task-B）',
      st.byCard.length === 1 && st.byCard[0].card === 'task-C', JSON.stringify(st.byCard))
    check('★ 显式给了 card 就不算未归因', st.unattributed_calls === 0, String(st.unattributed_calls))
  }

  // ── ⑤ 月报同口径 ─────────────────────────────────────────────────
  console.log('\n== ⑤ 月报（自然月）同口径，不许两套数字 ==')
  {
    setRows([
      rec({ origin: 'external', prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, note: 'cache_read=900 card=task-A' }),
      rec({ origin: 'external', total_tokens: 500 }),
    ])
    const ms = T.usageByMonth(3)
    const m = ms[0]
    check('★ 月报有当月一行', !!m, JSON.stringify(ms.map((x) => x.month)))
    check('★★ 月报新输入 = 100（只报 total 的那条不顶替）', !!m && m.new_input_tokens === 100, String(m && m.new_input_tokens))
    check('★ 月报缓存重读 = 900、total 仍为副列', !!m && m.cache_read_tokens === 900 && m.total_tokens === 1520,
      JSON.stringify(m && { c: m.cache_read_tokens, t: m.total_tokens }))
    check('★★ 月报未归因 = 50%', !!m && m.unattributed_pct === 50, String(m && m.unattributed_pct))
  }

  console.log('')
  if (failures.length) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
  console.log(`RESULT ${pass} / ${fail}`)
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('FAIL  测试驱动异常：' + ((e && e.stack) || e))
  process.exit(1)
})
