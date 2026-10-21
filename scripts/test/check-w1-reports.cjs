/**
 * 两份评估报告的"合同守卫"（2026-10-21 · W1-批次 3）
 *
 * 为什么给文档写断言：施工单对这两份报告有**硬字段要求** ——
 * ① 引擎评估必须给出「升 / 不升 / 缓升」三选一，并写清本次**没验**什么；
 * ② 拆分方案必须包含**回滚路径（快照点 + 灰度开关设计）**。
 * 这些字段最容易在后续改写中被顺手删掉（"太长了，精简一下"），而删掉之后
 * 决策依据就没了 —— 那时没人会重新发现。所以钉在这里。
 *
 * 只校验结构与必备字段，不校验行文。跑法：node scripts/test/check-w1-reports.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const EVAL = path.join(ROOT, 'docs', 'eval-engine-migration.md')
const PLAN = path.join(ROOT, 'docs', 'plan-app-vue-split.md')

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n') : '')

const ev = read(EVAL)
const pl = read(PLAN)

// ── ① 引擎迁移评估 ────────────────────────────────────────────────────────
check('引擎评估报告存在（docs/eval-engine-migration.md）', !!ev, EVAL)
check('★ 给出了三选一结论（升 / 不升 / 缓升 都要出现在文里，便于对照取舍）',
  /结论：\*\*升\*\*/.test(ev) && /不升的代价/.test(ev) && /缓升的条件/.test(ev),
  '缺结论段')
check('★ 结论指向具体目标版本（44），不是"升到新版本"这种空话',
  /目标 44/.test(ev), '没写目标版本')
check('★ 现状事实带取证（EOL 日期 / 内置 Chromium / Node 版本 / 安装包体积）',
  /EOL/.test(ev) && /Chromium 120/.test(ev) && /Node 18/.test(ev) && /79\.4 MB/.test(ev))
check('★ 工时估算按档给（不写虚假的精确小时）', /0\.5 天/.test(ev) && /合计[\s\S]{0,40}2–2\.5 天/.test(ev))
check('★★ 明确列出「本次没验的东西」（评估报告最容易把"没做"写成"没问题"）',
  /本次没验的东西/.test(ev) && /没在本机实跑/.test(ev))
check('★ 执行顺序里有快照与回滚（真动手时照它走）',
  /快照/.test(ev) && /git revert/.test(ev))

// ── ② App.vue 拆分方案 ────────────────────────────────────────────────────
check('拆分方案存在（docs/plan-app-vue-split.md）', !!pl, PLAN)
check('★ 行数是实测值且带复现命令（不是拍脑袋的 15000 行）',
  /15293/.test(pl) && /wc -l src\/renderer\/App\.vue/.test(pl) && /4036/.test(pl))
check('★ 给出分步顺序（低耦合先、大块最后）',
  /第 1 批/.test(pl) && /第 4 批/.test(pl) && /roadmap/.test(pl))
check('★★ 回滚路径含**快照点**与**灰度开关**两件（施工单指名要的字段）',
  /## 五、回滚路径/.test(pl) && /快照点/.test(pl) && /灰度开关/.test(pl)
  && /fc_split_legacy/.test(pl), '缺回滚字段')
check('★★ 灰度开关写清"开关关掉走旧实现"的机制与寿命（不留双份实现）',
  /走旧的内联实现/.test(pl) && /删掉旧块/.test(pl))
check('★ 每步验收命令是能直接抄的（构建 + 守卫 + 两层渲染断言）',
  /npm run build/.test(pl) && /check-template-bindings/.test(pl) && /e2e-renderer-web/.test(pl)
  && /e2e-renderer\.cjs/.test(pl))
check('★ 断言只增不减的原则写进方案（拆的时候别把测点搬丢）',
  /断言只增不减/.test(pl) && /断言数掉了/.test(pl))
check('★ 明确不做的事也写了（不趁机改视觉 / 不引 Pinia 重排）',
  /明确不做/.test(pl) && /不引入 Pinia/.test(pl) && /不趁机改视觉/.test(pl))

console.log('')
console.log('通过 ' + pass + ' / 失败 ' + fail)
process.exit(fail === 0 ? 0 : 1)
