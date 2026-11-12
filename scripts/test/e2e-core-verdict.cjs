/**
 * 核心判词 · 端到端（2026-11-12）
 *
 * 钉的是**整条链**：方针卡上的一个字段 → 读回来 → 喂进内容量闸。
 * 中间任何一环断了，内容量闸就永远是"未判"，等于没做。
 *
 * 为什么这条必须有（实测踩到的真 bug）：
 *   `savePolicy` 的防静默清空纪律会让 `''`（显式清空）和 `undefined`（没传）同流，
 *   于是**判词一旦写成「垃圾」就再也撤不回"未判"** —— 那个方向被永久锁死。
 *   人不该被自己 10 秒前写的一句话困住。
 */
const path = require('path')
const fs = require('fs')
const { mkTmp } = require('./_tmp.cjs')
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
  console.log('== 核心判词 端到端 ==')
  const TMP = mkTmp('fc-verdict-e2e-')
  process.env.FC_TEST_USERDATA = TMP
  fs.mkdirSync(path.join(TMP, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'registry.yaml'),
    'members: []\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')

  const data = require(path.join(DIST, 'data', 'index.js'))
  data.setDataDir(TMP)
  const pol = require(path.join(DIST, 'services', 'policies.js'))
  const inp = require(path.join(DIST, 'llm', 'planDraftInput.js'))

  // ① 没有方针卡 = 未判（空串，不是 undefined 也不是"没问题"）
  check('★ 项目完全没有方针卡时，coreVerdict 是空串（=未判）',
    inp.buildPlanDraftInputFromDisk({ project: 'demo', maxOpen: 1, maxDone: 0 }).coreVerdict === '',
    JSON.stringify(inp.buildPlanDraftInputFromDisk({ project: 'demo', maxOpen: 1, maxDone: 0 }).coreVerdict))

  // ② 写入判词 → 读得回来
  pol.savePolicy({ projectId: 'demo', mission: 'x', goal: '', scenario: '', boundary: '', coreVerdict: '垃圾 —— 玩法撑不住' })
  const v1 = inp.buildPlanDraftInputFromDisk({ project: 'demo', maxOpen: 1, maxDone: 0 }).coreVerdict
  check('★★ 写入「垃圾」后，规划输入里读得到它', /垃圾/.test(v1), JSON.stringify(v1))

  // ③ 不传该字段 = 沿用（防静默清空）
  pol.savePolicy({ projectId: 'demo', mission: '改了使命', goal: '', scenario: '', boundary: '' })
  const v2 = inp.buildPlanDraftInputFromDisk({ project: 'demo', maxOpen: 1, maxDone: 0 }).coreVerdict
  check('★★ 只改别的字段时，判词**不许**被静默清掉（沿用旧值）', /垃圾/.test(v2), JSON.stringify(v2))

  // ④ 显式传空 = 真的清空（回到未判）—— 这就是实测踩到的那个 bug
  pol.savePolicy({ projectId: 'demo', mission: 'x', goal: '', scenario: '', boundary: '', coreVerdict: '' })
  const v3 = inp.buildPlanDraftInputFromDisk({ project: 'demo', maxOpen: 1, maxDone: 0 }).coreVerdict
  check('★★ 显式传空串时，判词**真的被清掉**（人能撤掉自己写的「垃圾」）', v3 === '', JSON.stringify(v3))

  // ⑤ 文件里必须留下"未判"的可见提示（不是留个空白节）
  const raw = fs.readFileSync(path.join(TMP, 'policies', 'demo.md'), 'utf-8')
  check('★ 清空后方针卡里有「未判」提示与四个档位（下一个人一眼知道要填什么）',
    /未判/.test(raw) && /立得住/.test(raw) && /能玩/.test(raw) && /垃圾/.test(raw))

  // ⑥ 换新判词 → 覆盖旧值
  pol.savePolicy({ projectId: 'demo', mission: 'x', goal: '', scenario: '', boundary: '', coreVerdict: '能玩 —— 那 5 分钟是游戏' })
  const v4 = inp.buildPlanDraftInputFromDisk({ project: 'demo', maxOpen: 1, maxDone: 0 }).coreVerdict
  check('★ 新判词覆盖旧判词', /能玩/.test(v4) && !/垃圾/.test(v4), JSON.stringify(v4))

  console.log(`\nRESULT ${pass} pass / ${fail} fail`)
  if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log(' -', f)); process.exit(1) }
}

try { main() } catch (e) { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2) }
