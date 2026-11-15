/**
 * 证据行「人话」纯逻辑断言（2026-11-15 暮雨第三次：「界面依然很不美观」）
 *
 * 病根不是"没有样式"，而是**屏幕上有一条 40 字符的行，其中 24 个字符没人读得懂**：
 *   `✔ 自检 2026-11-03T04:00:54.502Z · 6/6 判据通过`
 * 它每天被扫几十次，挤走的正是该被看见的东西。
 *
 * 这一套钉的是"翻译不许走样"，因为翻错了在界面上**看着完全正常**：
 *  ① 只换 ISO 时刻，路径 / 命令 / 分数一个字符都不许动；
 *  ② 必须是**本地时区**（`04:00Z` 在东八区是 12:00 —— 显示成 04:00 会让人以为凌晨跑过一次）；
 *  ③ 认不出就原样返回，**绝不糊"刚刚/某天"**；
 *  ④ 同年不写年、跨年写年（四个字符也是屏幕面积）。
 *
 * 运行：node scripts/test/e2e-evidence-text.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { mkTmpPath } = require('./_tmp.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const OUT = mkTmpPath('fc-ev-')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function build() {
  fs.mkdirSync(OUT, { recursive: true })
  execFileSync(process.execPath, [
    path.join(DESKTOP, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(DESKTOP, 'src', 'shared', 'evidenceText.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'ES2020',
    '--strict', 'false', '--skipLibCheck',
  ], { cwd: DESKTOP, stdio: 'pipe' })
  const js = path.join(OUT, 'evidenceText.js')
  if (!fs.existsSync(js)) throw new Error('编译产物不存在：' + js)
  return require(js)
}

console.log('== 证据行人话 · 纯逻辑 ==')
const M = build()
const NOW = new Date(2026, 10, 15, 13, 0, 0) // 2026-11-15 13:00 本地

// ── ① 真实现场：卡上的原文长这样 ────────────────────────────────────────
{
  const raw = '自检 2026-11-03T04:00:54.502Z · 6/6 判据通过'
  const out = M.formatEvidence(raw, NOW)
  check('★★ 毫秒与 Z 都没了（屏幕上不再出现 .502Z）',
    out.indexOf('.502') < 0 && out.indexOf('Z') < 0, out)
  check('★★ 分数与结论原样保留（翻译不许吃掉判据本身）',
    out.indexOf('6/6 判据通过') >= 0, out)
  check('★ 前缀「自检」保留', out.indexOf('自检') === 0, out)
  check('★★ 是**本地时区**（04:00Z → 东八区 12:00，不是 04:00）',
    /12:00/.test(out), out)
  check('★★ 同年不写年（省下的四个字符会让一行读起来更短）',
    !/2026-/.test(out) && /11-03 12:00/.test(out), out)
}

// ── ② 跨年要写年（否则"11-03"到底是哪一年没人知道）────────────────────
{
  const out = M.formatEvidence('自检 2025-11-03T04:00:00Z', NOW)
  check('★★ 跨年写年', /2025-11-03/.test(out), out)
}

// ── ③ 只换时间：路径 / 命令 / 多段一个字都不许动 ────────────────────────
{
  const raw = 'docs/自检报告-20261103.md · node scripts/test/e2e-checks.cjs · 12/12 · 2026-11-03T04:00:54.502Z'
  const out = M.formatEvidence(raw, NOW)
  check('★★ 路径原样', out.indexOf('docs/自检报告-20261103.md') === 0, out)
  check('★★ 命令原样', out.indexOf('node scripts/test/e2e-checks.cjs') >= 0, out)
  check('★★ 多段分隔符原样（· 不许被替换成别的）',
    (out.match(/·/g) || []).length === 3, out)
  check('★ 只换了一处时间', out !== raw && out.indexOf('2026-11-03T') < 0, out)
  // 反例自证：如果实现"顺手把整行美化了一遍"，上面几条会同时红
  check('   反例自证：原文里的日期数字 20261103（文件名）不许被当成时间改写',
    out.indexOf('自检报告-20261103.md') >= 0)
}

// ── ④ 认不出就原样，绝不糊一个"刚刚" ───────────────────────────────────
{
  const raw = '自检 前几天跑过一次 · 6/6 判据通过'
  check('★★ 认不出的时间 → 整行原样返回', M.formatEvidence(raw, NOW) === raw)
  check('★ 空串不炸', M.formatEvidence('', NOW) === '')
  check('★ null 不炸', M.formatEvidence(null, NOW) === '')
  check('★★ 不许出现"刚刚 / 某天 / 最近"这类编出来的词',
    !/刚刚|某天|最近/.test(M.formatEvidence('x 2026-13-99T99:99:99Z y', NOW)))
}

// ── ⑤ 单点函数：shortLocalStamp ─────────────────────────────────────────
{
  check('★ shortLocalStamp 认不出的给空串（不是 Invalid Date）',
    M.shortLocalStamp('not-a-date', NOW) === '')
  check('★ shortLocalStamp 认得出的给 MM-DD HH:mm',
    /^11-03 12:00$/.test(M.shortLocalStamp('2026-11-03T04:00:54.502Z', NOW)),
    M.shortLocalStamp('2026-11-03T04:00:54.502Z', NOW))
}

// ── ⑥ planSummary：把"重复的正常"算成一个数 ─────────────────────────────
{
  const s = M.planSummary([
    { status: '完成', missing: [] },
    { status: '完成', missing: [] },
    { status: '待裁决', missing: ['判据'] },
    { status: '未冻结', missing: [] },
  ])
  check('★★ total/done/open 分开算', s.total === 4 && s.done === 2 && s.open === 2, JSON.stringify(s))
  check('★★ missing 只数真缺块的（不是数"有 missing 字段"）', s.missing === 1, JSON.stringify(s))
  check('★ 空输入不炸', M.planSummary([]).total === 0)
  check('★ 非数组不炸', M.planSummary(null).total === 0)
  check('★ 空项被跳过（数组里有 null 不许崩）', M.planSummary([null, { status: '完成' }]).done === 1)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
console.log(`RESULT ${pass} / ${fail}`)
try { fs.rmSync(OUT, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0)
