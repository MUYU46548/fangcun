/**
 * 账户口径（余额差值）· 退场守卫（2026-11-20）。
 *
 * 余额观测依赖模型通道配置，已随 BYOK 退场删除。现在钉的是：
 * IPC / preload / 问答页 / useAsk 都不再有账户口径入口；用量与单价仍保留。
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')
let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

console.log('== 账户口径 · 余额差值退场 ==')
const ipc = read('desktop/src/main/llm-ipc.ts')
const preload = read('desktop/src/preload/index.ts')
const ask = read('desktop/src/renderer/views/AskView.vue')
const useAsk = read('desktop/src/renderer/composables/useAsk.ts')

check('llm-ipc 不再注册 llm:balanceStatus / llm:balanceObserve',
  !/llm:balanceStatus|llm:balanceObserve/.test(ipc))
check('preload 不再暴露 llmBalanceStatus / llmBalanceObserve',
  !/llmBalanceStatus|llmBalanceObserve/.test(preload))
check('问答页不再有账户口径块（.ask-acc / 余额差值）',
  !/ask-acc|余额差值|来自供应商余额接口/.test(ask))
check('useAsk 不再读取余额 / 观测余额',
  !/balanceStatus|balanceObserving|refreshBalance|llmBalance/.test(useAsk))
check('llm-ipc 仍保留用量 / 单价',
  /llm:usageStats/.test(ipc) && /llm:getPrices/.test(ipc))
check('问答页仍保留 token 月报 / 渠道对比',
  /usageMonths/.test(ask) || /chanReport/.test(ask))

console.log('')
console.log(`RESULT ${pass} / ${fail}`)
if (fail) { console.log('\n失败项：'); for (const x of failures) console.log('  · ' + x) }
process.exit(fail ? 1 : 0)
