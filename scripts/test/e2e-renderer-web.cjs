/**
 * 渲染层 DOM 断言（无头浏览器兜底）—— 2026-09-28
 *
 * 存在的理由（一句话）：**没跑过的断言等于没有。**
 * `e2e-renderer.cjs` 要有桌面会话（真 Electron + 真点击），本机/CI 只能 `RESULT SKIP`，
 * 于是每轮新增的渲染层断言都成了"写了但从没执行过"——2026-09-28 那个
 * `if (draggingId)`（ref 裸用当布尔，恒为真）就是这么漏到用户面前的。
 *
 * 本脚本换一条路：用系统自带的 Edge/Chrome **无头模式**，
 * 加载**同一份构建产物**（desktop/dist/renderer）与**同一个假 preload**
 * （desktop/test/renderer-preload.cjs，把 require('electron') 换成直接挂 window 的壳），
 * 把界面真渲染出来，跑 `desktop/test/renderer-web-assert.js` 里的 DOM 几何/样式断言。
 *
 * 覆盖范围刻意只放**纯前端呈现**（换个摆法、几何、计算样式）。
 * 真 IPC、真点击、真 bridge 序列化仍以 e2e-renderer / e2e-bridge-clone 为准。
 *
 * 用法：node scripts/test/e2e-renderer-web.cjs
 * 环境变量：FC_WEB_BROWSER=<浏览器 exe 路径>（不给就自动找 Edge / Chrome）
 * 退出码：断言失败 → 1；找不到浏览器 → 2（**显式失败**，不伪装成通过）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DESKTOP = path.join(ROOT, 'desktop')
const DIST = path.join(DESKTOP, 'dist', 'renderer')
const INDEX = path.join(DIST, 'index.html')
const PRELOAD = path.join(DESKTOP, 'test', 'renderer-preload.cjs')
const ASSERT = path.join(DESKTOP, 'test', 'renderer-web-assert.js')

const CANDIDATES = [
  process.env.FC_WEB_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

function findBrowser() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p } catch { /* 忽略无权限路径 */ }
  }
  return null
}

/** 假 preload 的 require('electron') → 浏览器里直接挂 window 的壳（其余一字不改） */
function browserPreload() {
  const src = fs.readFileSync(PRELOAD, 'utf-8')
  const patched = src.replace(
    /const \{ contextBridge \} = require\('electron'\)/,
    'const contextBridge = { exposeInMainWorld: (k, v) => { window[k] = v } }'
  )
  if (patched === src) {
    console.error('FAIL  假 preload 的 contextBridge 引入方式变了，本脚本的替换规则已失效')
    process.exit(1)
  }
  // bundle 是 classic script 注入的，模块级 `const` 会污染全局 —— 整体包一层 IIFE
  return '(function () {\n' + patched + '\n})();\n'
}

/** 构建产物是**单块**（无顶层 import/export）→ 可以直接当 classic script 内联，
 *  绕开 file:// 下 ES module 的 CORS 限制（这条限制在无头浏览器里同样存在）。 */
/**
 * 常驻模式 + CDP：起一个**不退出**的实例，通过 DevTools 协议把页面 DOM 取回来。
 *
 * 为什么需要它：某些执行环境里，Chromium 的**一次性**模式（`--dump-dom` / `--screenshot`）
 * 进程启动后**立即退出、零产出**（exit 0、stderr 也空、连指定路径的截图文件都不生成），
 * 但**常驻**模式完全正常 —— 2026-10-10 本机实测：`--remote-debugging-port` 起的实例
 * 能正常渲染、`/json/version` 正常响应、`Runtime.evaluate` 能取到真实 DOM。
 * 所以这不是「无头浏览器不可用」，是「一次性模式的启动/退出通道被挡了」。
 * dump-dom 拿不到结果时改走这条路，而不是直接判失败。
 *
 * ⚠ 必须用独立 `--user-data-dir`：否则新实例的命令会被转发给用户正在用的浏览器，
 *   进程秒退、什么都拿不到（而 Chrome 进程数为 0 时也照样失败 → 与"实例冲突"无关）。
 */
function viaCdp(browser, url, env, budgetMs = 150000) {
  const port = 9411 + (process.pid % 500)
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cdp-'))
  const child = spawn(browser, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + prof,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox', '--disable-extensions',
    '--allow-file-access-from-files',
    // ⚠ 这里**不要**加 --virtual-time-budget（一次性模式那边是另一回事，那边必须加）：
    //   常驻模式下它会页面钉在虚拟时间轴上，断言里的 sleep/waitFor 永远跑不完 →
    //   表现为「CDP 兜底超时」。2026-10-10 实测：加了必超时，去掉后一次就过。
    'about:blank',
  ], { stdio: 'ignore', env })

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const base = 'http://127.0.0.1:' + port

  return (async () => {
    try {
      let ready = false
      for (let i = 0; i < 120; i++) {
        try { const r = await fetch(base + '/json/version'); if (r.ok) { ready = true; break } } catch { /* 还没起来 */ }
        await sleep(250)
      }
      if (!ready) throw new Error('CDP 端口没起来（' + port + '）')

      const tab = await (await fetch(base + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json()
      const ws = new WebSocket(tab.webSocketDebuggerUrl)
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true })
        ws.addEventListener('error', () => rej(new Error('WebSocket 连不上')), { once: true })
      })
      const send = (method, params) => new Promise((res) => {
        const id = Math.floor(Math.random() * 1e9)
        const onMsg = (ev) => {
          let m
          try { m = JSON.parse(ev.data) } catch { return }
          if (m.id === id) { ws.removeEventListener('message', onMsg); res(m) }
        }
        ws.addEventListener('message', onMsg)
        ws.send(JSON.stringify({ id, method, params }))
      })

      const deadline = Date.now() + budgetMs
      let html = ''
      let ticks = 0
      while (Date.now() < deadline) {
        await sleep(1000)
        const r = await send('Runtime.evaluate', {
          expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
          returnByValue: true,
        })
        html = (r && r.result && r.result.result && r.result.result.value) || ''
        if (html.indexOf('[[FC-END]]') >= 0) break
        // 每 10 秒报一次进度：页面在长、但断言没结束时，这条能区分"页面没渲染"和"断言还在跑"
        if (++ticks % 10 === 0) console.log('      [cdp] 等待断言完成… dom=' + html.length)
      }
      try { ws.close() } catch { /* ignore */ }
      return html
    } finally {
      try { child.kill() } catch { /* ignore */ }
    }
  })()
}

/** 从浏览器吐回来的 DOM 里取 [[FC-BEGIN]]…[[FC-END]] 之间的断言结果 */
function parseResult(raw) {
  // --dump-dom 会把 <pre> 的文本转义；CDP 返回的 outerHTML 也一样
  const flat = String(raw || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  const m = flat.match(/\[\[FC-BEGIN\]\]([\s\S]*?)\[\[FC-END\]\]/)
  if (!m) return null
  return { text: m[1].split('\n').filter((l) => l.trim()).join('\n'), sum: m[1].match(/通过 (\d+) \/ 失败 (\d+)/) }
}

function main() {
  if (!fs.existsSync(INDEX)) {
    console.error('FAIL  找不到渲染层构建产物:', INDEX, '—— 请先 cd desktop && npm run build')
    process.exit(1)
  }
  const browser = findBrowser()
  if (!browser) {
    console.error('FAIL  找不到可用的 Edge/Chrome。可用 FC_WEB_BROWSER=<exe 路径> 指定。')
    console.error('      本脚本**不**在找不到浏览器时假装通过。')
    process.exit(2)
  }

  const html = fs.readFileSync(INDEX, 'utf-8')
  const jsMatch = html.match(/src="\.\/(assets\/[^"]+\.js)"/)
  const cssMatch = html.match(/href="\.\/(assets\/[^"]+\.css)"/)
  if (!jsMatch) {
    console.error('FAIL  dist/renderer/index.html 里没有找到相对路径的入口 JS（构建配置变了吗？）')
    process.exit(1)
  }
  const bundlePath = path.join(DIST, jsMatch[1])
  const bundle = fs.readFileSync(bundlePath, 'utf-8')
  if (/^\s*(import|export)\s/m.test(bundle) || /^\s*export\s*\{/m.test(bundle)) {
    console.error('FAIL  构建产物不再是单块（有顶层 import/export），无法内联为 classic script。')
    console.error('      需要把 vite 的 rollupOptions.output.inlineDynamicImports 保持开启，或改用本地 HTTP 服务加载。')
    process.exit(1)
  }

  // ── 免责声明的"已同意"预置（2026-10-16 暮雨第 1 条）─────────────────────
  // 截图要拍**主界面**，不能被首启强制弹窗挡住 → 只给截图用这份 seed。
  // ⚠ 主断言流程**刻意不 seed**：那里要真跑一遍"首启必须强制弹"（见 renderer-web-assert.js
  //   开头那一节）。谁要往主流程加 seed，先想清楚是不是把那条断言废掉了。
  // ⚠ 版本号从 single source（disclaimer.ts）现读、不在这里写死 —— 写死会随声明改版分叉，
  //   表现为"截图里突然又弹出免责框"而没人知道为什么。
  const dmSrc = fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'disclaimer.ts'), 'utf-8')
  const dmVer = (dmSrc.match(/DISCLAIMER_VERSION\s*=\s*'([^']+)'/) || [])[1]
  if (!dmVer) {
    console.error('FAIL  从 disclaimer.ts 读不到 DISCLAIMER_VERSION —— 截图的"已同意"预置会失效')
    process.exit(1)
  }
  const ACK_SEED = "try{localStorage.setItem('fc_disclaimer_ack',JSON.stringify({v:'" + dmVer + "',at:'2026-10-16T00:00:00.000Z'}))}catch(e){}\n"

  const headFor = (seed) => [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>FC harness</title>',
    cssMatch ? `<link rel="stylesheet" href="./${cssMatch[1]}">` : '',
    '<script>', browserPreload(), (seed || ''), '</script>',
    '</head><body><div id="app"></div>',
    '<script>', bundle, '</script>',
  ]
  const harness = (tail, seed) => headFor(seed).concat(['<script>', tail, '</script>', '</body></html>']).join('\n')
  const harnessPath = path.join(DIST, '__web-harness.html')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  // ── --shots：给"没装桌面会话"的人留一份可看的真机截图（不是小样，是真产物）──
  //    用法 `node scripts/test/e2e-renderer-web.cjs --shots[=输出目录]`
  //    每个页签各拍两种摆法；顺便也是"两种摆法都能无错渲染"的冒烟。
  const shotArg = process.argv.find((a) => a === '--shots' || a.startsWith('--shots='))
  if (shotArg) {
    // ⚠ 必须 resolve 成绝对路径：`--screenshot=` 是交给 Edge 自己解析的，
    //   传相对路径时它会按**自己的**工作目录落盘 —— 2026-10-14 就这么踩了一次：
    //   传 `--shots=docs/views-web`，Edge 没写进仓库，而脚本只看"文件在不在" → 全绿假通过。
    const outDir = path.resolve(
      shotArg.includes('=') ? shotArg.split('=')[1] : path.join(ROOT, 'docs', 'views-web')
    )
    fs.mkdirSync(outDir, { recursive: true })
    const CASES = [
      ['看板', '列视图', 'board-cols'],
      ['看板', '列表视图', 'board-list'],
      ['待办', '清单', 'todo-list'],
      ['待办', '卡片网格', 'todo-grid'],
      // 没有视图切换器的页签：view 传空，driver 只会切页签
      ['日历', '', 'calendar'],
      ['日历', '改法A展开', 'calendar-expanded', '2026-09-30'],
      ['项目', '项目墙', 'project-tiles'],
      ['项目', '概览卡', 'project-overview'],
      ['项目', '主从', 'project-master'],
      // 2026-10-22 · 03 控制台：随问页的空态与"问出一屏答案"态各留一张（目检用）
      // 想法（2026-10-22 · 念头没有家）
      ['想法', '', 'ideas'],
      ['问答', '', 'ask'],
      ['问答', '', 'ask-answer', 'askans'],
      // 2026-09-29：日志（ID 芯片）与设置（主题色板 / 日志清理）各留一张证据
      ['日志', '', 'logs'],
      // 2026-09-29 第 3 条（方案二）：日志接力 —— 按链视图 + 接力对话框各留一张真机证据
      ['日志', '', 'logs-chain', 'chain'],
      ['日志', '', 'logs-relay', 'relay'],
      // 2026-09-30 用户补充：待办 / 回收站 多选 —— 各留一张批量栏 + 选中态证据
      ['待办', '', 'todo-batch', 'todobatch'],
      ['回收站', '', 'trash-batch', 'trashbatch'],
      // 2026-10-12 决策卡（AI 规划包第 3 件）：三态渲染 + 记一条/改状态交互
      ['决策', '', 'decisions'],
      ['决策', '', 'decisions-act', 'decact'],
      // 2026-10-14 任务卡右键菜单（第 ④ 步第二单）：换 reka-ui ContextMenu 后的成品长相
      ['看板', '列视图', 'ctx-menu', 'ctxmenu'],
      ['设置', '', 'settings'],
      // 2026-10-25：念头长度上限滑块（暮雨第 3 条跟进）—— 拍「拉到 15000」的成品态，
      // 目检就两件事：滑块位置对得上数值、数值与轨道在同一行不换行不溢出。
      ['设置', '', 'settings-idea-limit', 'idealimit'],
      // 2026-10-25：新建日志弹窗的附件区（暮雨第 4 / 7 条）—— 要点：按钮不再置灰、
      // 有「Ctrl+V 粘图」提示、粘一张图后出现「待挂 1 个」的虚线胶囊。
      ['日志', '', 'log-new-attach', 'lognew'],
      // 2026-10-25：拖两个文件进新建弹窗 → 点「取消」→ 必须弹「改动还没保存」条（待挂也算脏）。
      // 这一张同时证明 drop 通了、二次确认在。
      ['日志', '', 'log-new-attach-guard', 'attachguard'],
      // 2026-10-25：多选模式下的「分区头整组勾选」（暮雨第 11 条）——
      // 拍「点了一个分区头的框、整组进选择」的成品态，别的组一个没动。
      ['看板', '列视图', 'board-group-select', 'grpselect'],
      // 2026-10-25：项目优先级视图（可选启用）—— 真开开关 → 切页签 → 真拖一行，
      // 截图要看得出「第 2 名被拖到了第 1 位」（拖完立即落盘，没有保存按钮）。
      ['看板', '', 'priority-view', 'prioview'],
    ]
    const SEED_TODOS = [
      '多视图断言用：这是一条刻意写得很长的待办标题，用来验证卡片网格里标题最多三行不截断',
      '去便利店买咖啡豆',
      '把导出五件套的 README 补一版',
      '核对 029 结构地图的最后核实日期',
      '给看板列表视图补一条「空分区不画空框」的截图',
      '复盘上周的 EBUSY 环境问题',
    ]
    // FC_SHOT_THEME=<id>：整套截图换个主题拍（2026-09-29 用户第 4 条）——
    // 主题是纯 CSS 令牌，但"看着对不对"仍然只能靠真渲染截图目检。
    const THEME_SHOT = process.env.FC_SHOT_THEME || ''
    const driver = (page, view, extra) => `
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const all = (s) => Array.prototype.slice.call(document.querySelectorAll(s))
  const clickText = (t) => { const b = all('button, .vbtn').find((e) => (e.textContent || '').trim() === t); if (b) b.click(); return !!b }
  ${THEME_SHOT ? `document.documentElement.dataset.theme = ${JSON.stringify(THEME_SHOT)}; await sleep(250)` : ''}
  clickText(${JSON.stringify(page === '设置' ? '⚙' : page)}); await sleep(${page === '设置' ? 1000 : 600})
  ${page === '待办' ? `
  // 假后端的待办是空的 —— 先造几条，"方块卡片"才有东西可看（含一条超长标题）
  const seeds = ${JSON.stringify(SEED_TODOS)}
  // 2026-09-29 用户第 1 条：小框（+ 添加）已移除 —— 只能走唯一入口「＋ 新建待办」大框
  for (const t of seeds) {
    const nb = all('main.todos-view .todos-ctrls button').find((x) => x.textContent.indexOf('新建待办') >= 0)
    if (!nb) break
    nb.click()
    await sleep(200)
    const ta = all('#todo-edit-modal textarea')[0]
    if (!ta) break
    ta.value = t
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    const sb = all('#todo-edit-modal button').find((x) => (x.textContent || '').trim() === '保存')
    if (sb) sb.click()
    await sleep(260)
  }
  await sleep(500)` : ''}
  const b = all('.pagehead button.vsb').find((x) => x.textContent.indexOf(${JSON.stringify(view)}) >= 0)
  if (b) b.click()
  await sleep(1000)
  ${extra === 'chain' || extra === 'relay' ? `
  // 日志接力（第 3 条方案二）：先灌一条真链 A(已完成) → B(进行中)，再重进日志页
  window.__fcTest.setLogs([
    { id: 'log-relay-a', title: '接力源·问题清单', content: '列出14条问题', status: 'completed', project: 'demo',
      created: '2026-09-27T00:00:00.000Z', nextSteps: '清单勾选状态回写、批注导出格式、跨文件引用跳转',
      taskIds: ['task-relay'], agentName: 'hermes' },
    { id: 'log-relay-b', title: '接力后·功能性调整', content: '改三处', status: 'active', running: true, project: 'demo',
      created: '2026-09-29T00:00:00.000Z', continueFrom: 'log-relay-a', agentName: 'hermes', prevAgentName: 'DSH' },
    { id: 'log-relay-c', title: '孤立日志', content: '与链无关', status: 'active', project: 'demo',
      created: '2026-09-28T00:00:00.000Z' },
  ])
  clickText('看板'); await sleep(450); clickText('日志'); await sleep(700)
  ${extra === 'chain' ? `clickText('按链'); await sleep(700)` : `const rb = all('.relay-btn')[0]; if (rb) rb.click(); await sleep(700)`}` : ''}
  ${extra === 'todobatch' || extra === 'trashbatch' ? `
  // 待办/回收站多选（2026-09-30 用户补充）：先灌数据，重进页签，开多选并点两张
  ${extra === 'todobatch'
    ? `window.__fcTest.setTodos([
    { id: 'td-1', title: '多选截图：第一件事', priority: '高', done: false, created: 1 },
    { id: 'td-2', title: '多选截图：第二件事', priority: '中', done: false, created: 2 },
    { id: 'td-3', title: '多选截图：已完成的旧事', priority: '低', done: true, created: 3 },
  ])`
    : `window.__fcTest.setTrash([
    { name: 'task-trash-a.md', id: 'task-trash-a', title: '回收站多选截图：甲', status: '完成', project: '', bytes: 2048, mtime: Date.now() },
    { name: 'task-trash-b.md', id: 'task-trash-b', title: '回收站多选截图：乙', status: '待办', project: 'demo', bytes: 1024, mtime: Date.now() },
  ])`}
  clickText('看板'); await sleep(450); clickText(${JSON.stringify(page)}); await sleep(700)
  const bb = all('.batch-mode-btn').find((x) => (x.textContent || '').indexOf('多选') >= 0)
  if (bb) bb.click()
  await sleep(500)
  ${extra === 'todobatch'
    ? `const its = all('.todos-view .todo-item'); if (its[0]) its[0].click(); await sleep(200); if (its[1]) its[1].click()`
    : `const its = all('.trash-view .trash-main'); if (its[0]) its[0].click(); await sleep(200); if (its[1]) its[1].click()`}
  await sleep(500)` : ''}
  ${extra === 'decact' ? `
  // 决策卡交互（2026-10-12；2026-10-14 改走 data-dec 钩子 —— 视图已切到 components/DecisionBoard.vue）：
  // 记一条新决策 → 改 D-001 状态 → 筛「已撤销」——三步全真链路（mock IPC）
  const decMain = all('[data-dec="add-input"]')[0]
  if (decMain) {
    decMain.value = 'e2e 交互：这条决策是测试记的'
    decMain.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(150)
  }
  const decAddBtn = all('.decisions-view button').find((b) => (b.textContent || '').trim() === '记下')
  if (decAddBtn) decAddBtn.click()
  await sleep(500)
  const decSel = all('[data-dec="status"]')[0]
  if (decSel) {
    decSel.value = '已撤销'
    decSel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(500)
  }
  const decF = all('[data-dec="tab"]').find((x) => (x.textContent || '').trim().indexOf('已撤销') === 0)
  // ⚠ reka-ui TabsTrigger 只认 mousedown（源码里没有 click 处理）—— 合成 .click() 点了等于没点
  if (decF) decF.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  if (decF) decF.click()
  await sleep(500)` : ''}
  ${extra === 'askans' ? `
  // 随问（2026-10-22 · 03 任务一）：点一个常用问题，把"问出来的答案"拍下来
  const chip = all('.ask-view .ask-chip').find((x) => (x.textContent || '').trim() === '欠着什么')
  if (chip) chip.click()
  await sleep(1200)` : ''}
  ${extra === 'ctxmenu' ? `
  // 任务卡右键菜单（2026-10-14 第 ④ 步第二单）：在列视图第一张卡上派发 contextmenu，
  // 把 reka-ui ContextMenu 的成品长相拍下来（位置由 floating-ui 给，不是 left/top 内联坐标）
  const cw = all('#board .col > .card')[0]
  if (cw) cw.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))
  await sleep(800)` : ''}
  ${extra === 'idealimit' ? `
  // 念头长度上限滑块（2026-10-25）：拉到 15000 —— 截图要能同时看到
  // ① 滑块停在约 3/4 处 ② 右侧数值跟着变成 15,000 字 ③ 两者在同一行
  const sl = all('#smodal .slider')[0]
  if (sl) { sl.value = '15000'; sl.dispatchEvent(new Event('input', { bubbles: true })) }
  await sleep(400)` : ''}
  ${extra === 'lognew' ? `
  // 新建日志 → 在弹窗上派发一次真 paste（带一张 120x80 的 PNG）——
  // 走的是 onLogPaste 的新建态分支（只进内存，不碰 IPC），所以无头里也能看到"待挂 1 个"。
  const nb = all('button').find((b) => (b.textContent || '').indexOf('新建日志') >= 0)
  if (nb) nb.click()
  await sleep(600)
  const modal = document.querySelector('#log-edit-modal')
  if (modal) {
    const blob = await new Promise((res) => {
      const c = document.createElement('canvas')
      c.width = 120; c.height = 80
      const g = c.getContext('2d')
      g.fillStyle = '#7c5cbf'; g.fillRect(0, 0, 120, 80)
      g.fillStyle = '#ffffff'; g.font = '16px sans-serif'; g.fillText('PASTE DEMO', 8, 46)
      c.toBlob(res, 'image/png')
    })
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'paste-demo.png', { type: 'image/png' }))
    modal.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    await sleep(500)
    // 附件区在弹窗底部（弹窗自己滚动），不滚到底截图里根本看不到
    modal.scrollTop = modal.scrollHeight
    await sleep(350)
  }
` : ''}
  ${extra === 'attachguard' ? `
  // 拖两个文件进新建弹窗（走真 DragEvent + DataTransfer），再点「取消」——
  // 待挂附件必须算"未保存的改动"，否则用户点 × 就一声不响丢了（暮雨第 4 条追加）。
  const nb2 = all('button').find((b) => (b.textContent || '').indexOf('新建日志') >= 0)
  if (nb2) nb2.click()
  await sleep(600)
  const m2 = document.querySelector('#log-edit-modal')
  if (m2) {
    const mkPng = (color) => new Promise((res) => {
      const c = document.createElement('canvas')
      c.width = 80; c.height = 60
      const g = c.getContext('2d')
      g.fillStyle = color; g.fillRect(0, 0, 80, 60)
      c.toBlob(res, 'image/png')
    })
    const p1 = await mkPng('#7c5cbf')
    const p2 = await mkPng('#3f8f5f')
    const dt2 = new DataTransfer()
    dt2.items.add(new File([p1], 'drag-a.png', { type: 'image/png' }))
    dt2.items.add(new File([p2], 'drag-b.png', { type: 'image/png' }))
    m2.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt2, bubbles: true, cancelable: true }))
    await sleep(250)
    m2.dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true }))
    await sleep(600)
    const cancelBtn = all('#log-edit-modal button').find((b) => (b.textContent || '').trim() === '取消')
    if (cancelBtn) cancelBtn.click()
    await sleep(500)
    m2.scrollTop = m2.scrollHeight
    await sleep(350)
  }
` : ''}
  ${extra === 'grpselect' ? `
  // 分区头整组勾选（2026-10-25 第 11 条）：开多选 → 点第一个「卡数 >1」分区的组选框
  const bb = all('#views .batch-mode-btn').find((b) => (b.textContent || '').indexOf('任务多选') >= 0)
  if (bb) bb.click()
  await sleep(500)
  const gcols = all('#board .col')
  const gc = gcols.find((c) => c.querySelectorAll('.card[data-id]').length > 1)
  if (gc) {
    const gbox = gc.querySelector('h3 .grp-chk input')
    if (gbox) gbox.click()
  }
  await sleep(600)
` : ''}
  ${extra === 'prioview' ? `
  // 优先级视图（2026-10-25）：设置里开开关 → 顶栏出现页签 → 切进去 → 真拖一行
  const gear = all('button').find((b) => (b.textContent || '').trim() === '⚙')
  if (gear) gear.click()
  await sleep(700)
  const pchk = all('#smodal .chk input').find((i) => {
    const lb = i.closest('.chk')
    return lb && (lb.textContent || '').indexOf('优先级') >= 0
  })
  if (pchk) pchk.click()
  await sleep(400)
  const closeS = all('#smodal button').find((b) => (b.textContent || '').trim() === '关闭')
  if (closeS) closeS.click()
  await sleep(500)
  clickText('优先级')
  await sleep(900)
  const prows = all('.priority-view .pri-row')
  if (prows.length >= 2) {
    const dt = new DataTransfer()
    prows[0].dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    await sleep(150)
    prows[1].dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    await sleep(150)
    prows[1].dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    await sleep(700)
  }
` : ''}
  ${extra === '2026-09-30' ? `
  // 日历「改法 A」的展开态：点开 9-30 那格的「+N 条」，截图里要能看到"铺满整格"的样子
  const cells = all('main.calendar-view .calcell').filter(c => (c.textContent || '').indexOf('日历密度样例一') >= 0)
  if (cells[0]) { const mb = cells[0].querySelector('.cal-cell-more'); if (mb) mb.click() }
  await sleep(600)` : ''}
})()`
    let n = 0
    const next = () => {
      if (n >= CASES.length) return done()
      const [page, view, name, extra] = CASES[n++]
      fs.writeFileSync(harnessPath, harness(driver(page, view, extra), ACK_SEED), 'utf-8')
      const png = path.join(outDir, name + '.png')
      // ⚠ 先删旧图再拍：判据是「这张图是**这次**拍出来的」，不是「目录里有这么个文件」。
      //   2026-10-14 真事：上一轮留下的同名旧图让 Edge 没写也报 OK，截图"成功"了 17 张，
      //   实际一张都没更新（打开一看还是几天前的界面）。**存在 ≠ 本轮产出。**
      try { fs.rmSync(png, { force: true }) } catch { /* 忽略 */ }
      const c = spawn(browser, [
        // 2026-10-09：截图证据必须拍「动画的终态」而不是半透明的中间帧 ——
        // numIn 入场动画在 virtual-time 截图里会冻结在起始态（KPI 数字/阻塞按钮变幽灵字，
        // 目检两次误报"元素重叠/按钮不存在"）。关动画 = 每次拍出的都是确定的最终画面。
        '--headless=new', '--force-prefers-reduced-motion', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
        '--disable-extensions', '--window-size=' + (process.env.FC_SHOT_SIZE || '1440,900'), '--hide-scrollbars',
        // 独立 profile（同上）：截图 harness 里预置了"已同意免责声明"，但那只在**空 localStorage**
        // 上才意味着"干净的主界面"——用系统 profile 跑等于赌它没被写过。
        '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'fc-shot-')),
        // 显式钉住 1:1。⚠ 本机**实测**：不加这条 Edge 也是 1440×900（headless 默认 1:1），
        //   所以它不是"修了什么 bug"，而是防止换到 DPI 不同的机器上悄悄变成 0.75/1.25 倍 ——
        //   截图是给人目检的，尺寸漂移会让前后两张根本没法对比。
        '--force-device-scale-factor=' + (process.env.FC_SHOT_SCALE || '1'),
        '--virtual-time-budget=20000', '--screenshot=' + png,
        'file:///' + harnessPath.replace(/\\/g, '/'),
      ], { stdio: ['ignore', 'pipe', 'pipe'], env })
      c.on('close', () => {
        const okk = fs.existsSync(png) && fs.statSync(png).size > 5000
        console.log((okk ? 'OK   ' : 'FAIL ') + name + '.png  (' + (okk ? fs.statSync(png).size : 0) + ' bytes)')
        if (!okk) process.exitCode = 1
        next()
      })
    }
    var done = () => {
      try { fs.unlinkSync(harnessPath) } catch { /* 忽略 */ }
      console.log('截图目录：' + outDir)
      process.exit(process.exitCode || 0)
    }
    return next()
  }

  fs.writeFileSync(harnessPath, harness(fs.readFileSync(ASSERT, 'utf-8')), 'utf-8')
  console.log('== 渲染层 DOM 断言（无头浏览器）==')
  console.log('browser:', browser)
  console.log('harness:', harnessPath)

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--disable-extensions',
    // 2026-09-30：回收站多选断言加了 6 次点击 + waitFor，20000 虚拟毫秒会在断言跑完前
    // 把页面掐掉（表现为「没拿到断言结果」）。抬到 30000，与手动 --dump-dom 复跑一致。
    // 2026-10-03：又加了技能页多目标（卡 010/011）+ 设置页折叠（013）+ 看板归档提示条（012）
    // 三节、含数次 sleep/waitFor → 30000 再次不够，抬到 45000。
        // 2026-10-11：又加了筛选栏改版（点触发按钮 → 面板 → 点选项 → 点 ✕ 撤销）与设置页顺序断言，
    // 睡眠总量再次逼近上限 → 抬到 90000。
    '--virtual-time-budget=180000',
    // ⚠ 窗口尺寸必须与 CDP 兜底路径（`--window-size=1440,900`）**一致**：
    //   不然同一份断言在"一次性模式"（默认约 800×600 → innerWidth≈756）与兜底模式下
    //   量出来的几何完全不同 —— 表现为**同一个断言时红时绿**（2026-10-11 实测：
    //   浮层越界那条在 vw=756 时红、在 vw=1440 时绿）。
    '--window-size=1440,900',
    // ⚠ 2026-10-16：必须给**独立 profile**。此前主流程没带 `--user-data-dir`，
    //   会落到系统默认 profile —— 而"免责声明确认"就存在 localStorage 里（file:// origin），
    //   于是"首启到底弹不弹"变成**不可知**：本机跑是全新、别的机器上可能继承着旧记录，
    //   断言时红时绿。与 viaCdp 兜底路径口径统一（那边一直是独立 profile）。
    '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'fc-web-')),
    '--dump-dom',
    'file:///' + harnessPath.replace(/\\/g, '/'),
  ]

  const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { err += d.toString() })
  // 结果收口成一处：dump-dom 与 CDP 兜底共用
  const finish = (r) => {
    console.log(r.text)
    if (!r.sum) { console.log('FAIL  结果行缺失'); process.exit(1) }
    console.log('\nRESULT ' + r.sum[1] + ' / ' + r.sum[2])
    try { fs.unlinkSync(harnessPath) } catch { /* 留一份也无妨 */ }
    process.exit(Number(r.sum[2]) === 0 ? 0 : 1)
  }

  child.on('close', async () => {
    const r = parseResult(out)
    if (r) return finish(r)
    // 一次性模式没拿到 → 改走「常驻 + CDP」再试一次（原因见 viaCdp 顶部注释）
    console.log('INFO  --dump-dom 没拿到结果，改走「常驻 + CDP」重试…')
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      console.log('FAIL  CDP 兜底超时（150s）')
      process.exit(1)
    }, 150000)
    let html = ''
    try {
      html = await viaCdp(browser, 'file:///' + harnessPath.replace(/\\/g, '/'), env)
    } catch (e) {
      console.log('      CDP 也失败: ' + ((e && e.message) || e))
    }
    const r2 = parseResult(html)
    if (r2) return finish(r2)
    console.log('FAIL  没拿到断言结果（页面没跑完 / 浏览器参数失效）')
    console.log('      tail(stderr): ' + err.trim().split('\n').slice(-4).join(' ⏎ '))
    console.log('      tail(stdout): ' + out.trim().slice(-300))
    console.log('      cdp 取回的 DOM 长度: ' + String(html || '').length)
    console.log('RESULT 0 / 1')
    process.exit(1)
  })

  // 看门狗：正常一次跑完只要 1–3 秒（实测），所以它只在**浏览器真的卡住**时才响。
  // ⚠ 2026-10-11 改行为：原来这里直接 `process.exit(1)` —— 一次浏览器启动抽风就把整轮判红，
  //   而下面明明还有一条能救回来的 CDP 兜底路径。现在只杀子进程，把控制权交回 close 回调
  //   （它会自动走 CDP 重试）。**卡住 ≠ 断言失败**，别让环境抖动冒充回归。
  let watchdog = setTimeout(() => {
    console.log('INFO  --dump-dom 阶段超时（240s）→ 杀掉子进程，改走 CDP 兜底重试…')
    try { child.kill() } catch { /* ignore */ }
  }, 240000)
}

main()
