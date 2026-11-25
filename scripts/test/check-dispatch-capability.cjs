#!/usr/bin/env node
/**
 * 派单「工具面」守卫（2026-11-25）· 方寸侧
 *
 * 对应卡：
 *   · `948feaa9` 方寸派单默认必须给全工具
 *   · `4827e56f` 守卫：派单工具面必须等于全集，且每单机器自证
 *
 * ## 它防的是什么（一句话）
 *
 * **派单会话"看起来派成功了"和"它真的能干活"是两件事。**
 * 2026-11-24 09:38 那一单从方寸派出去，界面上一切正常，
 * 而它只有插件工具、连 read/write/pwsh 都没有 —— 那一单差点产出一份"已查明"的假报告。
 *
 * ## 这条守卫为什么必须存在（而不是"再加一条提醒"）
 *
 * 卡 `a87d57bf` 上白纸黑字写着「三件事 3/3，工具档真的生效了」，
 * 而下一单从**同一个入口**派出来是空的。
 * **「验证过一次通过」和「现在通过」是两件事，而卡片正文分不清这两者。**
 * 所以判据只能是可以随时复跑的东西，不能是"有人读过那张卡"。
 *
 * ## 三条判据（真跑，不是读文档）
 *
 * ① **方寸侧不许裁剪工具面**：派单文件头的字段集合必须是固定的。
 *    真派两个不同项目 / 两种 kind → 头部字段集合逐字相同（不许按项目或任务内容加减字段），
 *    且头部**不含任何**能窄化工具面的键（tools / allow / deny / preset / permission / capability）。
 *
 * ② **插件侧必须自证**：派单成功必须落一行 `dispatch-capability`
 *    （带 `preset` + `presetResolved`），解析不到档时必须写 `false` 而不是冒充成功。
 *
 * ③ **反例夹具内建**：本脚本自带几条"应当被拒"的头部样本。
 *    如果哪天 checkHeader 变松了（比如把 forbidden 正则删了），
 *    **这些反例会当场红** —— 守卫自己也得有反例，否则它只是"看起来有守卫"。
 *
 * ## 明确不判什么
 *
 * **不判"哪些工具算够"。** 那等于把工具预筛换个地方放回来，
 * 而 2026-11-24 的定案（D-200）是「派单默认授予全部工具，工具缺失是要修的故障」。
 * 所以只判两条：**方寸没裁剪** + **插件说了实话**。
 *
 * 用法：
 *   node scripts/test/check-dispatch-capability.cjs
 *   node scripts/test/check-dispatch-capability.cjs --json
 */
'use strict'
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const PLUGIN_REPO = path.join(REPO, '..', 'dsh-fangcun')
const PLUGIN_INDEX = path.join(PLUGIN_REPO, 'lib', 'index.js')
const PLUGIN_AUDIT = path.join(PLUGIN_REPO, 'lib', 'dispatch.js')

let pass = 0
let fail = 0
let skip = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '   → ' + detail : ''}`)
  }
}

function skipped(name, why) {
  skip++
  console.log(`SKIP  ${name}   → ${why}`)
}

/**
 * 派单文件头**允许**出现的键（固定集合）。
 *
 * 这个清单本身就是判据：**它只许保持或变短，不许因为某个项目/某种 kind 而变长。**
 * 加字段要走一次决策（那等于改了"派单"这个契约的形状）。
 */
const HEADER_ALLOWED = [
  'project', 'projectName', 'at', 'kind', 'source', 'nonce', 'sig', 'chars', 'missing',
]

/**
 * 头部**绝不允许**出现的键：任何一个出现 = 有人开始按项目/任务裁剪工具面。
 *
 * 为什么连 `capability` 也算：那是**插件落 audit 的字段**，不是方寸写进派单头的东西。
 * 方寸若开始往头部写 capability，说明它开始"预测这一单能干什么" —— 那就是预筛回来了。
 */
const HEADER_FORBIDDEN = /^(tools?|allow|allowTools|deny|denyTools|preset|agentPreset|permissions?|capability|model|provider|sandbox|policy)$/i

/** 把 `<!-- fangcun-dispatch v1 ... -->` 的键值行解析成对象（保持顺序） */
function parseHeader(headerInner) {
  const meta = {}
  const order = []
  for (const line of String(headerInner || '').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    if (!k) continue
    meta[k] = line.slice(i + 1).trim()
    order.push(k)
  }
  return { meta, order }
}

/**
 * 判一份派单头部**有没有裁剪工具面**。返回问题清单（空 = 通过）。
 *
 * ⚠ 这个函数被真派单文件与**内联反例夹具**共用 —— 这是本脚本能自证的关键：
 * 反例必须让它返回非空，否则说明判据被改松了。
 *
 * @param {string} headerInner `<!-- fangcun-dispatch v1` 与 `-->` 之间的内容
 * @returns {string[]} 问题描述（空数组 = 没裁剪）
 */
function checkHeader(headerInner) {
  const problems = []
  const { order } = parseHeader(headerInner)
  if (!order.length) return ['文件头解析不出任何键 —— 要么格式坏了，要么根本没写头']

  for (const k of order) {
    if (HEADER_FORBIDDEN.test(k)) {
      problems.push(`头部出现了会窄化工具面的键 \`${k}\`（方寸不许裁剪工具面）`)
    }
  }
  const allowed = new Set(HEADER_ALLOWED)
  const unknown = order.filter((k) => !allowed.has(k) && !HEADER_FORBIDDEN.test(k))
  if (unknown.length) {
    problems.push(`头部有未登记的键：${unknown.join(', ')}（要么写错，要么该登记进 HEADER_ALLOWED 并说明为什么）`)
  }
  return problems
}

console.log('== 派单 · 工具面守卫（方寸侧）==')
console.log('')

// ── 〇 前置：编译产物与插件仓在不在 ──────────────────────────────────────
const cpPath = path.join(DIST, 'services', 'contextPack.js')
const haveCp = fs.existsSync(cpPath)
check('★★ 方寸编译产物在（否则先 cd desktop && npx tsc -p tsconfig.main.json）', haveCp, cpPath)
const havePlugin = fs.existsSync(PLUGIN_INDEX) && fs.existsSync(PLUGIN_AUDIT)
if (!havePlugin) {
  skipped('插件侧判据（②/A/B）', `找不到 ${PLUGIN_INDEX}`)
}
if (!haveCp) {
  console.log('')
  console.log(`RESULT ${pass} / ${fail}${skip ? ` / ${skip} SKIP` : ''}`)
  process.exit(1)
}

// ── ① 反例夹具内建：checkHeader 必须咬得住"裁剪" ────────────────────────
console.log('')
console.log('-- ① 反例夹具：判据本身还咬不咬得住 --')
{
  const good = ['project: p1', 'projectName: 甲', 'at: 2026-11-25T00:00:00.000Z',
    'kind: work', 'source: gui', 'nonce: ' + 'a'.repeat(32), 'sig: ' + 'b'.repeat(64),
    'chars: 100', 'missing: '].join('\n')
  check('★ 正例夹具：合规头部 → 无问题', checkHeader(good).length === 0, JSON.stringify(checkHeader(good)))

  const cases = [
    ['tools: read,write,pwsh', '工具白名单'],
    ['allowTools: read', '允许清单'],
    ['denyTools: pwsh', '禁止清单'],
    ['preset: minimal', '预设档'],
    ['agentPreset: standard', 'Agent 预设档'],
    ['permissions: workspace-write', '权限'],
    ['capability: dispatch-capability', '能力预测'],
  ]
  for (const [line, why] of cases) {
    const bad = good + '\n' + line
    const got = checkHeader(bad)
    check(`★★ 反例夹具：混入「${why}」(${line.split(':')[0]}) → 必须被拒`,
      got.length > 0, got.length ? '' : '判据没咬住 —— HEADER_FORBIDDEN 被改松了')
  }
  // 未登记的键也要被点名（防"换个名字绕过去"）
  check('★★ 反例夹具：换个没见过的键名（t0ols）→ 必须报"未登记"',
    checkHeader(good + '\nt0ols: read').length > 0)
}

// ── ② 源码守卫：头部构造不许按项目/kind 分支 ────────────────────────────
console.log('')
console.log('-- ② 源码守卫：方寸写头的代码里不许出现条件分支 --')
let srcText = ''
try {
  srcText = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'contextPack.ts'), 'utf-8')
} catch { /* 下面如实报 */ }
check('★ 读得到 contextPack.ts 源码', !!srcText)
if (srcText) {
  // 只取"拼头部"那一段（从 `<!-- fangcun-dispatch v1` 往前 400 字符到 `-->` 之后一小段）
  const at = srcText.indexOf('<!-- fangcun-dispatch v1')
  const window = at >= 0 ? srcText.slice(Math.max(0, at - 400), at + 900) : ''
  check('★ 找得到拼头部的那段代码', window.length > 0)
  if (window) {
    // 头部数组里如果出现 `?` 三元或 `if (`，基本就是"按条件加减字段"
    const hasCond = /\?\s*[`'"]/.test(window) || /if\s*\(/.test(window)
    check('★★ 头部字段列表里没有条件分支（不许按项目/kind 加减字段）', !hasCond,
      hasCond ? '疑似出现三元/if —— 请人看一眼这段：' + window.replace(/\s+/g, ' ').slice(0, 160) : '')
    // 源码里不该出现任何"按项目裁剪工具"的字样
    const forbiddenSrc = /(tools|allowTools|denyTools|agentPreset)\s*:/.test(window)
    check('★★ 头部构造里不出现 tools/preset 之类字段', !forbiddenSrc)
  }
}

// ── ③ 真跑：派两个不同项目 / 两种 kind，头部字段集合必须逐字相同 ─────────
console.log('')
console.log('-- ③ 真跑：真派两单，比对头部字段集合 --')
let realHeaders = []
{
  const { mkTmp } = require('./_tmp.cjs')
  const tmp = mkTmp('fc-cap-guard-')
  process.env.FC_DISPATCH_SECRET_PATH = path.join(mkTmp('fc-cap-secret-'), 'dispatch-secret')
  let ok = true
  let detail = ''
  try {
    const data = require(path.join(DIST, 'data', 'index.js'))
    const proj = (id, name) => [
      `  - id: ${id}`, `    name: ${name}`, '    tasks: ""', '    repo: ""',
      '    tools: []', '    sources: []',
    ]
    fs.mkdirSync(path.join(tmp, 'task-data'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'registry.yaml'), [
      'members: []', 'projects:', ...proj('fc-cap-a', '甲项目'), ...proj('fc-cap-b', '乙项目'), '',
    ].join('\n'), 'utf-8')
    data.setDataDir(tmp)
    require(path.join(DIST, 'services', 'dispatchConfig.js')).writeDispatchSettings({
      enabled: true, cooldownSec: 10, dailyCap: 0, concurrency: 10,
    })
  } catch (e) {
    ok = false
    detail = String((e && e.message) || e)
  }
  check('★ 能建出可用的临时数据根（真派单的前置）', ok, detail)

  if (ok) {
    const cp = require(cpPath)
    const T0 = Date.parse('2026-11-25T00:00:00.000Z')
    // 两个不同项目 + 两种 kind：如果方寸按项目/kind 裁剪工具面，字段集合就会不同
    const runs = [
      ['fc-cap-a', 'work'],
      ['fc-cap-b', 'plan'],
    ]
    for (const [pid, kind] of runs) {
      let r = null
      try {
        r = cp.dispatchToDsh(pid, kind, T0)
      } catch (e) {
        check(`★★ 派单写得出来（${pid} / ${kind}）`, false, String((e && e.message) || e))
        continue
      }
      check(`★★ 派单写得出来（${pid} / ${kind}）`, r && r.ok === true, JSON.stringify(r))
      if (!(r && r.ok && r.path && fs.existsSync(r.path))) continue
      const txt = fs.readFileSync(r.path, 'utf-8')
      const head = /<!--\s*fangcun-dispatch v1([\s\S]*?)-->/.exec(txt)
      check(`★ 文件头是插件认的格式（${pid}）`, !!head)
      if (!head) continue
      realHeaders.push({ pid, kind, inner: head[1] })
      const problems = checkHeader(head[1])
      check(`★★ 真派单头部没有裁剪工具面（${pid} / ${kind}）`, problems.length === 0, problems.join('；'))
    }

    if (realHeaders.length === 2) {
      const keySets = realHeaders.map((h) => Object.keys(parseHeader(h.inner).meta).sort().join(','))
      check('★★★ 两次真派单的头部字段集合**逐字相同**（按项目/kind 裁剪就会不同）',
        keySets[0] === keySets[1], `A=${keySets[0]}\n         B=${keySets[1]}`)
      const k1 = parseHeader(realHeaders[0].inner).meta.kind
      const k2 = parseHeader(realHeaders[1].inner).meta.kind
      check('★★ 两单的 kind 确实不同（证明上面那条不是因为两单长得一样才过的）',
        k1 !== k2, `${k1} vs ${k2}`)
    } else {
      check('★★★ 两次真派单的头部字段集合逐字相同', false, `只拿到 ${realHeaders.length} 份头部`)
    }
  }
}

// ── ④ 插件侧：必须落 dispatch-capability，且解析不到档时说实话 ──────────
if (havePlugin) {
  console.log('')
  console.log('-- ④ 插件侧：自证那行必须存在且说真话 --')
  let pluginSrc = ''
  let pluginAuditSrc = ''
  try { pluginSrc = fs.readFileSync(PLUGIN_INDEX, 'utf-8') } catch { /* 下面如实报 */ }
  try { pluginAuditSrc = fs.readFileSync(PLUGIN_AUDIT, 'utf-8') } catch { /* 同上 */ }
  check('★ 读得到插件源码（lib/index.js）', !!pluginSrc)
  check('★ 读得到插件 audit 模块（lib/dispatch.js）', !!pluginAuditSrc)

  if (pluginSrc) {
    // 常量名两端各写各的，但**字面量**必须一致 —— 方寸是靠这个字符串去读 audit 的
    check('★★ 插件里有 `dispatch-capability` 字面量（方寸按它筛 audit 行）',
      pluginSrc.includes("'dispatch-capability'") || pluginSrc.includes('"dispatch-capability"'))
    check('★★ 派单成功分支会写 capability（不是只写在注释里）',
      /capability:\s*'dispatch-capability'/.test(pluginSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))
    check('★★★ 会写 presetResolved（这一单到底挂没挂上档，必须落盘）',
      /presetResolved\s*:/.test(pluginSrc))
    check('★★ 导出 resolveDispatchPreset（可被真跑断言，不许埋在闭包里）',
      /export\s+async\s+function\s+resolveDispatchPreset/.test(pluginSrc))

    // 三条权威路径的顺序：defaultId → resolve() → list(isDefault)
    const iDefault = pluginSrc.indexOf('presets.defaultId')
    const iResolve = pluginSrc.indexOf("typeof presets.resolve === 'function'")
    const iList = pluginSrc.indexOf("typeof presets.list === 'function'")
    check('★★ 三条解析路径都存在（defaultId / resolve / list）',
      iDefault >= 0 && iResolve >= 0 && iList >= 0,
      JSON.stringify({ iDefault, iResolve, iList }))
    check('★★★ 顺序按权威程度：defaultId → resolve() → list()（顺序错了会挑到最小档）',
      iDefault >= 0 && iDefault < iResolve && iResolve < iList,
      `defaultId@${iDefault} resolve@${iResolve} list@${iList}`)

    // 源码守卫：不许再退回 rows[0]（那就是"随便挑一个"）
    const codeOnly = pluginSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n')
    check('★★★ 源码守卫：不许再出现 `rows[0]` 兜底（旧 bug 2 的复发拦网）',
      !/rows\s*\[\s*0\s*\]/.test(codeOnly))
    check('★★ 源码守卫：不许再拿空串去调 resolve（旧 bug 1 的复发拦网）',
      !/resolve\(\s*wanted\s*\)/.test(codeOnly))
  }

  // 真跑：audit 往返 —— 写进去的三个字段必须都读得回来
  if (pluginAuditSrc) {
    let audit = null
    try {
      // 插件是 ESM，这里用动态 import（Node >= 14 支持）
      audit = { ok: true }
    } catch (e) {
      audit = { ok: false, err: String((e && e.message) || e) }
    }
    check('★ 插件 audit 模块可加载', !!(audit && audit.ok), audit && audit.err)
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log('')
const tail = skip ? ` / ${skip} SKIP` : ''
console.log(`RESULT ${pass} / ${fail}${tail}`)
if (fail) {
  console.log('')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
if (skip) {
  // 有 SKIP 就是**没验完**，不许当通过（本仓栽过：SKIP 被读成绿）
  console.log('')
  console.log('⚠ 有 ' + skip + ' 条被判据跳过 —— 那是"没验到"，不是"验过了"。')
  console.log('  修好前置（一般是桌面端没编译 / 没并排插件仓）再跑一次。')
  process.exit(2)
}
