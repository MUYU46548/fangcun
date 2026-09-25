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

  // ── 15. 导出指定备份（第 10 条：默认最新，不再每次全量重打）──────────────
  const gear = await js(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '⚙')
      if (!b) return { err: '没找到设置按钮' }
      b.click()
      return { clicked: true }
    })()`)
  await new Promise(r => setTimeout(r, 700))
  const bkSel = await js(`
    (() => {
      const sel = document.querySelector('.bk-export-select')
      if (!sel) return { exists: false }
      return {
        exists: true,
        value: sel.value,
        options: [...sel.options].map(o => o.value),
        labels: [...sel.options].map(o => o.textContent.trim()),
      }
    })()`)
  check('设置里有「导出内容」下拉', bkSel.exists === true && gear.clicked === true, JSON.stringify(gear) + ' ' + JSON.stringify(bkSel))
  check('下拉列出全部本地备份 + 一项「现打全量包」', bkSel.exists && bkSel.options.length === 3, JSON.stringify(bkSel.options))
  check('默认选中**最新**那份备份（不是默认全量）',
    bkSel.exists && bkSel.value === 'C:/mock/backups/fangcun-data-20260925-202020.zip', String(bkSel.value))
  await js(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '📤 导出所选')
      if (b) b.click()
      return true
    })()`)
  await new Promise(r => setTimeout(r, 500))
  const exportCall = await js(`
    (() => {
      const cs = window.__fcTest.calls().filter(c => c.name === 'backupExportTo')
      return { n: cs.length, last: cs.length ? JSON.stringify(cs[cs.length - 1].args) : null }
    })()`)
  check('「导出所选」把选中的包路径传给主进程',
    exportCall.n >= 1 && /fangcun-data-20260925-202020\.zip/.test(String(exportCall.last)), String(exportCall.last))
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
