#!/usr/bin/env node
/**
 * 规划输入组装 e2e（2026-11-02）
 *
 * 这张测的是「方寸为什么以前规划不好」的第 2 条根因：
 * **输入只有标题级摘要，正文一个字都不进上下文**（卡 task-20261027-003）。
 *
 * 判据：
 *  ① 真卡的「## 方案」「## 结果记录」原文必须进 input.tasks[*].plan / .actual（不是空的）；
 *  ② 未结卡优先、最久没动的排前面（规划要看在等决策的，不是看完结的）；
 *  ③ 已完成的只给标题、不带正文（省上下文，且它们的作用只是"别重复列"）；
 *  ④ **英文键回归**：loadTasks 给的是 fm.project / fm.status / fm.title，
 *     按中文键写会全读空 —— 这个坑 AGENTS.md 记过一次，本测试是第二道闸。
 *
 * 运行：node scripts/test/e2e-plan-draft-input.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const orig = Module._resolveFilename
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron') return path.join(REPO, 'scripts/test/electron-stub.cjs')
  return orig.call(this, r, ...a)
}
process.env.FC_TEST_USERDATA = path.join(REPO, '..', '.fc-test-plan-draft-input')

const data = require(path.join(REPO, 'desktop/dist/main/data/index.js'))
data.setDataDir(REPO)
const { buildPlanDraftInput } = require(path.join(REPO, 'desktop/dist/main/llm/planDraftInput.js'))
const { buildPlanDraftPrompt, allowedCitations } = require(path.join(REPO, 'desktop/dist/main/llm/planDraft.js'))

let pass = 0
let fail = 0
const check = (n, ok, d) => {
  if (ok) { pass++; console.log('PASS  ' + n) }
  else { fail++; console.log('FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d).slice(0, 300) : '')) }
}

const raw = data.loadTasks()
check('★ 能读到真卡（数据根设对了）', raw.length > 100, raw.length)

const input = buildPlanDraftInput(raw, { project: 'fangcun-base', maxOpen: 24, maxDone: 8 })
check('★★ 按项目过滤到真卡（不是 0 张）', input.tasks.length >= 10, input.tasks.length)
check('★★ 英文键没写错：每张都有标题', input.tasks.every((t) => t.title && t.title.length > 2),
  input.tasks.filter((t) => !t.title).slice(0, 3))

const withPlan = input.tasks.filter((t) => t.plan && t.plan.length > 10)
const withActual = input.tasks.filter((t) => t.actual && t.actual.length > 10)
check('★★ 方案正文进了上下文（不是只有标题）', withPlan.length >= 5, { withPlan: withPlan.length, total: input.tasks.length })
check('★★ 结果记录正文进了上下文', withActual.length >= 3, { withActual: withActual.length })

const sample = withPlan[0]
check('★ 正文是原文片段（能在卡文件里找到）', (() => {
  if (!sample) return false
  const f = path.join(REPO, 'task-data', sample.id + '.md')
  if (!fs.existsSync(f)) return false
  const body = fs.readFileSync(f, 'utf8')
  const head = sample.plan.replace(/\s+/g, ' ').slice(0, 30)
  return head.length > 5 && body.replace(/\s+/g, ' ').includes(head.replace(/\s+/g, ' ').slice(0, 18))
})(), sample ? sample.id : '(无)')

// ③ 已完成只给标题
const dones = input.tasks.filter((t) => t.status === '完成')
check('★ 已完成的卡只带标题、不带正文', dones.length > 0 && dones.every((t) => !t.plan && !t.actual), dones.length)

// ② 未结卡在前，且按更新时间升序（最久没动在前）
const openIdx = input.tasks.map((t, i) => [t, i]).filter(([t]) => t.status !== '完成').map(([, i]) => i)
const doneIdx = input.tasks.map((t, i) => [t, i]).filter(([t]) => t.status === '完成').map(([, i]) => i)
check('★ 未结卡排在已完成前面', openIdx.length === 0 || doneIdx.length === 0 || Math.max(...openIdx) < Math.min(...doneIdx),
  { openIdx: openIdx.slice(-1), doneIdx: doneIdx.slice(0, 1) })

// ④ prompt 里真的出现了正文（不是只在对象里）
const { user } = buildPlanDraftPrompt(input)
check('★★ prompt 文本里带上了"当初的方案"', user.includes('当初的方案'), user.slice(0, 80))
check('★★ prompt 文本里带上了"实际结果"', user.includes('实际结果'))
check('★ prompt 里有可用依据 id', allowedCitations(input).length > 0, allowedCitations(input).length)
check('★★ prompt 要求回答"为什么是现在做这件"（不是只列事）', /为什么是现在/.test(user))

// 中文键回归闸：源码里不许出现 fm.项目 / fm.标题 / fm.状态
const src = fs.readFileSync(path.join(REPO, 'desktop/src/main/llm/planDraftInput.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
check('★★ 源码没用中文键读 fm（fm.项目 / fm.标题 / fm.状态）',
  !/fm\??\.(项目|标题|状态|更新|创建)/.test(src), 'found chinese key')

console.log('\nRESULT ' + pass + ' / ' + fail)
process.exit(fail === 0 ? 0 : 1)
