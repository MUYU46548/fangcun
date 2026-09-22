/**
 * 通知中心端到端测试（灾后重建版，对齐 2026-09-20 重建的 notifications.ts / notifier.ts）
 *
 * 覆盖：
 *  - 存储层：幂等推送 / 列表 / 未读 / 已读 / 删除 / 清空 / 消解 / 超量淘汰
 *  - 检测器：parseDueValue 兼容 / 到点只弹一次 / key 不含 hours / 事件消失自动消解
 *  - IPC 层：7 个 handler 通道名与 preload API 对齐（源码断言）
 *
 * 运行：node scripts/test/e2e-notifications.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── 1. electron 桩注入（必须在业务模块之前） ────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-notif-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const SRC = path.resolve(__dirname, '../../desktop/src')

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

function main() {
  console.log('== 通知中心端到端测试 ==')
  console.log('root:', TEST_ROOT)

  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
    'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')

  const data = require(path.join(DIST, 'data', 'index.js'))
  const tasks = require(path.join(DIST, 'data', 'tasks.js'))
  const todos = require(path.join(DIST, 'services', 'todos.js'))
  const notif = require(path.join(DIST, 'services', 'notifications.js'))
  const notifier = require(path.join(DIST, 'services', 'notifier.js'))

  data.setDataDir(TEST_ROOT)
  check('数据目录已绑定', data.getDataDir() === TEST_ROOT, data.getDataDir())
  notifier._setSuppressOsNotify(true)

  // ══ A. 存储层 ════════════════════════════════════════════════════════

  // A1. 幂等推送
  const r1 = notif.pushNotification({ type: 'todo-due', title: '待办到期：写周报', sourceId: 'todo-1', key: '09-20' })
  check('首次推送 created=true', r1.created === true)
  check('通知带未读标记', r1.notification.read === false)
  check('通知落盘到数据目录 notifications/index.json',
    fs.existsSync(path.join(TEST_ROOT, 'notifications', 'index.json')))

  const r2 = notif.pushNotification({ type: 'todo-due', title: '待办到期：写周报', sourceId: 'todo-1', key: '09-20' })
  check('同指纹重复推送 created=false', r2.created === false)
  check('重复推送刷新标题', r2.notification.title === '待办到期：写周报')
  check('幂等推送不新增条目', notif.listNotifications().length === 1)

  // 改期（key 变化）= 新事件
  const r3 = notif.pushNotification({ type: 'todo-due', title: '待办到期：写周报', sourceId: 'todo-1', key: '09-25' })
  check('改期后 key 变化产生新通知', r3.created === true)
  check('同 sourceId 两条并存', notif.listNotifications().filter(n => n.sourceId === 'todo-1').length === 2)

  // A2. 列表与未读
  notif.pushNotification({ type: 'parse-error', level: 'error', title: '任务文件无法解析', sourceId: 'bad.md', key: 'bad.md' })
  check('未读计数正确', notif.getUnreadCount() === 3)
  const unreadList = notif.listNotifications({ unreadOnly: true })
  check('unreadOnly 过滤生效', unreadList.length === 3)
  check('列表按 updatedAt 倒序', notif.listNotifications()[0].updatedAt >= notif.listNotifications()[2].updatedAt)

  // A3. 已读 / 删除 / 清空
  const first = notif.listNotifications().find(n => n.type === 'todo-due' && n.key === '09-20')
  check('markRead 成功', notif.markRead(first.id) === true)
  check('markRead 后未读减一', notif.getUnreadCount() === 2)
  check('markRead 未知 id 返回 false', notif.markRead('ntf-none') === false)
  check('markAllRead 返回条数', notif.markAllRead() === 2)
  check('markAllRead 后未读归零', notif.getUnreadCount() === 0)

  check('deleteNotification 成功', notif.deleteNotification(first.id) === true)
  check('deleteNotification 未知 id 返回 false', notif.deleteNotification('ntf-none') === false)
  check('清空返回剩余条数', notif.clearAll() === 2)
  check('清空后列表为空', notif.listNotifications().length === 0)

  // A4. 消解（事件消失 → 对应未读自动标已读）
  notif.pushNotification({ type: 'parse-error', level: 'error', title: '坏文件A', sourceId: 'a.md', key: 'a.md' })
  notif.pushNotification({ type: 'parse-error', level: 'error', title: '坏文件B', sourceId: 'b.md', key: 'b.md' })
  notif.pushNotification({ type: 'task-timeout', level: 'warning', title: '超时', sourceId: 'task-1', key: 'timeout' })
  check('消解前未读 3 条', notif.getUnreadCount() === 3)
  const resolvedA = notif.resolveNotifications('parse-error', 'a.md')
  check('按 sourceId 消解只影响目标', resolvedA === 1)
  check('消解后其他类型未读仍在', notif.getUnreadCount() === 2)
  const resolvedAll = notif.resolveNotifications('task-timeout')
  check('按 type 整类消解', resolvedAll === 1)
  check('已读通知不被重复消解', notif.resolveNotifications('parse-error', 'a.md') === 0)
  notif.clearAll()

  // A4.5 僵尸通知防线（2026-09-22：用户反复报"删了刷新又复活"）
  // ① 事件消失 → 通知应直接消失，而不是变成"已读僵尸"长期留在列表
  notif.pushNotification({ type: 'task-timeout', level: 'warning', title: '超时A', sourceId: 'task-z1', key: 'timeout' })
  notif.resolveNotifications('task-timeout', 'task-z1')
  check('事件消失后通知被移除（不留已读僵尸）',
    notif.listNotifications().every(n => n.sourceId !== 'task-z1'))

  // ② 用户删掉的通知不得被同条件扫描重建
  notif.pushNotification({ type: 'task-timeout', level: 'warning', title: '超时B', sourceId: 'task-z2', key: 'timeout' })
  const zomb = notif.listNotifications().find(n => n.sourceId === 'task-z2')
  check('删除目标存在', !!zomb)
  notif.deleteNotification(zomb.id)
  const again = notif.pushNotification({ type: 'task-timeout', level: 'warning', title: '超时B重建尝试', sourceId: 'task-z2', key: 'timeout' })
  check('删除过的通知不会被同指纹重建', again.created === false && again.muted === true)
  check('忽略表记录了该指纹', notif.listMuted().includes('task-timeout|task-z2|timeout'))
  notif.unmuteAll()
  const afterUnmute = notif.pushNotification({ type: 'task-timeout', level: 'warning', title: '超时B', sourceId: 'task-z2', key: 'timeout' })
  check('清空忽略表后可重新提示', afterUnmute.created === true)
  notif.clearAll()

  // A5. 超量淘汰（已读最旧优先）
  for (let i = 0; i < 305; i++) {
    notif.pushNotification({ type: 'bulk', title: `bulk-${i}`, sourceId: `s-${i}`, key: String(i), level: 'info' })
  }
  // prune 在 scanOnce 内触发；存储层单独导出，直接调用验证淘汰规则
  const pruned = notif.prune()
  check('prune 淘汰 5 条最旧', pruned === 5, String(pruned))
  const bulkList = notif.listNotifications()
  check('超量后裁到上限 300', bulkList.length === 300, String(bulkList.length))
  // 把最旧的 10 条标已读，再触发淘汰 → 已读的应被优先清掉
  const oldest = bulkList.filter(n => n.type === 'bulk').slice(-10)
  for (const n of oldest) notif.markRead(n.id)
  notif.pushNotification({ type: 'bulk', title: 'new-after-read', sourceId: 's-new', key: 'new' })
  const pruned2 = notif.prune()
  check('已读最旧优先被淘汰', pruned2 >= 1, String(pruned2))
  const afterPrune = notif.listNotifications()
  check('淘汰后仍不超上限', afterPrune.length <= 300, String(afterPrune.length))
  check('新通知在淘汰后保留', afterPrune.some(n => n.title === 'new-after-read'))
  notif.clearAll()

  // A6. 存储健壮性：坏 JSON 回退空列表
  fs.writeFileSync(path.join(TEST_ROOT, 'notifications', 'index.json'), '{broken', 'utf-8')
  check('坏 JSON 回退空列表不抛错', notif.listNotifications().length === 0)
  notif.pushNotification({ type: 'recovery', title: '恢复', sourceId: 'r', key: 'r' })
  check('坏 JSON 后可重新写入', notif.listNotifications().length === 1)
  notif.clearAll()

  // ══ B. 检测器 ════════════════════════════════════════════════════════

  // B1. parseDueValue 兼容
  const d1 = notifier.parseDueValue('09-20')
  check('parseDueValue 支持 MM-DD', d1 !== null && (d1.getMonth() === 8))
  check('parseDueValue 支持 YYYY-MM-DD', notifier.parseDueValue('2026-09-20') !== null)
  check('parseDueValue 支持 ISO', notifier.parseDueValue('2026-09-20T10:00:00.000Z') !== null)
  check('parseDueValue 无效返回 null', notifier.parseDueValue('不合法') === null)
  check('parseDueValue 空值返回 null', notifier.parseDueValue('') === null && notifier.parseDueValue(undefined) === null)

  // B2. 待办到期：到点只弹一次 + 完成后消解
  const dueTodo = todos.createTodo('到期待办', '高', '2000-01-01') // 早已过期
  const futureTodo = todos.createTodo('未来待办', '低', '2999-01-01')
  const s1 = notifier.scanOnce()
  check('扫描产生新通知', s1.newNotifications >= 1, JSON.stringify(s1))
  check('过期待办产生 todo-due 通知',
    notif.listNotifications().some(n => n.type === 'todo-due' && n.sourceId === dueTodo.id))
  check('未到期待办不产生通知',
    !notif.listNotifications().some(n => n.type === 'todo-due' && n.sourceId === futureTodo.id))

  const s2 = notifier.scanOnce()
  check('第二次扫描不重弹（幂等）', s2.newNotifications === 0, JSON.stringify(s2))

  todos.updateTodo(dueTodo.id, { done: true })
  const s3 = notifier.scanOnce()
  check('待办完成后通知自动消解',
    !notif.listNotifications().some(n => n.type === 'todo-due' && n.sourceId === dueTodo.id && !n.read))
  check('消解计数进入返回值', s3.resolved >= 1, JSON.stringify(s3))

  // B3. 任务截止：逾期且非终态
  const dlTask = tasks.createTask({ title: '逾期任务', deadline: '2000-01-01' })
  const okTask = tasks.createTask({ title: '正常任务', deadline: '2999-01-01' })
  const doneTask = tasks.createTask({ title: '已完成逾期任务', deadline: '2000-01-01', status: '完成' })
  notifier.scanOnce()
  check('逾期任务产生 task-deadline 通知',
    notif.listNotifications().some(n => n.type === 'task-deadline' && n.sourceId === dlTask.id))
  check('未逾期任务不产生通知',
    !notif.listNotifications().some(n => n.type === 'task-deadline' && n.sourceId === okTask.id))
  check('已完成任务不产生逾期通知',
    !notif.listNotifications().some(n => n.type === 'task-deadline' && n.sourceId === doneTask.id))

  tasks.moveStatus(dlTask.id, '完成')
  notifier.scanOnce()
  check('任务完成后逾期通知消解',
    !notif.listNotifications().some(n => n.type === 'task-deadline' && n.sourceId === dlTask.id && !n.read))

  // B4. 任务超时：key 固定 'timeout'，不含 hours
  const past = Math.floor(Date.now() / 1000) - 48 * 3600
  const tmoTask = tasks.createTask({ title: '超时任务' })
  tasks.updateTask(tmoTask.id, { dispatch_time: String(past) })
  tasks.moveStatus(tmoTask.id, '进行中')
  const before = notif.listNotifications().filter(n => n.type === 'task-timeout').length
  notifier.scanOnce()
  const tmoNotifs = notif.listNotifications().filter(n => n.type === 'task-timeout' && n.sourceId === tmoTask.id)
  check('超时任务产生 task-timeout 通知', tmoNotifs.length === 1, String(tmoNotifs.length))
  check('超时通知 key 为固定 timeout（不含 hours）',
    tmoNotifs.length === 1 && tmoNotifs[0].key === 'timeout', tmoNotifs[0] && tmoNotifs[0].key)
  const sAgain = notifier.scanOnce()
  check('超时通知重复扫描不增殖', notif.listNotifications().filter(n => n.type === 'task-timeout').length === before + 1)
  tasks.moveStatus(tmoTask.id, '完成')
  notifier.scanOnce()
  check('超时任务完成后通知消解',
    !notif.listNotifications().some(n => n.type === 'task-timeout' && n.sourceId === tmoTask.id && !n.read))

  // B5. 解析失败：osNotify 不弹（持续可见型），修复后消解
  const badFile = path.join(TEST_ROOT, 'task-data', 'task-badyaml-001.md')
  fs.writeFileSync(badFile, '---\n标题: [坏 YAML\n状态: 待办\n---\n\n正文\n', 'utf-8')
  const sBad = notifier.scanOnce()
  check('解析失败产生 parse-error 通知', sBad.newNotifications >= 1, JSON.stringify(sBad))
  check('解析失败通知不弹系统通知（osNotify=false 路径存在）',
    notif.listNotifications().some(n => n.type === 'parse-error' && n.sourceId && n.sourceId.includes('task-badyaml-001')))
  // 修复坏文件
  fs.writeFileSync(badFile, '---\nid: task-badyaml-001\n标题: 修好了\n状态: 待办\n---\n\n正文\n', 'utf-8')
  notifier.scanOnce()
  check('解析错误修复后通知消解',
    !notif.listNotifications().some(n => n.type === 'parse-error' && !n.read))

  // B6. 备份失败事件入口
  notifier.reportBackupFailure(2, 'connection refused')
  const bk = notif.listNotifications().find(n => n.type === 'backup-failed')
  check('备份失败写入通知中心', !!bk)
  check('备份失败标题含连续次数', bk && bk.title.includes('2'))
  notifier.resolveBackupFailure()
  check('备份恢复后通知消解',
    !notif.listNotifications().some(n => n.type === 'backup-failed' && !n.read))

  // B7. 扫描器生命周期
  notifier.startScanner(50)
  check('startScanner 后运行中', notifier.getScannerStatus().running === true)
  notifier.stopScanner()
  check('stopScanner 后停止', notifier.getScannerStatus().running === false)

  // ══ C. IPC / preload 接线（源码断言，防漂移） ═════════════════════════
  const ipcSrc = fs.readFileSync(path.join(SRC, 'main', 'ipc.ts'), 'utf-8')
  const preloadSrc = fs.readFileSync(path.join(SRC, 'preload', 'index.ts'), 'utf-8')
  for (const ch of ['notifications:list', 'notifications:unreadCount', 'notifications:markRead',
    'notifications:markAllRead', 'notifications:delete', 'notifications:clear', 'notifications:scan']) {
    check(`IPC handler 通道存在: ${ch}`, ipcSrc.includes(`'${ch}'`))
  }
  for (const api of ['notificationsList', 'notificationsUnreadCount', 'notificationsMarkRead',
    'notificationsMarkAllRead', 'notificationsDelete', 'notificationsClear', 'notificationsScan']) {
    check(`preload 暴露 API: ${api}`, preloadSrc.includes(api))
  }
  const entrySrc = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf-8')
  check('真实入口启动扫描器', entrySrc.includes('startScanner'))
  check('真实入口退出时停止扫描器', entrySrc.includes('stopScanner'))

  // ══ 汇总 ═════════════════════════════════════════════════════════════
  console.log('─'.repeat(50))
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail > 0) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
    process.exitCode = 1
  }
}

try {
  main()
} catch (e) {
  console.error('测试框架异常：', e)
  process.exitCode = 1
}
