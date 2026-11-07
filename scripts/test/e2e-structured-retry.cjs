#!/usr/bin/env node
/**
 * 结构化输出修复环 e2e（W3 · 卡 task-20261107-001）
 *
 * 真跑**编译产物** `dist/main/llm/planDraft.js` 的 `generatePlanDraft`，
 * 模型调用/写盘/留痕全部注入，不联网、不碰真实 task-data。
 *
 * 要复刻的事故（`docs/投入产出-第一条真事实-20261107.md`）：
 *   11-02 有一次 18,031 字符的往返，换回来一句"模型输出里没有 JSON 对象"，
 *   然后整轮就结束了 —— **一次都没再要**。方寸自己 10 次调用里 5 次失败，全在这一步。
 *
 * 判据（每条都有反例）：
 *   ① 散文 → 一次严格重试 → 救回，结果带 retried / trace 带 retried；
 *   ② 截断 → 重试仍截断 → failKind=truncated，文案不许含糊成"失败"；
 *   ③ 两次纯文本 → 文案要说"重试一次仍是…"，不是空话；
 *   ④ 重试指令**按类型给**（截断说"减少条目"，散文说"只输出 JSON"）；
 *   ⑤ 首次就成功 → 不许谎报 retried，trace 里也没有这个字段。
 *
 * 运行：node scripts/test/e2e-structured-retry.cjs
 */
const fs = require('fs')
const path = require('path')
const { mkTmpPath } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'main', 'llm', 'planDraft.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}

const TEST_ROOT = mkTmpPath('fc-retry-')
fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })  // setDataDir 要认出这是数据根
fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'projects: []\n', 'utf-8')
process.env.FC_TEST_USERDATA = path.join(TEST_ROOT, '.userdata')
require(path.join(REPO, 'scripts/test/electron-stub.cjs'))
const data = require(path.join(REPO, 'desktop/dist/main/data/index.js'))
data.setDataDir(TEST_ROOT)
const { setTraceFilePathForTest } = require(path.join(REPO, 'desktop/dist/main/llm/trace.js'))
setTraceFilePathForTest(path.join(TEST_ROOT, 'ai-trace.jsonl'))
const { generatePlanDraft } = require(ART)

const INPUT = {
  project: 'demo',
  projectName: '演示项目',
  definition: '把结构化输出的失败分型并重试一次。',
  tasks: [{ id: 't1', title: '修复环', status: '进行中' }],
  ledger: null,
  git: { commits: 3, since: '30 天' },
}
const GOOD = {
  stages: [{
    id: 'P0', title: '修复环', what: '失败分型 + 一次重试',
    approach: ['配平扫描判截断'],
    copy: [['CI checks', '失败分型', '并行调度', '三类各一条反例']],
    criteria: ['cmd: node scripts/test/e2e-structured-retry.cjs 退出码 0'],
    cites: ['task:t1', 'git:commits'],
  }],
}
const GOOD_TEXT = JSON.stringify(GOOD)
const PROSE = '好的，我来分析一下这个项目。它主要分为三层：数据、逻辑、界面……后面省略很多字'
const CUT = '{"stages":[{"id":"P0","title":"修'

/** 按序返回文本；同时记下每次收到的 prompt */
function depsFor(returns) {
  const prompts = []
  const traces = []
  const written = []
  let i = 0
  const d = {
    now: '2026-11-07T00:00:00.000Z',
    callLlm: async (prompt) => {
      prompts.push(String(prompt || ''))
      const v = returns[Math.min(i, returns.length - 1)]
      i++
      if (v instanceof Error) throw v
      return { text: String(v), usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, model: 'fake' }
    },
    writeFile: (file, content) => written.push({ file, content }),
    appendTrace: (rec) => traces.push(rec),
  }
  return { d, prompts, traces, written, calls: () => i }
}

async function main() {
  // ── ① 散文 → 重试救回 ────────────────────────────────────────────
  console.log('== ① 散文 → 一次严格重试 → 救回（旧实现这里直接放弃）==')
  {
    const x = depsFor([PROSE, GOOD_TEXT])
    const r = await generatePlanDraft(INPUT, x.d)
    check('★★ 救回来了（ok=true）', r.ok === true, r.error)
    check('★★ 恰好又调了一次，不是无限重试', x.calls() === 2, String(x.calls()))
    check('★ 结果如实标 retried（不许把重试救回的当成一次成）', r.retried === true, String(r.retried))
    check('★ 草案只留"待裁决"，引用与判据照旧生效', r.ok && r.stages.length === 1 && r.stages[0].cites.includes('task:t1'), JSON.stringify(r.stages))
    check('★★ trace 里带 retried: true（以后才算得出重试收益率）',
      x.traces.length === 1 && x.traces[0].retried === true, JSON.stringify(x.traces))
    check('★ 重试指令说"只输出一个 JSON 对象"（不是笼统"注意格式"）',
      x.prompts.length === 2 && /只输出一个 JSON 对象/.test(x.prompts[1]), (x.prompts[1] || '').slice(-120))
    check('★ 写盘走注入，没碰真实 task-data', x.written.length === 1, String(x.written.length))
  }

  // ── ② 截断 → 重试仍截断 ──────────────────────────────────────────
  console.log('\n== ② 截断 → 重试仍截断：类型要说准 ==')
  {
    const x = depsFor([CUT, CUT])
    const r = await generatePlanDraft(INPUT, x.d)
    check('★★ 失败类型 = truncated（不是 not_json，更不是"失败"）', r.ok === false && r.failKind === 'truncated', String(r.failKind))
    check('★ 文案说清是"截断 / 不完整"，不是空话', /截断|不完整/.test(r.error || ''), r.error)
    check('★★ 重试指令是"减少条目数量"（截断要少画点，不是"只输出 JSON"）',
      x.prompts.length === 2 && /减少条目数量/.test(x.prompts[1]), (x.prompts[1] || '').slice(-120))
    check('★ trace 带 fail_kind=truncated + retried=true',
      x.traces.length === 1 && x.traces[0].fail_kind === 'truncated' && x.traces[0].retried === true,
      JSON.stringify(x.traces))
    check('★ 失败时不写任何草案文件', x.written.length === 0, String(x.written.length))
  }

  // ── ③ 两次纯文本 ─────────────────────────────────────────────────
  console.log('\n== ③ 两次纯文本：错误要说"两次都没给出 JSON" ==')
  {
    const x = depsFor([PROSE, PROSE])
    const r = await generatePlanDraft(INPUT, x.d)
    check('★★ 文案里明说"重试一次仍是"（不是"生成失败"四个字）',
      r.ok === false && /重试一次仍是/.test(r.error || ''), r.error)
    check('★ failKind 是 not_json', r.failKind === 'not_json', String(r.failKind))
    check('★ trace 的 ok=false 且带 error 原文',
      x.traces.length === 1 && x.traces[0].ok === false && !!x.traces[0].error, JSON.stringify(x.traces))
  }

  // ── ④ 反例：首次就成功 ───────────────────────────────────────────
  console.log('\n== ④ 反例：一次就成 → 不许谎报 retried ==')
  {
    const x = depsFor([GOOD_TEXT])
    const r = await generatePlanDraft(INPUT, x.d)
    check('★★ 只调一次', r.ok === true && x.calls() === 1, String(x.calls()))
    check('★★ 结果 retried 为假 / 缺省（不许给自己贴金）', !r.retried, String(r.retried))
    check('★★ trace 里没有 retried 字段', x.traces.length === 1 && !('retried' in x.traces[0]), JSON.stringify(x.traces))
  }

  // ── ⑤ 反例：重试调用本身抛错 ─────────────────────────────────────
  console.log('\n== ⑤ 反例：重试调用失败 → 说清是重试挂了，不许静默 ==')
  {
    const x = depsFor([PROSE, new Error('通道全挂')])
    const r = await generatePlanDraft(INPUT, x.d)
    check('★★ 错误文案带"重试调用失败"和原因',
      r.ok === false && /重试调用失败/.test(r.error || '') && /通道全挂/.test(r.error || ''), r.error)
    check('★ 失败仍留一条 trace（不因为重试挂了就丢账）', x.traces.length === 1, JSON.stringify(x.traces))
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
