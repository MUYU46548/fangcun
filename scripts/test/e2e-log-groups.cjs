#!/usr/bin/env node
/**
 * 日志「进行中 / 主日志 + 附属 / 状态撤销」端到端（2026-10-30 暮雨第 1 / 4 / 6 条）
 *
 * 真跑编译产物 `dist/main/services/logs.js` + 临时数据目录（真 .md 文件）。
 *
 * 钉住的事，每一条都对应一次真事故：
 *  ① **AI 申请收口不许动「进行中」**：requestLogClose 以前顺手写 `running=false`，
 *     用户手动标的「进行中」在 agent 说"做完了"那一刻无声消失 —— 第 1 / 6 条。
 *  ② 绑定是落盘的：主日志 `attached: [id]` 经 parse → render 往返不丢；
 *     一个副日志只能归一个主日志，主日志不能当附属。
 *  ③ 一键全进行中 / 全完成：只动该动的（完成/归档的跳过），按真成功数报账。
 *  ④ 撤销按快照还原：complete 后撤销要把「进行中 + 完成时间 + 保留天数」原样还回去，
 *     不是统一退回「待处理」。
 *  ⑤ 销毁副日志会清掉主日志里的断链。
 *  ⑥ 源码守卫：requestLogClose 里不许出现 `running = false`；「进行中」只有 setLogRunning 能写。
 *
 * 运行：node scripts/test/e2e-log-groups.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const ROOT = path.resolve(__dirname, '../..')
const DIST = path.join(ROOT, 'desktop', 'dist', 'main')
const TEST_ROOT = path.join(os.tmpdir(), 'fc-loggroup-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}
const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

function main() {
  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'), 'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf8')
  const data = require(path.join(DIST, 'data', 'index.js'))
  data.setDataDir(TEST_ROOT)
  const logs = require(path.join(DIST, 'services', 'logs.js'))

  const mk = (title) => {
    const r = logs.createLog(title, 'demo', '内容', undefined, {})
    if (!r.ok) throw new Error('建日志失败：' + r.error)
    return r.data
  }

  console.log('== ① AI 申请收口不许动「进行中」 ==')
  {
    const l = mk('用户已派出去的活')
    logs.setLogRunning(l.id, true)
    check('  手动标「进行中」生效', logs.getLog(l.id).running === true)
    const r = logs.requestLogClose(l.id)
    const after = logs.getLog(l.id)
    check('★ 申请收口返回 ok', r.ok === true, JSON.stringify(r))
    check('★★ AI 说做完了 ≠ 用户撤销派活：running 仍是 true（第 1/6 条的真事故）',
      after.running === true, String(after.running))
    check('  申请收口本身有标记（agentDone=true）', after.agentDone === true)
    check('  状态仍是 active（AI 不能替用户完成）', after.status === 'active', after.status)
    logs.cancelLogClose(l.id)
    check('  撤回收口后 running 依旧不变', logs.getLog(l.id).running === true)
  }

  // 2026-10-30 第二次追问（截图：同一张卡同时写「待处理」和「等你确认」）：
  // 没标「进行中」= 没派出去，AI 就不该能申请收口，否则卡面自相矛盾。
  {
    const l = mk('还没派出去的活')
    const r = logs.requestLogClose(l.id)
    const after = logs.getLog(l.id)
    check('★★ 没标「进行中」→ 申请收口被拒（不然「待处理 + 等你确认」自相矛盾）',
      r.ok === false && /还没标|没派出去/.test(r.error || ''), JSON.stringify(r))
    check('★★ 被拒后 agentDone 仍是 false（卡面不会出现「等你确认」）', after.agentDone !== true)
    check('  拒绝消息直接告诉人下一步该点哪', /标为进行中|完成/.test(r.error || ''), String(r.error))
  }

  console.log('\n== ② 主日志 + 附属日志：绑定落盘、校验、往返 ==')
  const main = mk('主日志：0.6.0 这一轮')
  const sideA = mk('副日志：并行通道 A')
  const sideB = mk('副日志：并行通道 B')
  const sideC = mk('副日志：别人家的')
  {
    const r = logs.setLogAttached(main.id, [sideA.id, sideB.id])
    check('★ 绑定返回 ok', r.ok === true, JSON.stringify(r))
    const back = logs.getLog(main.id)
    check('★ 主日志 attached 落盘为两条', Array.isArray(back.attached) && back.attached.length === 2,
      JSON.stringify(back.attached))
    check('  parse → render 往返不丢（文件里真有 attached 行）', (() => {
      const p = path.join(TEST_ROOT, 'docs', '执行日志', main.id + '.md')
      return fs.readFileSync(p, 'utf8').indexOf('attached:') >= 0
    })())
    check('  组内 id 顺序 = [主, 副A, 副B]', JSON.stringify(logs.logGroupIds(main.id)) === JSON.stringify([main.id, sideA.id, sideB.id]),
      JSON.stringify(logs.logGroupIds(main.id)))

    // 反例：一个副日志只能归一个主
    const main2 = mk('另一个主日志')
    logs.setLogAttached(main2.id, [sideC.id])
    const dup = logs.setLogAttached(main.id, [sideC.id])
    check('★ 副日志已被别的组占了 → 整批拒绝', dup.ok === false && /已经属于/.test(dup.error || ''), JSON.stringify(dup))
    check('  拒绝后主日志的 attached 没被改坏', logs.getLog(main.id).attached.length === 2,
      JSON.stringify(logs.getLog(main.id).attached))
    const nest = logs.setLogAttached(main.id, [main2.id])
    check('★ 主日志不能当别人的附属（不支持嵌套）', nest.ok === false && /自己也是主日志/.test(nest.error || ''), JSON.stringify(nest))
    const selfMain = mk('自指测试主日志')
    const self = logs.setLogAttached(selfMain.id, [selfMain.id])
    check('  自己绑自己会被静默忽略（不产生自指）', self.ok === true && !logs.getLog(selfMain.id).attached.includes(selfMain.id),
      JSON.stringify(logs.getLog(selfMain.id).attached))
    const childBoss = logs.setLogAttached(sideA.id, [sideC.id])
    check('★ 已经是别人附属的日志不能再当主日志（不做嵌套）', childBoss.ok === false && /附属/.test(childBoss.error || ''),
      JSON.stringify(childBoss))
    // 上面的 set 是"整批替换" —— 自指测试会清空原绑定，这里把主日志的绑定恢复回来
    logs.setLogAttached(main.id, [sideA.id, sideB.id])
    check('  恢复绑定后仍是两条', logs.getLog(main.id).attached.length === 2, JSON.stringify(logs.getLog(main.id).attached))
  }

  console.log('\n== ③ 一键全进行中 / 全完成（只动该动的） ==')
  {
    logs.completeLog(sideB.id, 7, '')
    const run = logs.setLogGroupRunning(main.id, true)
    check('★ 全组进行中返回 ok 且改了 2 条（已完成的副B跳过）',
      run.ok && run.changed.length === 2 && run.skipped.includes(sideB.id),
      JSON.stringify(run))
    check('  主日志 running=true', logs.getLog(main.id).running === true)
    check('  副A running=true', logs.getLog(sideA.id).running === true)
    check('  已完成的副B没被悄悄拉回', logs.getLog(sideB.id).status === 'completed')

    const done = logs.completeLogGroup(main.id, 7, '整组收工')
    check('★ 全组完成改了 2 条（已完成的那条跳过）', done.ok && done.changed.length === 2,
      JSON.stringify(done))
    check('  主日志 completed + running 清掉', logs.getLog(main.id).status === 'completed' && !logs.getLog(main.id).running)
    check('  副A completed', logs.getLog(sideA.id).status === 'completed')
  }

  console.log('\n== ④ 撤销按快照还原（不是统一退回待处理） ==')
  {
    const l = mk('要撤销的日志')
    logs.setLogRunning(l.id, true)
    const snap = logs.logStateSnapshot(l.id)
    check('  快照带上 running / 状态 / 完成时间字段', !!snap && snap.running === true && snap.status === 'active')
    logs.completeLog(l.id, 3, '完成一下')
    logs.restoreLogState(l.id, snap)
    const back = logs.getLog(l.id)
    check('★★ 按快照还原后 running 回来了（这是「撤销」不是「退回待处理」）', back.running === true, String(back.running))
    check('  状态回到 active', back.status === 'active', back.status)
    check('  完成时间/保留天数一并清回快照值', back.completed === null && back.retainDays === null,
      JSON.stringify({ completed: back.completed, retainDays: back.retainDays }))
    const bad = logs.restoreLogState(l.id, { status: '乱写的' })
    check('  非法快照被拒（不写盘）', bad.ok === false && /不合法/.test(bad.error || ''), JSON.stringify(bad))
  }

  console.log('\n== ⑤ 单独完成一条附属：关系不丢，全组动作跳过它 ==')
  {
    const m = mk('单独完成测试主日志')
    const s = mk('会被单独完成的副日志')
    logs.setLogAttached(m.id, [s.id])
    const done = logs.completeLog(s.id, 3, '这条先完成')
    check('★ 单独完成副日志成功', done.ok === true, JSON.stringify(done))
    check('★★ 单独完成后主日志 attached 里仍然有它（关系不因状态变化而丢）',
      (logs.getLog(m.id).attached || []).includes(s.id),
      JSON.stringify(logs.getLog(m.id).attached))
    const run = logs.setLogGroupRunning(m.id, true)
    check('★ 全组进行中只动主日志（已完成的副日志跳过）',
      run.ok && run.changed.length === 1 && run.changed[0] === m.id && run.skipped.includes(s.id),
      JSON.stringify(run))
    const off = logs.setLogGroupRunning(m.id, false)
    check('  全组撤销只动仍挂「进行中」的主日志',
      off.ok && off.changed.length === 1 && off.changed[0] === m.id,
      JSON.stringify(off))
  }

  console.log('\n== ⑥ 销毁副日志会清掉主日志里的断链 ==')
  {
    const m = mk('断链测试主日志')
    const s = mk('会被销毁的副日志')
    logs.setLogAttached(m.id, [s.id])
    logs.destroyLog(s.id)
    check('★ 副日志销毁后主日志 attached 里没有它了',
      !(logs.getLog(m.id).attached || []).includes(s.id),
      JSON.stringify(logs.getLog(m.id).attached))
  }

  console.log('\n== ⑦ 源码守卫（谁在写 running） ==')
  {
    const src = strip(fs.readFileSync(path.join(ROOT, 'desktop/src/main/services/logs.ts'), 'utf8'))
    const fn = (name) => {
      const i = src.indexOf('export function ' + name)
      if (i < 0) return ''
      const j = src.indexOf('\nexport function ', i + 10)
      return src.slice(i, j < 0 ? src.length : j)
    }
    check('★★ requestLogClose 里没有 `running = false`（第 1/6 条的病根）',
      !/\.running\s*=\s*false/.test(fn('requestLogClose')), fn('requestLogClose').slice(0, 200))
    check('★ 「进行中」只有一个自动写入点：setLogRunning / restoreLogState 之外不许成片写',
      (src.match(/\.running\s*=\s*(true|false|on)/g) || []).length <= 8,
      String((src.match(/\.running\s*=\s*(true|false|on)/g) || []).length))
    check('★ AI 收口只有 agent_done，不碰 running（源码顺序断言：requestLogClose 里没有 running 赋值）',
      !/\.running\s*=/.test(fn('requestLogClose')))
  }

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    failures.forEach((f) => console.log('  - ' + f))
    process.exit(1)
  }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
}

main()
