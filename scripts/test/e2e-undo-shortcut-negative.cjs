/**
 * 反例自证（2026-11-12）：把 Ctrl+Z 的旧规则装回去，`e2e-undo-shortcut` 必须精确变红。
 *
 * 为什么单独一个脚本、而不是手动改一下再改回来：
 * 2026-11-12 当天已经踩过一次 —— 用 `node -e` + 正则替换去掉修复，**转义没匹配上**，
 * 断言照样绿，差点当成"自证通过"。暮雨那句“根本没检”说的就是这种事。
 *
 * 所以这里的规矩：
 *   ① 打完补丁**必须**断言"补丁真的进去了"（找不到 marker 就退出 2，绝不继续）；
 *   ② 必须在 `finally` 里还原（哪怕中途崩了也不留脏工作区）；
 *   ③ 红必须是**指定的那几条**变红，不是"随便红了几条就算"。
 *
 * 运行：node scripts/test/e2e-undo-shortcut-negative.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'desktop', 'src', 'shared', 'undoKey.ts')
const TEST = path.join(__dirname, 'e2e-undo-shortcut.cjs')

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}
const failures = []

/** 跑被测脚本，返回 {code, out}（不抛，断言要看它的输出） */
function run() {
  try {
    const out = execFileSync(process.execPath, [TEST], { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

function main() {
  console.log('== 反例自证：旧规则必须变红 ==')
  const original = fs.readFileSync(SRC, 'utf-8')

  // 补丁：把新规则换回 2026-10-21 的旧规则（"只要撤销条在就接管，不管焦点在哪"）
  const NEW_RULE = `  if (!hasUndo) return 'native'   // 没有可撤的数据动作 → 一律让给原生
  if (editable) return 'native'   // 在打字 → 撤字，别动数据
  return 'data'`
  if (original.indexOf(NEW_RULE) < 0) {
    console.error('FATAL 找不到要替换的规则原文 —— 本脚本的补丁锚点已失效（不许当通过）')
    process.exit(2)
  }
  const OLD_RULE = `  return hasUndo ? 'data' : 'native'`
  const patched = original.replace(NEW_RULE, OLD_RULE)
  if (patched === original) {
    console.error('FATAL 替换没生效（转义没匹配上？）—— 不许当通过')
    process.exit(2)
  }

  try {
    fs.writeFileSync(SRC, patched, 'utf-8')
    // ① 补丁必须真的在盘上
    const onDisk = fs.readFileSync(SRC, 'utf-8')
    check('★ 补丁真的写进去了（旧规则原文出现在盘上）', onDisk.indexOf(OLD_RULE) >= 0)
    check('★ 补丁真的顶掉了新规则（新规则原文已消失）', onDisk.indexOf(NEW_RULE) < 0)

    const r = run()
    check('★★ 旧规则下被测脚本**必须变红**（退出码非 0）', r.code !== 0, 'code=' + r.code)
    check('★★ 红的是「在 textarea 里仍夺走 Ctrl+Z」那条（不是别的断言顺带崩）',
      /FAIL.*在 textarea 里 \+ 有待撤数据动作 → 仍归原生/.test(r.out),
      r.out.split('\n').filter(l => l.startsWith('FAIL')).slice(0, 4).join(' | '))
    check('★★ 红的是「旧规则在 textarea 里也会夺走 Ctrl+Z」那条自证',
      /FAIL.*旧规则在 textarea 里也会夺走 Ctrl\+Z/.test(r.out),
      r.out.split('\n').filter(l => l.startsWith('FAIL')).slice(0, 4).join(' | '))
    check('★ 而「在按钮上 → 归数据动作」那条**不许**跟着红（那条新旧规则本来就一致）',
      !/FAIL.*在按钮上 \+ 有待撤数据动作 → 归数据动作/.test(r.out))
  } finally {
    fs.writeFileSync(SRC, original, 'utf-8')
  }

  // ② 还原后必须重新全绿（否则"修好了"是假的）
  const back = fs.readFileSync(SRC, 'utf-8')
  check('★★ 文件已逐字节还原', back === original)
  const r2 = run()
  check('★★ 还原后重新全绿（19/0）', r2.code === 0 && /RESULT 19 pass \/ 0 fail/.test(r2.out),
    'code=' + r2.code + ' ' + (r2.out.match(/RESULT [^\n]*/) || [''])[0])

  console.log(`\nRESULT ${pass} pass / ${fail} fail`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log(' -', f)
    process.exit(1)
  }
}

try { main() } catch (e) {
  console.error('FATAL', e && (e.stack || e.message || e))
  process.exit(2)
}
