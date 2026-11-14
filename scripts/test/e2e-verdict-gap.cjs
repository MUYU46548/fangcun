#!/usr/bin/env node
/**
 * 核心判词缺口可见性（2026-11-14 · 长 Loop P1-1）
 *
 * 这一片要解决的问题**不是"让用户填"**（那是他的决定，10 秒的动作，不许代填），
 * 而是**他根本看不见还剩几份没判**：
 *   · 14 份方针卡里 13 份的「核心判词」还是骨架 `> 未判 …`
 *   · 而内容量闸只认核心判词 —— 未判 = 对所有项目只放行"最小原型"
 *   · 此前界面上唯一能看到判词的地方，是**一份份打开方针弹窗**
 *
 * 所以断言钉三件：
 *   ① 判词状态**必须与「方针已立」分开**（方针卡使命写满了 ≠ 核心判过）
 *   ② 缺口数必须按「真正没判的」算（骨架 / 空 / "未判"都不算判过）
 *   ③ 判词表格子必须接进界面（否则又是个"数据层有、界面没有"）
 *
 * 反例自证：把 isUnjudged 换成"非空就算判过" → ②立刻红（13 份未判会变成 0）
 *
 * 运行：node scripts/test/e2e-verdict-gap.cjs   （需先 cd desktop && npm run build）
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'coreVerdict.js')

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
const { isUnjudged, verdictSkeleton } = require(ART)

console.log('== 核心判词缺口可见性 ==')

// ── ① 骨架 / 空 / 未判 都必须算"没判过" ────────────────────────────────
{
  const skeleton = verdictSkeleton()
  check('★★ 骨架提示算**未判**（这是 13 份项目的实际状态）', isUnjudged(skeleton) === true,
    JSON.stringify(String(skeleton).slice(0, 60)))
  check('★ 空串算未判', isUnjudged('') === true)
  check('★ 只有 `> 未判` 一行也算未判', isUnjudged('> 未判 —— 核心玩法还没被人确认过"立得住"。') === true)
  check('★ 写「未判」两字也算未判（不许因为带了别的字就当成判过）', isUnjudged('未判') === true)
}
{
  check('★★ 真判过的不算未判（"能玩"是四档之一）',
    isUnjudged('能玩 —— 核心流程通了，细节没打磨。2026-11-11') === false)
  check('★ "垃圾"也算判过（判过 = 有结论，不等于结论好）',
    isUnjudged('垃圾 —— 两间房纯属填充物。2026-11-11') === false)
}
{
  // 反例自证：如果按"非空就算判过"，骨架会被当成已判 —— 13 份未判会变成 0 份
  const skeleton = verdictSkeleton()
  const naive = String(skeleton || '').trim().length > 0
  check('★★ 反例自证：按"非空即判过"的粗糙口径，骨架会被算成已判（那正是要防的假绿）',
    naive === true && isUnjudged(skeleton) === true,
    'naive=' + naive)
}

// ── ② 真实数据：13 份未判必须数得出来 ─────────────────────────────────
{
  // 直接读真 policies/ —— 这不是"测夹具"，是测**现场**。
  // ⚠ 这个数会随用户填写而变，所以断言不写死"13"，写"数得出来且与逐份核对一致"。
  const dir = path.join(REPO, 'policies')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : []
  check('★ policies/ 下有方针卡（真数据在）', files.length > 0, 'files=' + files.length)

  let judged = 0, unjudged = 0
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf-8')
    const m = /(?:^|\n)##\s*核心判词\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/.exec(t)
    const body = m ? m[1].trim() : ''
    if (isUnjudged(body)) unjudged++
    else judged++
  }
  check('★★ 逐份核对：已判 + 未判 = 总数（不漏不多）',
    judged + unjudged === files.length, `${judged}+${unjudged} vs ${files.length}`)
  console.log(`      现场：${files.length} 份方针卡 → 已判 ${judged} / 未判 ${unjudged}`)
  check('★ 现场至少有一份是判过的（fangcun-base 写了自己的定位）', judged >= 1, 'judged=' + judged)
}

// ── ③ 界面接线：判词状态必须与「方针已立」分开，并出现在项目页 ──────────────
{
  const app = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue'), 'utf-8')
  const view = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'views', 'ProjectsView.vue'), 'utf-8')

  check('★★ loadPolicyMap 真的读了 coreVerdict（不读就永远是空表）',
    /judged\[p\.id\]\s*=\s*!isUnjudged\(/.test(app))
  check('★★ 判词判定走 isUnjudged（不自己写正则 —— 两套口径是本仓老病）',
    /import \{ isUnjudged \}/.test(app) && !/核心判词[^\n]*\^>\\s\*未判/.test(app.replace(/\/\*[\s\S]*?\*\//g, ' ')))
  check('★ 判词表与方针表是**两张表**（policyJudgedMap ≠ policyMap）',
    /policyJudgedMap/.test(app) && /const policyJudgedMap = ref/.test(app))
  check('★★ judgeGap 是**独立**的 computed（判词缺口没混进 charterStats 的四个数里）',
    /const judgeGap = computed\(\(\) => \{/.test(app)
    // charterStats 的返回体里不许出现判词相关字段
    && !/return \{ total, filled, skeleton, missing, mapMissing, mapReady[^}]*judge/i.test(app)
    // 且它真的被交到项目页（只用 computed 不接线＝白算）
    && /get judgeGap\(\) \{ return judgeGap\.value \}/.test(app))
  check('★★ 项目页出现了判词计数（用户一眼看得到还剩几份）',
    /judgeGap\.count/.test(view) && /判词待判/.test(view))
  check('★ 项目卡上有判词状态格（不是只藏在顶部计数里）',
    /policyJudgedMap\[p\.id\]/.test(view) && /判词：/.test(view))
  check('★ 有"从第一个未判的开始"的直达动作（省得自己去列表里找）',
    /openFirstUnjudged/.test(app) && /openFirstUnjudged/.test(view))
  check('★ 判词按钮用的是 ui 基座（不是新造的手搓按钮）',
    /<Button[^>]*cb-judge-btn/.test(view))
}

// ── ④ 源码守卫：不许有"代用户填判词"的代码 ──────────────────────────────
{
  const files = ['desktop/src/renderer/App.vue', 'desktop/src/renderer/views/ProjectsView.vue',
    'desktop/src/main/services/policies.ts']
  let autoFill = false
  for (const rel of files) {
    const p = path.join(REPO, rel)
    if (!fs.existsSync(p)) continue
    const src = fs.readFileSync(p, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    // 找"把 coreVerdict 直接赋成某个档位"的写法（自动填 = 替用户做决定）
    if (/coreVerdict\s*[:=]\s*['"](能玩|立得住|垃圾)['"]/.test(src)) autoFill = true
  }
  check('★★ 没有任何"自动把判词填成某档"的代码（那是替用户做决定，不许）', autoFill === false)
}

console.log('\n' + (fail ? '❌ ' : '✅ ') + `RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(fail ? 1 : 0)
