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
 * 运行：node scripts/test/e2e-dispatch-contract.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')
const PLUGIN = path.join(REPO, '..', 'dsh-fangcun', 'lib', 'dispatch.js')

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
let plugin = null
try {
  // 插件是 ESM，这里用 createRequire 骗不过去 —— 直接读源码抽常量（不看行为，只看声明）
  plugin = fs.readFileSync(PLUGIN, 'utf-8')
} catch { /* ignore */ }

check('★ 方寸导出 DISPATCH_KINDS', Array.isArray(cp.DISPATCH_KINDS), JSON.stringify(cp.DISPATCH_KINDS))
check('★ 方寸导出 normalizeDispatchKind', typeof cp.normalizeDispatchKind === 'function')

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dispatch-contract-'))
  // ⚠ `setDataDir` 会**校验**目标目录里已经有 registry.yaml 或 task-data —— 先造再设，
  //   反了就直接 throw（第一次就栽在这）。这不是"测试可以绕过"的检查，是数据根的真实前提。
  try {
    fs.mkdirSync(path.join(tmp, 'task-data'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'registry.yaml'), [
      'members: []',
      'projects:',
      '  - id: fc-dispatch-demo',
      '    name: 契约夹具',
      '    tasks: ""',
      '    repo: ""',
      '    tools: []',
      '    sources: []',
      '',
    ].join('\n'), 'utf-8')
    data.setDataDir(tmp)
  } catch (e) {
    check('★★ 能建出一个可用的临时数据根', false, String(e && e.message || e))
  }
  try {
    const r = cp.dispatchToDsh('fc-dispatch-demo', 'plan')
    check('★ plan 派单写得出来', !!r && r.ok === true, JSON.stringify(r))
    check('★ 返回值里 kind=plan', r && r.kind === 'plan', String(r && r.kind))

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
        meta.project === 'fc-dispatch-demo', String(meta.project))
    }

    // 缺省 = work（老调用方不传第二个参数，行为必须与 0.6.0 一致）
    const r2 = cp.dispatchToDsh('fc-dispatch-demo')
    check('★★ 不传 kind 时缺省 work（0.6.0 老调用方零破坏）',
      r2 && r2.kind === 'work', String(r2 && r2.kind))

    // 乱写的值回落 work，不许静默升级成 plan
    const r3 = cp.dispatchToDsh('fc-dispatch-demo', '随便什么')
    check('★★ 认不出的 kind 回落 work（不许静默变成 plan）',
      r3 && r3.kind === 'work', String(r3 && r3.kind))
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
