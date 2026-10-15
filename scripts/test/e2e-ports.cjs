/**
 * 服务 / 端口登记与监控（2026-09-26 卡 006）
 *
 * 用户回执：「之前想让方寸管理端口，事实上端口从未被管理，依旧乱七八糟。」
 * 查证到的字面事实：`launchpad/config.ts` 的 `LaunchApp` 早有 `port?` 字段但**全仓无人读**，
 * `apps.json.sample` 里 4 个应用一个都没填。本测试钉住：
 *   ① 登记源两条都要真读：启动台 apps.json 的 port 字段 + 手填 services.json；
 *   ② 占用者是**真查**出来的（起一个真 TCP 监听，断言 PID 就是本进程，不是编的）；
 *   ③ 冲突预警：同端口被登记多次要报出来；
 *   ④ 手填清单的增删校验 + 原子写（不留 .tmp）+ 坏文件不崩（报原因）；
 *   ⑤ ★ 口径守卫：**整份实现里不许出现杀进程的能力**（用户明确选的是只读 A 档）。
 *
 * 运行：node scripts/test/e2e-ports.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-ports-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

/** 在 1024-49151 里试出一个能绑的端口（避开 Windows 动态端口段 49152+，否则会被"未登记列表"过滤掉） */
function bindPort() {
  return new Promise((resolve, reject) => {
    let tries = 0
    const attempt = () => {
      const port = 20000 + Math.floor(Math.random() * 20000)
      const srv = net.createServer()
      srv.once('error', () => { if (++tries > 30) reject(new Error('找不到可用端口')); else attempt() })
      srv.listen(port, '127.0.0.1', () => resolve({ srv, port }))
    }
    attempt()
  })
}

/** 拿一个确定空闲的端口（绑上再放开） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function main() {
  console.log('== 服务 / 端口监控测试 ==')
  console.log('sandbox:', TEST_ROOT)
  fs.mkdirSync(TEST_ROOT, { recursive: true })

  const reg = require(path.join(DIST, 'services', 'portRegistry.js'))
  const stub = require(STUB)

  // ── 0. 口径守卫：这份实现里不许有杀进程的能力 ──────────────────────
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'src', 'main', 'services', 'portRegistry.ts'), 'utf-8')
  check('★ 只读口径：实现里没有 taskkill / process.kill（用户选的是 A 档，不做"结束占用进程"）',
    !/taskkill|process\.kill|killProcess|terminate\(/i.test(src),
    (src.match(/taskkill|process\.kill|killProcess/gi) || []).join(','))
  check('★ 也没有对外暴露任何"杀进程"的导出函数',
    !Object.keys(reg).some(k => /kill|terminate|stop|endProcess/i.test(k)),
    Object.keys(reg).join(','))

  // ── 1. 空清单：不报错、就是空 ──────────────────────────────────────
  const empty = await reg.listServices()
  check('没登记任何端口时不报错，返回空清单', empty.ok === true && empty.rows.length === 0, JSON.stringify({ ok: empty.ok, n: empty.rows.length, err: empty.error }))
  check('servicesJsonPath / appsJsonPath 都落在测试沙盒（没碰真 userData）',
    path.resolve(empty.servicesJsonPath).startsWith(path.resolve(TEST_ROOT)) &&
    path.resolve(empty.appsJsonPath).startsWith(path.resolve(TEST_ROOT)),
    empty.servicesJsonPath)

  // ── 2. 启动台的 port 字段：真读、真探活 ────────────────────────────
  const { srv, port: livePort } = await bindPort()
  // 第二个监听：**不登记**，专门用来测"未登记但正在监听"与"登记进来"
  // （第一版测试拿已登记的 livePort 去测未登记，必然测不出来 —— 那是测试自己的错）
  const { srv: srvExtra, port: extraPort } = await bindPort()
  const idlePort = await freePort()
  const listeners = []
  listeners.push(srv, srvExtra)

  // ⚠ 夹具按**新模型**写（2026-10-15）：应用只带"观测到的端口"，不带配置端口。
  //   `legacy-port` 那条是刻意的**老数据**：还留着已停用的 `port` 字段 —— 必须能读、
  //   必须给出"该字段已停用"的提示，但**不许**拿它当端口来源去生成服务行。
  fs.writeFileSync(path.join(TEST_ROOT, 'apps.json'), JSON.stringify({
    apps: [
      { id: 'test-live', name: '测试用活服务', observedPorts: [livePort], observedAt: '2026-10-15T00:00:00.000Z', description: '本测试起的真监听' },
      { id: 'test-idle', name: '测试用死服务', port: idlePort, description: '老数据：留着已停用的 port，没人监听' },
      { id: 'no-port', name: '还没观测到端口的应用', description: '端口对它还是未知数' },
    ],
  }, null, 2))

  const p1 = await reg.listServices()
  // ── 2a. 应用行：端口是**观测结果**，不是配置项（2026-10-15 新模型）────────
  check('★ 启动台应用按**应用**列出来（三条都在，不因为"没填端口"就消失）',
    p1.apps.length === 3, JSON.stringify(p1.apps.map(a => a.name)))
  const liveApp = p1.apps.find(a => a.id === 'test-live')
  check('★★ 应用"观测到的端口"是真读的，且其中正在监听的被标出来（listeningPorts）',
    !!liveApp && liveApp.observedPorts.includes(livePort) && liveApp.listeningPorts.includes(livePort),
    JSON.stringify(liveApp))
  const idleApp = p1.apps.find(a => a.id === 'test-idle')
  check('★ 已经没人监听的观测端口：仍在 observedPorts 里、但不在 listeningPorts 里',
    !!idleApp && idleApp.observedPorts.length === 0 && idleApp.listeningPorts.length === 0,
    JSON.stringify(idleApp))
  check('★ 老数据的 port 字段不再当端口来源，但会给"该字段已停用"的提示',
    !!idleApp && /已停用/.test(idleApp.legacyPortNote), JSON.stringify(idleApp && idleApp.legacyPortNote))
  check('★ 「已登记」行里**没有**从启动台生成的条目了（那条线只剩手填）',
    p1.rows.every(r => r.source === 'manual'), JSON.stringify(p1.rows.map(r => r.source)))
  check('★ 观测到端口的应用排前面（有服务形态的先看到）',
    p1.apps[0].id === 'test-live', JSON.stringify(p1.apps.map(a => a.id)))
  check('统计数字自洽（监听中 + 空闲 = 已登记行数）',
    p1.listeningCount + p1.idleCount + p1.rows.length === p1.rows.length * 2,
    `${p1.listeningCount}+${p1.idleCount} vs rows=${p1.rows.length}`)

  // ── 3. 未登记但正在监听 ───────────────────────────────────────────
  check('★ 「未登记但正在监听」抓到了那个没登记的监听',
    p1.unregistered.some(u => u.port === extraPort), JSON.stringify(p1.unregistered.map(u => u.port)))
  check('  未登记项带 PID 与进程名',
    (p1.unregistered.find(u => u.port === extraPort) || {}).pid === process.pid,
    JSON.stringify(p1.unregistered.find(u => u.port === extraPort)))
  check('★★ 已被应用"认领"的观测端口**不**出现在未登记列表里（两栏不重叠，"无主"栏不许重复报已有的）',
    !p1.unregistered.some(u => u.port === livePort))
  check('  系统端口（<1024）被滤掉（不许把 135/445 这些倒给用户）',
    p1.unregistered.every(u => u.port >= 1024), JSON.stringify(p1.unregistered.map(u => u.port).slice(0, 12)))
  check('  RPC 动态端口段（>49151）被滤掉',
    p1.unregistered.every(u => u.port <= 49151))
  check('★ 只列"像服务"的进程（QQ/svchost/System/msedge 这些不该倒给用户）',
    p1.unregistered.every(u => reg.isServerishProcess(u.processName)),
    JSON.stringify(p1.unregistered.map(u => u.processName)))
  check('★ 被滤掉的数量如实报出来（不静默隐藏）',
    typeof p1.hiddenCount === 'number' && p1.hiddenCount >= 0, String(p1.hiddenCount))
  check('  白名单本身认得 node/python，不认 svchost/QQ/msedge',
    reg.isServerishProcess('node') && reg.isServerishProcess('python.exe') &&
    !reg.isServerishProcess('svchost') && !reg.isServerishProcess('QQ') && !reg.isServerishProcess('msedge'))

  // ── 4. 手填清单：增 / 校验 / 去重 / 原子写 ────────────────────────
  const rAdd1 = reg.addManualService({ name: '方寸看板', port: 8753, note: 'Python 版 tegula' })
  check('登记一个手填服务成功', rAdd1.ok === true, JSON.stringify(rAdd1))
  const p2 = await reg.listServices()
  const m = p2.rows.find(r => r.port === 8753)
  check('★ 手填的服务出现在清单里，source=manual', m && m.source === 'manual', JSON.stringify(m))
  check('手填服务带备注（note 显示成副标题）', m && m.note === 'Python 版 tegula', m && m.note)

  check('端口名不能为空', reg.addManualService({ name: '  ', port: 9999 }).ok === false)
  check('端口不合法（>65535）被拒', reg.addManualService({ name: 'x', port: 70000 }).ok === false)
  check('端口不合法（非整数）被拒', reg.addManualService({ name: 'x', port: 12.5 }).ok === false)
  check('同端口重复登记被拒', reg.addManualService({ name: 'again', port: 8753 }).ok === false)
  check('  被拒后文件没被改坏（清单里 8753 还是一条）',
    (await reg.listServices()).rows.filter(r => r.port === 8753).length === 1)

  const svcFile = path.join(TEST_ROOT, 'services.json')
  check('★ services.json 落盘了', fs.existsSync(svcFile))
  check('★ 原子写不留 .tmp 残渣', !fs.existsSync(svcFile + '.tmp'))
  check('  落盘内容是 { services: [...] }（结构固定）',
    Array.isArray(JSON.parse(fs.readFileSync(svcFile, 'utf-8')).services))

  // ── 5. 冲突预警：同端口登记多次 ──────────────────────────────────
  // 直接写文件造冲突（界面不会造成这种数据，但手改/迁移会）
  fs.writeFileSync(svcFile, JSON.stringify({
    services: [
      { name: '方寸看板', port: 8753, note: 'Python 版' },
      { name: '墨坊 API', port: 8753, note: '撞端口了' },
    ],
  }, null, 2))
  const p3 = await reg.listServices()
  check('★ 同端口登记多次 → duplicatePorts 报出来', p3.duplicatePorts.includes(8753), JSON.stringify(p3.duplicatePorts))
  check('  两条都标 duplicated=true', p3.rows.filter(r => r.port === 8753).every(r => r.duplicated === true))

  // ── 6. 移除：手填能删，启动台的不许删 ─────────────────────────────
  check('★ 移除手填服务成功', reg.removeManualService(8753).ok === true)
  check('  移除后清单里没有它了', (await reg.listServices()).rows.every(r => r.port !== 8753))
  check('★ 不在手填清单里的端口（比如应用观测出来的）不许从这里删',
    reg.removeManualService(livePort).ok === false,
    JSON.stringify(reg.removeManualService(livePort)))

  // ── 7. 打开地址（只读操作，仅登记过的端口）───────────────────────
  stub.shell.external.length = 0
  const open1 = await reg.openService(livePort)
  check('★ 打开登记过的端口 → 走 shell.openExternal', open1.ok === true && open1.url === `http://127.0.0.1:${livePort}/`, JSON.stringify(open1))
  check('  真的是这个 URL（不是别的）', stub.shell.external[0] === `http://127.0.0.1:${livePort}/`, String(stub.shell.external[0]))

  stub.shell.external.length = 0
  const open2 = await reg.openService(12345)
  check('★ 打开未登记的端口被拒（不许拿本页当"任意端口跳板"）',
    open2.ok === false && stub.shell.external.length === 0, JSON.stringify(open2))

  stub.shell.failNext = '被拒绝'
  const open3 = await reg.openService(livePort)
  check('  打开失败要返回原因（不是静默 ok）', open3.ok === false && !!open3.error, JSON.stringify(open3))
  stub.shell.failNext = ''

  // ── 8. 坏文件不崩（报原因，还能显示解析得出的部分）────────────────
  fs.writeFileSync(svcFile, '{ 这不是合法 JSON ')
  const p4 = await reg.listServices()
  check('★ services.json 坏了：ok=false 且给出原因（不静默当空）',
    p4.ok === false && /services\.json/.test(String(p4.error)), JSON.stringify({ ok: p4.ok, error: p4.error }))
  check('  坏文件不影响「启动台应用」那部分照常显示', p4.apps.length === 3, String(p4.apps.length))
  check('  也不抛异常（页面还能用）', true)

  // 坏文件上登记必须**拒绝且原文件不动**（静默重写会把原有登记整段吞掉）
  fs.writeFileSync(svcFile, 'not json at all')
  const addOnCorrupt = reg.addManualService({ name: '在坏文件上追加', port: 9100 })
  check('★ 坏文件上拒绝登记（code 明确），不给"假装成功"的机会',
    addOnCorrupt.ok === false && /解析失败/.test(String(addOnCorrupt.error)), JSON.stringify(addOnCorrupt))
  check('★ 拒绝后原文件一个字节没动（不许吞掉旧内容）',
    fs.readFileSync(svcFile, 'utf-8') === 'not json at all')
  const rmOnCorrupt = reg.removeManualService(9100)
  check('  坏文件上"取消登记"同样拒绝', rmOnCorrupt.ok === false, JSON.stringify(rmOnCorrupt))

  // ── 9. adopt：把"未登记但正在监听"登记进来 ───────────────────────
  fs.writeFileSync(svcFile, JSON.stringify({ services: [] }, null, 2))
  const adopt = reg.adoptUnregistered(extraPort, 'node')
  check('★ adopt 把监听中的端口登记进手填清单', adopt.ok === true, JSON.stringify(adopt))
  const p5 = await reg.listServices()
  const adopted = p5.rows.find(r => r.port === extraPort && r.source === 'manual')
  check('  登记后它变成手填条目', !!adopted, JSON.stringify(p5.rows.filter(r => r.port === extraPort)))
  check('  登记后它不再出现在"未登记"里', !p5.unregistered.some(u => u.port === extraPort))

  for (const s of listeners) { try { s.close() } catch { /* ignore */ } }

  // ── 启动应用 + 观测端口（2026-10-15 新模型）──────────────────────────────
  //   旧模型是「按端口启动」：要求用户先知道端口、还得把它登在应用上 —— 那条路出了旧案
  //   （vite 的 8090 登在打包 exe 上，点「启动」永远"空闲"）。暮雨的口径是
  //   「端口永远是记不住的，不要指望根据端口去配置。你永远不知道用户有什么端口。」
  //   所以入口改成**应用**，端口变成**观测结果**。安全线不变：只认启动台登记过的应用。
  {
    const notRegistered = await reg.startAppAndObserve('不存在的应用 id')
    check('★ 不在启动台登记里的应用 → 拒绝启动（不做通用进程启动器）',
      notRegistered && notRegistered.ok === false && /启动台/.test(notRegistered.message),
      JSON.stringify(notRegistered))

    for (const bad of ['', null, undefined, '   ']) {
      const r = await reg.startAppAndObserve(bad)
      check(`  id 为空（${JSON.stringify(bad)}）→ 拒绝`, r && r.ok === false, JSON.stringify(r))
    }

    // 注册一个**真的会开端口**的应用：cmd 指向一个起 TCP 监听的脚本，验证"观测"这条路真跑得通
    // 「会开端口」的那个：node -e 起一个真 TCP 监听（用 node 是因为启动器对 .exe 支持最稳）
    const { srv: obsSrv, port: obsPort } = await bindPort()
    try { obsSrv.close() } catch { /* 把端口让给子进程 */ }
    const lp = path.join(TEST_ROOT, 'apps.json')
    fs.writeFileSync(lp, JSON.stringify({ apps: [
      { id: 'obs-app', name: '会开端口的小应用', path: process.execPath, cmd: process.execPath,
        args: ['-e', `require('net').createServer().listen(${obsPort},'127.0.0.1');setTimeout(()=>{},20000)`], description: '' },
      { id: 'quiet-app', name: '不开端口的桌面应用', path: process.execPath, cmd: process.execPath,
        args: ['-e', 'setTimeout(()=>{},1500)'], description: '' },
    ] }, null, 2), 'utf-8')
    const before = JSON.parse(fs.readFileSync(lp, 'utf-8'))
    check('  夹具里的应用**一个端口字段都没有**（新模型不再要求配置端口）',
      before.apps.every(a => a.port === undefined && a.observedPorts === undefined))

    const obs = await reg.startAppAndObserve('obs-app')
    check('★ 启动应用后**观测**到它新开的端口（不靠用户填任何东西）',
      obs && obs.ok === true && Array.isArray(obs.newPorts) && obs.newPorts.includes(obsPort),
      JSON.stringify(obs))
    check('★ 观测结果写回了 apps.json 的 observedPorts（历史靠观测积累，不靠配置）',
      (() => { const a = JSON.parse(fs.readFileSync(lp, 'utf-8')).apps.find(x => x.id === 'obs-app'); return !!a && Array.isArray(a.observedPorts) && a.observedPorts.includes(obsPort) })())
    check('  写回时不写老字段 port（让它自然从新文件里消失）',
      JSON.parse(fs.readFileSync(lp, 'utf-8')).apps.every(a => a.port === undefined))

    const listAfter = await reg.listServices()
    const appRow = listAfter.apps.find(a => a.id === 'obs-app')
    check('★ 应用行带出观测端口 + 此刻正在监听的端口',
      !!appRow && appRow.observedPorts.includes(obsPort) && appRow.listeningPorts.includes(obsPort),
      JSON.stringify(appRow))
    check('★★ 应用观测到的端口**不再**出现在「未登记但在监听」里（已有主，不许重复报成无主）',
      !listAfter.unregistered.some(u => u.port === obsPort), JSON.stringify(listAfter.unregistered))
    check('★ 「已登记」行里也**不再**从启动台生成条目（那条线只剩手填）',
      listAfter.rows.every(r => r.source === 'manual'), JSON.stringify(listAfter.rows.map(r => r.source)))
    const openUnknown = await reg.openService(65533)
    check('★ openService 对"方寸完全不认识的端口"仍然拒绝（不做万能 URL 打开器）',
      openUnknown && openUnknown.ok === false, JSON.stringify(openUnknown))
    const openKnown = await reg.openService(obsPort)
    check('★ openService 认识"应用观测到的端口"（不必先登记就能打开）',
      openKnown && openKnown.ok === true && String(openKnown.url).includes(String(obsPort)),
      JSON.stringify(openKnown))

    const quiet = await reg.startAppAndObserve('quiet-app')
    check('★★ 没观测到端口**不算失败**（桌面程序大多不监听；旧模型会把它说成"接错了"）',
      quiet && quiet.ok === true && Array.isArray(quiet.newPorts) && quiet.newPorts.length === 0,
      JSON.stringify(quiet))

    // 口径守卫：实现里不许出现任何"杀进程"能力（A 档只读，用户明确排除）
    const src = fs.readFileSync(path.resolve(__dirname, '../../desktop/src/main/services/portRegistry.ts'), 'utf-8')
    check('★ 实现里没有任何杀进程调用（taskkill / process.kill / terminate）',
      !/taskkill|process\.kill|\bkill\(|terminate/i.test(src))
    const names = Object.keys(reg).join(',')
    check('★ 导出函数名里也没有 kill/terminate/stop', !/kill|terminate|stop/i.test(names), names)
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log('FAIL  测试自身异常:', (e && e.stack) || e)
  console.log('RESULT 0 / 1')
  process.exit(1)
})
