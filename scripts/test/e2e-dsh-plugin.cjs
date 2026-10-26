/**
 * fangcun-dsh 插件骨架守卫（2026-10-26）
 *
 * 这个插件是**独立仓库的种子**（先放在方寸仓的 `dsh/` 子目录里开发，
 * 等要发 npm / 独立分发时 `git subtree split -P dsh` 连历史拆出去）。
 * 所以这里钉的是「拆出去还能不能用」这件事本身：
 *
 *  ① 包元数据必须自洽（name / version / dsh.bundle.patch 指向的文件真的存在）；
 *  ② 挂载声明（cordis.patch.yml）里的 id/name 必须等于包名 —— 改了包名忘了改这里，
 *     宿主会找不到模块，症状是"装了但没出现"；
 *  ③ **不许 import 方寸的代码**（一旦 import，拆仓就锁死，而且插件版本被迫跟本体联动）；
 *  ④ health 只说能自证的事实（路径存在与否），认不出数据根时**返回空串而不是猜一个**。
 *
 * 反例怎么打：把 lib/index.js 里加一行 `import x from '../../desktop/src/shared/plain'` → ③ 红；
 *   把 cordis.patch.yml 的 name 改成别的 → ② 红；把 resolveDataDir 改成兜底返回 cwd → ④ 红。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const DIR = path.join(REPO, 'dsh')

let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fails.push(name + (extra ? '  → ' + extra : '')); console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

;(async () => {
  // ── ① 包元数据 ────────────────────────────────────────────────────
  console.log('\n── ① 包元数据 ──')
  const pkgRaw = fs.readFileSync(path.join(DIR, 'package.json'), 'utf-8')
  const pkg = JSON.parse(pkgRaw)
  check('包名是 fangcun-dsh', pkg.name === 'fangcun-dsh', pkg.name)
  check('有 dsh.bundle.patch 字段（宿主靠它找挂载声明）', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml',
    JSON.stringify(pkg.dsh))
  check('★ patch 指向的文件**真的存在**', fs.existsSync(path.join(DIR, 'cordis.patch.yml')))
  check('main 指向的文件真的存在', !!pkg.main && fs.existsSync(path.join(DIR, pkg.main)), String(pkg.main))
  check('type=module（插件体用 ESM，宿主按 ESM 加载）', pkg.type === 'module', String(pkg.type))
  check('★ files 里包含 lib 与 cordis.patch.yml（不列就发不出去）',
    Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'),
    JSON.stringify(pkg.files))
  check('package.json 引用的文件都存在（icon 字段若存在必须有那个文件）',
    !pkg.icon || fs.existsSync(path.join(DIR, pkg.icon)), String(pkg.icon || '(无 icon)'))

  // ── ② 挂载声明 ────────────────────────────────────────────────────
  console.log('\n── ② 挂载声明 ──')
  const patch = fs.readFileSync(path.join(DIR, 'cordis.patch.yml'), 'utf-8').replace(/\r\n/g, '\n')
  check('有 insert 段（而不是空文件糊过去）', /^-\s*insert:/m.test(patch), patch.split('\n').slice(-6).join(' | '))
  check('★ id 与 name 都等于包名（不一致 → 宿主找不到模块，表现为"装了但没出现"）',
    new RegExp('id:\\s*' + pkg.name).test(patch) && new RegExp('name:\\s*' + pkg.name).test(patch))

  // ── ③ 边界：不许 import 方寸的代码 ────────────────────────────────
  console.log('\n── ③ 边界（拆仓后还能不能用）──')
  const lib = fs.readFileSync(path.join(DIR, 'lib/index.js'), 'utf-8').replace(/\r\n/g, '\n')
  check('★ 不 import 方寸本体代码（否则两个仓锁死）',
    !/from\s+['"]\.\.\/\.\.\/(desktop|tegula)/.test(lib) && !/from\s+['"]@\//.test(lib))
  check('★ 不 import electron（插件跑在 DSH 宿主里，没有 electron）', !/from\s+['"]electron['"]/.test(lib))
  check('  只用 node 内置模块 + 方寸的对外接口（命名管道 / CLI / 文件）',
    /node:fs|from 'fs'/.test(lib) && /tegula-mcp/.test(lib))

  // ── ④ health：只说能自证的事实 ────────────────────────────────────
  console.log('\n── ④ health 自报 ──')
  const mod = await import('file://' + path.join(DIR, 'lib/index.js').replace(/\\/g, '/'))
  check('插件导出 default.name = 包名', mod.default && mod.default.name === pkg.name, String(mod.default && mod.default.name))
  check('★ 插件里的 PLUGIN_VERSION 与 package.json 一致（防两处版本漂移）',
    mod.PLUGIN_VERSION === pkg.version, mod.PLUGIN_VERSION + ' vs ' + pkg.version)

  // 造一个"像方寸数据根"的临时目录
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dsh-'))
  fs.writeFileSync(path.join(tmp, 'registry.yaml'), 'projects: []\n', 'utf-8')
  fs.mkdirSync(path.join(tmp, 'task-data'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'policies'), { recursive: true })

  const h1 = mod.collectHealth({ FANGCUN_DATA_DIR: tmp, APPDATA: path.join(tmp, 'nope') })
  check('环境变量指到数据根 → source=env 且三个目录都 found',
    h1.fangcun.source === 'env' && h1.fangcun.found.registry && h1.fangcun.found.taskData && h1.fangcun.found.policies,
    JSON.stringify(h1.fangcun))
  check('★ 认不出数据根时**返回空串，不猜路径**', (() => {
    const h = mod.collectHealth({ APPDATA: path.join(tmp, 'definitely-not-here') })
    return h.fangcun.dataDir === '' && h.fangcun.source === 'none' && h.fangcun.found.registry === false
  })())
  check('★ health 里带"还没做什么"的清单（不许让用户以为功能齐了）',
    Array.isArray(h1.todo) && h1.todo.length >= 2, JSON.stringify(h1.todo))
  check('  health 不泄露密钥类字段（只有路径与布尔）', (() => {
    // ⚠ 只扫 plugin/fangcun 两棵子树：`todo` 里出现 "token" 是**正当的**（说的是"报 token 用量"），
    //   第一版扫全量 JSON 因此假红 —— 判据要盯"凭据"，不是盯这个词。
    const s = JSON.stringify({ plugin: h1.plugin, fangcun: h1.fangcun })
    return !/api[_-]?key|apikey|password|secret|bearer|sk-[A-Za-z0-9]{8}/i.test(s)
  })())

  // ── ⑤ 注册契约 ────────────────────────────────────────────────────
  console.log('\n── ⑤ 注册契约 ──')
  check('ROUTES 里有一条 /fangcun/ 前缀的 GET 路由',
    Array.isArray(mod.ROUTES) && mod.ROUTES.some((r) => r.method === 'GET' && String(r.path).startsWith('/fangcun/')),
    JSON.stringify((mod.ROUTES || []).map((r) => r.method + ' ' + r.path)))

  // 假 res 收 handler 输出：确认真能返回 JSON（不是个空壳）
  const route = mod.ROUTES.find((r) => String(r.path).includes('health'))
  let body = ''
  const fakeRes = {
    statusCode: 0,
    setHeader() {},
    end(s) { body = String(s) },
  }
  await route.handler({ method: 'GET' }, fakeRes)
  let parsed = null
  try { parsed = JSON.parse(body) } catch { /* 下面断言会红 */ }
  check('★ handler 真能返回可解析的 JSON', fakeRes.statusCode === 200 && !!parsed && parsed.ok === true, body.slice(0, 60))

  // apply 真会往宿主注册（假 root）
  const registered = []
  const deps = []
  const fakeRoot = {
    inject(list, cb) { deps.push(list); cb({ webServer: { register: (r) => registered.push(r) } }) },
  }
  mod.default.apply(fakeRoot)
  check('★ apply 等 webServer 就绪后才注册（不会在宿主还没备好时硬塞）', deps.length === 1 && deps[0].includes('webServer'), JSON.stringify(deps))
  check('★ apply 真把路由注册进宿主', registered.length === mod.ROUTES.length, 'registered=' + registered.length)

  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }

  console.log('\n──────────────────────────────')
  if (fails.length) {
    console.log(`通过 ${pass} / 失败 ${fails.length}`)
    fails.forEach((f) => console.log('  · ' + f))
    process.exit(1)
  }
  console.log(`RESULT ${pass} / 0  —— fangcun-dsh 骨架自洽`)
})()
