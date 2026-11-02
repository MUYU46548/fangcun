#!/usr/bin/env node
/**
 * 计划与实际的对照镜 e2e（卡 task-20261027-004 阶段一，2026-11-02）
 *
 * 真跑**编译产物** `dist/shared/planMirror.js`。
 *
 * 判据一句话：**原样取出来，一个字不许改**。
 *   ① 逐字相等 —— 返回的 text 与卡正文里那一段必须完全一致（去首尾空白后）；
 *      这是这张卡最硬的一条：暮雨三次打回都是因为我"自作聪明地加工/归纳"了。
 *   ② 不打分 —— 返回对象里不许有 score / quality / rating / level 这类字段。
 *   ③ 缺失要说出来 —— 只有一半时 missing 必须标明缺哪半，且不许把空串当"没写"。
 *   ④ 字数必须带局限说明 —— 卡里的铁律："任何指标必须自带一句它证明不了什么"。
 *      反例：LEN_CAVEAT 被删空 / 只留数字 → 下面那条精确红。
 *   ⑤ 真卡实测 —— 拿 42 对真实样本过一遍，统计两半齐全的张数（不写死数字）。
 *
 * 运行：node scripts/test/e2e-plan-mirror.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const { extractMirror, describeMissing, LEN_CAVEAT } = require(path.join(REPO, 'desktop/dist/shared/planMirror.js'))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')) }
}

// ── ① 逐字相等：造一段正文，取出来必须一模一样 ──────────────────────
const body = [
  '## 方案',
  '',
  '这是方案的**第一行**，带 markdown。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '### 三级标题属于这一段内容（不许被切走）',
  '',
  '结尾一句。',
  '',
  '## 结果记录',
  '',
  '实际做的和方案不一样的地方：',
  '1. 没做列表项二',
  '',
  '## 其它',
  '',
  '这一段不该被取出来。',
].join('\n')

const m = extractMirror(body)
const planInFile = body.slice(body.indexOf('## 方案') + '## 方案'.length, body.indexOf('## 结果记录')).trim()
const actualInFile = body.slice(body.indexOf('## 结果记录') + '## 结果记录'.length, body.indexOf('## 其它')).trim()

check('★★ 方案段逐字相等（不摘要、不加工）', m.plan.text === planInFile, m.plan.text.slice(0, 60))
check('★★ 结果段逐字相等', m.actual.text === actualInFile, m.actual.text.slice(0, 60))
check('★ 三级标题留在方案段里（没被当成段落边界切走）', m.plan.text.includes('### 三级标题属于这一段内容'))
check('★ 段外的内容没被带进来', !m.plan.text.includes('不该被取出来') && !m.actual.text.includes('不该被取出来'))
check('★ 字数就是原文长度（不是估算）', m.plan.len === m.plan.text.length && m.actual.len === m.actual.text.length,
  { plan: m.plan.len, actual: m.actual.len })
check('★ 两段都在时 missing 为空', m.missing.length === 0, m.missing)

// ── ② 不打分：对象里不许出现任何评价性字段 ────────────────────────
const keys = JSON.stringify(m)
check('★★ 返回对象里没有评分/等级类字段（score / quality / rating / level）',
  !/\b(score|quality|rating|grade|level)\b/i.test(keys), keys.slice(0, 120))

// ── ③ 缺失要说出来 ────────────────────────────────────────────────
const onlyPlan = extractMirror('## 方案\n\n只写了方案。\n')
check('★ 只有方案时 missing 标 actual', onlyPlan.missing.length === 1 && onlyPlan.missing[0] === 'actual', onlyPlan.missing)
check('★ 缺失那一侧 text 是空串、len 是 0', onlyPlan.actual.text === '' && onlyPlan.actual.len === 0)
const none = extractMirror('## 其它\n\n什么都没写。\n')
check('★ 两段都没有时 missing 两项都标', none.missing.length === 2, none.missing)
check('★ 缺一半时给出的是人话（不是空字符串）',
  describeMissing(['plan']).includes('方案') && describeMissing(['actual']).includes('结果记录'),
  describeMissing(['plan']))
check('★ 两段齐全时 describeMissing 返回空串', describeMissing([]) === '', describeMissing([]))

// ── ④ 标题别名（历史写法）────────────────────────────────────────
check('★ 认 `## 计划` 这个别名', extractMirror('## 计划\n\n老卡用这个写法。\n').plan.text === '老卡用这个写法。')
check('★ 认 `## 做法` 这个别名', extractMirror('## 做法\n\n更老的写法。\n').plan.text === '更老的写法。')
check('★ 认 `## 结果` 这个别名', extractMirror('## 结果\n\n做完了。\n').actual.text === '做完了。')
check('★ 同时有 `## 方案` 和 `## 做法` 时取方案', (() => {
  const r = extractMirror('## 方案\n\n正式方案。\n\n## 做法\n\n补充做法。\n')
  return r.plan.text === '正式方案。' && r.plan.heading === '方案'
})())

// ── ⑤ 字数必须带局限说明（铁律）──────────────────────────────────
check('★★ 字数旁有局限说明，且明说“不说明好坏”',
  typeof LEN_CAVEAT === 'string' && LEN_CAVEAT.length > 40 &&
  LEN_CAVEAT.includes('不说明') && LEN_CAVEAT.includes('任务复杂度'), LEN_CAVEAT.slice(0, 60))
check('★★ 局限说明不是空壳（提到了 r≈+0.34 那个实测反例）',
  /r\s*[≈=]\s*\+?0\.34/.test(LEN_CAVEAT), LEN_CAVEAT)

// ── ⑥ 真卡实测：42 对样本过一遍（不写死张数）──────────────────────
const TD = path.join(REPO, 'task-data')
const files = fs.readdirSync(TD).filter((f) => f.endsWith('.md'))
let both = 0
let planOnly = 0
let actualOnly = 0
let neither = 0
let mismatch = 0
for (const f of files) {
  const s = fs.readFileSync(path.join(TD, f), 'utf8')
  const parts = s.split('---')
  if (parts.length < 3) continue
  const b = parts.slice(2).join('---')
  const r = extractMirror(b)
  if (r.plan.text && r.actual.text) both++
  else if (r.plan.text) planOnly++
  else if (r.actual.text) actualOnly++
  else neither++
  // 逐字回查：取出来的文本必须真能在正文里找到
  if (r.plan.text && !b.includes(r.plan.text)) mismatch++
  if (r.actual.text && !b.includes(r.actual.text)) mismatch++
}
check('★★ 真卡样本：两段齐全的张数 ≥ 30（这张卡当年统计是 43 对）', both >= 30, { both, planOnly, actualOnly, neither })
check('★★ 所有取出的段落都能在原文里逐字找到（零加工自证）', mismatch === 0, { mismatch })

// ── ⑦ 界面侧：详情里真的并排渲染（源码守卫）────────────────────────
const vue = fs.readFileSync(path.join(REPO, 'desktop/src/renderer/components/TaskPreview.vue'), 'utf8')
check('★ 详情组件里挂了对照镜块', /class="mirror"/.test(vue) && /extractMirror/.test(vue))
check('★ 两块并排（mirror-cols 下两个 mirror-col）', (vue.match(/class="mirror-col"/g) || []).length === 2)
check('★ 缺一半时界面上明说缺哪段（不是留白）',
  /mirror-missing/.test(vue) && /没有.*方案.*这一段/.test(vue) && /没有.*结果记录.*这一段/.test(vue))
check('★ 字数旁边挂了局限说明（界面上不是只有数字）', /LEN_CAVEAT/.test(vue) && /mirror-caveat/.test(vue))
check('★★ 详情里没有“打分/评分/质量分”这类加工（界面不替人判断）',
  !/质量分|评分|打分|得分/.test(vue.replace(/<!--[\s\S]*?-->/g, '')))

console.log('\nRESULT ' + pass + ' / ' + fail)
process.exit(fail === 0 ? 0 : 1)
