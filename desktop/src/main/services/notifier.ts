/**
 * Fangcun Desktop — 通知检测器
 *
 * 主进程轻量定时扫描（默认 60s），把 7 类事件写入通知中心：
 *   todo-due（待办到期）/ task-deadline（任务截止）/ task-timeout（超时未回写）
 *   / parse-error（解析失败）/ backup-failed（由 scheduler 事件写入，不在此扫描）
 *   / blocker-broken（阻塞链断裂）/ task-stalled（进行中却没动静）
 *
 * **扫描范围是用户拍板的定稿，不自作主张加新类型**（2026-10-01 原话：
 * 「先不急着改，先明确需求再改，我觉得按你这样改只会增加一堆噪音，很吵」）。
 * 新增的 blocker-broken / task-stalled 一律 `osNotify:false` —— 形态是
 * 「角标红点 + 面板集中看」，不弹系统通知。
 *
 * 到点只弹一次：去重键含事件指纹（due 值），改期后是新事件。
 * 事件消失时自动消解对应未读通知（resolveNotifications）。
 */
import { Notification as OsNotification } from 'electron'
import * as appLog from './appLog'
import * as todos from './todos'
import * as notifications from './notifications'
import * as data from '../data'
import * as tasks from '../data/tasks'

let timer: NodeJS.Timeout | null = null
let running = false
let lastScanAt: string | null = null
/** 测试注入：跳过系统通知 */
let suppressOsNotify = false

/** 解析 due/deadline：兼容 MM-DD / YYYY-MM-DD / ISO；无效返回 null */
export function parseDueValue(v: unknown): Date | null {
  if (!v) return null
  const s = String(v).trim()
  let d: Date
  if (/^\d{1,2}-\d{1,2}$/.test(s)) {
    const now = new Date()
    d = new Date(now.getFullYear(), Number(s.split('-')[0]) - 1, Number(s.split('-')[1]))
    // MM-DD 无年份：若已过去超过 180 天，视为明年（跨年容错）
    if (d.getTime() < now.getTime() - 180 * 86400000) d.setFullYear(d.getFullYear() + 1)
  } else {
    d = new Date(s)
  }
  return isNaN(d.getTime()) ? null : d
}

function osNotify(title: string, body: string): void {
  if (suppressOsNotify) return
  try {
    if (OsNotification.isSupported()) new OsNotification({ title, body }).show()
  } catch { /* 通知失败不影响主流程 */ }
}

function push(input: notifications.PushInput): boolean {
  const r = notifications.pushNotification(input)
  if (r.created && input.osNotify !== false) {
    osNotify('方寸 · ' + input.title, input.body ?? '')
  }
  return r.created
}

/**
 * 更新包下载完成 → 必须「看得见」（012，2026-09-25）。
 *
 * 为什么必须在主进程弹：方寸关窗只是**缩进托盘**，窗口不可见时渲染层的设置页文案、
 * toast 全都看不到。只改渲染层状态 = 用户永远不知道新版本已经下好了（原 bug 就是这样）。
 */
export function notifyUpdateReady(version: string): boolean {
  return push({
    type: 'update-downloaded',
    level: 'info',
    title: `新版本 ${version} 已下载完成`,
    body: '点「立即重启安装」升级；也可稍后在 设置 → 关于 里安装',
    sourceId: version,
    key: 'update-downloaded:' + version,
  })
}

/** 一次完整扫描。exported 供测试与手动触发。 */
export function scanOnce(now = new Date()): { scanned: boolean; newNotifications: number; resolved: number } {
  let created = 0
  let resolved = 0

  // ── 1. 待办到期（到点弹一次；完成/删除后自动消解） ──
  const todoList = todos.listTodos()
  const dueTodoIds = new Set<string>()
  for (const t of todoList) {
    if (t.done) continue
    const due = parseDueValue(t.due)
    if (due && due.getTime() <= now.getTime()) {
      dueTodoIds.add(t.id)
      if (push({
        type: 'todo-due', level: 'warning',
        title: `待办到期：${t.title}`,
        body: `优先级 ${t.priority}`,
        sourceId: t.id, key: t.due,
      })) created++
    }
  }
  // 已完成或已删除的到期待办 → 消解
  for (const n of notifications.listNotifications()) {
    if (n.type === 'todo-due' && !dueTodoIds.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('todo-due', n.sourceId)
    }
  }

  // ── 2. 任务截止（deadline 已过且未到终态） ──
  const activeTasks = data.loadTasks('active')
  const overdueIds = new Set<string>()
  for (const t of activeTasks) {
    if (t.fm.status === '完成' || t.fm.status === '驳回') continue
    const dl = parseDueValue(t.fm.deadline)
    if (dl && dl.getTime() < now.getTime()) {
      overdueIds.add(t.id)
      if (push({
        type: 'task-deadline', level: 'warning',
        title: `任务逾期：${t.fm.title ?? t.id}`,
        body: `截止 ${String(t.fm.deadline ?? '')}，当前状态 ${t.fm.status ?? '未知'}`,
        sourceId: t.id, key: String(t.fm.deadline ?? ''),
      })) created++
    }
  }
  for (const n of notifications.listNotifications()) {
    if (n.type === 'task-deadline' && !overdueIds.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('task-deadline', n.sourceId)
    }
  }

  // ── 3. 任务超时未回写（复用 findTimeoutTasks） ──
  const timeouts = tasks.findTimeoutTasks()
  const timeoutIds = new Set(timeouts.map(t => t.id))
  for (const t of timeouts) {
    if (push({
      type: 'task-timeout', level: 'warning',
      title: `任务超时未回写：${t.title}`,
      body: `已进行 ${t.hours} 小时`,
      // key 不含 hours：小时数每次扫描都会变，用它做指纹会每小时生成一条新通知
      sourceId: t.id, key: 'timeout',
    })) created++
  }
  for (const n of notifications.listNotifications()) {
    if (n.type === 'task-timeout' && !timeoutIds.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('task-timeout', n.sourceId)
    }
  }

  // ── 4. 解析失败（持续可见，事件存在即保持未读） ──
  const perrs = data.getParseErrors()
  const errPaths = new Set(perrs)
  for (const p of perrs) {
    if (push({
      type: 'parse-error', level: 'error', osNotify: false,
      title: '任务文件无法解析',
      body: p,
      sourceId: p, key: p,
    })) created++
  }
  for (const n of notifications.listNotifications()) {
    if (n.type === 'parse-error' && !errPaths.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('parse-error', n.sourceId)
    }
  }

  // ── 5. 阻塞链断裂（B 类，2026-10-01 用户定稿）────────────────────────
  // 非终态任务的 `阻塞:` 指向一个活跃区与归档区都找不到的任务（已删 / 在 .trash 里）。
  // 数据异常但可恢复 → warning（不打"紧急"），且不弹系统通知。
  const broken = tasks.detectBrokenBlockers()
  const brokenPairs = new Set(broken.map(b => `${b.taskId}|${b.blockerId}`))
  for (const b of broken) {
    if (push({
      type: 'blocker-broken', level: 'warning', osNotify: false,
      title: `阻塞链断裂：${b.taskTitle}`,
      body: `它依赖的 ${b.blockerId} 已不存在（可能被删除或进了回收站）`,
      sourceId: b.taskId, key: b.blockerId,   // 每对「任务×缺失阻塞源」一条，避免互相挤掉
    })) created++
  }
  for (const n of notifications.listNotifications()) {
    if (n.type === 'blocker-broken' && !brokenPairs.has(`${n.sourceId}|${n.key ?? ''}`)) {
      resolved += notifications.resolveNotifications('blocker-broken', n.sourceId)
    }
  }

  // ── 6. 进行中却没动静（C 类，2026-10-01 用户定稿）────────────────────
  // 「状态=进行中」= 用户把提示词扔给 AI 后回方寸点的按钮 = 已派活；
  // 此后任务文件 ≥24h 没有任何写入 = 没人回写。只扫进行中（其他状态天然不回写，扫了是噪音）。
  const stalled = tasks.findStalledTasks()
  const stalledIds = new Set(stalled.map(t => t.id))
  for (const t of stalled) {
    if (push({
      type: 'task-stalled', level: 'warning', osNotify: false,
      title: `任务没动静：${t.title}`,
      body: `状态「进行中」，但任务文件已 ${t.hours} 小时没有任何写入`,
      sourceId: t.id,
      key: 'stalled',   // 固定指纹：小时数每次扫描都变，用它做指纹会每小时长出一条新通知
    })) created++
  }
  for (const n of notifications.listNotifications()) {
    if (n.type === 'task-stalled' && !stalledIds.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('task-stalled', n.sourceId)
    }
  }

  notifications.prune()
  lastScanAt = new Date().toISOString()
  return { scanned: true, newNotifications: created, resolved }
}

/** 备份失败事件入口（scheduler 调用） */
export function reportBackupFailure(failStreak: number, firstError: string): void {
  push({
    type: 'backup-failed', level: 'error',
    title: `备份连续失败 ${failStreak} 次`,
    body: firstError.slice(0, 200),
    sourceId: 'backup', key: String(failStreak),
  })
}

export function resolveBackupFailure(): void {
  notifications.resolveNotifications('backup-failed')
}

export function startScanner(intervalMs = 60000): void {
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    try {
      scanOnce()
    } catch (e) {
      // P0-4（2026-10-01）：这里原本是 `catch {}` **静默吞异常** —— 「扫描器停摆」和
      // 「扫不到事件」在界面上长得一模一样，用户只能得出通知中心是坏的。落应用日志后
      // 照常继续（单次失败不致命），配合面板页脚的「上次扫描」相对时间即可判断是否停摆。
      appLog.error('notifier', '单次扫描失败（下次到点照常重试）', e)
    }
    running = false
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  // 启动后 5s 做首次扫描
  const first = setTimeout(() => {
    try { scanOnce() } catch (e) { appLog.error('notifier', '启动后首次扫描失败', e) }
  }, 5000)
  if (typeof first.unref === 'function') first.unref()
}

export function stopScanner(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function getScannerStatus(): { running: boolean; lastScanAt: string | null } {
  return { running: !!timer, lastScanAt }
}

/** 测试钩子 */
export function _setSuppressOsNotify(v: boolean): void { suppressOsNotify = v }
