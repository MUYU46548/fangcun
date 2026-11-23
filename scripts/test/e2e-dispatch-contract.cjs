/**
 * 派单 · 跨语言契约（2026-11-17）
 *
 * ## 为什么必须有这一条
 *
 * 「派给 DSH」是**两份代码写、一份文件读**：
 *   · 方寸（TS）`services/contextPack.ts#dispatchToDsh` → **写**派单文件；
 *   · 插件（JS）`lib/dispatch.js#parseDispatch` → **读**派单文件。
 *
 * 两边的键名、取值域、缺省语义**全靠各自代码里的常量对齐**。
 * 一旦一边改了另一没跟，症状是：派单文件写出来了，插件解析成 `null` 直接**丢弃**，
 * 用户看到"点了按钮，什么也没发生" —— 而两边的单测都会是绿的。
 * 这与 `e2e-fm-contract`（TS 与 Python 读同一份 frontmatter）是同一类病。
 *
 * ## 2026-11-17 暮雨定案
 *
 * > 「规划功能几乎要全部重做……现在定死了 DSH 绑方寸，**以后可以直接在 DSH 里派活做规划**。」
 *
 * 于是新增 `kind`（work / plan）。这个字段**必须两边同时认**，所以本守卫的核心就是它。
 *
 * ## 2026-11-20 追加：冷却闸 + 不堆积旧派单
 *
 * 暮雨：「规划类派活类任务的按钮有没有冷却机制？比如点一次倒计时 10s，
 * 防止用户狂点开一堆会话浪费钱。」
 *
 * 点一次 = 插件开一个会话。所以方寸侧必须：① 同一项目 10 秒内只允许一份；
 * ② 新派单落盘时清掉同项目还没被消费的旧派单（否则 DSH 关着时点几次，
 * 一开 DSH 就一份一份全开成会话）。这一节把两条都钉住。
 *
 * 运行：node scripts/test/e2e-dispatch-contract.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const PLUGIN = path.join(REPO, '..', 'dsh-fangcun', 'lib', 'dispatch.js')
// 签名密钥落到临时文件，别碰真 userData（2026-11-20）
const SECRET_DIR = mkTmp('fc-dispatch-secret-')
process.env.FC_DISPATCH_SECRET_PATH = path.join(SECRET_DIR, 'dispatch-secret')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

console.log('== 派单 · 跨语言契约 ==')

// ── ① 两边都在 ──────────────────────────────────────────────────────────
const cpPath = path.join(DIST, 'services', 'contextPack.js')
check('★★ 方寸编译产物在（先 `cd desktop && npx tsc -p tsconfig.main.json`）',
  fs.existsSync(cpPath), cpPath)
check('★★ 插件源码在（同机并列仓库 ../dsh-fangcun）',
  fs.existsSync(PLUGIN), PLUGIN)
if (!fs.existsSync(cpPath) || !fs.existsSync(PLUGIN)) {
  console.log('')
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(1)
}

// ── ② 两边认的 kind 取值域必须逐字一致 ──────────────────────────────────
const cp = require(cpPath)
const sign = require(path.join(DIST, 'services', 'dispatchSign.js'))
let plugin = null
try {
  // 插件是 ESM，这里用 createRequire 骗不过去 —— 直接读源码抽常量（不看行为，只看声明）
  plugin = fs.readFileSync(PLUGIN, 'utf-8')
} catch { /* ignore */ }

check('★ 方寸导出 DISPATCH_KINDS', Array.isArray(cp.DISPATCH_KINDS), JSON.stringify(cp.DISPATCH_KINDS))
check('★ 方寸导出 normalizeDispatchKind', typeof cp.normalizeDispatchKind === 'function')

// ── 2026-11-21：派单总闸的共享设置（跨语言真源）──────────────────────────
// 两端读同一个 JSON 文件；默认值 / 文件名 / 四项键名必须逐字一致，
// 否则"方寸以为关了、插件以为开着"这条病会换个地方复发。
{
  const gateMod = require(path.join(REPO, 'desktop', 'dist', 'shared', 'dispatchGate.js'))
  const pluginText = String(plugin)
  check('★★ 方寸默认设置：enabled=false（出厂不发车）',
    gateMod.DISPATCH_SETTINGS_DEFAULTS.enabled === false)
  const m = /DISPATCH_DEFAULTS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(pluginText)
  check('★ 插件也能找到 DISPATCH_DEFAULTS（否则读的一方没有默认值）', !!m)
  if (m) {
    const get = (k) => {
      const mm = new RegExp(k + '\\s*:\\s*([^,\\n]+)').exec(m[1])
      return mm ? mm[1].trim() : ''
    }
    const pluginDefaults = {
      enabled: get('enabled') === 'true',
      cooldownSec: Number(get('cooldownSec')),
      dailyCap: Number(get('dailyCap')),
      concurrency: Number(get('concurrency')),
    }
    check('★★ 两边默认设置逐项一致（关 / 30 秒 / 3 / 1）',
      JSON.stringify(pluginDefaults) === JSON.stringify(gateMod.DISPATCH_SETTINGS_DEFAULTS),
      `方寸=${JSON.stringify(gateMod.DISPATCH_SETTINGS_DEFAULTS)} 插件=${JSON.stringify(pluginDefaults)}`)
  }
  const pluginFile = /DISPATCH_SETTINGS_FILENAME\s*=\s*['"]([^'"]+)['"]/.exec(pluginText)
  check('★★ 共享设置文件名两边一致（同一个文件才是同一个开关）',
    !!pluginFile && pluginFile[1] === gateMod.DISPATCH_SETTINGS_FILENAME,
    `方寸=${gateMod.DISPATCH_SETTINGS_FILENAME} 插件=${pluginFile ? pluginFile[1] : '(没找到)'}`)
  check('★★ 插件导出了唯一判据 checkDispatchGate（消费端不许各算各的）',
    /export function checkDispatchGate/.test(pluginText))
  const pluginIndex = fs.readFileSync(path.join(REPO, '..', 'dsh-fangcun', 'lib', 'index.js'), 'utf-8')
  check('★★ 插件消费端默认关时整目录拒收（reason=disabled）',
    /reject\(row,\s*'disabled'/.test(pluginIndex))
}

const feKinds = JSON.stringify(cp.DISPATCH_KINDS)
const pluginKindsMatch = /DISPATCH_KINDS\s*=\s*\[([^\]]*)\]/.exec(String(plugin))
check('★★ 插件也有 DISPATCH_KINDS（否则读的一方不认识这个字段）',
  !!pluginKindsMatch, pluginKindsMatch ? '' : '插件里没找到 DISPATCH_KINDS 声明')
if (pluginKindsMatch) {
  const fe = JSON.parse(feKinds).slice().sort()
  const be = pluginKindsMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort()
  check('★★ 两边 kind 取值域逐字一致（改一边不改另一边 = 派单被静默丢弃）',
    JSON.stringify(fe) === JSON.stringify(be), `方寸=${JSON.stringify(fe)} 插件=${JSON.stringify(be)}`)
}

// ── ③ 方寸真的把 kind 写进文件头（而不是只在返回值里提一下）──────────────
{
  const data = require(path.join(DIST, 'data', 'index.js'))
  const tmp = mkTmp('fc-dispatch-contract-')
  // ⚠ `setDataDir` 会**校验**目标目录里已经有 registry.yaml 或 task-data —— 先造再设，
  //   反了就直接 throw（第一次就栽在这）。这不是"测试可以绕过"的检查，是数据根的真实前提。
  try {
    fs.mkdirSync(path.join(tmp, 'task-data'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'registry.yaml'), [
      'members: []',
      'projects:',
      '  - id: fc-dispatch-demo-a',
      '    name: 契约夹具 A',
      '    tasks: ""',
      '    repo: ""',
      '    tools: []',
      '    sources: []',
      '  - id: fc-dispatch-demo-b',
      '    name: 契约夹具 B',
      '    tasks: ""',
      '    repo: ""',
      '    tools: []',
      '    sources: []',
      '  - id: fc-dispatch-demo-c',
      '    name: 契约夹具 C',
      '    tasks: ""',
      '    repo: ""',
      '    tools: []',
      '    sources: []',
      '',
    ].join('\n'), 'utf-8')
    data.setDataDir(tmp)
    // 2026-11-21：派单总闸**默认关**。派单契约测试要先显式打开（否则下面全是"被拒"）。
    // 这三项是这张测试自己的量程：10 秒冷却、日上限不限、在途 10（不是产品默认值）。
    require(path.join(DIST, 'services', 'dispatchConfig.js')).writeDispatchSettings({
      enabled: true, cooldownSec: 10, dailyCap: 0, concurrency: 10,
    })
  } catch (e) {
    check('★★ 能建出一个可用的临时数据根', false, String(e && e.message || e))
  }
  try {
    // 2026-11-20：三个项目的**第一次**派单都用同一个模拟时刻，互不触发对方的冷却。
    const T0 = Date.parse('2026-11-17T00:00:00.000Z')
    const r = cp.dispatchToDsh('fc-dispatch-demo-a', 'plan', T0)
    check('★ plan 派单写得出来', !!r && r.ok === true, JSON.stringify(r))
    check('★ 返回值里 kind=plan', r && r.kind === 'plan', String(r && r.kind))
    check('★ 成功时回传冷却时长（= 共享设置里的秒数 × 1000，renderer 照它显示）',
      r && r.cooldownMs === 10_000, String(r && r.cooldownMs))

    if (r && r.ok && r.path && fs.existsSync(r.path)) {
      const txt = fs.readFileSync(r.path, 'utf-8')
      const head = /<!--\s*fangcun-dispatch v1([\s\S]*?)-->/.exec(txt)
      check('★ 文件头是插件认的格式', !!head)
      const meta = {}
      if (head) {
        for (const line of head[1].split(/\r?\n/)) {
          const i = line.indexOf(':')
          if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
        }
      }
      check('★★ 文件头里有 `kind: plan`（**不是只写在返回值里** —— 插件只读文件）',
        meta.kind === 'plan', `实际 kind=${JSON.stringify(meta.kind)}`)
      check('★ project 在头部（插件靠它判断"这是不是派单"）',
        meta.project === 'fc-dispatch-demo-a', String(meta.project))
      // 2026-11-20：GUI 派单必须带 source/nonce/sig；插件只认签名有效的
      check('★★ 头部有 source=gui / nonce / sig（agent 手写文件没有这三行）',
        meta.source === 'gui' && /^[0-9a-f]{32}$/.test(String(meta.nonce || ''))
        && /^[0-9a-f]{64}$/.test(String(meta.sig || '')),
        JSON.stringify({ source: meta.source, nonce: meta.nonce, sig: meta.sig }))
      const bodyText = txt.slice(head.index + head[0].length).replace(/^(?:[ \t]*\r?\n)+/, '')
      const canonical = {
        source: meta.source, project: meta.project, at: meta.at, kind: meta.kind,
        nonce: meta.nonce, chars: Number(meta.chars),
        missing: String(meta.missing || '').split('|').filter(Boolean), body: bodyText,
      }
      const secret = fs.readFileSync(process.env.FC_DISPATCH_SECRET_PATH, 'utf-8').trim()
      check('★★ 签名验证通过（密钥与插件同一口径）',
        sign.verifyDispatch(secret, canonical, meta.sig))
      check('★★ 改一个字签名就对不上（正文被篡改会被拒）',
        sign.verifyDispatch(secret, { ...canonical, body: bodyText + '\n篡改' }, meta.sig) === false)
      check('★ 换一把密钥也过不了',
        sign.verifyDispatch('0'.repeat(64), canonical, meta.sig) === false)
    }

    // 缺省 = work（老调用方不传第二个参数，行为必须与 0.6.0 一致）
    const r2 = cp.dispatchToDsh('fc-dispatch-demo-b', undefined, T0)
    check('★★ 不传 kind 时缺省 work（0.6.0 老调用方零破坏）',
      r2 && r2.kind === 'work', String(r2 && r2.kind))

    // 乱写的值回落 work，不许静默升级成 plan
    const r3 = cp.dispatchToDsh('fc-dispatch-demo-c', '随便什么', T0)
    check('★★ 认不出的 kind 回落 work（不许静默变成 plan）',
      r3 && r3.kind === 'work', String(r3 && r3.kind))

    // ── ④ 冷却闸（2026-11-20；2026-11-21 改为共享设置驱动）────────────────
    check('★ 默认冷却时长是 30 秒（出厂设置；本测试把共享设置改成了 10 秒）',
      cp.DISPATCH_COOLDOWN_MS === 30_000, String(cp.DISPATCH_COOLDOWN_MS))
    const r4 = cp.dispatchToDsh('fc-dispatch-demo-a', 'plan', T0 + 1_000)
    check('★★ 同一项目 10 秒内再派 → 被拒（不是只靠界面禁用）',
      r4 && r4.ok === false && r4.cooling === true, JSON.stringify(r4))
    check('★ 拒绝时带 leftMs（renderer 拿它起倒计时）',
      r4 && r4.leftMs > 0 && r4.leftMs <= 10_000, String(r4 && r4.leftMs))
    check('★ 冷却按项目算：另一个项目同一时刻照常能派（上一步 r2 已成功）',
      r2 && r2.ok === true)
    check('★ 纯函数口径：t+10s 之后可派（不用真等 10 秒）',
      cp.dispatchCooldownLeft('fc-dispatch-demo-a', T0 + 10_000) === 0,
      String(cp.dispatchCooldownLeft('fc-dispatch-demo-a', T0 + 10_000)))

    // 冷却到期后再派：同项目旧的未消费派单必须被清掉，只留这次这份。
    const dir = path.join(tmp, '.dispatch-dsh')
    const listA = () => fs.readdirSync(dir).filter((n) => n.startsWith('dispatch-fc-dispatch-demo-a-'))
    const before = listA()
    const r5 = cp.dispatchToDsh('fc-dispatch-demo-a', 'plan', T0 + 10_000)
    check('★ 冷却到期后可以再派', r5 && r5.ok === true, JSON.stringify(r5))
    const after = listA()
    check('★★ 新派单落盘时清掉同项目旧派单（同一项目最多一份待消费 —— 否则开 DSH 时一份份全开成会话）',
      before.length === 1 && after.length === 1 && after[0] !== before[0],
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    check('★ 清理只碰本项目：另外两个项目的派单还在',
      fs.readdirSync(dir).filter((n) => n.startsWith('dispatch-fc-dispatch-demo-b-')).length === 1
      && fs.readdirSync(dir).filter((n) => n.startsWith('dispatch-fc-dispatch-demo-c-')).length === 1,
      JSON.stringify(fs.readdirSync(dir)))

    // ── ⑤ 带任务书的派单（2026-11-20 · D-150：文档拆卡 / 出单）─────────────
    check('★ 方寸导出 dispatchMessageToDsh', typeof cp.dispatchMessageToDsh === 'function')
    const T1 = T0 + 20_000
    const rm = cp.dispatchMessageToDsh('fc-dispatch-demo-b', 'work', '【这次要做的事】测试任务书：拆成待审批卡', T1)
    check('★★ 带任务书的派单写得出来', rm && rm.ok === true, JSON.stringify(rm))
    check('★ 带任务书时 kind 仍是 work（插件按它开工作会话）', rm && rm.kind === 'work')
    if (rm && rm.ok && rm.path && fs.existsSync(rm.path)) {
      const txt = fs.readFileSync(rm.path, 'utf-8')
      const body = txt.slice(txt.indexOf('-->') + 3).replace(/^\s+/, '')
      check('★★ 任务书排在上下文包**前面**（DSH 一进来先看到这次要做的事）',
        body.startsWith('【这次要做的事】'), body.slice(0, 80))
      check('★ 任务书整段在文件里（不是只回传在返回值里）',
        txt.indexOf('测试任务书：拆成待审批卡') >= 0)
    }
    const rm2 = cp.dispatchMessageToDsh('fc-dispatch-demo-b', 'work', '再派一次', T1 + 1_000)
    check('★★ 带任务书的派单同样受 10 秒冷却闸（不是绕过冷却的后门）',
      rm2 && rm2.ok === false && rm2.cooling === true, JSON.stringify(rm2))
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ── ④ 源码守卫：方寸侧不许自己发明第二种派单格式 ──────────────────────
{
  const src = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'contextPack.ts'), 'utf-8')
  check('★ 派单头部只有一处（`fangcun-dispatch v1` 在源码里只出现一次）',
    (src.match(/fangcun-dispatch v1/g) || []).length === 1,
    `出现 ${(src.match(/fangcun-dispatch v1/g) || []).length} 次`)
  check('★ 源码里真的拼了 `kind:` 这一行',
    /`kind: \$\{kind\}`/.test(src), '没找到 kind 行 —— 插件会读不到用途')
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
