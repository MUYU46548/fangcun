/**
 * Ctrl+Z 归属判定（2026-11-12 暮雨第 3 条）
 *
 * 用户原话：
 *   “编辑日志文本时，有时想撤销错误的粘贴，结果好像自动撤销了一条日志操作，
 *    我还找不到是哪一条被动了。”
 *
 * 这里钉两件事，缺一条就复现原 bug：
 *   ① **打字时别抢** —— 焦点在 textarea / 文本 input / contenteditable 里，
 *      Ctrl+Z 必须留给原生（撤字），哪怕撤销栈里有十条待撤的数据动作；
 *   ② **不打字时照抢** —— 2026-10-21 那次“狂按 Ctrl+Z 也没用”的场景（焦点在按钮/卡片上）
 *      不许因为这次修复而复发。
 *   ③ 撤完必须**说出撤了哪一条**（“我还找不到是哪一条被动了”）。
 *
 * 判据在 `desktop/src/shared/undoKey.ts`（纯函数，不依赖 Vue/DOM），
 * 所以能在这里真跑，而不是靠肉眼读 App.vue。
 *
 * 运行：node scripts/test/e2e-undo-shortcut.cjs
 */
const path = require('path')
const fs = require('fs')
const { mkTmpPath } = require('./_tmp.cjs')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const SRC = path.join(DESKTOP, 'src', 'shared', 'undoKey.ts')
const OUT = mkTmpPath('fc-undokey-')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

/** 编译 time.ts / calendar.ts 同一套口径（strict:false、commonjs、无 DOM lib） */
function compile() {
  fs.mkdirSync(OUT, { recursive: true })
  execFileSync(process.execPath, [
    path.join(DESKTOP, 'node_modules', 'typescript', 'bin', 'tsc'),
    SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'ES2020',
    '--strict', 'false', '--skipLibCheck',
  ], { cwd: DESKTOP, stdio: 'pipe' })
  const js = path.join(OUT, 'undoKey.js')
  if (!fs.existsSync(js)) throw new Error('编译产物不存在: ' + js)
  return require(js)
}

function main() {
  console.log('== Ctrl+Z 归属判定 e2e ==')
  const k = compile()

  // ── ① 什么算“可以撤字”的地方 ────────────────────────────────────────
  check('★ textarea 算可编辑（日志正文就是 textarea）',
    k.isEditableTarget({ tagName: 'TEXTAREA' }) === true)
  check('★ 文本型 input 算可编辑',
    ['text', 'search', 'url', 'email', 'password', 'number', 'tel'].every(
      (ty) => k.isEditableTarget({ tagName: 'INPUT', type: ty }) === true))
  check('★ input 不写 type 时按 text 算（老 HTML 的默认值）',
    k.isEditableTarget({ tagName: 'INPUT' }) === true)
  check('★ contenteditable 算可编辑（浏览器算好的 isContentEditable 直接用）',
    k.isEditableTarget({ tagName: 'DIV', isContentEditable: true }) === true)

  // ── ② 反例：这些**不算**可编辑，抢走 Ctrl+Z 是对的 ──────────────────
  check('★★ 反例：checkbox / radio / range 不算（它们没有原生撤销语义）',
    ['checkbox', 'radio', 'range', 'color', 'file'].every(
      (ty) => k.isEditableTarget({ tagName: 'INPUT', type: ty }) === false))
  check('★★ 反例：按钮 / 卡片 / body 不算（10-21 那次的现场就是焦点落在这些上面）',
    ['BUTTON', 'DIV', 'BODY', 'A'].every(
      (tag) => k.isEditableTarget({ tagName: tag, isContentEditable: false }) === false))
  check('★ 空目标（焦点落在 document 上）不算可编辑',
    k.isEditableTarget(null) === false && k.isEditableTarget(undefined) === false)

  // ── ③ 归属矩阵 ──────────────────────────────────────────────────────
  check('★★ 在 textarea 里 + 有待撤数据动作 → 仍归原生（这就是用户报的那一幕）',
    k.decideUndoKey(true, true) === 'native', k.decideUndoKey(true, true))
  check('★ 在按钮上 + 有待撤数据动作 → 归数据动作（10-21 的场景不许复发）',
    k.decideUndoKey(true, false) === 'data', k.decideUndoKey(true, false))
  check('★ 没有待撤动作 → 一律让给原生（在哪儿都一样）',
    k.decideUndoKey(false, false) === 'native' && k.decideUndoKey(false, true) === 'native')

  // ── ④ 反例自证：退回旧规则，上面的断言必须变红 ──────────────────────
  // 旧规则（2026-10-21 ~ 11-12）写法是“只要撤销条在就接管，不管焦点在哪”。
  const oldRule = (hasUndo) => (hasUndo ? 'data' : 'native')
  check('★★ 反例自证：旧规则在 textarea 里也会夺走 Ctrl+Z（这正是 bug 本体）',
    oldRule(true) === 'data' && k.decideUndoKey(true, true) === 'native',
    `old=${oldRule(true)} new=${k.decideUndoKey(true, true)}`)
  check('★★ 反例自证：旧规则下“在按钮上”也归数据（所以两条规则不是一回事，不能只删一条）',
    oldRule(true) === k.decideUndoKey(true, false),
    '旧规则与新规则在非编辑区必须一致，否则等于把 10-21 的修复又搞坏了')

  // ── ⑤ 接线守卫：判定必须真的被 App.vue 调用，且拦在前面 ────────────
  const vue = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'App.vue'), 'utf-8')
    .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
  check('★ App.vue 引了判定函数（不是摆设）',
    /import \{[^}]*decideUndoKey[^}]*\} from '\.\.\/shared\/undoKey'/.test(vue),
    '缺 import')
  const zBranch = (vue.match(/if \(e\.key === 'z' \|\| e\.key === 'Z'\) \{([\s\S]{0,900}?)\n  \}/) || [])[1] || ''
  const decideAt = zBranch.indexOf('decideUndoKey(')
  const preventAt = zBranch.indexOf('e.preventDefault()')
  check('★★ 先判归属再 preventDefault（顺序反了就是原 bug）',
    decideAt >= 0 && preventAt > decideAt, `decide@${decideAt} prevent@${preventAt}`)
  check('★★ 判定读的是**当前焦点**（document.activeElement），不是某个写死的标志位',
    /isEditableTarget\(document\.activeElement/.test(zBranch), zBranch.slice(0, 120))

  // ── ⑥ “撤完说清撤了哪一条”（“我还找不到是哪一条被动了”）──────────
  check('★★ 撤销成功后要报出被撤动作的名字（不能静默撤掉）',
    /撤回完成：刚才那一步是「\$\{label\}」/.test(vue), 'runUndo 未播报 label')
  const runUndoBody = (vue.match(/async function runUndo\(\)[\s\S]{0,700}?\n\}/) || [])[0] || ''
  check('★ 播报用的是**撤销那一刻**的栈顶 label（先取再撤；撤完再取拿到的是下一条）',
    /const label = undoBar\.value\?\.label/.test(runUndoBody) &&
    runUndoBody.indexOf('const label') < runUndoBody.indexOf('runUndoCore('),
    runUndoBody.slice(0, 200))

  // ── ⑦ 纯函数不许依赖 DOM/Vue（否则它就没法在这类测试里真跑）─────────
  const src = fs.readFileSync(SRC, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
  check('★★ undoKey.ts 零 Vue / 零 DOM 依赖（所以能脱浏览器真跑）',
    !/from 'vue'/.test(src) && !/\bdocument\./.test(src) && !/\bwindow\./.test(src),
    '出现了运行时依赖')
  check('★ undoKey.ts 不许出现 DOM 类型注解（主进程 tsconfig 的 lib 没有 DOM）',
    !/HTMLElement|EventTarget|KeyboardEvent/.test(src), '会编译不过')

  console.log(`\nRESULT ${pass} pass / ${fail} fail`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log(' -', f)
    process.exit(1)
  }
}

try { main() } catch (e) {
  console.error('FATAL', e && (e.stack || e.message || e))
  process.exit(2)
}
