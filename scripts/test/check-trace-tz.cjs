/**
 * 时间戳时区守卫（2026-10-27）
 *
 * 起因（真实事故）：暮雨看到审批留痕写着「[2026-10-27 04:24] 审批通过」，而那个点他根本不在
 * 电脑前 —— 原话是「难道是幽灵？」。查下来不是幽灵，是 `reviewTask` 用 `toISOString()`（**UTC**）
 * 却当本地时间写进给人看的文本，差 8 小时：真实时间是当天中午 12:24。
 *
 * 同一条链上还有两处同类缺陷：
 *   · `chat.ts` 写 ai-trace 时 `toISOString().slice(0,19)` **把时区标记 Z 切掉了**，
 *     读侧 `Date.parse` 会按本地解释 → 月报跨月算错月；
 *   · `tegula_llm.py` 写**本地时间且无标记**，而 TS 侧写 UTC —— 同一个 ai-trace.jsonl
 *     里混着两种基准，同一天两条记录能差 8 小时。
 *
 * 三条都修了。这个守卫防止有人把它们改回去 —— 尤其是 `.slice(0,19)` 看着很"整洁"，
 * 很容易被当成习惯写法再抄一遍。
 *
 * 运行：node scripts/test/check-trace-tz.cjs
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '../..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

console.log('== 时间戳时区守卫 ==')

// ① TS 写 ai-trace：必须保留完整 ISO（含 Z）
const chat = read('desktop/src/main/llm/chat.ts')
check('chat.ts：ai-trace 的 ts 保留完整 ISO（含时区标记 Z）',
  /ts:\s*new Date\(\)\.toISOString\(\),/.test(chat),
  '期望 `ts: new Date().toISOString(),`')
check('chat.ts：不再把 toISOString 切到 19 位（会切掉 Z）',
  !/toISOString\(\)\.slice\(0,\s*19\)/.test(chat),
  '发现 `toISOString().slice(0,19)`')

// ② Python 写 ai-trace：必须写 UTC 且带偏移
const py = read('tegula_llm.py')
check('tegula_llm.py：_trace_call 的 ts 用 UTC（带 +00:00）',
  /datetime\.now\(datetime\.timezone\.utc\)\.isoformat/.test(py),
  '期望 `datetime.now(datetime.timezone.utc).isoformat(...)`')
check('tegula_llm.py：不再用裸 now()（本地时间、无时区标记）',
  !/"ts":\s*datetime\.datetime\.now\(\)\.isoformat/.test(py),
  '发现 `datetime.now().isoformat()`')

// ③ 审批留痕：写给人的时间必须是本地时间
const ipc = read('desktop/src/main/ipc.ts')
const reviewFn = (() => {
  const i = ipc.indexOf('export function reviewTask')
  return i < 0 ? '' : ipc.slice(i, i + 2600)
})()
check('ipc.ts：能定位到 reviewTask', reviewFn.length > 0, '')
check('ipc.ts：reviewTask 不再用 toISOString 当本地时间写留痕',
  reviewFn.length > 0 && !/const ts = new Date\(\)\.toISOString\(\)/.test(reviewFn),
  '发现 `const ts = new Date().toISOString()...`')
check('ipc.ts：reviewTask 的 ts 取自本地 getFullYear / getHours',
  reviewFn.includes('getFullYear()') && reviewFn.includes('getHours()'), '')

// ④ 读侧兼容：无时区标记的旧记录按 UTC 解释
const trace = read('desktop/src/main/llm/trace.ts')
check('trace.ts：存在 parseTs 兼容函数', /function parseTs\(/.test(trace), '')
check('trace.ts：usageStats / usageByMonth 都走 parseTs（不再裸 Date.parse）',
  (trace.match(/parseTs\(/g) || []).length >= 3,
  'parseTs 出现次数 = ' + (trace.match(/parseTs\(/g) || []).length)

// ── 反例自证：判定用的正则真的会咬住旧写法 ────────────────────────────
const OLD_TS = 'ts: new Date().toISOString().slice(0, 19),'
const OLD_PY = '"ts": datetime.datetime.now().isoformat(timespec="seconds"),'
const OLD_IPC = "const ts = new Date().toISOString().replace('T', ' ').slice(0, 16)"
check('反例：旧 chat.ts 写法会被咬住', /toISOString\(\)\.slice\(0,\s*19\)/.test(OLD_TS), '')
check('反例：旧 Python 写法会被咬住', /"ts":\s*datetime\.datetime\.now\(\)\.isoformat/.test(OLD_PY), '')
check('反例：旧 ipc.ts 写法会被咬住', /const ts = new Date\(\)\.toISOString\(\)/.test(OLD_IPC), '')

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) { console.log('\n失败项：'); for (const f of failures) console.log(' -', f) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
