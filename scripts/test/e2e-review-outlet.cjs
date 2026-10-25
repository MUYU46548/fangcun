/**
 * 待审批卡出口端到端测试（2026-10-25 暮雨第 1 条，第二次提）
 *
 * 病根：AI 产出一律落「待审批」（契约红线），但预览面板只给「待验收」开了裁决入口
 *   → 待审批卡在界面上只有 forceCloseTask 那两条「直接完成 / 直接驳回」，
 *     既不转正、也不写结论。用户原话：「要么完成要么驳回，没有其他去处，理由都填不了。」
 *
 * 本测试钉住修复后的语义（直接 require 编译产物里的 reviewTask，真跑数据层）：
 *   ① 待审批 + accept → 状态变「待办」（转正），结果记录留一行「审批通过」
 *   ② 待审批 + reject 无理由 → 显式报错且**卡一个字节都没动**（反例）
 *   ③ 待审批 + reject 有理由 → 状态变「驳回」，理由进结果记录
 *   ④ 待验收 两条老语义不回归（accept → 完成 / reject → 驳回）
 *   ⑤ 待办/草稿 两种裁决都拒（不能拿裁决绕过流程）—— 反例自证
 *   ⑥ 源码守卫：预览面板的裁决按钮必须同时认「待审批」与「待验收」
 *      （只认待验收 = 这次的病根；只认待审批 = 把验收流程弄丢）
 *
 * 运行：node scripts/test/e2e-review-outlet.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── 1. electron 桩注入（必须在业务模块之前） ────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-review-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const REPO = path.resolve(__dirname, '../..')

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

function main() {
  console.log('== 待审批出口测试 ==')
  console.log('root:', TEST_ROOT)

  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  fs.writeFileSync(
    path.join(TEST_ROOT, 'registry.yaml'),
    'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n',
    'utf-8'
  )

  const data = require(path.join(DIST, 'data', 'index.js'))
  const tasks = require(path.join(DIST, 'data', 'tasks.js'))
  data.setDataDir(TEST_ROOT)

  // reviewTask 是 ipc 模块导出的裁决入口（本轮补的 export）。
  // 它内部只用 tasks 数据层，不需要真的注册 IPC 通道。
  const ipc = require(path.join(DIST, 'ipc.js'))
  check('reviewTask 已导出（测试可直达裁决入口）', typeof ipc.reviewTask === 'function')

  const mk = (title, status) => tasks.createTask({ title, status, project: 'demo' })
  const rd = (id) => tasks.readTask(id)

  // ── ① 待审批 + accept → 待办（转正）+ 结果记录留痕 ────────────────────
  {
    const t = mk('AI 落的草稿卡', '待审批')
    const r = ipc.reviewTask(t.id, 'accept', '结论清楚、验收线可查，可以转正')
    const after = rd(t.id)
    check('① 待审批 accept 返回 ok', r.ok === true, JSON.stringify(r))
    check('① 待审批 accept → 状态变「待办」', after.fm.status === '待办', String(after.fm.status))
    const log = String(after.fm.result_log || '')
    check('① 结果记录写了「审批通过（转正「待办」）」', log.includes('审批通过'), log.slice(0, 120))
    check('① 结果记录带上用户填的意见', log.includes('结论清楚、验收线可查'), log.slice(0, 120))
    check('① 结果记录带时间前缀', /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/.test(log), log.slice(0, 60))
  }

  // ── ② 待审批 + reject 无理由 → 报错且卡零改动（反例） ────────────────
  {
    const t = mk('没理由驳回试试', '待审批')
    const before = fs.readFileSync(t.path, 'utf-8')
    const r = ipc.reviewTask(t.id, 'reject', '   ')
    const after = rd(t.id)
    check('② 待审批无理由驳回 → ok=false', r.ok === false, JSON.stringify(r))
    check('② 错误信息说清「审批驳回理由必填」', /审批驳回理由必填/.test(String(r.error)), String(r.error))
    check('② 状态没变（仍待审批）', after.fm.status === '待审批', String(after.fm.status))
    check('② 文件字节没变（宁可不动也不写半条账）',
      fs.readFileSync(t.path, 'utf-8') === before)
  }

  // ── ③ 待审批 + reject 有理由 → 驳回 + 理由留痕 ───────────────────────
  {
    const t = mk('要驳回的 AI 卡', '待审批')
    const r = ipc.reviewTask(t.id, 'reject', '验收线写的是「能跑」，这不是判据，重写')
    const after = rd(t.id)
    check('③ 待审批 reject 返回 ok', r.ok === true, JSON.stringify(r))
    check('③ 状态变「驳回」', after.fm.status === '驳回', String(after.fm.status))
    const log = String(after.fm.result_log || '')
    check('③ 结果记录写了「审批驳回」', log.includes('审批驳回'), log.slice(0, 120))
    check('③ 驳回理由原文进结果记录', log.includes('这不是判据'), log.slice(0, 160))
  }

  // ── ④ 待验收两条老语义不回归 ─────────────────────────────────────────
  {
    const t1 = mk('待验收通过', '待验收')
    const r1 = ipc.reviewTask(t1.id, 'accept', '按验收线逐条核过')
    const a1 = rd(t1.id)
    check('④ 待验收 accept → 完成', r1.ok && a1.fm.status === '完成', String(a1.fm.status))
    check('④ 待验收通过仍写「验收通过」措辞（不串成审批）',
      String(a1.fm.result_log || '').includes('验收通过'), String(a1.fm.result_log).slice(0, 80))

    const t2 = mk('待验收驳回', '待验收')
    const r2 = ipc.reviewTask(t2.id, 'reject', '截图里第二条没做到')
    const a2 = rd(t2.id)
    check('④ 待验收 reject → 驳回', r2.ok && a2.fm.status === '驳回', String(a2.fm.status))
    check('④ 待验收驳回仍写「验收驳回」措辞',
      String(a2.fm.result_log || '').includes('验收驳回'), String(a2.fm.result_log).slice(0, 80))
  }

  // ── ⑤ 待办 / 草稿 不许走裁决（反例自证：别把通道开成万能改状态） ─────
  for (const st of ['待办', '草稿', '进行中']) {
    const t = mk('不该能裁决的 ' + st, st)
    const ra = ipc.reviewTask(t.id, 'accept', 'x')
    const rr = ipc.reviewTask(t.id, 'reject', 'y')
    check(`⑤ 「${st}」accept 被拒`, ra.ok === false, JSON.stringify(ra))
    check(`⑤ 「${st}」reject 被拒`, rr.ok === false, JSON.stringify(rr))
    check(`⑤ 「${st}」状态未变`, rd(t.id).fm.status === st, String(rd(t.id).fm.status))
    check(`⑤ 「${st}」错误信息列出可裁决的两种状态`,
      /待审批/.test(String(ra.error)) && /待验收/.test(String(ra.error)), String(ra.error))
  }

  // ── ⑥ 源码守卫：入口条件必须同时认两种状态 ───────────────────────────
  {
    // 本机 core.autocrlf=true（工作区 CRLF）→ 先归一化，否则字符窗口断言会假红
    const vue = fs.readFileSync(path.join(REPO, 'desktop/src/renderer/App.vue'), 'utf-8')
      .replace(/\r\n/g, '\n')
    const need = `v-if="previewTask.status === '待验收' || previewTask.status === '待审批'"`
    check('⑥ 预览面板裁决入口同时认「待验收」与「待审批」', vue.includes(need))
    check('⑥ 裁决弹窗按 kind 区分审批 / 验收措辞',
      vue.includes("reviewModal.kind === 'approval'"), '少了 kind 分支 = 审批弹窗还是写着"验收"')
    check('⑥ openReview 真的按状态判 kind',
      /kind:\s*t\.status === '待审批' \? 'approval' : 'acceptance'/.test(vue))
    // 反例：不许再出现"只认待验收"的旧写法单独存在
    const legacyOnly = /v-if="previewTask\.status === '待验收'"\s*\n\s*class="pri"/.test(vue)
    check('⑥ 旧的「只认待验收」写法已不存在', !legacyOnly, '旧写法还在 = 待审批又被锁回去了')
  }

  console.log(`\n== 结果：${pass}/${fail} ==`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
}

main()
