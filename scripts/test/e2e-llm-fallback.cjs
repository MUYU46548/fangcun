/**
 * BYOK 多通道降级（0.6.0 第 2 批 · 2026-11-02）
 *
 * 判据四件事：
 *  ① 主通道失败 → 自动换下一条，并在 `note` 里说清"谁失败、为什么、最后用了谁"；
 *  ② **不是所有失败都换**：400 这类请求本身不合法 → 停（换通道也一样错，白烧一次额度）；
 *  ③ 没配齐的通道压根不进链（别拿半条通道去等一次超时）；
 *  ④ 每次失败都留痕（谁的通道 / 为什么 / 多久）。
 *
 * 全程**注入假调用**，不真发请求、不花钱。
 * 运行：node scripts/test/e2e-llm-fallback.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}
const ROOT = path.join(os.tmpdir(), 'fc-llm-fb-' + Date.now())
process.env.FC_TEST_USERDATA = path.join(ROOT, 'userdata')
fs.mkdirSync(process.env.FC_TEST_USERDATA, { recursive: true })

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')) }
}

const L = require(path.join(DIST, 'shared', 'llmChannel.js'))
const { buildChain, classifyFailure, describeChain, channelProblem, channelTag } = L
const { chatWithFallback } = require(path.join(DIST, 'main', 'llm', 'fallback.js'))

const MAIN = { id: 'main', label: '主通道', baseUrl: 'https://a.example/v1', apiKey: 'k1', model: 'm1', enabled: true }
const BACKUP = { id: 'bk1', label: '备用通道 1', baseUrl: 'https://b.example/v1', apiKey: 'k2', model: 'm2', enabled: true }

function err(code, message = 'boom') {
  const e = new Error(message)
  e.code = code
  return e
}

;(async () => {
  console.log('== ① 链解析：主在前、未配齐剔除、主通道写错要退化 ==')
  const c1 = buildChain([BACKUP, MAIN], 'main')
  check('★★ 主通道排第一（配置顺序里它在后面也一样）', c1.chain[0].id === 'main' && c1.chain[1].id === 'bk1',
    c1.chain.map((x) => x.id).join(','))
  const half = { id: 'x', label: '半条通道', baseUrl: 'https://x.example', apiKey: '', model: 'm' }
  const c2 = buildChain([MAIN, half], 'main')
  check('★★ 缺密钥的通道不进链（不拿半条通道去等超时）',
    c2.chain.length === 1 && c2.skipped.some((k) => k.id === 'x' && /密钥/.test(k.reason)),
    JSON.stringify(c2.skipped))
  const c3 = buildChain([BACKUP], 'main')
  check('★ 主通道不存在 → 按顺序用可用的，并说明这件事',
    c3.chain[0].id === 'bk1' && c3.skipped.some((k) => /主通道/.test(k.reason)), JSON.stringify(c3.skipped))
  check('★ 停用的通道与"没配完"分开说',
    /已停用/.test(channelProblem({ ...MAIN, enabled: false })) && /缺/.test(channelProblem(half)))
  check('★ 端点不像地址 → 拒绝', /不像地址/.test(channelProblem({ ...MAIN, baseUrl: 'a.example' })))
  check('★ 通道标签：主通道带“（主）”', channelTag(MAIN, 'main') === '主通道（主）' && channelTag(BACKUP, 'main') === '备用通道 1')

  console.log('\n== ② 失败分类：该换的换，不该换的停 ==')
  check('★★ 401 → 换下一条', classifyFailure(err(401)).verdict === 'retry-next')
  check('★★ 429 限流 → 换下一条', classifyFailure(err(429)).verdict === 'retry-next')
  check('★★ 5xx → 换下一条', classifyFailure(err(503)).verdict === 'retry-next')
  check('★★ 超时 → 换下一条', classifyFailure(new Error('request timeout')).verdict === 'retry-next')
  check('★ 网络不可达 → 换下一条', classifyFailure(new Error('connect ECONNREFUSED 127.0.0.1:1')).verdict === 'retry-next')
  check('★★ 400 请求本身不合法 → **停**（换通道也一样错）', classifyFailure(err(400)).verdict === 'stop')
  check('★ 422 同理停', classifyFailure(err(422)).verdict === 'stop')
  check('★ 停的时候要给出"改请求而不是靠降级掩盖"的提示',
    /不要靠降级掩盖/.test(classifyFailure(err(400)).hint), classifyFailure(err(400)).hint)
  check('★ 认不出的错误：换下一条但如实说没认出类型',
    (() => { const c = classifyFailure(new Error('something weird')); return c.verdict === 'retry-next' && /未识别/.test(c.reason) })())

  console.log('\n== ③ 降级话术 ==')
  check('★ 一次过 → 不吭声（空串）',
    describeChain([{ channelId: 'main', channelLabel: '主通道', ok: true }], 'main') === '')
  const said = describeChain([
    { channelId: 'main', channelLabel: '主通道', ok: false, reason: '限流（429）' },
    { channelId: 'bk1', channelLabel: '备用通道 1', ok: true },
  ], 'bk1')
  check('★★ 降级说明谁失败、为什么、切到谁', /已切到“备用通道 1”/.test(said) && /限流/.test(said), said)
  const allFail = describeChain([
    { channelId: 'main', channelLabel: '主通道', ok: false, reason: '限流（429）' },
    { channelId: 'bk1', channelLabel: '备用通道 1', ok: false, reason: '超时' },
  ])
  check('★★ 全挂时把每条都列出来', /所有通道都失败了/.test(allFail) && /主通道/.test(allFail) && /备用通道 1/.test(allFail), allFail)

  console.log('\n== ④ 真跑降级：注入假调用，不花钱 ==')
  // 主通过
  let calls = 0
  const ok1 = await chatWithFallback('hi', {
    channels: () => ({ channels: [MAIN, BACKUP], primaryId: 'main' }),
    calls: 0,
    callOne: async () => { calls++; return { text: '答', usage: { totalTokens: 7 }, model: 'm1' } },
    appendTrace: () => {},
  })
  check('★★ 主通道成功：ok + 只调一次 + 不吭声', ok1.ok && calls === 1 && ok1.note === '' && ok1.channelId === 'main',
    JSON.stringify({ ok: ok1.ok, calls, note: ok1.note }))
  // 主 429 → 备用成功
  let n = 0
  const traces = []
  const ok2 = await chatWithFallback('hi', {
    channels: () => ({ channels: [MAIN, BACKUP], primaryId: 'main' }),
    callOne: async (ch) => { n++; if (ch.id === 'main') throw err(429, 'rate limited'); return { text: '备用的答案', model: 'm2' } },
    appendTrace: (r) => traces.push(r),
  })
  check('★★ 主通道 429 → 自动切备用并成功', ok2.ok && n === 2 && ok2.channelId === 'bk1', JSON.stringify({ ok: ok2.ok, n, ch: ok2.channelId }))
  check('★★ 返回里说清降级了（界面 toast 直接用这句）', /已切到“备用通道 1”/.test(ok2.note) && /限流/.test(ok2.note), ok2.note)
  check('★★ 每次失败都留痕（带通道 id + 原因）',
    traces.length === 1 && traces[0].ok === false && traces[0].channel === 'main' && /限流/.test(traces[0].error),
    JSON.stringify(traces.map((t) => ({ ch: t.channel, e: String(t.error).slice(0, 20) }))))
  check('★ 两次尝试都记在 attempts 里（成功也记）', ok2.attempts.length === 2 && ok2.attempts[1].ok === true)

  // 主 400 → 停
  let m = 0
  const stop = await chatWithFallback('hi', {
    channels: () => ({ channels: [MAIN, BACKUP], primaryId: 'main' }),
    callOne: async () => { m++; throw err(400, 'bad request') },
    appendTrace: () => {},
  })
  check('★★ 400 直接停：不试备用（省一次额度）', stop.ok === false && m === 1, JSON.stringify({ ok: stop.ok, m }))
  check('★★ 停的时候给出改请求的提示，而不是"全部通道失败"',
    /请求本身不合法/.test(stop.error) && /不要靠降级掩盖/.test(stop.error), stop.error)

  // 全挂
  let k = 0
  const dead = await chatWithFallback('hi', {
    channels: () => ({ channels: [MAIN, BACKUP], primaryId: 'main' }),
    callOne: async () => { k++; throw err(503, 'server down') },
    appendTrace: () => {},
  })
  check('★★ 全挂：ok=false 且说清两条都失败', dead.ok === false && k === 2 && /所有通道都失败了/.test(dead.error), dead.error)

  // 没配齐
  const none = await chatWithFallback('hi', {
    channels: () => ({ channels: [half], primaryId: 'main' }),
    callOne: async () => { throw new Error('不该被调用') },
    appendTrace: () => {},
  })
  check('★★ 一条可用通道都没有 → ok=false + 逐条说缺什么（且一次都没调）',
    none.ok === false && /没有可用通道/.test(none.error) && /缺/.test(none.error), none.error)

  // maxChannels
  const limited = await chatWithFallback('hi', {
    channels: () => ({ channels: [MAIN, BACKUP], primaryId: 'main' }),
    maxChannels: 1,
    callOne: async () => { throw err(503) },
    appendTrace: () => {},
  })
  check('★ maxChannels=1 时只试第一条（可配置的上限）', limited.attempts.length === 1, String(limited.attempts.length))

  console.log('\n== ⑤ 接线守卫：设置页真的能加/删备用通道 ==')
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')
  const SET = read('desktop/src/renderer/components/settings/AgentSettings.vue')
  check('★★ 设置页有“备用通道（降级链）”块', /lb-block/.test(SET) && /备用通道（降级链）/.test(SET))
  check('★★ “加一条”真走 llmChannelsUpsert', /llmChannelsUpsert\(/.test(SET))
  check('★ “删”真走 llmChannelsRemove', /llmChannelsRemove\(/.test(SET))
  check('★ 密钥输入框写明“留空=不改”（与主通道同一条防线）', /留空=不改/.test(SET))
  check('★ 界面说清 400 不会切通道（不是"什么错都重试"）', /请求本身不合法（400）不会切/.test(SET), '')
  const PRE = read('desktop/src/preload/index.ts')
  check('★★ preload 暴露这三个口', /llmChannelsList/.test(PRE) && /llmChannelsUpsert/.test(PRE) && /llmChannelsRemove/.test(PRE))
  const IDX = read('desktop/src/index.ts')
  check('★★ 真实入口 index.ts 注册了 registerLlmChannelIpcHandlers',
    /registerLlmChannelIpcHandlers\(\)/.test(IDX) && /from '\.\/main\/channel-ipc'/.test(IDX))
  const IPC = read('desktop/src/main/channel-ipc.ts')
  check('★ 通道名带 llm- 前缀（与花销的 channels:get 不撞车）',
    /llm-channels:list/.test(IPC) && !/'channels:get'/.test(IPC))
  const CFG = read('desktop/src/main/llm/channels.ts')
  // 注：channels.ts 的**注释**里会提到 llm-config.json（说明为什么不碰它），所以只扫写操作
  check('★★ 备用通道存在独立文件（不写主通道那份 llm-config.json）',
    /llm-channels\.json/.test(CFG) && !/atomicWrite\([^)]*llm-config\.json/.test(CFG))
  check('★ 掩码/空密钥不覆盖已存密钥（与主通道同一防线）', /isMaskedKey/.test(CFG))

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) { console.log('\n失败项：'); for (const x of failures) console.log('  · ' + x) }
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2) })
