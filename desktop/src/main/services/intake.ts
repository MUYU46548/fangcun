/**
 * 收卡机检 · 主进程侧（文件系统那一半）
 *
 * 纯逻辑在 `shared/intake.ts`（Node 可直跑、不碰 fs）；这里只补两件必须碰盘的事：
 *  ① `file:` 判据的存在性检查；
 *  ② 把"交付物 + 判据"跑一遍并把报告交回调用方（MCP 的 intake_task / IPC intake:check）。
 *
 * 一条安全口径：`file:` 里的相对路径**不许逃出仓库**（`..` 或绝对路径一律 false）。
 * 收卡机检是"验收交付物"，不是"读机器上任意文件"的后门。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'
import { checkDeliverable, type IntakeReport } from '../../shared/intake'

/**
 * 路径存在性：相对 `root`（默认数据根 = 仓库根）。
 * 越界 / 绝对路径 / 读不了 → false（不抛、不猜）。
 */
export function repoFileExists(rel: string, root?: string): boolean {
  try {
    const base = path.resolve(String(root || getDataDir()))
    const abs = path.resolve(base, String(rel || ''))
    if (abs !== base && !abs.startsWith(base + path.sep)) return false
    return fs.existsSync(abs)
  } catch {
    return false
  }
}

/** 跑一份收卡机检（交付物 + 判据）。repo 缺省 = 数据根。 */
export function checkIntake(
  deliverable: string,
  criteria: string[],
  repo?: string,
): IntakeReport {
  return checkDeliverable(deliverable, criteria, {
    exists: (rel: string) => repoFileExists(rel, repo),
  })
}
