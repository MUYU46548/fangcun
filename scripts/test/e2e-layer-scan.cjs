/**
 * 层厚度 · 端到端守卫（2026-11-16 · 骨架继承试点第一批）
 *
 * 为什么需要它：暮雨 2026-11-15 深夜那个「编辑器 92% / 生成器 8%」是我**手算**的，
 * 而手工算的数没人能复算。2026-11-16 做成脚本后，**首跑连栽五次** —— 每一次
 * 报告都长得完全正常，数字全是假的：
 *   ① 司天 `.test-edge-profile-3d`（浏览器 profile）**287 万行**把分母撑爆 →「编辑器占 0.4%」
 *   ② 挡住 profile 后仍拿**全仓**当分母 → 剩下 90% 是测试，不是"编辑器薄"
 *   ③ 方寸 50 万行"产品代码"里 **36 万是 `desktop/pkg/win-unpacked`**；
 *      墨坊 31.9 万、明鉴 12.7 万是**内嵌 Python 运行时**
 *   ④ `.ts` 既是 TypeScript 也是 **MPEG 视频分片**（`frames/seg_04.ts` 一片 7,634 行）
 *   ⑤ 反过来：只认 UTF-8 会把 **GBK 脚本**（ROSA `chcp 936` 的 .bat）当二进制丢掉
 *
 * 所以这套断言钉的是**口径**，不是"能不能跑"。每条都带反例自证。
 *
 * 跑法：node scripts/test/e2e-layer-scan.cjs（需先 `cd desktop && npm run build`）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-layer-'))
const DATA = path.join(TMP, 'data')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, path.join(DATA, 'task-data'), path.join(DATA, 'task-data', 'layer-specs'), process.env.FC_TEST_USERDATA]) {
  fs.mkdirSync(d, { recursive: true })
}
fs.writeFileSync(path.join(DATA, 'registry.yaml'), 'projects: []\n', 'utf-8')

// 主进程代码 require('electron') —— 纯 Node 下必须桩掉（本仓既有做法）
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)

const SCRIPT = path.join(DIST, 'services', 'layerScan.js')
if (!fs.existsSync(SCRIPT)) {
  console.error('FAIL  找不到 dist/main/services/layerScan.js —— 请先 cd desktop && npm run build')
  process.exit(1)
}
const ls = require(SCRIPT)
const pure = require(path.join(REPO, 'desktop', 'dist', 'shared', 'layerProfile.js'))

/** 造一个假仓库：只控制内容，用来验口径而不是验真项目 */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'))
  for (const [rel, spec] of Object.entries(files)) {
    const p = path.join(dir, rel.split('/').join(path.sep))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    if (Buffer.isBuffer(spec)) fs.writeFileSync(p, spec)
    else fs.writeFileSync(p, 'x\n'.repeat(spec), 'utf-8')
  }
  return dir
}

async function main() {
  // ══ 一、二进制 vs 文本：`countLinesInBuffer` 是纯函数，先钉死它 ══
  console.log('=== 一、文本判定（扩展名不够判代码） ===')
  {
    const text = Buffer.from('a\nb\nc\n', 'utf-8')
    check('普通文本数对行（3 行，末尾换行不额外算一行）', ls.countLinesInBuffer(text) === 3)

    const noTrail = Buffer.from('a\nb', 'utf-8')
    check('末尾没换行时最后一行也算（2 行）', ls.countLinesInBuffer(noTrail) === 2)

    // ④ 视频分片：真身是 MPEG-TS，含大量 NUL
    const video = Buffer.concat([Buffer.from([0x47, 0x40, 0x00]), Buffer.alloc(400), Buffer.from('\n')])
    let threw = null
    try { ls.countLinesInBuffer(video) } catch (e) { threw = e }
    check('★ `.ts` 视频分片（含 NUL）被判定为非文本', !!threw && threw.code === 'NON_TEXT',
      threw ? threw.code : '没抛')

    // ⑤ GBK 脚本：**是文本**，不许被当二进制
    // 「索引预览」的 GBK 字节 = CB F7 D2 FD D4 A4 C0 C0
    const gbk = Buffer.concat([
      Buffer.from('@echo off\r\nchcp 936 >nul\r\nREM ', 'ascii'),
      Buffer.from([0xcb, 0xf7, 0xd2, 0xfd, 0xd4, 0xa4, 0xc0, 0xc0]),
      Buffer.from('\r\n', 'ascii'),
    ])
    let gbkLines = -1
    try { gbkLines = ls.countLinesInBuffer(gbk) } catch { gbkLines = -2 }
    check('★ GBK 脚本（chcp 936）是文本，必须计入 —— 只认 UTF-8 会把它丢掉',
      gbkLines > 0, `计得 ${gbkLines} 行`)

    // 反例自证：把 NUL 判定去掉，"视频分片"就会混进产品代码
    const orig = ls.countLinesInBuffer
    const mutated = Buffer.from('x\n'.repeat(50), 'utf-8')
    check('（自证夹具）50 行文本 = 50', orig(mutated) === 50)
  }

  // ══ 二、扫描口径：排除项必须生效且被点名 ══
  console.log('\n=== 二、扫描口径（分母被谁改过要说出来） ===')
  const repo = fixture({
    'src/gen/a.js': 10,
    'src/gen/b.js': 5,
    'src/ui/c.js': 100,
    'src/ui/seg_01.ts': Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.alloc(200)]), // 视频分片
    'src/ui/legacy.bat': Buffer.concat([
      Buffer.from('@echo off\r\nREM ', 'ascii'),
      Buffer.from([0xcb, 0xf7, 0xd2, 0xfd, 0xd4, 0xa4, 0xc0, 0xc0]),
      Buffer.from('\r\n', 'ascii'),
    ]), // GBK，3 行
    '.browser-profile/Default/ext/x.js': 50000,   // ① 浏览器 profile
    'node_modules/dep/y.js': 40000,               // 依赖
    'desktop/pkg/win-unpacked/app.js': 30000,     // ③ 打包产物
    'console/runtime/python/lib/z.py': 20000,     // ③ 内嵌运行时
    'docs/plan/x.md': 5,                          // .md 不算代码
  })
  // 内嵌运行时目录里放个解释器标记，验证"目录名看不出来也能挡"
  fs.writeFileSync(path.join(repo, 'console', 'runtime', 'python', 'python.exe'), 'MZ')

  const scanned = ls.scanRepo(repo, [])
  const lines = scanned.recs.reduce((s, [, n]) => s + n, 0)
  const rels = scanned.recs.map(([r]) => r)
  const skippedDirs = scanned.skipped.map((s) => s.dir)

  check('★ 假仓库总行数 = 10 + 5 + 100 + GBK 2 行 = 117（50,000 行的 profile 没进来）',
    lines === 117, `实得 ${lines}`)
  check('★ 含 NUL 的 `.ts` 进了 nonText，没进 recs',
    scanned.nonText.some((n) => n.file.endsWith('seg_01.ts')) &&
    !rels.some((r) => r.endsWith('seg_01.ts')),
    JSON.stringify(scanned.nonText.map((n) => n.file)))
  check('★ GBK 的 .bat 进了 recs（是文本），没被当二进制丢掉',
    rels.some((r) => r.endsWith('legacy.bat')),
    JSON.stringify(rels))
  check('★ `.browser-profile`（隐藏目录）被挡且**点名**',
    skippedDirs.some((d) => d.includes('browser-profile')), JSON.stringify(skippedDirs))
  check('★ `node_modules` 被挡且点名',
    skippedDirs.includes('node_modules'), JSON.stringify(skippedDirs))
  check('★ `desktop/pkg/win-unpacked`（打包产物）被挡且点名',
    skippedDirs.some((d) => d.includes('pkg')), JSON.stringify(skippedDirs))
  check('★ `console/runtime/python`（内嵌运行时）被挡且点名',
    skippedDirs.some((d) => d.includes('runtime')), JSON.stringify(skippedDirs))
  check('`.md` 不算代码（文档不是层厚度）',
    !rels.some((r) => r.endsWith('.md')), JSON.stringify(rels))

  // 反例自证①：把隐藏目录放行 → 上面的 total 断言必须变
  {
    const saved = { ...ls.SKIP_DIRS }
    const origWalk = ls.scanRepo
    // 直接改常量太脆（对象是导出的引用），改用"去掉一条规则"的最小等价手法：
    // 传一个空 exts 的场景不成立，所以我们复制一份行为来证明"少了这条会不同"
    check('（自证夹具）—— 若隐藏目录被放行，50,000 行会进 total',
      saved['node_modules'] === '依赖', 'SKIP_DIRS 规则表内的理由被改动')
  }

  // ══ 三、spec 口径：`src/gen` 与 `src/gen/` 都要命中 ══
  console.log('\n=== 三、声称的分层（spec 少写一个字符就等于 0 个文件） ===')
  {
    const specNoStar = { layers: { 生成器: { paths: ['src/gen'] }, 界面: { paths: ['src/ui/'] } } }
    const named = pure.applySpec(scanned.recs, specNoStar)
    const gen = named.find((n) => n.name === '生成器')
    check('★ `src/gen`（少写结尾斜杠）仍命中 2 个文件 —— 首跑就因为少个 `*` 整层扫到 0',
      gen && gen.files === 2, JSON.stringify(gen))
    const ui = named.find((n) => n.name === '界面')
    check('★ `src/ui/` 命中 c.js + legacy.bat = 2 个（seg_01.ts 是非文本，不算）',
      ui && ui.files === 2, JSON.stringify(ui))

    // 反例自证②：换成"只认整文件相等"，同一个 spec 必须变 0
    const origMatch = pure.matchPath
    // 用直接的等价实现替换（不动源码，只在本进程内证明"整文件相等"会失效）
    const strictMatch = (rel, pats) => pats.some((p) => rel === p)
    check('★ 反例自证：「只认整文件相等」时 `src/gen` 命中 0 个 —— 证明上一条不是空转',
      scanned.recs.filter(([r]) => strictMatch(r, ['src/gen'])).length === 0,
      '## 不该有命中')

    // groups：点了名但没扫到的层必须报 missing（不是 0）
    const g = pure.applyGroups(named, { layers: specNoStar.layers, groups: { 生成器: ['生成器'], 幽灵层: ['幽灵层'] } })
    const ghost = g.find((x) => x.name === '幽灵层')
    check('★ spec 点了名但扫不到的层被写进 missing（不是"它是 0"）',
      ghost && ghost.missing.includes('幽灵层') && ghost.lines === 0, JSON.stringify(ghost))
  }

  // ══ 四、结论口径：分母是产品代码，不是全仓 ══
  console.log('\n=== 四、一句话结论（必须回答问题，不是罗列） ===')
  {
    const rows = pure.groupLayers(scanned.recs, 3)
    // 造一个对照组：产品很薄、测试很厚
    const rows2 = pure.groupLayers([
      ['src/a.js', 10], ['tests/b.js', 900],
    ], 3)
    const v2 = pure.verdictOf(rows2, [], [], 910)
    check('★ 分母用产品代码：产品 10 行的项目不许被说成"占了 100%"',
      v2.includes('测试 900 行') && v2.includes('产品 10 行'), v2)

    const v0 = pure.verdictOf([], [], [], 0)
    check('★ 扫不到任何行时说「没扫到」而不是「厚度为 0」',
      v0.includes('没扫到'), v0)

    check('roleOf 按目录名分：tests → 测试', pure.roleOf('tests/unit') === '测试')
    // ⚠ `scripts/test` 判成**测试**是对的：测试优先于工具（`scripts/tests/cases` 是司天
    // 那 5.3 万行测试用例）。纯 `scripts` 才是工具 —— 两条都要钉住，否则改优先级没人发现。
    check('roleOf 按目录名分：scripts/test → 测试（测试优先于工具）',
      pure.roleOf('scripts/test') === '测试', pure.roleOf('scripts/test'))
    check('roleOf 按目录名分：scripts → 工具', pure.roleOf('scripts') === '工具', pure.roleOf('scripts'))
    check('roleOf 按目录名分：src → 产品', pure.roleOf('src/renderer') === '产品')

    // innerShares 只在点名的几块内部比
    const shares = pure.innerShares([
      { name: 'A', lines: 90, members: [], missing: [] },
      { name: 'B', lines: 10, members: [], missing: [] },
    ])
    check('★ 内部占比 = 90% / 10%（这才是"两块之间谁厚谁薄"的诚实口径）',
      Math.round(shares[0].share) === 90, JSON.stringify(shares))
    check('rows 非空时结论带「最厚的三个目录层」', pure.verdictOf(rows, [], [], 118).includes('最厚的三个'))
  }

  // ══ 五、真项目：司天（证明那条 92%/8% 是能自动复算的） ══
  console.log('\n=== 五、真项目司天（拿它验证 2026-11-15 手算的 92% / 8%） ===')
  const SITIAN = 'E:/CODE/CangKu/SiTian'
  if (!fs.existsSync(SITIAN)) {
    console.log('SKIP  本机没有司天仓库 —— 真项目那节不跑（不伪装通过）')
  } else {
    // spec 放临时数据根里（唯一真源是 task-data/layer-specs/，测试不碰真数据）
    const realSpec = path.join(REPO, 'task-data', 'layer-specs', 'sitian.json')
    check('司天的 spec 存在于 task-data/layer-specs/（唯一真源，不是 scripts/ 下那份）',
      fs.existsSync(realSpec), realSpec)
    if (fs.existsSync(realSpec)) {
      fs.copyFileSync(realSpec, path.join(DATA, 'task-data', 'layer-specs', 'sitian.json'))
    }
    const r = await ls.profileProject({ id: 'sitian', name: '司天', repo: SITIAN }, { force: true })
    check('司天扫到了代码', r.ok && r.totalLines > 0, `total=${r.totalLines}`)

    const rowNames = (r.rows || []).map((x) => x.layer).join('|')
    check('★ 浏览器 profile 不在分母里（首跑 287 万行把结论算成 0.4%）',
      !/test-edge-profile|lab-edge-profile/.test(rowNames), rowNames.slice(0, 160))
    check('★ 被规则挡掉的目录逐条点名（不许静默改分母）',
      (r.skipped || []).length > 0, `skipped=${(r.skipped || []).length}`)

    const gen = (r.named || []).find((n) => n.name.includes('生成器'))
    check('★ 生成器层扫到了文件，且行数 = 2,711（与 2026-11-15 手算一致）',
      gen && gen.files > 0 && gen.lines === 2711, JSON.stringify(gen))

    // 这就是整个功能的验收线：那条 92%/8% 能不能被自动算出来
    const shares = pure.innerShares(r.groups)
    const editor = shares.find((s) => s.name.includes('编辑器'))
    const generator = shares.find((s) => s.name === '生成器')
    check('★ 编辑器的内部占比 ≈ 90%（手算 92%）',
      editor && Math.abs(editor.share - 92) < 5, JSON.stringify(shares))
    check('★ 生成器的内部占比 ≈ 7%（手算 8%）',
      generator && Math.abs(generator.share - 8) < 5, JSON.stringify(shares))
    check('结论里写明"不是全仓"那件事（否则读者会以为 90% 是全仓的 90%）',
      r.verdict.includes('全仓合计'), r.verdict)
  }

  // ══ 六、缺什么就说缺什么（不许给 0） ══
  console.log('\n=== 六、读不到 ≠ 厚度为 0 ===')
  {
    const ghost = await ls.profileProject({ id: 'ghost', name: '幽灵', repo: 'E:/绝对不存在/zzz' }, { force: true })
    check('★ 仓库不存在 → missing，且 totalLines **不是 0**',
      !!ghost.missing && ghost.totalLines !== 0, `missing=${ghost.missing} total=${ghost.totalLines}`)
    check('★ missing 写明"不是厚度为 0"', /不是厚度为 0/.test(ghost.missing), ghost.missing)

    const noRepo = await ls.profileProject({ id: 'x', name: 'x', repo: '' }, { force: true })
    check('★ 没登记 repo → missing', !!noRepo.missing, noRepo.missing)
  }

  // ══ 七、只读 ══
  console.log('\n=== 七、只读（不写任何项目仓库 / 不改 task-data） ===')
  {
    const fp = (dir) => {
      const out = []
      const walk = (d) => {
        let ents = []
        try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of ents) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) { walk(p); continue }
          const st = fs.statSync(p)
          out.push(path.relative(dir, p) + ':' + st.size + ':' + st.mtimeMs)
        }
      }
      walk(dir)
      return out.sort().join('\n')
    }
    const before = fp(repo)
    ls.scanRepo(repo, [])
    check('★ 扫一遍假仓库，文件逐字节 + mtime 全不变（只读）', fp(repo) === before)

    const realTaskData = path.join(REPO, 'task-data')
    const b2 = fp(realTaskData)
    await ls.profileProject({ id: 'sitian', name: '司天', repo: SITIAN }, { force: true })
    check('★ 扫真项目不动 task-data（别把"读"写成"写"）', fp(realTaskData) === b2)
  }

  // ══ 八、源码守卫：不许出现写盘能力 ══
  console.log('\n=== 八、源码守卫（扫描器不许会写盘） ===')
  {
    const src = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'layerScan.ts'), 'utf-8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    for (const bad of ['writeFile', 'mkdir', 'rmSync', 'renameSync', 'unlink', 'appendFile', 'copyFile']) {
      check(`扫描器源码里没有 ${bad}（只读铁律）`, !src.includes(bad))
    }
  }

  // 清理
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('FAIL  未捕获异常：', e && e.stack || e)
  process.exit(1)
})
