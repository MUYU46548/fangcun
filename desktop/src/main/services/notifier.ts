/**
 * Fangcun Desktop — 通知检测器
 *
 * 主进程轻量定时扫描（默认 60s），把这几类事件写入通知中心：
 *   todo-due（待办到期）/ task-deadline（任务截止）/ **task-review（待验收等你拍板）**
 *   / parse-error（解析失败）/ backup-failed（由 scheduler 事件写入，不在此扫描）
 *   / blocker-broken（阻塞链断裂）
 *
 * ⚠ 2026-11-05 删掉两条（暮雨：“没用的东西会冒出来”“我什么都做不了”）：
 *   · `task-timeout`：只看「派活 → 现在」，与文件有没有被回写无关 —— 与 task-stalled 各报一条，
 *     且 agent 一直在干也照报；
 *   · `task-stalled`：判据没错，但它把“干完了没关单 / 在忙别的 / 真没人做”三种原因
 *     压成一句“没人接手”，而三种情况下用户要做的事完全不同 —— 方寸也没有观测外部 agent 的能力。
 *     已挪进**整理体检**（services/cleanup.ts: pickStalled），你主动点开才看。
 * 留下的每一条都必须能回答“用户下一步能做什么”。
 *
 * **扫描范围是用户拍板的定稿，不自作主张加新类型**（2026-10-01 原话：
 * “先不急着改，先明确需求再改，我觉得按你这样改只会增加一堆噪音，很吵”）。
 * 新增的 blocker-broken / task-review 一律 `osNotify:false` —— 形态是
 * “角标红点 + 面板集中看”，不弹系统通知。
 *
 * 到点只弹一次：去重键含事件指纹（due 值），改期后是新事件。
 * 事件消失时自动消解对应未读通知（resolveNotifications）。
 */
import { BrowserWindow, Notification as OsNotification } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as appLog from './appLog'
import * as todos from './todos'
import * as notifications from './notifications'
import * as data from '../data'
import * as tasks from '../data/tasks'
// 问卷待答（2026-11-11）：卷是 agent 那边落盘的，用户不会自己知道
import * as questionnaires from '../data/questionnaires'
// 计划草案（0.7.0 规划根基）：草案落盘后没人知道 = 决策链卡在“没人看见”
import * as planDrafts from '../data/planDrafts'
// 结构地图「最后核实」日期（只读日期，不做 git 比对 —— 见 scanStructMap 的注释）
import * as policyStore from './policies'
// 日志保留期（只读：已完成 + retain_until 已过 → 提醒去点「清理超期」）
import * as logs from './logs'
// 技能副本漂移（与设置页同一个函数 `checkSkillsStatus`，不另写一套 md5 比对）
import * as skillInstaller from './skillInstaller'
import { detectAgentTargets } from './agents'

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

/**
 * 2026-10-29（暮雨第 8 条“全部修完直到稳定”+ dsh-notify-tray 借鉴 #1“免打扰”）：
 * **窗口正看着方寸时不该弹系统通知** —— 面板里已经有红点，再弹一个系统气泡只是打断。
 * 判定来源可注入（`_setFocusProbe`），因为 e2e 里没有真 BrowserWindow。
 */
let focusProbe: (() => boolean) | null = null
export function _setFocusProbe(fn: (() => boolean) | null): void { focusProbe = fn }

function windowFocused(): boolean {
  if (focusProbe) { try { return !!focusProbe() } catch { return false } }
  try { return BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isFocused()) } catch { return false }
}

function osNotify(title: string, body: string, onClick?: () => void): void {
  if (suppressOsNotify) return
  if (windowFocused()) return   // 正看着方寸：留红点，不打断
  try {
    if (OsNotification.isSupported()) {
      const n = new OsNotification({ title, body })
      if (onClick) n.on('click', onClick)
      n.show()
    }
  } catch { /* 通知失败不影响主流程 */ }
}

/**
 * 点系统通知 → **回到具体对象**（借鉴 #2）。
 * 光把窗口拉到前台不够：通知说的是“任务逾期：X”，用户点了却只看到一屏卡片，
 * 还得自己找。这里把 type+sourceId 交给渲染层，由它切视图并打开那张卡/那条日志。
 */
export function focusSource(type: string, sourceId?: string): void {
  try {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('notify:focus', { type, sourceId: sourceId || '' })
  } catch (e: any) {
    appLog.warn('notifier', '聚焦通知来源失败：' + (e?.message || e))
  }
}

/** 测试用：直接调点击路径（真机上由系统通知的 click 事件触发） */
export const _focusForTest = focusSource

function push(input: notifications.PushInput): boolean {
  const r = notifications.pushNotification(input)
  if (r.created && input.osNotify !== false) {
    // 点通知 → 回到具体对象（任务卡 / 日志 / 待办）。没有 sourceId 的通知（如备份失败）只聚焦窗口。
    osNotify('方寸 · ' + input.title, input.body ?? '', () => focusSource(input.type, input.sourceId))
  }
  return r.created
}

/** 任务所属项目（`project` 可能是数组/单值）；没有就空串，按项目订阅时视为“全局” */
function projectOfTask(t: any): string {
  const p = t?.fm?.project ?? t?.project
  return (Array.isArray(p) ? String(p[0] || '') : String(p || '')).trim()
}

/**
 * 更新包下载完成 → 必须“看得见”（012，2026-09-25）。
 *
 * 为什么必须在主进程弹：方寸关窗只是**缩进托盘**，窗口不可见时渲染层的设置页文案、
 * toast 全都看不到。只改渲染层状态 = 用户永远不知道新版本已经下好了（原 bug 就是这样）。
 */
/**
 * 有新记忆待审批 → 进通知中心 + （窗口不在前台时）弹系统通知（2026-11-20）。
 *
 * 去重 key = 最新那条待审批文件的路径：同一批不重复弹；新的一条来了才再通知。
 * 点通知 → `notify:focus` type=memory-pending，渲染层切到记忆页并筛「待审批」。
 */
export function notifyMemoryPending(count: number, latestClaim: string, latestFile: string): boolean {
  if (!Number.isFinite(Number(count)) || Number(count) <= 0) return false
  return push({
    type: 'memory-pending',
    level: 'warning',
    title: `有 ${Number(count)} 条记忆待审批`,
    body: latestClaim ? `最新：${latestClaim}` : '打开记忆页处理',
    sourceId: 'memory',
    key: String(latestFile || `count-${Number(count)}`),
    osNotify: true,
  })
}

export function notifyUpdateReady(version: string): boolean {
  // 已经“下载完成”说明“发现新版本”那条过时了，先消解，避免同一个版本两条挂着。
  try { notifications.resolveNotifications('update-available') } catch { /* ignore */ }
  return push({
    type: 'update-downloaded',
    level: 'info',
    title: `新版本 ${version} 已下载完成`,
    body: '点“立即重启安装”升级；也可稍后在 设置 → 关于 里安装',
    sourceId: version,
    key: 'update-downloaded:' + version,
  })
}

/**
 * 发现新版本（2026-11-21 暮雨：检查更新检测到新版本时是否会主动通知）。
 *
 * 此前只在窗口开着时给一条 toast；窗口缩在托盘/用户没看设置页就等于没提示。
 * 这里进通知中心（带未读角标），并在系统托盘层弹一条系统通知 —— 与“下载完成”同一条口径。
 */
export function notifyUpdateAvailable(version: string): boolean {
  return push({
    type: 'update-available',
    level: 'info',
    title: `发现新版本 ${version}`,
    body: '到 设置 → 通用 → 版本与更新 点“下载”；不装也不影响当前使用',
    sourceId: version,
    key: 'update-available:' + version,
  })
}

/**
 * 待办的“到点”时间 = 到期日 + 可选到期时间（2026-11-03 修）。
 *
 * 真 bug：`due=2026-11-03` + `dueTime=20:52` 的待办，在 17:55 就弹“待办到期”。
 * 因为旧代码只 `parseDueValue(t.due)`，把“到期日”当成当天 00:00 —— **时间字段被完全忽略**。
 * 现在：有 dueTime 就拼到那一分钟；没有就保持老行为（当天 00:00，即“今天到期”的提醒）。
 *
 * 为什么要复用 `parseDueValue` 而不是 `shared/time.parseDueAt`：后者对 `MM-DD` 没有
 * “已过去 180 天视为明年”的跨年容错，换掉会改变存量数据的语义。这里只补时间，不动日期解析。
 */
export function dueAtOf(due: unknown, dueTime?: unknown): number {
  const s0 = String(due ?? '').trim()
  let base: Date | null
  // ⚠ `new Date('2026-11-03')` 按 **UTC** 解析 —— 在非东八区会把“当天 20:52”拼到前一天。
  //   纯日期一律按**本地**构造（与待办“到期日”的语义一致）。
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s0)
  if (ymd) base = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
  else base = parseDueValue(due)
  if (!base) return NaN
  const s = String(dueTime ?? '').trim().replace(/：/g, ':')
  const m = s.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/)
  if (!m) return base.getTime()
  const hh = Number(m[1]); const mm = Number(m[2])
  if (hh > 23 || mm > 59) return base.getTime()
  const at = new Date(base)
  at.setHours(hh, mm, 0, 0)
  return at.getTime()
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
    // ⚠ 必须带 dueTime：只看到期日会把“今晚 20:52”的待办在凌晨/白天就报成到期（2026-11-03 修）
    const dueAt = dueAtOf(t.due, t.dueTime)
    if (Number.isFinite(dueAt) && dueAt <= now.getTime()) {
      dueTodoIds.add(t.id)
      if (push({
        type: 'todo-due', level: 'warning',
        title: `待办到期：${t.title}`,
        body: `优先级 ${t.priority}${t.due ? ` · 到期 ${String(t.due)}${t.dueTime ? ' ' + String(t.dueTime) : ''}` : ''}`,
        sourceId: t.id,
        // 指纹含时间：改期/改时间 = 新事件；没时间时保持老键（不制造一次性重复弹窗）
        key: `${String(t.due ?? '')}${t.dueTime ? ' ' + String(t.dueTime) : ''}`,
        project: String((t as any).project || ''),
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
        project: projectOfTask(t),
      })) created++
    }
  }
  for (const n of notifications.listNotifications()) {
    if (n.type === 'task-deadline' && !overdueIds.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('task-deadline', n.sourceId)
    }
  }

  // ── 3. 待验收等你拍板（2026-11-05 暮雨：“有用的东西不提醒，没用的东西会冒出来”）──
  // 这是全站**唯一**既有动作又有时间性的通知：agent 交了活，你不点头整条链就停在那儿
  // （不归档、不 reject、下一格也推不动）。此前它一条通知都没有 —— 而“任务没动静”那种
  // 用户什么也做不了的提醒反倒有两份。
  // 与其它新增类型同规矩：`osNotify:false`，只进面板；点击直达那张卡（sourceId = 任务 id）。
  const reviewIds = new Set<string>()
  for (const t of activeTasks) {
    if (t.fm.status !== '待验收') continue
    reviewIds.add(t.id)
    if (push({
      type: 'task-review', level: 'warning', osNotify: false,
      title: `等你拍板：${t.fm.title ?? t.id}`,
      body: `状态“待验收” —— 觉得行就点“通过”（归档），不行就打回重做；不点它就一直停在这儿`,
      sourceId: t.id,
      key: 'review',
      project: projectOfTask(t),
    })) created++
  }
  for (const n of notifications.listNotifications()) {
    if (n.type === 'task-review' && !reviewIds.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('task-review', n.sourceId)
    }
  }

  // ── 3b. 旧“任务超时未回写”清场（2026-11-05 删）──────────────────────
  // 它和 task-stalled（现也已停用）是同一件事的两种算法，而且更差：
  //   · 只看「派活时间 → 现在」，**完全不管文件有没有被回写** —— agent 一直在干也照报（误报）；
  //   · 于是同一张卡会同时出现“超时未回写”+“任务没动静”两条，点开是同一张卡。
  // 保留判据更准的那条（stalled 看的是"文件真没动"）。这里把历史残留一次性消解掉，
  // 否则面板里会永远挂着再也不会被刷新的旧条目（“僵尸通知”比不提醒更糟）。
  resolved += notifications.resolveNotifications('task-timeout')

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
      title: `依赖的卡不见了：${b.taskTitle}`,
      body: `“${b.taskTitle}”依赖的 ${b.blockerId} 已经不在活跃区/归档区（可能被删除或进了回收站）。`
        + '这不是任务本身的状态，是依赖关系断了：把缺失的卡找回，或删掉这条依赖即可。',
      sourceId: b.taskId, key: b.blockerId,   // 每对“任务×缺失阻塞源”一条，避免互相挤掉
      project: b.project || '',
    })) created++
  }
  for (const n of notifications.listNotifications()) {
    if (n.type === 'blocker-broken' && !brokenPairs.has(`${n.sourceId}|${n.key ?? ''}`)) {
      resolved += notifications.resolveNotifications('blocker-broken', n.sourceId)
    }
  }

  // ── 6. 已停用：进行中却没动静（原 C 类）────────────────────────────
  // 2026-11-05 暮雨：“这个任务没动静的消息有什么用吗？我又能做什么？我什么都做不了。”
  // 他说得对，而且比"没用"更严重 —— 它**宣称的判断超出了方寸能看见的范围**：
  // 方寸只知道"这个 .md 文件没被写"，而没被写至少三种原因（干完了没关单 / 在忙别的 / 真没人做），
  // 三种情况下你要做的事完全不同。压成一句"没人接手"就是替你下结论。
  // 何况方寸没有能力观测外部 agent 在不在干活（ai-trace 只记方寸自己发起的调用）。
  // → 判据原样搬进 `services/cleanup.ts: pickStalled`，由**整理体检**承载（你主动点开才看）。
  //   这里只负责把历史残留清掉：面板里不许留再也刷不新的僵尸通知。
  resolved += notifications.resolveNotifications('task-stalled')

  // ── 7. 问卷待你答（2026-11-11 暮雨：「新问卷完全无提示」，整站零联动）──────
  // 为什么必须在这里：卷是 **agent 在那边落盘的**（qn_propose），用户在看板时根本不会知道
  // 多了一卷；而卷没答完、没批准，依赖它的规划/派工单一步都走不了 —— 整条链卡在“没人知道”。
  // 口径：只提示「待答」（未批准 / 未作废 / 未被取代 / 未归档）；批准或作废后自动消解。
  // 去重靠 notifications 的 type+sourceId+key；key 里带题数，卷被扩题会再提示一次（那确实是新活）。
  const pendingDecks = new Set<string>()
  try {
    const decks = questionnaires.listDecks().decks
    for (const d of decks) {
      if (d.approved || d.voided || d.replacedBy || d.archived) continue
      pendingDecks.add(d.deck)
      const allAnswered = Number(d.answered || 0) >= Number(d.total || 0)
      if (push({
        type: 'questionnaire-pending', level: allAnswered ? 'info' : 'warning',
        title: allAnswered
          ? `问卷答完了，等你批准：${d.title || d.deck}`
          : `问卷待你答：${d.title || d.deck}`,
        body: allAnswered
          ? `${d.total} 题答案已齐${d.project ? ' · ' + d.project : ''} —— 点开核对后批准；批准前依赖它的规划/派工单仍出不来`
          : `${d.total} 题${d.project ? ' · ' + d.project : ''} —— 答完并批准之前，依赖它的规划/派工单出不来`,
        sourceId: d.deck,
        key: `v1:${d.total}`,
        project: String((d as any).project || ''),
      })) created++
    }
  } catch (e: any) {
    // 读不到不该让整次扫描挂掉，但也不能静默：留一行日志
    appLog.warn('notifier', '问卷待答扫描失败：' + (e?.message || e))
  }
  for (const n of notifications.listNotifications()) {
    if (n.type === 'questionnaire-pending' && !pendingDecks.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('questionnaire-pending', n.sourceId)
    }
  }

  // ── 8–13. 计划草案 · 结构地图 · 日志保留期 · 反问 · 已批准未落卡 · 技能漂移（实现见文件末尾）──
  {
    const a = scanPlanDrafts(); created += a.created; resolved += a.resolved
    const b = scanStructMap(); created += b.created; resolved += b.resolved
    const c = scanLogRetention(); created += c.created; resolved += c.resolved
    const d = scanDeckAskback(); created += d.created; resolved += d.resolved
    const e2 = scanDeckUndelivered(); created += e2.created; resolved += e2.resolved
    const f = scanSkillDrift(); created += f.created; resolved += f.resolved
  }

  notifications.prune()
  const expired = notifications.cleanupExpired(now)
  lastScanAt = new Date().toISOString()
  return { scanned: true, newNotifications: created, resolved: resolved + expired }
}

// ── 8. 计划草案等你提成（2026-11-11 · 0.7.0 规划根基）────────────────────
// 与问卷待答同一类：草案是 **agent 在那边落盘的**，用户不会知道多了一份；
// 而草案不提成阶段卡，它就永远只是一份文件 —— 决策链卡在“没人知道”这一步。
// 口径：只提示「有格三块齐全」的草案（缺块的那种提不了，提示了只会让人白点）。
// 去重：type+sourceId+key，key 带可提的格号 —— 草案又长出新格会再提示一次（那确实是新活）。
function scanPlanDrafts(): { created: number; resolved: number } {
  let created = 0
  const readyFiles = new Set<string>()
  try {
    for (const d of planDrafts.listDrafts().drafts) {
      const ready = d.stages.filter((s) => !s.missing.length)
      if (!ready.length) continue
      readyFiles.add(d.file)
      if (push({
        type: 'plan-draft', level: 'info', osNotify: false,
        // 2026-11-24：提成阶段卡是 agent 的活（它有 plan_submit / stage_plan_propose），
        // 用户在这一步只是“要不要提”，不是“去填”。归 agent，用派单带走。
        owner: 'agent',
        title: `草案等你提成：${d.file}`,
        body: `${ready.length} 格三块齐全（共 ${d.stages.length} 格）—— 到「项目页 → 作战计划」点“提成阶段卡”；提完它才是待裁决的卡`,
        sourceId: d.file,
        key: `v1:${ready.map((s) => s.id).join(',')}`,
      })) created++
    }
  } catch (e: any) {
    appLog.warn('notifier', '计划草案扫描失败：' + (e?.message || e))
  }
  let resolved = 0
  for (const n of notifications.listNotifications()) {
    if (n.type === 'plan-draft' && !readyFiles.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('plan-draft', n.sourceId)
    }
  }
  return { created, resolved }
}

// ── 10. 日志过了保留期还没清（2026-11-11）─────────────────────────────────
// 「清理超期」这个按钮一直**要人主动去点**；过了 retain_until 还挂在“已完成”里的日志，
// 没人提醒就会一直占着面板。口径：只提「已完成 **且** retain_until 已过」。
// 聚合一条（逐条刷会淹掉通知中心），key 里带“命中条数 + 最早那条 id”：
// 又冒出新的一批 → key 变 → 再提醒一次；清干净了 → 自动消解。
function scanLogRetention(): { created: number; resolved: number } {
  let created = 0
  let pending = 0
  try {
    const now = new Date().toISOString()
    const due = logs.listLogs().filter((l: any) => l.status === 'completed' && l.retainUntil && now > l.retainUntil)
    pending = due.length
    if (due.length) {
      const first = due[0]
      if (push({
        type: 'log-retention', level: 'info', osNotify: false,
        title: `${due.length} 条已完成日志已过保留期`,
        body: `最早一条：《${String(first.title || first.id)}》（保留到 ${String(first.retainUntil).slice(0, 10)}）。`
          + '到日志页点「清理超期」把它们收进已归档（只改状态，不删文件）',
        sourceId: 'logs',
        key: `v1:${due.length}:${String(first.id)}`,
      })) created++
    }
  } catch (e: any) {
    appLog.warn('notifier', '日志保留期扫描失败：' + (e?.message || e))
  }
  let resolved = 0
  for (const n of notifications.listNotifications()) {
    if (n.type === 'log-retention' && !pending) resolved += notifications.resolveNotifications('log-retention', n.sourceId)
  }
  return { created, resolved }
}

// ── 11. 问卷里有“反问”（这题问错了，要重出题）（2026-11-11）────────────────
// 反问（`kind='askback'`）不是答案，是“这题问错了，真问题在别处”。没人处理它就永远搁在那儿，
// 而依赖这条答案的规划/派工单一动不动 —— 所以它必须冒出来。
function scanDeckAskback(): { created: number; resolved: number } {
  let created = 0
  const decks = new Set<string>()
  try {
    for (const fn of fs.readdirSync(questionnaires.questionnaireDir()).filter((f) => f.endsWith('.answers.json'))) {
      const deck = fn.replace(/\.answers\.json$/, '')
      let a: any = {}
      try { a = JSON.parse(fs.readFileSync(path.join(questionnaires.questionnaireDir(), fn), 'utf-8')) } catch { continue }
      if (!a || a.voidedAt || a.archivedAt) continue
      const back = Object.keys(a.answers || {}).filter((q) => a.answers[q] && a.answers[q].kind === 'askback')
      if (!back.length) continue
      decks.add(deck)
      if (push({
        type: 'deck-askback', level: 'warning', osNotify: false,
        // 2026-11-24：反问 = “这题问错了，要重出题”，重出题是 agent 的活（qn_propose 在它手里）。
        // 用户能做的是“把它交给 AI”，所以归 agent。
        owner: 'agent',
        title: `问卷有反问待处理：${deck}`,
        body: `${back.length} 题被反问（${back.slice(0, 3).join(' / ')}）—— 到问卷页把「打包成补代价」复制给 agent 重出这几题`,
        sourceId: deck, key: `v1:${back.join(',')}`,
      })) created++
    }
  } catch (e: any) {
    appLog.warn('notifier', '反问扫描失败：' + (e?.message || e))
  }
  let resolved = 0
  for (const n of notifications.listNotifications()) {
    if (n.type === 'deck-askback' && !decks.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('deck-askback', n.sourceId)
    }
  }
  return { created, resolved }
}

// ── 12. 已批准的卷还没落成卡（2026-11-11）───────────────────────────────
// 批准 = 决策卡进了台账；但**决策要变成活**得靠卡。批准完 3 天还一条卡都没引用它，
// 说明这卷答案躺在库里没人用 —— 这正是“问卷答了很多但项目没动”的那种形态。
// 3 天是为了别在刚批准时催人。
const DECK_IDLE_DAYS = 3
function scanDeckUndelivered(): { created: number; resolved: number } {
  let created = 0
  const idle = new Set<string>()
  try {
    const cutoff = Date.now() - DECK_IDLE_DAYS * 86400000
    for (const fn of fs.readdirSync(questionnaires.questionnaireDir()).filter((f) => f.endsWith('.answers.json'))) {
      const deck = fn.replace(/\.answers\.json$/, '')
      let a: any = {}
      try { a = JSON.parse(fs.readFileSync(path.join(questionnaires.questionnaireDir(), fn), 'utf-8')) } catch { continue }
      if (!a || !a.approvedAt || a.voidedAt || a.archivedAt) continue
      const at = new Date(String(a.approvedAt)).getTime()
      if (!Number.isFinite(at) || at > cutoff) continue
      const hasDelivery = Object.keys(a.deliveries || {}).length > 0
      if (hasDelivery) continue
      idle.add(deck)
      if (push({
        type: 'deck-undelivered', level: 'info', osNotify: false,
        // 2026-11-24 暮雨：“本来就是 AI 自己的问题，要弹也是去弹给 AI 看”。
        // 「卷批准了没落卡」的下一步动作是**派一单让 AI 去落卡**，用户自己点不动 ——
        // 归 agent，默认不打扰人，但下次派单会带进任务书（contextPack §6b）。
        owner: 'agent',
        title: `卷已批准 ${Math.floor((Date.now() - at) / 86400000)} 天，还没有卡引用它`,
        body: `《${deck}》的答案已进决策台账，但没有一张卡带着它的验收线 —— 决策要变成活，得落成卡`,
        sourceId: deck, key: `v1:${String(a.approvedAt).slice(0, 10)}`,
      })) created++
    }
  } catch (e: any) {
    appLog.warn('notifier', '已批准未落卡扫描失败：' + (e?.message || e))
  }
  let resolved = 0
  for (const n of notifications.listNotifications()) {
    if (n.type === 'deck-undelivered' && !idle.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('deck-undelivered', n.sourceId)
    }
  }
  return { created, resolved }
}

// ── 13. 技能副本跟真源不一致（2026-11-11）───────────────────────────────
// `check-skills` 早就能判，但它只在“人跑脚本 / 打开设置页”时跑。技能是**给别的 agent 读的规矩**，
// 副本落后 = 别的 agent 按旧规矩干活，比没有技能更糟。
// 口径与设置页同一个函数（`checkSkillsStatus`），不另写一套 md5 比对。
function scanSkillDrift(): { created: number; resolved: number } {
  let created = 0
  let drifted = 0
  try {
    const targets = detectAgentTargets(skillInstaller.getHermesSkillsDirPath())
      .filter((t) => t.detected && t.mode === 'installable')
    const rows: { id: string; name: string; which: string[] }[] = []
    for (const t of targets) {
      try {
        const st = skillInstaller.checkSkillsStatus(t.id)
        const bad = (st.skills || []).filter((s) => s.installed && s.outdated)
        if (bad.length) rows.push({ id: t.id, name: t.name, which: bad.map((s) => s.name) })
      } catch { /* 单个目标读不出来不影响别的目标 */ }
    }
    drifted = rows.reduce((n, r) => n + r.which.length, 0)
    if (rows.length) {
      if (push({
        type: 'skill-drift', level: 'info', osNotify: false,
        // 2026-11-24：“重新安装技能副本”是纯机械动作，agent 跑一条命令就能做 —— 归 agent。
        owner: 'agent',
        title: `${drifted} 个技能副本跟真源不一致`,
        body: rows.map((r) => `${r.name}：${r.which.slice(0, 4).join('、')}`).join('；')
          + ' —— 到设置页 → 技能，点“重新安装”让别的 agent 读到的是新规矩',
        sourceId: 'skills',
        key: `v1:${rows.map((r) => r.id + ':' + r.which.join(',')).join('|')}`,
      })) created++
    }
  } catch (e: any) {
    appLog.warn('notifier', '技能副本漂移扫描失败：' + (e?.message || e))
  }
  let resolved = 0
  if (!drifted) {
    for (const n of notifications.listNotifications()) {
      if (n.type === 'skill-drift') resolved += notifications.resolveNotifications('skill-drift', n.sourceId)
    }
  }
  return { created, resolved }
}

// ── 9. 结构地图久未核实（2026-11-11）──────────────────────────────────────
// ⚠ 判据只用**文件里写着的「最后核实」日期**，**不做 git 比对**：那要逐个仓库起 git，
//   60 秒一次的扫描里太贵（而且会让主进程卡顿）。
//   所以文案必须诚实地说“很久没核实”，绝不能说“结构已经变了” —— 那是另一件事（drift），
//   它由结构地图页按需算，不给到这里替你下结论。
const STRUCTMAP_STALE_DAYS = 90
function scanStructMap(): { created: number; resolved: number } {
  let created = 0
  const staleIds = new Set<string>()
  try {
    const projects = (data.parseRegistry() as any[]) || []
    for (const p of projects) {
      const id = String(p?.id || '')
      if (!id) continue
      const map = String(policyStore.getPolicy(id)?.structureMap || '')
      const m = /最后核实[：:]\s*(\d{4})-(\d{2})-(\d{2})/.exec(map)
      if (!m) continue                       // 没写日期 = 还没填，由结构地图页自己说，不在这里刷
      const day = `${m[1]}-${m[2]}-${m[3]}`
      const at = new Date(`${day}T00:00:00`).getTime()
      if (!Number.isFinite(at)) continue
      const age = Math.floor((Date.now() - at) / 86400000)
      if (age < STRUCTMAP_STALE_DAYS) continue
      staleIds.add(id)
      if (push({
        type: 'structmap-stale', level: 'info', osNotify: false,
        title: `结构地图 ${age} 天没核实：${String(p?.name || id)}`,
        body: `最后核实 ${day}。地图过期的风险是“读者以为它是对的”—— 动手前先读一眼，改了就更新日期`,
        sourceId: id, key: `v1:${day}`,
      })) created++
    }
  } catch (e: any) {
    appLog.warn('notifier', '结构地图核实日期扫描失败：' + (e?.message || e))
  }
  let resolved = 0
  for (const n of notifications.listNotifications()) {
    if (n.type === 'structmap-stale' && !staleIds.has(n.sourceId ?? '')) {
      resolved += notifications.resolveNotifications('structmap-stale', n.sourceId)
    }
  }
  return { created, resolved }
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
      // P0-4（2026-10-01）：这里原本是 `catch {}` **静默吞异常** —— “扫描器停摆”和
      // “扫不到事件”在界面上长得一模一样，用户只能得出通知中心是坏的。落应用日志后
      // 照常继续（单次失败不致命），配合面板页脚的“上次扫描”相对时间即可判断是否停摆。
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
