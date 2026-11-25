#!/usr/bin/env node
/**
 * agent 核销通道的反例自证（2026-11-25）
 *
 * ## 它守的是什么
 *
 * 日志「下一步」的处置标记只能写进**日志正文**，而日志从 2026-11-19 起对 agent 只读。
 * 于是那道闸**天生只能由用户清**，而用户已经明确说过很多次：
 *
 *   「日志欠账 42 条跟我说几万次都没用，**我不知道要干什么**。」
 *
 * 一个"只有用户能清、用户又不会去清"的闸 = 永远红 = 纯噪音。
 * 所以加了 agent 核销通道：写在 `task-data/.log-dispositions.jsonl`，**不碰日志一个字**。
 *
 * ## 为什么必须有这个反例脚本
 *
 * 这条通道的本质风险是 **agent 自批自销**：它能把闸刷绿，而绿本身就是它自己说的。
 * 那就是本仓反复栽的"假绿"。所以四条硬约束每一条都要能被证明"抓得住"：
 *
 *   ① 证据不够长 → 不算核销
 *   ② 类别不在白名单 → 不算核销
 *   ③ 坏 JSON 行 → 跳过，不许让整份清点归零
 *   ④ 序号指向不存在的条目 → 不生效
 *   ⑤ 日志正文一个字节都不动
 *
 * ⚠ **按增量判，不写死条数** —— 写死"11 条 / 31 条"的话，
 *   下次再核销一条这条守卫就自己假红，然后有人会去改数字把红消掉。
 *   这是本仓"为了消红改判据"的老路，不能走。
 *
 * 用法：node scripts/test/check-log-dispositions.cjs
 */
'use strict'
const fs = require('fs')
const { execFileSync } = require('child_process')

const P = 'task-data/.log-dispositions.jsonl'
const BAK = P + '.bak-check'

if (!fs.existsSync(P)) {
  console.error('找不到 ' + P + ' —— 没有核销文件时这条守卫没有意义（先确认路径没变）')
  process.exit(2)
}

const orig = fs.readFileSync(P, 'utf8')
fs.writeFileSync(BAK, orig, 'utf8')

/** 跑一次 --stats，取两个数 */
function runStats() {
  const out = execFileSync(process.execPath, ['scripts/audit-log-nextsteps.cjs', '--stats'], { encoding: 'utf8' })
  const m = /仍未接（欠账）:\s*(\d+)/.exec(out)
  const a = /agent 核销（带证据，日志未改）:\s*(\d+)/.exec(out)
  return { uncovered: m ? Number(m[1]) : NaN, agent: a ? Number(a[1]) : NaN }
}

function restore() { fs.writeFileSync(P, orig, 'utf8') }

/** 改第一条有效核销的某个字段，跑一次，还原 */
function mutateFirst(fn) {
  const lines = orig.trim().split(/\r?\n/).filter(Boolean)
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    try {
      const r = JSON.parse(lines[i])
      if (r && r.log && Number.isInteger(Number(r.n))) { idx = i; break }
    } catch { /* 跳 */ }
  }
  if (idx < 0) throw new Error('核销文件里没有一条可解析的有效行')
  const row = JSON.parse(lines[idx])
  fn(row)
  lines[idx] = JSON.stringify(row)
  fs.writeFileSync(P, lines.join('\n') + '\n', 'utf8')
  const r = runStats()
  restore()
  return r
}

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log('PASS  ' + name)
  else { failed++; console.log('FAIL  ' + name + (detail ? '   → ' + detail : '')) }
}

// ── 基线（拿当前真身的数，不写死）──────────────────────────────────────
const base = runStats()
check('基线：两个数都读得出来（读成 0/NaN 就是读坏了）',
  Number.isFinite(base.agent) && Number.isFinite(base.uncovered) && base.agent > 0,
  JSON.stringify(base))

// ── ① 证据太短 ─────────────────────────────────────────────────────────
{
  const r = mutateFirst((row) => { row.evidence = '已做' })
  check('① 证据少于门槛 → 不算核销（核销 -1、欠账 +1）',
    r.agent === base.agent - 1 && r.uncovered === base.uncovered + 1, JSON.stringify(r))
}

// ── ② 类别不在白名单 ───────────────────────────────────────────────────
{
  const r = mutateFirst((row) => { row.kind = '随便写的' })
  check('② 类别不在白名单 → 不算核销（核销 -1、欠账 +1）',
    r.agent === base.agent - 1 && r.uncovered === base.uncovered + 1, JSON.stringify(r))
}

// ── ③ 坏 JSON 行 ───────────────────────────────────────────────────────
{
  fs.writeFileSync(P, orig + '\n{这不是JSON\n', 'utf8')
  const r = runStats()
  restore()
  check('③ 坏 JSON 行被跳过，其余核销照常（不许整份归零）',
    r.agent === base.agent && r.uncovered === base.uncovered, JSON.stringify(r))
}

// ── ④ 序号指向不存在的条目 ────────────────────────────────────────────
{
  const r = mutateFirst((row) => { row.n = 9999 })
  check('④ 序号指向不存在的条目 → 不生效（核销 -1、欠账 +1）',
    r.agent === base.agent - 1 && r.uncovered === base.uncovered + 1, JSON.stringify(r))
}

// ── ⑤ 日志正文一个字节都不动 ──────────────────────────────────────────
{
  let dirty = ''
  try {
    dirty = execFileSync('git', ['status', '--porcelain', 'docs/执行日志/'], { encoding: 'utf8' })
  } catch { /* 不在 git 里就跳过这条 */ }
  check('⑤ agent 核销不动日志正文（docs/执行日志 工作区无改动）', dirty.trim() === '', dirty.slice(0, 80))
}

// ── 还原并复核 ─────────────────────────────────────────────────────────
restore()
try { fs.unlinkSync(BAK) } catch { /* ignore */ }
const after = runStats()
check('⑥ 跑完还原回基线（守卫不许改变真身状态）',
  after.agent === base.agent && after.uncovered === base.uncovered,
  JSON.stringify({ base, after }))

console.log('')
console.log(failed ? 'RESULT 有 ' + failed + ' 条没咬住' : 'RESULT 反例全对')
process.exit(failed ? 1 : 0)
