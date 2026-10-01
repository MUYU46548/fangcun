#!/usr/bin/env node
/**
 * 跨语言 frontmatter 契约测试（2026-10-01 · 通知中心诊断后的 P0-2）
 *
 * 为什么存在这一套：
 *   `task-data/*.md` 与 `docs/执行日志/*.md` 同时被**两个写者**读写 ——
 *   Python（tegula/core.py：CLI / 看板 / done / log）与桌面端 TS（desktop/src/main/data|services）。
 *   只要任一端写出对方读不懂的形态，对方的**下一次写回**就会把那个字段静默清空：
 *     · 2026-09-28 前言块式列表：parse_task 只认行内 → task-20260925-033 的项目归属与
 *       结果记录当场消失，全仓 30 张卡受影响（parse_task 里有当时的注释）；
 *     · 日志附件块式列表：_parse_log 只认行内 `[a, b]` → 读成 '' → 下次 _write_log 清空。
 *   两个方向 × 两种形态 = 4 条路，这条套件把它们逐条钉死：
 *       TS(块式 yaml.dump) → Python      Python(渲染) → TS(js-yaml)
 *       TS(手工内联)      → Python       Python(渲染) → TS
 *
 * 约束：零第三方依赖（Node 侧只用 stdlib + 仓库已有的 js-yaml 来**模拟** TS 侧的读法）。
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
let pass = 0
let fail = 0
const out = []
const check = (name, cond, detail) => {
  if (cond) { pass++; out.push('PASS  ' + name) }
  else { fail++; out.push('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

// ── 夹具：TS 端 yaml.dump 风格的任务（块式列表，桌面端 data/index.ts 的写法）──
const TASK_BLOCK = [
  '---',
  'id: task-fm-block',
  '标题: 块式列表任务',
  '项目: [fm-demo]',
  '状态: 待办',
  '阻塞:',
  '  - task-dep-a',
  '  - task-dep-b',
  '标签:',
  '  - tag-x',
  '---',
  '正文：这条文件是桌面端 yaml.dump 出来的形态，Python 必须读得懂',
  '',
].join('\n')

// 块式日志（历史上让附件被读空的形态）
const LOG_BLOCK = [
  '---',
  'schema_version: 1',
  'id: log_fm_block',
  'title: 块式附件日志',
  'project: fm-demo',
  '附件:',
  '  - report.md',
  '  - shot.png',
  '任务:',
  '  - task-1',
  '---',
  '正文',
  '',
].join('\n')

// TS renderLog 的**手工内联**形态（当前实现）
const LOG_INLINE = [
  '---',
  'schema_version: 1',
  'id: log_fm_inline',
  'title: 内联附件日志',
  'project: fm-demo',
  '附件: [a.png, b.md]',
  '任务: [task-1, task-2]',
  '---',
  '正文',
  '',
].join('\n')

const DRIVER = `
import sys, os, json
repo, tmp = sys.argv[1], sys.argv[2]
sys.path.insert(0, repo)
from tegula import core

data = os.path.join(tmp, 'data')
core.DATA_DIR = data
core.TASK_DIR = os.path.join(data, 'task-data')
core.REGISTRY_PATH = os.path.join(data, 'registry.yaml')
core.ACTIVITY_LOG = os.path.join(core.TASK_DIR, '.activity.log')
core._LOGS_DIR = os.path.join(data, 'logs')
os.makedirs(core.TASK_DIR, exist_ok=True)
os.makedirs(core._LOGS_DIR, exist_ok=True)
with open(core.REGISTRY_PATH, 'w', encoding='utf-8') as f:
    f.write('members: []\\nprojects: []\\nreleased: []\\n')

checks = []
def check(name, cond, detail=''):
    checks.append({'name': name, 'pass': bool(cond), 'detail': str(detail)[:240]})

# ── T1：TS yaml.dump 的块式任务 → Python parse_task ──
d1 = core.parse_task(os.path.join(tmp, 'task-block.md'))
check('TS 块式任务 → Python parse_task 还原「阻塞」列表',
      bool(d1) and d1.get('阻塞') == ['task-dep-a', 'task-dep-b'],
      d1 and repr(d1.get('阻塞')))
check('TS 块式任务 → Python parse_task 还原「标签」列表',
      bool(d1) and d1.get('标签') == ['tag-x'], d1 and repr(d1.get('标签')))

# ── T2：块式日志 → Python _parse_log（读空 = 下次写回清空，就是那起事故）──
with open(os.path.join(tmp, 'log-block.md'), encoding='utf-8') as f:
    fm2, _ = core._parse_log(f.read())
check('★★ 块式日志 → Python _parse_log 还原「附件」（否则下次写回静默清空）',
      fm2.get('附件') == ['report.md', 'shot.png'], repr(fm2.get('附件')))
check('★ 块式日志 → Python _parse_log 还原「任务」',
      fm2.get('任务') == ['task-1'], repr(fm2.get('任务')))

# ── T3：TS renderLog 的内联日志 → Python ──
with open(os.path.join(tmp, 'log-inline.md'), encoding='utf-8') as f:
    fm3, _ = core._parse_log(f.read())
check('TS 内联日志 → Python _parse_log 还原「附件」',
      fm3.get('附件') == ['a.png', 'b.md'], repr(fm3.get('附件')))
check('TS 内联日志 → Python _parse_log 还原「任务」',
      fm3.get('任务') == ['task-1', 'task-2'], repr(fm3.get('任务')))

# ── T4：Python 写日志 → 自己读回，列表不丢 ──
lid = 'log_fm_roundtrip'
core._write_log(lid, {
    'schema_version': 1, 'id': lid, 'title': '往返日志', 'project': 'fm-demo',
    '附件': ['x.png', 'y.md'], '任务': ['task-9'],
}, '正文')
got = core._read_log(lid)
fm4 = (got or {}).get('fm', {})
check('Python 写日志 → 读回「附件」不丢',
      fm4.get('附件') == ['x.png', 'y.md'], repr(fm4.get('附件')))
check('Python 写日志 → 读回「任务」不丢',
      fm4.get('任务') == ['task-9'], repr(fm4.get('任务')))
log_path = core._log_path(lid)

# ── T5：Python 写任务 → 自己读回，列表不丢 ──
tp = os.path.join(core.TASK_DIR, 'task-fm-rt.md')
core.write_task_file(tp, {
    'id': 'task-fm-rt', '标题': '往返任务', '项目': ['fm-demo'], '状态': '待办',
    '阻塞': ['dep-1'], '标签': ['t1'],
})
d5 = core.parse_task(tp)
check('Python 写任务 → 读回「阻塞」不丢', bool(d5) and d5.get('阻塞') == ['dep-1'],
      d5 and repr(d5.get('阻塞')))
check('Python 写任务 → 读回「标签」不丢', bool(d5) and d5.get('标签') == ['t1'],
      d5 and repr(d5.get('标签')))

# ── T6：Python 写出的形态必须是行内列表（TS 侧 js-yaml 两种都懂，但行内是两端公约）──
with open(tp, encoding='utf-8') as f:
    raw = f.read()
check('Python 写出的任务，「阻塞」是行内形态', '阻塞: [dep-1]' in raw,
      [ln for ln in raw.splitlines() if '阻塞' in ln])
with open(log_path, encoding='utf-8') as f:
    rawl = f.read()
check('Python 写出的日志，「附件」是行内形态', '附件: [x.png, y.md]' in rawl,
      [ln for ln in rawl.splitlines() if '附件' in ln])

print(json.dumps({'checks': checks, 'taskFile': tp, 'logFile': log_path}, ensure_ascii=False))
`

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|===)/.exec(text)
  return m ? m[1] : null
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-contract-'))
  fs.writeFileSync(path.join(tmp, 'task-block.md'), TASK_BLOCK, 'utf-8')
  fs.writeFileSync(path.join(tmp, 'log-block.md'), LOG_BLOCK, 'utf-8')
  fs.writeFileSync(path.join(tmp, 'log-inline.md'), LOG_INLINE, 'utf-8')
  const driverPath = path.join(tmp, 'driver.py')
  fs.writeFileSync(driverPath, DRIVER, 'utf-8')

  const r = spawnSync('python', [driverPath, REPO, tmp], { encoding: 'utf-8', timeout: 60000 })
  if (r.status !== 0) {
    check('Python 契约驱动能跑通', false, `exit=${r.status} ${(r.stderr || '').slice(-300)}`)
    finish()
    return
  }
  let drv
  try {
    drv = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop())
    check('Python 契约驱动能跑通', true)
  } catch (e) {
    check('Python 契约驱动能跑通', false, String((r.stdout || '').slice(-300)))
    finish()
    return
  }
  for (const c of drv.checks) check(c.name, c.pass, c.detail)

  // ── Python 写出的文件 → TS 侧读法（js-yaml，与 desktop/data 一致）──
  let yaml
  try {
    yaml = require(path.join(REPO, 'desktop', 'node_modules', 'js-yaml'))
    check('js-yaml 可用（模拟 TS 侧读法）', true)
  } catch (e) {
    check('js-yaml 可用（模拟 TS 侧读法）', false, String(e).slice(0, 200))
    finish()
    return
  }

  try {
    const tRaw = fs.readFileSync(drv.taskFile, 'utf-8')
    const tFm = yaml.load(splitFrontmatter(tRaw)) || {}
    check('★★ Python 写出的任务 → TS(js-yaml) 读到「阻塞」',
      JSON.stringify(tFm['阻塞']) === JSON.stringify(['dep-1']), JSON.stringify(tFm['阻塞']))
    check('Python 写出的任务 → TS(js-yaml) 读到「标签」',
      JSON.stringify(tFm['标签']) === JSON.stringify(['t1']), JSON.stringify(tFm['标签']))
  } catch (e) {
    check('★★ Python 写出的任务 → TS(js-yaml) 读到「阻塞」', false, String(e).slice(0, 200))
  }

  try {
    const lRaw = fs.readFileSync(drv.logFile, 'utf-8')
    const lFm = yaml.load(splitFrontmatter(lRaw)) || {}
    check('★★ Python 写出的日志 → TS(js-yaml) 读到「附件」',
      JSON.stringify(lFm['附件']) === JSON.stringify(['x.png', 'y.md']), JSON.stringify(lFm['附件']))
    check('Python 写出的日志 → TS(js-yaml) 读到「任务」',
      JSON.stringify(lFm['任务']) === JSON.stringify(['task-9']), JSON.stringify(lFm['任务']))
  } catch (e) {
    check('★★ Python 写出的日志 → TS(js-yaml) 读到「附件」', false, String(e).slice(0, 200))
  }

  // ── 源码守卫：为什么 T1/T2 必须长期存在（谁在生产这两种形态）──
  try {
    const logsTs = fs.readFileSync(path.join(REPO, 'desktop/src/main/services/logs.ts'), 'utf-8')
    check('源码守卫：TS 日志 yaml.dump 带 flowLevel:-1（列表一律内联，Python 逐行读才读得到）',
      /flowLevel:\s*-1/.test(logsTs))
    const dataIdx = fs.readFileSync(path.join(REPO, 'desktop/src/main/data/index.ts'), 'utf-8')
    check('源码守卫：TS 任务写盘仍走 yaml.dump（所以「块式 → Python」这条路永远活着）',
      /yaml\.dump/.test(dataIdx))
  } catch (e) {
    check('源码守卫：读取 TS 源文件', false, String(e).slice(0, 200))
  }

  finish()
}

function finish() {
  console.log(out.join('\n'))
  console.log(`通过 ${pass} / 失败 ${fail}`)
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
