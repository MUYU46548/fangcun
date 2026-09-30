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

  const head = [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>FC harness</title>',
    cssMatch ? `<link rel="stylesheet" href="./${cssMatch[1]}">` : '',
    '<script>', browserPreload(), '</script>',
    '</head><body><div id="app"></div>',
    '<script>', bundle, '</script>',
  ]
  const harness = (tail) => head.concat(['<script>', tail, '</script>', '</body></html>']).join('\n')
  const harnessPath = path.join(DIST, '__web-harness.html')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  // ── --shots：给"没装桌面会话"的人留一份可看的真机截图（不是小样，是真产物）──
  //    用法 `node scripts/test/e2e-renderer-web.cjs --shots[=输出目录]`
  //    每个页签各拍两种摆法；顺便也是"两种摆法都能无错渲染"的冒烟。
  const shotArg = process.argv.find((a) => a === '--shots' || a.startsWith('--shots='))
  if (shotArg) {
    const outDir = shotArg.includes('=') ? shotArg.split('=')[1] : path.join(ROOT, 'docs', 'views-web')
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
      // 2026-09-29：日志（ID 芯片）与设置（主题色板 / 日志清理）各留一张证据
      ['日志', '', 'logs'],
      // 2026-09-29 第 3 条（方案二）：日志接力 —— 按链视图 + 接力对话框各留一张真机证据
      ['日志', '', 'logs-chain', 'chain'],
      ['日志', '', 'logs-relay', 'relay'],
      // 2026-09-30 用户补充：待办 / 回收站 多选 —— 各留一张批量栏 + 选中态证据
      ['待办', '', 'todo-batch', 'todobatch'],
      ['回收站', '', 'trash-batch', 'trashbatch'],
      ['设置', '', 'settings'],
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
      created: '2026-09-29T00:00:00.000Z', continueFrom: 'log-relay-a', agentName: 'hermes' },
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
      fs.writeFileSync(harnessPath, harness(driver(page, view, extra)), 'utf-8')
      const png = path.join(outDir, name + '.png')
      const c = spawn(browser, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
        '--disable-extensions', '--window-size=1440,900', '--hide-scrollbars',
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
    '--virtual-time-budget=30000',
    '--dump-dom',
    'file:///' + harnessPath.replace(/\\/g, '/'),
  ]

  const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { err += d.toString() })
  child.on('close', () => {
    // --dump-dom 会把 <pre> 的文本转义，先还原再取标记之间的内容
    const flat = out
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    const m = flat.match(/\[\[FC-BEGIN\]\]([\s\S]*?)\[\[FC-END\]\]/)
    if (!m) {
      console.log('FAIL  没拿到断言结果（页面没跑完 / 浏览器参数失效）')
      console.log('      tail(stderr): ' + err.trim().split('\n').slice(-4).join(' ⏎ '))
      console.log('      tail(stdout): ' + out.trim().slice(-300))
      console.log('RESULT 0 / 1')
      process.exit(1)
    }
    const body = m[1].split('\n').filter((l) => l.trim()).join('\n')
    console.log(body)
    const sum = m[1].match(/通过 (\d+) \/ 失败 (\d+)/)
    if (!sum) {
      console.log('FAIL  结果行缺失')
      process.exit(1)
    }
    console.log('\nRESULT ' + sum[1] + ' / ' + sum[2])
    try { fs.unlinkSync(harnessPath) } catch { /* 留一份也无妨 */ }
    process.exit(Number(sum[2]) === 0 ? 0 : 1)
  })

  setTimeout(() => {
    console.log('FAIL  无头浏览器超时（60s）')
    try { child.kill() } catch { /* ignore */ }
    process.exit(1)
  }, 60000)
}

main()
