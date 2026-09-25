/**
 * 时间解析/格式化回归（2026-09-25）
 *
 * 为什么单独测：数据里同时有 **ISO / 秒级 Unix 数字 / MM-DD** 三种写法
 *   （Python 版 tegula 写的是 `1787930114`，`new Date("1787930114")` = Invalid Date）。
 * 这类错在界面上只表现为「日期空着 / 显示 Invalid Date / N天前变成 NaN」，
 * 肉眼很难判定对错，所以用纯函数断言钉住。time.ts 不依赖 Vue/DOM，可直接 tsc 编出来跑。
 *
 * 运行：node scripts/test/e2e-timefmt.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const SRC = path.join(DESKTOP, 'src', 'shared', 'time.ts')
const OUT = path.join(os.tmpdir(), 'fc-time-' + Date.now())

let pass = 0, fail = 0
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
  const js = path.join(OUT, 'time.js')
  if (!fs.existsSync(js)) throw new Error('编译产物不存在: ' + js)
  return require(js)
}

function main() {
  const t = compile()
  const SEC = 1787930114            // Python 版 tegula 真写在文件里的值（秒级）
  const MS = SEC * 1000

  // ── A. parseTime：三种写法都要能认 ─────────────────────────────────
  check('A1 秒级数字字符串不再是 Invalid Date', Number.isFinite(t.parseTime(String(SEC))))
  check('A2 秒级数字（number）等价于字符串', t.parseTime(SEC) === t.parseTime(String(SEC)))
  check('A3 毫秒数字按毫秒算', t.parseTime(MS) === t.parseTime(SEC))
  check('A4 秒级/毫秒级不混淆（阈值 1e11）', t.parseTime(MS) !== t.parseTime(String(MS)) / 1000)
  check('A5 ISO 能解析', t.parseTime('2026-09-25T08:52:56.605Z') === Date.parse('2026-09-25T08:52:56.605Z'))
  check('A6 YYYY-MM-DD 能解析', Number.isFinite(t.parseTime('2026-09-25')))
  const md = t.parseTime('09-30')
  const mdDate = new Date(md)
  check('A7 MM-DD 按今年补年份', Number.isFinite(md) && mdDate.getMonth() === 8 && mdDate.getDate() === 30,
    String(mdDate))
  check('A8 空值/垃圾一律 NaN（不返回 Invalid Date）',
    [NaN, null, undefined, '', '   ', 'abc', {}, []].every(v => Number.isNaN(t.parseTime(v))))
  check('A9 Date 对象原样接受', t.parseTime(new Date(MS)) === MS)

  // ── B. formatDate：坏输入给 '—'，好输入如实显示 ────────────────────
  const fSec = t.formatDate(String(SEC))
  check('B1 秒级时间戳能正常显示（不是 Invalid Date）',
    fSec !== 'Invalid Date' && fSec !== '—' && fSec.length >= 8, fSec)
  check('B2 秒级与毫秒显示一致', t.formatDate(String(SEC)) === t.formatDate(String(MS)))
  check('B3 空值给 —', t.formatDate('') === '—' && t.formatDate(undefined) === '—')
  check('B4 垃圾给 —（不是 Invalid Date）', t.formatDate('abc') === '—', t.formatDate('abc'))
  check('B5 ISO 正常显示', t.formatDate('2026-09-25T08:52:56.605Z') !== '—')

  // ── C. relativeTime / daysSince / relTimeShort 不出现 NaN ──────────
  check('C1 垃圾输入相对时间给空串（不是 NaN月前）', t.relativeTime('abc') === '', t.relativeTime('abc'))
  check('C2 今天识别为「今天」', t.relativeTime(new Date().toISOString()) === '今天')
  check('C3 秒级时间戳能算出相对时间', t.relativeTime(String(SEC)).length > 0, t.relativeTime(String(SEC)))
  const d1 = t.daysSince(String(SEC))
  check('C4 daysSince 秒级能算且不是 NaN', Number.isFinite(d1) && d1 > 0, String(d1))
  check('C5 daysSince 垃圾给 NaN（调用方必须自己兜底）', Number.isNaN(t.daysSince('abc')))
  check('C6 relTimeShort 刚刚', t.relTimeShort(new Date().toISOString()) === '刚刚', t.relTimeShort(new Date().toISOString()))
  check('C7 relTimeShort 垃圾给空串', t.relTimeShort('abc') === '')
  check('C8 formatDateTime 兜底原字符串（备份状态那种人类文本）',
    t.formatDateTime('未同步') === '未同步', t.formatDateTime('未同步'))
  check('C9 formatDateTime 正常格式化', /^\d{1,2}-\d{2} \d{2}:\d{2}$/.test(t.formatDateTime(String(MS))),
    t.formatDateTime(String(MS)))

  // ── D. 接线（源码断言，防漂移 / 防有人把本地实现加回来）───────────
  const vue = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'App.vue'), 'utf8')
  check('D1 App.vue 从 shared/time 取日期工具', /from '\.\.\/shared\/time'/.test(vue))
  check('D2 没有再把本地 formatDate 定义加回来', !/function formatDate\(/.test(vue))
  check('D3 没有本地 relativeTime 定义', !/function relativeTime\(/.test(vue))
  check('D4 isStale 走 daysSince（坏日期不会误判为停滞）', /const days = daysSince\(t\.updated\)/.test(vue))
  check('D5 computeHealth 走 daysSince', /const days = daysSince\(lastActivity\)/.test(vue))
  check('D6 全屏遮罩不再有 backdrop-filter（失焦不重绘的元凶）',
    /\.overlay \{[^}]*\}/.test(vue) && !/\.overlay \{[^}]*backdrop-filter/.test(vue),
    'overlay 规则里出现了 backdrop-filter')
  check('D7 通知面板遮罩同样没有 backdrop-filter',
    !/\.nc-wrap \{[^}]*backdrop-filter/.test(vue))

  console.log('─'.repeat(50))
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); process.exitCode = 1 }
  console.log(`RESULT ${pass} / ${fail}`)
}

try { main() } catch (e) { console.error('测试框架异常：', e); process.exitCode = 1; console.log('RESULT 0 / 1') }
