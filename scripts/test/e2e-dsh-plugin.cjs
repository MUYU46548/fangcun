/**
 * DSH 侧的方寸插件（2026-11-06 暮雨：“依然未体现 DSH 插件相关，
 * 且 DSH 插件应该自带把方寸接入的功能”）。
 *
 * 要钉住的事实：
 *  ① 方寸**已经有一个专属 DSH 插件**（dsh-fangcun），装在 profile 的 `node_modules` +
 *     登记进 `dsh.profile.bundles` —— 两处都要能读出来（只登记不进 bundles = 不会加载）；
 *  ② 它**自带接入**：直连方寸命名管道，不需要用户抄 command/args/env；
 *  ③ patch 里那条**旧的手工桥**（`- id: mcp-fangcun` + dsh-mcp-client）要能认出来，
 *     并且要能说出"它指向的命令在不在 / 是不是开发目录" —— 这才是"配了但连不上"的判据；
 *  ④ 反例：注释里写着 fangcun 的那一行**不是**配置（本机 patch 顶部就有一整段注释）。
 *
 * ⚠ 隔离：`FC_DSH_HOME` 与 `FC_MCP_PIPE` 都重定向到临时目录，绝不读用户真实 DSH。
 *
 * 运行：node scripts/test/e2e-dsh-plugin.cjs
 */
const path = require('path')
const fs = require('fs')
const Module = require('module')
const { mkTmp } = require('./_tmp.cjs')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = mkTmp('fc-dsh-plugin-')
const DSH = path.join(TEST_ROOT, 'dsh')
process.env.FC_TEST_USERDATA = TEST_ROOT
process.env.FC_DSH_HOME = DSH
// 管道重定向到一个不存在的路径 → alive 必须是 false（machine-independent）
const FAKE_PIPE = path.join(TEST_ROOT, 'no-such-pipe')
process.env.FC_MCP_PIPE = FAKE_PIPE

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

/** 造 profile：dependencies + bundles + node_modules/dsh-fangcun/package.json */
function fakeProfile(opts = {}) {
  const { bundled = true, withDep = true, version = '0.3.0', patch = '' } = opts
  const dir = path.join(DSH, 'profiles', 'desktop')
  fs.mkdirSync(path.join(dir, 'node_modules', 'dsh-fangcun'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'dsh-fangcun', 'package.json'),
    JSON.stringify({ name: 'dsh-fangcun', version }), 'utf-8')
  const pkg = {
    name: 'dsh-profile-desktop',
    dependencies: withDep ? { 'dsh-fangcun': 'link:E:/CODE/CangKu/dsh-fangcun', 'dsh-keep-awake': '0.3.1' } : {},
    dsh: { profile: { bundles: bundled ? ['@deepseek-ai/dsh-base', 'dsh-fangcun'] : ['@deepseek-ai/dsh-base'] } },
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8')
  if (patch) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch, 'utf-8')
  return dir
}

function main() {
  console.log('== DSH 方寸插件（只读探测）==')
  const mod = require(path.join(DIST, 'services', 'dshPlugin.js'))

  // ── ① 正常装了 ──────────────────────────────────────────────────────
  fakeProfile({
    patch: [
      '# fangcun (tegula) task-board bridge —— 这只是一句注释，不是配置',
      'model:',
      '  default: x',
      '- id: mcp-fangcun',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: fangcun',
      // ⚠ 故意用一个**不存在**的开发路径：判据是"配置里有 ≠ 连得上"，
      //   拿真实存在的 exe 当夹具这条断言就恒真（2026-11-06 首版就这么假绿过一次）。
      '    command: "E:\\\\nope-fc\\\\desktop\\\\node_modules\\\\electron\\\\dist\\\\electron.exe"',
      '    args: ["x.js"]',
      '- id: llm-pi-ai',
      '  config:',
      '    providers: {}',
      '',
    ].join('\n'),
  })

  const s = mod.detectDshPlugin()
  check('★ 认出方寸插件（profile 的 dependencies 里带 fangcun）',
    s.plugins.length === 1 && s.plugins[0].name === 'dsh-fangcun', JSON.stringify(s.plugins))
  check('★ 版本读的是 node_modules 里那份（不是 dependencies 的 spec）',
    s.plugins[0].version === '0.3.0', s.plugins[0].version)
  check('★ link: 装法要露出真实目录（才知道装的是不是本地开发版）',
    /link:/.test(s.plugins[0].spec) && /dsh-fangcun/.test(String(s.plugins[0].linkedDir)),
    s.plugins[0].spec + ' → ' + s.plugins[0].linkedDir)
  check('★ 进没进 bundles 单独一个事实（只登记依赖不会加载）',
    s.plugins[0].bundled === true, String(s.plugins[0].bundled))
  check('  summary 说清"自带接入 = 命名管道"',
    /命名管道/.test(s.summary), s.summary)

  // ── ② 自带通道 ───────────────────────────────────────────────────────
  check('★ 自带通道就是方寸的命名管道（与 pipe.ts 同一口径，不手写字面量）',
    s.pipe.path === FAKE_PIPE, s.pipe.path)
  check('  管道不在 → alive=false（不许凭空报"通"）', s.pipe.alive === false, String(s.pipe.alive))

  // ── ③ 旧的手工桥 ─────────────────────────────────────────────────────
  check('★ 认出 patch 里那条旧手工桥（含行号，方便用户去删）',
    !!s.legacy && s.legacy.line === 4, JSON.stringify(s.legacy && s.legacy.line))
  check('  桥的插件名读对了', s.legacy.plugin === '@deepseek-ai/dsh-mcp-client', s.legacy.plugin)
  check('  反斜杠还原成真实路径形态', s.legacy.command.includes('\\node_modules\\'), s.legacy.command)
  check('★ 判得出"指向开发目录"（dev 一清就断，这是真隐患）',
    s.legacy.isDevPath === true, String(s.legacy.isDevPath))
  check('★ 命令文件不在 → commandExists=false（配置里有 ≠ 连得上）',
    s.legacy.commandExists === false, String(s.legacy.commandExists))

  // ── ④ 反例：注释里写 fangcun 不算配置 ────────────────────────────────
  {
    const dir = path.join(DSH, 'profiles', 'desktop')
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), [
      '# - id: mcp-fangcun   ← 这行被注释掉了，等同于没有',
      'model:',
      '  default: x',
      '',
    ].join('\n'), 'utf-8')
    const s2 = mod.detectDshPlugin()
    check('★ 反例：注释掉的 `- id: mcp-fangcun` 不许当成"有手工桥"',
      s2.legacy === undefined, JSON.stringify(s2.legacy))
  }

  // ── ⑤ 反例：bundles 没登记 → 不会加载 ────────────────────────────────
  {
    fakeProfile({ bundled: false, patch: '' })
    const s3 = mod.detectDshPlugin()
    check('★ 反例：装了但没进 bundles → bundled=false（宿主不会加载它）',
      s3.plugins.length === 1 && s3.plugins[0].bundled === false, JSON.stringify(s3.plugins.map(p => p.bundled)))
    check('  没有 patch 时 legacy 为空（不报假的"旧桥"）', s3.legacy === undefined, JSON.stringify(s3.legacy))
  }

  // ── ⑥ 反例：bundles 里有、dependencies 没有 → 也要露出来 ──────────────
  {
    fakeProfile({ bundled: true, withDep: false, patch: '' })
    const s4 = mod.detectDshPlugin()
    check('★ 反例：只在 bundles 里登记（dependencies 无）也要列出来，并说明来源',
      s4.plugins.length === 1 && /bundles 里登记/.test(s4.plugins[0].spec), JSON.stringify(s4.plugins))
  }

  // ── ⑦ 一根都没有 → 明说"没装插件"而不是报错 ──────────────────────────
  {
    const dir = path.join(DSH, 'profiles', 'desktop')
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf-8')
    const s5 = mod.detectDshPlugin()
    check('★ 装了 DSH 但没装方寸插件 → plugins 空 + summary 说清',
      s5.plugins.length === 0 && /没装方寸插件/.test(s5.summary), s5.summary)
  }

  // ── ⑧ 源码守卫：这个模块只读，不许写 DSH 的任何东西 ────────────────────
  {
    const code = fs.readFileSync(path.join(DIST, 'services', 'dshPlugin.js'), 'utf-8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    const writes = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'copyFileSync', 'rmSync']
      .filter((w) => code.includes(w))
    check('★ dshPlugin 零写调用（方寸不改 DSH 任何配置）', writes.length === 0, writes.join(','))
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
