/**
 * 接入 Hermes 的 MCP（2026-11-06 暮雨：“Hermes 要接，而且应该通过方寸去接”）。
 *
 * 这是方寸**唯一**会写别人配置文件的通道，所以判据要钉得比别处死：
 *   ① 只加不删：把新增块整段抠掉后，必须与原文**逐字节相同**；
 *   ② 写之前必须有备份，备份内容 = 原文；
 *   ③ 写完 YAML 必须仍能解析（交给真 Python + PyYAML，不是自己数缩进）；
 *   ④ 幂等：已经接上就一个字都不写；
 *   ⑤ 反例：配置文件不在 → 失败且**不替它新建**；注释里写着 fangcun → 仍算未接入。
 *
 * ⚠ 隔离：`HERMES_HOME` 指向临时目录（`mcpConnect.hermesHome()` 的第一优先级就是它），
 *   否则这一步会写进**用户真实的 %LOCALAPPDATA%\hermes\config.yaml**。
 *
 * 运行：node scripts/test/e2e-hermes-link.cjs
 */
const path = require('path')
const { mkTmp, mkTmpPath } = require('./_tmp.cjs')
const fs = require('fs')
const os = require('os')
const Module = require('module')
const { spawnSync } = require('child_process')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = mkTmpPath('fc-hermes-link-')
const HERMES = path.join(TEST_ROOT, 'hermes')
process.env.FC_TEST_USERDATA = TEST_ROOT
process.env.HERMES_HOME = HERMES
fs.mkdirSync(HERMES, { recursive: true })

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

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ } }

/** 一份“像真的” Hermes 配置：有注释、有别的段、mcp_servers 里已经有两个条目 */
const SAMPLE = [
  '# Hermes 配置（夹具）—— 注释必须在接入之后原样还在',
  'model:',
  '  default: deepseek-v4.1-flash',
  '  provider: opencode-go',
  'mcp_servers:',
  '  mcp42:',
  '    url: https://example.invalid/mcp',
  '    timeout: 120',
  '  novelforge:',
  '    command: C:\\somewhere\\python.exe',
  '    args:',
  '      - E:\\x\\bridge.py',
  '    enabled: true',
  'known_plugin_toolsets:',
  '  cli:',
  '    - spotify',
  'telemetry:',
  '  send: true',
  '',
].join('\n')

/**
 * 用真 YAML 解析器（desktop/node_modules 里的 js-yaml）验证“写完还能解析”。
 * ⚠ 本机 `python` 没装 PyYAML（实测 No module named 'yaml'），所以走 node 侧的真解析器；
 *   解析器不可用时显式 SKIP 并说明原因，绝不拿“缩进看着对”冒充解析通过。
 */
function yamlParse(file) {
  let yaml
  try {
    yaml = require(require.resolve('js-yaml', { paths: [path.resolve(__dirname, '../../desktop')] }))
  } catch (e) {
    return { ok: null, reason: '没有 js-yaml: ' + (e && e.message) }
  }
  try {
    const d = yaml.load(fs.readFileSync(file, 'utf-8'))
    const servers = (d && d.mcp_servers) || {}
    const fc = servers.fangcun
    return {
      ok: true,
      has: !!fc,
      command: fc && fc.command,
      args: fc && fc.args,
      env: fc && fc.env,
      servers: Object.keys(servers).sort(),
    }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

function main() {
  console.log('== Hermes 接入（方寸唯一会写别人配置的通道）==')
  const mod = require(path.join(DIST, 'services', 'hermesLink.js'))
  const probe = require(path.join(DIST, 'services', 'probe.js'))
  const cfg = path.join(HERMES, 'config.yaml')

  // ── 场景 A：正常接入 ────────────────────────────────────────────────
  fs.writeFileSync(cfg, SAMPLE, 'utf-8')
  const before = fs.readFileSync(cfg, 'utf-8')

  const st0 = mod.hermesMcpLinkStatus()
  check('★ 初始状态：配置文件在、未接入', st0.present === true && st0.linked === false, JSON.stringify(st0))
  check('  状态里的路径就是 HERMES_HOME 下那份（没写用户真实目录）',
    path.resolve(st0.configPath) === path.resolve(cfg), st0.configPath)

  const r1 = mod.linkHermesMcp('A')
  check('★ 接入成功', r1.ok === true && r1.changed === true, JSON.stringify(r1))
  check('  返回里带备份路径且备份真实存在', !!r1.backupPath && fs.existsSync(r1.backupPath), r1.backupPath)
  check('★ 备份内容 = 原文（写坏才有东西可还原）', fs.readFileSync(r1.backupPath, 'utf-8') === before)

  const after = fs.readFileSync(cfg, 'utf-8')
  // ⚠ 按**行**抠：块的前后各有一个换行，`split(block).join('')` 会留下空行，判据永远对不上
  //   （2026-11-06 首版就踩了这个，实现那边也改成行级比较）
  const afterLines = after.split(/\r?\n/)
  const blockLines0 = r1.block.split(/\r?\n/)
  const bi = afterLines.indexOf(blockLines0[0])
  const strippedLines = bi < 0 ? afterLines : afterLines.slice(0, bi).concat(afterLines.slice(bi + blockLines0.length))
  const beforeLines = before.split(/\r?\n/)
  check('★ 只加不删：把新增块按行抠掉后与原文逐行相同（顺序也没乱）',
    bi >= 0 && strippedLines.length === beforeLines.length && strippedLines.every((l, i) => l === beforeLines[i]),
    `块起点=${bi} 抠掉后 ${strippedLines.length} 行 vs 原文 ${beforeLines.length} 行`)

  const lines = after.split('\n')
  const idxMcp = lines.findIndex((l) => /^mcp_servers:\s*$/.test(l))
  const idxFc = lines.findIndex((l) => /^ {2}fangcun:\s*$/.test(l))
  const idxNext = lines.findIndex((l) => /^known_plugin_toolsets:/.test(l))
  check('★ 插在 mcp_servers 段内、下一个顶层键之前（不是随手追加到文件末尾）',
    idxMcp >= 0 && idxFc > idxMcp && idxNext > idxFc, `mcp=${idxMcp} fangcun=${idxFc} next=${idxNext}`)
  check('  缩进是 2 空格（与邻居 mcp42 / novelforge 同级）', /^ {2}fangcun:$/.test(lines[idxFc]), JSON.stringify(lines[idxFc]))
  check('  原注释还在（没被 load+dump 洗掉）', after.includes('# Hermes 配置（夹具）'))

  const py = yamlParse(cfg)
  if (py.ok === null) {
    console.log('SKIP  PyYAML 不可用，跳过结构解析断言：' + py.reason)
  } else {
    check('★ 写完 YAML 仍能解析，且 mcp_servers.fangcun 真的在', py.ok === true && py.has === true, JSON.stringify(py))
    check('  三个既有 MCP 条目一个没少（mcp42 / novelforge 都在）',
      (py.servers || []).includes('mcp42') && (py.servers || []).includes('novelforge'), JSON.stringify(py.servers))
    check('  command 指向真实存在的本机可执行文件', !!py.command && fs.existsSync(py.command), String(py.command))
    check('  env 带 ELECTRON_RUN_AS_NODE=1（少了它方寸按 GUI 起 → GPU 崩）',
      !!py.env && py.env.ELECTRON_RUN_AS_NODE === '1', JSON.stringify(py.env))
  }

  // ── 场景 B：幂等 ───────────────────────────────────────────────────
  const mtime0 = fs.statSync(cfg).mtimeMs
  const r2 = mod.linkHermesMcp('A')
  check('★ 已接入时再点：changed=false 且明说“没改动任何文件”',
    r2.ok === true && r2.changed === false && /没有改动/.test(r2.message), JSON.stringify(r2))
  check('  文件一个字节都没动（mtime 与内容都不变）',
    fs.readFileSync(cfg, 'utf-8') === after && fs.statSync(cfg).mtimeMs === mtime0)

  // ── 场景 C：反例 —— 注释里写着 fangcun 不算接入 ──────────────────────
  {
    const c2 = path.join(HERMES, 'commented.yaml')
    fs.writeFileSync(c2, [
      '# fangcun (tegula) task-board bridge —— 这只是一句注释',
      'model:',
      '  default: x',
      '',
    ].join('\n'), 'utf-8')
    check('★ 反例：只有注释写 fangcun → 状态仍是“未接入”',
      probe.fangcunConfigHit(c2).linked === false, JSON.stringify(probe.fangcunConfigHit(c2)))
  }

  // ── 场景 D：反例 —— 没有 mcp_servers 段 → 末尾新建一段，YAML 仍可解析 ──
  {
    fs.writeFileSync(cfg, ['model:', '  default: x', 'telemetry:', '  send: true', ''].join('\n'), 'utf-8')
    const r = mod.linkHermesMcp('A')
    check('★ 反例（缺 mcp_servers 段）：仍能接入', r.ok === true && r.changed === true, JSON.stringify(r))
    const txt = fs.readFileSync(cfg, 'utf-8')
    check('  在文件末尾新建了 mcp_servers 段', /^mcp_servers:$/m.test(txt), txt.slice(-160))
    const p2 = yamlParse(cfg)
    if (p2.ok !== null) {
      check('  新建出来的段 YAML 能解析且含 fangcun', p2.ok === true && p2.has === true, JSON.stringify(p2))
    }
  }

  // ── 场景 E：反例 —— 配置文件不存在 → 失败且不新建 ─────────────────────
  {
    const missing = path.join(HERMES, 'nope', 'config.yaml')
    fs.rmSync(path.join(HERMES, 'nope'), { recursive: true, force: true })
    // 用 HERMES_HOME 的重定向来命中这个不存在的路径
    const oldHome = process.env.HERMES_HOME
    process.env.HERMES_HOME = path.join(HERMES, 'nope')
    try {
      const r = mod.linkHermesMcp('A')
      check('★ 反例：配置文件不存在 → ok:false（不替 Hermes 建配置）',
        r.ok === false && /不替它新建/.test(r.message), JSON.stringify(r))
      check('  真的没有把目录/文件建出来', !fs.existsSync(missing), missing)
    } finally {
      if (oldHome === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = oldHome
    }
  }

  // ── 场景 F：CRLF 文件写回仍是 CRLF ───────────────────────────────────
  {
    const crlf = SAMPLE.replace(/\n/g, '\r\n')
    fs.writeFileSync(cfg, crlf, 'utf-8')
    const r = mod.linkHermesMcp('A')
    const out = fs.readFileSync(cfg, 'utf-8')
    // 末尾 split 出来的空串不算“裸 LF 行”，要排掉再数
    const bareLf = out.split(/\n/).filter((l) => l !== '' && !l.endsWith('\r')).length
    check('★ CRLF 的文件写回仍是 CRLF（不许混进裸 LF）', r.ok === true && bareLf === 0, '裸 LF 行数=' + bareLf)
    check('  CRLF 下 YAML 也能解析（不是只有 LF 才对）', (yamlParse(cfg).ok !== false), JSON.stringify(yamlParse(cfg)))
  }

  // ── 场景 G：写能力只存在于 hermesLink（mcpConnect 仍零写）───────────────
  {
    const code = (p) => fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    const mc = code(path.join(DIST, 'services', 'mcpConnect.js'))
    const hl = code(path.join(DIST, 'services', 'hermesLink.js'))
    check('★ mcpConnect 仍然零写调用（A 路线没被这轮改动破掉）',
      !/writeFileSync|appendFileSync|renameSync|copyFileSync/.test(mc))
    check('★ 写能力只在 hermesLink 里（且它只写一个目标：Hermes config.yaml）',
      /writeFileSync/.test(hl) && !/\.cursor|\.codex|claude\.json|opencode\.json/.test(hl), 'hermesLink 里出现了别的目标？')
  }

  rmrf(TEST_ROOT)
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
