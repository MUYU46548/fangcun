/**
 * MCP · arch_generate（agent 直接要点架构图，2026-11-02）
 *
 * 判据不是"工具挂上了"，而是三件事：
 *  ① agent 能让方寸**用它自己的生成链路**出图（不是另写一套）；
 *  ② 坏入参立刻可读地失败，**绝不偷偷调模型**（花钱的路径必须由有效入参触发）；
 *  ③ JSON-RPC 链能承载"个别工具异步"（其他工具仍是同步返回，不整条链改成 Promise）。
 *
 * 本测试**不调用任何模型**：只走参数校验与错误分支。
 * 运行：node scripts/test/e2e-mcp-arch.cjs
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
const ROOT = path.join(os.tmpdir(), 'fc-mcp-arch-' + Date.now())
process.env.FC_TEST_USERDATA = path.join(ROOT, 'userdata')
fs.mkdirSync(path.join(ROOT, 'task-data'), { recursive: true })
// 一份**只有空项目**的 registry：archForProject 会因为仓库不存在而失败 → 走错误分支，不调模型
fs.writeFileSync(path.join(ROOT, 'registry.yaml'), [
  'projects:',
  '  - id: ghost',
  '    name: 幽灵项目',
  '    repo: ' + JSON.stringify(path.join(ROOT, 'nowhere')),
  '',
].join('\n'), 'utf-8')

const REPO = path.resolve(__dirname, '../..')
const DIST = path.join(REPO, 'desktop', 'dist')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')) }
}

const data = require(path.join(DIST, 'main', 'data', 'index.js'))
data.setDataDir(ROOT)
const { MCP_TOOLS, handleMCPToolCall } = require(path.join(DIST, 'main', 'mcp', 'tools.js'))
const { handleMCPRequest } = require(path.join(DIST, 'main', 'mcp', 'handler.js'))

;(async () => {
  console.log('== ① 工具挂上了，且描述交代了"会花钱" ==')
  const tool = MCP_TOOLS.find((t) => t.name === 'arch_generate')
  check('★ 工具清单里有 arch_generate', !!tool)
  check('★★ 描述里明说会调用用户配的模型并产生花销（不能瞒着 agent）',
    /BYOK|模型/.test(tool.description) && /花销|计费|花/.test(tool.description), tool.description.slice(0, 120))
  check('★ 必填参数是 project', (tool.inputSchema.required || []).includes('project'))

  console.log('\n== ② 坏入参：立刻可读地失败，绝不偷偷调模型 ==')
  const noArg = await handleMCPToolCall('arch_generate', {})
  check('★★ 没给 project → isError + 说清要什么',
    noArg.isError === true && /project/.test(noArg.content[0].text), noArg.content[0].text)
  const ghost = await handleMCPToolCall('arch_generate', { project: 'ghost' })
  check('★★ 仓库不存在 → isError（这条路径根本到不了模型调用）',
    ghost.isError === true && /不存在|扫不出/.test(ghost.content[0].text), ghost.content[0].text)

  console.log('\n== ③ JSON-RPC 链能承载"个别工具异步" ==')
  // 注：这里**不用** arch_generate 触发真实异步分支 —— 那要有效项目，会真调模型（花钱）。
  // 异步承载能力用源码守卫 + 同步工具不回归来钉，避免"为了测一条断言去烧一次额度"。
  const rpcSync = handleMCPRequest({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'arch_generate', arguments: { project: 'ghost' } },
  })
  check('★ 坏入参走同步错误分支（还没到调模型那一步）', !!rpcSync && typeof rpcSync.then !== 'function')
  const resp = await rpcSync
  check('★ await 之后拿到正常 JSON-RPC 回包（id 对得上）', !!resp && resp.id === 7 && !!resp.result, JSON.stringify(resp && resp.id))
  const handlerSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'mcp', 'handler.ts'), 'utf-8')
  check('★★ handler 里真有"返回 Promise 就转成 Promise<Response>"的分支',
    /typeof \(out as any\)\.then === 'function'/.test(handlerSrc) && /Promise\.resolve\(out\)\.then/.test(handlerSrc))
  // 同步工具仍然是同步返回 —— 不许为了一个工具把整条链都 Promise 化
  const syncResp = handleMCPRequest({ jsonrpc: '2.0', id: 8, method: 'tools/list' })
  check('★★ 同步工具仍是同步返回（没被拖成 Promise）',
    !!syncResp && typeof syncResp.then !== 'function' && Array.isArray(syncResp.result.tools),
    String(typeof syncResp && syncResp.then))

  console.log('\n== ④ 与界面同一个生成链路（不另写一套） ==')
  const toolsSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'mcp', 'tools.ts'), 'utf-8')
  const ipcSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'ipc.ts'), 'utf-8')
  check('★★ tools.ts 调的是 generateArchGraph（与界面同一个服务）',
    /generateArchGraph\(/.test(toolsSrc) && /from '\.\.\/services\/archAi'/.test(toolsSrc))
  check('★★ 界面那个 IPC 也调同一个服务（两条入口一份实现）',
    /generateArchGraph\(/.test(ipcSrc) && /from '\.\/services\/archAi'/.test(ipcSrc))
  check('★ 工具层没有自己拼图（不许把审计逻辑抄第二份）',
    !/auditArchDraft|draftToGraph/.test(toolsSrc))

  console.log('\n== ⑤ 管道回调是 async（否则 await 编译不过） ==')
  const sockSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'mcp', 'socket-server.ts'), 'utf-8')
  check('★ socket data 回调声明为 async 且真 await 了 handler',
    /socket\.on\('data',\s*async/.test(sockSrc) && /await handleMCPRequest\(/.test(sockSrc))

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) { console.log('\n失败项：'); for (const x of failures) console.log('  · ' + x) }
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2) })
