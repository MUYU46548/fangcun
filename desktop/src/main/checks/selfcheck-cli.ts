#!/usr/bin/env node
/**
 * 自检报告 CLI（0.6.0 P7）—— 唯一的执行入口，由 `scripts/selfcheck-plan.py` 调起
 *
 * 用法（一般不用手敲，Python 入口会带好参数）：
 *   node desktop/dist/main/checks/selfcheck-cli.js --repo <仓库> --data-dir <数据根> --out <报告路径> [--days 30]
 *
 * 只做三件事：读计划卡 → 跑判据（P3）→ 写报告。**不改计划卡**。
 */
import * as fs from 'fs'
import * as path from 'path'
import { setDataDir, atomicWrite } from '../data'
import { runSelfCheck, reportPath } from './selfCheck'

function argOf(argv: string[], name: string, fallback = ''): string {
  const i = argv.indexOf(name)
  if (i >= 0 && i + 1 < argv.length) return String(argv[i + 1] || '')
  const eq = argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const repo = path.resolve(argOf(argv, '--repo', process.cwd()))
  const dataDir = path.resolve(argOf(argv, '--data-dir', repo))
  const days = Number(argOf(argv, '--days', '30'))
  const now = argOf(argv, '--now', '') || new Date().toISOString()
  try {
    setDataDir(dataDir)
  } catch (e: any) {
    console.error(`数据根不可用：${dataDir}（${e?.message || e}）`)
    return 2
  }
  const report = await runSelfCheck({ repo, days, now })
  const out = path.resolve(argOf(argv, '--out', reportPath(repo, report.date)))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  atomicWrite(out, report.markdown)
  const t = report.totals
  console.log(`自检完成：通过 ${t.pass} / 未过 ${t.fail} / 未开工 ${t.notStarted}`
    + `（判据 ${t.passed}/${t.criteria} 通过，未判定 ${t.unknown}）`)
  console.log(`报告：${out}`)
  if (!report.insight.ok) console.log(`额外一格：${report.insight.text}`)
  return 0
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error('自检失败：' + ((e && e.stack) || e))
    process.exit(1)
  })
}
