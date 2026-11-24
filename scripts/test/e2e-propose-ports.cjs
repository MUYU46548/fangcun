#!/usr/bin/env node
/**
 * K3 · 插件四个「出卷 / 提议」口（2026-11-24，落地 2026-11-23 问卷 K3 的答案 A）
 *
 * ## 为什么做这件事（机器真因，不是态度问题）
 *
 * 2026-11-23 查实：`dsh-fangcun` 插件只注册了 7 个工具，`fangcun_write` 的 action 只有
 * `create` / `update` / `move` —— **没有 qn_propose、没有 decision_propose**。
 * 而技能卡 `fangcun-bridge` 的 ①.9 完整写着「有 ≥2 个问题要拍板 → 用 qn_propose 出卷」。
 * **技能教了，工具没有。** 实测插件日志：500 条记录 / 14 个会话，问卷类调用 **0 次**。
 *
 * K3 原话：「A. 现在就做，四个口一起补（questionnaire / decision / stage_plan / smap）」。
 *
 * ## 这个守卫钉的是「闸」，不是「转发」
 *
 * 四个口的存在意义是"AI 能主动问你"，那同时也意味着**它有了一个新的打扰你的能力**。
 * 所以每条断言问的都是同一句话：**它能不能自己把事定了？**
 *
 *   ① `decision_propose` 传「有效」必须**被拒**（不是悄悄改成待审批）——
 *      悄悄改会让模型以为自己已经定了一件事，实际只是提了个议案；
 *   ② 待审批的决策**不进** agent 开工读到的"最近有效决策"与上下文包
 *      （未获批准的规矩被当成现行规矩读，比没有这条规矩更危险）；
 *   ③ 问卷 / 阶段卡 / 结构地图三个口落的都是**草稿态**，用户不点就不生效；
 *   ④ 四个口的名字必须**两边逐字一致**（插件 → 方寸 MCP），
 *      否则症状是"点了什么都没发生"——两边单测都绿。
 *
 * 运行：node scripts/test/e2e-propose-ports.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const PLUGIN = path.join(REPO, '..', 'dsh-fangcun')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

console.log('== K3 · 插件四个提议口 ==')

// ── ① 四个口都在插件里，且名字与方寸 MCP 工具表逐字一致 ──────────────────
const TOOL = path.join(PLUGIN, 'lib', 'tool.js')
if (!fs.existsSync(TOOL)) {
  console.log('FAIL  插件仓库在（同机并列 ../dsh-fangcun）  → ' + TOOL)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const toolSrc = fs.readFileSync(TOOL, 'utf8')
const mcpSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'mcp', 'tools.ts'), 'utf8')

const mcpToolNames = [...mcpSrc.matchAll(/^\s{4}name: '([a-z_]+)',/gm)].map((m) => m[1])
const FOUR = ['qn_propose', 'decision_propose', 'stage_plan_propose', 'smap_propose']
for (const t of FOUR) {
  check(`★ 方寸 MCP 有 ${t} 这个工具`, mcpToolNames.includes(t), mcpToolNames.slice(0, 8).join(','))
}

// 插件侧：WRITE_ACTIONS 里四个 action → 同名方寸工具（逐字相等，不许映射到别名）
for (const t of FOUR) {
  const re = new RegExp(`\\b${t}:\\s*'([a-z_]+)'`)
  const m = re.exec(toolSrc)
  check(`★★ 插件 ${t} → 方寸 ${t}（两边名字逐字一致，否则"点了没反应"）`,
    m && m[1] === t, m ? `插件映射到 ${m[1]}` : '插件里没有这条映射')
}

// ── ② 闸：四个口都只能落草稿态 ──────────────────────────────────────────
console.log('\n-- 四个口都只能落草稿态（不能自批） --')
const REQUIRED_STRINGS = [
  ['decision_propose', /不接受 status/, toolSrc],
  // 这道闸的**话术**在方寸侧（tools.ts 的 case）—— 插件只管把参数转过去，
  // 真正拒"传有效"的地方是方寸。分开扫，别把两处的断言混成一处。
  ['decision_propose', /agent 只能提「待审批」/, mcpSrc],
  ['qn_propose', /缺 id/, toolSrc],
  ['qn_propose', /至少要 2 个/, toolSrc],
  ['qn_propose', /代价说明/, toolSrc],
  ['qn_propose', /验收线/, toolSrc],
  ['stage_plan_propose', /技术方案/, toolSrc],
  ['stage_plan_propose', /照抄点/, toolSrc],
  ['stage_plan_propose', /判据/, toolSrc],
  ['stage_plan_propose', /cmd:/, toolSrc],
  ['smap_propose', /最后核实/, toolSrc],
]
for (const [who, re, src] of REQUIRED_STRINGS) {
  check(`★ ${who} 的硬校验还在（${String(re).slice(1, 24)}…）`, re.test(src))
}

// ── ③ 决策：待审批不许泄给 agent ────────────────────────────────────────
console.log('\n-- 待审批的决策不许被 agent 当成现行规矩 --')
const DEC = path.join(REPO, 'desktop', 'src', 'main', 'data', 'decisions.ts')
const decSrc = fs.readFileSync(DEC, 'utf8')
check('★ 决策卡有四态且含「待审批」', /DECISION_STATUSES[^=]*=\s*\[[^\]]*待审批/.test(decSrc))
check('★ 常量 DECISION_PENDING 就是「待审批」', /DECISION_PENDING[^=]*=\s*'待审批'/.test(decSrc))
check('★★ agent 可写状态白名单只含「待审批」',
  /AGENT_WRITABLE_DECISION_STATUSES[^=]*=\s*\[DECISION_PENDING\]/.test(decSrc))

// 上下文包只取「有效」—— 这是"未批准的规矩不外泄"的落点
const CP = path.join(REPO, 'desktop', 'src', 'main', 'services', 'contextPack.ts')
const cpSrc = fs.readFileSync(CP, 'utf8')
check('★★ 上下文包只把「有效」的决策喂给 agent（待审批的不进）',
  /loadDecisions\(\)\.filter\(\(d\) => String\(d\.状态 \|\| ''\) === '有效'/.test(cpSrc))

// ── ④ 真跑一遍方寸侧：待审批落盘 / 不外泄 / 传有效被拒 ──────────────────
console.log('\n-- 真跑方寸 MCP（临时数据目录，不碰真实数据） --')
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-propose-'))
try {
  fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(DATA, 'registry.yaml'),
    'members: []\nprojects:\n  - id: p1\n    name: 夹具项目\nreleased: []\n', 'utf-8')
  fs.writeFileSync(path.join(DATA, 'task-data', 'decisions.md'),
    '# 决策记录（决策卡）\n\n## D-001 早就定下的一件事\n\n- 日期: 2026-11-01\n- 状态: 有效\n- 项目: p1\n- 出处: 人\n', 'utf-8')

  const driver = `
  const D = ${JSON.stringify(path.join(REPO, 'desktop'))}
  const out = []
  const check = (n, c, d) => out.push({ n, c: !!c, d: String(d || '').slice(0, 240) })
  const tools = require(D + '/dist/main/mcp/tools.js')
  const data = require(D + '/dist/main/data/index.js')
  data.setDataDir(${JSON.stringify(DATA)})
  const call = (name, args) => {
    const r = tools.handleMCPToolCall(name, args || {})
    const txt = r && r.content && r.content[0] && r.content[0].text
    try { return JSON.parse(txt) } catch (e) { return { __raw: txt } }
  }

  // ① 传「有效」→ 必须被拒（不是悄悄降级）
  const evil = call('decision_propose', { content: '偷偷生效的一条', source: 'agent 自说自话', status: '有效' })
  check('★★ agent 传「有效」被明确拒（不是悄悄改成待审批）', evil && evil.ok === false, JSON.stringify(evil))
  check('★ 拒绝话术点明"转正由用户在决策页点"',
    evil && /待审批|转正/.test(String(evil.error || '')), String(evil && evil.error))

  // ② 正常提议 → 落待审批
  const ok = call('decision_propose', { content: '夹具提议的决策', source: '测试用例', project: 'p1' })
  check('★★ 正常提议落盘成功', ok && ok.ok === true, JSON.stringify(ok))
  check('★★ 读回状态就是「待审批」', ok && ok.status === '待审批', JSON.stringify(ok))
  check('★ 返回值明说"用户点了才生效"', ok && /待审批/.test(String(ok.hint || '')), String(ok && ok.hint))

  // ③ 待审批不进 decision_list 的「有效」口径
  const effective = call('decision_list', { status: '有效' })
  const list = Array.isArray(effective.decisions) ? effective.decisions : []
  check('★★ 待审批的决策不出现在「有效」清单里（未批准 ≠ 现行规矩）',
    !list.some((d) => String(d.内容 || '').includes('夹具提议')), list.map((d) => d.内容).join(' | '))
  check('对照：早就定下的那条仍在（判据没被写死成"什么都不返回"）',
    list.some((d) => String(d.内容 || '').includes('早就定下')), list.map((d) => d.内容).join(' | '))

  // ④ 显式查待审批能看到它（用户/工具要知道"有东西等我签"）
  const pending = call('decision_list', { status: '待审批' })
  const pl = Array.isArray(pending.decisions) ? pending.decisions : []
  check('★ 显式查「待审批」能查到（不能藏起来等人猜）',
    pl.some((d) => String(d.内容 || '').includes('夹具提议')), pl.map((d) => d.内容).join(' | '))
  console.log('__RESULT__' + JSON.stringify(out))
  `
  const r = require('child_process').spawnSync(process.execPath, ['-e', driver], { encoding: 'utf-8', timeout: 60000 })
  const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('__RESULT__'))
  if (!line) {
    check('方寸 MCP 子进程跑得起来', false, String(r.stderr || '').slice(0, 300))
  } else {
    for (const row of JSON.parse(line.slice('__RESULT__'.length))) {
      check(row.n, row.c, row.d)
    }
  }
} finally {
  try { fs.rmSync(DATA, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\nRESULT ${pass} / ${pass + fail}`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
