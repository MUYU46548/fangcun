#!/usr/bin/env node
/**
 * plan_draft 诊断探针（2026-11-10）
 *
 * 由来：`plan_draft` 经 MCP 调两次都「Request timed out」，包里也没落草案。
 * 应用侧 LLM 超时来自 `llm-config.json` 的 `timeout`（当前 60s），而一次规划草稿要 60s+。
 * 这个脚本用**同一份输入构建器 + 同一份 prompt + 同一个模型**跑一遍，只把"发请求的那一层"
 * 换成不受 60s 限制的 fetch —— 用来判断：到底是超时、还是模型/解析的问题。
 *
 * 跑法：`node scripts/probe-plan-draft.cjs`
 * 产物：本质仍是一次真实起草，草案落 `task-data/plans/_drafts/<项目>-<日期>.md`（状态待裁决）；
 *       同时打印耗时、token、被丢弃条数 —— 这些是判断"能不能在超时内跑完"的依据。
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..')
const DIST = path.join(REPO, 'desktop', 'dist')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(REPO)

const { buildPlanDraftInputFromDisk } = require(path.join(DIST, 'main', 'llm', 'planDraftInput.js'))
const { generatePlanDraft } = require(path.join(DIST, 'main', 'llm', 'planDraft.js'))

const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'fangcun-desktop', 'llm-config.json'), 'utf8'))

async function callLlm(prompt, system) {
  const t0 = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 280000)
  try {
    const res = await fetch(String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        // 2026-11-10：deepseek-flash 是推理模型 —— 4096 的预算会被思考过程吃光，
        // 正文返回空串（finish_reason=length）。应用侧 chatDetailed 会自动翻到 8192，
        // 探针这里直接给 8192，否则量到的不是产品路径。
        max_tokens: 32768,
        temperature: 0.3,
        // 思考**不关**：这代模型的智力在 reasoning 里，关掉换来的是能跑但质量很差的输出。
        // 正文空串的根因是预算不够（思考 > 8192），所以直接给 32768。
      }),
      signal: ctl.signal,
    })
    const txt = await res.text()
    console.log(`[llm] HTTP ${res.status}  ${Date.now() - t0}ms  replyChars=${txt.length}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`)
    const j = JSON.parse(txt)
    const msg = j.choices && j.choices[0] && j.choices[0].message
    const finish = j.choices && j.choices[0] && j.choices[0].finish_reason
    const content = String((msg && msg.content) || '')
    console.log(`[llm] finish=${finish} content=${content.length}chars reasoning=${String((msg && msg.reasoning_content) || '').length}chars`)
    return {
      text: String((msg && msg.content) || ''),
      usage: j.usage ? {
        promptTokens: j.usage.prompt_tokens,
        completionTokens: j.usage.completion_tokens,
        totalTokens: j.usage.total_tokens,
      } : undefined,
      model: String(j.model || cfg.model),
    }
  } finally { clearTimeout(timer) }
}

;(async () => {
  const input = buildPlanDraftInputFromDisk({ project: 'fangcun-base', maxOpen: 24, maxDone: 8 })
  const t0 = Date.now()
  const r = await generatePlanDraft(input, { callLlm })
  console.log(JSON.stringify({
    ok: r.ok,
    elapsed_ms: Date.now() - t0,
    error: r.error,
    stages: (r.stages || []).length,
    dropped: (r.dropped || []).length,
    missing: r.missingCitations,
    file: r.file,
    model: r.model,
    usage: r.usage,
  }, null, 2))
  if (r.markdown) {
    console.log('\n--- MARKDOWN ---\n' + r.markdown)
  }
})().catch((e) => { console.error('PROBE FAIL:', e && e.stack || e); process.exit(1) })
