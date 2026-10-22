#!/usr/bin/env node
/**
 * agent 上下文包测试（2026-10-22 · 出单卡「规划上下文包 b 版核对补齐」的落地物）
 *
 * 这个东西的**唯一职责**是把散在六处的现状拼成一段能直接粘给 agent 的 Markdown，
 * 不评价不建议。所以断言只盯两件事：
 *
 *   ★ 拼进来的东西**必须是真身原文**（契约多行块、三字段、有效决策、未完成卡、日志），
 *     不许摘要、不许改写 —— 拼错了 agent 会照着错的干；
 *   ★ 缺什么**必须说出来**（missing + 正文里那句「还没有立项契约」）——
 *     "没写"和"写了但空"对 agent 是两回事，静默省略等于告诉它"这项目没这规矩"。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpack-e2e-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
const repoFull = path.join(TMP, 'repoFull')
const repoBare = path.join(TMP, 'repoBare')
process.env.FC_TEST_USERDATA = USERDATA
for (const d of [DATA, USERDATA, repoFull, repoBare]) fs.mkdirSync(d, { recursive: true })
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.mkdirSync(path.join(DATA, 'docs', '执行日志'), { recursive: true })
fs.mkdirSync(path.join(DATA, 'policies'), { recursive: true })

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

// ── 夹具 ────────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(DATA, 'registry.yaml'), [
  'members: []',
  'projects:',
  '  - id: full',
  '    name: 齐全项目',
  `    repo: ${repoFull.replace(/\\/g, '/')}`,
  '    状态: 活跃开发中（夹具）',
  '    路线图: 跑通第一单',
  '    说明: 欠着：①甲欠账 ②乙欠账',
  '  - id: bare',
  '    name: 光板项目',
  `    repo: ${repoBare.replace(/\\/g, '/')}`,
  '    状态: ""',
  'released: []',
  '',
].join('\n'), 'utf-8')

// 契约：故意用「多行 + Markdown 表格」的写法，验"原文成块"而不是被塞进一行列表
fs.writeFileSync(path.join(repoFull, '立项契约.md'), [
  '# 立项契约 · 齐全项目',
  '',
  '## ① 终态形态',
  '桌面端为主产品。',
  '',
  '## ② 验收线',
  '一屏可见。',
  '',
  '## ③ 不要什么',
  '- 不做重型表单',
  '- 不做表单式录入',
  '',
  '## ④ 选型定死',
  '| 项 | 定死为 |',
  '|---|---|',
  '| 运行环境 | Windows 11 |',
  '',
].join('\n'), 'utf-8')

// 方针（格式是 `## 分节`，不是 kv —— policies.getPolicy 用 section('使命') 抓）
fs.writeFileSync(path.join(DATA, 'policies', 'full.md'), [
  '# 方针 · 齐全项目',
  '',
  '更新: 2026-10-22',
  '',
  '## 使命',
  '让项目状态有地方挂',
  '',
  '## 当前目标',
  '一屏看完',
  '',
  '## 应用场景',
  '桌面端重度使用',
  '',
  '## 方针边界',
  '不乱改用户数据',
  '',
  '## 结构地图',
  '',
  '> 最后核实：2026-10-22',
  '',
  '- 模块清单：core / cli',
  '',
].join('\n'), 'utf-8')

// 决策：1 条本项目有效 / 1 条已撤销（不该出现）/ 1 条全局有效（该出现）
// ⚠ 文件在 task-data/decisions.md，格式是 `## D-00x 内容` + `- 键: 值`（不是 Markdown 表格）
fs.writeFileSync(path.join(DATA, 'task-data', 'decisions.md'), [
  '# 决策记录（决策卡）',
  '',
  '## D-001 本项目：走 BYOK 自填端点',
  '- 日期: 2026-10-20',
  '- 状态: 有效',
  '- 项目: full',
  '- 出处: 群聊拍板',
  '',
  '## D-002 这条已经撤了不该出现',
  '- 日期: 2026-10-19',
  '- 状态: 已撤销',
  '- 项目: full',
  '- 出处: 群聊',
  '',
  '## D-003 全局：不连默认端点',
  '- 日期: 2026-10-18',
  '- 状态: 有效',
  '- 出处: 群聊',
  '',
].join('\n'), 'utf-8')

const mkTask = (id, title, project, status, prio, plan) => [
  '---', `id: ${id}`, `标题: ${title}`, `项目: [${project}]`, `状态: ${status}`,
  `优先级: ${prio}`, '创建: 1791000000', '更新: 1791000000', '来源: human',
  '指派: hermes', '验收: 暮雨', '阻塞: []',
  '---', '## 方案', plan || '- [ ] 做点事', '', '## 结果记录', '',
].join('\n')
fs.writeFileSync(path.join(DATA, 'task-data', 't-hi.md'), mkTask('t-hi', '高优先级的活', 'full', '待办', '高', '- [ ] 先改 core.py 的解析入口'), 'utf-8')
fs.writeFileSync(path.join(DATA, 'task-data', 't-low.md'), mkTask('t-low', '低优先级的活', 'full', '待办', '低'), 'utf-8')
fs.writeFileSync(path.join(DATA, 'task-data', 't-done.md'), mkTask('t-done', '已经做完的活', 'full', '完成', '中'), 'utf-8')

fs.writeFileSync(path.join(DATA, 'docs', '执行日志', 'log_1.md'), [
  '---', 'type: execution-log', 'id: log_1', 'project: full',
  'title: 今天把解析入口理了一遍', 'status: completed',
  "created: '2026-10-21T02:00:00.000Z'", 'tags: []', 'tasks: []', '---', '正文不重要。', '',
].join('\n'), 'utf-8')

// ── 加载产物 ────────────────────────────────────────────────────────────
const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)
const cp = require(path.join(DIST, 'services', 'contextPack.js'))

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}

console.log('---- 1. 齐全项目：六处来源一处不漏 ----')
const full = cp.buildContextPack('full')
check('生成成功', full.ok, full.error)
const t = String(full.text || '')
check('★ 七个小节都在（边界/状态/方针/决策/未完成卡/日志/硬约束）',
  ['## 1. 这个项目的边界', '## 2. 现在的状态', '## 3. 方针', '## 4. 已经拍板的事',
   '## 5. 还没做完的卡', '## 6. 最近做了什么', '## 7. 干活时的硬约束'].every((k) => t.indexOf(k) >= 0),
  t.slice(0, 80))
check('★ 契约四字段是**原文**（不是摘要）',
  t.indexOf('桌面端为主产品。') >= 0 && t.indexOf('一屏可见。') >= 0
  && t.indexOf('不做表单式录入') >= 0 && t.indexOf('| 运行环境 | Windows 11 |') >= 0)
check('★ 多行契约块没被塞进一行列表（表格能原样渲染）',
  t.indexOf('\n| 项 | 定死为 |') >= 0, '')
check('★ 登记表三字段原值都在',
  t.indexOf('活跃开发中（夹具）') >= 0 && t.indexOf('跑通第一单') >= 0 && t.indexOf('①甲欠账') >= 0)
check('★ 方针四字段 + 结构地图都在',
  t.indexOf('让项目状态有地方挂') >= 0 && t.indexOf('不乱改用户数据') >= 0 && t.indexOf('模块清单：core / cli') >= 0)
check('★ 没缺项时 missing 为空', Array.isArray(full.missing) && full.missing.length === 0, JSON.stringify(full.missing))

console.log('\n---- 2. 决策只列「有效」，且带出处 ----')
check('★★ 有效决策在（本条目的）', t.indexOf('走 BYOK 自填端点') >= 0)
check('★★ 全局有效决策也在（项目为空的那些对谁都算）', t.indexOf('不连默认端点') >= 0)
check('★★ 已撤销的**不许**出现（否则 agent 会把撤销过的当现行规矩）',
  t.indexOf('这条已经撤了') < 0)
check('  带出处（能追到是谁拍的板）', t.indexOf('出处：群聊拍板') >= 0)

console.log('\n---- 3. 未完成卡：按优先级、排除已完成、带方案第一条 ----')
const iHi = t.indexOf('高优先级的活')
const iLow = t.indexOf('低优先级的活')
check('★ 未完成卡都在', iHi > 0 && iLow > 0)
check('★ 按优先级排（高在前）', iHi > 0 && iLow > 0 && iHi < iLow, `hi=${iHi} low=${iLow}`)
check('★ 已完成的卡不进第 5 节', t.indexOf('已经做完的活') < 0)
check('  带方案第一条（agent 知道从哪下手）', t.indexOf('先改 core.py 的解析入口') >= 0)
check('  卡片数从真身算（2 张未完成）', String(full.counts.tasks) === '2', JSON.stringify(full.counts))

console.log('\n---- 4. 日志：在、带日期 ----')
check('★ 最近日志在', t.indexOf('今天把解析入口理了一遍') >= 0)
check('  带日期', /- 2026-10-21 · 今天把解析入口理了一遍/.test(t), '')

console.log('\n---- 5. 缺什么必须说出来（不许静默省略） ----')
const bare = cp.buildContextPack('bare')
const bt = String(bare.text || '')
check('光板项目也能生成（不是报错）', bare.ok, bare.error)
check('★★ missing 逐项列出缺什么',
  Array.isArray(bare.missing) && bare.missing.indexOf('立项契约') >= 0
  && bare.missing.indexOf('方针') >= 0 && bare.missing.indexOf('未完成任务卡') >= 0
  && bare.missing.indexOf('执行日志') >= 0,
  JSON.stringify(bare.missing))
// ⚠ 「有效决策卡」不该在 missing 里：那条全局决策（项目为空）对每个项目都算数。
//   这条同时钉住了"全局决策不能因为项目不匹配就被丢掉"。
check('★ 全局决策仍算数 → 光板项目不缺「有效决策卡」',
  bare.missing.indexOf('有效决策卡') < 0 && bt.indexOf('不连默认端点') >= 0,
  JSON.stringify(bare.missing))
check('★★ 正文里明说「还没有立项契约」（不是空着不提）',
  bt.indexOf('还没有立项契约') >= 0, bt.slice(0, 100))
check('★ 没填的字段写「（未填）」', bt.indexOf('（未填）') >= 0)
check('★ 结尾有一句「缺不等于没有」的警告', bt.indexOf('缺不等于没有') >= 0)
check('★ 缺项时 counts 能看出这是空包',
  bare.counts && bare.counts.tasks === 0 && bare.counts.logs === 0, JSON.stringify(bare.counts))

console.log('\n---- 6. 边界 ----')
check('空 id → 显式报错', cp.buildContextPack('').ok === false)
check('不存在的项目 → 显式报错', cp.buildContextPack('nope').ok === false)
const limited = cp.buildContextPack('full', { maxTasks: 1 })
const lt = String(limited.text || '')
check('maxTasks 生效（只列 1 张，且说明还有多少）',
  lt.indexOf('高优先级的活') >= 0 && lt.indexOf('低优先级的活') < 0 && lt.indexOf('另有') >= 0,
  '')
check('★ 中文标点 / 表格竖线没被转义或吃掉（原文照搬）', lt.indexOf('| 运行环境 | Windows 11 |') >= 0)

console.log(`\n==== ${PASS} 通过 / ${FAILS.length} 失败 ====`)
if (FAILS.length) { FAILS.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1) }
