/**
 * BYOK 退场守卫（2026-11-20 暮雨：全走 DSH，界面不再配 Key/端点）。
 *
 * 原文件钉的是“小米两套端点/预设/Key 前缀”—— 这些入口已删。现在钉的是**删除真的落地**：
 * App.vue / AgentSettings / preload / llm-ipc 都不能再出现模型通道配置，
 * 同时用量/单价/DSH 派单入口必须还在。
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

console.log('== BYOK 退场 · 模型配置入口 ==')
const app = read('desktop/src/renderer/App.vue')
const agent = read('desktop/src/renderer/components/settings/AgentSettings.vue')
const preload = read('desktop/src/preload/index.ts')
const ipc = read('desktop/src/main/llm-ipc.ts')
const planDraft = read('desktop/src/main/llm/planDraft.ts')

check('App.vue 不再有 LLM_PRESETS / llmCfg / llmGetConfig / llmTestConnection',
  !/LLM_PRESETS|llmCfg|llmGetConfig|llmSetConfig|llmTestConnection|llmResetConfig/.test(app))
check('AgentSettings 不再有模型通道 / Base URL / API Key / 备用通道',
  !/<h4>模型通道|Base URL|API Key|llmChannels|llmCfg|applyLlmPreset/.test(agent))
check('AgentSettings 仍保留单价 / 用量 / 挂机 / MCP 写口',
  /模型单价/.test(agent) && /AI 用量/.test(agent) && /挂机提醒/.test(agent) && /MCP 写口/.test(agent))
check('preload 不再暴露模型配置 / 通道 / chat 口',
  !/llmGetConfig|llmSetConfig|llmTestConnection|llmChannelsList|llmChannelsUpsert|llmChannelsRemove|llmChat/.test(preload))
check('llm-ipc 不再注册 config/chat/planning 通道',
  !/llm:getConfig|llm:setConfig|llm:testConnection|llm:chat|llm:auditProject|llm:decomposeGoal|llm:decideDP/.test(ipc))
check('llm-ipc 仍保留用量 / 单价',
  /llm:usageStats/.test(ipc) && /llm:getPrices/.test(ipc) && /llm:setPrices/.test(ipc))
check('planDraft 不再 import chatWithFallback / getConfig',
  !/chatWithFallback|from '\.\/config'|getConfig/.test(planDraft))
check('DSH 派单入口仍在（App.vue）',
  /dispatchToDsh|dispatchMessageDsh/.test(app))
check('免责声明已抬到 v1.7（任务成果与模型强度条款）',
  /DISCLAIMER_VERSION = '1\.7'/.test(read('desktop/src/renderer/disclaimer.ts')))

console.log('')
console.log(`RESULT ${pass} / ${fail}`)
if (fail) { console.log('\n失败项：'); for (const x of failures) console.log('  · ' + x) }
process.exit(fail ? 1 : 0)
