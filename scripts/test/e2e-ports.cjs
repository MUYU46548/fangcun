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

  fs.writeFileSync(path.join(TEST_ROOT, 'apps.json'), JSON.stringify({
    apps: [
      { id: 'test-live', name: '测试用活服务', port: livePort, description: '本测试起的真监听' },
      { id: 'test-idle', name: '测试用死服务', port: idlePort, description: '没人监听' },
      { id: 'no-port', name: '没填端口的应用', description: '不该出现在服务页' },
    ],
  }, null, 2))

  const p1 = await reg.listServices()
  check('★ 启动台 apps.json 里的 port 字段真的被读了（这字段此前全仓无人读）',
    p1.rows.some(r => r.port === livePort), JSON.stringify(p1.rows.map(r => [r.name, r.port])))
  check('没填 port 的应用不出现在服务页', !p1.rows.some(r => r.name === '没填端口的应用'))
  const live = p1.rows.find(r => r.port === livePort)
  check('★ 活服务被识别为"监听中"', live && live.listening === true, JSON.stringify(live))
  check('★★ 占用者 PID 是**真查的**（就是本测试进程）', live && live.pid === process.pid,
    `pid=${live && live.pid} 期望=${process.pid}`)
  check('占用者进程名解析出来了（node）', live && /node/i.test(live.processName), live && live.processName)
  check('来源标成 launchpad', live && live.source === 'launchpad', live && live.source)
  const idle = p1.rows.find(r => r.port === idlePort)
  check('★ 没人监听的端口 → listening=false、pid=null', idle && idle.listening === false && idle.pid === null, JSON.stringify(idle))
  check('统计数字自洽（监听中 + 空闲 = 登记数）',
    p1.listeningCount + p1.idleCount === p1.rows.length, `${p1.listeningCount}+${p1.idleCount} vs ${p1.rows.length}`)

  // ── 3. 未登记但正在监听 ───────────────────────────────────────────
  check('★ 「未登记但正在监听」抓到了那个没登记的监听',
    p1.unregistered.some(u => u.port === extraPort), JSON.stringify(p1.unregistered.map(u => u.port)))
  check('  未登记项带 PID 与进程名',
    (p1.unregistered.find(u => u.port === extraPort) || {}).pid === process.pid,
    JSON.stringify(p1.unregistered.find(u => u.port === extraPort)))
  check('  已登记的那个端口**不**出现在未登记列表里（两栏不重叠）',
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
  check('★ 启动台登记的端口不许从这里删（要改 apps.json）',
    reg.removeManualService(livePort).ok === false)
  check('  拒绝后启动台那条还在', (await reg.listServices()).rows.some(r => r.port === livePort))

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
  check('  坏文件不影响启动台那部分照常显示', p4.rows.some(r => r.port === livePort))
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

  // ── 一键启动的安全线（2026-09-26 回执：「服务页没看到 8090 有动静」）──────
  //   页面能"当场把它拉起来"才有意义，但**必须只认启动台里登记过、且带 port 的应用**：
  //   端口对不上就拒绝 —— 方寸绝不替用户拉起陌生程序（也永远不杀进程）。
  {
    const notRegistered = await reg.startService(65533)
    check('★ 未登记的端口 → 拒绝启动（不做通用进程启动器）',
      notRegistered && notRegistered.ok === false && /启动台/.test(notRegistered.message),
      JSON.stringify(notRegistered))

    for (const bad of [0, -1, 70000, NaN]) {
      const r = await reg.startService(bad)
      check(`  非法端口 ${String(bad)} → 拒绝`, r && r.ok === false, JSON.stringify(r))
    }

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
