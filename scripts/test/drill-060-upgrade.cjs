#!/usr/bin/env node
/**
 * 0.6.0 升级 / 回滚演练（卡 060-升级回滚演练-f9916b97，2026-11-02）
 *
 * 卡上的验收标准：升级与回滚各成功一次；**回滚后卡数、决策数、日志数与升级前逐项一致**；
 * 两段耗时均有记录。暮雨批注：「爱做就做吧，注意隔离」。
 *
 * 隔离怎么做：全程只在临时目录里跑，真实 task-data **一个字节都不动**（跑完会核对）。
 *
 * 为什么这么设计 —— 方寸的数据层是"纯文件 + frontmatter"，升级本身不做 schema 迁移：
 *   0.5.7 → 0.6.0 之间新增的是**独立文件**（llm-channels.json / plans/_drafts/），
 *   旧版读到不认识的文件只会忽略，不会崩。
 *   所以真正的风险不在"升级时数据被改坏"，而在**回滚时能不能回到升级前那一份**。
 *   这就决定了本演练的主角是"备份 → 覆盖使用 → 从备份回滚 → 逐项对账"。
 *
 * 运行：node scripts/test/drill-060-upgrade.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const Module = require('module')

const REPO = path.resolve(__dirname, '../..')
const orig = Module._resolveFilename
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron') return path.join(REPO, 'scripts/test/electron-stub.cjs')
  return orig.call(this, r, ...a)
}

const WORK = path.join(process.env.TMPDIR || os.tmpdir(), 'fc-060-drill-' + Date.now())
const DATA = path.join(WORK, 'task-data')
const SNAP = path.join(WORK, 'snapshot')

let pass = 0
let fail = 0
const check = (n, ok, d) => {
  if (ok) { pass++; console.log('PASS  ' + n + (d ? '  · ' + d : '')) }
  else { fail++; console.log('FAIL  ' + n + (d !== undefined ? '  → ' + JSON.stringify(d).slice(0, 300) : '')) }
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch (_) {} }
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.trash') continue
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else fs.copyFileSync(s, d)
  }
}
function countIn(dir, filter) {
  let n = 0
  const walk = (p) => {
    if (!fs.existsSync(p)) return
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name)
      if (e.isDirectory()) walk(f)
      else if (filter(e.name, f)) n++
    }
  }
  walk(dir)
  return n
}
function dirHash(dir) {
  const h = crypto.createHash('sha256')
  const walk = (p) => {
    if (!fs.existsSync(p)) return
    for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(p, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.name.endsWith('.md') || e.name.endsWith('.yaml') || e.name.endsWith('.json')) {
        h.update(path.relative(dir, f))
        h.update(fs.readFileSync(f))
      }
    }
  }
  walk(dir)
  return h.digest('hex')
}

// ── 段 0：隔离 ────────────────────────────────────────────────────
console.log('── 段0 隔离 ──')
const REAL = path.join(REPO, 'task-data')
const realHashBefore = dirHash(REAL)
copyTree(REAL, DATA)
check('临时工作区建好（真实数据只读复制）', fs.existsSync(DATA))
check('真实数据未被改动（开工前指纹）', dirHash(REAL) === realHashBefore)

/** 活跃区卡数（task-data 根目录的 .md，不含 archive/ 与子目录）—— 与 loadTasks() 同一口径 */
const activeCount = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')).length

const before = {
  cards: countIn(DATA, (n) => n.endsWith('.md') && !n.startsWith('_')),
  active: activeCount(DATA),
  decisions: (() => {
    const f = path.join(DATA, 'decisions.md')
    return fs.existsSync(f) ? (fs.readFileSync(f, 'utf8').match(/^## D-\d+/gm) || []).length : 0
  })(),
  logs: countIn(DATA, (n) => n.endsWith('.md')),
}
console.log('  基线：卡 ' + before.cards + ' / 决策 ' + before.decisions + ' / md 文件 ' + before.logs)

// ── 段 1：升级前快照（= 用户在 0.5.x 上的数据）────────────────────
console.log('\n── 段1 升级前快照 ──')
const t0 = Date.now()
copyTree(DATA, SNAP)
const snapMs = Date.now() - t0
const snapHash = dirHash(SNAP)
check('快照完成（这是回滚的还原点）', fs.existsSync(SNAP), snapMs + 'ms')
check('快照与当前数据逐字节一致', snapHash === dirHash(DATA))

// ── 段 2：升级（0.5.7 → 0.6.0）后继续使用 ─────────────────────────
console.log('\n── 段2 升级后使用（0.6.0 会写的新东西）──')
const t1 = Date.now()
const data = require(path.join(REPO, 'desktop/dist/main/data/index.js'))
data.setDataDir(WORK)

// 口径：只跟"升级写入前的同一次 loadTasks"比 —— 不跟文件数比（根目录的 .md 里有 decisions.md 等非卡文件）
const loadBefore = (data.loadTasks() || []).length

// 模拟 0.6.0 的新增写入：备用通道文件、计划草案目录、一张新卡
fs.writeFileSync(path.join(WORK, 'llm-channels.json'), JSON.stringify({ channels: [] }, null, 2))
fs.mkdirSync(path.join(WORK, 'task-data', 'plans', '_drafts'), { recursive: true })
fs.writeFileSync(path.join(WORK, 'task-data', 'plans', '_drafts', 'drill.md'), '# 演练草案\n')

const created = data.createTask ? data.createTask({ title: '演练：升级后新建的一张卡', project: 'fangcun-base' }) : null
const afterUpgrade = {
  cards: countIn(DATA, (n) => n.endsWith('.md') && !n.startsWith('_')),
}
const upgradeMs = Date.now() - t1
const loadAfter = (data.loadTasks() || []).length
// 只要求"旧卡一张不少"。新卡是否被同一次 loadTasks 看见取决于数据层有没有进程内缓存，
// 那不是升级路径的风险点（文件层面已由上一条断言覆盖）。
check('升级后旧卡一张不少（没有因为版本变化读不出来）', loadAfter >= loadBefore,
  loadBefore + ' → ' + loadAfter)
check('升级后新增写入生效（新卡 / 新文件）', afterUpgrade.cards > before.cards,
  before.cards + ' → ' + afterUpgrade.cards)
check('0.6.0 新文件落在数据根、不影响旧文件', fs.existsSync(path.join(WORK, 'llm-channels.json')))
console.log('  升级段耗时 ' + upgradeMs + 'ms（含一次建卡写盘）')

// ── 段 3：回滚（从快照还原）──────────────────────────────────────
console.log('\n── 段3 回滚到升级前 ──')
const t2 = Date.now()
rmrf(DATA)
copyTree(SNAP, DATA)
const rollbackMs = Date.now() - t2
const afterRollback = {
  cards: countIn(DATA, (n) => n.endsWith('.md') && !n.startsWith('_')),
  decisions: (() => {
    const f = path.join(DATA, 'decisions.md')
    return fs.existsSync(f) ? (fs.readFileSync(f, 'utf8').match(/^## D-\d+/gm) || []).length : 0
  })(),
  logs: countIn(DATA, (n) => n.endsWith('.md')),
}

check('★★ 回滚后卡数与升级前一致', afterRollback.cards === before.cards,
  before.cards + ' → ' + afterRollback.cards)
check('★★ 回滚后决策数与升级前一致', afterRollback.decisions === before.decisions,
  before.decisions + ' → ' + afterRollback.decisions)
check('★★ 回滚后 md 文件数与升级前一致', afterRollback.logs === before.logs,
  before.logs + ' → ' + afterRollback.logs)
check('★★ 回滚后整树指纹与快照完全一致（逐字节）', dirHash(DATA) === snapHash)
check('回滚后升级期新增的卡已消失（真回到过去，不是只覆盖）',
  !fs.readdirSync(DATA).some((f) => f.includes('演练-升级后新建')))
console.log('  回滚段耗时 ' + rollbackMs + 'ms')

// ── 段 4：回滚后还能正常用（不是死数据）─────────────────────────
console.log('\n── 段4 回滚后可用性 ──')
const tasks = data.loadTasks() || []
check('回滚后数据层能正常加载', tasks.length > 0, tasks.length + ' 张')
const one = tasks.find((t) => t.body && t.body.length > 50)
check('回滚后卡正文完整可读（抽一张）', !!one, one ? one.id : '(没有)')

// ── 段 5：真实数据零改动 ─────────────────────────────────────────
console.log('\n── 段5 真实数据零改动 ──')
check('★★ 全程没碰真实 task-data（指纹与开工前一致）', dirHash(REAL) === realHashBefore)

// ── 段 6：耗时与结论 ─────────────────────────────────────────────
console.log('\n── 段6 记录 ──')
console.log('  快照 ' + snapMs + 'ms | 升级+使用 ' + upgradeMs + 'ms | 回滚 ' + rollbackMs + 'ms')
console.log('  基线 → 升级后 → 回滚：卡 ' + before.cards + ' → ' + afterUpgrade.cards + ' → ' + afterRollback.cards)
console.log('  工作区：' + WORK)
rmrf(WORK)

console.log('\nRESULT ' + pass + ' / ' + fail)
process.exit(fail === 0 ? 0 : 1)
