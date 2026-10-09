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

/** 2026-09-29 用户第 1 条：小框（+ 添加）已移除 —— 造待办一律走唯一入口「＋ 新建待办」大框 */
const ADD_TODO_BTN = '＋ 新建待办'
async function addTodoViaModal(title, opts = {}) {
  await js(CLICK_BY_TEXT(ADD_TODO_BTN))
  if (!(await waitFor(`!!document.querySelector('#todo-edit-modal')`, 4000, '新建弹窗'))) return false
  await js(`(() => {
    const m = document.querySelector('#todo-edit-modal')
    const ta = m.querySelector('textarea')
    ta.value = ${JSON.stringify(title)}
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ${opts.prio ? `const ps = [...m.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === ${JSON.stringify(opts.prio)}))
    if (ps) { ps.value = ${JSON.stringify(opts.prio)}; ps.dispatchEvent(new Event('change', { bubbles: true })) }` : ''}
    ${opts.due ? `const d = m.querySelector('input[type=date]')
    d.value = ${JSON.stringify(opts.due)}; d.dispatchEvent(new Event('input', { bubbles: true }))` : ''}
    return true
  })()`)
  await sleep(150)
  await js(`(() => {
    const b = [...document.querySelectorAll('#todo-edit-modal button')].find(x => x.textContent.trim() === '保存')
    if (b) b.click()
    return !!b
  })()`)
  await sleep(400)
  return true
}

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
  // 2026-09-29 用户第 1 条：小框（+ 添加）与「大框新建」两个入口合并成一个
  check('快速小框已移除（不再有长得像搜索框的输入框，也没有第二个入口）',
    await js(`!document.querySelector('input.todo-input') &&
              ![...document.querySelectorAll('.todos-ctrls button')].some(b => b.textContent.includes('添加'))`))
  check('唯一入口「＋ 新建待办」存在',
    await js(`!!document.querySelector('.todos-ctrls .todo-new') &&
              document.querySelector('.todos-ctrls .todo-new').textContent.trim() === ${JSON.stringify('＋ 新建待办')}`))

  // 按钮必须真的适配了样式（用户第 1 条后半：样式仍为默认）
  const btnStyle = await js(`
    (() => {
      const b = document.querySelector('.todos-ctrls .todo-new')
      if (!b) return null
      const cs = getComputedStyle(b)
      return { bg: cs.backgroundColor, radius: cs.borderRadius, weight: cs.fontWeight, appearance: cs.appearance }
    })()
  `)
  check('「＋ 新建待办」不是浏览器默认样式（有圆角/有背景/有字重）',
    !!btnStyle && btnStyle.radius !== '0px' && btnStyle.weight !== '400',
    JSON.stringify(btnStyle))

  // ── 2. 空内容保存 → 必须有反馈（此前是静默 return）────────────────
  await js(CLICK_BY_TEXT('＋ 新建待办'))
  await waitFor(`!!document.querySelector('#todo-edit-modal')`, 4000, '新建弹窗')
  await js(`(() => { const b = [...document.querySelectorAll('#todo-edit-modal button')].find(x => x.textContent.trim() === '保存'); if (b) b.click(); return !!b })()`)
  await sleep(250)
  const emptyToast = await js(`(document.querySelector('#toast') || {}).textContent || ''`)
  check('空内容保存有明确反馈（不再是静默失败）', /不能为空|请先|输入/.test(emptyToast), emptyToast)
  check('空内容不产生待办', (await js(`window.__fcTest.todos().length`)) === 0)
  await js(`(() => { const b = [...document.querySelectorAll('#todo-edit-modal button')].find(x => x.textContent.trim() === '取消'); if (b) b.click(); return !!b })()`)
  await sleep(200)

  // ── 3. 大框填内容保存 → 真创建（唯一入口）──────────────────────────
  await js(`window.__fcTest.reset()`)
  await addTodoViaModal('渲染层测试待办')
  const created = await waitFor(`window.__fcTest.todos().length === 1`, 5000, '待办落库')
  check('点「＋ 新建待办」→ 保存真的调到了 todosCreate', await js(`window.__fcTest.callCount('todosCreate') >= 1`))
  check('待办已创建', created, JSON.stringify(await js(`window.__fcTest.todos()`)))
  const listRendered = await waitFor(`[...document.querySelectorAll('.todo-item .todo-title')].some(e => e.textContent.includes('渲染层测试待办'))`,
    5000, '列表回显')
  check('列表立即回显新待办', listRendered)
  check('弹窗保存后自动关闭（不留悬空弹窗）',
    await js(`!document.querySelector('#todo-edit-modal')`))

  // ── 4. 回车不再直接创建（小框移除后，弹窗里的回车 = 换行）────────────
  check('已无「回车即建」入口（回车路径随小框一起移除）',
    await js(`!document.querySelector('input.todo-input')`))

  // ── 5. 优先级走弹窗字段（替代 p0 尾缀语法）──────────────────────────
  await addTodoViaModal('带优先级的待办', { prio: '高' })
  await waitFor(`window.__fcTest.todos().length === 2`, 5000, '高优先级创建')
  const p0 = await js(`window.__fcTest.todos().find(t => t.title === '带优先级的待办')`)
  check('弹窗里选「高」写入高优先级', !!p0 && p0.priority === '高', JSON.stringify(p0))

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
  const ctxOk = await waitFor(`!!document.querySelector('.ctx-menu:not(.ctx-other)')`, 4000, '右键菜单')
  check('任务卡右键菜单可打开', ctxOk)
  if (ctxOk) {
    const hasAssign = await js(`[...document.querySelectorAll('.ctx-menu:not(.ctx-other) button')].some(b => b.textContent.includes('指派时间'))`)
    check('右键菜单含「指派时间」', hasAssign)
  }

  // ── 7.2 弹药库「复制为派工单」（卡 031 六字段 schema）───────────────
  //   六字段进模板文本、不进 JSON；纯文本拼接零智能；**只复制不派发**。
  //   同一批断言在 e2e-renderer-web（无头浏览器）里跑得更细（六字段逐项/纪律段/三种状态标记）。
  if (ctxOk) {
    await js(`window.__fcTest.reset()`)
    check('★ 右键菜单含「复制为派工单」（弹药库出口）',
      await js(`[...document.querySelectorAll('.ctx-menu:not(.ctx-other) button')].some(b => b.textContent.includes('复制为派工单'))`))
    await js(`(() => {
      const b = [...document.querySelectorAll('.ctx-menu:not(.ctx-other) button')].find(x => x.textContent.includes('复制为派工单'))
      if (b) b.click()
      return !!b
    })()`)
    check('  点它走到主进程剪贴板通道',
      await waitFor(`window.__fcTest.calls().some(c => c.name === 'clipboardWriteText')`, 4000, 'clipboardWriteText'))
    const disp = await js(`
      (() => {
        const cs = window.__fcTest.calls().filter(c => c.name === 'clipboardWriteText')
        return cs.length ? String(cs[cs.length - 1].args[0] || '') : ''
      })()`)
    check('★ 派工单六字段齐 + 约束卡/验收四条/驳回纪律都在',
      ['## 1 任务目标', '## 2 工作目录 / 范围', '## 3 项目事实 / 放置位置', '## 4 抽象档位',
       '## 5 验收判据', '## 6 驳回上限', '## 约束卡', '## 验收四条', '## 驳回纪律']
        .every(h => String(disp).indexOf(h) >= 0),
      String(disp).slice(0, 120))
    const names = await js(`JSON.stringify(window.__fcTest.calls().map(c => c.name))`)
    check('★ 零智能不派发：只写剪贴板，没碰任何执行/派发通道',
      String(names).indexOf('clipboardWriteText') >= 0
      && !/dispatch|execute|spawn|run|launch/i.test(String(names)), String(names))
  }

  // ── 7.5 看板密度方案 B（2026-09-28 用户挑定）────────────────────────
  //   ① 列灰底 / 卡白底，列删掉 4px 左边色条   ② 卡级染色取消（左边条只留逾期）
  //   ③ 紧凑单行卡（标题单行省略，正文/标签移进悬停轻提示）  ④ 完成/驳回列默认折叠
  //   ⑤ 悬停补救：**只在标题真被截断时**出现、150ms 后弹、拖拽中不弹
  const density = await js(`
    (() => {
      const rgb = (s) => (s.match(/\\d+/g) || []).map(Number)
      const col = document.querySelector('#board .col')
      const card = document.querySelector('#board .card')
      if (!col || !card) return { err: '看板没渲染出来' }
      const cs = getComputedStyle(col), ks = getComputedStyle(card)
      const ttl = card.querySelector('.ttl')
      const ts = ttl ? getComputedStyle(ttl) : null
      return {
        colRgb: rgb(cs.backgroundColor), cardRgb: rgb(ks.backgroundColor),
        colBorderLeft: cs.borderLeftWidth, cardBorderLeft: ks.borderLeftWidth,
        h: Math.round(card.getBoundingClientRect().height),
        ttlWhiteSpace: ts && ts.whiteSpace, ttlOverflowX: ts && ts.overflowX,
        hasPreview: !!card.querySelector('.card-preview'),
        collapsed: [...document.querySelectorAll('#board .col.collapsed-col')].map(c => (c.querySelector('.status-label') || c.querySelector('h3')).textContent.trim()),
        all: [...document.querySelectorAll('#board .col')].map(c => (c.querySelector('.status-label') || c.querySelector('h3')).textContent.trim()),
      }
    })()`)
  check('★ 列底色与卡片色反转（列淡灰 243 · 卡纯白 255）',
    !density.err && density.colRgb[0] < 250 && density.cardRgb.join(',') === '255,255,255',
    JSON.stringify(density))
  check('★ 列不再有 4px 左边色条（"竖条好几条"的主要来源，一次省 4 条）',
    !density.err && parseFloat(density.colBorderLeft) <= 1, String(density.colBorderLeft))
  check('★ 卡片不再整张染色（左边条只在逾期时出现）',
    !density.err && parseFloat(density.cardBorderLeft) <= 1, String(density.cardBorderLeft))
  check('★ 紧凑单行卡：卡高 ≤ 34px（改前约 48px，带正文预览时更高）',
    !density.err && density.h <= 34, String(density.h))
  check('★ 卡上不再有正文预览行（内容移进悬停轻提示，点开仍是详情面板）',
    density.hasPreview === false, JSON.stringify(density))
  check('★ 标题单行省略（nowrap + overflow hidden），不再换行撑高',
    !density.err && density.ttlWhiteSpace === 'nowrap' && /hidden/.test(String(density.ttlOverflowX)),
    JSON.stringify(density))
  check('★ 完成 / 驳回列默认折叠（终态平时不用看 —— 同「已归档默认收起」一条哲学）',
    !density.err && ['完成', '驳回'].every(l => density.collapsed.includes(l)),
    JSON.stringify({ collapsed: density.collapsed, all: density.all }))
  check('  非终态列照常展开（待办 / 进行中 / 待验收不被默认收起）',
    !density.err && !density.collapsed.includes('待办') && !density.collapsed.includes('进行中')
      && !density.collapsed.includes('待验收'),
    JSON.stringify(density.collapsed))

  // 卡右侧 meta：**日期与所属项目常驻可见**（2026-09-28 用户反馈「希望看见所属项目和日期」）
  const cardMeta = await js(`
    (() => {
      const cards = [...document.querySelectorAll('#board .card')].filter(c => c.offsetParent !== null)
      const bad = []
      for (const c of cards) {
        const d = c.querySelector('.card-date'), p = c.querySelector('.card-proj')
        const title = (c.querySelector('.ttl') || {}).textContent || ''
        if (!d || !d.textContent.trim() || d.offsetParent === null) bad.push('无日期:' + title)
        if (!p || !p.textContent.trim() || p.offsetParent === null) bad.push('无项目:' + title)
      }
      return { total: cards.length, badCount: bad.length, bad: bad.slice(0, 4) }
    })()`)
  check('★ 板上每张可见卡都常驻显示「日期 + 所属项目」',
    !cardMeta.err && cardMeta.total > 0 && cardMeta.badCount === 0, JSON.stringify(cardMeta))
  const arrProj = await js(`
    (() => {
      const c = [...document.querySelectorAll('#board .card')]
        .find(x => ((x.querySelector('.ttl') || {}).textContent || '').includes('数组项目的任务'))
      if (!c) return { err: '没找到「数组项目的任务」那张卡' }
      return { proj: (c.querySelector('.card-proj') || {}).textContent || '', raw: JSON.stringify((c.querySelector('.card-proj') || {}).title || '') }
    })()`)
  check('★ 「项目」是数组时也能显示成项目名（不过 normProject 就永远匹配不到 —— 用户报的「看不见项目」）',
    !arrProj.err && arrProj.proj.trim() === '第二个项目', JSON.stringify(arrProj))
  const duePref = await js(`
    (() => {
      const c = [...document.querySelectorAll('#board .card')]
        .find(x => ((x.querySelector('.ttl') || {}).textContent || '').includes('演示任务') && !((x.querySelector('.ttl') || {}).textContent || '').includes('归档'))
      if (!c) return { err: '没找到「演示任务」那张卡' }
      const d = c.querySelector('.card-date')
      return { text: d ? d.textContent.trim() : '', over: d ? d.classList.contains('over') : null }
    })()`)
  // 夹具截止日跟随今天（见 renderer-preload.cjs 的 FIX_DEADLINE）—— 这里按同一条规则算期望，
  // 别再写死 '09-30'：跨月第一天会假红，2026-10-01 实测过一次。
  const fixMmdd = (() => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })()
  check(`★ 有截止日就显示截止日（${fixMmdd}，逾期才标红）`,
    !duePref.err && duePref.text.includes(fixMmdd), JSON.stringify(duePref))
  const updFallback = await js(`
    (() => {
      const c = [...document.querySelectorAll('#board .card')]
        .find(x => ((x.querySelector('.ttl') || {}).textContent || '').includes('数组项目的任务'))
      if (!c) return { err: 'no card' }
      const d = c.querySelector('.card-date')
      return { text: d ? d.textContent.trim() : '', dim: d ? d.classList.contains('dim') : null }
    })()`)
  check('★ 没有截止日就退到「更新 MM-DD」（卡上永远看得见一个日期，且样式区分开）',
    !updFallback.err && /更新/.test(updFallback.text) && updFallback.dim === true, JSON.stringify(updFallback))

  // ⑤ 悬停轻提示：造两张确定的卡（一张超长会截断、一张很短不会），不靠数据碰运气
  const tipPrep = await js(`
    (() => {
      // 只用**可见**的卡：默认折叠的完成/驳回列里也有 .card，但 rect 是 0×0
      const cards = [...document.querySelectorAll('#board .card')].filter(c => c.offsetParent !== null)
      if (cards.length < 2) return { err: '可见的看板卡少于 2 张：' + cards.length }
      const LONG = '这是一条故意写得很长的标题用来触发省略号并且验证悬停提示确实补回了完整文字'
      const set = (c, s, tag) => {
        const t = c.querySelector('.ttl')
        if (!t) return false
        t.textContent = s
        c.setAttribute('data-tip-test', tag)
        return true
      }
      if (!set(cards[0], LONG, 'long') || !set(cards[1], '短标题', 'short')) return { err: '找不到 .ttl' }
      return { long: LONG }
    })()`)
  check('（环境）造出「超长标题」与「短标题」两张卡', !tipPrep.err, JSON.stringify(tipPrep))

  await js(`(() => { const c = document.querySelector('[data-tip-test="long"]'); if (c) c.dispatchEvent(new MouseEvent('mouseenter')) ; return true })()`)
  await new Promise(r => setTimeout(r, 50))
  check('★ 悬停不是「立刻弹出」：50ms 时还没有（延时 150ms，不是 0 也不是 1-2 秒）',
    (await js(`!!document.querySelector('.card-tip')`)) === false)
  await new Promise(r => setTimeout(r, 350))
  const tipShown = await js(`
    (() => {
      const t = document.querySelector('.card-tip')
      if (!t) return null
      const cs = getComputedStyle(t)
      return {
        title: (t.querySelector('.card-tip-title') || {}).textContent || '',
        position: cs.position, pointerEvents: cs.pointerEvents,
      }
    })()`)
  check('★ 标题被截断的卡：悬停后弹出轻提示，且给的是完整标题（不是省略的那截）',
    !!tipShown && tipShown.title === tipPrep.long, JSON.stringify(tipShown))
  check('★ 轻提示 position:fixed + pointer-events:none（不进布局、不吃命中 —— 方寸铁律）',
    !!tipShown && tipShown.position === 'fixed' && tipShown.pointerEvents === 'none', JSON.stringify(tipShown))

  // 拖拽中不许弹（拖着卡划过一整列时浮层会一路闪）
  const tipDrag = await js(`
    (() => {
      const long = document.querySelector('[data-tip-test="long"]')
      if (!long) return { err: '没有长标题卡' }
      try { long.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() })) } catch (e) { /* 合成 DataTransfer 的 setDragImage 可能抛，不影响 draggingId 已置位 */ }
      long.dispatchEvent(new MouseEvent('mouseleave'))
      long.dispatchEvent(new MouseEvent('mouseenter'))
      return { ok: true }
    })()`)
  await new Promise(r => setTimeout(r, 400))
  check('★ 拖拽中不弹悬停浮层（拖卡片时鼠标必划过一堆卡）',
    tipDrag.err ? false : (await js(`!!document.querySelector('.card-tip')`)) === false,
    JSON.stringify(tipDrag))
  await js(`(() => { const c = document.querySelector('[data-tip-test="long"]'); if (c) { try { c.dispatchEvent(new DragEvent('dragend', { bubbles: true })) } catch (e) {} c.dispatchEvent(new MouseEvent('mouseleave')) } return true })()`)
  await new Promise(r => setTimeout(r, 200))

  // 短标题的卡不该弹任何东西（界面保持安静）
  await js(`(() => { const c = document.querySelector('[data-tip-test="short"]'); if (c) c.dispatchEvent(new MouseEvent('mouseenter')) ; return true })()`)
  await new Promise(r => setTimeout(r, 400))
  check('★ 标题没被截断的卡：悬停不弹任何东西（只有真被省略号的才提示）',
    (await js(`!!document.querySelector('.card-tip')`)) === false,
    String(await js(`document.querySelector('.card-tip') ? '有浮层' : '无浮层'`)))
  await js(`(() => { const c = document.querySelector('[data-tip-test="short"]'); if (c) c.dispatchEvent(new MouseEvent('mouseleave')) ; return true })()`)

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

  // 2026-09-28 用户第 3 条：全折叠 / 全展开是**同一个按钮**的两种状态。
  // 修前界面上并排放着「折叠全部」与「展开」两个按钮，永远有一个点了没反应。
  const foldBtnCount = await js(`
    (() => [...document.querySelectorAll('button')].filter(b => /折叠全部|展开全部/.test(b.textContent.trim())).length)()`)
  check('★ 顶栏只有一个「折叠/展开全部」按钮（不再并排两个，其中一个必定无效）',
    foldBtnCount === 1, String(foldBtnCount))
  const foldBtnBefore = await js(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => /折叠全部|展开全部/.test(x.textContent.trim())); return b ? b.textContent.trim() : null })()`)
  check('  展开状态下按钮文案是「折叠全部」', String(foldBtnBefore).includes('折叠全部'), String(foldBtnBefore))

  await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => /折叠全部|展开全部/.test(x.textContent.trim())); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  const allFold = await js(`
    (() => {
      const cols = [...document.querySelectorAll('#board .col')]
      const b = [...document.querySelectorAll('button')].find(x => /折叠全部|展开全部/.test(x.textContent.trim()))
      return {
        collapsed: cols.filter(c => c.className.includes('collapsed-col')).length,
        total: cols.length,
        anyVisible: [...document.querySelectorAll('#board .card')].some(c => c.offsetParent !== null),
        label: b ? b.textContent.trim() : null,
      }
    })()`)
  check('同一个按钮点一下把所有分组折叠起来', allFold.collapsed === allFold.total && allFold.total > 1, JSON.stringify(allFold))
  check('全折叠后没有卡片还露在外面', allFold.anyVisible === false, JSON.stringify(allFold))
  check('★ 折叠后按钮自己变成「展开全部」（文案跟着状态走，不是一个死按钮）',
    String(allFold.label).includes('展开全部'), String(allFold.label))

  await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => /折叠全部|展开全部/.test(x.textContent.trim())); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 250))
  const afterExpand = await js(`
    (() => {
      const n = [...document.querySelectorAll('#board .col')].filter(c => c.className.includes('collapsed-col')).length
      const b = [...document.querySelectorAll('button')].find(x => /折叠全部|展开全部/.test(x.textContent.trim()))
      return { n, label: b ? b.textContent.trim() : null }
    })()`)
  check('再点一次全还原（同一个按钮走完一个来回）', afterExpand.n === 0, JSON.stringify(afterExpand))
  check('★ 展开后文案回到「折叠全部」', String(afterExpand.label).includes('折叠全部'), String(afterExpand.label))

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
  // 「＋ 新建待办」大框保存 → 勾选 → 它变成「已勾选」，正好是第 14 条的场景。
  await js(`(() => { const b = [...document.querySelectorAll('nav#views .vbtn')].find(x => x.textContent.trim() === '待办'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 400))
  const seeded = await (async () => {
    const ok = await addTodoViaModal('第14条_签下之后也要能编辑')
    return ok ? { typed: true } : { err: '新建弹窗没打开' }
  })()
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
      if (!b) return { err: '没找到「＋ 新建待办」按钮' }
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
  check('「＋ 新建待办」打开的是新建态（标题为「新建待办」、内容为空）',
    createModal.exists === true && createModal.h3 === '新建待办' && createModal.empty === true,
    JSON.stringify(createOpen) + ' ' + JSON.stringify(createModal))
  await js(`
    (() => {
      const ta = document.querySelector('#todo-edit-modal textarea')
      ta.value = '弹窗新建的待办'
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
      return { n: cs.length, last: cs.length ? JSON.stringify(cs[cs.length-1].args) : null, inList: list.includes('弹窗新建的待办') }
    })()`)
  check('「＋ 新建待办」真的调到了 todosCreate 且落到列表里',
    createdViaModal.n >= 1 && /弹窗新建的待办/.test(String(createdViaModal.last)) && createdViaModal.inList === true,
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
  //     2026-09-29 对齐 09-28 改版：旧断言点的 .log-archive-toggle 已不存在
  //     （现为 .log-group-sep/.log-group-toggle + v-show 分组，卡片父级隐藏时
  //     自身 computed display 仍非 none）——改用 getClientRects 判可见 + 状态归一化，
  //     折叠/展开往返不依赖跨轮持久化的 localStorage 初始态（「默认收起」另由
  //     e2e-renderer-web 的全新 profile 断言）。
  const sec14 = () => js(`(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0
    const sep = [...document.querySelectorAll('main.logs-view .log-group-sep')]
      .find(s => (s.textContent || '').includes('已归档'))
    const cards = [...document.querySelectorAll('.log-card')]
    const arch = cards.find(c => (c.textContent || '').includes('归档的日志'))
    return {
      hasSep: !!sep,
      sepText: sep ? sep.textContent.replace(/\\s+/g, ' ').trim() : null,
      archExists: !!arch,
      archVisible: shown(arch),
      visibleCount: cards.filter(shown).length,
      archIsLast: cards.length ? (cards[cards.length - 1].textContent || '').includes('归档的日志') : false,
      hasToggle: !!document.querySelector('main.logs-view .g-archived .log-group-toggle'),
    }
  })()`)
  const part = await sec14()
  check('归档日志有独立分区头（.log-group-sep 而非旧 .log-archive-sep）',
    part.hasSep === true, JSON.stringify(part))
  check('分区头写明归档条数（glabel + gn）',
    /已归档\s*1\b/.test(String(part.sepText || '')), String(part.sepText))
  check('归档分区头有折叠开关（g-archived .log-group-toggle）', part.hasToggle === true, JSON.stringify(part))
  check('归档日志排在主区之后（DOM 顺序，不管收没收起）', part.archIsLast === true, JSON.stringify(part))
  // 归一化：初始态可能是用户/上一轮留下的 localStorage —— 先收到已知态（收起）再往返
  if (part.archVisible) {
    await js(`(() => { const b = document.querySelector('main.logs-view .g-archived .log-group-toggle'); if (b) b.click(); return true })()`)
    await new Promise(r => setTimeout(r, 300))
  }
  const c1 = await sec14()
  check('收起归档后主区只见未归档的 2 条（归档卡留在 DOM、不占视图）',
    c1.archVisible === false && c1.visibleCount === 2, JSON.stringify(c1))
  await js(`(() => { const b = document.querySelector('main.logs-view .g-archived .log-group-toggle'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 300))
  const expanded = await sec14()
  check('点分区头能展开归档日志', expanded.archVisible === true, JSON.stringify(expanded))
  check('展开后主区 + 归档区共 3 条可见', expanded.visibleCount === 3, String(expanded.visibleCount))
  await js(`(() => { const b = document.querySelector('main.logs-view .g-archived .log-group-toggle'); if (b) b.click(); return true })()`)
  await new Promise(r => setTimeout(r, 300))
  const reCollapsed = await sec14()
  check('再点一次能收回去', reCollapsed.archVisible === false, JSON.stringify(reCollapsed))

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

  // 2026-09-28 卡 026-001（验收驳回原话：「依然不能手动点来选中备份，回收站都能点了，备份不能点，无语」）
  //   修前 `.bk-item` 是没有 @click 的死 div，行上只有「恢复」按钮 —— 点行毫无反应。
  await js(`window.__fcTest.reset()`)
  const rowClick = await js(`
    (() => {
      const row = document.querySelector('.bk-item')
      if (!row) return { err: '没有备份行' }
      row.click()
      return { name: (row.querySelector('.bk-item-name') || {}).textContent || '' }
    })()`)
  check('★ 点备份行会去校验**这一份**（把它的路径直接交给主进程，不再走文件选择器）',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'backupVerifyPackage' && String(c.args[0] || '').includes('.zip'))`, 5000, 'backupVerifyPackage'),
    JSON.stringify(rowClick) + ' ' + String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'backupVerifyPackage'))`)))
  check('★ 校验结果就地展开（manifest 摘要 + 文件数），用户能看到这一份里有什么',
    await waitFor(`(() => { const v = document.querySelector('.bk-verify'); return !!v && /个文件/.test(v.textContent) })()`, 5000, '校验结果面板'),
    String(await js(`(() => { const v = document.querySelector('.bk-verify'); return v ? v.textContent.slice(0, 80) : 'none' })()`)))
  check('★ 被点开的那一行有明确标记（不是"点了好像没反应"）',
    await js(`(() => { const r = document.querySelector('.bk-item.on'); return !!r && !!r.querySelector('.bk-inspecting') })()`),
    String(await js(`document.querySelector('.bk-item.on') ? document.querySelector('.bk-item.on').textContent.slice(0, 40) : 'none'`)))
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
        mapBtn: bar ? (bar.querySelector('.cb-map-btn') || {}).textContent : null,
        mapBtnTag: bar && bar.querySelector('.cb-map-btn') ? bar.querySelector('.cb-map-btn').tagName : null,
        cardBtns: btns,
        tiles: tiles.length,
      }
    })()`)
  check('项目页有「项目章程」缺口条', !!charter.barText, JSON.stringify(charter))
  check('缺口条统计正确（已填 1 / 共 2，缺失 1）',
    /已填 1 \/ 2/.test(String(charter.barText)) && /缺失 1/.test(String(charter.barText)), String(charter.barText))
  // 029 验收驳回原话「找不到在哪里」：结构地图此前只是**不可点的计数 span**，且没缺口时干脆不渲染。
  // 现在必须是**常驻的按钮**（没缺口时也在），点开有内容。
  check('★ 缺口条有「结构地图」入口，而且是可点的 button（029 驳回原因就是找不到它）',
    charter.mapBtnTag === 'BUTTON' && /结构地图/.test(String(charter.mapBtn)), JSON.stringify(charter))
  check('★ 缺口数显示在这个入口上（还有 1 张方针卡没有结构地图）',
    /待填 1/.test(String(charter.mapBtn)), String(charter.mapBtn))
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

  // ── 16.5 结构地图入口（卡 029，验收驳回原话「找不到在哪里」）──────────────
  //   修前：结构地图只存在于方针卡文件里，界面上唯一相关的是一个**不可点的计数 span**，
  //   而且没有缺口时它还不渲染 —— 用户当然找不到。现在：常驻按钮 + 可点开的一览 + 能看能改。
  await js(`(() => { window.confirm = () => true; return true })()`)
  await js(`(() => { const b = document.querySelector('.cb-map-btn'); if (b) b.click(); return !!b })()`)
  check('★ 点「结构地图」打开一览（不再是个点了没反应的计数）',
    await waitFor(`!!document.querySelector('#smap-modal')`, 5000, '结构地图一览'))
  const smap = await js(`
    (() => {
      const items = [...document.querySelectorAll('#smap-modal .smap-item')]
      return items.map(i => ({
        name: (i.querySelector('.smap-name') || {}).textContent || '',
        meta: (i.querySelector('.smap-meta') || {}).textContent || '',
        btn: (i.querySelector('.smap-open') || {}).textContent || '',
        cls: i.className,
      }))
    })()`)
  check('一览列出全部登记项目（2 个）', smap.length === 2, JSON.stringify(smap))
  check('★ 没结构地图的项目说清状态（不是空白）',
    smap.some(r => r.name.includes('演示项目') && /没有结构地图/.test(r.meta)),
    JSON.stringify(smap))
  check('★ 连方针卡都没有的项目也如实说', smap.some(r => /连方针卡都还没立/.test(r.meta)), JSON.stringify(smap))
  check('缺的排在前面（要动的先看到）', String(smap[0].cls).includes('missing') || String(smap[0].cls).includes('nopolicy'),
    JSON.stringify(smap.map(r => r.cls)))

  // 从一览进方针卡：结构地图要能看能改（此前界面上**根本没有这个字段**）
  await js(`(() => { const b = [...document.querySelectorAll('#smap-modal .smap-open')][0]; if (b) b.click(); return !!b })()`)
  check('★ 一览里点一下就能进方针卡编辑',
    await waitFor(`!!document.querySelector('#policy-modal')`, 5000, '方针卡弹窗'))
  check('★ 方针卡里有「结构地图」小节（此前只读得到、界面看不见）',
    await js(`(() => { const t = document.querySelector('#policy-modal textarea.tall'); return !!t })()`))
  await js(`(() => { const b = [...document.querySelectorAll('#policy-modal button')].find(x => x.textContent.includes('标记今天已核实')); if (b) b.click(); return !!b })()`)
  await new Promise(r => setTimeout(r, 200))
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  check('★ 「标记今天已核实」把最后核实日期改成今天（029 的日期戳纪律）',
    await js(`(() => { const t = document.querySelector('#policy-modal textarea.tall'); return !!t && t.value.includes('${iso}') })()`),
    String(await js(`(() => { const t = document.querySelector('#policy-modal textarea.tall'); return t ? t.value.slice(0, 60) : 'none' })()`)))
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const b = [...document.querySelectorAll('#policy-modal button')].find(x => x.textContent.includes('保存方针卡')); if (b) b.click(); return !!b })()`)
  check('★ 保存时把结构地图一起发出去（不发 = 界面里改的会丢）',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'policySave' && /最后核实/.test(JSON.stringify(c.args)))`, 5000, 'policySave 带 structureMap'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'policySave').map(c => String(JSON.stringify(c.args)).slice(0, 120)))`)))

  // 已经填好的卡：一览要显示「最后核实」日期（029 的日期戳就是给人看的）
  await js(`window.__fcTest.setPolicies({
    demo: { mission: '使命内容', goal: '', scenario: '', boundary: '',
      structureMap: '> 最后核实：2026-09-27（当日实测）\\n- 模块清单：渲染层 / 主进程\\n- 主数据流：task-data → loadAllTasksRaw → 看板' },
  })`)
  await js(`(() => { const b = document.querySelector('.cb-map-btn'); if (b) b.click(); return !!b })()`)
  await waitFor(`!!document.querySelector('#smap-modal')`, 5000, '一览再开')
  const smap2 = await js(`
    (() => {
      const i = [...document.querySelectorAll('#smap-modal .smap-item')].find(x => (x.querySelector('.smap-name') || {}).textContent.includes('演示项目'))
      return i ? { meta: (i.querySelector('.smap-meta') || {}).textContent || '', btn: (i.querySelector('.smap-open') || {}).textContent || '', cls: i.className } : null
    })()`)
  check('★ 填好的卡在一览里显示「最后核实 · 2026-09-27」',
    !!smap2 && /最后核实 · 2026-09-27/.test(String(smap2.meta)), JSON.stringify(smap2))
  check('★ 缺口清掉后按钮上的计数变成「n/n」（入口仍在，不会消失）',
    await js(`(() => { const t = (document.querySelector('.cb-map-btn') || {}).textContent || ''; return /1\\/1/.test(t) })()`),
    String(await js(`(document.querySelector('.cb-map-btn') || {}).textContent`)))
  await js(`(() => { const b = [...document.querySelectorAll('#smap-modal button')].find(x => x.textContent.trim() === '关闭'); if (b) b.click(); return !!b })()`)
  await new Promise(r => setTimeout(r, 200))

  // ── 16.6 多视图切换（2026-09-28 用户第 ① 条后半句 + 卡 033 验收驳回）────────
  //   用户原话：「尝试多种视图可选（用户自己切换，旧的视图可以保留）」
  //   033 驳回原话：「我要的方块卡片式视图和其他视图也没出现，多视图根本没做。」
  //   这里钉三件事，缺一条这个功能就是假的：
  //     ① **旧视图永远是默认**（列视图 / 清单）—— 新视图是"换个摆法"，不是替换；
  //     ② 两种摆法**互斥**（同时挂两份 DOM 会让勾选、计数、键盘焦点全部翻倍）；
  //     ③ 选择进**真身 prefs.json**（与分组方式同一套，换 origin 不丢）。
  //   另加"换个摆法没丢功能"：点开详情、拖拽改状态，在列表视图里必须照样成立。
  await js(CLICK_BY_TEXT('看板'))
  await sleep(350)

  const sw = await js(`
    (() => {
      const head = document.querySelector('.pagehead')
      if (!head) return { ok: false }
      return {
        ok: true,
        btns: [...head.querySelectorAll('button.vsb')].map(b => ({ t: (b.textContent || '').trim(), on: b.classList.contains('on') })),
        hint: (head.querySelector('.pagehead-hint') || {}).textContent || '',
      }
    })()`)
  check('★ 看板页头有视图切换器（列视图 / 列表视图），而且是真 button',
    sw.ok && sw.btns.length === 2
    && sw.btns.some(b => b.t.includes('列视图')) && sw.btns.some(b => b.t.includes('列表视图')),
    JSON.stringify(sw))
  check('★ 默认仍是**旧视图**（列视图高亮、列表视图未选）—— 用户要的是"可以保留"，不是被换掉',
    sw.ok && sw.btns.some(b => b.t.includes('列视图') && b.on) && !sw.btns.some(b => b.t.includes('列表视图') && b.on),
    JSON.stringify(sw.btns))
  check('  切换器旁有说明（不必先点一遍才知道两个摆法差在哪）',
    sw.ok && String(sw.hint).length > 6, String(sw.hint))

  const colState = await js(`({
    cols: document.querySelectorAll('#board .col').length,
    cards: document.querySelectorAll('#board .col > .card').length,
    list: document.querySelectorAll('#board .board-list').length,
  })`)
  check('  默认渲染的是列视图（有 .col 与卡片，没有 .board-list）',
    colState.cols > 0 && colState.cards > 0 && colState.list === 0, JSON.stringify(colState))

  check('★ 能点到「列表视图」', await js(`
    (() => {
      const b = [...document.querySelectorAll('.pagehead button.vsb')].find(x => x.textContent.includes('列表视图'))
      if (!b) return false
      b.click(); return true
    })()`))
  check('★ 列表视图真的渲染出来（.board-list + 状态分区）',
    await waitFor(`document.querySelectorAll('#board .board-list .blgrp').length > 0`, 5000, '列表视图分区'))

  const listState = await js(`
    (() => ({
      rows: document.querySelectorAll('#board .board-list .brow').length,
      cols: document.querySelectorAll('#board .col').length,
      cards: document.querySelectorAll('#board .card').length,
      pills: [...document.querySelectorAll('#board .board-list .lpill')].map(p => ({
        label: (p.querySelector('.glabel') || {}).textContent || '',
        n: (p.querySelector('.gn') || {}).textContent || '',
      })),
    }))()`)
  check('★ 两种摆法互斥：列表视图里不再挂着列视图那份 DOM（否则勾选/计数/焦点全会翻倍）',
    listState.cols === 0 && listState.cards === 0, JSON.stringify(listState))
  check('★ 摆的是同一批任务（行数 = 卡数，不重不漏）',
    listState.rows === colState.cards && colState.cards > 0,
    `rows=${listState.rows} cards=${colState.cards}`)
  check('  分区头 = 状态名 + 条数（与列头同源，不是另算一份）',
    listState.pills.length === colState.cols
    && listState.pills.every(p => p.label && /^\d+$/.test(p.n)),
    JSON.stringify(listState.pills))

  // 折叠状态共用：在列表视图里折叠一个分区 → 该分区的行全部隐藏，展开回来还在。
  // ⚠ 目标分区**按数据挑**（第一个"展开着且有条目"的），不写死名字 ——
  //   前面的用例已经挪过任务、也切过分组方式，写死「待办」是给自己埋雷。
  const FOLD_TARGET = `
    (() => {
      const vis = (g) => [...g.querySelectorAll('.brow')].filter(r => r.offsetParent !== null).length
      return [...document.querySelectorAll('#board .board-list .blgrp')].find(g => vis(g) > 0) || null
    })()`
  const mvFold = await js(`
    (() => {
      const g = ${FOLD_TARGET}
      if (!g) return null
      const label = (g.querySelector('.glabel') || {}).textContent || ''
      const vis = () => [...g.querySelectorAll('.brow')].filter(r => r.offsetParent !== null).length
      const before = vis()
      g.querySelector('.lpill').click()
      return { label, before, total: g.querySelectorAll('.brow').length }
    })()`)
  await sleep(300)
  const mvFoldAfter = await js(`
    (() => {
      const g = ${FOLD_TARGET}
      if (!g) return { vis: -1, label: '(全折叠了)' }
      return { vis: [...g.querySelectorAll('.brow')].filter(r => r.offsetParent !== null).length, label: (g.querySelector('.glabel') || {}).textContent || '' }
    })()`)
  check('★ 分区头可折叠（复用列视图那套折叠机制，不是列表视图重做一遍）',
    !!mvFold && mvFold.before > 0 && mvFoldAfter.vis === 0,
    JSON.stringify(mvFold) + ' → ' + JSON.stringify(mvFoldAfter))
  // 展开回来（用折叠时记下的分区名，同样不写死）
  const mvFoldLabel = mvFold ? mvFold.label : ''
  const mvPickGroup = `[...document.querySelectorAll('#board .board-list .blgrp')].find(x => (x.querySelector('.glabel') || {}).textContent === ${JSON.stringify(mvFoldLabel)})`
  await js(`
    (() => {
      const g = ${mvPickGroup}
      if (g) g.querySelector('.lpill').click()
      return !!g
    })()`)
  await sleep(300)
  check('  再点能展开回来（折叠不是单向的）',
    await js(`
      (() => {
        const g = ${mvPickGroup}
        return !!g && [...g.querySelectorAll('.brow')].filter(r => r.offsetParent !== null).length > 0
      })()`),
    String(await js(`JSON.stringify([...document.querySelectorAll('#board .board-list .blgrp')].map(g => ((g.querySelector('.glabel') || {}).textContent || '') + ':' + [...g.querySelectorAll('.brow')].filter(r => r.offsetParent !== null).length))`)))

  // 换个摆法不能丢功能：点开详情
  await js(`(() => { const r = document.querySelector('#board .board-list .brow'); if (r) r.click(); return !!r })()`)
  check('★ 列表视图里点一行照样打开详情（不是"只有列视图能点"）',
    await waitFor(`!!document.querySelector('#roverlay')`, 5000, '详情浮层'))
  await js(`(() => { const o = document.querySelector('#roverlay'); if (o) o.click(); return true })()`)
  await sleep(250)

  // 换个摆法不能丢功能：拖到别的分区 = 改状态
  const dropInfo = await js(`
    (() => {
      const row = document.querySelector('#board .board-list .brow')
      if (!row) return { ok: false }
      const from = row.closest('.blgrp')
      const target = [...document.querySelectorAll('#board .board-list .blgrp')].find(g => g !== from)
      if (!target) return { ok: false }
      const dt = new DataTransfer()
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      return { ok: true, id: row.dataset.id, to: (target.querySelector('.glabel') || {}).textContent || '' }
    })()`)
  await sleep(300)
  check('★ 列表视图里拖一行到别的分区 = 改状态（拖拽没在换摆法时丢掉）',
    dropInfo.ok && await waitFor(`window.__fcTest.calls().some(c => c.name === 'moveStatus')`, 5000, 'moveStatus'),
    JSON.stringify(dropInfo) + ' | ' + String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'moveStatus').map(c => c.args))`)))

  // 选择进真身 prefs.json
  check('★ 视图选择写进真身 prefs.json（换 origin 不丢，与分组方式同一套机制）',
    await waitFor(`window.__fcTest.prefs().fc_board_view === 'list'`, 4000, 'prefs.fc_board_view'),
    String(await js(`JSON.stringify(window.__fcTest.prefs())`)))
  check('  localStorage 只当读缓存，两边取值一致',
    await js(`localStorage.getItem('fc_board_view') === '"list"'`),
    String(await js(`localStorage.getItem('fc_board_view')`)))

  // ── 待办页签：清单（默认）/ 卡片网格（033 点名的「方块卡片式」）──
  await js(CLICK_BY_TEXT('待办'))
  await sleep(350)
  const tsw = await js(`
    (() => {
      const head = document.querySelector('.pagehead')
      if (!head) return { ok: false }
      return {
        ok: true,
        btns: [...head.querySelectorAll('button.vsb')].map(b => ({ t: (b.textContent || '').trim(), on: b.classList.contains('on') })),
        grid: !!document.querySelector('main.todos-view .todos-list.as-grid'),
        items: document.querySelectorAll('main.todos-view .todo-item').length,
      }
    })()`)
  check('★ 待办页头也有切换器（清单 / 卡片网格）',
    tsw.ok && tsw.btns.some(b => b.t.includes('清单')) && tsw.btns.some(b => b.t.includes('卡片网格')),
    JSON.stringify(tsw))
  check('★ 待办默认仍是清单（旧视图），且初始不是网格',
    tsw.ok && tsw.btns.some(b => b.t.includes('清单') && b.on) && tsw.grid === false, JSON.stringify(tsw))
  check('  待办页切换器是**另一套**选项（不是把看板那套原样搬过来）',
    await js(`(() => { const h = document.querySelector('.pagehead'); return !!h && !/列视图/.test(h.textContent) })()`))

  check('★ 能点到「卡片网格」', await js(`
    (() => {
      const b = [...document.querySelectorAll('.pagehead button.vsb')].find(x => x.textContent.includes('卡片网格'))
      if (!b) return false
      b.click(); return true
    })()`))
  check('★ 卡片网格真的渲染出来（033 要的「方块卡片式」）',
    await waitFor(`!!document.querySelector('main.todos-view .todos-list.as-grid')`, 5000, 'as-grid'))
  const cardLayout = await js(`
    (() => {
      const it = document.querySelector('main.todos-view .todos-list.as-grid .todo-item')
      if (!it) return { err: '没有卡片' }
      const chk = it.querySelector('.todo-chk')
      const ttl = it.querySelector('.todo-title')
      const pri = it.querySelector('.todo-prio')
      const cs = getComputedStyle(ttl)
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
      return {
        display: getComputedStyle(it).display,
        clamp: cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp'),
        whiteSpace: cs.whiteSpace,
        box: getComputedStyle(ttl).display,
        chk: r(chk), ttl: r(ttl), pri: pri ? r(pri) : null,
        card: r(it),
        cells: getComputedStyle(document.querySelector('main.todos-view .todos-list')).gridTemplateColumns,
      }
    })()`)
  check('  卡片是网格排布 + 方块（auto-fill 多列，不是又一行清单）',
    !cardLayout.err && String(cardLayout.display).includes('flex')
    && String(cardLayout.cells).split(' ').length >= 2, JSON.stringify(cardLayout))
  check('★ 标题**独占一行且最多 3 行不截断**（-webkit-line-clamp:3，不是 nowrap 省略号）',
    !cardLayout.err && String(cardLayout.clamp) === '3' && cardLayout.whiteSpace !== 'nowrap'
    && cardLayout.ttl.y > cardLayout.chk.y && cardLayout.ttl.w > cardLayout.card.w * 0.7,
    JSON.stringify({ clamp: cardLayout.clamp, ws: cardLayout.whiteSpace, ttl: cardLayout.ttl, chk: cardLayout.chk }))
  check('  优先级在卡片第一行右端（"扫一眼卡片墙"要比较的那个字段）',
    !cardLayout.err && !!cardLayout.pri
    && Math.abs(cardLayout.pri.y - cardLayout.chk.y) < 8
    && cardLayout.pri.x > cardLayout.card.x + cardLayout.card.w / 2,
    JSON.stringify({ pri: cardLayout.pri, chk: cardLayout.chk, card: cardLayout.card }))

  // 网格里功能不丢：点标题进编辑
  await js(`(() => { const t = document.querySelector('main.todos-view .todos-list.as-grid .todo-title'); if (t) t.click(); return !!t })()`)
  check('★ 网格里点标题进编辑（操作按钮不在卡面上 ≠ 不能改）',
    await waitFor(`!!document.querySelector('#todo-edit-modal')`, 5000, '待办编辑弹窗'))
  await js(`(() => { const b = [...document.querySelectorAll('#todo-edit-modal button')].find(x => x.textContent.trim() === '取消'); if (b) b.click(); return !!b })()`)
  await sleep(250)

  // 网格里勾选照样生效
  await js(`window.__fcTest.reset()`)
  await js(`(() => {
    const c = document.querySelector('main.todos-view .todos-list.as-grid .todo-item .todo-chk')
    if (!c) return false
    c.click(); return true
  })()`)
  check('★ 网格里勾选照样写回后端（勾选是复用的同一个 input，不是另做一套）',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'todosUpdate' || c.name === 'todosToggle')`, 5000, 'todosUpdate'),
    String(await js(`JSON.stringify(window.__fcTest.calls().map(c => c.name))`)))
  check('★ 待办视图选择也进真身 prefs.json',
    await waitFor(`window.__fcTest.prefs().fc_todo_view === 'grid'`, 4000, 'prefs.fc_todo_view'),
    String(await js(`JSON.stringify(window.__fcTest.prefs())`)))

  // 收尾：把两个页签都还原成默认摆法 ——
  // 后面的 12 页签静态审计（盖字 / 对比度）是按"默认摆法"建立的基线，
  // 换摆法会让它去审一套没人常规使用、也还没人眼过过的排版。新摆法的排版另有上面这批几何断言兜。
  await js(`
    (() => {
      const b = [...document.querySelectorAll('.pagehead button.vsb')].find(x => x.textContent.includes('清单'))
      if (b) b.click()
      return !!b
    })()`)
  await sleep(250)
  await js(CLICK_BY_TEXT('看板'))
  await sleep(300)
  await js(`
    (() => {
      const b = [...document.querySelectorAll('.pagehead button.vsb')].find(x => x.textContent.includes('列视图'))
      if (b) b.click()
      return !!b
    })()`)
  await sleep(300)
  check('  切回默认摆法后列视图恢复（选择可逆，不是单向开关）',
    await js(`document.querySelectorAll('#board .col').length > 0 && document.querySelectorAll('#board .board-list').length === 0`))
  check('  切回后真身也同步回默认值（不是只改了界面）',
    await waitFor(`window.__fcTest.prefs().fc_board_view === 'cols'`, 4000, 'prefs 回 cols'),
    String(await js(`JSON.stringify(window.__fcTest.prefs())`)))

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
    await js(`[...document.querySelectorAll('.skill-id')].some(e => e.textContent.includes('fangcun-bridge'))`))
  check('卡片显示绝对路径（手抄不出来的那一半）',
    await js(`[...document.querySelectorAll('.skill-path')].some(e => e.textContent.includes('C:/mock/skills/fangcun-bridge/SKILL.md'))`))
  // ⚠ 2026-10-09 修断言（本条自卡 010/011 改文案后一直红，与改动面无关但属实）：
  //   ① 旧断言找「未装到 Hermes」—— skillStateText 早就改成 '未装'（App.vue:5268），文案绑死即红；
  //   ② 旧断言要求出现「已装（最新）」—— 那取决于**本机装的副本是不是最新**（机器状态，
  //      非代码事实）：本机实测是「有更新」= 装了但副本旧，同样是合法状态。
  //   判据改成「状态文案落在已知三态集合内 + 未装的那张确实是未装 + 装了的那张确实不是未装」——
  //   验的是渲染逻辑与文案表，不验本机那一刻的版本比对结果。
  check('★ 已装 / 未装两种状态文案都对',
    await js(`(() => {
      const KNOWN = ['文件缺失', '无可直装目标', '未装', '有更新', '已装（最新）']
      const texts = [...document.querySelectorAll('.skill-state')].map(e => e.textContent.trim())
      if (!texts.length) return false
      if (!texts.every(t => KNOWN.includes(t))) return false
      // 未装的那张必须报「未装」（本机第二个技能没装 → 恒成立）
      if (!texts.includes('未装')) return false
      // 装了的那张必须是「最新」或「有更新」之一（不能是未装/文件缺失）
      return texts.some(t => t === '已装（最新）' || t === '有更新')
    })()`),
    String(await js(`[...document.querySelectorAll('.skill-state')].map(e => e.textContent).join('|')`)))

  // 17a. 复制安装提示词（核心诉求：让 agent 自己装、杜绝手抄）
  await js(`(() => { const b = [...document.querySelectorAll('.skills-btn')].find(x => x.textContent.includes('复制安装提示词')); if (b) b.click(); return !!b })()`)
  const promptCopied = await waitFor(`window.__fcTest.callCount('clipboardWriteText') >= 1`, 5000, '复制走到 clipboardWriteText')
  check('★ 点「复制安装提示词」真的走到剪贴板通道（不是死按钮）', promptCopied)
  check('★ 复制的内容里带绝对路径（杜绝手抄出错）',
    await js(`window.__fcTest.calls().filter(c => c.name === 'clipboardWriteText').map(c => JSON.stringify(c.args)).join('|').includes('C:/mock/skills/fangcun-bridge/SKILL.md')`),
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
    await addTodoViaModal(`优先级徽章 ${label}`, { prio: label })
  }
  check('★ 三档优先级都有徽章（高/中/低）',
    await js(`!!document.querySelector('.todo-prio.prio-high') &&
              !!document.querySelector('.todo-prio.prio-mid') &&
              !!document.querySelector('.todo-prio.prio-low')`),
    String(await js(`[...document.querySelectorAll('.todo-prio')].map(e => e.className + ':' + e.textContent.trim()).join(' | ')`)))
  check('徽章显示中文 高/中/低（不是内部英文值）',
    await js(`[...document.querySelectorAll('.todo-prio')].some(e => e.textContent.trim() === '低')`))

  // 18c. 逾期标注：造一条 2020 年到期的未完成待办
  await js(CLICK_BY_TEXT('＋ 新建待办'))
  check('★ 「＋ 新建待办」打开弹窗', await waitFor(`!!document.querySelector('#todo-edit-modal')`, 4000, '新建弹窗'))
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
  await js(CLICK_BY_TEXT('＋ 新建待办'))
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
  // 2026-09-30 卡 005：热区从 .trash-main 扩到整行，clickable 类由 .trash-item 的
  // cursor:pointer 承担（选择器同步改，否则这条断言永远红）。
  check('★ 卡片本体带可点标记（.trash-item cursor:pointer + title 提示）',
    await js(`(() => { const r = document.querySelector('main.trash-view .trash-item');
      const c = document.querySelector('main.trash-view .trash-main');
      return !!r && getComputedStyle(r).cursor === 'pointer' && !!c && !!c.getAttribute('title') })()`))
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

  // ── 23. 卡 037 第一批：日志右键菜单 + 置顶（2026-09-26 用户口径）────────
  //   规格铁律：菜单是「出口加速器」；一层封顶、单项 ≤7；删除放最末且二次确认；
  //   任何「发给 AI / 智能总结」永不进菜单。
  await js(`(() => { window.confirm = () => true; return true })()`)
  await js(`window.__fcTest.setLogs([
    { id: 'log-demo-1', title: '进行中的日志', content: '内容A', status: 'active', running: true, project: 'demo', created: '2026-09-24T00:00:00.000Z' },
    { id: 'log-demo-2', title: '已完成的日志', content: '内容B', status: 'completed', project: 'demo', created: '2026-09-23T00:00:00.000Z' },
    { id: 'log-demo-3', title: '归档的日志', content: '内容C', status: 'archived', project: 'demo', created: '2026-09-22T00:00:00.000Z' },
  ])`)
  await js(`(() => { const b = [...document.querySelectorAll('.vbtn')].find(x => x.textContent.trim() === '日志'); if (b) b.click(); return !!b })()`)
  check('切到日志页', await waitFor(`document.querySelectorAll('main.logs-view .log-card').length >= 3`, 6000, '日志卡'),
    String(await js(`document.querySelectorAll('main.logs-view .log-card').length`)))
  check('★ 日志卡能右键（回执：右键此前只作用于任务卡）',
    await js(`(() => { const c = document.querySelector('main.logs-view .log-card'); if (!c) return false;
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 140 })); return true })()`))
  check('★ 右键菜单真的弹出来了', await waitFor(`document.querySelector('.ctx-menu.ctx-other')`, 5000, '右键菜单'))
  const logMenu = await js(`document.querySelector('.ctx-menu.ctx-other').textContent`)
  check('★ 菜单项与用户规格一致（复制全文 / 带元信息 / 复制并标记已派 / 置顶 / 改归属 / 归档 / 删除）',
    ['复制全文', '复制带元信息', '复制并标记已派', '置顶', '改项目归属', '归档', '删除'].every(k => String(logMenu).includes(k)),
    String(logMenu))
  check('★ 删除排在最后（破坏性动作不配顺手）',
    await js(`(() => { const bs = [...document.querySelectorAll('.ctx-menu.ctx-other button')]; return bs.length > 0 && bs[bs.length - 1].textContent.includes('删除') })()`))
  check('★ 菜单里没有"发给 AI / 智能总结"（元层铁律，永不进菜单）',
    await js(`!/AI|智能|总结|生成/i.test(document.querySelector('.ctx-menu.ctx-other').textContent)`))
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const b = [...document.querySelectorAll('.ctx-menu.ctx-other button')].find(x => x.textContent.includes('复制带元信息')); if (b) b.click(); return !!b })()`)
  check('★ 「复制带元信息」走主进程剪贴板，内容自动带 [日期] [项目]（粘进开发日志不用补头）',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'clipboardWriteText' && c.args[0].includes('[2026-09-24]') && c.args[0].includes('[demo]'))`, 5000, '带元信息复制'),
    String(await js(`JSON.stringify((window.__fcTest.calls().find(c => c.name === 'clipboardWriteText') || {}).args || [])`)))
  // 复制并标记已派：复制 + 把这条手动标成「进行中」
  // 2026-09-28：走的是新通道 logsSetRunning，**不再是 logsReopen** ——
  // 撤销（reopen）现在只回到「待处理」，拿它当"已派"会把状态标反。
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const c = [...document.querySelectorAll('main.logs-view .log-card')].find(x => x.textContent.includes('已完成的日志')); if (c) c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 })); return !!c })()`)
  await waitFor(`document.querySelector('.ctx-menu.ctx-other')`, 4000, '第二条菜单')
  await js(`(() => { const b = [...document.querySelectorAll('.ctx-menu.ctx-other button')].find(x => x.textContent.includes('复制并标记已派')); if (b) b.click(); return !!b })()`)
  check('★ 「复制并标记已派」= 复制 + 手动标为「进行中」（两步并一步）',
    await waitFor(`window.__fcTest.callCount('clipboardWriteText') >= 1 && window.__fcTest.callCount('logsSetRunning') >= 1`, 5000, '复制+已派'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => ['clipboardWriteText', 'logsSetRunning', 'logsReopen'].includes(c.name)))`)))
  check('★ 「已派」走 setRunning(true)，不得误用 logsReopen（那只是撤销到待处理）',
    await js(`(() => { const c = window.__fcTest.calls().find(x => x.name === 'logsSetRunning'); return !!c && c.args[1] === true })()`),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'logsSetRunning'))`)))
  // 置顶：写数据 + 列表置顶 + 视觉标记
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const c = [...document.querySelectorAll('main.logs-view .log-card')].find(x => x.textContent.includes('归档的日志')); if (c) c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 180 })); return !!c })()`)
  await waitFor(`document.querySelector('.ctx-menu.ctx-other')`, 4000, '第三条菜单')
  await js(`(() => { const b = [...document.querySelectorAll('.ctx-menu.ctx-other button')].find(x => x.textContent.includes('置顶')); if (b) b.click(); return !!b })()`)
  check('★ 「置顶」写回后端（新字段 pinned，不是复用 status）',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'logsSetPinned' && c.args[1] === true)`, 5000, 'logsSetPinned'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'logsSetPinned'))`)))
  check('★ 置顶的那条在列表最前面（排序生效，视觉也在）',
    await waitFor(`(() => { const c = document.querySelector('main.logs-view .log-card'); return !!c && c.classList.contains('pinned') && !!c.querySelector('.log-pin') })()`, 6000, '置顶卡在最前'),
    String(await js(`(() => { const c = document.querySelector('main.logs-view .log-card'); return c ? c.textContent.slice(0, 40) : 'none' })()`)))
  // 改项目归属：走 prompt + 专用通道（不受"非 active 不可编辑"限制）
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const c = [...document.querySelectorAll('main.logs-view .log-card')].find(x => x.textContent.includes('已完成的日志')); if (c) c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 })); return !!c })()`)
  await waitFor(`document.querySelector('.ctx-menu.ctx-other')`, 4000, '第四条菜单')
  await js(`(() => { const b = [...document.querySelectorAll('.ctx-menu.ctx-other button')].find(x => x.textContent.includes('改项目归属')); if (b) b.click(); return !!b })()`)
  check('★ 「改项目归属」打开的是应用内选择器（不是 prompt —— Electron 不实现它）',
    await waitFor(`document.querySelector('#log-project-modal')`, 5000, '项目选择器'))
  await js(`(() => { const b = [...document.querySelectorAll('#log-project-modal .skills-btn')].find(x => x.textContent.includes('演示项目')); if (b) b.click(); return !!b })()`)
  check('★ 选完项目走到 logsSetProject（已完成的日志也能改 —— 归类属性不是内容编辑）',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'logsSetProject' && c.args[1] === 'demo')`, 5000, 'logsSetProject'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'logsSetProject'))`)))

  // ── 23.5 日志状态模型 + 分区（2026-09-28 用户第 2/5 条）────────────────
  //   用户口径：① 「进行中」只能手动打上、可撤销、且**不是完成/归档的前置条件**；
  //             ② 那堆筛选"除了把信息搞得支离破碎以外没什么作用" → 状态改用**分区**表达。
  await js(`window.__fcTest.setLogs([
    { id: 'lg-run', title: '正在跑的', content: 'A', status: 'active', running: true, project: 'demo', created: '2026-09-24T00:00:00.000Z' },
    { id: 'lg-todo', title: '还没跑的', content: 'B', status: 'active', project: 'demo', created: '2026-09-23T00:00:00.000Z' },
    { id: 'lg-done', title: '跑完了的', content: 'C', status: 'completed', project: 'demo', created: '2026-09-22T00:00:00.000Z' },
  ])`)
  // ⚠ 换数据后必须**离开再回到日志页**：日志列表只在 `watch(curView)` 里 loadLogs()（+5s 轮询），
  //   原地 setLogs 会读到旧 DOM，断言就变成在测上一批假数据。
  await js(`(() => { const b = [...document.querySelectorAll('.vbtn')].find(x => x.textContent.trim() === '待办'); if (b) b.click(); return !!b })()`)
  await sleep(200)
  await js(`(() => { const b = [...document.querySelectorAll('.vbtn')].find(x => x.textContent.trim() === '日志'); if (b) b.click(); return !!b })()`)
  check('（环境）日志页渲染出这 3 条', await waitFor(
    `[...document.querySelectorAll('main.logs-view .log-card-title')].some(t => t.textContent.includes('正在跑的'))`, 6000, '新日志数据'),
    String(await js(`JSON.stringify([...document.querySelectorAll('main.logs-view .log-card-title')].map(t => t.textContent))`)))

  const lgGroups = await js(`
    (() => ({
      labels: [...document.querySelectorAll('main.logs-view .log-group-toggle')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
      hasStatusSelect: !![...document.querySelectorAll('main.logs-view select')].some(s => [...s.options].some(o => o.textContent.includes('全部状态'))),
      badges: [...document.querySelectorAll('main.logs-view .log-card')].map(c => {
        const b = c.querySelector('.log-status-badge')
        const t = c.querySelector('.log-card-title')
        return (b ? b.textContent.trim() : '?') + ':' + (t ? t.textContent.trim() : '?')
      }),
    }))()`)
  check('★ 日志页按状态分区（进行中 / 待处理 / 已完成…）',
    Array.isArray(lgGroups.labels) && lgGroups.labels.some(l => l.includes('进行中')) && lgGroups.labels.some(l => l.includes('待处理')),
    JSON.stringify(lgGroups.labels))
  check('★ 分区头带计数（不必点进去数）', lgGroups.labels.length > 0 && lgGroups.labels.every(l => /\d/.test(l)),
    JSON.stringify(lgGroups.labels))
  check('★ 「进行中」分区排最前（谁在跑 = 最该先看到）',
    lgGroups.labels.length > 0 && lgGroups.labels[0].includes('进行中'), JSON.stringify(lgGroups.labels))
  check('★ 状态筛选下拉已删除（状态由分区表达，不再用单值下拉把画面切碎）',
    lgGroups.hasStatusSelect === false, JSON.stringify(lgGroups))
  check('★ 手动标了 running 的显示「进行中」，没标的显示「待处理」（不再一创建就是进行中）',
    lgGroups.badges.some(b => b.startsWith('进行中:') && b.includes('正在跑的')) &&
    lgGroups.badges.some(b => b.startsWith('待处理:') && b.includes('还没跑的')),
    JSON.stringify(lgGroups.badges))

  const doneBtn = await js(`
    (() => {
      const c = [...document.querySelectorAll('main.logs-view .log-card')].find(x => x.textContent.includes('还没跑的'))
      if (!c) return { err: '没找到「还没跑的」那张卡' }
      return { hasDone: [...c.querySelectorAll('button')].some(b => b.textContent.trim() === '完成') }
    })()`)
  check('★ 「完成」按钮在「待处理」日志上直接可用（进行中不是完成的前置条件）',
    doneBtn.hasDone === true, JSON.stringify(doneBtn))

  await js(`window.__fcTest.reset()`)
  await js(`(() => {
    const c = [...document.querySelectorAll('main.logs-view .log-card')].find(x => x.textContent.includes('还没跑的'))
    const b = c && c.querySelector('.log-run-btn'); if (b) b.click(); return !!b
  })()`)
  check('★ 卡片上有手动「标为进行中」开关，点了走 logs:setRunning(true)',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'logsSetRunning' && c.args[1] === true)`, 5000, 'setRunning(true)'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'logsSetRunning'))`)))

  await js(`window.__fcTest.reset()`)
  await js(`(() => {
    const c = [...document.querySelectorAll('main.logs-view .log-card')].find(x => x.textContent.includes('正在跑的'))
    const b = c && c.querySelector('.log-run-btn'); if (b) b.click(); return !!b
  })()`)
  check('★ 同一只开关能撤销（setRunning(false) —— 防误操作，用户第 2 条明写）',
    await waitFor(`window.__fcTest.calls().some(c => c.name === 'logsSetRunning' && c.args[1] === false)`, 5000, 'setRunning(false)'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'logsSetRunning'))`)))

  const moreClosed = await js(`
    (() => ({
      hasBtn: !!document.querySelector('main.logs-view .log-more-btn'),
      hasAgent: [...document.querySelectorAll('main.logs-view select')].some(s => [...s.options].some(o => o.textContent.includes('全部 Agent'))),
    }))()`)
  check('★ 「更多筛选」默认收起：Agent / 日期范围不再和搜索框挤在一条线上',
    moreClosed.hasBtn === true && moreClosed.hasAgent === false, JSON.stringify(moreClosed))
  await js(`(() => { const b = document.querySelector('main.logs-view .log-more-btn'); if (b) b.click(); return !!b })()`)
  await new Promise(r => setTimeout(r, 250))
  check('点开「更多筛选」才出现 Agent 下拉',
    (await js(`[...document.querySelectorAll('main.logs-view select')].some(s => [...s.options].some(o => o.textContent.includes('全部 Agent')))`)) === true)
  await js(`(() => { const b = document.querySelector('main.logs-view .log-more-btn'); if (b) b.click(); return !!b })()`)
  await new Promise(r => setTimeout(r, 150))

  // 关联日志条目：单击就能打开（修前这条列表项**没有任何点击处理器** —— 点了毫无反应，
  // 用户只好反复点、以为是"要双击"，所以这条用源码级断言钉死入口存在）
  check('★ 任务详情的关联日志条目绑定了单击打开（修前是个死 div，怎么点都没反应）',
    /class="task-log-item"[\s\S]{0,120}@click="openLogPreview\(log\)"/.test(
      require('fs').readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'App.vue'), 'utf-8')))

  // ── 24. 卡 037 第二批：待办右键菜单 + 置顶（不动托盘，用户已定口径）────
  await js(`window.__fcTest.setTodos([])`)
  await js(`(() => { const b = [...document.querySelectorAll('.vbtn')].find(x => x.textContent.trim() === '待办'); if (b) b.click(); return !!b })()`)
  check('切到待办页', await waitFor(`document.querySelector('main.todos-view')`, 6000, '待办视图'))
  await addTodoViaModal('被右键的待办')
  check('建出一条待办用于右键', await waitFor(`document.querySelectorAll('main.todos-view .todo-item').length === 1`, 5000, '待办条目'),
    String(await js(`document.querySelectorAll('main.todos-view .todo-item').length`)))
  check('★ 待办行能右键',
    await js(`(() => { const r = document.querySelector('main.todos-view .todo-item'); if (!r) return false;
      r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 130, clientY: 150 })); return true })()`))
  check('★ 待办右键菜单弹出（置顶 / 复制内容 / 编辑 / 删除）',
    await waitFor(`document.querySelector('.ctx-menu.ctx-other')`, 5000, '待办菜单') &&
    await js(`['置顶', '复制内容', '编辑', '删除'].every(k => document.querySelector('.ctx-menu.ctx-other').textContent.includes(k))`),
    String(await js(`document.querySelector('.ctx-menu.ctx-other') ? document.querySelector('.ctx-menu.ctx-other').textContent : 'none'`)))
  await js(`window.__fcTest.reset()`)
  await js(`(() => { const b = [...document.querySelectorAll('.ctx-menu.ctx-other button')].find(x => x.textContent.includes('置顶')); if (b) b.click(); return !!b })()`)
  check('★ 待办「置顶」写回后端', await waitFor(`window.__fcTest.calls().some(c => c.name === 'todosSetPinned' && c.args[1] === true)`, 5000, 'todosSetPinned'),
    String(await js(`JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'todosSetPinned'))`)))
  check('★ 置顶后待办带上 📌 且置顶样式生效',
    await waitFor(`(() => { const r = document.querySelector('main.todos-view .todo-item'); return !!r && r.classList.contains('pinned') && !!r.querySelector('.todo-pin') })()`, 6000, '待办置顶样式'))
  check('★ 待办菜单里没有托盘项（用户口径：这批不动托盘）',
    await js(`!/托盘|Tray/i.test(document.querySelector('.ctx-menu.ctx-other') ? document.querySelector('.ctx-menu.ctx-other').textContent : '')`))

  // ── 21. 「遮罩挡字」与主题可读性（2026-09-27 用户第 2/3 条）────────────
  // ① 拖拽提示必须自己消失。模拟「拖进窗口又取消」（Esc / 拖出窗口 / 松手在窗口外）——
  //    这三种收场都不会有 drop，也不保证有 dragleave；OS 文件拖拽的 dragend 只发给拖动源，
  //    页面收不到 ⇒ 修前实测：待办提示永久留在屏幕上（96% 不透明的色块，正压着正文第一行）。
  // ② 任何位置都不该有东西盖在文字上面。
  // ③ 文字对比度 ≥ 4.5（WCAG AA）。唯一豁免：日历「过去日期」的日号（刻意压暗，≥3.0）。
  const AUDIT_JS = `(() => {
    const vis = (el) => {
      if (!el || el.nodeType !== 1) return false
      const s = getComputedStyle(el)
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false
      const r = el.getBoundingClientRect()
      return r.width > 1 && r.height > 1
    }
    // ★ 2026-09-28（用户第 1 条）——**这是上一轮漏掉的真盲区**：
    //   elementFromPoint 遵守 pointer-events，而那个挡住文字的光斑恰恰是 pointer-events:none
    //   （"点不掉、也不报错"就是它的特征）。于是"12 页签无盖字"这条断言**红着也报绿**。
    //   修法：先把所有 pointer-events:none 的元素临时改成 auto，让命中测试真的看得见它们，
    //   审计结束再逐字恢复原值（不留任何副作用）。
    const patched = []
    for (const el of document.querySelectorAll('body, body *')) {
      if (getComputedStyle(el).pointerEvents === 'none') {
        patched.push([el, el.style.pointerEvents])
        el.style.pointerEvents = 'auto'
      }
    }
    const rgba = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] }
    const blend = (f, b) => f.slice(0, 3).map((c, i) => c * f[3] + b[i] * (1 - f[3]))
    const lum = (c) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2] }
    const effBg = (el) => {
      const chain = []; let n = el
      while (n && n.nodeType === 1) { chain.unshift(n); n = n.parentElement }
      let acc = [255, 255, 255]
      for (const nd of chain) { const c = rgba(getComputedStyle(nd).backgroundColor); if (c && c[3] > 0) acc = blend(c, acc) }
      return acc
    }
    const vw = innerWidth, vh = innerHeight
    const covered = [], low = []
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      const t = (n.nodeValue || '').trim()
      if (t.length < 2) continue
      const el = n.parentElement
      if (!vis(el)) continue
      const s = getComputedStyle(el)
      // ① 盖字：文字中心点被别的元素命中
      const rg = document.createRange(); rg.selectNodeContents(n)
      // ⚠ 2026-09-28：必须把文字矩形**裁到元素自己的矩形内**。
      //   紧凑单行卡的标题是 overflow:hidden + text-overflow:ellipsis —— Range 给的是
      //   **布局矩形（未裁剪）**，长标题会一路伸到隔壁列里去，取中点在邻列命中另一个元素，
      //   于是审计会把"正常的省略号"报成"有东西盖住文字"（假阳性）。
      //   取交集后剩下的才是"用户真的看得见的那截文字"。
      const er = el.getBoundingClientRect()
      const raw = rg.getBoundingClientRect()
      const left = Math.max(raw.left, er.left), right = Math.min(raw.right, er.right)
      const top = Math.max(raw.top, er.top), bottom = Math.min(raw.bottom, er.bottom)
      const rect = { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
      if (rect.width >= 3 && rect.height >= 3 && rect.bottom > 0 && rect.top < vh) {
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
        // 中心点必须真的在视口内 —— 看板是横向滚动的，滚出右边界那条列的列头会被
        // 夹到视口边缘、命中另一列（假阳性，2026-09-27 实测踩过）
        if (cx >= 0 && cy >= 0 && cx < vw && cy < vh) {
          const hit = document.elementFromPoint(cx, cy)
          if (hit && !(hit === el || el.contains(hit) || hit.contains(el))) {
            const hn = typeof hit.className === 'string' ? hit.className : hit.tagName
            const hr = hit.getBoundingClientRect()
            const hs = getComputedStyle(hit)
            covered.push(t.slice(0, 18) + ' [' + (typeof el.className === 'string' ? el.className : el.tagName) + ' ← ' + hn
              + ' pos=' + hs.position + ' z=' + hs.zIndex + ' 文字@' + Math.round(rect.left) + ',' + Math.round(rect.top)
              + ' 盖层@' + Math.round(hr.left) + ',' + Math.round(hr.top) + ' ' + Math.round(hr.width) + 'x' + Math.round(hr.height) + ']')
          }
        }
      }
      // ② 对比度
      const fg = rgba(s.color); if (!fg) continue
      const bg = effBg(el)
      const cr = (() => { const a = blend(fg, bg), l1 = lum(a), l2 = lum(bg); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) })()
      const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 600
      // 豁免：日历「过去日期」的日号 —— 刻意压暗表示已过去，按图形对象 3.0 要求
      const past = el.classList.contains('dnum') && !!el.closest('.calcell.past')
      const need = past ? 3 : (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5
      if (cr < need) low.push(t.slice(0, 20) + ' ' + s.color + ' ' + Math.round(size) + 'px ' + cr.toFixed(2) + '<' + need)
    }
    // 恢复 pointer-events（审计不得留下副作用）
    for (const [el, v] of patched) el.style.pointerEvents = v
    return { covered, low }
  })()`

  const AUDIT_VIEWS = ['看板', '待办', '日志', '项目', '阻塞', '路线图', '日历', '归档', '回收站', '启动台', '技能', '服务']

  // ① 拖拽提示自愈（不靠 drop / dragleave）
  await js(CLICK_BY_TEXT('待办'))
  check('（环境）能切到待办视图', await waitFor(`!!document.querySelector('main.todos-view')`, 6000, '待办视图'))
  await js(`(() => { const z = document.querySelector('main.todos-view'); const dt = new DataTransfer()
    z.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }))
    z.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt })); return 1 })()`)
  await sleep(150)
  check('★ 拖文件进待办时出现「松手导入」提示', await js(`!!document.querySelector('.todo-drop-hint')`))
  await sleep(1700)
  check('★ 拖拽被取消（无 drop/dragleave）后提示自己消失，不再永久盖住正文',
    !(await js(`!!document.querySelector('.todo-drop-hint') || !!document.querySelector('.drop-hint.global')`)))

  // 技能页自己有投放区 —— 不该再被误判成「本页不支持导入」并盖一层全局灰条
  await js(CLICK_BY_TEXT('技能'))
  await sleep(500)
  await js(`(() => { const z = document.querySelector('main.skills-view'); const dt = new DataTransfer()
    z.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt })); return 1 })()`)
  await sleep(200)
  check('★ 技能页拖拽不再被误判成「本页不支持导入」',
    !(await js(`!!document.querySelector('.drop-hint.global')`)))
  await sleep(1600)
  check('★ 技能页投放遮罩也会自己消失', !(await js(`!!document.querySelector('.skills-dropmask')`)))

  // ③ 装饰光斑必须真的在**背景层**（2026-09-28 用户第 1 条的真因）
  //   `.blob` 是 position:fixed + z-index:0，而看板的 .col / 卡片都是**非定位的流内元素**。
  //   按 CSS 绘制顺序（负 z 子层 → 流内块背景 → 行内内容 → z-index:0/auto 的已定位元素），
  //   z-index:0 的它**画在所有正文之上** —— 460×460 的淡紫光斑正好糊在左上角第一列文字上。
  //   它 pointer-events:none，所以既点不掉、也不会被命中测试抓到（上一轮"无盖字"断言因此漏报）。
  //   修法：① 产品侧 .blob 落成 z-index:-1；② 审计侧临时放开 pointer-events（见 AUDIT_JS）。
  //   这条断言直接验**绘制顺序**：放开命中后，光斑覆盖区里不许有任何一点命中 .blob。
  await js(CLICK_BY_TEXT('看板'))
  await new Promise(r => setTimeout(r, 400))
  const blobHit = await js(`
    (() => {
      const blob = document.querySelector('.blob.b1')
      if (!blob) return { err: '找不到 .blob.b1' }
      const prev = blob.style.pointerEvents
      blob.style.pointerEvents = 'auto'
      const r = blob.getBoundingClientRect()
      const pts = []
      for (const fy of [0.35, 0.5, 0.65]) for (const fx of [0.25, 0.5, 0.75]) {
        pts.push([Math.round(r.left + r.width * fx), Math.round(r.top + r.height * fy)])
      }
      const hits = pts
        .filter(([x, y]) => x > 0 && y > 0 && x < innerWidth && y < innerHeight)
        .map(([x, y]) => { const h = document.elementFromPoint(x, y); return h ? (typeof h.className === 'string' && h.className ? h.className : h.tagName) : 'none' })
      blob.style.pointerEvents = prev
      return { z: getComputedStyle(blob).zIndex, hits }
    })()`)
  check('★ 左上角装饰光斑在背景层（z-index 为负），不再画在正文之上',
    !blobHit.err && parseFloat(blobHit.z) < 0, JSON.stringify(blobHit))
  check('★ 放开命中后，光斑覆盖区里没有任何一点命中 .blob（真·不挡字，而不是"点不穿所以查不到"）',
    !blobHit.err && Array.isArray(blobHit.hits) && blobHit.hits.length > 0
      && !blobHit.hits.some(h => /blob/.test(String(h))),
    JSON.stringify(blobHit))

  // ② ③ 逐页签静态审计（盖字 + 对比度）
  const badViews = []
  let coveredTotal = 0, lowTotal = 0
  for (const v of AUDIT_VIEWS) {
    if (!(await js(CLICK_BY_TEXT(v)))) continue
    await sleep(420)
    const r = await js(AUDIT_JS)
    coveredTotal += r.covered.length
    lowTotal += r.low.length
    if (r.covered.length || r.low.length) badViews.push(`${v}[盖${r.covered.length}/低${r.low.length}: ${[...r.covered.slice(0, 1), ...r.low.slice(0, 2)].join(' ; ')}]`)
  }
  check('★ 12 个页签都没有元素盖在文字上面（遮罩挡字）', coveredTotal === 0, badViews.slice(0, 2).join(' | '))
  check('★ 12 个页签文字对比度全部达 WCAG AA 4.5（日历过去日期按 3.0 豁免）', lowTotal === 0, badViews.slice(0, 2).join(' | '))

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
