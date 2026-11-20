/**
 * BYOK 多通道 · 退场守卫（2026-11-20）。
 *
 * 原文件测的是 fallback / channel-ipc 的降级链；这条功能已随 BYOK 退场。
 * 现在钉的是：配置入口真的断了，而 MCP/CLI 的“入口保留、提示版”没有断。
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

console.log('== BYOK · 多通道/降级链退场 ==')
check('channel-ipc.ts 已删除（不再注册 llm-channels:*）',
  !fs.existsSync(path.join(REPO, 'desktop/src/main/channel-ipc.ts')))
check('index.ts 不再 import/调用 registerLlmChannelIpcHandlers',
  !/registerLlmChannelIpcHandlers|channel-ipc/.test(read('desktop/src/index.ts')))
check('preload 不再暴露 llmChannels*',
  !/llmChannelsList|llmChannelsUpsert|llmChannelsRemove/.test(read('desktop/src/preload/index.ts')))
check('AgentSettings 不再有备用通道表单',
  !/备用通道（降级链）|llmChannels|llmChannelsUpsert|llmChannelsRemove/.test(
    read('desktop/src/renderer/components/settings/AgentSettings.vue')))
check('llm-ipc 不再注册 chat/planning/balance',
  !/llm:chat|llm:auditProject|llm:decomposeGoal|llm:balanceStatus|llm:balanceObserve/.test(
    read('desktop/src/main/llm-ipc.ts')))
check('planDraft 不再回落本地模型（无 chatWithFallback）',
  !/chatWithFallback/.test(read('desktop/src/main/llm/planDraft.ts')))
check('MCP plan_submit 仍保留（agent 交草案，不调模型）',
  /case 'plan_submit'/.test(read('desktop/src/main/mcp/tools.ts')))
check('MCP/CLI 的 plan_draft / ai-* 入口仍在（提示版）',
  /name: 'plan_draft'/.test(read('desktop/src/main/mcp/tools.ts'))
  && /def cmd_ai_plan/.test(read('tegula/cli.py'))
  && /def cmd_ai_brief/.test(read('tegula/cli.py'))
  && /def cmd_ai_doc/.test(read('tegula/cli.py')))

console.log('')
console.log(`RESULT ${pass} / ${fail}`)
if (fail) { console.log('\n失败项：'); for (const x of failures) console.log('  · ' + x) }
process.exit(fail ? 1 : 0)
