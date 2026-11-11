#!/usr/bin/env node
/**
 * 进队列闸 · 跨语言一致性 e2e（2026-11-11）
 *
 * 为什么要这一套：进队列锁有两个实现（桌面 `data/qnGate.ts` + `qnQueueGate.ts`，
 * CLI `tegula/core.py#_queue_gate_reason`）。两种语言没法共用一个运行时函数，
 * 所以**判据必须逐条对齐** —— 否则 GUI 锁得住、CLI 锁不住，闸就是纸糊的。
 *
 * 判法：同一批夹具（卷 md + answers.json + 任务卡）先让 **TS 侧**判一遍（真走
 * `tasks.moveStatus` 到「待办」），再把同一批卡交给 **Python 侧**判一遍
 * （真 import tegula.core，同一个临时数据根），逐条比 `ok`。
 *
 * 运行：node scripts/test/e2e-qn-queue-parity.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { spawnSync } = require('child_process')
const { mkTmp } = require('./_tmp.cjs')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist')
const TMP = mkTmp('qn-parity-')
const DATA = path.join(TMP, 'data')
const TASK_DIR = path.join(DATA, 'task-data')
const QDIR = path.join(TASK_DIR, 'questionnaires')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
for (const d of [DATA, TASK_DIR, QDIR, process.env.FC_TEST_USERDATA]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'),
  'projects:\n  - id: fangcun-base\n    name: 方寸\n    repo: .\n', 'utf-8')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(DATA)
const tasks = require(path.join(DIST, 'main', 'data', 'tasks.js'))
const store = require(path.join(DIST, 'main', 'data', 'questionnaires.js'))

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
  return !!cond
}

// ── 夹具 ────────────────────────────────────────────────────────────────
const Q1 = [
  '## A1 形状', '做一件还是两件？',
  '- **A. 甲**——代价甲', '- **B. 乙**——代价乙',
  '【验收线】出现反例即违约', '',
]
function deck(name, lines) { fs.writeFileSync(path.join(QDIR, name + '.md'), lines.join('\n'), 'utf-8') }
deck('齐了', ['# 齐了卷', '**项目**：fangcun-base', ...Q1])
deck('没批', ['# 没批卷', '**项目**：fangcun-base', ...Q1])
deck('有反问', ['# 反问卷', '**项目**：fangcun-base', ...Q1])
deck('全否', ['# 全否卷', '**项目**：fangcun-base', ...Q1])
deck('缺题', ['# 缺题卷', '**项目**：fangcun-base'])
deck('部分答', ['# 部分答卷', '**项目**：fangcun-base', ...Q1,
  '## A2 顺序', '先做哪件？', '- **A. 先甲**——代价甲', '- **B. 先乙**——代价乙', '【验收线】顺序颠倒即违约', ''])
deck('别家卷', ['# 别家卷', '**项目**：sitian', ...Q1])
store.writeAnswers('齐了', { answers: { A1: { kind: 'pick', k: 'A' } } }); store.approveDeck('齐了')
store.writeAnswers('没批', { answers: { A1: { kind: 'pick', k: 'A' } } })          // 没批准
store.writeAnswers('有反问', { answers: { A1: { kind: 'askback', text: '问错了' } } }); store.approveDeck('有反问')
store.writeAnswers('全否', { answers: { A1: { kind: 'reject' } }, approvedAt: new Date().toISOString() })
store.writeAnswers('缺题', { answers: {}, approvedAt: new Date().toISOString() })
store.writeAnswers('部分答', { answers: { A1: { kind: 'pick', k: 'A' } }, approvedAt: new Date().toISOString() })
store.writeAnswers('别家卷', { answers: { A1: { kind: 'pick', k: 'A' } }, approvedAt: new Date().toISOString() })

const CASES = [
  { key: '卷已批准且无待答', deck: '齐了', expect: true },
  { key: '答案没批准', deck: '没批', expect: false },
  { key: '卷里有反问', deck: '有反问', expect: false },
  { key: '整卷全否决', deck: '全否', expect: false },
  { key: '卷里一道题都没有', deck: '缺题', expect: false },
  { key: '卷根本不存在', deck: '鬼卷', expect: false },
  { key: '没声明澄清卷（普通卡）', deck: '', expect: true },
  // 题目级澄清（`<卷>#<题号>`）：同一卷、两题只答一题
  { key: '题目级：答了的那题', deck: '部分答#A1', expect: true },
  { key: '题目级：没答的那题', deck: '部分答#A2', expect: false },
  { key: '整卷押但在部分答卷上', deck: '部分答', expect: false },
  // 项目对不上（2026-11-11 评审抓到的第二条：Python 侧曾漏掉这条判据）
  { key: '拿别家项目的卷当依据', deck: '别家卷', expect: false },
]

// ── TS 侧 ───────────────────────────────────────────────────────────────
const tsVerdicts = {}
const ids = {}
for (const c of CASES) {
  const t = tasks.createTask({
    title: 'parity-' + c.key, status: '草稿', project: 'fangcun-base',
    clarify: c.deck || undefined,
  })
  ids[c.key] = t.id
  let ok = true, why = ''
  try { tasks.moveStatus(t.id, '待办') } catch (e) { ok = false; why = String(e.message || e) }
  tsVerdicts[c.key] = { ok, why }
}

// ── Python 侧（同一个临时数据根；真 import tegula.core）─────────────────
const pyFile = path.join(TMP, 'probe.py')
fs.writeFileSync(pyFile, `
import json, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import tegula.core as core
core.TASK_DIR = ${JSON.stringify(TASK_DIR)}
core.REGISTRY_PATH = ${JSON.stringify(path.join(DATA, 'registry.yaml'))}
core._GATES_SRC = None
out = {}
ids = json.loads(sys.stdin.read())
for key, tid in ids.items():
    p = core.locate_task(tid)
    d = core.parse_task(p) if p else None
    if d is None:
        out[key] = {"ok": None, "why": "parse fail"}
        continue
    why = core._queue_gate_reason(d)
    out[key] = {"ok": not why, "why": why}
print(json.dumps(out, ensure_ascii=False))
`, 'utf-8')

const py = spawnSync('python', [pyFile], {
  input: JSON.stringify(ids),
  encoding: 'utf-8',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  timeout: 120000,
})
if (py.error || py.status !== 0) {
  check('★★ Python 侧探针能跑起来（跨语言对账的前提）', false, String(py.error || py.stderr || py.stdout).slice(0, 400))
} else {
  let pyVerdicts = {}
  try { pyVerdicts = JSON.parse(String(py.stdout).trim().split('\n').pop()) } catch (e) {
    check('★★ Python 侧输出是 JSON', false, String(py.stdout).slice(0, 300))
  }
  console.log('== 逐条对账（TS vs Python）==')
  for (const c of CASES) {
    const tsv = tsVerdicts[c.key] || {}
    const pyv = pyVerdicts[c.key] || {}
    check(`★★ 「${c.key}」两侧一致（期望 ${c.expect ? '放行' : '拒'}）`,
      tsv.ok === c.expect && pyv.ok === c.expect && tsv.ok === pyv.ok,
      `TS=${JSON.stringify(tsv).slice(0, 160)} PY=${JSON.stringify(pyv).slice(0, 160)}`)
  }
  // 拒因必须能指回具体东西（卷名 / 题号 / 项目），不能只说“不允许”
  check('★★ 拒的时候两侧都说清了是哪一卷/哪一题（不是空话）',
    CASES.filter((c) => !c.expect).every((c) => {
      const name = String(c.deck || '').split('#')[0]
      const okMsg = (w) => w && (w.includes(name) || w.includes('属于') || w.includes('卷《'))
      return okMsg(tsVerdicts[c.key].why) && okMsg(pyVerdicts[c.key].why)
    }),
    JSON.stringify(CASES.filter((c) => !c.expect).map((c) => [c.deck, tsVerdicts[c.key].why, pyVerdicts[c.key].why])).slice(0, 500))
}

console.log(`\nRESULT ${pass} / ${fail}`)
if (fail) { console.log('失败明细：'); failures.forEach((f) => console.log('  · ' + f)) }
process.exit(fail === 0 ? 0 : 1)
