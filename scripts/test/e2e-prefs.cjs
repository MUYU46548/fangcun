/**
 * 回归：UI 偏好持久化（014，2026-09-25「执行 Agent 预设丢失」）
 *
 * 症状：攒的执行 Agent 预设莫名清空。
 * 真因：预设只存 localStorage，而 localStorage 绑定**起源** ——
 *   dev 的 vite host 从 `localhost` 改成 `127.0.0.1` 就等于换了 origin（打包版是 file://，又是另一套）。
 * 修法：真身移到主进程 userData/prefs.json，localStorage 降级为缓存 + 一次性迁移。
 *
 * 断言：
 *  A 存储层 —— 合并写入 / 原子替换 / 坏文件回退 / 键隔离
 *  B 生存性 —— 模拟「localStorage 被清空（换 origin）」后，真身仍读得到预设（这是本 bug 的要害）
 *  C 接线 —— IPC 通道、preload API、渲染层迁移与读缓存逻辑齐备（源码断言，防漂移）
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── 1. electron 桩注入（必须在业务模块之前） ────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-prefs-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const SRC = path.resolve(__dirname, '../../desktop/src')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; return }
  fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
}

function main() {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  const prefs = require(path.join(DIST, 'services', 'prefs.js'))

  // ══ A. 存储层 ════════════════════════════════════════════════════════
  check('A1 初始为空对象', Object.keys(prefs.getPrefs()).length === 0, JSON.stringify(prefs.getPrefs()))

  prefs.setPref('fc_agent_presets', ['hermes', 'codex'])
  check('A2 写入后读得到', JSON.stringify(prefs.getPref('fc_agent_presets')) === '["hermes","codex"]')
  check('A3 落盘到 prefs.json', fs.existsSync(prefs.getPrefsPath()), prefs.getPrefsPath())

  prefs.setPref('fc_cal_show_todos', false)
  check('A4 合并写入不覆盖已有键',
    Array.isArray(prefs.getPref('fc_agent_presets')) && prefs.getPref('fc_cal_show_todos') === false,
    JSON.stringify(prefs.getPrefs()))

  // 原子替换：不留 .tmp 残骸
  const leftovers = fs.readdirSync(TEST_ROOT).filter(f => f.endsWith('.tmp'))
  check('A5 原子替换后无 .tmp 残骸', leftovers.length === 0, JSON.stringify(leftovers))

  // 坏文件回退（不能抛，否则 UI 启动路径被拖垮）
  fs.writeFileSync(prefs.getPrefsPath(), '{broken', 'utf-8')
  let threw = false
  let empty = null
  try { empty = prefs.getPrefs() } catch { threw = true }
  check('A6 坏 JSON 回退空对象且不抛', threw === false && empty !== null && Object.keys(empty).length === 0)
  prefs.setPref('fc_agent_presets', ['恢复'])
  check('A7 坏文件后可重新写入', JSON.stringify(prefs.getPref('fc_agent_presets')) === '["恢复"]')

  // ══ B. 生存性：换 origin（localStorage 清空）不该丢预设 ═══════════════
  const before = JSON.stringify(prefs.getPref('fc_agent_presets'))
  // 模拟渲染层侧「新 origin」：localStorage 是空的（新 origin 天然为空），只有主进程文件在
  check('B1 localStorage 被清空后，真身照样有值', JSON.stringify(prefs.getPref('fc_agent_presets')) === before,
    before)
  // 换一个「新进程」重新 require（清模块缓存）→ 仍然读得到 = 不是内存里假活着
  Object.keys(require.cache).filter(k => k.includes('services') && k.endsWith('prefs.js')).forEach(k => delete require.cache[k])
  const prefs2 = require(path.join(DIST, 'services', 'prefs.js'))
  check('B2 新进程重新加载后仍在（真的在磁盘上）',
    JSON.stringify(prefs2.getPref('fc_agent_presets')) === before)

  // ══ C. 接线（源码断言，防漂移） ══════════════════════════════════════
  const ipcSrc = fs.readFileSync(path.join(SRC, 'main', 'ipc.ts'), 'utf-8')
  const preloadSrc = fs.readFileSync(path.join(SRC, 'preload', 'index.ts'), 'utf-8')
  const vueSrc = fs.readFileSync(path.join(SRC, 'renderer', 'App.vue'), 'utf-8')

  check('C1 主进程注册 prefs:get', /guardedHandle\('prefs:get'/.test(ipcSrc))
  check('C2 主进程注册 prefs:set', /guardedHandle\('prefs:set'/.test(ipcSrc))
  check('C3 preload 暴露 prefsGet', /prefsGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('prefs:get'\)/.test(preloadSrc))
  check('C4 preload 暴露 prefsSet', /prefsSet:\s*\(key: string, value: any\)\s*=>\s*ipcRenderer\.invoke\('prefs:set'/.test(preloadSrc))
  check('C5 渲染层有与主进程对齐的同步逻辑', /async function syncAgentPresets/.test(vueSrc) && /syncAgentPresets\(\)/.test(vueSrc))
  check('C6 启动时调用同步（onMounted 内）', /onMounted\(\(\) => \{[\s\S]{0,400}syncAgentPresets\(\)/.test(vueSrc))
  check('C7 预设写入同时落缓存与真身', /function saveAgentPresets[\s\S]{0,400}prefsSet\('fc_agent_presets'/.test(vueSrc))
  check('C8 真身空而缓存有值时做一次性迁移',
    /cached && cached\.length[\s\S]{0,160}prefsSet\('fc_agent_presets', cached\)/.test(vueSrc))

  console.log('─'.repeat(50))
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); process.exitCode = 1 }
  console.log(`RESULT ${pass} / ${fail}`)
}

try { main() } catch (e) { console.error('测试框架异常：', e); process.exitCode = 1; console.log('RESULT 0 / 1') }
