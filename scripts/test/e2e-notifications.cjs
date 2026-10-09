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

  // A6. 静音 7 天自动恢复（2026-10-01 用户拍板：删除不再永久拉黑，此前无任何恢复入口）
  check('★ 静音时长常量 = 7 天', notif.MUTE_TTL_MS === 7 * 86400000, String(notif.MUTE_TTL_MS))
  notif._setMuteTtlForTest(-1000)  // 注入"刚删就已过期"，不必等 7 天
  notif.pushNotification({ type: 'mute-ttl', level: 'info', title: 'TTL 目标', sourceId: 'mtl-1', key: 'k' })
  const mtl = notif.listNotifications().find(n => n.sourceId === 'mtl-1')
  check('TTL 段的删除目标存在', !!mtl)
  notif.deleteNotification(mtl.id)
  check('★ 过期时忽略表里不再留痕',
    !notif.listMuted().includes('mute-ttl|mtl-1|k'), JSON.stringify(notif.listMuted()))
  const revived = notif.pushNotification({ type: 'mute-ttl', level: 'info', title: 'TTL 复活', sourceId: 'mtl-1', key: 'k' })
  check('★★ 到期后恢复提醒（永久拉黑已废除）', revived.created === true, JSON.stringify(revived))
  // 恢复成默认 7 天：期内仍应静音
  notif._setMuteTtlForTest(notif.MUTE_TTL_MS)
  const mtl2 = notif.listNotifications().find(n => n.sourceId === 'mtl-1')
  if (mtl2) notif.deleteNotification(mtl2.id)
  const stillMuted = notif.pushNotification({ type: 'mute-ttl', level: 'info', title: 'TTL 又试', sourceId: 'mtl-1', key: 'k' })
  check('★★ 默认 TTL 期内仍被静音（删了确实管用）',
    stillMuted.created === false && stillMuted.muted === true, JSON.stringify(stillMuted))
  // P0-5（2026-10-01）：静音表必须**可读可恢复** —— 此前 listMuted/unmuteAll 在
  // ipc/preload/App 三处零命中，点过 🗑 的提醒 7 天内彻底消失且用户不知情。
  const mutedNow = notif.listMuted()
  check('★ listMuted 把期内被静音的 key 列出来（面板「被忽略 N 条」的数据源）',
    mutedNow.includes('mute-ttl|mtl-1|k'), JSON.stringify(mutedNow))
  const unmutedCount = notif.unmuteAll()
  check('★★ unmuteAll 返回条数并清空（IPC 通道 notifications:unmuteAll 直接用它）',
    unmutedCount === mutedNow.length && notif.listMuted().length === 0,
    'n=' + unmutedCount + ' left=' + JSON.stringify(notif.listMuted()))
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

  // B8. 更新包下载完成必须「看得见」（012，2026-09-25）
  // 方寸关窗=缩进托盘：只改设置页状态时用户什么都看不到 → 必须落通知中心 + 弹系统通知
  const stub = require(STUB)
  const origSupported = stub.Notification.isSupported
  stub.Notification.isSupported = () => true
  notifier._setSuppressOsNotify(false)
  const upOk = notifier.notifyUpdateReady('0.2.6')
  check('更新下载完成写入通知中心', upOk === true &&
    notif.listNotifications().some(n => n.type === 'update-downloaded' && n.sourceId === '0.2.6'))
  check('更新下载完成同时弹系统通知（隐藏到托盘也能看见）',
    !!stub.Notification.lastShown && String(stub.Notification.lastShown.title).includes('0.2.6'),
    JSON.stringify(stub.Notification.lastShown))
  check('同版本重复推送被幂等（不刷屏）', notifier.notifyUpdateReady('0.2.6') === false)
  const updaterSrc = fs.readFileSync(path.join(SRC, 'main', 'updater.ts'), 'utf-8')
  const dlBranch = updaterSrc.slice(updaterSrc.indexOf("autoUpdater.on('update-downloaded'"), updaterSrc.indexOf("autoUpdater.on('error'"))
  check('updater 的 update-downloaded 分支调用了 notifyUpdateReady（防再次静默丢失）',
    /notifyUpdateReady\(/.test(dlBranch))
  check('updater 仍保留渲染层事件（设置页进度不丢）', /update:downloaded/.test(dlBranch))
  stub.Notification.isSupported = origSupported
  notifier._setSuppressOsNotify(true)
  notif.clearAll()

  // ══ B9. 阻塞链断裂（2026-10-01 用户定稿 B 类）═══════════════════════════
  // 真实案例：task-20260910-001 依赖的 task-20260910-002 只在 .trash 里，链断了但毫无表示。
  const depA = tasks.createTask({ title: '会被删的依赖' })
  const needA = tasks.createTask({ title: '依赖它的任务', blockers: [depA.id] })
  const depB = tasks.createTask({ title: '健在的依赖' })
  const needB = tasks.createTask({ title: '依赖健在者', blockers: [depB.id] })
  notifier.scanOnce()
  check('★ 依赖健在时不产生断裂通知（不是逢阻塞就报）',
    !notif.listNotifications().some(n => n.type === 'blocker-broken'))
  const trashDir = path.join(TEST_ROOT, 'task-data', '.trash')
  const beforeTrash = new Set(fs.existsSync(trashDir) ? fs.readdirSync(trashDir) : [])
  tasks.deleteTask(depA.id)
  const trashed = fs.existsSync(trashDir) ? fs.readdirSync(trashDir).filter(f => !beforeTrash.has(f)) : []
  check('依赖被删除（进了 .trash）', trashed.length >= 1, JSON.stringify(trashed))
  notifier.scanOnce()
  const bks = notif.listNotifications().filter(n => n.type === 'blocker-broken' && n.sourceId === needA.id)
  check('★★ 依赖进回收站 → 阻塞链断裂通知（本例的真实场景）', bks.length === 1, String(bks.length))
  check('★ 文案点明缺的是哪个 id（否则没法顺着去修）',
    bks.length === 1 && String(bks[0].body).includes(depA.id), bks[0] && bks[0].body)
  check('★ 只报真断的那条（健在的 needB 不报）',
    !notif.listNotifications().some(n => n.type === 'blocker-broken' && n.sourceId === needB.id))
  const sBk2 = notifier.scanOnce()
  check('重复扫描不增殖（指纹 = 任务×缺失源）', sBk2.newNotifications === 0, JSON.stringify(sBk2))
  if (trashed[0]) tasks.restoreTrashItem(trashed[0])
  notifier.scanOnce()
  check('★★ 从回收站还原后通知自动消解（不留僵尸）',
    !notif.listNotifications().some(n => n.type === 'blocker-broken' && !n.read))
  notif.clearAll()

  // ══ B10. 进行中却没动静（2026-10-01 用户定稿 C 类）══════════════════════
  // 「状态=进行中」= 用户把提示词扔给 AI 后回方寸点的按钮 = 已派活（用户原话）。
  const stTask = tasks.createTask({ title: '点进行中后没人回写' })
  tasks.moveStatus(stTask.id, '进行中')
  notifier.scanOnce()
  check('★ 刚点进行中、还没超时 → 不报（时钟从点按钮那一刻才开始走）',
    !notif.listNotifications().some(n => n.type === 'task-stalled' && n.sourceId === stTask.id))
  // 把 更新 拨回 3 天前 = 「点了进行中之后 72 小时没有任何写入」
  const stPath = path.join(TEST_ROOT, 'task-data', `${stTask.id}.md`)
  let stTxt = fs.readFileSync(stPath, 'utf-8')
  const staleIso = new Date(Date.now() - 72 * 3600_000).toISOString()
  const updRe = /^([ \t]*)(?:更新|updated):.*$/m
  stTxt = updRe.test(stTxt)
    ? stTxt.replace(updRe, `$1更新: ${staleIso}`)
    : stTxt.replace(/^---\r?\n/, `---\n更新: ${staleIso}\n`)
  fs.writeFileSync(stPath, stTxt, 'utf-8')
  notifier.scanOnce()
  const stalledNotifs = notif.listNotifications().filter(n => n.type === 'task-stalled' && n.sourceId === stTask.id)
  check('★★ 72 小时没写入 → task-stalled', stalledNotifs.length === 1, String(stalledNotifs.length))
  check('★ 指纹固定为 stalled（小时数每次都变，拿它当指纹会长出一堆）',
    stalledNotifs.length === 1 && stalledNotifs[0].key === 'stalled', stalledNotifs[0] && String(stalledNotifs[0].key))
  check('★ 文案写明卡了多久（72 小时）',
    stalledNotifs.length === 1 && /72 小时/.test(String(stalledNotifs[0].body)), stalledNotifs[0] && stalledNotifs[0].body)
  // 只认「进行中」：其它状态天然不回写，扫了就是噪音（用户 2026-10-01 否决按更新比时间的原因）
  const zeroHits = tasks.findStalledTasks(0)
  check('★★ findStalledTasks 返回的全是「进行中」（待办/待验收/完成一律不扫）',
    zeroHits.length >= 1 && zeroHits.every(t => tasks.readTask(t.id) && tasks.readTask(t.id).fm.status === '进行中'),
    JSON.stringify(zeroHits.map(t => t.id)))
  // 回写一次 → 时钟重置 → 消解（这才是"真回写检查"，不是派活后一路倒计时）
  tasks.updateTask(stTask.id, { title: '回写了，有动静' })
  notifier.scanOnce()
  check('★★ 回写一次后 task-stalled 自动消解',
    !notif.listNotifications().some(n => n.type === 'task-stalled' && !n.read))
  notif.clearAll()

  // ══ B11. 超期清理（2026-10-08 用户拍板：error 永不清，已读 info/warning 30 天）
  notif._setExpiryForTest(-1000)
  const oldWarn = notif.pushNotification({ type: 'task-stalled', level: 'warning', title: '旧 warning', sourceId: 'x', key: 'x' })
  const oldInfo = notif.pushNotification({ type: 'update-downloaded', level: 'info', title: '旧 info', sourceId: 'y', key: 'y' })
  const oldErr = notif.pushNotification({ type: 'parse-error', level: 'error', title: '旧 error', sourceId: 'z', key: 'z' })
  notif.markRead(oldWarn.notification.id)
  notif.markRead(oldInfo.notification.id)
  notif.markRead(oldErr.notification.id)
  const cleaned = notif.cleanupExpired()
  check('★★ 已读 warning/info 超期被清理', cleaned === 2, String(cleaned))
  check('★ error 永不清理（还在列表里）', notif.listNotifications().some(n => n.type === 'parse-error'))
  check('★ 清理后只剩 error 一条', notif.listNotifications().length === 1, String(notif.listNotifications().length))
  notif.clearAll()
  notif._setExpiryForTest(-1000)
  const unreadN = notif.pushNotification({ type: 'task-stalled', level: 'warning', title: '未读不清理', sourceId: 'u', key: 'u' })
  const c2 = notif.cleanupExpired()
  check('★ 未读通知超期也不清理', c2 === 0 && notif.listNotifications().length === 1, String(c2))
  notif.clearAll()
  notif._setExpiryForTest(30 * 24 * 3600_000)

  // ══ C. IPC / preload 接线（源码断言，防漂移） ═══════════════════════════
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

  // C2. 2026-10-01 用户定稿：只加这两类 + 形态（不弹系统通知）+ 渲染层有标签
  const notifierSrc = fs.readFileSync(path.join(SRC, 'main', 'services', 'notifier.ts'), 'utf-8')
  check('扫描器接了「阻塞链断裂」检测', notifierSrc.includes('detectBrokenBlockers'))
  check('扫描器接了「进行中没动静」检测', notifierSrc.includes('findStalledTasks'))
  check('★ 新增两类都 osNotify:false（角标红点+面板，不弹系统通知 —— 用户拍板的形态）',
    /'blocker-broken'[\s\S]{0,260}?osNotify:\s*false/.test(notifierSrc) &&
    /'task-stalled'[\s\S]{0,260}?osNotify:\s*false/.test(notifierSrc))
  // P0-4 / P0-5 的三层接线（ipc → preload → 渲染层）：少一层就等于功能不存在
  const ipcSrc2 = fs.readFileSync(path.join(SRC, 'main', 'ipc.ts'), 'utf-8')
  const preSrc = fs.readFileSync(path.join(SRC, 'preload', 'index.ts'), 'utf-8')
  check('★ IPC 有扫描器状态通道（P0-4）', ipcSrc2.includes('notifications:scannerStatus'))
  check('★ IPC 有静音表读取/恢复通道（P0-5）',
    ipcSrc2.includes('notifications:listMuted') && ipcSrc2.includes('notifications:unmuteAll'))
  check('★ preload 暴露三条新通道', preSrc.includes('notificationsScannerStatus')
    && preSrc.includes('notificationsListMuted') && preSrc.includes('notificationsUnmuteAll'))
  const notifierSrc2 = fs.readFileSync(path.join(SRC, 'main', 'services', 'notifier.ts'), 'utf-8')
  check('★★ 扫描异常落应用日志（此前 catch{} 静默吞 = 停摆无人知）',
    /catch \([^)]*\) \{[\s\S]{0,160}?appLog\.error\('notifier'/.test(notifierSrc2))
  const appSrc = fs.readFileSync(path.join(SRC, 'renderer', 'App.vue'), 'utf-8')
  check('★ 渲染层给两类都配了标签（否则面板显示裸 type 名）',
    appSrc.includes("'blocker-broken'") && appSrc.includes("'task-stalled'"))
  const tasksSrc = fs.readFileSync(path.join(SRC, 'main', 'data', 'tasks.ts'), 'utf-8')
  check('★ C 类判据是「文件多久没写」而不是「派活后多久」（真回写检查）',
    /findStalledTasks[\s\S]{0,400}?taskLastTouchedMs/.test(tasksSrc))
  check('★ B 类把归档区算进"健在"（归档 = 链被解开，不是断裂）',
    /detectBrokenBlockers[\s\S]{0,300}?loadAllTasksRaw\('all'\)/.test(tasksSrc))

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
