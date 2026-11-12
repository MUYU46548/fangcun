/**
 * 内容量闸 · **接线**回归（2026-11-12）
 *
 * 上一个测试（e2e-content-scale）验的是纯函数本身。
 * 这一个验的是**它真的接进了草案管道** —— 否则纯函数再准也没人调用，
 * 那正是方寸反复犯的病（"能力建好了、零用例"）。
 *
 * 真事：记忆圣所那份规划写着「总时长 4–5 小时，三幕，七间房」，
 *   而核心玩法从没被人判过一句。三块齐全、判据合法、依据真实 —— 所有旧闸都会放行。
 */
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

const orig = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return orig.call(this, request, ...rest)
}

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function main() {
  console.log('== 内容量闸接线 e2e ==')
  const pd = require(path.join(DIST, 'llm', 'planDraft.js'))

  // 三块齐全 + 判据是合法相对路径 + 依据真实 => 旧闸全过，只剩"量"这一关
  const mk = (title, what) => ({
    id: 'P0', title, what,
    approach: ['逐间实现'],
    copy: [['项', '来源', '原文', '到位'], ['房间', 'ruling:x:S4', '七间', '七间都在']],
    criteria: ['file: docs/README.md'],
    cites: ['task:t1'],
  })

  // ① 大内容量 + 没判词 => 必须被内容量闸丢掉（不是被"判据不合法"误伤）
  const big = pd.validateDraftStages([mk('铺三幕主线：总时长 4–5 小时', '七间房全部做出来')], ['task:t1'], {})
  check('★★ 「4–5 小时三幕七间房」被内容量闸丢掉', big.stages.length === 0, JSON.stringify(big.stages.map((s) => s.title)))
  check('★★ 丢掉原因记在 scaleBlocked（不是混进 missingCitations）',
    big.scaleBlocked === 1 && big.missingCitations === 0,
    JSON.stringify({ scale: big.scaleBlocked, cites: big.missingCitations }))
  check('★★ 丢弃理由里点名了抽到的量（5 小时 / 3 幕 / 7 间房）',
    /5 小时/.test(JSON.stringify(big.dropped)) && /7 间房/.test(JSON.stringify(big.dropped)),
    JSON.stringify(big.dropped).slice(0, 200))
  check('★★ 丢弃理由给的是"先做最小原型"，不是让用户改判据',
    /最小原型/.test(JSON.stringify(big.dropped)))

  // ② 小改动必须**不受影响** —— 否则这条闸会把日常卡全锁死
  const small = pd.validateDraftStages([mk('改一个按钮的颜色', '把主按钮改成品牌紫')], ['task:t1'], {})
  check('★★ 不含内容量的普通格子照常通过（这条闸只管"铺量"）',
    small.stages.length === 1 && small.scaleBlocked === 0, JSON.stringify(small.dropped))

  // ③ 人给了"立得住"判词 => 同样的量放行（说明它拦的是"没验证"，不是"量大"）
  const verified = pd.validateDraftStages([mk('铺三幕主线：总时长 4–5 小时', '七间房')], ['task:t1'], { coreVerdict: '立得住' })
  check('★★ 有"立得住"判词时，同样的内容量放行（拦的是"没验证"而非"量大"）',
    verified.stages.length === 1, JSON.stringify(verified.dropped))

  // ④ 判词=垃圾 => 仍然拦，且理由点名"已判为垃圾"
  const junk = pd.validateDraftStages([mk('铺三幕主线：总时长 4–5 小时', '七间房')], ['task:t1'], { coreVerdict: '垃圾' })
  check('★★ 判词=垃圾时照样拦，且理由说明"已被判为垃圾"',
    junk.stages.length === 0 && /垃圾/.test(JSON.stringify(junk.dropped)), JSON.stringify(junk.dropped).slice(0, 160))

  // ⑤ 小原型（0.5 小时）在没判词时也必须放行 —— 不然连验证都做不了
  const proto = pd.validateDraftStages([mk('最小原型：0.5 小时走通一遍仪式', '1 间房')], ['task:t1'], {})
  check('★★ 0.5 小时 / 1 间房的最小原型，没判词也放行（否则没法验证核心）',
    proto.stages.length === 1, JSON.stringify(proto.dropped))

  console.log(`\nRESULT ${pass} pass / ${fail} fail`)
  if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log(' -', f)); process.exit(1) }
}

try { main() } catch (e) { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2) }
