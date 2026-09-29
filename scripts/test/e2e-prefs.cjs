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

  // ══ D. 硬件加速开关（2026-09-25 用户第 1/3/9 条的人工验证杠杆）════════
  // 「点输入框光标不进去、要切到别的窗口再切回来才恢复」这条已经去掉了全部常驻实时
  // 模糊合成层。若仍复发，剩下的只有合成器/核显驱动层 —— 所以给用户一个能自己翻的
  // 开关。这里钉死三件事：开关落盘、主进程真读、读的时机在 ready 之前且 userData 之后。
  prefs.setPref('fc_disable_gpu', true)
  check('D1 硬件加速开关写入真身', prefs.getPref('fc_disable_gpu') === true)
  check('D2 落盘到 prefs.json（重启/换 origin 不丢）',
    JSON.parse(fs.readFileSync(prefs.getPrefsPath(), 'utf-8')).fc_disable_gpu === true,
    fs.readFileSync(prefs.getPrefsPath(), 'utf-8'))
  prefs.setPref('fc_disable_gpu', false)
  check('D3 能关回去', prefs.getPref('fc_disable_gpu') === false)

  const idxSrc = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf-8')
  const iSetPath = idxSrc.indexOf("app.setPath('userData'")
  const iGetPref = idxSrc.indexOf("getPref('fc_disable_gpu')")
  const iDisable = idxSrc.indexOf('app.disableHardwareAcceleration()')
  check('D4 主进程启动时读了 fc_disable_gpu', iGetPref > 0, `@${iGetPref}`)
  check('D5 ★ 时机正确：先 setPath(userData) → 再读 prefs → 再 disableHardwareAcceleration',
    iSetPath >= 0 && iGetPref > iSetPath && iDisable > iGetPref,
    `setPath@${iSetPath} getPref@${iGetPref} disable@${iDisable}`)
  check('D6 ★ 关硬件加速受开关约束，不是无条件调用',
    /getPref\('fc_disable_gpu'\) === true[\s\S]{0,240}app\.disableHardwareAcceleration\(\)/.test(idxSrc))
  check('D7 渲染层设置页有同名开关（key 两端一致）且提示需重启',
    /fc_disable_gpu/.test(vueSrc) && /function onDisableGpuChange/.test(vueSrc) && /需重启生效/.test(vueSrc))
  check('D8 ★ 开关也进 syncBoardPrefs 双向对齐（不只写 localStorage，否则换 origin 丢）',
    /function syncBoardPrefs[\s\S]{0,3000}typeof p\?\.fc_disable_gpu === 'boolean'/.test(vueSrc))

  // ══ E. 多视图选择（2026-09-28 用户第 ① 条 + 卡 033 多视图）════════════
  // 与 014 是**同一个 bug 类**：只写 localStorage 的偏好在换 origin 时会整个消失。
  // 视图选择（看板 列/列表、待办 清单/卡片网格）必须走同一条真身路径。
  // 数据层在这里真写真读；界面接线用源码断言钉住（真点击在 e2e-renderer 里）。
  prefs.setPref('fc_board_view', 'list')
  check('E1 看板视图选择能写入真身', prefs.getPref('fc_board_view') === 'list')
  check('E2 落盘到 prefs.json（重启/换 origin 不丢）',
    JSON.parse(fs.readFileSync(prefs.getPrefsPath(), 'utf-8')).fc_board_view === 'list')
  prefs.setPref('fc_todo_view', 'grid')
  check('E3 待办视图选择能写入真身',
    JSON.parse(fs.readFileSync(prefs.getPrefsPath(), 'utf-8')).fc_todo_view === 'grid')
  check('E4 两个键互不覆盖（合并写入，不是整体重写）',
    prefs.getPref('fc_board_view') === 'list' && prefs.getPref('fc_todo_view') === 'grid')

  check('E5 ★ syncBoardPrefs 读这两个键（真身优先，否则重启回到默认摆法）',
    /function syncBoardPrefs[\s\S]{0,4000}p\?\.fc_board_view === 'cols'[\s\S]{0,400}p\?\.fc_todo_view === 'list'/.test(vueSrc))
  check('E6 ★ 只认白名单字面量（prefs.json 可以手改，别让界面进"两个按钮都不高亮"的怪状态）',
    /fc_board_view === 'cols' \|\| p\?\.fc_board_view === 'list'/.test(vueSrc)
    && /fc_todo_view === 'list' \|\| p\?\.fc_todo_view === 'grid'/.test(vueSrc))
  check('E7 ★ 默认值是**旧视图**（列视图 / 清单）—— 用户要的是"旧的可以保留"',
    /BOARD_VIEW_KEY, 'cols'/.test(vueSrc) && /TODO_VIEW_KEY, 'list'/.test(vueSrc))
  check('E8 ★ 切视图会写回真身（saveUiPref → prefsSet）',
    /function setViewMode[\s\S]{0,500}saveUiPref\(TODO_VIEW_KEY[\s\S]{0,300}saveUiPref\(BOARD_VIEW_KEY/.test(vueSrc))
  check('E9 页头切换器是真 button + 选中态跟着 currentViewMode（不是死控件）',
    /v-for="o in viewOptions"[\s\S]{0,200}class="vsb"[\s\S]{0,200}:class="\{ on: currentViewMode === o\.v \}"[\s\S]{0,120}@click="setViewMode\(o\.v\)"/.test(vueSrc))
  check('E10 两种摆法互斥渲染（同时挂两份 DOM 会让勾选/计数翻倍）',
    /boardView === 'list'[\s\S]{0,200}class="board-list"/.test(vueSrc)
    && /v-if="boardView === 'cols'"/.test(vueSrc))

  // E11/E12 看板排序方式（2026-09-29：它此前是个**死控件** —— sortMode 只在模板绑了 v-model，
  //        全代码零引用 → 换下拉毫无反应。接上之后同样必须进真身，否则重启就忘。）
  prefs.setPref('fc_board_sort', 'updated')
  check('E11 排序选择能写入真身并落盘',
    prefs.getPref('fc_board_sort') === 'updated'
    && JSON.parse(fs.readFileSync(prefs.getPrefsPath(), 'utf-8')).fc_board_sort === 'updated')
  check('E12 ★ syncBoardPrefs 白名单读 fc_board_sort（只认三个已知值，手改 prefs.json 也不会进怪状态）',
    /fc_board_sort === 'active' \|\| p\?\.fc_board_sort === 'updated' \|\| p\?\.fc_board_sort === 'created'/.test(vueSrc))
  check('E13 ★ 排序真的被用上了（修前 sortMode 全代码零引用 —— 死控件）',
    /function applySortMode/.test(vueSrc) && /return applySortMode\(result\)/.test(vueSrc))

  // E14/E15/E16 项目页签三摆法（2026-09-29 用户：「两种视图都要，做成用户可自选切换选项」）
  prefs.setPref('fc_pv_view', 'master')
  check('E14 项目页签摆法能写入真身并落盘',
    prefs.getPref('fc_pv_view') === 'master'
    && JSON.parse(fs.readFileSync(prefs.getPrefsPath(), 'utf-8')).fc_pv_view === 'master')
  check('E15 ★ syncBoardPrefs 白名单读 fc_pv_view（只认三个已知值 —— prefs.json 是可以手改的）',
    /fc_pv_view === 'tiles' \|\| p\?\.fc_pv_view === 'overview' \|\| p\?\.fc_pv_view === 'master'/.test(vueSrc))
  check('E16 ★ 三种摆法互斥渲染 + 各自的根容器类独立（共用类名就没法机械判"挂了几个"）',
    /pvView === 'tiles'/.test(vueSrc) && /pvView === 'overview'/.test(vueSrc)
    && /class="pvgrid" v-if="pvView === 'tiles'"/.test(vueSrc)
    && /class="ovgrid"/.test(vueSrc) && /class="pv-ms"/.test(vueSrc))

  console.log('─'.repeat(50))
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); process.exitCode = 1 }
  console.log(`RESULT ${pass} / ${fail}`)
}

try { main() } catch (e) { console.error('测试框架异常：', e); process.exitCode = 1; console.log('RESULT 0 / 1') }
