/**
 * 同步按钮的「阶段 + 耗时」文案（2026-10-25 卡 004）。
 *
 * 暮雨原话：「Git 同步转圈依然很抽象，能不能搞个进度条或者额外的转圈动画？
 *           全世界那么多软件没见过这样整个按钮拿去旋转的，太傻了。」
 *
 * 两条设计红线，写在这里免得以后有人"优化"掉：
 *  ① **不编百分比**。`git push` 不报字节进度，任何 `37%` 都是编的 —— 编进度就是假成功。
 *     能做的是：真实阶段（主进程真跑哪一步就报哪一步）+ 真实秒数。
 *  ② **阶段名必须来自主进程**。渲染层不许自己按时间"猜"到下一步 ——
 *     猜出来的阶段和真实进度对不上时，比不显示更糟。
 *
 * 本文件只放纯函数：不碰 electron、不碰 DOM，所以 `node` 能直接断言
 * （`scripts/test/e2e-sync-visible.cjs`，可以喂任意秒数而不用真等 15 秒）。
 */

/** 主进程真正会经过的阶段（顺序即 `gitSyncData` 里的执行顺序） */
export const SYNC_PHASES = ['prepare', 'scan', 'mirror', 'commit', 'push', 'recover'] as const
export type SyncPhase = typeof SYNC_PHASES[number]

/** 阶段 → 人话。⚠ 只写"正在做什么"，不写"还剩多久"（那必须有真数据才敢写）。 */
const PHASE_LABEL: Record<SyncPhase, string> = {
  prepare: '准备仓库',
  scan: '扫描改动',
  mirror: '写入副本',
  commit: '提交',
  push: '推送',
  recover: '重试推送',
}

/** 超过这个时长就补一句「网络慢」—— 这不是进度，是给"卡住了吗"一个解释 */
export const SLOW_AFTER_MS = 15_000

/** 是不是合法阶段名（主进程/旧版本可能传来别的字符串，别让界面出现英文枚举） */
export function isSyncPhase(v: unknown): v is SyncPhase {
  return typeof v === 'string' && (SYNC_PHASES as readonly string[]).includes(v)
}

export function syncPhaseLabel(phase: unknown): string {
  return isSyncPhase(phase) ? PHASE_LABEL[phase] : '同步'
}

/**
 * 进行中的胶囊文字：`推送 3s` / `推送 · 网络慢 18s`
 *
 * 秒数取**整秒向下取整**（0.9s 显示 0s 而不是 1s —— 宁可显得慢，不夸大）。
 * `phase` 认不出时退回笼统的「同步」，不显示 `undefined`。
 */
export function syncCapsuleText(phase: unknown, elapsedMs: number): string {
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const secs = Math.floor(ms / 1000)
  const label = syncPhaseLabel(phase)
  const slow = ms >= SLOW_AFTER_MS ? ' · 网络慢' : ''
  const known = isSyncPhase(phase)
  // 认得出的阶段说"在干什么"；认不出就说"同步中"（不硬编一个阶段糊弄）
  const head = known ? label : '同步中'
  return `${head}${slow} ${secs}s`
}

/** 结束态（在按钮上停留 3 秒后回图标） */
export function syncDoneText(ok: boolean): string {
  return ok ? '已同步' : '未同步'
}
