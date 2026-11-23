/**
 * 派单总闸 · e2e（2026-11-21 · 卡 `所有能主动开-dsh-会话的入口闸要下在-e4264e6c`）
 *
 * ## 钉的是什么
 *
 * 暮雨 2026-11-21 18:45 定案：**不做上限，做「出厂不发车」**。
 * 所以这条测试的核心判据不是"数字调对了"，而是：
 *
 *   ① 全新数据根（没有 `dispatch-settings.json`）→ **默认关**：
 *      派单被拒、**一个文件都不写**、审计留一行 `disabled`；
 *   ② 显式打开后才写文件；打开之后冷却 / 日上限 / 在途按共享设置生效；
 *   ③ 日上限只数**成功开过的会话**（`ok:true`），被拒的不占额度；
 *   ④ 冷却按**项目**算（另一项目不该被连坐）；
 *   ⑤ 设置文件坏掉 → **按默认关**（读不懂时放行 = 把闸拆了）；
 *   ⑥ 源码守卫：写派单只有 `contextPack` 一条路，且它必须先过 `checkDispatch`。
 *
 * ## 为什么这些反例必须存在
 *
 * 这张卡的前身（`9d8bf98a`）已经把签名/审计做进包了，但默认是
 * `10 / 不冷却 / 不限` —— 等于"闸存在、但开着"。只测"能派出去"会全绿，
 * 而用户真正要的是"**没人点就开不出来**"。所以本文件先测"派不出去"。
 *
 * 运行：`node scripts/test/e2e-dispatch-gate.cjs`（需先 build）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const SECRET_DIR = mkTmp('fc-dispatch-gate-secret-')
process.env.FC_DISPATCH_SECRET_PATH = path.join(SECRET_DIR, 'dispatch-secret')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

const gateMod = path.join(DIST, 'shared', 'dispatchGate.js')
const cfgMod = path.join(DIST, 'main', 'services', 'dispatchConfig.js')
const cpMod = path.join(DIST, 'main', 'services', 'contextPack.js')
const dataMod = path.join(DIST, 'main', 'data', 'index.js')

console.log('== 派单总闸 · e2e ==')
check('★★ 编译产物在（先 `cd desktop && npm run build`）',
  fs.existsSync(gateMod) && fs.existsSync(cfgMod) && fs.existsSync(cpMod) && fs.existsSync(dataMod),
  [gateMod, cfgMod, cpMod, dataMod].filter((p) => !fs.existsSync(p)).join(' / '))
if (fail) { console.log(`\nRESULT ${pass} / ${fail}`); process.exit(1) }

const gate = require(gateMod)
const cfg = require(cfgMod)
const cp = require(cpMod)
const data = require(dataMod)

// ── 夹具：一个能被 setDataDir 接受的最小数据根 ──────────────────────────
function freshRoot(tag) {
  const tmp = mkTmp(`fc-dispatch-gate-${tag}-`)
  fs.mkdirSync(path.join(tmp, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'registry.yaml'), [
    'members: []',
    'projects:',
    '  - id: gate-proj-a',
    '    name: 闸门夹具 A',
    '    tasks: ""',
    '    repo: ""',
    '    tools: []',
    '    sources: []',
    '  - id: gate-proj-b',
    '    name: 闸门夹具 B',
    '    tasks: ""',
    '    repo: ""',
    '    tools: []',
    '    sources: []',
    '',
  ].join('\n'), 'utf-8')
  data.setDataDir(tmp)
  return tmp
}
function dispatchFiles(root) {
  try { return fs.readdirSync(path.join(root, '.dispatch-dsh')).filter((n) => /^dispatch-.*\.md$/.test(n)) } catch { return [] }
}
function auditRows(root) {
  try {
    return fs.readFileSync(path.join(root, '.dispatch-dsh', 'audit.jsonl'), 'utf-8')
      .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

// ── ① 纯函数：出厂默认 + 判据顺序 ────────────────────────────────────────
{
  check('★★ 出厂默认 enabled=false（默认不发车）', gate.DISPATCH_SETTINGS_DEFAULTS.enabled === false,
    JSON.stringify(gate.DISPATCH_SETTINGS_DEFAULTS))
  check('★ 出厂默认冷却/日上限/在途 = 30s / 3 / 1',
    gate.DISPATCH_SETTINGS_DEFAULTS.cooldownSec === 30
    && gate.DISPATCH_SETTINGS_DEFAULTS.dailyCap === 3
    && gate.DISPATCH_SETTINGS_DEFAULTS.concurrency === 1,
    JSON.stringify(gate.DISPATCH_SETTINGS_DEFAULTS))
  check('★★ 垃圾输入归一后仍是关（读不懂绝不放行）',
    gate.normalizeDispatchSettings({ enabled: 'true', cooldownSec: 'x' }).enabled === false)
  check('★ enabled 只认严格 true（1 / "yes" 不算）',
    gate.normalizeDispatchSettings({ enabled: 1 }).enabled === false
    && gate.normalizeDispatchSettings({ enabled: 'yes' }).enabled === false)

  const off = gate.checkDispatch('p1', gate.DISPATCH_SETTINGS_DEFAULTS, [], Date.now())
  check('★★ 默认关：闸门第一个理由就是 disabled', off.ok === false && off.reason === 'disabled', JSON.stringify(off))

  const now = Date.now()
  const todayIso = new Date(now).toISOString()
  const settings = { enabled: true, cooldownSec: 10, dailyCap: 1, concurrency: 1 }
  const rows = [{ at: todayIso, ok: true, project: 'p1' }]
  // 冷却与日上限分开测：日上限优先（先判"今天没额度了"，再谈等多久）
  const cool = gate.checkDispatch('p1', { ...settings, dailyCap: 0 }, rows, now)
  check('★★ 冷却按项目算：本项目 10 秒内再派 → cooldown', cool.reason === 'cooldown' && cool.leftMs > 0, JSON.stringify(cool))
  const other = gate.checkDispatch('p2', { ...settings, dailyCap: 0 }, rows, now)
  check('★★ 冷却不连坐别的项目（p2 可以派）', other.ok === true, JSON.stringify(other))
  const capped = gate.checkDispatch('p2', settings, rows, now)
  check('★★ 日上限按全局算：别的项目也挡住（今天 1/1）',
    capped.reason === 'daily-cap' && capped.today === 1 && capped.dailyCap === 1, JSON.stringify(capped))
  check('★ 日上限拒绝时 leftToday=0', capped.leftToday === 0)
  const unlimited = gate.checkDispatch('p1', { ...settings, dailyCap: 0, cooldownSec: 0 }, rows, now)
  check('★ 0 = 不限（日上限/冷却都放行）', unlimited.ok === true, JSON.stringify(unlimited))
  const busy = gate.checkDispatch('p1', { ...settings, cooldownSec: 0, dailyCap: 0, concurrency: 2 }, [], now, 2)
  check('★★ 在途满 → concurrency（不建第二个会话）', busy.reason === 'concurrency', JSON.stringify(busy))

  // 本地日：26 小时前的成功不算今天（UTC 口径在 +08:00 会把今天 08:00 前算成昨天）
  const old = new Date(now - 26 * 3600 * 1000).toISOString()
  const onlyOld = gate.checkDispatch('p1', { ...settings, cooldownSec: 0 }, [{ at: old, ok: true, project: 'p1' }], now)
  check('★★ 今天只数本地日（26 小时前的不算今天）', onlyOld.ok === true && onlyOld.today === 0, JSON.stringify(onlyOld))
  check('★ 坏时间戳不当 0（不会出现 1970 年那种假冷却）',
    gate.checkDispatch('p1', { ...settings, cooldownSec: 0 }, [{ at: '不是时间', ok: true, project: 'p1' }], now).ok === true)
  check('★ 文笔：disabled 的人话里写清"去哪打开"（已搬进 Agent，文案要跟着）',
    /设置 → Agent → DSH 派单/.test(gate.dispatchGateText(gate.checkDispatch('p', gate.DISPATCH_SETTINGS_DEFAULTS, [], now))))
}

// ── ② 默认关：真的写不出派单文件 ─────────────────────────────────────────
{
  const root = freshRoot('default-off')
  try {
    const st = cfg.readDispatchSettingsState()
    check('★★ 全新数据根：设置文件不存在 → source=default', st.exists === false && st.error === '', JSON.stringify(st))
    check('★★ 全新数据根：读出来就是关', st.settings.enabled === false)

    const T = Date.now()
    const r = cp.dispatchToDsh('gate-proj-a', 'work', T)
    check('★★ 默认关：派单被拒，返回 disabled（不是"失败"）',
      r && r.ok === false && r.disabled === true && r.reason === 'disabled', JSON.stringify(r))
    check('★★ 默认关：**一份派单文件都不写**', dispatchFiles(root).length === 0, JSON.stringify(dispatchFiles(root)))
    const rows = auditRows(root)
    check('★★ 默认关：审计留一行 rejected（reason=disabled / stage=gui-gate）',
      rows.length === 1 && rows[0].ok === false && rows[0].reason === 'disabled' && rows[0].stage === 'gui-gate',
      JSON.stringify(rows))

    const h = cfg.buildDispatchHealth()
    check('★ health：source/default + gate.disabled + pending=0',
      h.source === 'default' && h.settings.enabled === false && h.gate.reason === 'disabled' && h.pending === 0,
      JSON.stringify(h))
  } finally { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } }
}

// ── ③ 打开之后：写得出、日上限按成功会话数算 ─────────────────────────────
{
  const root = freshRoot('enabled')
  try {
    const w = cfg.writeDispatchSettings({ enabled: true, cooldownSec: 0, dailyCap: 1, concurrency: 1 })
    check('★★ 设置页写四项：落盘并回读一致', w.ok === true && w.changed === true
      && w.settings.enabled === true && w.settings.dailyCap === 1, JSON.stringify(w))
    check('★ 共享设置文件真的存在（插件读的就是它）', fs.existsSync(cfg.dispatchSettingsPath()))

    const T = Date.now()
    const r = cp.dispatchToDsh('gate-proj-a', 'work', T)
    check('★★ 打开之后：派单写得出来', r && r.ok === true, JSON.stringify(r))
    check('★ 成功时回传冷却时长 = 设置里的秒数 × 1000', r && r.cooldownMs === 0, String(r && r.cooldownMs))
    const files = dispatchFiles(root)
    check('★ 真的落了一份派单文件', files.length === 1, JSON.stringify(files))

    // 模拟插件消费成功（会话开出来了）—— 审计里那一行是"额度"的唯一来源
    cfg.appendDispatchAudit({ ok: true, source: 'gui', project: 'gate-proj-a', kind: 'work', sessionId: 'sess-1', file: files[0] })
    const T2 = T + 1
    const r2 = cp.dispatchToDsh('gate-proj-b', 'work', T2)
    check('★★ 日上限 1：第二单被拒，且说清"今天已 1/1"',
      r2 && r2.ok === false && r2.reason === 'daily-cap' && r2.today === 1 && r2.dailyCap === 1 && /1\/1/.test(String(r2.error)),
      JSON.stringify(r2))
    check('★★ 被拒的单不写文件（目录里仍只有第一份）', dispatchFiles(root).length === 1, JSON.stringify(dispatchFiles(root)))

    const h = cfg.buildDispatchHealth()
    check('★ health：today=1 / source=file / gate.daily-cap',
      h.today === 1 && h.source === 'file' && h.gate.reason === 'daily-cap', JSON.stringify(h))

    // 设置页（dispatch:settings）与插件诊断页（mcp:dshPlugin）必须渲染**同一个对象**：
    // 两边各算一个数，就是这张卡要治的病。
    const dshPluginMod = require(path.join(DIST, 'main', 'services', 'dshPlugin.js'))
    const dsh = dshPluginMod.detectDshPlugin('0.7.5')
    check('★★ health.dispatch 与设置页同源：settings 逐项一致',
      JSON.stringify(dsh.dispatch.settings) === JSON.stringify(h.settings),
      JSON.stringify({ health: h.settings, plugin: dsh.dispatch.settings }))
    check('★★ health.dispatch 与设置页同源：gate 逐项一致（today/dailyCap/reason）',
      JSON.stringify(dsh.dispatch.gate) === JSON.stringify(h.gate),
      JSON.stringify({ health: h.gate, plugin: dsh.dispatch.gate }))
  } finally { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } }
}

// ── ④ 冷却：同一项目拦住、别的项目照常 ───────────────────────────────────
{
  const root = freshRoot('cooldown')
  try {
    cfg.writeDispatchSettings({ enabled: true, cooldownSec: 10, dailyCap: 0, concurrency: 1 })
    const T = Date.now()
    cfg.appendDispatchAudit({ ok: true, source: 'gui', project: 'gate-proj-a', at: new Date(T).toISOString() })

    const blocked = cp.dispatchToDsh('gate-proj-a', 'work', T + 1000)
    check('★★ 冷却内再派 → cooling + leftMs（主进程闸，不是只靠界面禁用）',
      blocked && blocked.ok === false && blocked.cooling === true && blocked.leftMs > 0, JSON.stringify(blocked))
    const leftAt = cp.dispatchCooldownLeft('gate-proj-a', T + 1000)
    check('★ dispatchCooldownLeft 与闸同源（约 9 秒）', leftAt > 8000 && leftAt <= 10000, String(leftAt))

    const okOther = cp.dispatchToDsh('gate-proj-b', 'work', T + 1000)
    check('★★ 冷却按项目：gate-proj-b 不被连坐', okOther && okOther.ok === true, JSON.stringify(okOther))

    const okAfter = cp.dispatchToDsh('gate-proj-a', 'work', T + 10_000)
    check('★ t+10s 之后可再派', okAfter && okAfter.ok === true, JSON.stringify(okAfter))
    check('★ 同项目旧派单被清掉（只留最新一份）', dispatchFiles(root).filter((n) => n.startsWith('dispatch-gate-proj-a-')).length === 1,
      JSON.stringify(dispatchFiles(root)))
  } finally { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } }
}

// ── ④b 连点 5 次：只开 1 个会话，另 4 次带原因码 ─────────────────────────
{
  const root = freshRoot('burst')
  try {
    cfg.writeDispatchSettings({ enabled: true, cooldownSec: 10, dailyCap: 0, concurrency: 1 })
    const T = Date.now()
    const results = []
    for (let i = 0; i < 5; i++) results.push(cp.dispatchToDsh('gate-proj-a', 'work', T + i * 500))
    check('★★ 连点 5 次 → 只写得出一份派单（不会堆 5 份等插件全开）',
      results.filter((r) => r && r.ok === true).length === 1 && dispatchFiles(root).length === 1,
      JSON.stringify(results.map((r) => ({ ok: r.ok, reason: r.reason }))))
    check('★★ 另 4 次都是 cooldown 且带 leftMs（原因码不是一句"失败"）',
      results.filter((r) => r && r.ok === false && r.reason === 'cooldown' && r.leftMs > 0).length === 4,
      JSON.stringify(results.map((r) => r.reason)))
    check('★ 4 次拒绝都进了 audit（事后能追是谁在连点）',
      auditRows(root).filter((r) => r.ok === false && r.reason === 'cooldown' && r.stage === 'gui-gate').length === 4,
      JSON.stringify(auditRows(root).map((r) => r.reason)))
  } finally { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } }
}

// ── ⑤ 失败即关：坏文件 / 非法 patch / 坏审计行 ───────────────────────────
{
  const root = freshRoot('fail-closed')
  try {
    const bad = cfg.writeDispatchSettings({ enabled: 'yes' })
    check('★★ 非法设置被拒（enabled 必须是 true/false）', bad.ok === false && /true/.test(String(bad.error)), JSON.stringify(bad))
    check('★ 非法 patch 不落盘（设置文件仍不存在）', !fs.existsSync(cfg.dispatchSettingsPath()))

    fs.mkdirSync(path.dirname(cfg.dispatchSettingsPath()), { recursive: true })
    fs.writeFileSync(cfg.dispatchSettingsPath(), '{ 这不是 JSON', 'utf-8')
    const st = cfg.readDispatchSettingsState()
    check('★★ 设置文件坏了 → 按默认关 + 把原因说出来',
      st.settings.enabled === false && /读不出来/.test(st.error), JSON.stringify(st))
    const r = cp.dispatchToDsh('gate-proj-a', 'work', Date.now())
    check('★★ 设置读坏时仍然派不出去（失败即关）', r && r.disabled === true, JSON.stringify(r))

    // 审计坏行：跳过，不影响后续判定
    fs.writeFileSync(path.join(root, '.dispatch-dsh', 'audit.jsonl'), '{坏行\n{"ok":true,"project":"p","at":"' + new Date().toISOString() + '"}\n', 'utf-8')
    const rows = cfg.readDispatchAudit()
    check('★ 审计坏行被跳过（不能反过来卡住派单）', rows.length === 1 && rows[0].ok === true, JSON.stringify(rows))
  } finally { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } }
}

// ── ⑥ 源码守卫：写派单只有一条路，且必须先过闸 ───────────────────────────
{
  const cpSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'contextPack.ts'), 'utf-8')
  check('★★ 写侧真的调了唯一判据 checkDispatch', /checkDispatch\(/.test(cpSrc))
  check('★★ 写侧明确区分 disabled（不是笼统的"失败"）', /disabled:\s*true/.test(cpSrc))
  check('★★ 写侧拒单也留痕（stage=gui-gate）', /stage:\s*'gui-gate'/.test(cpSrc))

  // 扫全部主进程源码：除 contextPack 外，不许任何文件直接往派单目录写 dispatch-*.md
  const mainDir = path.join(REPO, 'desktop', 'src', 'main')
  const offenders = []
  ;(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.ts$/.test(e.name)) continue
      if (p.endsWith(path.join('services', 'contextPack.ts'))) continue
      const src = fs.readFileSync(p, 'utf-8')
      if (/writeFileSync\([^\n]*dispatch-/.test(src)) offenders.push(path.relative(REPO, p))
    }
  })(mainDir)
  check('★★ 没有第二个文件绕开 gate 直接写派单', offenders.length === 0, offenders.join(' | '))

  const cfgSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'dispatchConfig.ts'), 'utf-8')
  check('★ health 与设置页共用同一个 buildDispatchHealth', /checkDispatch\('',/.test(cfgSrc) && /readDispatchAudit\(/.test(cfgSrc))

  const appSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue'), 'utf-8')
  check('★★ 项目派单入口必须看总闸（默认关时连花钱确认都不弹）',
    /async function dispatchToDsh[\s\S]{0,1600}?!dispatchEnabled\.value/.test(appSrc))
  check('★★ 日志派单入口也必须看总闸（不能留第二条路）',
    /async function dispatchLogToDsh[\s\S]{0,1200}?!dispatchEnabled\.value/.test(appSrc))
  const projSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'views', 'ProjectsView.vue'), 'utf-8')
  check('★ 项目页两个按钮都绑定 !ctl.dispatchEnabled', (projSrc.match(/!ctl\.dispatchEnabled/g) || []).length >= 2)
  const logsSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'views', 'LogsView.vue'), 'utf-8')
  check('★ 日志页按钮也绑定 !ctl.dispatchEnabled', /!ctl\.dispatchEnabled/.test(logsSrc))
  // 2026-11-21（卡 2bd6106a）：DSH/Agent 相关项已从「通用」搬进「Agent」，
  // 四项绑定真身在 DshAgentSettings.vue；别再去 GeneralSettings 里找（会假红）。
  const genSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'components', 'settings', 'DshAgentSettings.vue'), 'utf-8')
  check('★★ 设置页四项都在：启用 / 冷却秒数 / 日上限 / 在途',
    /dispatchDraft\.enabled/.test(genSrc) && /dispatchDraft\.cooldownSec/.test(genSrc)
    && /dispatchDraft\.dailyCap/.test(genSrc) && /dispatchDraft\.concurrency/.test(genSrc))
  const agentHub = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'components', 'settings', 'AgentSettings.vue'), 'utf-8')
  check('★ 这四项挂在 Agent 分类里（DshAgentSettings 被 AgentSettings 引用）',
    /import DshAgentSettings/.test(agentHub) && /<DshAgentSettings/.test(agentHub))
  const ipcSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'ipc.ts'), 'utf-8')
  check('★ IPC 读写两条通道都在', /dispatch:settings'/.test(ipcSrc) && /dispatch:settingsSet/.test(ipcSrc))
  const preSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'preload', 'index.ts'), 'utf-8')
  check('★ preload 与 IPC 同名同形', /dispatchSettingsGet/.test(preSrc) && /dispatchSettingsSet/.test(preSrc))
}

// ── ⑦ 在途闸不会误伤子代理（2026-11-21 · 卡 2bd6106a B）──────────────────
//
// 暮雨问：「同时在途是否会意外限制子代理导致任务失败损耗高额费用？
//           按理只应该对会话生效，以会话为单位，不会误伤子代理。」
//
// 设计口径（从源码可判，不是拍胸脯）：
//   · 闸只认一个纯参数 `inFlight`，它**不读 DSH 的会话树 / agents / subagent**；
//   · 方寸写侧调 `checkDispatch(..., now)` 时**根本不传 inFlight**（默认 0）——
//     写侧只按"同一项目上次写派单的时刻"算冷却，与运行时开没开会话无关；
//   · 插件消费侧的 `active` 计数只数**它自己开出的派单会话**（按派单文件行），
//     会话内起的子代理不走 `checkDispatch`、也没有派单文件，结构上进不了这个计数。
// ⚠ 真机"会话内起 2 个子代理"的 e2e 需要真实 DSH 会话（花钱），按用户口径
//   不为定性跑真实派单；这条守的是**设计口径不被改坏**，真机那一步在卡里另记。
{
  const gateSrcRaw = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'shared', 'dispatchGate.ts'), 'utf-8')
  const gateSrc = gateSrcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★★ 闸门是纯函数：不读 agents / session 树 / subagent 名单',
    !/\bagents\b|subagent|session\.list|session\/created|agent\/created/.test(gateSrc),
    (gateSrc.match(/\b(agents|subagent|session\.list|session\/created|agent\/created)\b/g) || []).join(','))
  check('★ inFlight 是调用方传进来的数字（闸自己不去数运行时会话）',
    /inFlight = 0/.test(gateSrcRaw) && /@param inFlight/.test(gateSrcRaw))
  const cpSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'contextPack.ts'), 'utf-8')
  const cpCalls = cpSrc.match(/checkDispatch\((?:[^()]|\([^()]*\))*\)/g) || []
  check('★★ 写侧 checkDispatch 不数在途（省略 inFlight 或显式传 0——在途只在插件消费侧数）',
    cpCalls.length >= 1 && cpCalls.every((c) => /,\s*now\s*\)$/.test(c) || /,\s*now\s*,\s*0\s*,/.test(c)),
    cpCalls.join(' | '))
  const appSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue'), 'utf-8')
  check('★ 「花钱动作前确认」只是渲染层弹窗偏好（不挂运行时，碰不到子代理）',
    /costConfirm/.test(appSrc) && !/costConfirm[\s\S]{0,200}checkDispatch/.test(appSrc))
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
