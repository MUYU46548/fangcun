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

  // ── 10. 看板分组：按项目（显示项目名）+ 折叠 ─────────────────────
  // 用户 2026-09-25：「看板里多了这么多东西…像没有尽头的单子」。
  // 这里真点真读：分组标题必须是**项目名**（不是 fangcun-base 这种内部 id）、
  // 未知 id 要回退成 id（不能空白）、无项目进「未归属」、点标题能折叠、分组不丢任务。
  const backToBoard = await js(`
    (() => {
      const b = [...document.querySelectorAll('nav#views .vbtn')].find(x => x.textContent.trim() === '看板')
      if (!b) return false
      b.click()
      return true
    })()`)
  check('能切回「看板」页签', backToBoard === true)
  await new Promise(r => setTimeout(r, 400))

  const projSel = await js(`
    (() => {
      const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'project'))
      if (!sel) return { err: '没找到分组下拉' }
      sel.value = 'project'
      sel.dispatchEvent(new Event('change'))
      return { ok: true }
    })()`)
  check('工具栏有「按项目」分组入口', projSel && projSel.ok === true, JSON.stringify(projSel))
  await new Promise(r => setTimeout(r, 400))

  const groups = await js(`
    (() => {
      const cols = [...document.querySelectorAll('#board .col')]
      return {
        labels: cols.map(c => c.querySelector('h3').innerText.trim().split('\\n')[0]),
        counts: cols.map(c => c.querySelector('.n') && c.querySelector('.n').textContent.trim()),
        cards: cols.map(c => c.querySelectorAll('.card').length),
        ids: cols.map(c => [...c.querySelectorAll('.card')].map(x => x.getAttribute('data-id') || '?')),
      }
    })()`)
  const allIds = groups.ids.flat().filter(x => x !== '?')
  check('分组标题解析成项目名（不是内部 id demo）', groups.labels.includes('演示项目'), JSON.stringify(groups.labels))
  check('查不到名字的项目回退显示 id（不留空白标题）', groups.labels.includes('ghost-proj'), JSON.stringify(groups.labels))
  check('没项目的任务进「未归属」', groups.labels.includes('未归属'), JSON.stringify(groups.labels))
  // 同一个 id 不能在板子上出现两次：勾「含归档」时若归档区有同 id 副本，此前会显示两遍。
  check('同一任务 id 不重复出现（含归档时也去重）',
    new Set(allIds).size === allIds.length, JSON.stringify({ ids: groups.ids }))
  check('分组标题里的数量与列内唯一任务数一致',
    groups.counts.every((n, i) => Number(n) === new Set(groups.ids[i]).size),
    JSON.stringify({ counts: groups.counts, ids: groups.ids }))

  // 折叠：**点完必须等 Vue 把 DOM 刷出来**再读（Vue 更新是异步微任务，同步读会读到旧 DOM —— 本测试自己先踩过一次）
  const foldBefore = await js(`
    (() => {
      const col = document.querySelector('#board .col')
      const chev = col.querySelector('h3 .chev')
      const cs = chev ? getComputedStyle(chev) : null
      return {
        collapsed: col.className.includes('collapsed-col'),
        visible: [...col.querySelectorAll('.card')].filter(c => c.offsetParent !== null).length,
        chevBorderLeft: cs && cs.borderLeftWidth, chevBorderTop: cs && cs.borderTopWidth,
      }
    })()`)
  await js(`(() => { document.querySelector('#board .col h3').click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  const foldAfter = await js(`
    (() => {
      const col = document.querySelector('#board .col')
      const chev = col.querySelector('h3 .chev')
      return {
        collapsed: col.className.includes('collapsed-col'),
        visible: [...col.querySelectorAll('.card')].filter(c => c.offsetParent !== null).length,
        chevTransform: chev ? getComputedStyle(chev).transform : null,
      }
    })()`)
  check('点分组标题会折叠该列', foldAfter.collapsed === true && foldBefore.collapsed === false,
    JSON.stringify({ before: foldBefore, after: foldAfter }))
  check('折叠后该列卡片全部隐藏', foldAfter.visible === 0 && foldBefore.visible > 0,
    JSON.stringify({ before: foldBefore, after: foldAfter }))
  check('折叠箭头是 CSS 画的三角（不是 ▸/▾ 字形 —— 那两个字体会缺字变空白）',
    parseFloat(foldBefore.chevBorderLeft) >= 4 && parseFloat(foldBefore.chevBorderTop) >= 3,
    JSON.stringify({ left: foldBefore.chevBorderLeft, top: foldBefore.chevBorderTop }))
  await js(`(() => { document.querySelector('#board .col h3').click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  const foldRestored = await js(`
    (() => {
      const col = document.querySelector('#board .col')
      return {
        collapsed: col.className.includes('collapsed-col'),
        visible: [...col.querySelectorAll('.card')].filter(c => c.offsetParent !== null).length,
      }
    })()`)
  check('再点一次能展开回来', foldRestored.collapsed === false && foldRestored.visible === foldBefore.visible,
    JSON.stringify({ before: foldBefore, restored: foldRestored }))

  await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '折叠全部'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  const allFold = await js(`
    (() => {
      const cols = [...document.querySelectorAll('#board .col')]
      return {
        collapsed: cols.filter(c => c.className.includes('collapsed-col')).length,
        total: cols.length,
        anyVisible: [...document.querySelectorAll('#board .card')].some(c => c.offsetParent !== null),
      }
    })()`)
  check('「折叠全部」把所有分组折叠起来', allFold.collapsed === allFold.total && allFold.total > 1, JSON.stringify(allFold))
  check('全折叠后没有卡片还露在外面', allFold.anyVisible === false, JSON.stringify(allFold))
  await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '展开'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  const afterExpand = await js(`([...document.querySelectorAll('#board .col')].filter(c => c.className.includes('collapsed-col')).length)`)
  check('「展开」能一次全还原', afterExpand === 0, String(afterExpand))

  // 还原默认视图，别把状态留给下一次
  await js(`
    (() => {
      const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'project'))
      if (sel) { sel.value = 'status'; sel.dispatchEvent(new Event('change')) }
      return true
    })()`)

  // ── 11. 多选：方框不能小到要「小心翼翼点」（用户 2026-09-25 第 2 条）────────
  const batchOn = await js(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('任务多选'))
      if (!b) return false
      b.click()
      return true
    })()`)
  check('有「任务多选」入口', batchOn === true)
  await new Promise(r => setTimeout(r, 300))
  const chkBox = await js(`
    (() => {
      const c = document.querySelector('#board .card .batch-chk')
      if (!c) return { err: '批量模式下卡片里没有复选框' }
      const cs = getComputedStyle(c)
      return { w: cs.width, h: cs.height, visible: c.offsetParent !== null || c.style.display !== 'none' }
    })()`)
  check('多选框放大到 ≥20×20（不再是 16px 的小方框）',
    parseFloat(chkBox.w) >= 20 && parseFloat(chkBox.h) >= 20, JSON.stringify(chkBox))

  // 点卡片本体（不瞄方框）也要能选中
  const clickCard = await js(`
    (() => {
      const before = document.querySelectorAll('#board .card.selected').length
      const card = document.querySelector('#board .card')
      card.click()
      return { before }
    })()`)
  await new Promise(r => setTimeout(r, 200))
  const afterCardClick = await js(`
    (() => ({
      selected: document.querySelectorAll('#board .card.selected').length,
      count: (document.querySelector('.batch-bar .batch-count') || {}).textContent || '',
    }))()`)
  check('批量模式下点卡片本体即可勾选（不必瞄小方框）',
    afterCardClick.selected === clickCard.before + 1, JSON.stringify({ before: clickCard.before, after: afterCardClick }))
  await js(`(() => { document.querySelector('#board .card').click(); return true })()`)
  await new Promise(r => setTimeout(r, 200))
  const afterUnclick = await js(`document.querySelectorAll('#board .card.selected').length`)
  check('再点一次取消勾选', afterUnclick === clickCard.before, String(afterUnclick))

  await js(`(() => { const b = [...document.querySelectorAll('.batch-bar button')].find(x => x.textContent.trim() === '全选'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  const selAll = await js(`
    (() => ({
      selected: document.querySelectorAll('#board .card.selected').length,
      cards: document.querySelectorAll('#board .card').length,
      count: (document.querySelector('.batch-bar .batch-count') || {}).textContent || '',
    }))()`)
  check('「全选」把当前视图内所有任务都勾上',
    selAll.selected === selAll.cards && selAll.cards > 0, JSON.stringify(selAll))
  check('已选数量与计数文案一致',
    selAll.count.includes(String(selAll.selected)), JSON.stringify(selAll.count))
  await js(`(() => { const b = [...document.querySelectorAll('.batch-bar button')].find(x => x.textContent.trim() === '取消全选'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  const selNone = await js(`document.querySelectorAll('#board .card.selected').length`)
  check('「取消全选」清空选择', selNone === 0, String(selNone))
  await js(`(() => { const b = [...document.querySelectorAll('.batch-bar button')].find(x => x.textContent.trim() === '取消'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  const batchOff = await js(`!document.querySelector('.batch-bar')`)
  check('「取消」退出多选模式', batchOff === true)

  // ── 12. 新建日志「卡一下」：全屏遮罩上的实时模糊会让失焦窗口不重绘（用户第 3 条）──
  await js(`
    (() => {
      const b = [...document.querySelectorAll('nav#views .vbtn')].find(x => x.textContent.trim() === '日志')
      if (b) b.click()
      return true
    })()`)
  await new Promise(r => setTimeout(r, 400))
  const logClick = await js(`
    (() => {
      const t0 = performance.now()
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '+ 新建日志')
      if (!b) return { err: '没找到「+ 新建日志」按钮' }
      b.click()
      return { ms: Math.round(performance.now() - t0) }
    })()`)
  await new Promise(r => setTimeout(r, 350))   // Vue 更新是异步的：必须等 DOM 刷出来再读
  const logOpen = await js(`
    (() => {
      const el = document.querySelector('#log-edit-overlay')
      const cs = el ? getComputedStyle(el) : null
      return {
        exists: !!el,
        // 注意：position:fixed 元素的 offsetParent 恒为 null，不能用它判可见性
        visible: el ? el.getBoundingClientRect().height > 0 : false,
        clickMs: ${JSON.stringify(logClick.ms)},
        backdrop: cs ? (cs.backdropFilter || cs.webkitBackdropFilter || 'none') : null,
        transform: cs ? cs.transform : null,
        title: el ? (el.querySelector('h3') || {}).textContent : null,
      }
    })()`)
  check('「新建日志」能打开编辑框', logOpen.exists === true && logOpen.visible === true, JSON.stringify(logOpen))
  check('点开编辑框的同步耗时不是卡顿（<300ms）',
    typeof logOpen.clickMs === 'number' && logOpen.clickMs < 300, String(logOpen.clickMs) + 'ms')
  check('全屏遮罩不再用实时模糊（失焦不重绘的元凶）',
    logOpen.backdrop === 'none', String(logOpen.backdrop))
  check('遮罩已提升为独立合成层（translateZ）',
    String(logOpen.transform) !== 'none' && String(logOpen.transform).startsWith('matrix'), String(logOpen.transform))
  await js(`(() => { const el = document.querySelector('#log-edit-overlay'); if (el) el.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  check('点遮罩能关掉编辑框', (await js(`!document.querySelector('#log-edit-overlay')`)) === true)

  // ── 13. 待办编辑（第 12 条：模态大框；第 14 条：勾选之后也要能改）──────────
  // 注意：不改夹具默认值（前面几节的断言假设待办为空）。这里走**真实用户路径**现造一条：
  // 输入框回车创建 → 勾选 → 它变成「已勾选」，正好是第 14 条的场景。
  await js(`(() => { const b = [...document.querySelectorAll('nav#views .vbtn')].find(x => x.textContent.trim() === '待办'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 400))
  const seeded = await js(`
    (() => {
      const inp = document.querySelector('.todo-input')
      if (!inp) return { err: '没找到待办输入框' }
      inp.value = '第14条_签下之后也要能编辑'
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return { typed: true }
    })()`)
  await new Promise(r => setTimeout(r, 500))
  // 勾上它（勾选 → 完成态）
  const toggled = await js(`
    (() => {
      const item = [...document.querySelectorAll('.todo-item')]
        .find(el => (el.textContent || '').includes('第14条_签下之后也要能编辑'))
      if (!item) return { err: '新建的待办没出现在列表里' }
      const chk = item.querySelector('.todo-chk')
      if (chk && !chk.checked) chk.click()
      return { found: true, wasChecked: !!(chk && chk.checked) }
    })()`)
  await new Promise(r => setTimeout(r, 500))
  const doneCount = await js(`
    (() => {
      const done = [...document.querySelectorAll('.todo-item')].filter(el => el.className.includes('done'))
      return { n: done.length, titles: done.map(el => (el.querySelector('.todo-title') || {}).textContent) }
    })()`)
  check('能造出「已勾选」的待办（第 14 条场景就位）', doneCount.n >= 1, JSON.stringify(seeded) + ' ' + JSON.stringify(toggled) + ' ' + JSON.stringify(doneCount))
  const opened = await js(`
    (() => {
      const item = [...document.querySelectorAll('.todo-item')]
        .find(el => el.className.includes('done') && (el.textContent || '').includes('第14条_签下之后也要能编辑'))
      if (!item) return { err: '没找到已勾选的那条待办' }
      const btn = item.querySelector('.todo-edit')
      if (!btn) return { err: '已勾选的待办上没有「改」按钮' }
      btn.click()
      return { clicked: true }
    })()`)
  await new Promise(r => setTimeout(r, 300))
  const todoOpen = await js(`
    (() => {
      const el = document.querySelector('#todo-edit-modal')
      if (!el) return { exists: false }
      const ta = el.querySelector('textarea')
      return {
        exists: true,
        width: Math.round(el.getBoundingClientRect().width),
        h3: (el.querySelector('h3') || {}).textContent,
        taH: ta ? Math.round(ta.getBoundingClientRect().height) : 0,
        doneHint: !!el.querySelector('.todo-edit-donehint'),
        value: ta ? ta.value : '',
      }
    })()`)
  check('点「改」能打开编辑弹窗（且是**已勾选**那条）—— 第 14 条', todoOpen.exists === true, JSON.stringify(opened) + ' ' + JSON.stringify(todoOpen))
  check('编辑弹窗是大框：内容区高度 ≥ 160px —— 第 12 条', todoOpen.taH >= 160, String(todoOpen.taH) + 'px')
  check('编辑弹窗宽度 ≥ 600px', todoOpen.width >= 600, String(todoOpen.width) + 'px')
  check('已完成的待办也有提示（证明改的就是已完成那条）', todoOpen.doneHint === true)
  check('弹窗带出原内容', String(todoOpen.value).includes('第14条'), String(todoOpen.value).slice(0, 24))
  await js(`
    (() => {
      const ta = document.querySelector('#todo-edit-modal textarea')
      ta.value = '改过的内容'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  await new Promise(r => setTimeout(r, 150))
  await js(`
    (() => {
      const b = [...document.querySelectorAll('#todo-edit-modal button')].find(x => x.textContent.trim() === '保存')
      if (b) b.click()
      return true
    })()`)
  await new Promise(r => setTimeout(r, 450))
  const saved = await js(`
    (() => {
      const ups = window.__fcTest.calls().filter(c => c.name === 'todosUpdate')
      return {
        n: ups.length,
        last: ups.length ? JSON.stringify(ups[ups.length - 1].args) : null,
        closed: !document.querySelector('#todo-edit-modal'),
      }
    })()`)
  check('保存真的调到了 todosUpdate（已完成也允许改）',
    saved.n >= 1 && /改过的内容/.test(String(saved.last)), JSON.stringify(saved))
  check('保存后弹窗自动关闭', saved.closed === true)

  // 第 12 条的另一半：**新建**也要能走大框（不只编辑）
  const createOpen = await js(`
    (() => {
      const b = [...document.querySelectorAll('.todo-new')][0]
      if (!b) return { err: '没找到「大框新建」按钮' }
      b.click()
      return { clicked: true }
    })()`)
  await new Promise(r => setTimeout(r, 300))
  const createModal = await js(`
    (() => {
      const el = document.querySelector('#todo-edit-modal')
      if (!el) return { exists: false }
      return { exists: true, h3: (el.querySelector('h3') || {}).textContent,
               taH: Math.round(el.querySelector('textarea').getBoundingClientRect().height),
               empty: !el.querySelector('textarea').value }
    })()`)
  check('「大框新建」打开的是新建态（标题为「新建待办」、内容为空）',
    createModal.exists === true && createModal.h3 === '新建待办' && createModal.empty === true,
    JSON.stringify(createOpen) + ' ' + JSON.stringify(createModal))
  await js(`
    (() => {
      const ta = document.querySelector('#todo-edit-modal textarea')
      ta.value = '大框新建的待办'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const b = [...document.querySelectorAll('#todo-edit-modal button')].find(x => x.textContent.trim() === '保存')
      return true
    })()`)
  await new Promise(r => setTimeout(r, 150))
  await js(`
    (() => {
      const b = [...document.querySelectorAll('#todo-edit-modal button')].find(x => x.textContent.trim() === '保存')
      if (b) b.click()
      return true
    })()`)
  await new Promise(r => setTimeout(r, 450))
  const createdViaModal = await js(`
    (() => {
      const cs = window.__fcTest.calls().filter(c => c.name === 'todosCreate')
      const list = window.__fcTest.todos().map(t => t.title)
      return { n: cs.length, last: cs.length ? JSON.stringify(cs[cs.length-1].args) : null, inList: list.includes('大框新建的待办') }
    })()`)
  check('大框新建真的调到了 todosCreate 且落到列表里',
    createdViaModal.n >= 1 && /大框新建的待办/.test(String(createdViaModal.last)) && createdViaModal.inList === true,
    JSON.stringify(createdViaModal))

  // 第 13 条：日志/任务编辑框也要够大（原先 .tall 在 #log-edit-modal 下从未生效）
  await js(`(() => { const b = [...document.querySelectorAll('nav#views .vbtn')].find(x => x.textContent.trim() === '日志'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 400))
  await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '+ 新建日志'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 400))
  const logSize = await js(`
    (() => {
      const el = document.querySelector('#log-edit-modal')
      if (!el) return { exists: false }
      const tas = [...el.querySelectorAll('textarea')]
      return {
        exists: true,
        width: Math.round(el.getBoundingClientRect().width),
        heights: tas.map(t => Math.round(t.getBoundingClientRect().height)),
        contentH: Math.max(0, ...tas.map(t => Math.round(t.getBoundingClientRect().height))),
      }
    })()`)
  check('日志编辑器宽度 ≥ 700px（原 560px）', logSize.exists === true && logSize.width >= 700,
    JSON.stringify(logSize))
  check('「执行内容」框 ≥ 280px 高（原是小框，.tall 从未生效）',
    logSize.exists === true && logSize.contentH >= 280, JSON.stringify(logSize.heightArr || logSize.heights))
  await js(`(() => { const el = document.querySelector('#log-edit-overlay'); if (el) el.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))

  // ── 14. 归档日志独立分区（第 16 条后半句：批量归档后仍占主视图）──────────
  await js(`(() => { const b = [...document.querySelectorAll('nav#views .vbtn')].find(x => x.textContent.trim() === '日志'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 400))
  const part = await js(`
    (() => {
      const sep = document.querySelector('.log-archive-sep')
      const cards = [...document.querySelectorAll('.log-card')]
      const arch = cards.find(c => (c.textContent || '').includes('归档的日志'))
      return {
        hasSep: !!sep,
        sepText: sep ? sep.textContent.trim() : null,
        total: cards.length,
        visibleCount: cards.filter(c => getComputedStyle(c).display !== 'none').length,
        archExists: !!arch,
        archVisible: arch ? getComputedStyle(arch).display !== 'none' : null,
        archIsLast: cards.length ? (cards[cards.length - 1].textContent || '').includes('归档的日志') : false,
        toggleText: (document.querySelector('.log-archive-toggle') || {}).textContent,
      }
    })()`)
  check('归档日志有独立分区头', part.hasSep === true, JSON.stringify(part))
  check('分区头写明归档条数', /已归档 1 条/.test(String(part.sepText || part.toggleText)), String(part.toggleText))
  check('默认收起：归档日志不占主视图', part.archExists === true && part.archVisible === false, JSON.stringify(part))
  check('主区只显示未归档的 2 条', part.visibleCount === 2, String(part.visibleCount))
  check('归档日志排在主区之后（不是混在中间）', part.archIsLast === true)
  await js(`(() => { const b = document.querySelector('.log-archive-toggle'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 300))
  const expanded = await js(`
    (() => {
      const arch = [...document.querySelectorAll('.log-card')].find(c => (c.textContent || '').includes('归档的日志'))
      const cards = [...document.querySelectorAll('.log-card')]
      return {
        visible: arch ? getComputedStyle(arch).display !== 'none' : null,
        visibleCount: cards.filter(c => getComputedStyle(c).display !== 'none').length,
        toggleText: (document.querySelector('.log-archive-toggle') || {}).textContent,
      }
    })()`)
  check('点分区头能展开归档日志', expanded.visible === true, JSON.stringify(expanded))
  check('展开后主区 + 归档区共 3 条可见', expanded.visibleCount === 3, String(expanded.visibleCount))
  await js(`(() => { const b = document.querySelector('.log-archive-toggle'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 300))
  const reCollapsed = await js(`
    (() => {
      const arch = [...document.querySelectorAll('.log-card')].find(c => (c.textContent || '').includes('归档的日志'))
      return { visible: arch ? getComputedStyle(arch).display !== 'none' : null }
    })()`)
  check('再点一次能收回去', reCollapsed.visible === false, JSON.stringify(reCollapsed))

  // ── 15. 导出备份（2026-09-26 用户第 1、2 条：一次点击、只落一个 zip）────────
  const gear = await js(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '⚙')
      if (!b) return { err: '没找到设置按钮' }
      b.click()
      return { clicked: true }
    })()`)
  await new Promise(r => setTimeout(r, 700))
  const bkExportUi = await js(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('导出备份'))
      return {
        hasSelect: !!document.querySelector('.bk-export-select'),
        btnText: btn ? btn.textContent.trim() : null,
      }
    })()`)
  check('★ 设置里**没有**「导出内容」下拉了（不再要人逐字核对文件名）',
    bkExportUi.hasSelect === false && gear.clicked === true,
    JSON.stringify(gear) + ' ' + JSON.stringify(bkExportUi))
  check('★ 换成一次点击的「📤 导出备份（一个 zip）」按钮',
    !!bkExportUi.btnText && bkExportUi.btnText.includes('一个 zip'), String(bkExportUi.btnText))
  await js(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('导出备份'))
      if (b) b.click()
      return true
    })()`)
  await new Promise(r => setTimeout(r, 500))
  const exportCall = await js(`
    (() => {
      const cs = window.__fcTest.calls().filter(c => c.name === 'backupExportTo')
      return { n: cs.length, last: cs.length ? JSON.stringify(cs[cs.length - 1].args) : null }
    })()`)
  check('★ 点一下就把**最新那份**备份路径直接交给主进程（不需要人选）',
    exportCall.n >= 1 && /fangcun-data-20260925-202020\.zip/.test(String(exportCall.last)), String(exportCall.last))
  check('★ 导出只传 package（不再带 includeTool 往外写 README/sidecar/恢复脚本）',
    exportCall.n >= 1 && !/includeTool/.test(String(exportCall.last)), String(exportCall.last))
  await js(`(() => { const el = document.querySelector('#soverlay'); if (el) el.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))

  // ── 16. 项目章程缺口（第 7 条：13 个登记项目里只有 1 个有方针卡）──────────
  await js(`(() => { const b = [...document.querySelectorAll('nav#views .vbtn')].find(x => x.textContent.trim() === '项目'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 700))
  const charter = await js(`
    (() => {
      const bar = document.querySelector('.charter-bar')
      const tiles = [...document.querySelectorAll('.tile')]
      const btns = [...document.querySelectorAll('.pv-policy')].map(b => b.textContent.trim())
      return {
        barText: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : null,
        hasFillBtn: !!bar && [...bar.querySelectorAll('button')].some(b => b.textContent.includes('补齐')),
        cardBtns: btns,
        tiles: tiles.length,
      }
    })()`)
  check('项目页有「项目章程」缺口条', !!charter.barText, JSON.stringify(charter))
  check('缺口条统计正确（已填 1 / 共 2，缺失 1）',
    /已填 1 \/ 2/.test(String(charter.barText)) && /缺失 1/.test(String(charter.barText)), String(charter.barText))
  check('有方针的项目卡片显示「查看/编辑」', charter.cardBtns.some(t => t.includes('查看/编辑')), JSON.stringify(charter.cardBtns))
  check('缺方针的项目卡片显示「立项目方针」', charter.cardBtns.some(t => t.includes('立项目方针')), JSON.stringify(charter.cardBtns))
  check('缺口条出现「补齐骨架」按钮', charter.hasFillBtn === true, JSON.stringify(charter))
  await js(`
    (() => {
      const bar = document.querySelector('.charter-bar')
      const b = bar && [...bar.querySelectorAll('button')].find(x => x.textContent.includes('补齐'))
      if (b) b.click()
      return true
    })()`)
  await new Promise(r => setTimeout(r, 700))
  const fillCall = await js(`
    (() => {
      const cs = window.__fcTest.calls().filter(c => c.name === 'policySave')
      return { n: cs.length, args: cs.map(c => JSON.stringify(c.args)) }
    })()`)
  check('「补齐骨架」只为缺失的项目建文件（demo2，不动已有的 demo）',
    fillCall.n === 1 && /demo2/.test(String(fillCall.args[0])) && !/policySave.*"demo"/.test(String(fillCall.args.join(' '))),
    JSON.stringify(fillCall))

  // ── 16. 回收站页签（2026-09-26 卡 034：数据一直在 .trash，缺的只是界面入口）──
  //     真点：页签 → 列表 → 「还原」→ 「彻底删除」，并核对传出去的参数是**文件名**。
  const trashNavOk = await waitFor(`[...document.querySelectorAll('.vbtn')].some(b => b.textContent.trim() === '回收站')`, 4000, '回收站页签出现')
  check('★ 有「回收站」页签', trashNavOk)
  check('★ 能点到「回收站」页签', await js(CLICK_BY_TEXT('回收站')))
  const trashViewOk = await waitFor(`document.querySelector('main.trash-view')`, 6000, '回收站视图渲染')
  check('★ 回收站视图已渲染（不是白屏/占位）', trashViewOk)
  check('列表渲染出回收站条目（数据源 = trashList）',
    await js(`document.querySelectorAll('.trash-item').length === 2`),
    String(await js(`document.querySelectorAll('.trash-item').length`)))
  check('条目显示标题（不是只有文件名）',
    await js(`[...document.querySelectorAll('.trash-title')].some(e => e.textContent.includes('被删掉的演示任务'))`))
  check('条目显示文件名（操作句柄的另一半）',
    await js(`[...document.querySelectorAll('.trash-name')].some(e => e.textContent.includes('task-demo-902.2.md'))`))
  check('每条都有「还原」和「彻底删除」按钮',
    await js(`document.querySelectorAll('.trash-item').length === 2 &&
              [...document.querySelectorAll('.trash-item')].every(it => it.querySelectorAll('.trash-btn').length === 2)`))
  check('回收站视图不加载任务列表 → 顶栏计数显示「—」（不是冒充条数）',
    await js(`(document.querySelector('#count') || {}).textContent.trim() === '—'`),
    String(await js(`((document.querySelector('#count') || {}).textContent || '').trim()`)))

  // 16a. 点「还原」
  await js(`(() => { const b = document.querySelector('.trash-item .trash-btn'); if (b) b.click(); return true })()`)
  const restoreCalled = await waitFor(`window.__fcTest.callCount('trashRestore') >= 1`, 5000, 'trashRestore 被调用')
  check('★ 点「还原」真的调到了 trashRestore（不是死按钮）', restoreCalled)
  check('★ 传的是文件名而不是 id',
    await js(`window.__fcTest.calls().filter(c => c.name === 'trashRestore').map(c => JSON.stringify(c.args)).join('|') === '["task-demo-901.md"]'`),
    String(await js(`window.__fcTest.calls().filter(c => c.name === 'trashRestore').map(c => JSON.stringify(c.args)).join('|')`)))
  check('还原成功后该条从列表消失（重新拉了一次列表）',
    await waitFor(`document.querySelectorAll('.trash-item').length === 1`, 5000, '列表刷新'))

  // 16b. 点「彻底删除」（渲染层有 confirm 二次确认 —— 测试里直接放行）
  // ⚠ 表达式必须返回可序列化的值：`window.confirm = () => true` 的求值结果是**函数**，
  //    经 URL 协议回传会抛 "An object could not be cloned"（e2e-bridge-clone 记过这一类）。
  await js(`(() => { window.confirm = () => true; return true })()`)
  await js(`(() => {
    const bs = [...document.querySelectorAll('.trash-item .trash-btn')].filter(b => b.textContent.includes('彻底删除'))
    if (bs[0]) bs[0].click()
    return !!bs[0]
  })()`)
  const purgeCalled = await waitFor(`window.__fcTest.callCount('trashPurge') >= 1`, 5000, 'trashPurge 被调用')
  check('★ 点「彻底删除」真的调到了 trashPurge', purgeCalled)
  check('★ 彻底删除传的也是文件名',
    await js(`window.__fcTest.calls().filter(c => c.name === 'trashPurge').map(c => JSON.stringify(c.args)).join('|') === '["task-demo-902.2.md"]'`),
    String(await js(`window.__fcTest.calls().filter(c => c.name === 'trashPurge').map(c => JSON.stringify(c.args)).join('|')`)))
  check('★ 删空后显示空态（不是空白页）',
    await waitFor(`!!document.querySelector('main.trash-view .empty-state')`, 5000, '空回收站空态'),
    String(await js(`!!document.querySelector('main.trash-view .empty-state')`)))
  check('背地里的数据真的清了（假后端 store 里 0 条）',
    await js(`window.__fcTest.trash().length === 0`))

  // ── 17. 技能安装专区（2026-09-26 卡 038：功能在、界面不在）──────────────
  //     真点：页签 → 卡片 → 复制提示词 / 复制全文 / 装到 Hermes / 打开目录
  const skillsNavOk = await waitFor(`[...document.querySelectorAll('.vbtn')].some(b => b.textContent.trim() === '技能')`, 4000, '技能页签出现')
  check('★ 有「技能」页签（此前完全没有入口，所以"毫无存在感"）', skillsNavOk)
  check('★ 能点到「技能」页签', await js(CLICK_BY_TEXT('技能')))
  const skillsViewOk = await waitFor(`document.querySelector('main.skills-view')`, 6000, '技能视图渲染')
  check('★ 技能安装专区已渲染（不是白屏/占位）', skillsViewOk)
  check('技能卡片按真源条数渲染（只数自发布的那类，外部导入的另算）',
    await js(`document.querySelectorAll('.skill-card:not(.imported)').length === 2`),
    String(await js(`document.querySelectorAll('.skill-card').length`)))
  check('卡片显示技能 ID',
    await js(`[...document.querySelectorAll('.skill-id')].some(e => e.textContent.includes('fangcun-hermes-bridge'))`))
  check('卡片显示绝对路径（手抄不出来的那一半）',
    await js(`[...document.querySelectorAll('.skill-path')].some(e => e.textContent.includes('C:/mock/skills/fangcun-hermes-bridge/SKILL.md'))`))
  check('★ 已装 / 未装两种状态文案都对',
    await js(`[...document.querySelectorAll('.skill-state')].some(e => e.textContent.includes('已装（最新）')) &&
              [...document.querySelectorAll('.skill-state')].some(e => e.textContent.includes('未装到 Hermes'))`),
    String(await js(`[...document.querySelectorAll('.skill-state')].map(e => e.textContent).join('|')`)))

  // 17a. 复制安装提示词（核心诉求：让 agent 自己装、杜绝手抄）
  await js(`(() => { const b = [...document.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('复制安装提示词')); if (b) b.click(); return !!b })()`)
  const promptCopied = await waitFor(`window.__fcTest.callCount('clipboardWriteText') >= 1`, 5000, '复制走到 clipboardWriteText')
  check('★ 点「复制安装提示词」真的走到剪贴板通道（不是死按钮）', promptCopied)
  check('★ 复制的内容里带绝对路径（杜绝手抄出错）',
    await js(`window.__fcTest.calls().filter(c => c.name === 'clipboardWriteText').map(c => JSON.stringify(c.args)).join('|').includes('C:/mock/skills/fangcun-hermes-bridge/SKILL.md')`),
    String(await js(`window.__fcTest.calls().filter(c => c.name === 'clipboardWriteText').map(c => JSON.stringify(c.args)).join('|').slice(0, 120)`)))

  // 17b. 复制 SKILL.md 全文
  await js(`(() => { const b = [...document.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('复制 SKILL.md 全文')); if (b) b.click(); return !!b })()`)
  check('★ 点「复制 SKILL.md 全文」把正文复制出去',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'clipboardWriteText' && JSON.stringify(c.args).includes('正文甲'))`, 5000, '全文复制'),
    String(await js(`window.__fcTest.callCount('clipboardWriteText')`)))

  // 17c. 一键装到 Hermes
  await js(`(() => { const b = [...document.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('装到 Hermes')); if (b) b.click(); return !!b })()`)
  check('★ 点「⚡ 装到 Hermes」真的调到了 skillsInstall（这条通道早就存在，此前没人能点）',
    await waitFor(`window.__fcTest.callCount('skillsInstall') >= 1`, 5000, 'skillsInstall'))

  // 17d. 打开目录（两个都点，参数必须分得开）
  await js(`(() => { const b = [...document.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('📂 技能目录')); if (b) b.click(); return !!b })()`)
  await js(`(() => { const b = [...document.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('Hermes 目录')); if (b) b.click(); return !!b })()`)
  const dirCalls = await waitFor(`window.__fcTest.callCount('skillsOpenDir') >= 2`, 5000, 'skillsOpenDir 两次')
  check('★ 「技能目录 / Hermes 目录」两个按钮分别传出 resources / hermes',
    dirCalls && await js(`window.__fcTest.calls().filter(c => c.name === 'skillsOpenDir').map(c => JSON.stringify(c.args)).join('|') === '["resources"]|["hermes"]'`),
    String(await js(`window.__fcTest.calls().filter(c => c.name === 'skillsOpenDir').map(c => JSON.stringify(c.args)).join('|')`)))
  check('「装到别的 agent」区在界面上',
    await js(`!!document.querySelector('main.skills-view .skills-agents') &&
              !!document.querySelector('main.skills-view .skills-agents-title')`))

  // ── 17e. 技能直接导入（2026-09-26 卡 005，用户参照 WorkBuddy 的导入面板）──
  //     钉住四件事：入口点得通、拖拽能投放、**重名必须问一句才覆盖**、移除只删导入的
  check('★ 有「📥 导入技能…」「📁 导入文件夹…」两个入口（Windows 上选文件/选目录不能同一个框）',
    await js(`[...document.querySelectorAll('.skills-btn')].some(b => b.textContent.includes('导入技能')) &&
              [...document.querySelectorAll('.skills-btn')].some(b => b.textContent.includes('导入文件夹'))`))

  check('★ 已导入的外部技能单独成列（不和自发布技能混着数）',
    await js(`document.querySelectorAll('.skill-card.imported').length === 1`),
    String(await js(`document.querySelectorAll('.skill-card.imported').length`)))
  check('★ 外部卡片带「外部导入」徽章', await js(`!!document.querySelector('.skill-card.imported .skill-badge')`))
  check('外部卡片显示 name / description / 落位目录',
    await js(`(() => { const c = document.querySelector('.skill-card.imported'); if (!c) return false;
      const t = c.textContent;
      return t.includes('external-demo') && t.includes('外部丢进来的示例技能') && t.includes('C:/mock/hermes/skills/external-demo') })()`))

  // 17e-1. 点「导入技能…」→ 选包 → 导入
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const b = [...document.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('导入技能')); if (b) b.click(); return !!b })()`)
  check('★ 点「导入技能…」真的调起选包（不是死按钮）',
    await waitFor(`window.__fcTest.callCount('skillsImportPick') >= 1`, 5000, 'skillsImportPick'))
  check('  选的是文件（kind=file）',
    await js(`window.__fcTest.calls().some(c => c.name === 'skillsImportPick' && JSON.stringify(c.args) === '["file"]')`))
  check('★ 选完就导入，且默认 overwrite=false（不偷偷覆盖）',
    await waitFor(`window.__fcTest.callCount('skillsImport') >= 1`, 5000, 'skillsImport'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'skillsImport'))`)))
  check('  导入带的是用户选中的路径',
    await js(`window.__fcTest.calls().some(c => c.name === 'skillsImport' && JSON.stringify(c.args).includes('C:/fake/incoming-skill.zip'))`),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'skillsImport'))`)))
  check('★ 导入成功后列表里多出这条技能（界面真的刷新了）',
    await waitFor(`document.querySelectorAll('.skill-card.imported').length === 2`, 5000, '导入后刷新'),
    String(await js(`document.querySelectorAll('.skill-card.imported').length`)))

  // 17e-2. 拖拽投放：dragover 出遮罩 → drop 读路径导入
  // ⚠ 分三步发事件：Vue 的 DOM 更新是异步的（nextTick），
  //   在同一次 js() 里"派发事件 → 立刻查 DOM"必然查不到遮罩（本测试第一版就栽在这）。
  await js(`(() => {
    const main = document.querySelector('main.skills-view'); if (!main) return false
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    over.dataTransfer = { files: [{ path: 'D:/dropped/some-skill.zip' }], dropEffect: '' }
    window.__fcDragDT = over.dataTransfer
    main.dispatchEvent(over)
    return true
  })()`)
  check('★ 拖入文件时出现投放遮罩（拖拽这条路要看得见）',
    await waitFor(`!!document.querySelector('.skills-dropmask')`, 3000, '拖拽遮罩'),
    await js(`document.querySelector('.skills-dropmask') ? 'yes' : 'no-mask'`))
  await js(`(() => {
    const main = document.querySelector('main.skills-view'); if (!main) return false
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    drop.dataTransfer = window.__fcDragDT
    main.dispatchEvent(drop)
    return true
  })()`)
  await sleep(120)
  check('★ 松手真的导入 —— 读的是 DataTransfer 里的路径（不是靠文件名猜）',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'skillsImport' && JSON.stringify(c.args).includes('D:/dropped/some-skill.zip'))`, 5000, 'drop 导入'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'skillsImport'))`)))
  check('  松手后遮罩消失', await js(`!document.querySelector('.skills-dropmask')`))

  // 17e-3. 重名：必须问一句才覆盖（取消 = 不覆盖；确定 = 带 overwrite 再来一次）
  await js(`window.__fcTest.reset()`)
  await js(`window.__fcTest.setImport('incoming-skill', { exists: true, pickPath: 'D:/dropped/dup.zip' })`)
  await js(`(() => { window.confirm = () => false; return true })()`)
  await js(`(() => { const b = [...document.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('导入技能')); if (b) b.click(); return !!b })()`)
  await waitFor(`window.__fcTest.callCount('skillsImport') >= 1`, 5000, '重名第一次调用')
  await sleep(250)
  check('★ 重名 + 用户取消 → 绝不覆盖（没有带 overwrite=true 的第二次调用）',
    await js(`!window.__fcTest.calls().some(c => c.name === 'skillsImport' && c.args[1] === true)`),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'skillsImport'))`)))

  await js(`window.__fcTest.reset()`)
  await js(`(() => { window.confirm = () => true; return true })()`)
  await js(`(() => { const b = [...document.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('导入技能')); if (b) b.click(); return !!b })()`)
  check('★ 重名 + 用户确认 → 第二次带上 overwrite=true',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'skillsImport' && c.args[1] === true)`, 5000, 'overwrite 重试'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'skillsImport'))`)))

  // 17e-4. 移除：只删带导入标记的那条
  await js(`window.__fcTest.reset()`)
  await js(`(() => { window.confirm = () => true; return true })()`)
  await js(`(() => { const c = document.querySelector('.skill-card.imported');
    const b = c && [...c.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('移除'));
    if (b) b.click(); return !!b })()`)
  check('★ 点「🗑 移除」走到 skillsRemove',
    await waitFor(`window.__fcTest.callCount('skillsRemove') >= 1`, 5000, 'skillsRemove'))
  check('  传的是技能 name（不是猜的 id/目录）',
    await js(`window.__fcTest.calls().some(c => c.name === 'skillsRemove' && c.args[0] === 'external-demo')`),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'skillsRemove'))`)))
  check('  移除后卡片从列表消失（界面真的刷新了）',
    await waitFor(`!([...document.querySelectorAll('.skill-card.imported .skill-id')].some(e => e.textContent.includes('external-demo')))`, 5000, '移除后刷新'))
  await js(`window.__fcTest.setImport('incoming-skill', { exists: false })`)

  // ── 19. 服务 / 端口（2026-09-26 卡 006：A 档 = 只读监控 + 冲突预警）──────
  //     用户口径：「之前想让方寸管理端口，事实上端口从未被管理」→ 现在能看、能登记；
  //     但**明确不要**"结束占用进程"，所以下面专门有一条断言钉住"没有杀进程的按钮"。
  check('★ 有「服务」页签', await js(`[...document.querySelectorAll('.vbtn')].some(b => b.textContent.trim() === '服务')`))
  check('★ 能点到「服务」页签', await js(CLICK_BY_TEXT('服务')))
  check('★ 服务页已渲染（不是白屏/占位）', await waitFor(`document.querySelector('main.services-view')`, 6000, '服务视图'))
  check('★ 切过去就真去拉了服务状态', await waitFor(`window.__fcTest.callCount('servicesList') >= 1`, 5000, 'servicesList'))
  // ⚠ 选 `.svc-item:not(.small)` —— 「未登记但正在监听」那一段也用 .svc-item（small），
  //   不排除就会把两类算在一起（本测试第一版就数成了 3）
  check('登记的服务按条数渲染（2 条）',
    await waitFor(`document.querySelectorAll('main.services-view .svc-item:not(.small)').length === 2`, 5000, '服务条目'),
    String(await js(`document.querySelectorAll('main.services-view .svc-item:not(.small)').length`)))
  check('★ 监听中 / 空闲 两种状态都显示出来',
    await js(`(() => { const t = document.querySelector('main.services-view').textContent;
      return t.includes('监听中') && t.includes('空闲') })()`))
  check('★ 监听中的行显示占用者 PID 与进程名（"谁占着"是这页的核心信息）',
    await js(`(() => { const t = document.querySelector('main.services-view').textContent;
      return t.includes('PID 1234') && t.includes('python') })()`),
    String(await js(`document.querySelector('main.services-view').textContent.slice(0, 200)`)))
  check('空闲的行说明"没有进程在监听"',
    await js(`document.querySelector('main.services-view').textContent.includes('没有进程在监听')`))
  check('来源分开标注（手填 / 启动台）',
    await js(`(() => { const t = document.querySelector('main.services-view').textContent;
      return t.includes('手填') && t.includes('启动台') })()`))
  check('★★ 没有任何"结束/杀掉占用进程"的按钮（用户选的是只读 A 档，不许偷偷加）',
    await js(`![...document.querySelectorAll('main.services-view button')].some(b => /结束|杀掉|杀进程|停止进程|kill/i.test(b.textContent))`),
    String(await js(`JSON.stringify([...document.querySelectorAll('main.services-view button')].map(b => b.textContent))`)))

  // 19a. 打开地址：监听的能点，空闲的是禁用
  await js(`window.__fcTest.reset()`)
  check('★ 空闲服务的「打开地址」是禁用的（点了必然报错，不能让人白点）',
    await js(`(() => { const rows = [...document.querySelectorAll('main.services-view .svc-item')];
      const idle = rows.find(r => r.textContent.includes('空闲'));
      const b = idle && [...idle.querySelectorAll('button')].find(x => x.textContent.includes('打开地址'));
      return !!b && b.disabled === true })()`))
  await js(`(() => { const rows = [...document.querySelectorAll('main.services-view .svc-item')];
    const on = rows.find(r => r.textContent.includes('监听中'));
    const b = on && [...on.querySelectorAll('button')].find(x => x.textContent.includes('打开地址'));
    if (b) b.click(); return !!b })()`)
  check('★ 点「打开地址」→ servicesOpen 带上那个端口',
    await waitFor(`window.__fcTest.callCount('servicesOpen') >= 1`, 5000, 'servicesOpen'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'servicesOpen'))`)))
  check('  传的是端口号（不是 id / 名字）',
    await js(`window.__fcTest.calls().some(c => c.name === 'servicesOpen' && c.args[0] === 8753)`))

  // 19b. 登记端口：填表 → 调 servicesAdd
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const i = document.querySelector('main.services-view input.svc-input'); return !!i })()`)
  check('★ 空服务名时拒绝登记（不许把空条目写进清单）',
    await (async () => {
      await js(`(() => { const i = document.querySelector('main.services-view input.svc-input'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true}));
        const p = document.querySelector('main.services-view input.svc-port-input'); p.value = '9001'; p.dispatchEvent(new Event('input', {bubbles:true})) })()`)
      await js(`(() => { const b = [...document.querySelectorAll('main.services-view button')].find(x => x.textContent.includes('登记端口')); if (b) b.click(); return !!b })()`)
      await sleep(200)
      return await js(`window.__fcTest.callCount('servicesAdd') === 0`)
    })())
  await js(`(() => { const i = document.querySelector('main.services-view input.svc-input'); i.value = '新登记的端口'; i.dispatchEvent(new Event('input', {bubbles:true}));
    const p = document.querySelector('main.services-view input.svc-port-input'); p.value = '9001'; p.dispatchEvent(new Event('input', {bubbles:true})) })()`)
  await js(`(() => { const b = [...document.querySelectorAll('main.services-view button')].find(x => x.textContent.includes('登记端口')); if (b) b.click(); return !!b })()`)
  check('★ 填好名字+端口后点登记 → servicesAdd 收到 {name, port}',
    await waitFor(`window.__fcTest.callCount('servicesAdd') >= 1`, 5000, 'servicesAdd'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'servicesAdd'))`)))
  check('  端口以数字传（不是字符串，主进程那边要按整数校验）',
    await js(`window.__fcTest.calls().some(c => c.name === 'servicesAdd' && typeof c.args[0].port === 'number' && c.args[0].port === 9001)`))
  check('★ 登记成功后列表里多出这条（界面真的刷新了）',
    await waitFor(`document.querySelectorAll('main.services-view .svc-item:not(.small)').length === 3`, 5000, '登记后刷新'),
    String(await js(`document.querySelectorAll('main.services-view .svc-item:not(.small)').length`)))

  // 19c. 未登记但正在监听 → 一键登记进来
  await js(`window.__fcTest.reset()`)
  check('★ 「未登记但正在监听」区块有内容（把"乱七八糟的端口"摆出来，能管就登记）',
    await js(`document.querySelector('main.services-view .services-unreg') &&
              document.querySelector('main.services-view .services-unreg').textContent.includes('8090')`),
    String(await js(`(document.querySelector('main.services-view .services-unreg') || {}).textContent || ''`)))
  check('★ 提示里写清"已略过多少不像是服务的端口"（不做全盘扫描，但也不偷偷藏）',
    await js(`document.querySelector('main.services-view .services-unreg').textContent.includes('12')`),
    String(await js(`document.querySelector('main.services-view .services-unreg').textContent.slice(0, 160)`)))
  await js(`(() => { const box = document.querySelector('main.services-view .services-unreg');
    const b = box && [...box.querySelectorAll('button')].find(x => x.textContent.includes('登记'));
    if (b) b.click(); return !!b })()`)
  check('★ 点「＋ 登记」→ servicesAdopt(port, 进程名)',
    await waitFor(`window.__fcTest.callCount('servicesAdopt') >= 1`, 5000, 'servicesAdopt'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'servicesAdopt'))`)))
  check('  带端口号 + 进程名（名字不用用户手打）',
    await js(`window.__fcTest.calls().some(c => c.name === 'servicesAdopt' && c.args[0] === 8090 && c.args[1] === 'node')`))

  // 19d. 取消登记（只删手填的那条）
  await js(`window.__fcTest.reset()`)
  await js(`(() => { window.confirm = () => true; return true })()`)
  await js(`(() => { const rows = [...document.querySelectorAll('main.services-view .svc-item')];
    for (const r of rows) {
      const b = [...r.querySelectorAll('button')].find(x => x.textContent.includes('取消登记'));
      if (b) { b.click(); return true }
    }
    return false })()`)
  check('★ 手填的那条能「取消登记」→ servicesRemove',
    await waitFor(`window.__fcTest.callCount('servicesRemove') >= 1`, 5000, 'servicesRemove'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'servicesRemove'))`)))
  check('  启动台登记的那条**没有**取消登记按钮（要改 apps.json）',
    await js(`(() => { const rows = [...document.querySelectorAll('main.services-view .svc-item')];
      const l = rows.find(r => r.textContent.includes('启动台'));
      return !!l && ![...l.querySelectorAll('button')].some(x => x.textContent.includes('取消登记')) })()`))

  // ── 18. 待办专项整修（2026-09-26 卡 033）────────────────────────────
  //     本轮先盘问题清单再修，这里钉住"看得见"的那几条：
  //     统计行 / 三档优先级徽章 / 逾期标注 / 项目筛选精确匹配（旧行为是漏筛）/
  //     空态区分"被筛掉" / 一键清除筛选 / Esc 关弹窗。
  check('切回待办页签', await js(CLICK_BY_TEXT('待办')))
  await waitFor(`document.querySelector('main.todos-view')`, 5000, '待办视图')

  // 18a. 统计行
  check('★ 顶部有统计行（共 N 条 · 未完成 M · 已完成 K）',
    await js(`!!document.querySelector('.todos-stats') &&
              document.querySelector('.todos-stats').textContent.includes('共') &&
              document.querySelector('.todos-stats').textContent.includes('条') &&
              document.querySelector('.todos-stats').textContent.includes('未完成')`),
    String(await js(`((document.querySelector('.todos-stats')||{}).textContent||'').trim()`)))

  // 18b. 三档优先级徽章（原来只有"高"有徽章，中/低看不出来）
  for (const [suffix, label] of [['p0', '高'], ['p1', '中'], ['p2', '低']]) {
    await js(`(() => {
      const i = document.querySelector('input.todo-input')
      i.value = '优先级徽章 ${label} ${suffix}'
      i.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await js(CLICK_BY_TEXT('+ 添加'))
    await sleep(200)
  }
  check('★ 三档优先级都有徽章（高/中/低）',
    await js(`!!document.querySelector('.todo-prio.prio-high') &&
              !!document.querySelector('.todo-prio.prio-mid') &&
              !!document.querySelector('.todo-prio.prio-low')`),
    String(await js(`[...document.querySelectorAll('.todo-prio')].map(e => e.className + ':' + e.textContent.trim()).join(' | ')`)))
  check('徽章显示中文 高/中/低（不是内部英文值）',
    await js(`[...document.querySelectorAll('.todo-prio')].some(e => e.textContent.trim() === '低')`))

  // 18c. 逾期标注：造一条 2020 年到期的未完成待办
  await js(CLICK_BY_TEXT('大框新建'))
  check('★ 「大框新建」打开弹窗', await waitFor(`!!document.querySelector('#todo-edit-modal')`, 4000, '新建弹窗'))
  await js(`(() => {
    const m = document.querySelector('#todo-edit-modal')
    const ta = m.querySelector('textarea')
    ta.value = '逾期待办（2020 到期）'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    const d = m.querySelector('input[type=date]')
    d.value = '2020-01-01'
    d.dispatchEvent(new Event('input', { bubbles: true }))
    const sel = [...m.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'demo'))
    if (sel) { sel.value = 'demo'; sel.dispatchEvent(new Event('change', { bubbles: true })) }
    return true
  })()`)
  await js(CLICK_BY_TEXT('保存'))
  const overdueShown = await waitFor(`!!document.querySelector('.todo-due.overdue')`, 5000, '逾期标注出现')
  check('★ 过期未完成标红为「逾期 N 天」（此前同一行小灰字，看不出过期）', overdueShown)
  check('逾期天数算出来了',
    await js(`(((document.querySelector('.todo-due.overdue')||{}).textContent)||'').includes('逾期')`),
    String(await js(`(((document.querySelector('.todo-due.overdue')||{}).textContent)||'').trim()`)))
  check('★ 统计行出现「逾期」计数',
    await js(`(((document.querySelector('.todos-stats')||{}).textContent)||'').includes('逾期')`),
    String(await js(`(((document.querySelector('.todos-stats')||{}).textContent)||'').trim()`)))

  // 18d. 项目筛选必须精确匹配（旧实现 `!t.project || t.project === X` 是漏筛）
  const setTodoFilter = (val) => `(() => {
    const s = [...document.querySelectorAll('.todos-ctrls select.todo-filter')]
      .find(x => [...x.options].some(o => o.value === ${JSON.stringify(val)}))
    if (!s) return false
    s.value = ${JSON.stringify(val)}
    s.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`
  check('把项目筛选切到 demo', await js(setTodoFilter('demo')))
  await sleep(300)
  check('★ 选中项目后只显示归属该项目的（不归属的不再混进来）',
    await js(`document.querySelectorAll('.todo-item').length > 0 &&
              [...document.querySelectorAll('.todo-item')].every(it => !!it.querySelector('.todo-project'))`),
    String(await js(`[...document.querySelectorAll('.todo-item')].map(it => (it.querySelector('.todo-project')||{textContent:''}).textContent + '|' + (it.querySelector('.todo-title')||{textContent:''}).textContent).join(' ; ')`)))
  check('切到「不归属任何项目」只剩没有项目徽章的',
    await js(setTodoFilter('__none__')) &&
    await js(`[...document.querySelectorAll('.todo-item')].every(it => !it.querySelector('.todo-project'))`))
  check('★ 不归属筛选下创建不会把哨兵值写成项目 id（脏数据防线）',
    await js(`!window.__fcTest.todos().some(t => t.project === '__none__' || t.project === '__all__')`),
    JSON.stringify(await js(`window.__fcTest.todos().map(t => t.project)`)))

  // 18e. 空态：切到一个没有待办的项目（demo2）
  check('切到没有待办的项目 demo2', await js(setTodoFilter('demo2')))
  await sleep(300)
  check('★ 空态区分「被筛掉」而不是「暂无待办」',
    await js(`!!document.querySelector('main.todos-view .empty-state') &&
              document.querySelector('main.todos-view .empty-text').textContent.includes('没有符合当前筛选')`),
    String(await js(`((document.querySelector('main.todos-view .empty-text')||{}).textContent||'').trim()`)))
  check('统计行说明遮住多少条 + 提供一键清除筛选',
    await js(`(((document.querySelector('.todos-stats')||{}).textContent)||'').includes('当前筛选遮住') &&
              !!document.querySelector('.todos-clear')`))
  await js(`(() => { const b = document.querySelector('.todos-clear'); if (b) b.click(); return !!b })()`)
  await sleep(300)
  check('★ 点「清除筛选」恢复完整列表（不再空态）',
    await js(`document.querySelectorAll('.todo-item').length > 0 &&
              !document.querySelector('main.todos-view .empty-state')`),
    String(await js(`document.querySelectorAll('.todo-item').length`)))

  // 18f. Esc 关弹窗（此前 Esc 只关通知面板，任何弹窗都关不掉）
  await js(CLICK_BY_TEXT('大框新建'))
  await waitFor(`!!document.querySelector('#todo-edit-modal')`, 4000, '弹窗再开')
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  check('★ Esc 能关掉待办弹窗',
    await waitFor(`!document.querySelector('#todo-edit-modal')`, 4000, '弹窗关闭'))

  // 渲染层不应有未捕获错误
  // ── 20. 回收站卡片不再是死卡（2026-09-26 用户回执第 1 条）─────────────
  //   原话：「回收站依然每个卡片都是不能点的死卡，确认这是设计意图？我可没想要这个。」
  //   实测：卡片本体确实没有任何 click —— 只有两个按钮能点。现在点卡片任意位置读正文预览。
  await js(`(() => { window.confirm = () => true; return true })()`)
  await js(`window.__fcTest.setTrash([
    { name: 'task-demo-901.md', id: 'task-demo-901', title: '被删掉的演示任务', status: '待办', project: 'demo', bytes: 512, mtime: '2026-09-26T09:00:00.000Z' },
    { name: 'task-demo-902.2.md', id: 'task-demo-902', title: '同名副本（历史遗留）', status: '完成', project: 'demo', bytes: 640, mtime: '2026-09-25T08:00:00.000Z' },
  ])`)
  await js(`(() => { const b = [...document.querySelectorAll('.vbtn')].find(x => x.textContent.trim() === '回收站'); if (b) b.click(); return !!b })()`)
  check('能切到回收站视图', await waitFor(`document.querySelector('main.trash-view')`, 6000, '回收站视图'))
  check('回收站条目读出来了', await waitFor(`document.querySelectorAll('main.trash-view .trash-item').length === 2`, 6000, '回收站条目'),
    String(await js(`document.querySelectorAll('main.trash-view .trash-item').length`)))
  check('★ 卡片本体带可点标记（class clickable + title 提示）',
    await js(`(() => { const c = document.querySelector('main.trash-view .trash-main'); return !!c && c.classList.contains('clickable') && !!c.getAttribute('title') })()`))
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const c = document.querySelector('main.trash-view .trash-main'); if (c) c.click(); return !!c })()`)
  check('★ 点卡片本身弹出正文预览（回执修的就是这里）',
    await waitFor(`document.querySelector('#trash-preview-overlay')`, 5000, '预览浮层'))
  check('★ 预览走 trash:read，且传的是**文件名**（不是 id —— 回收站同一 id 可能多份）',
    await waitFor(`window.__fcTest.callCount('trashRead') >= 1`, 5000, 'trashRead'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'trashRead'))`)))
  check('★ 预览里看得到正文文字',
    await js(`document.querySelector('#trash-preview-overlay').textContent.includes('正文')`))
  check('★ 预览里也有「还原 / 彻底删除」两个动作',
    await js(`[...document.querySelectorAll('#trash-preview-overlay .trash-btn')].some(b => b.textContent.includes('还原')) &&
              [...document.querySelectorAll('#trash-preview-overlay .trash-btn')].some(b => b.textContent.includes('彻底删除'))`))
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const b = [...document.querySelectorAll('#trash-preview-overlay .trash-btn')].find(x => x.textContent.includes('还原')); if (b) b.click(); return !!b })()`)
  check('★ 预览里点「还原」真的走 trashRestore（不是摆设）',
    await waitFor(`window.__fcTest.callCount('trashRestore') >= 1`, 5000, 'trashRestore'))
  check('★ 还原成功后预览自动关、列表少一条（不留悬空状态）',
    await waitFor(`!document.querySelector('#trash-preview-overlay') && document.querySelectorAll('main.trash-view .trash-item').length === 1`, 6000, '预览关闭+列表刷新'),
    String(await js(`document.querySelectorAll('main.trash-view .trash-item').length`)))

  // ── 21. 装到别的 agent（回执第 2 条：只有 Hermes 可装）─────────────────
  //   原话：「技能没找到任何可以安装给 WorkBuddy 的地方，依然只有安装到 Hermes，我赶时间懒得做，没测。」
  await js(`(() => { const b = [...document.querySelectorAll('.vbtn')].find(x => x.textContent.trim() === '技能'); if (b) b.click(); return !!b })()`)
  check('切到技能页会去拉 agent 目标', await waitFor(`window.__fcTest.callCount('agentsList') >= 1`, 5000, 'agentsList'))
  check('agent 目标列表渲染出来', await waitFor(`document.querySelectorAll('.agent-row').length >= 3`, 5000, 'agent 行'),
    String(await js(`document.querySelectorAll('.agent-row').length`)))
  check('★ WorkBuddy 出现在目标列表里（回执缺的就是这块）',
    await js(`[...document.querySelectorAll('.agent-row')].some(r => r.textContent.includes('WorkBuddy'))`))
  check('★ 目标行区分「可直装」与「给文件手动导入」',
    await js(`[...document.querySelectorAll('.agent-row')].some(r => r.textContent.includes('可直装')) &&
              [...document.querySelectorAll('.agent-row')].some(r => r.textContent.includes('给文件手动导入'))`))
  check('★ 没检测到的 agent 行变灰且不给按钮',
    await js(`(() => { const r = [...document.querySelectorAll('.agent-row')].find(x => x.textContent.includes('Claude Code')); return !!r && r.classList.contains('agent-off') && r.querySelectorAll('button').length === 0 })()`))
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const r = [...document.querySelectorAll('.agent-row')].find(x => x.textContent.includes('WorkBuddy')); const b = r && [...r.querySelectorAll('button')].find(x => x.textContent.includes('打开')); if (b) b.click(); return !!b })()`)
  check('★ 点「▶ 打开 WorkBuddy」走到 agentsOpen（真去开对方）',
    await waitFor(`window.__fcTest.callCount('agentsOpen') >= 1`, 5000, 'agentsOpen'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'agentsOpen'))`)))
  check('  传的是 target id（workbuddy）',
    await js(`window.__fcTest.calls().some(c => c.name === 'agentsOpen' && c.args[0] === 'workbuddy')`))
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const r = [...document.querySelectorAll('.agent-row')].find(x => x.textContent.includes('WorkBuddy')); const b = r && [...r.querySelectorAll('button')].find(x => x.textContent.includes('显示')); if (b) b.click(); return !!b })()`)
  check('★ 点「📂 显示一份 SKILL.md」走到 skillsReveal（把文件亮出来给你拖进去）',
    await waitFor(`window.__fcTest.callCount('skillsReveal') >= 1`, 5000, 'skillsReveal'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'skillsReveal'))`)))
  check('  技能卡片上也有「📂 显示 SKILL.md」按钮',
    await js(`[...document.querySelectorAll('.skill-card .skills-btn')].some(b => b.textContent.includes('显示 SKILL.md'))`))

  // ── 22. 服务页：导出快照 + 空闲一键启动（回执第 3 条）──────────────────
  //   原话：「服务页没看到 8090 有动静：绒花墨坊 :8090 空闲 启动台 没有进程在监听
  //          也没任何导出分析功能，直接复制给你了，懒得搞。」
  await js(`(() => { const b = [...document.querySelectorAll('.vbtn')].find(x => x.textContent.trim() === '服务'); if (b) b.click(); return !!b })()`)
  check('切到服务页拉到清单', await waitFor(`window.__fcTest.callCount('servicesList') >= 1`, 5000, 'servicesList'))
  // 前面的服务测试改过清单（取消了 8753、把未登记的 8090 登记走了）——
  // 快照断言要的是"内容真的反映当前清单"，所以先灌一份确定的数据再刷新
  await js(`window.__fcTest.setServices([
    { id: 'manual:8753', name: '方寸看板', port: 8753, note: 'Python 版 tegula', project: '', source: 'manual', listening: true, pid: 1234, processName: 'python', duplicated: false },
    { id: 'app:nobody', name: '没人跑的服务', port: 9100, note: '', project: '', source: 'launchpad', listening: false, pid: null, processName: '', duplicated: false },
  ])`)
  await js(`(() => { const b = [...document.querySelectorAll('main.services-view .skills-btn')].find(x => x.textContent.includes('刷新')); if (b) b.click(); return !!b })()`)
  check('  刷新后清单回到确定的 2 条', await waitFor(`document.querySelectorAll('main.services-view .svc-item:not(.small)').length === 2`, 5000, '重新灌数据'))
  check('★ 有「📋 复制快照」按钮（回执要的"导出分析"）',
    await js(`[...document.querySelectorAll('main.services-view .skills-btn')].some(b => b.textContent.includes('复制快照'))`))
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const b = [...document.querySelectorAll('main.services-view .skills-btn')].find(x => x.textContent.includes('复制快照')); if (b) b.click(); return !!b })()`)
  check('★ 点「复制快照」真的写进剪贴板（走主进程通道 clipboardWriteText）',
    await waitFor(`window.__fcTest.callCount('clipboardWriteText') >= 1`, 5000, 'clipboardWriteText'))
  check('★ 快照内容含端口清单本体（不是空串/一句"ok"）：端口 + 状态 + 统计都在',
    await js(`(() => { const c = window.__fcTest.calls().find(x => x.name === 'clipboardWriteText'); if (!c) return false;
      const t = String(c.args[0] || '');
      return t.includes(':8753') && t.includes(':9100') && t.includes('已登记') &&
             /登记 \\d+ · 监听中 \\d+ · 空闲 \\d+/.test(t) &&
             t.includes('监听中 pid=1234 python') })()`),
    String(await js(`String((window.__fcTest.calls().find(x => x.name === 'clipboardWriteText') || {}).args || '')`)))
  check('★ 空闲的启动台应用有「▶ 启动」按钮',
    await js(`(() => { const r = [...document.querySelectorAll('main.services-view .svc-item')].find(x => x.textContent.includes('没人跑的服务')); return !!r && [...r.querySelectorAll('button')].some(b => b.textContent.includes('启动')) })()`))
  check('★ 手填的空闲行**不给**启动按钮（方寸只启动启动台登记过的应用）',
    await js(`(() => { const r = [...document.querySelectorAll('main.services-view .svc-item')].find(x => x.textContent.includes('方寸看板')); if (!r) return true; return ![...r.querySelectorAll('button')].some(b => b.textContent.includes('启动')) })()`))
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const r = [...document.querySelectorAll('main.services-view .svc-item')].find(x => x.textContent.includes('没人跑的服务')); const b = r && [...r.querySelectorAll('button')].find(x => x.textContent.includes('启动')); if (b) b.click(); return !!b })()`)
  check('★ 点「▶ 启动」走到 servicesStart，带上端口',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'servicesStart' && c.args[0] === 9100)`, 5000, 'servicesStart :9100'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'servicesStart'))`)))
  check('★ 服务页依然没有"结束/杀掉进程"这类按钮（A 档只读，用户明确排除）',
    await js(`![...document.querySelectorAll('main.services-view button')].some(b => /结束|杀掉|停止进程|kill/i.test(b.textContent))`))

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
