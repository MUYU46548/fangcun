#!/usr/bin/env node
/**
 * 正文链接 → 磁盘路径 的解析断言（2026-11-05 暮雨第 10 条）
 *
 * 现场原话：“依然打不开日志里的文件（蓝色链接），点开方寸直接白屏永久卡死，必须大退。”
 * 两个病根，这条测试各钉一个：
 *   ① 相对路径被当成**相对进程 cwd**（打包后完全对不上）→ 文件明明在也打不开；
 *   ② 没有任何导航拦截（那条在主进程，由 e2e-renderer 的静态守卫管）。
 *
 * 真跑**编译产物** `desktop/dist/shared/linkPath.js`（纯逻辑 + fs.existsSync，不需要 electron）。
 * 全部在临时目录里造，不碰真数据根 —— 反例（`../` 越界、不存在的文件、空基准）
 * 与正例同等重要：**"能打开"和"什么都敢打开"是两件事**。
 *
 * 运行：node scripts/test/e2e-linkpath.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'linkPath.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { resolveLinkPath, insideRoot } = require(ART)

// ── 夹具：数据根 + 一个别的项目仓库 + 一个"外面"的目录 ────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-linkpath-'))
const DATA_ROOT = path.join(TMP, 'data-root')
const PROJ = path.join(TMP, 'proj-a')
const OUTSIDE = path.join(TMP, 'outside')

function touch(p, text = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}
touch(path.join(DATA_ROOT, 'desktop/src/main/data/tasks.ts'))
touch(path.join(DATA_ROOT, 'docs/执行日志/log_1.md'))
touch(path.join(DATA_ROOT, 'shared-name.ts'), 'data-root')
touch(path.join(PROJ, 'shared-name.ts'), 'proj-a')
touch(path.join(PROJ, 'src/cli.py'))
touch(path.join(OUTSIDE, 'secret.txt'), 'SECRET')
fs.mkdirSync(path.join(DATA_ROOT, 'task-data'), { recursive: true })

const ROOTS = [DATA_ROOT, PROJ]

console.log('== 正文链接 → 磁盘路径 ==')

// ── ① 绝对路径 ───────────────────────────────────────────────────────
const absHit = path.join(DATA_ROOT, 'docs/执行日志/log_1.md')
check('绝对路径（含中文目录）能命中', resolveLinkPath(absHit, ROOTS) === absHit)
check('绝对路径但文件不存在 → null（不猜同名）',
  resolveLinkPath(path.join(TMP, 'nope', 'x.md'), ROOTS) === null,
  String(resolveLinkPath(path.join(TMP, 'nope', 'x.md'), ROOTS)))

// ── ② 相对路径：这是用户报障的主场景 ─────────────────────────────────
const relHit = resolveLinkPath('desktop/src/main/data/tasks.ts', ROOTS)
check('★★ 相对数据根的路径能命中（日志里最常见的那种写法）',
  relHit === path.join(DATA_ROOT, 'desktop/src/main/data/tasks.ts'), String(relHit))
const projHit = resolveLinkPath('src/cli.py', ROOTS)
check('★★ 只在项目仓库里存在的相对路径能命中第二个基准',
  projHit === path.join(PROJ, 'src/cli.py'), String(projHit))

// 顺序优先：两个基准都有同名文件时，取**先给的那个**（数据根在前）
const dup = resolveLinkPath('shared-name.ts', ROOTS)
check('★ 多个基准都有同名文件 → 取先给的那个（不随机、不猜）',
  dup === path.join(DATA_ROOT, 'shared-name.ts'), String(dup))
const dupRev = resolveLinkPath('shared-name.ts', [PROJ, DATA_ROOT])
check('★ 反例：把基准顺序倒过来，结果跟着换（证明它真的按顺序试，不是写死数据根）',
  dupRev === path.join(PROJ, 'shared-name.ts'), String(dupRev))

// ── ③ 越界必须拒（安全判据，不是"顺便") ──────────────────────────────
const escape = resolveLinkPath('../../outside/secret.txt', ROOTS)
check('★★ `../` 跑出基准 → null（不许借链接读到项目外面的文件）',
  escape === null, String(escape))
check('★★ 反例自证：那个文件**真的存在**（所以 null 是拦截的结果，不是文件不存在）',
  fs.existsSync(path.join(OUTSIDE, 'secret.txt')))
const deepEscape = resolveLinkPath('../../../etc/passwd', ROOTS)
check('★ 多层 `../` 同样拒', deepEscape === null, String(deepEscape))

// ── ④ 不给基准 = 绝不退回 cwd ────────────────────────────────────────
const noRoots = resolveLinkPath('desktop/src/main/data/tasks.ts', [])
check('★★ 基准为空 → null（旧实现退回进程 cwd，正是"打包后打不开"的真因）',
  noRoots === null, String(noRoots))
check('   反例自证：该相对路径在**无关目录**下确实不存在（说明 null 不是巧合）',
  !fs.existsSync(path.resolve(TMP, 'desktop/src/main/data/tasks.ts')))

// ── ⑤ 编辑器式写法 ───────────────────────────────────────────────────
check('★ `foo.ts:120` 的行号被剥掉（日志里贴行号很常见）',
  resolveLinkPath('desktop/src/main/data/tasks.ts:120', ROOTS) === path.join(DATA_ROOT, 'desktop/src/main/data/tasks.ts'),
  String(resolveLinkPath('desktop/src/main/data/tasks.ts:120', ROOTS)))
check('★ `foo.md#L3` 的锚点被剥掉',
  resolveLinkPath('docs/执行日志/log_1.md#L3', ROOTS) === path.join(DATA_ROOT, 'docs/执行日志/log_1.md'),
  String(resolveLinkPath('docs/执行日志/log_1.md#L3', ROOTS)))
check('★ 引号包裹的路径被剥引号（从别处复制粘贴的常见形态）',
  resolveLinkPath('"desktop/src/main/data/tasks.ts"', ROOTS) === path.join(DATA_ROOT, 'desktop/src/main/data/tasks.ts'))

// ── ⑥ file:// URL ───────────────────────────────────────────────────
const fileUrl = 'file:///' + absHit.replace(/\\/g, '/')
check('★ `file:///…` URL 能还原成磁盘路径',
  resolveLinkPath(fileUrl, ROOTS) === absHit, fileUrl + ' → ' + String(resolveLinkPath(fileUrl, ROOTS)))

// ── ⑦ 目录也能开（资源管理器）────────────────────────────────────────
check('★ 目录路径照常返回（打开目录 = 用资源管理器打开，属于正常诉求）',
  resolveLinkPath('task-data', ROOTS) === path.join(DATA_ROOT, 'task-data'))

// ── ⑧ 坏输入一律 null，不许抛 ────────────────────────────────────────
let threw = false
try {
  check('空串 → null', resolveLinkPath('', ROOTS) === null)
  check('纯空白 → null', resolveLinkPath('   ', ROOTS) === null)
  check('null → null', resolveLinkPath(null, ROOTS) === null)
  check('undefined → null', resolveLinkPath(undefined, ROOTS) === null)
  check('roots 为 null 也不抛', resolveLinkPath('a.md', null) === null)
} catch (e) {
  threw = true
}
check('★ 以上坏输入一个都没抛异常（链接坏了不该把界面搞崩）', !threw)

// ── ⑨ insideRoot 本体 ────────────────────────────────────────────────
check('insideRoot：子路径为真', insideRoot(path.join(DATA_ROOT, 'a.md'), DATA_ROOT))
check('★ insideRoot：等于根本身为假（那是目录本身，不是"里面的文件"）',
  !insideRoot(DATA_ROOT, DATA_ROOT))
check('★ insideRoot：兄弟目录为假（`data-root2` 不是 `data-root` 里的东西）',
  !insideRoot(path.join(DATA_ROOT + '2', 'a.md'), DATA_ROOT))

// ── ⑩ 源码守卫：白屏的两个闸都必须真的在 ────────────────────────────
// 解析对但没人拦导航，一样白屏；拦了导航但渲染层没接管，用户看到的还是"点了没反应"。
// ⚠ 本机 core.autocrlf=true（CRLF）：先归一换行，否则 `\n` 判据全红（踩过）。
console.log('')
console.log('== 源码守卫（两道闸都不能少） ==')
const INDEX_SRC = path.join(REPO, 'desktop/src/index.ts')
const APP_SRC = path.join(REPO, 'desktop/src/renderer/App.vue')
const idx = fs.readFileSync(INDEX_SRC, 'utf8').replace(/\r\n/g, '\n')
const app = fs.readFileSync(APP_SRC, 'utf8').replace(/\r\n/g, '\n')

check('★★ 主进程有 will-navigate 拦截（否则点链接 = 整窗导航 = 白纸）',
  /webContents\.on\('will-navigate'/.test(idx))
check('★★ 拦下之后**交给系统打开**，不是静默丢弃（静默 = 用户以为点坏了）',
  /isOwnPage\(url\)[\s\S]{0,600}openTargetExternally\(url\)/.test(idx))
check('★★ setWindowOpenHandler 一律 deny（target=_blank 也不许开新窗）',
  /setWindowOpenHandler\([\s\S]{0,400}action:\s*'deny'/.test(idx))
check('★★ 渲染层在根元素上接管了点击（@click="onAppClick"）',
  /@click="onAppClick"/.test(app))
check('★★ 只接管正文容器（`.markdown` / `.body-text`），不吃掉卡片与工具栏的 a',
  /closest\('\.markdown, \.body-text'\)/.test(app))
// 顺序判据：preventDefault 必须在第一个 await 之前 —— 晚一步窗口就已经开始导航了。
{
  const fnAt = app.indexOf('async function onAppClick')
  const seg = fnAt >= 0 ? app.slice(fnAt, fnAt + 2200) : ''
  const pd = seg.indexOf('e.preventDefault()')
  const aw = seg.indexOf('await ')
  check('★★ onAppClick 里 preventDefault 在**第一个 await 之前**（晚一步就已经开始导航）',
    pd >= 0 && aw > pd, 'preventDefault@' + pd + ' await@' + aw)
  check('★★ 反例自证：把顺序判据套到"没有 preventDefault"的片段上必须为假',
    !((() => { const s = 'async function f(){ await x(); }'; const p = s.indexOf('e.preventDefault()'); return p >= 0 && s.indexOf('await ') > p })()))
}

// 清场
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结论 */ }

console.log('')
if (failures.length) {
  console.log('失败明细：')
  for (const f of failures) console.log('  · ' + f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
