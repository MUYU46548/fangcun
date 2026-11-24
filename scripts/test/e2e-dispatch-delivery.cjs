#!/usr/bin/env node
/**
 * 派单「到底有没有人接」（2026-11-24 · 暮雨第 8 条）
 *
 * 原话：「如果 DSH 未启动，方寸的 DSH 联动功能（各种派单类）是否会有智能的处理方式？
 * 还是卡着骗用户已成功？」
 *
 * 诚实回答（改之前）：**会骗**。方寸只把任务书写进 `<数据根>/.dispatch-dsh/`，
 * 真正开会话的是 DSH 里的插件（8 秒一拍去取）。DSH 没开 = 没人来取 = 文件一直躺着，
 * 而界面弹的是绿色的「已发送给 DSH……DSH 那边会冒出一个新会话」。
 *
 * 本守卫钉住的判据：
 *   ① 探测**没跑**（checked:false）不许算成"有人在接"；
 *   ② DSH 在跑但**插件没装** → 仍然是"没人接"（装了没进 bundles 也取不走）；
 *   ③ 只有「进程在 + 插件在」才允许说会有人取走；
 *   ④ `queued` 的文案里**禁止**出现「已发送 / 会冒出一个新会话」这类既成事实的说法；
 *   ⑤ 进程表解析只认**整名**，`includes('dsh')` 会把无关程序当成消费方（反例自证）；
 *   ⑥ 源码守卫：成功路径必须真的把探测结论传进去，界面不许自己另编一句话。
 *
 * 运行：node scripts/test/e2e-dispatch-delivery.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'dispatchDelivery.js')
const DSHP = path.join(REPO, 'desktop', 'dist', 'main', 'services', 'dshPlugin.js')
const CP = path.join(REPO, 'desktop', 'src', 'main', 'services', 'contextPack.ts')
const IPC = path.join(REPO, 'desktop', 'src', 'main', 'ipc.ts')
const APP = path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { describeDispatchDelivery, consumerPresent } = require(ART)

console.log('== 派单 · 到底有没有人接 ==')

const probe = (checked, running, pluginInstalled) => ({ checked, running, pluginInstalled, evidence: '' })

// ── ① 没核实到 ≠ 有人在接 ───────────────────────────────────────────────
console.log('\n-- 没核实到不许当成有人接 --')
check('★ checked:false → 不算在场（不知道不能当"在"）',
  consumerPresent(probe(false, true, true)) === false)
check('★ checked:false 的 delivery 是 queued，不是 will-consume',
  describeDispatchDelivery(probe(false, true, true), 100).delivery === 'queued')
check('完全没传探测结果 → queued（最保守）',
  describeDispatchDelivery(null, 100).delivery === 'queued')
check('undefined 也 queued', describeDispatchDelivery(undefined, 100).delivery === 'queued')

// ── ② 进程在但插件没装 = 没人接 ─────────────────────────────────────────
console.log('\n-- DSH 在跑但插件没装，仍然不算有人接 --')
check('★ running:true + pluginInstalled:false → queued',
  describeDispatchDelivery(probe(true, true, false), 100).delivery === 'queued')
check('  consumerPresent 也跟着是 false',
  describeDispatchDelivery(probe(true, true, false), 100).consumerPresent === false)
check('★ 只有两者都成立才 will-consume',
  describeDispatchDelivery(probe(true, true, true), 100).delivery === 'will-consume')
check('DSH 没跑 + 插件装着 → queued（插件装着但没人跑它）',
  describeDispatchDelivery(probe(true, false, true), 100).delivery === 'queued')

// ── ③ queued 的文案不许冒充成功 ────────────────────────────────────────
console.log('\n-- queued 的话不许说成已经发生 --')
const queuedTexts = [
  describeDispatchDelivery(probe(false, false, false), 12345).hint,
  describeDispatchDelivery(probe(true, false, true), 12345).hint,
  describeDispatchDelivery(probe(true, true, false), 12345).hint,
  describeDispatchDelivery(null, 12345).hint,
]
const LYING = ['已发送', '会冒出一个新会话', '已经在跑', '已开工', '正在执行']
for (const t of queuedTexts) {
  const bad = LYING.filter((w) => t.includes(w))
  check(`queued 文案不含既成事实说法（${t.slice(0, 30)}…）`, bad.length === 0, bad.join(' / '))
}
check('★ queued 文案必须说清"现在没人取"或"没核实到"',
  queuedTexts.every((t) => /不会|没核实|没检测到/.test(t)),
  queuedTexts.join(' || '))
check('queued 文案里带字节数（人要知道派了多大一份）',
  describeDispatchDelivery(probe(true, false, true), 12345).hint.includes('12345'))

// ── ④ will-consume 才可以说会有人取走 ──────────────────────────────────
console.log('\n-- 有人接的时候才说会有人接 --')
const willText = describeDispatchDelivery(probe(true, true, true), 999).hint
check('will-consume 文案提到 DSH 会取走', /取走|开一个新会话/.test(willText), willText)
check('will-consume 的 consumerPresent 是 true',
  describeDispatchDelivery(probe(true, true, true), 999).consumerPresent === true)
check('will-consume 文案也不许说"已发送"（文件刚落地，会话还没开）',
  !willText.includes('已发送'), willText)

// ── ⑤ 进程表解析：只认整名（反例自证）──────────────────────────────────
console.log('\n-- 进程表解析只认整名 --')
if (fs.existsSync(DSHP)) {
  const { parseDshProcesses } = require(DSHP)
  const csv = [
    '"chrome.exe","1234","Console","1","100,000 K"',
    '"DeepSeek Harness.exe","5678","Console","1","500,000 K"',
    '"notepad.exe","9999","Console","1","1,000 K"',
  ].join('\r\n')
  const hits = parseDshProcesses(csv)
  check('★ 认得出 DeepSeek Harness.exe', hits.some((h) => /DeepSeek Harness/i.test(h)), String(hits))
  // 反例：进程名里带 dsh 但与 DSH 无关的，**不许**被算成消费方
  const trap = [
    '"dsh-fangcun-helper.exe","1111","Console","1","1 K"',
    '"mydsh-tool.exe","2222","Console","1","1 K"',
    '"chrome.exe","3333","Console","1","1 K"',
  ].join('\r\n')
  check('★★ 反例：名字里只是"含 dsh"的程序不算消费方（否则会把没人接说成有人接）',
    parseDshProcesses(trap).length === 0, String(parseDshProcesses(trap)))
  check('空输出 → 零命中（不抛）', parseDshProcesses('').length === 0)
  check('坏行跳过（不抛）', Array.isArray(parseDshProcesses('garbage\n"",')))
  check('大小写不敏感（deepseek harness.exe）',
    parseDshProcesses('"deepseek harness.exe","1","Console","1","1 K"').length === 1)
} else {
  check('dshPlugin 编译产物存在', false, DSHP)
}

// ── ⑥ 源码守卫：探测结论真的被用上了 ───────────────────────────────────
console.log('\n-- 源码守卫 --')
const cpSrc = fs.readFileSync(CP, 'utf8')
check('★★ 派单成功路径调用了 describeDispatchDelivery（不是就地写死一句好话）',
  /describeDispatchDelivery\(consumer/.test(cpSrc))
check('★ 派单返回值里带 deliveryHint / consumerPresent',
  /deliveryHint:\s*verdict\.hint/.test(cpSrc) && /consumerPresent:\s*verdict\.consumerPresent/.test(cpSrc))
check('派单函数签名接受 consumer（探测结果从外面传进来，逻辑层不 import electron）',
  /consumer\?:\s*DispatchConsumerProbe \| null/.test(cpSrc))

const ipcSrc = fs.readFileSync(IPC, 'utf8')
check('★ IPC 派单通道是 async 且真的 await 了探测',
  /context:dispatchDsh',\s*async[\s\S]{0,300}await safeProbeConsumer\(\)/.test(ipcSrc))
check('★ 带任务书的派单通道同样 await 探测',
  /context:dispatchMessage',\s*async[\s\S]{0,300}await safeProbeConsumer\(\)/.test(ipcSrc))
check('★ 探测失败不许把派单搞失败（safeProbeConsumer 自己兜住，不 rethrow）',
  /async function safeProbeConsumer[\s\S]{0,600}catch[\s\S]{0,400}checked:\s*false/.test(ipcSrc))

const appSrc = fs.readFileSync(APP, 'utf8')
check('★★ 界面措辞来自主进程的 deliveryHint（不许自己再编一句"会冒出新会话"）',
  /String\(r\.deliveryHint \|\| ''\)/.test(appSrc))
check('★ 项目页派单不再无条件说"DSH 那边会冒出一个新会话"',
  !/已发送给 DSH：「\$\{p\.name \|\| p\.id\}」的\$\{what\}（\$\{r\.chars \|\| 0\} 字）—— DSH 那边会冒出一个新会话/.test(appSrc))
check('★ 日志页派单同样按 delivery 分流',
  /logQueued/.test(appSrc) && /r\.delivery !== 'will-consume'/.test(appSrc))

console.log(`\nRESULT ${pass} / ${pass + fail}`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
