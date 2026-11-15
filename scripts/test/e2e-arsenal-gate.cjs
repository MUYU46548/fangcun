#!/usr/bin/env node
/**
 * 派工单硬闸 + 直连 e2e（2026-11-09 · S3）
 *
 * 暮雨拍板：
 *   · 闸口范围 = 不只规划件，**派工单 / 任务书生成口**也要过澄清闸（D-061 选 B）；
 *   · 已落档验收线**追加**到派工单第 7 节，不覆盖第 5 节人工验收（规格 §6 第 3 条）。
 *
 * 判据：
 *   ① 没写 `澄清: <卷>` → `buildDispatchResult` 直接拒（不是拼一段红字）；
 *   ② 有卷 → 文本里第 7 节带验收线原文、第 8 节带卷名，且第 5 节原样保留；
 *   ③ 老调用方 `buildDispatchText` 不传卷仍能拿到原文（向后兼容），但第 8 节明确写“缺”；
 *   ④ 源码守卫：界面真的调 `questionnaireDispatchContext` + `buildDispatchResult`；
 *   ⑤ `intake_task` 认卡上 `拍板: D-xxx` 并自动加 `str: D-xxx` 判据。
 *
 * 运行：node scripts/test/e2e-arsenal-gate.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const { buildDispatchResult, buildDispatchText } = require(path.join(DIST, 'shared', 'arsenal.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

const base = {
  id: 'task-x', title: '测试卡', body: '卡的正文', status: '待办', path: '',
  priority: '中', tags: ['t'], projectRoot: 'E:/x', projectName: '方寸',
  acceptance: ['verify.py 全绿'],
}

console.log('== ① 没卷不许派 ==')
{
  const r = buildDispatchResult({ ...base, strict: true })
  check('★★ 没写澄清卷 → 拒', r.ok === false, JSON.stringify(r))
  check('★ 拒因说清“澄清问卷”', /澄清问卷/.test(r.error || ''), r.error)
}

console.log('== ② 有卷：第 7 节带验收线、第 8 节带卷名、第 5 节保留 ==')
{
  const r = buildDispatchResult({
    ...base, strict: true,
    clarify: '方寸-规划判断半-裁决层A',
    rulings: [{ deck: '方寸-规划判断半-裁决层A', qid: 'S2', line: '所有相关旧题都已答且无未决冲突才算过' }],
  })
  check('★ 有卷 → 放行', r.ok === true, r.error)
  const text = r.text || ''
  check('★★ 第 7 节标题在', /## 7 已落档的验收/.test(text))
  check('★★ 验收线原文在（题号 + 卷名 + 线）',
    /S2（方寸-规划判断半-裁决层A）：所有相关旧题都已答且无未决冲突才算过/.test(text), text.match(/## 7[\s\S]{0,160}/))
  check('★★ 第 8 节带卷名', /## 8 澄清问卷[\s\S]{0,80}方寸-规划判断半-裁决层A/.test(text))
  check('★★ 第 5 节人工验收原样保留（没被覆盖）', /## 5 验收判据[\s\S]{0,120}verify\.py 全绿/.test(text))
}

console.log('== ③ 老调用方向后兼容 ==')
{
  const text = buildDispatchText({ ...base })
  check('★ 不传卷仍能拿到原文', typeof text === 'string' && text.length > 200)
  check('★ 但第 8 节明确写“缺”', /缺 —— 这张卡没有附澄清问卷/.test(text))
  check('★ 没有验收线时第 7 节如实说没有', /本项目还没有已落档的验收线/.test(text))
}

console.log('== ④ 界面对账（源码守卫）==')
{
  const app = fs.readFileSync(path.join(REPO, 'desktop/src/renderer/App.vue'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  check('★★ 界面真的调 questionnaireDispatchContext', /questionnaireDispatchContext\s*\(/.test(app))
  check('★★ 界面真的用 buildDispatchResult（不是只拼文本）', /buildDispatchResult\s*\(/.test(app))
  check('★★ 没卷时界面直接拒（toast + return）', /不许派：这张卡没有附澄清问卷[\s\S]{0,120}return/.test(app))
  const qn = fs.readFileSync(path.join(REPO, 'desktop/src/main/data/questionnaires.ts'), 'utf-8')
  check('★ 答案落卡时写了「## 澄清问卷」标记（派工单靠它认卷）', /## 澄清问卷/.test(qn))
}

console.log('== ⑤ intake 必读闸 ==')
{
  const tools = fs.readFileSync(path.join(REPO, 'desktop/src/main/mcp/tools.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  check('★★ intake_task 支持 taskId', /args\.taskId/.test(tools))
  check('★★ 从卡上抽 拍板/相关旧拍板 的 D- 编号',
    /相关旧拍板/.test(tools) && /D-\\d\+/.test(tools))
  check('★★ 自动加 str: D-xxx 判据', /criteria\.push\(`str: \$\{id\}`\)/.test(tools))
}

console.log('== ⑥ 前端施工纪律 R1–R5 随派工单下发（2026-11-15）==')
// 为什么钉这里：纪律有两个出口 —— CLI 任务书（Python）与桌面「复制为派工单」（TS）。
// 只落一边 = "用哪个入口派，决定了执行方看不看得到纪律"，那等于没有纪律。
// 真源只有 `docs/施工纪律-前端.md`；这两处都是它的投影，所以两处必须都说。
{
  const dm = { ...base, strict: true, clarify: '某卷' }
  const design = buildDispatchResult({ ...dm, tags: ['设计'] })
  const designText = design.text || ''
  check('★★ 设计卡派工单带 R1–R5 节', /## 前端施工纪律（R1–R5/.test(designText))
  check('★★ 带 R1 的可执行命令（不是抽象要求）',
    /--shots/.test(designText) && /FC_SHOT_ONLY/.test(designText) && /900,700/.test(designText))
  check('★★ 带 R2「禁止用测试绿替代」与 R3 `check-ui-freeze`',
    /禁止用“测试绿”替代这条/.test(designText) && /check-ui-freeze/.test(designText))
  check('★ type=design 也算（不只看标签；与 Python 侧 `_task_kind` 同一套认法）',
    /## 前端施工纪律/.test(buildDispatchResult({ ...dm, type: 'design' }).text || ''))
  check('★ 标签 ui / design 也算',
    /## 前端施工纪律/.test(buildDispatchResult({ ...dm, tags: ['ui'] }).text || '')
    && /## 前端施工纪律/.test(buildDispatchResult({ ...dm, tags: ['design'] }).text || ''))
  // 反例：普通卡不许塞 —— 后端/账本卡带上这段就是噪音，最终会让人整体无视这一节
  check('★★ 反例：普通卡（无设计标签）**不带**这段',
    !/前端施工纪律/.test(buildDispatchResult({ ...dm, tags: ['账本'] }).text || ''))
  check('★★ 反例：评审卡也不带（评审不是施工）',
    !/前端施工纪律/.test(buildDispatchResult({ ...dm, tags: ['评审'] }).text || ''))
  // 源码守卫：界面确实把 type 传进去了（漏传 = 这条功能对桌面入口永久失效）
  const appSrc = fs.readFileSync(path.join(REPO, 'desktop/src/renderer/App.vue'), 'utf-8')
  check('★★ 界面确实把 type 传给 buildDispatchResult（漏传 = 桌面入口永久不下发）',
    /buildDispatchResult\(\{[\s\S]{0,600}?type:\s*String\(/.test(appSrc))
  // 与真源对账：文档里 R1–R5 都在（指路了但文件缺一节 = 空指针）
  const docP = path.join(REPO, 'docs', '施工纪律-前端.md')
  const doc = fs.existsSync(docP) ? fs.readFileSync(docP, 'utf-8') : ''
  check('★★ docs/施工纪律-前端.md 真存在且 R1–R5 五节齐全',
    [1, 2, 3, 4, 5].every((i) => doc.indexOf('## R' + i) >= 0),
    'len=' + doc.length)
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
