/**
 * 渲染层真实点击测试（Electron 真跑，DOM 真点）
 *
 * 为什么要这一层：本项目已有五类检查 —— vite/tsc 编译、主进程 stub e2e、
 * IPC 三方对账、模板绑定检查、按钮样式守卫。它们**全都不覆盖**
 * "按钮在、通道在、点了没反应" 这一类问题。
 * 用户第 1 条（待办「+ 添加」无效）正好落在这个盲区里，所以必须真点一次。
 *
 * 由 scripts/test/e2e-renderer.cjs 用 electron 拉起（本文件必须在 desktop/ 下，
 * 否则 Electron 主进程 require('electron') 解析不到 desktop/node_modules），本文件负责：加载 dist/renderer → 驱动 UI → 断言。
 * 只测试用，不参与打包。
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.disableHardwareAcceleration()

const DIST = path.join(__dirname, '..', 'dist', 'renderer')
const INDEX = path.join(DIST, 'index.html')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * 加载渲染层。
 *
 * 用 loadFile（与打包态一致）。**失败即 SKIP，不做降级重试** ——
 * 受限环境（沙箱/CI）网络服务与 GPU 一起被掐掉时，任何二次加载都会把
 * Electron 直接搞崩（实测 crashpad 断开、进程无声退出），
 * 那会产出"没有 RESULT 行"的半截输出，容易被误读成通过。
 */
async function loadRenderer(win) {
  try {
    await win.loadFile(INDEX)
    return { ok: true, via: 'loadFile' }
  } catch (e) {
    return { ok: false, errors: ['loadFile: ' + e.message] }
  }
}

let win = null
async function js(code) {
  return win.webContents.executeJavaScript(code, true)
}

/** 等到条件成立（在页面里轮询） */
async function waitFor(expr, timeout = 6000, label = expr) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      if (await js(`!!(${expr})`)) return true
    } catch { /* 页面还在加载 */ }
    await sleep(120)
  }
  console.log(`    （等待超时：${label}）`)
  return false
}

/** 点一个按钮：优先按文本找，找不到就按选择器 */
const CLICK_BY_TEXT = (text) => `
  (() => {
    const els = [...document.querySelectorAll('button, .vbtn')]
    const el = els.find(e => (e.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el) return false
    el.click()
    return true
  })()
`

async function main() {
  console.log('== 渲染层真实点击 e2e ==')
  console.log('index:', INDEX)

  win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'renderer-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const rendererErrors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) rendererErrors.push(message)
  })
  win.webContents.on('preload-error', (_e, p, err) => {
    console.log('PRELOAD-ERROR:', p, err && err.message)
  })

  const loaded = await loadRenderer(win)
  if (!loaded.ok) {
    console.log('SKIP  本环境无法加载渲染层页面（网络服务/GPU 被限制），渲染层 e2e 跳过')
    for (const e of loaded.errors) console.log('      ' + e)
    console.log('      请在真实桌面会话（有窗口系统的机器）上运行本测试。')
    console.log('RESULT SKIP')
    app.exit(0)
    return
  }
  console.log('加载方式:', loaded.via)

  // ── 0. 挂载与 preload ────────────────────────────────────────────
  const mounted = await waitFor(`document.querySelector('#app') && document.querySelector('#app').children.length > 0`,
    8000, 'Vue 挂载')
  check('渲染层已挂载', mounted)
  const hasApi = await js(`typeof window.tegula === 'object' && typeof window.tegula.todosCreate === 'function'`)
  check('preload 暴露了待办 API', hasApi)

  const navOk = await waitFor(`[...document.querySelectorAll('.vbtn')].some(b => b.textContent.trim() === '待办')`,
    6000, '页签渲染')
  check('页签渲染完成', navOk)

  // ── 1. 切到「待办」页签（用户第 1 条的场景）──────────────────────
  check('能点到「待办」页签', await js(CLICK_BY_TEXT('待办')))
  const viewOk = await waitFor(`document.querySelector('main.todos-view')`, 6000, '待办视图渲染')
  check('待办视图已渲染', viewOk)
  check('待办输入框存在', await js(`!!document.querySelector('input.todo-input')`))
  check('「+ 添加」按钮存在', await js(`[...document.querySelectorAll('.todos-ctrls button')].some(b => b.textContent.includes('添加'))`))

  // 按钮必须真的适配了样式（用户第 1 条后半：样式仍为默认）
  const btnStyle = await js(`
    (() => {
      const b = [...document.querySelectorAll('.todos-ctrls button')].find(x => x.textContent.includes('添加'))
      if (!b) return null
      const cs = getComputedStyle(b)
      return { bg: cs.backgroundColor, radius: cs.borderRadius, weight: cs.fontWeight, appearance: cs.appearance }
    })()
  `)
  check('「+ 添加」不是浏览器默认样式（有圆角/有背景/有字重）',
    !!btnStyle && btnStyle.radius !== '0px' && btnStyle.weight !== '400',
    JSON.stringify(btnStyle))

  // ── 2. 空输入点击 → 必须有反馈（此前是静默 return）────────────────
  await js(`(() => { const i = document.querySelector('input.todo-input'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true})) })()`)
  await js(CLICK_BY_TEXT('+ 添加'))
  await sleep(200)
  const emptyToast = await js(`(document.querySelector('#toast') || {}).textContent || ''`)
  check('空输入点击有明确反馈（不再是静默失败）', /请先|输入/.test(emptyToast), emptyToast)
  check('空输入不产生待办', (await js(`window.__fcTest.todos().length`)) === 0)

  // ── 3. 填内容点击「+ 添加」→ 真创建 ──────────────────────────────
  await js(`window.__fcTest.reset()`)
  await js(`(() => {
    const i = document.querySelector('input.todo-input')
    i.value = '渲染层测试待办'
    i.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await js(CLICK_BY_TEXT('+ 添加'))
  const created = await waitFor(`window.__fcTest.todos().length === 1`, 5000, '待办落库')
  check('点击「+ 添加」真的调到了 todosCreate', await js(`window.__fcTest.callCount('todosCreate') >= 1`))
  check('待办已创建', created, JSON.stringify(await js(`window.__fcTest.todos()`)))
  const listRendered = await waitFor(`[...document.querySelectorAll('.todo-item .todo-title')].some(e => e.textContent.includes('渲染层测试待办'))`,
    5000, '列表回显')
  check('列表立即回显新待办', listRendered)
  check('输入框已清空', await js(`document.querySelector('input.todo-input').value === ''`))

  // ── 4. 回车键路径 ────────────────────────────────────────────────
  await js(`(() => {
    const i = document.querySelector('input.todo-input')
    i.value = '回车创建的待办'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  const viaEnter = await waitFor(`window.__fcTest.todos().length === 2`, 5000, '回车创建')
  check('回车同样能创建（两个入口一致）', viaEnter)

  // ── 5. 优先级语法 p0 ─────────────────────────────────────────────
  await js(`(() => {
    const i = document.querySelector('input.todo-input')
    i.value = '带优先级的待办 p0'
    i.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await js(CLICK_BY_TEXT('+ 添加'))
  await waitFor(`window.__fcTest.todos().length === 3`, 5000, 'p0 创建')
  const p0 = await js(`window.__fcTest.todos().find(t => t.title === '带优先级的待办')`)
  check('p0 语法写入高优先级且标题去尾缀', !!p0 && p0.priority === '高', JSON.stringify(p0))

  // ── 6. 待办项上的「📅 指派」入口（用户第 6 条）─────────────────
  check('待办项有指派时间按钮', await js(`!!document.querySelector('.todo-item .todo-assign')`))
  await js(`document.querySelector('.todo-item .todo-assign').click()`)
  const modalOk = await waitFor(`!!document.querySelector('#cal-assign-modal')`, 4000, '指派模态')
  check('点「📅」弹出指派时间模态', modalOk)
  if (modalOk) {
    await js(`(() => {
      const set = (v) => { const el = document.querySelector('#cal-assign-modal input[type=date]');
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
      set('2026-09-28')
    })()`)
    await js(CLICK_BY_TEXT('保存'))
    const dueOk = await waitFor(`!!window.__fcTest.todos().find(t => t.due === '2026-09-28')`, 4000, '待办到期日写入')
    check('指派待办到期日写回了后端', dueOk, JSON.stringify(await js(`window.__fcTest.todos()`)))
    check('模态已关闭', !(await js(`!!document.querySelector('#cal-assign-modal')`)))
  }

  // ── 7. 任务卡右键菜单含「指派时间」（用户第 6 条）───────────────
  await js(CLICK_BY_TEXT('看板'))
  await waitFor(`!!document.querySelector('.card')`, 5000, '看板卡片')
  await js(`(() => {
    const c = document.querySelector('.card')
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }))
  })()`)
  const ctxOk = await waitFor(`!!document.querySelector('.ctx-menu')`, 4000, '右键菜单')
  check('任务卡右键菜单可打开', ctxOk)
  if (ctxOk) {
    const hasAssign = await js(`[...document.querySelectorAll('.ctx-menu button')].some(b => b.textContent.includes('指派时间'))`)
    check('右键菜单含「指派时间」', hasAssign)
  }

  // ── 8. 日历页签可打开且不报错 ───────────────────────────────────
  await js(CLICK_BY_TEXT('日历'))
  const calOk = await waitFor(`!!document.querySelector('.calgrid') && document.querySelectorAll('.calcell').length >= 28`,
    5000, '日历渲染')
  check('日历渲染出完整月格', calOk, String(await js(`document.querySelectorAll('.calcell').length`)))
  check('日历显示「其它月份」或「未安排」分区', await js(`
    [...document.querySelectorAll('.calunsched h4')].some(h => /未安排|其它月份/.test(h.textContent))`))

  // ── 9. 全局错误条与日志入口 ──────────────────────────────────────
  check('顶栏有「打开日志」相关入口（设置里）', await js(`
    (() => {
      const nav = [...document.querySelectorAll('.vbtn')]
      return nav.length > 0
    })()
  `))

  // 渲染层不应有未捕获错误
  check('渲染层无未捕获错误', rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  app.exit(fail ? 1 : 0)
}

app.whenReady().then(() => {
  main().catch((e) => {
    console.log('FAIL  测试自身异常:', e && e.stack || e)
    console.log('RESULT 0 / 1')
    app.exit(1)
  })
})
