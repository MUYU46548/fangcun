/**
 * 随包分发的技能清单 + 「上次同步还算不算数」的判据（2026-11-05）。
 *
 * 为什么单独抽出来：这两件事原来都长在 `main/services/skillInstaller.ts` 里，
 * 而那个文件依赖 electron（app.getPath / shell），于是**测试跑不起来** ——
 * 而它们恰恰是两个真出过问题的地方：
 *   ① 技能清单写死两个 id → 加第三个技能时自动同步看不见它，且不报错；
 *   ② 升级后旧进程还占着托盘，同步压根没跑，界面上却和成功时长得一样。
 * 抽成纯函数后 `scripts/test/e2e-skill-sync.cjs` 能直接跑它们（含反例）。
 */
import * as fs from 'fs'
import * as path from 'path'

/**
 * 兜底技能 id（**只在 manifest 与目录都读不到时**才用）。
 *
 * 2026-11-05 之前它叫 `SKILL_DIRS`，而且是**唯一**真相源：往 skills/ 里加第三个技能，
 * `checkSkillsStatus` / `installSkillsTo` / `autoCheckSkills` 全看不见它 ——
 * 技能页面上有、自动同步里没有，"技能随方寸版本分发"这句承诺当场失效，却不报任何错。
 */
export const FALLBACK_SKILL_DIRS: readonly string[] = ['fangcun-bridge', 'skill-management-policy']

/**
 * 读一个技能源目录里"该分发哪几个技能"。
 *
 * 顺序：`manifest.json` 的 `skills[].id` → 目录扫描（带 SKILL.md 的子目录）→ 兜底常量。
 * 第三层只在"manifest 删坏 + 目录读不到"时生效 —— 那种情况下宁可装老的两个，
 * 也不能什么都不装：技能卡约束的是 agent 行为，缺了会真的做错事。
 */
export function readSkillIdsFromDir(dir: string): string[] {
  const ids: string[] = []
  try {
    const mp = path.join(dir, 'manifest.json')
    if (fs.existsSync(mp)) {
      const m = JSON.parse(fs.readFileSync(mp, 'utf-8'))
      for (const e of Array.isArray(m?.skills) ? m.skills : []) {
        const id = String(e?.id ?? '').trim()
        if (id && ids.indexOf(id) < 0) ids.push(id)
      }
    }
  } catch {
    /* manifest 坏了 → 目录扫描兜底 */
  }
  if (!ids.length) {
    try {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) ids.push(d.name)
      }
    } catch {
      /* 目录不存在 → 兜底常量 */
    }
  }
  return ids.length ? ids : FALLBACK_SKILL_DIRS.slice()
}

export interface SkillSyncStaleVerdict {
  /** 这份记录还作数吗（false = 该重新同步一次） */
  stale: boolean
  /** 为什么（给人看的一句话；作数时为空串） */
  reason: string
}

/**
 * 上次同步记录还算不算数。
 *
 * 判据只有两条，但两条都必须有：
 *   · 没记录 —— 从没跑成过（第一次启动、或者每次都失败到写不进盘）；
 *   · 记录的 `appVersion` ≠ 当前版本 —— **升级过了，但同步停在旧版本**。
 *     这正是"更新后技能没更新"的唯一可观测特征：方寸常驻托盘，升级后旧进程不退，
 *     新实例被单实例锁顶掉，那句 autoCheckSkills 从头到尾没执行。
 */
export function judgeSkillSyncStale(
  status: { appVersion?: string } | null | undefined,
  currentVersion: string,
): SkillSyncStaleVerdict {
  if (!status || !status.appVersion) {
    return { stale: true, reason: '还没有同步记录 —— 自动同步一次都没跑成过' }
  }
  const cur = String(currentVersion || '').trim()
  if (cur && status.appVersion !== cur) {
    return {
      stale: true,
      reason: `上次同步是在 ${status.appVersion} 跑的，现在是 ${cur} —— 升级后的技能还没同步过去`,
    }
  }
  return { stale: false, reason: '' }
}
