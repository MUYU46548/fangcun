/**
 * 契约：DSH 插件的「记忆 5 口」必须真的存在，提示词里点名的工具不许是空头支票。
 *
 * ## 为什么这道测试必须存在（2026-11-25 · P16.1）
 *
 * 病根不是"记忆功能没做"，是**教了没给**：`lib/prompt.js` 从 0.7.1 起让模型
 * 「动手前先 `memory_search`」，而插件工具面 7 个里 `memory_*` **0 个**。
 * 只测"提示词里写了记忆"是绿的，只测"工具表有 12 个"也是绿的 —— 两边各写一套就永远发现不了。
 * 所以这里**对表**：提示词里出现的 `fangcun_memory_*` 必须在工具表里；反过来说，
 * 提示词/工具描述里不许再出现裸的 `memory_*`（模型调不到的名字）。
 *
 * 插件仓不在本机时：**SKIP，退出 2** —— 不是通过（本仓规矩：SKIP ≠ 过）。
 *
 * 运行：node scripts/test/check-memory-tools.cjs
 */
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const REPO = path.resolve(__dirname, '..', '..')
const pluginDir = String(process.env.FANGCUN_PLUGIN_DIR || '').trim()
  || path.resolve(REPO, '..', 'dsh-fangcun')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}  → ${detail}`) }
}

console.log('== DSH 插件 · 记忆 5 口契约 ==')

const toolPath = path.join(pluginDir, 'lib', 'tool.js')
const promptPath = path.join(pluginDir, 'lib', 'prompt.js')
const statusPath = path.join(pluginDir, 'lib', 'status.js')
if (!fs.existsSync(toolPath) || !fs.existsSync(promptPath)) {
  console.log(`SKIP  找不到 DSH 插件仓（${pluginDir}）`)
  console.log('      设 FANGCUN_PLUGIN_DIR 指向 dsh-fangcun 仓再跑；SKIP 不算通过。')
  process.exit(2)
}

;(async () => {
  const toolMod = await import(pathToFileURL(toolPath).href)
  const promptMod = await import(pathToFileURL(promptPath).href)

  const tools = toolMod.buildTools({ async callTool() { return { content: [{ type: 'text', text: '{}' }] } } })
  const names = new Set(tools.map((t) => t.name))

  const MEMORY = {
    fangcun_memory_search: 'memory_search',
    fangcun_memory_read: 'memory_read',
    fangcun_memory_core: 'memory_core',
    fangcun_memory_briefing: 'memory_briefing',
    fangcun_memory_organize: 'memory_organize',
    fangcun_memory_write: 'memory_write',
  }
  for (const [tool, mcp] of Object.entries(MEMORY)) {
    check(`★★ 工具表里有 ${tool}`, names.has(tool), [...names].sort().join(','))
    check(`★ 路由 ${tool} → ${mcp}`, toolMod.TOOL_ROUTES[tool] === mcp, String(toolMod.TOOL_ROUTES[tool]))
    const def = tools.find((t) => t.name === tool)
    check(`★ ${tool} 有 output.schema / render / execute`,
      !!(def && def.output && def.output.schema && typeof def.output.render === 'function' && typeof def.execute === 'function'))
  }

  const rules = String(promptMod.RULES_TEXT || '')
  for (const name of ['fangcun_memory_search', 'fangcun_memory_read', 'fangcun_memory_write']) {
    check(`★★ 提示词点名 ${name}（模型才知道怎么用）`, rules.includes(name))
  }
  // 裸名字 = 模型调不到（MCP 那套名字插件里没有）
  const bare = /(?<!fangcun_)memory_(search|read|write|core|briefing)/
  check('★★ 提示词里没有裸的 memory_*（不许再"教了没给"）', !bare.test(rules),
    (rules.match(bare) || [])[0] || '')
  const status = fs.readFileSync(statusPath, 'utf-8')
  // ⚠ 不能整文件扫裸名：status.js 里有 `client.callTool('memory_core')` —— 那是**代码里的 MCP 工具名**，
  // 不是给模型看的提示。只钉"给人看的那句提示"用的是插件工具名。
  check('★★ status 提示用的是 fangcun_memory_search（不是裸名）',
    status.includes('fangcun_memory_search') && /条归档记忆，不自动注入；要细节用 fangcun_memory_search/.test(status),
    '')
  const desc = tools.map((t) => String(t.description || '')).join('\n')
  check('★★ 工具描述里也没有裸的 memory_*', !bare.test(desc), (desc.match(bare) || [])[0] || '')

  // 写口必须自己说清"待审批"，不能假装已生效
  const write = tools.find((t) => t.name === 'fangcun_memory_write')
  check('★★ 写口描述含「待审批」', /待审批/.test(String(write && write.description)), '')

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  · ' + f)
    process.exit(1)
  }
})().catch((e) => {
  console.error('ERROR', e && e.message)
  process.exit(1)
})
