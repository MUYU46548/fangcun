/**
 * MCP 接入材料生成（2026-10-02 卡 002 · A 路线）
 *
 * 钉住四件事：
 *   ① 入口解析按本机路径动态生成、args 为绝对路径且文件真实存在（禁写死 E:/CODE/... 于代码里 —— 断言存在性）
 *   ② 六家目标齐全，配置落点按官方格式（DSH YAML 数组 / Codex 下划线 / OpenCode type:local 等）
 *   ③ A 路线红线：服务只读文件系统做检测，没有任何写外部文件的函数
 *   ④ 坏输入显式拒绝（未知目标 / 未知入口 / 入口不可用 → ok:false）
 *
 * 运行：node scripts/test/e2e-mcp-connect.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── electron 桩注入（必须在业务模块之前）────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-mcpconn-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
process.env.LOCALAPPDATA = path.join(TEST_ROOT, 'localappdata')

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

function main() {
  console.log('== MCP 接入材料测试 ==')
  const mod = require(path.join(DIST, 'services', 'mcpConnect.js'))

  // ── ① 入口解析 ─────────────────────────────────────────────────
  const entries = mod.listMcpEntries()
  check('listMcpEntries 返回 A/B 两个入口', entries.length === 2 && entries[0].id === 'A' && entries[1].id === 'B',
    JSON.stringify(entries.map(e => e.id)))
  const entryA = entries.find(e => e.id === 'A')
  const entryB = entries.find(e => e.id === 'B')
  // ── 入口 A 自举化（2026-10-18 重做；老写法 `node …app.asar.unpacked/dist/cli/tegula-mcp.js`
  //    在安装版上从来不可用 —— asar 内文件外部 node 跑不了，且 builder 没配 asarUnpack）──
  check('入口 A 可用（自举桥：方寸自己的可执行文件）', entryA.available === true, entryA.detail)
  check('★ 入口 A 的 command 是绝对路径且真实存在（方寸 exe / dev 下的 electron.exe）',
    entryA.available && path.isAbsolute(entryA.command) && fs.existsSync(entryA.command), entryA.command)
  check('★ 入口 A 用 --mcp-bridge 自举（零外部 node、不受 app.asar 不可执行的影响）',
    entryA.args.includes('--mcp-bridge'), JSON.stringify(entryA.args))
  check('★★ 入口 A 的 command 必须跟随宿主进程可执行文件（真机=方寸.exe，测试进程=node.exe），不许写死裸 `node`',
    entryA.command === process.execPath, `${entryA.command} vs ${process.execPath}`)
  check('★ dist/cli/tegula-mcp.js 不再是入口 A 的依赖（asar 内的 js 外部跑不了）',
    !entryA.args.some(a => /tegula-mcp\.js$/.test(a)), JSON.stringify(entryA.args))
  // 源码守卫：桥模块必须零 electron 依赖（ELECTRON_RUN_AS_NODE=1 时 electron 模块只剩路径字符串）
  {
    // ⚠ 先剥注释再扫：本仓工作区是 CRLF，且这些文件的注释里**故意**会提到 require('electron')
    //   作为反例说明 —— 直接扫源码会把注释当代码判红（2026-10-18 实锤）。
    const codeOnly = (p) => fs.readFileSync(p, 'utf-8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const bridgeSrc = codeOnly(path.join(DIST, 'mcp', 'bridge-standalone.js'))
    check('★ 桥模块零 require("electron")（否则纯 node 模式下 ipcMain/app 全是 undefined）',
      !/require\(["']electron["']\)/.test(bridgeSrc), bridgeSrc.slice(0, 80))
    const pipeSrc = codeOnly(path.join(DIST, 'mcp', 'pipe.js'))
    check('★ 管道名单一出处 pipe.js 也不依赖 electron', !/require\(["']electron["']\)/.test(pipeSrc))
    const bootSrc = codeOnly(path.resolve(DIST, '..', 'boot.js'))
    check('★ 真入口 boot.js 在分流判断之前不许 require 业务模块（TS 会把 import 提到顶部）',
      bootSrc.indexOf('process.argv.includes') >= 0 &&
      bootSrc.indexOf("require('./index')") > bootSrc.indexOf('process.argv.includes'),
      bootSrc.replace(/\n/g, ' ').slice(0, 200))
    const pkg = JSON.parse(fs.readFileSync(path.resolve(DIST, '../../package.json'), 'utf-8'))
    check('★ package.json main 指向 boot.js（真入口分流层）', pkg.main === 'dist/boot.js', String(pkg.main))
  }
  check('入口 B 可用（仓库根 tegula.py）', entryB.available === true, entryB.detail)
  check('入口 B args = [绝对路径 tegula.py, mcp]',
    entryB.available && path.isAbsolute(entryB.args[0]) && entryB.args[1] === 'mcp' && fs.existsSync(entryB.args[0]),
    JSON.stringify(entryB.args))
  check('配置段不带 cwd（两个入口均实测 cwd 无关）',
    entries.every(e => !('cwd' in e)), JSON.stringify(entries))

  // ── ② 六家目标 + 官方格式 ───────────────────────────────────────
  const targets = mod.detectMcpTargets()
  const ids = targets.map(t => t.id)
  check('七家目标齐全（六家官方落点 + WorkBuddy）',
    ['dsh', 'claudecode', 'cursor', 'codex', 'opencode', 'hermes', 'workbuddy'].every(x => ids.includes(x)),
    ids.join(','))
  const dsh = targets.find(t => t.id === 'dsh')
  check('DSH 本机检测到（~/.dsh/profiles/<p>/cordis.patch.yml 真实存在）',
    dsh.detected === true && !!dsh.configPath && fs.existsSync(dsh.configPath), dsh.evidence)

  // ── WorkBuddy（2026-10-03 用户：「似乎没有让 WorkBuddy 自装接入 MCP 的选项」）──
  {
    const wb = targets.find(t => t.id === 'workbuddy')
    check('★ WorkBuddy 在目标清单里（此前六家没有它 → 用户找不到自装入口）', !!wb)
    check('★ WorkBuddy 的 configPath 必须是 undefined（落点不可知就不猜、不显示"打开配置文件"）',
      wb && wb.configPath === undefined, JSON.stringify(wb && wb.configPath))
    check('  它的 howTo 明说"不猜/不代写"并指向「让它自装」',
      wb && /不猜/.test(wb.howTo) && /让它自装/.test(wb.howTo), wb && wb.howTo.slice(0, 60))
    const snip = mod.buildMcpSnippet('workbuddy', 'A')
    check('★ WorkBuddy 配置段生成成功（通用 mcpServers 形状 + 本机真实入口路径）',
      snip.ok && /mcpServers/.test(snip.snippet) && /--mcp-bridge/.test(snip.snippet),
      snip.snippet.slice(0, 120))
    const p = mod.buildSelfInstallPrompt('workbuddy', 'A')
    check('★ 能生成 WorkBuddy 的「自装指令」（这就是用户要的那个选项）', p.ok === true, p.message)
    check('★ 落点不可知时，自装指令点名"按你自己的格式改写，但 command/args 原样保留"',
      p.ok && /按你自己的文档改写/.test(p.prompt) && /command/.test(p.prompt) && /args/.test(p.prompt),
      p.ok ? p.prompt.split('\n').slice(6, 9).join(' | ') : p.message)
  }

  const expect = (tid, eid, ...subs) => {
    const r = mod.buildMcpSnippet(tid, eid)
    check(`[${tid} × ${eid}] 生成成功`, r.ok === true, r.message)
    if (!r.ok) return
    for (const s of subs) {
      check(`  含 ${JSON.stringify(s)}`, r.snippet.includes(s), r.snippet.slice(0, 200))
    }
  }

  expect('dsh', 'A', '- id: mcp-fangcun', "name: '@deepseek-ai/dsh-mcp-client'", 'serverName: fangcun',
    'transport: stdio', 'failOnStartupError: false')
  expect('dsh', 'B', 'command: "python"', '"mcp"', 'serverName: fangcun')
  // ── 卡009（2026-10-03 · DSH 自装实测反馈）：insert: 形式（裸行会被静默跳过）──
  {
    const dshA = mod.buildMcpSnippet('dsh', 'A')
    check('★ 卡009：DSH 配置段是 insert: 形式（裸行=按id覆盖，id不存在静默跳过 —— DSH 实测接不通的真 bug）',
      dshA.ok && dshA.snippet.startsWith('- insert:') &&
      /^ {4}- id: mcp-fangcun$/m.test(dshA.snippet) &&
      /^ {6}name: '@deepseek-ai\/dsh-mcp-client'$/m.test(dshA.snippet),
      JSON.stringify(dshA.snippet.split('\n').slice(0, 4)))
    check('  卡009：howTo 点名 insert 语义与热加载（防止再改回裸行）',
      /insert/.test(dsh.howTo) && /静默跳过/.test(dsh.howTo) && /热加载/.test(dsh.howTo),
      dsh.howTo.slice(0, 80))
  }
  expect('claudecode', 'A', '"mcpServers"', '"fangcun"', '"command"', '--mcp-bridge')
  expect('cursor', 'A', '"mcpServers"', '"fangcun"')
  expect('codex', 'A', '[mcp_servers.fangcun]', 'command = ')
  expect('codex', 'B', '[mcp_servers.fangcun]', 'tegula.py')
  expect('opencode', 'A', '"mcp"', '"fangcun"', '"type": "local"', '--mcp-bridge')
  expect('hermes', 'A', 'mcp_servers:', '  fangcun:', '--mcp-bridge')

  // Codex 下划线守卫（官方文档：mcp-servers / mcpservers 会被静默忽略）
  const codexSnippet = mod.buildMcpSnippet('codex', 'A').snippet
  check('Codex 不出现连字符/无分隔节名（必须 mcp_servers 下划线）',
    !codexSnippet.includes('[mcp-servers') && !codexSnippet.includes('[mcpservers'), codexSnippet)

  // 所有配置段必须带本机动态路径（不是占位符）。
  // JSON/YAML 序列化会把反斜杠转义成 \\，比较前把 snippet 里的 \\ 归一成单斜杠。
  const norm = (s) => s.replace(/\\\\/g, '\\')
  for (const tid of ids) {
    const r = mod.buildMcpSnippet(tid, 'A')
    if (!r.ok) continue
    check(`[${tid}] 配置段含本机真实入口路径`, norm(r.snippet).includes(entryA.command),
      norm(r.snippet).slice(0, 160))
    check(`[${tid}] 配置段带 --mcp-bridge（否则方寸会当普通窗口再开一个实例）`,
      r.snippet.includes('--mcp-bridge'), r.snippet.slice(0, 160))
  }

  // ── ③ A 路线红线：无写外部文件能力 ──────────────────────────────
  const src = fs.readFileSync(path.join(DIST, 'services', 'mcpConnect.js'), 'utf-8')
  const writeCalls = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'copyFileSync']
    .filter(w => src.includes(w))
  check('★ 服务源码零写调用（A 路线：方寸不写任何外部应用的文件）',
    writeCalls.length === 0, writeCalls.join(','))

  // ── ④ 坏输入显式拒绝 ───────────────────────────────────────────
  const bad1 = mod.buildMcpSnippet('不存在的目标', 'A')
  check('未知目标 → ok:false 且有原因', bad1.ok === false && !!bad1.message, JSON.stringify(bad1))
  const bad2 = mod.buildMcpSnippet('dsh', 'Z')
  check('未知入口 → ok:false', bad2.ok === false && !!bad2.message, JSON.stringify(bad2))
  const bad3 = mod.buildMcpSnippet('dsh', '')
  check('空入口 → ok:false', bad3.ok === false, JSON.stringify(bad3))

  // ── 卡006（2026-10-03）：自装指令 —— A 路线第三渠道 ──────────────────
  const p1 = mod.buildSelfInstallPrompt('dsh', 'A')
  check('卡006a：自装指令生成成功（dsh × A）', p1.ok === true, p1.message)
  check('卡006b：含技能卡真实路径且指向 fangcun-bridge/SKILL.md',
    p1.ok && /源文件：.+fangcun-bridge[\\/]+SKILL\.md/.test(p1.prompt), p1.prompt.slice(0, 200))
  check('卡006c：含按格式生成的配置段（与 mcpSnippet 同源，取首行比对）',
    p1.ok && p1.prompt.includes(mod.buildMcpSnippet('dsh', 'A').snippet.split('\n')[0]))
  check('卡006d：含目标配置文件与自检步骤（装完自己验证再汇报）',
    p1.ok && p1.prompt.includes('目标配置文件') && p1.prompt.includes('自检') && p1.prompt.includes('汇报'))
  const pBad = mod.buildSelfInstallPrompt('不存在的目标', 'A')
  check('卡006e：未知目标 → ok:false 且有原因', pBad.ok === false && !!pBad.message, JSON.stringify(pBad))

  // ── 卡007（2026-10-03）：OpenCode「已检测到」误报 —— 两处检测都挂「能跑」门（源码守卫，机器无关）──
  const ocSrc = fs.readFileSync(path.join(DIST, '..', '..', 'src', 'main', 'services', 'mcpConnect.ts'), 'utf-8')
  const agSrc = fs.readFileSync(path.join(DIST, '..', '..', 'src', 'main', 'services', 'agents.ts'), 'utf-8')
  check('卡007：装卡区与 MCP 区的 OpenCode 检测都要求 opencode --version 能跑（不止看目录）',
    /runProbe: 'opencode --version'/.test(agSrc) && /cliRuns\(t\.runProbe\)/.test(agSrc) &&
    /cliRuns\('opencode --version'\)/.test(ocSrc),
    `agents=${/cliRuns\(t\.runProbe\)/.test(agSrc)} mcp=${/cliRuns\('opencode --version'\)/.test(ocSrc)}`)

  // ── 清理 ───────────────────────────────────────────────────────
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
