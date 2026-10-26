/**
 * 卡 006 · MCP 读卡计量（2026-10-26）
 *
 * 要回答的问题（暮雨原话）：「看板任务一堆待办，很多我都不知道到底做了没有。
 * 而且不是应该 agent 会自己发现待办吗？做完会不会回写？」
 *
 * 前半句的根因不是状态字段不准，而是**状态只反映"有人改过它"**：
 * 一张卡放三个月没人打开，和"今天刚看过准备做"在数据上一模一样。
 * 这里钉住的就是补上那一维，并且守住三条：
 *  ① 只读行为**不许写任务文件**（否则每次读都变成写：乐观锁噪音、mtime 全变）；
 *  ② 计量失败**不许挡住读卡**（静默）；
 *  ③ 坏行/缺文件**不许炸**，也**不许把整份统计作废**。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '../..')
let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fails.push(name + (extra ? '  → ' + extra : '')); console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

// ── ① 计量本身（临时数据根，不碰真数据）────────────────────────────────
function usageChecks() {
  console.log('\n── ① 计量（临时数据根）──')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-usage-'))
  const STUB = path.join(REPO, 'scripts/test/electron-stub.cjs')
  const orig = Module._resolveFilename
  process.env.FC_TEST_USERDATA = base
  try {
    fs.mkdirSync(path.join(base, 'task-data'), { recursive: true })
    fs.writeFileSync(path.join(base, 'registry.yaml'), 'projects: []\n', 'utf-8')
    Module._resolveFilename = function (r, ...a) { return r === 'electron' ? STUB : orig.call(this, r, ...a) }
    // eslint-disable-next-line
    const data = require(path.join(REPO, 'desktop/dist/main/data/index.js'))
    data.setDataDir(base)
    // eslint-disable-next-line
    const U = require(path.join(REPO, 'desktop/dist/main/mcp/usage.js'))

    // 一张"真卡"文件，用来验"读别把它改动了"
    const taskFile = path.join(base, 'task-data', 'task-x.md')
    const body = '---\nid: task-x\n标题: 演示\n状态: 待办\n---\n正文\n'
    fs.writeFileSync(taskFile, body, 'utf-8')
    const before = fs.readFileSync(taskFile)

    U.recordRead('get_task', ['task-x'])
    U.recordRead('list_tasks', ['task-x', 'task-y', '', null])
    U.recordRead('get_task', [])                      // 空列表不写事件
    check('★ 读卡**不改任务文件**（逐字节相同 —— 这条是整张卡的设计前提）',
      Buffer.compare(before, fs.readFileSync(taskFile)) === 0)

    const logPath = path.join(base, 'mcp-usage.jsonl')
    check('计量落在独立日志 mcp-usage.jsonl（不是任务文件里）',
      fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf-8').indexOf('task-x') >= 0)
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n')
    check('空 ids 的那次没写事件（3 行 → 2 行）', lines.length === 2, 'lines=' + lines.length)

    const stats = U.readStats(30)
    check('★ 统计对：task-x 被读 2 次、task-y 1 次',
      stats.get('task-x').reads === 2 && stats.get('task-y').reads === 1,
      JSON.stringify([...stats].map(([k, v]) => [k, v.reads])))
    check('  记下最后来源（via）', stats.get('task-x').lastVia === 'list_tasks', stats.get('task-x').lastVia)

    check('「从未读过」清单只含没出现过的卡', (() => {
      const never = U.neverRead(['task-x', 'task-y', 'task-z'])
      return never.length === 1 && never[0] === 'task-z'
    })(), JSON.stringify(U.neverRead(['task-x', 'task-y', 'task-z'])))

    // 坏行 + 过期事件
    const old = { ts: new Date(Date.now() - 60 * 86400_000).toISOString(), via: 'get_task', ids: ['task-old'] }
    fs.appendFileSync(logPath, '{ 这不是 JSON\n', 'utf-8')
    fs.appendFileSync(logPath, JSON.stringify(old) + '\n', 'utf-8')
    const s2 = U.readStats(30)
    check('★ 坏行跳过、不影响其他卡（不整份作废）', s2.get('task-x') && s2.get('task-x').reads === 2)
    check('  30 天窗口外的旧事件不计入', !s2.has('task-old') && U.readStats(90).has('task-old'))

    // MCP 侧：never_read 必须能把这批"没人碰过"的卡数出来
    // ⚠ 必须用**没被记录过**的 id：上面 recordRead 已经把 task-x/task-y 都记过了，
    //   拿 task-y 当"没人读过"的样本会自相矛盾（第一版就是这么写错的，断言当场红）
    fs.writeFileSync(path.join(base, 'task-data', 'task-z.md'),
      '---\nid: task-z\n标题: 没人读过的卡\n状态: 待办\n优先级: 高\n---\n正文\n', 'utf-8')
    fs.writeFileSync(path.join(base, 'task-data', 'task-y.md'),
      '---\nid: task-y\n标题: 读过但没细看的卡\n状态: 待办\n---\n正文\n', 'utf-8')
    // eslint-disable-next-line
    const tools = require(path.join(REPO, 'desktop/dist/main/mcp/tools.js'))
    const listed = tools.MCP_TOOLS.map((t) => t.name)
    check('★ MCP 工具表里有 never_read 与 usage_report（对外可见）',
      listed.includes('never_read') && listed.includes('usage_report'), listed.join(','))
    const r = tools.handleMCPToolCall('never_read', { days: 30 })
    let payload = null
    try { payload = JSON.parse(r.content[0].text) } catch { /* 下面会红 */ }
    check('★★ never_read 数对了：3 张未完结卡里只有 task-z 没人读过',
      payload && payload.total_open === 3 && payload.never_read === 1
      && payload.items.length === 1 && payload.items[0].id === 'task-z',
      JSON.stringify(payload && { total: payload.total_open, never: payload.never_read, ids: payload.items.map((x) => x.id) }))
    check('  输出里带窗口天数（口径要写在数字旁边）', payload && payload.window_days === 30)
  } catch (e) {
    check('计量组没抛异常', false, (e && e.stack) || String(e))
  } finally {
    Module._resolveFilename = orig
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

// ── ② `tegula next` 要读出这两行（真跑 CLI，只读）──────────────────────
function cliChecks() {
  console.log('\n── ② tegula next（真跑，只读）──')
  let out = ''
  try {
    out = execFileSync('python', ['tegula.py', 'next'], { cwd: REPO, encoding: 'utf-8', timeout: 60_000 })
  } catch (e) {
    check('tegula next 能跑', false, (e && e.message) || String(e))
    return
  }
  check('★ 文本输出里有「触发条件」一行（为什么现在该做它）', /触发条件\s*:/.test(out))
  check('★★ 文本输出里有「被读过」一行（这张卡到底有没有人碰过）', /被读过\s*:/.test(out), out.slice(0, 120))
  check('  没被读过时说清是 0 次，而不是留空', /被读过\s*: 近 30 天 0 次/.test(out) || /被读过\s*: \d+ 次/.test(out))

  let json = null
  try {
    json = JSON.parse(execFileSync('python', ['tegula.py', 'next', '--format', 'json'], { cwd: REPO, encoding: 'utf-8', timeout: 60_000 }))
  } catch (e) {
    check('tegula next --format json 能跑', false, (e && e.message) || String(e))
  }
  if (json) {
    check('★ json 面也带 usage（agent 能判断"没人碰过"）',
      json.usage && typeof json.usage.reads === 'number', JSON.stringify(json.usage))
  }
}

// ── ③ 源码守卫 ─────────────────────────────────────────────────────────
function guardChecks() {
  console.log('\n── ③ 源码守卫 ──')
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8').replace(/\r\n/g, '\n')
  const tools = read('desktop/src/main/mcp/tools.ts')
  const usage = read('desktop/src/main/mcp/usage.ts')
  const cli = read('tegula/cli.py')

  check('★ 三条读工具都记了（list_tasks / get_task / search_tasks）',
    /recordRead\('list_tasks'/.test(tools) && /recordRead\('get_task'/.test(tools) && /recordRead\('search_tasks'/.test(tools))
  check('★ never_read 只读（handler 里不许出现写任务/改状态的调用）', (() => {
    const i = tools.indexOf("case 'never_read'")
    if (i < 0) return false
    const seg = tools.slice(i, i + 2200)
    return !/moveStatus|updateTask|createTask|deleteTask|writeTaskFile/.test(seg)
  })())
  check('★ 计量模块不碰任务写入（不许 import writeTaskFile / render_task 那套）',
    !/writeTaskFile|renderTask|write_task_file/.test(usage))
  check('  计量写入失败静默（catch 里不做任何 UI/日志动作）', /catch \{ \/\* 铁律：静默 \*\/ \}/.test(usage))
  check('★ cli.py 用的是 core 的 DATA_DIR（同一数据根，不在别处另算）',
    /DATA_DIR/.test(cli) && /os\.path\.join\(DATA_DIR, "mcp-usage\.jsonl"\)/.test(cli))
}

usageChecks()
cliChecks()
guardChecks()

console.log('\n──────────────────────────────')
if (fails.length) {
  console.log(`通过 ${pass} / 失败 ${fails.length}`)
  fails.forEach((f) => console.log('  · ' + f))
  process.exit(1)
}
console.log(`RESULT ${pass} / 0  —— 卡 006 读卡计量全绿`)
