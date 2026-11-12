/**
 * 反例自证：把「不做其他项目的计划」装回模板，e2e-plan-drafts 必须精确变红。
 *
 * 规则同 e2e-undo-shortcut-negative：锚点找不到就退出 2，绝不当作通过；finally 里必还原。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'desktop', 'src', 'main', 'llm', 'planDraft.ts')
const TEST = path.join(__dirname, 'e2e-plan-drafts.cjs')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function run() {
  try {
    return { code: 0, out: execFileSync(process.execPath, [TEST], { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8' }) }
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

function main() {
  console.log('== 反例自证：旧模板句必须变红 ==')
  const original = fs.readFileSync(SRC, 'utf-8')

  const NEW_LINE = "  lines.push('- 不做多人协作 / 审批流；草案不自动冻结（裁决权在人）。')"
  if (original.indexOf(NEW_LINE) < 0) {
    console.error('FATAL 找不到锚点（模板已被改动？）—— 不许当通过')
    process.exit(2)
  }
  const OLD_LINE = "  lines.push('- 不做其他项目的计划；不做多人协作 / 审批流；草案不自动冻结。')"
  const patched = original.replace(NEW_LINE, OLD_LINE)
  if (patched === original) { console.error('FATAL 替换没生效'); process.exit(2) }

  try {
    fs.writeFileSync(SRC, patched, 'utf-8')
    check('★ 补丁真的写进去了', fs.readFileSync(SRC, 'utf-8').indexOf(OLD_LINE) >= 0)
    // 必须重新编译，否则测的还是旧 dist
    execFileSync(process.execPath, [
      path.join(ROOT, 'desktop', 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p', path.join(ROOT, 'desktop', 'tsconfig.main.json'),
    ], { cwd: path.join(ROOT, 'desktop'), stdio: 'pipe' })

    const r = run()
    check('★★ 旧模板句下被测脚本必须变红', r.code !== 0, 'code=' + r.code)
    check('★★ 红的是「草案模板不许再写不做其他项目的计划」那条',
      /FAIL.*草案模板不许再写/.test(r.out),
      r.out.split('\n').filter(l => l.startsWith('FAIL')).slice(0, 3).join(' | '))
    check('★★ 反例自证那条（真渲染）也必须跟着红 —— 证明它咬的是产出不是源码',
      /FAIL.*反例自证：真渲染一份草案/.test(r.out))
  } finally {
    fs.writeFileSync(SRC, original, 'utf-8')
    execFileSync(process.execPath, [
      path.join(ROOT, 'desktop', 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p', path.join(ROOT, 'desktop', 'tsconfig.main.json'),
    ], { cwd: path.join(ROOT, 'desktop'), stdio: 'pipe' })
  }

  check('★★ 文件已逐字节还原', fs.readFileSync(SRC, 'utf-8') === original)
  const r2 = run()
  check('★★ 还原并重编译后重新全绿（50/0）', r2.code === 0 && /RESULT 50 \/ 0/.test(r2.out),
    'code=' + r2.code + ' ' + (r2.out.match(/RESULT [^\n]*/) || [''])[0])

  console.log(`\nRESULT ${pass} pass / ${fail} fail`)
  if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log(' -', f)); process.exit(1) }
}

try { main() } catch (e) { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2) }
