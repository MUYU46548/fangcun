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
  // ⚠ 2026-10-23：自 App.vue 拆分后，模板/样式散在 App.vue + views/*.vue + composables/*.ts，
  //   这里扫全部渲染层源码（判据只更严：原来"App.vue 里不许有"现在等于"任何渲染层文件都不许有"）。
  // ⚠ 2026-10-31：全局样式已外置到 styles/app.css（`<style src>`），D6/D9/D16 要找的
  //   `.overlay` / `.blob` 规则现在只住在那里 —— 把 css 一起纳入扫描，否则三条断言永远绿不了。
  const vue = require('./_sources.cjs').rendererSource()
    + '\n' + fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'styles', 'app.css'), 'utf8')
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

  // D8/D9（2026-09-25 新增）：上轮的教训是「清了一个元素，漏了另一个」——
  //   .overlay / .nc-wrap 都清了，却把**常驻**的 #bar 留着，用户第 1/3/9 条因此复发。
  //   所以判据从「逐元素白名单」改成「全文件零容忍」。剥注释后再判，否则撞自己写的说明文字。
  const vueNoComment = vue.replace(/\/\*[\s\S]*?\*\//g, '')
  const bfCount = (vueNoComment.match(/backdrop-filter/g) || []).length
  check('D8 App.vue 全域零 backdrop-filter（不再一个元素一个元素地漏）',
    bfCount === 0, `backdrop-filter 仍出现 ${bfCount} 次`)
  check('D9 装饰光斑保留合成层提升（blur 结果缓存成纹理，不随每次合成重算）',
    /\.blob \{[^}]*filter: blur\(/.test(vueNoComment) && /\.blob \{[^}]*will-change: transform/.test(vueNoComment),
    '.blob 缺 filter: blur 或 will-change: transform')

  // D10–D12（2026-09-25 第二批）：
  //   D10 快捷键 Ctrl+S —「通道早通、UI 无入口」的教训：新功能必须证明**真挂上了**，
  //       而且**卸载时摘干净**（ncInit 那套曾因早退导致监听器根本不注册）。
  //       更要紧的是**只点主保存按钮 `.pri`**：验收弹窗的「通过」是 `.ok`、驳回是 `.danger`，
  //       裁决类必须用手点 —— Ctrl+S 误触一下就把任务验收了。
  //   D12 日历底部「横条墙」默认收起（第 10 条），别退回一铺一大片。
  check('D10 快捷键：挂载 + 卸载 + 只点主保存按钮（.pri），不碰裁决按钮',
    /addEventListener\('keydown', onShortcutKeydown\)/.test(vueNoComment) &&
    /removeEventListener\('keydown', onShortcutKeydown\)/.test(vueNoComment) &&
    /querySelector<HTMLButtonElement>\('\.acts button\.pri'\)/.test(vueNoComment) &&
    !/querySelector[^\n]*\.acts button\.(ok|danger)/.test(vueNoComment),
    '缺挂载/卸载，或动了裁决按钮')
  // ⚠ 2026-10-23 改写：原判据是「**完全不**接管 Ctrl+Z」，那是 2026-09-25 的规则。
  //   2026-10-21 暮雨第 1 条（「狂按 Ctrl+Z 也没用」）改成了**有条件的接管**：
  //   撤销条上有待撤动作 → 撤这一步数据动作；没有 → 放行输入框的原生撤销。
  //   所以新的判据不是"不许出现 key === 'z'"，而是**顺序**：
  //   必须先 `if (!undoBar.value) return` 再 `preventDefault()`。
  //   顺序反了就会把输入框里的撤销吃掉 —— 这正是当初那条断言要保护的用户体验。
  // ⚠ 判据必须看**顺序**，不能用「A 之后 B 在 200 字内」那种窗口：
  //   第一版就是这么写的，结果把 Ctrl+S 分支里的 preventDefault 匹配上了 ——
  //   把两行顺序颠倒（先拦后判）照样全绿，等于没写。现在先切出 Ctrl+Z 这一段，再比下标。
  const zBranch = (vueNoComment.match(/if \(e\.key === 'z' \|\| e\.key === 'Z'\) \{([\s\S]{0,900}?)\n  \}/) || [])[1] || ''
  const zGuard = zBranch.indexOf('if (!undoBar.value) return')
  const zPrevent = zBranch.indexOf('e.preventDefault()')
  check('D11 Ctrl+Z：撤销条在才接管，没有待撤动作就放行原生撤销（先判后拦）',
    !!zBranch && zGuard >= 0 && zPrevent > zGuard,
    zBranch
      ? `guard@${zGuard} preventDefault@${zPrevent}（必须是 guard 在前）`
      : '没找到 Ctrl+Z 分支（快捷键被删了？）')
  check('D12 日历底部横条默认收起（第 10 条：不再一铺一大片）',
    /calBottomOpen = ref\(false\)/.test(vueNoComment) && /class="cal-more"/.test(vueNoComment))

  // D13–D15（2026-09-27 用户第 2/3 条：「怪异遮罩挡字」+「不同颜色外观下可读性差」）
  //   D13 Python 版看板还有 13 处 backdrop-filter（含常驻顶栏）——同一条铁律只清了桌面版，
  //       这次扫到就把两个前端一起钉住（判据仍是「全文件零容忍」）。
  //   D14 两个前端共用同一套设计令牌：改一处忘另一处 = 同一个界面两副面孔。
  //   D15 遮罩不许再有「全屏 + 带 blur」的形状（死 CSS 也算：留着会让人以为真有这一层）。
  const board = fs.readFileSync(path.join(ROOT, 'templates', 'board.html'), 'utf8')
  const boardNoComment = board.replace(/\/\*[\s\S]*?\*\//g, '')
  const boardBf = (boardNoComment.match(/backdrop-filter/g) || []).length
  check('D13 board.html（Python 版看板）同样零 backdrop-filter', boardBf === 0, `仍出现 ${boardBf} 次`)
  const pick = (src, name) => (new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(src) || [])[1]
  const tokens = ['accent', 'muted', 'danger', 'success', 'warning'].filter((t) => pick(vue, t) || pick(board, t))
  const drift = tokens.filter((t) => pick(vue, t) && pick(board, t) && pick(vue, t).toLowerCase() !== pick(board, t).toLowerCase())
  check('D14 两个前端的品牌色令牌一致（accent/muted/danger/success/warning）',
    drift.length === 0, `不一致：${drift.map((t) => `${t} 桌面=${pick(vue, t)} 看板=${pick(board, t)}`).join(' , ')}`)
  check('D15 没有「全屏 + backdrop-filter」的遮罩残留（含死 CSS）',
    !/inset:0[^}]*backdrop-filter/.test(boardNoComment) && !/inset:\s*0[^}]*backdrop-filter/.test(vueNoComment))

  // D16（2026-09-28 用户第 1 条）：**装饰层必须真的在背景层**。
  //   `.blob`（左上角 460×460 淡紫光斑）一直是 `position: fixed` + `z-index: 0`，
  //   而看板的 .col / 卡片都是**非定位的流内元素**。按 CSS 绘制顺序：
  //     负 z 子层 → 流内块背景 → 行内内容 → z-index:0/auto 的**已定位**元素
  //   也就是说 z-index:0 的它画在所有正文**之上**，只被 z-index:2 的 #bar / #views 挡着 ——
  //   "淡淡一层紫盖住左上角文字"就是这么来的。它同时是 pointer-events:none，
  //   所以既不响应点击、也不会被命中测试抓到（上一轮"无盖字"断言因此漏报）。
  //   判据：装饰光斑的 z-index 必须是负的（真的落到背景层）。
  const blobRule = (/(^|\n)\s*\.blob\s*\{[^}]*\}/.exec(vueNoComment) || [])[0] || ''
  const blobZ = (/z-index:\s*(-?\d+)/.exec(blobRule) || [])[1]
  check('D16 装饰光斑（.blob）在背景层：z-index 为负，不画在正文之上',
    blobRule !== '' && blobZ !== undefined && parseInt(blobZ, 10) < 0,
    `规则=${blobRule.replace(/\s+/g, ' ').slice(0, 120)} z-index=${blobZ}`)

  // D17（2026-10-03 卡 task-20261003-004·族1）：老看板编辑弹窗必须有关闭防丢。
  //   保存时的 expected_update 乐观锁防的是并发覆盖，防不了「点遮罩/取消/Esc 把没保存的
  //   编辑丢掉」。判据：openEdit/openNew 各存一次快照（≥2 处）、closeModal 带 force 参数
  //   与 confirm、成功落盘路径显式放行（closeModal(true) / 成功后清 editSnap）。
  check('D17 board.html 编辑弹窗关闭防丢（打开存快照 / 改过才问 / 成功落盘不追问）',
    /let editSnap=/.test(boardNoComment) &&
    (boardNoComment.match(/editSnap=formSnap\(\)/g) || []).length >= 2 &&
    /function closeModal\(force\)/.test(boardNoComment) &&
    (boardNoComment.match(/closeModal\(true\)/g) || []).length >= 3 &&
    /if\(r\.ok\)editSnap=""/.test(boardNoComment),
    `snap=${(boardNoComment.match(/editSnap=formSnap\(\)/g) || []).length} force=${/function closeModal\(force\)/.test(boardNoComment)} bypass=${(boardNoComment.match(/closeModal\(true\)/g) || []).length}`)

  // ══ E. 待办「日期 + 可选时间」合成（2026-10-12 暮雨：待办只有到期日，想再加个时间）══
  //   原话场景：「workbuddy 额度 21:33:59 重置，让用户选个 21:39」——
  //   所以 due=今天 + dueTime=21:39 必须在 **21:39 之后**就算过期，而不是等第二天。
  //   ⚠ 这里测的是 shared/time 的纯函数；App.vue 里不许内联日期算术（e2e-calendar 有守卫）。
  const today = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const ymd = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

  // ⚠ E1 记录一个**既有口径**（不是缺陷，别"顺手修"）：
  //   `parseTime('2026-10-12')` 走 `Date.parse` → 按 **UTC 零点** 解析，
  //   在东八区落成当天 08:00。所以"只有日期"的 parseDueAt 是 08:00 而不是 00:00。
  //   这是老代码一直的样子（`daysSince` 也吃同一口），待办的"逾期天数"因此以早八点为界。
  //   本次只**记录**它，不改变它 —— 改它会同时动到日历/逾期/归档三处既有行为。
  check('E1 parseDueAt：只有日期 → 当天（口径：UTC 零点，东八区=08:00，记录既有行为）',
    (() => {
      const d = new Date(t.parseDueAt('2026-10-12'))
      const p = new Date(Date.parse('2026-10-12'))
      return d.getTime() === p.getTime() && d.getMinutes() === 0
    })(),
    new Date(t.parseDueAt('2026-10-12')).toString())
  check('E2 parseDueAt：日期 + 时间 → 那一天的 21:39（不是 00:00）',
    (() => { const d = new Date(t.parseDueAt('2026-10-12', '21:39')); return d.getHours() === 21 && d.getMinutes() === 39 })())
  check('E3 parseDueAt：只有时间没日期 → 挂到今天那个点',
    (() => { const d = new Date(t.parseDueAt('', '21:39')); return d.getHours() === 21 && d.getMinutes() === 39 && d.getDate() === today.getDate() })())
  check('E4 parseDueAt：全角冒号也认（21：39）',
    t.parseDueAt('2026-10-12', '21：39') === t.parseDueAt('2026-10-12', '21:39'))
  check('E5 parseDueAt：冒号带秒也认（21:39:00 = 21:39）',
    t.parseDueAt('2026-10-12', '21:39:00') === t.parseDueAt('2026-10-12', '21:39'))
  check('E6 parseDueAt：都解析不了 → NaN（调用方当"没有截止"处理）',
    [t.parseDueAt('', ''), t.parseDueAt('abc', 'xyz'), t.parseDueAt(undefined, undefined)]
      .every((v) => Number.isNaN(v)))
  check('E7 parseDueAt：秒归零（分钟级对齐，不是"现在这一秒"）',
    (() => { const d = new Date(t.parseDueAt('2026-10-12', '21:39')); return d.getSeconds() === 0 && d.getMilliseconds() === 0 })())

  check('E8 formatDueTime：21:39 原样', t.formatDueTime('21:39') === '21:39')
  check('E9 formatDueTime：9:5 补齐成 09:05',
    t.formatDueTime('9:5') === '09:05', t.formatDueTime('9:5'))
  check('E10 formatDueTime：越界/乱码一律空串（不许把乱码印到界面上）',
    ['', 'abc', '99:99', '25:00', '12:99', undefined, null].every((v) => t.formatDueTime(v) === ''),
    JSON.stringify(['', 'abc', '99:99'].map((v) => t.formatDueTime(v))))

  // daysSinceDue —— 这条是本次真正踩到的坑：原先 App.vue 内联写日期算术，
  // 被 e2e-calendar 的守卫抓住。迁进 shared/time 之后，行为必须与旧口径一致。
  check('E11 daysSinceDue：无时间时等价于 daysSince（老行为一字不变）',
    t.daysSinceDue('2026-10-01') === t.daysSince('2026-10-01'))
  check('E12 daysSinceDue：**今天 + 已过的时分** → 正数（不是 0）',
    (() => {
      // 挑一个今天肯定已经过去的时间点（现在的小时减 1，跨零点则退到 00:01）
      const now = new Date()
      const h = now.getHours() > 0 ? now.getHours() - 1 : 0
      const v = t.daysSinceDue(ymd, pad(h) + ':00')
      return v > 0 && v < 1
    })())
  check('E13 daysSinceDue：**今天 + 还没到的时分** → 负数（还没到期）',
    (() => {
      const now = new Date()
      const h = now.getHours() < 23 ? now.getHours() + 1 : 23
      const v = t.daysSinceDue(ymd, pad(h) + ':59')
      return v < 0
    })())
  check('E14 daysSinceDue：dueTime 是空串/undefined → 退回按天（不要被空串带偏）',
    t.daysSinceDue('2026-10-01', '') === t.daysSince('2026-10-01') &&
    t.daysSinceDue('2026-10-01', undefined) === t.daysSince('2026-10-01'))
  check('E15 daysSinceDue：日期都解析不了 → NaN（不是 0）',
    Number.isNaN(t.daysSinceDue('abc', '21:39')))

  console.log('─'.repeat(50))
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); process.exitCode = 1 }
  console.log(`RESULT ${pass} / ${fail}`)
}

try { main() } catch (e) { console.error('测试框架异常：', e); process.exitCode = 1; console.log('RESULT 0 / 1') }
