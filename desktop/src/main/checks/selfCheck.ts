/**
 * 自检报告（0.6.0 P7）—— 方寸跑一遍计划卡里的全部判据，出逐格结论
 *
 * 复用 P3 执行器（四类真跑）与 P4 准入逻辑（全过才算通过）：
 *   · 只跑“已冻结 / 未完成 / 完成”的格子；“待裁决 / 未冻结”记“未开工”——
 *     没批的计划不该被自检偷偷跑；
 *   · 每条判据的结果原样保留（通过 / 未过 / 未判定），未过项附**实际值**；
 *   · 额外一格：从 P5 的投入产出账算一条"原来不知道的事"（每张完成卡摊多少花销/token），
 *     算不出就明写“算不出，因为 X”；
 *   · 报告只写 `docs/自检报告-<日期>.md`，不改计划卡（推进是 P4 的事，且要人点）。
 *
 * 为什么 P7 自己的 `selfcheck-plan.py` 不跑：那会递归。在结果里如实记 `unknown` + 原因。
 */
import * as fs from 'fs'
import * as path from 'path'
import { listPlanFiles, readPlan, type PlanDoc, type PlanStage } from '../data/plans'
import { getDataDir } from '../data'
import { runCriterion, type CheckResult } from './runner'
import { collectWasteLedger } from '../usage/ledger'
import { deriveWasteInsight, type WasteInsight, type WasteLedger } from '../../shared/waste'
import { evaluateStageGate } from '../../shared/stageGate'

export type StageConclusion = '通过' | '未过' | '未开工'

export interface StageSelfCheck {
  file: string
  id: string
  title: string
  status: string
  conclusion: StageConclusion
  results: CheckResult[]
  total: number
  passed: number
  failed: number
  unknown: number
}

export interface SelfCheckOptions {
  /** 判据里的相对路径以它为根（项目仓库） */
  repo?: string
  days?: number
  now?: string
  timeoutMs?: number
}

export interface SelfCheckDeps {
  runCriterion?: (raw: string, opts: { root?: string; timeoutMs?: number }) => Promise<CheckResult>
  ledger?: (opts: { days: number; repo: string }) => WasteLedger
}

export interface SelfCheckReport {
  date: string
  iso: string
  days: number
  files: string[]
  stages: StageSelfCheck[]
  totals: {
    stages: number
    pass: number
    fail: number
    notStarted: number
    criteria: number
    passed: number
    failed: number
    unknown: number
  }
  ledger: WasteLedger
  insight: WasteInsight
  markdown: string
}

const NOT_STARTED = ['待裁决', '待裁决（未冻结）', '待起草', '未冻结', '']
const SELF_CMD = /selfcheck-plan\.py/i

function isNotStarted(status: string): boolean {
  return NOT_STARTED.includes(String(status || '').trim())
}

/** 报告日期按**本地日历**（用户说的"今天"不是 UTC 的今天） */
function localDate(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return String(iso).slice(0, 10)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function actualOf(r: CheckResult): string {
  const ev = r.evidence || {}
  if (ev.actual !== undefined && ev.actual !== null) return `实际值 ${ev.actual}`
  if (ev.exitCode !== undefined && ev.exitCode !== null) return `实际值：退出码 ${ev.exitCode}`
  if (ev.timedOut) return '实际值：超时（未判定）'
  const d = String(r.detail || '').trim()
  return d ? `实际：${d}` : '实际：未给出'
}

function conclusionOf(results: CheckResult[]): StageConclusion {
  // 复用 P4 准入逻辑：全过才放行；空判据 / 任何 fail / unknown 都算未过
  const gate = evaluateStageGate(results.map((r) => ({
    raw: r.raw, state: r.state, detail: r.detail, evidence: r.evidence,
  })))
  return gate.canAdvance ? '通过' : '未过'
}

async function checkStage(
  doc: PlanDoc, stage: PlanStage, repo: string, deps: SelfCheckDeps, timeoutMs?: number,
): Promise<StageSelfCheck> {
  const base = {
    file: doc.file, id: stage.id, title: stage.title,
    status: String(stage.status || '').trim(),
  }
  if (isNotStarted(base.status)) {
    return { ...base, conclusion: '未开工', results: [], total: 0, passed: 0, failed: 0, unknown: 0 }
  }
  const run = deps.runCriterion || runCriterion
  const results: CheckResult[] = []
  for (const raw of stage.criteria || []) {
    const line = String(raw || '').trim()
    if (!line) continue
    if (SELF_CMD.test(line)) {
      results.push({
        ok: false, state: 'unknown', kind: 'cmd',
        detail: '自检命令不能在自检里再跑一遍（会递归）—— 请用 python scripts/selfcheck-plan.py 单独跑',
        evidence: {}, raw: line,
      })
      continue
    }
    results.push(await run(line, { root: repo, timeoutMs }))
  }
  const passed = results.filter((r) => r.state === 'pass').length
  const failed = results.filter((r) => r.state === 'fail').length
  const unknown = results.filter((r) => r.state === 'unknown').length
  return {
    ...base, conclusion: conclusionOf(results), results,
    total: results.length, passed, failed, unknown,
  }
}

/** 渲染报告（纯函数；测试可直接喂 fixture） */
export function buildSelfCheckMarkdown(report: Omit<SelfCheckReport, 'markdown'>): string {
  const L: string[] = []
  L.push(`# 自检报告 · ${report.date}`, '')
  L.push(`- 生成：${report.iso}`)
  L.push(`- 计划卡：${report.files.join(' / ') || '（没有计划卡）'}`)
  L.push(`- 投入产出账窗口：近 ${report.days || '全部'} 天`)
  L.push(`- 逐格：通过 ${report.totals.pass} / 未过 ${report.totals.fail} / 未开工 ${report.totals.notStarted}（共 ${report.totals.stages} 格）`)
  L.push(`- 判据：通过 ${report.totals.passed} / 未过 ${report.totals.failed} / 未判定 ${report.totals.unknown}（共 ${report.totals.criteria} 条）`)
  L.push('- 口径：自检只跑“已冻结 / 未完成 / 完成”的格子；“待裁决 / 未冻结”记“未开工”。'
    + '未知前缀、超时、自检自身命令记“未判定”——**都不算通过**。')
  L.push('')
  L.push('## 逐格结论', '')
  if (!report.stages.length) {
    L.push('本仓还没有计划卡 —— 没有可自检的格子。')
  } else {
    L.push('| 计划 | 阶段 | 状态 | 结论 | 判据 | 通过 | 未过 | 未判定 |')
    L.push('|---|---|---|---|---|---|---|---|')
    for (const s of report.stages) {
      L.push(`| ${s.file} | ${s.id} · ${s.title} | ${s.status || '未填'} | ${s.conclusion} | ${s.total} | ${s.passed} | ${s.failed} | ${s.unknown} |`)
    }
  }
  L.push('')
  L.push('## 未过 / 未判定明细', '')
  const bad = report.stages.flatMap((s) => s.results
    .filter((r) => r.state !== 'pass')
    .map((r) => ({ s, r })))
  if (!bad.length) {
    L.push('（没有未过 / 未判定项）')
  } else {
    for (const { s, r } of bad) {
      const tag = r.state === 'unknown' ? '未判定' : '未过'
      L.push(`- ${s.file} · ${s.id}“${r.raw}”→ ${actualOf(r)}（${tag}）`)
    }
  }
  L.push('')
  L.push('## 投入产出账', '')
  if (!report.ledger.cells.length) {
    L.push(`- ${report.ledger.emptyText}`)
  } else {
    for (const c of report.ledger.cells) {
      L.push(`- ${c.label}：${c.value}${c.detail ? `（${c.detail}）` : ''}`)
      L.push(`  - ${c.caveat}`)
    }
  }
  L.push('')
  L.push('### 额外一格：你原来不知道的事', '')
  L.push(report.insight.text)
  L.push('')
  L.push('## 结论', '')
  for (const s of report.stages) {
    const counts = s.total ? `（${s.passed}/${s.total} 通过）` : ''
    L.push(`- ${s.file} · ${s.id} ${s.conclusion}${counts}`)
  }
  const output = report.ledger.cells.find((c) => c.key === 'output')
  if (output) L.push(`- 近 ${report.days || '全部'} 天产出：${output.value}（口径见“投入产出账”）`)
  // “算不出”只允许出现一次（P7 判据）：算不出时结论里不再重复同一句
  if (report.insight.ok) L.push(`- ${report.insight.text}`)
  else L.push('- 额外一格没有可算的结论（原因见上）。')
  return L.join('\n') + '\n'
}

/**
 * 跑一遍自检（不写盘；写报告在 `selfcheck-cli.ts`，测试可只看返回值）。
 */
export async function runSelfCheck(opts: SelfCheckOptions = {}, deps: SelfCheckDeps = {}): Promise<SelfCheckReport> {
  const repo = String(opts.repo || '').trim() || (() => {
    try { return getDataDir() } catch { return process.cwd() }
  })()
  const days = Number.isFinite(Number(opts.days)) ? Math.max(0, Math.floor(Number(opts.days))) : 30
  const iso = String(opts.now || new Date().toISOString())
  const date = localDate(iso)
  const files = listPlanFiles()
  const stages: StageSelfCheck[] = []
  for (const f of files) {
    const doc = readPlan(f)
    if (!doc) continue
    for (const s of doc.stages) {
      stages.push(await checkStage(doc, s, repo, deps, opts.timeoutMs))
    }
  }
  const totals = {
    stages: stages.length,
    pass: stages.filter((s) => s.conclusion === '通过').length,
    fail: stages.filter((s) => s.conclusion === '未过').length,
    notStarted: stages.filter((s) => s.conclusion === '未开工').length,
    criteria: stages.reduce((n, s) => n + s.total, 0),
    passed: stages.reduce((n, s) => n + s.passed, 0),
    failed: stages.reduce((n, s) => n + s.failed, 0),
    unknown: stages.reduce((n, s) => n + s.unknown, 0),
  }
  const ledger = deps.ledger
    ? deps.ledger({ days, repo })
    : collectWasteLedger({ days, repo })
  const insight = deriveWasteInsight(ledger)
  const base = { date, iso, days, files, stages, totals, ledger, insight }
  const markdown = buildSelfCheckMarkdown(base)
  return { ...base, markdown }
}

/** 报告默认落点：`docs/自检报告-<日期>.md` */
export function reportPath(root: string, date: string): string {
  return path.join(root, 'docs', `自检报告-${date}.md`)
}

/** 写报告（只写报告，不改计划卡） */
export function writeSelfCheckReport(root: string, report: Pick<SelfCheckReport, 'date' | 'markdown'>): string {
  const out = reportPath(root, report.date)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, report.markdown, 'utf-8')
  return out
}
