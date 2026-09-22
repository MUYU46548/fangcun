/**
 * 日志导入去重（同名 + 正文内容指纹）测试（2026-09-22）
 *
 * 用户要求：「同名拦截帮我加正文内容哈希比对」。
 * 规范化/指纹这类东西只要有一点偏差就会"有时候拦得住有时候拦不住"，
 * 而这种错误在界面上几乎无法复现 —— 所以必须落在纯函数里被脚本断言。
 *
 * 运行：node scripts/test/e2e-logdedupe.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const SRC = path.join(DESKTOP, 'src', 'renderer', 'logdedupe.ts')
const OUT = path.join(os.tmpdir(), 'fc-dedupe-' + Date.now())

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function compile() {
  fs.mkdirSync(OUT, { recursive: true })
  execFileSync(process.execPath, [
    path.join(DESKTOP, 'node_modules', 'typescript', 'bin', 'tsc'),
    SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'ES2020',
    '--strict', 'false', '--skipLibCheck',
  ], { cwd: DESKTOP, stdio: 'pipe' })
  const js = path.join(OUT, 'logdedupe.js')
  if (!fs.existsSync(js)) throw new Error('编译产物不存在: ' + js)
  return require(js)
}

function main() {
  console.log('== 日志导入去重 e2e ==')
  let d
  try {
    d = compile()
  } catch (e) {
    console.log('FAIL  编译 logdedupe.ts 失败:', e.message)
    process.exit(1)
  }

  // ── 1. 规范化 ─────────────────────────────────────────────────────
  check('CRLF 与 LF 视为同一份', d.normalizeLogText('a\r\nb') === d.normalizeLogText('a\nb'))
  check('行尾空白不影响', d.normalizeLogText('a   \nb\t') === d.normalizeLogText('a\nb'))
  check('空行不影响', d.normalizeLogText('a\n\n\nb') === 'a\nb')
  check('大小写不敏感', d.normalizeLogText('Hello') === d.normalizeLogText('hello'))
  check('首行 markdown 标题被忽略', d.normalizeLogText('# 标题\n正文') === '正文')
  check('二级标题开头同样忽略', d.normalizeLogText('## 小标题\n正文') === '正文')
  check('正文中间的同级标题不忽略', d.normalizeLogText('正文\n# 中间标题') === '正文\n# 中间标题')

  // ── 2. 指纹 ───────────────────────────────────────────────────────
  const fa = d.textFingerprint('第一份内容')
  check('指纹非空且带长度后缀', /^[0-9a-f]{8}:\d+$/.test(fa), fa)
  check('相同内容指纹一致', fa === d.textFingerprint('第一份内容'))
  check('不同内容指纹不同', fa !== d.textFingerprint('第二份内容'))
  check('空内容指纹为空（不参与内容判重）', d.textFingerprint('') === '' && d.textFingerprint('   \n ') === '')
  check('写法差异（换行/空格）指纹一致',
    d.textFingerprint('A\r\nB  ') === d.textFingerprint('a\n\nb'))
  check('★ 改名不改内容 → sameContent 为真',
    d.sameContent('# 旧标题\n同一份正文', '# 新标题\n同一份正文'))
  check('内容不同 → sameContent 为假', !d.sameContent('正文甲', '正文乙'))
  check('空内容之间不算同内容', !d.sameContent('', ''))
  check('长文本指纹稳定（不因长度溢出而漂移）',
    d.textFingerprint('x'.repeat(5000)) === d.textFingerprint('x'.repeat(5000)))

  // ── 3. 分类 ───────────────────────────────────────────────────────
  const existing = [
    { title: '日报', content: '# 日报\n今天做了 A 和 B' },
    { title: '周报', content: '本周重点：打包' },
    { title: '空日志', content: '' },
  ]

  let r = d.classifyLogImport([{ title: '新文件', text: '完全新的内容' }], existing)
  check('全新技术上算 fresh', r.fresh.length === 1 && r.dupTitle.length === 0 && r.dupContent.length === 0)

  r = d.classifyLogImport([{ title: '日报', text: '完全不同的内容' }], existing)
  check('同名（内容不同）→ dupTitle', r.dupTitle.length === 1 && r.fresh.length === 0, JSON.stringify(r))

  r = d.classifyLogImport([{ title: '日报改名版', text: '# 日报\n今天做了 A 和 B' }], existing)
  check('★ 改名但同内容 → dupContent（用户要的那条）', r.dupContent.length === 1 && r.fresh.length === 0, JSON.stringify(r))

  // 同一个文件被改名 + 行尾差异（真实场景：另存/复制粘贴带 CRLF），内容仍应判同
  r = d.classifyLogImport([{ title: '日报改名版', text: '# 日报\r\n今天做了 A 和 B   \r\n' }], existing)
  check('★ 改名 + 换行/空白差异仍判同内容', r.dupContent.length === 1, JSON.stringify(r))

  // 文件首行是"裸标题"（没有 #），与库里存的 markdown 标题写法不同 —— 标题感知归一
  r = d.classifyLogImport([{ title: '日报', text: '日报\n今天做了 A 和 B' }], existing)
  check('★ 首行裸标题 vs markdown 标题写法差异仍判同内容', r.dupTitle.length + r.dupContent.length === 1, JSON.stringify(r))

  r = d.classifyLogImport([{ title: '新空文件', text: '   ' }], existing)
  check('空内容不因"同为空白"被误拦（且标题不冲突时放行）', r.fresh.length === 1, JSON.stringify(r))

  r = d.classifyLogImport([
    { title: '甲', text: '同一内容' },
    { title: '乙', text: '同一内容' },
  ], [])
  check('批内同内容第二次被拦', r.fresh.length === 1 && r.dupInBatch.length === 1, JSON.stringify(r))

  r = d.classifyLogImport([
    { title: '丙', text: 'A' },
    { title: '丙', text: 'B' },
  ], [])
  check('批内同名第二次被拦', r.fresh.length === 1 && r.dupInBatch.length === 1, JSON.stringify(r))

  r = d.classifyLogImport([
    { title: '新', text: 'n1' },
    { title: '旧', text: 'o1' },
  ], [{ title: '旧', content: 'o1' }])
  check('混合场景：只放行干净的', r.fresh.length === 1 && r.fresh[0].title === '新' && r.dupTitle.length === 1)

  r = d.classifyLogImport([], existing)
  check('空输入不炸', r.fresh.length === 0 && r.dupTitle.length === 0)

  check('摘要含"同内容"字样', /同内容/.test(d.classifySummary({ fresh: [], dupTitle: [], dupContent: ['x'], dupInBatch: [] })))
  check('无重复时摘要报数量', d.classifySummary({ fresh: [1, 2], dupTitle: [], dupContent: [], dupInBatch: [] }) === '将导入 2 个文件',
    d.classifySummary({ fresh: [1, 2], dupTitle: [], dupContent: [], dupInBatch: [] }))

  // ── 4. 渲染层确实在用（防漂移）────────────────────────────────────
  const appVue = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'App.vue'), 'utf-8')
  check('App.vue 导入 logdedupe', /from '\.\/logdedupe'/.test(appVue))
  check('App.vue 使用 classifyLogImport', /classifyLogImport\(/.test(appVue))
  check('App.vue 的确认文案点明按内容指纹判定', /内容指纹/.test(appVue))
  check('导入路径不再自己拼 Set 判重', !/const existing = new Set<string>\(\)/.test(appVue))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
