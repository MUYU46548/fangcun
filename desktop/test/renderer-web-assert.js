/**
 * 渲染层 DOM 断言 —— 在**无头浏览器**里跑（2026-09-28）。
 *
 * 为什么存在：`e2e-renderer.cjs` 需要真实桌面会话（真 Electron + 真点击），
 * 受限环境里只能 `RESULT SKIP`。于是每轮新增的渲染层断言都"没跑过"——
 * 而**没跑过的断言等于没有**（2026-09-28 那个 `if (draggingId)` 的 ref 裸用，
 * 就是这么漏出去、被用户当场抓到的）。
 *
 * 这里用系统自带 Edge/Chrome 的无头模式，加载**同一份构建产物** + **同一个假 preload**，
 * 把界面真的渲染出来，做 DOM 几何 / 计算样式断言。
 * 覆盖面刻意只放「换摆法」这一类纯前端呈现问题（多视图切换）；
 * 真 IPC、真点击、真拖拽仍以 `e2e-renderer.cjs`（Electron）为准 —— 两者互补，不是替代。
 *
 * 由 `scripts/test/e2e-renderer-web.cjs` 注入到生成的 HTML 里（classic script）。
 * 环境里没有 require / module：window.tegula 与 window.__fcTest 由内联的假 preload 提供。
 */
;(async () => {
  const out = []
  let pass = 0
  let fail = 0
  const check = (name, cond, detail) => {
    if (cond) { pass++; out.push('PASS  ' + name) }
    else { fail++; out.push('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s))
  const clickText = (t) => {
    const b = $$('button, .vbtn').find((e) => (e.textContent || '').trim() === t)
    if (!b) return false
    b.click()
    return true
  }
  const waitFor = async (fn, ms, label) => {
    const t0 = Date.now()
    while (Date.now() - t0 < (ms || 5000)) {
      try { if (fn()) return true } catch (e) { /* 还没渲染出来 */ }
      await sleep(40)
    }
    out.push('    （等待超时：' + (label || String(fn)) + '）')
    return false
  }
  const rect = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }

  try {
    // ── 挂载 ────────────────────────────────────────────────────────────
    const mounted = await waitFor(() => !!$('#bar'), 8000, '顶栏出现（渲染层挂载）')
    check('渲染层在无头浏览器里挂载成功（#bar 出现）', mounted)
    check('preload 假后端可用（window.tegula 在）', typeof window.tegula === 'object' && window.tegula !== null)
    check('测试侧只读入口在（window.__fcTest 在）', typeof window.__fcTest === 'object' && window.__fcTest !== null)

    // ══ 看板 · 多视图 ══════════════════════════════════════════════════
    check('能切到「看板」页签', clickText('看板'))
    await sleep(400)

    const sw = (() => {
      const head = $('.pagehead')
      if (!head) return { ok: false }
      return {
        ok: true,
        btns: $$('.pagehead button.vsb').map((b) => ({ t: (b.textContent || '').trim(), on: b.classList.contains('on') })),
        hint: (head.querySelector('.pagehead-hint') || {}).textContent || '',
      }
    })()
    check('★ 看板页头有视图切换器（列视图 / 列表视图），且是真 button',
      sw.ok && sw.btns.length === 2
      && sw.btns.some((b) => b.t.indexOf('列视图') >= 0) && sw.btns.some((b) => b.t.indexOf('列表视图') >= 0),
      JSON.stringify(sw))
    check('★ 默认仍是**旧视图**（列视图高亮、列表视图未选）—— 要的是"旧的可以保留"，不是被换掉',
      sw.ok && sw.btns.some((b) => b.t.indexOf('列视图') >= 0 && b.on)
      && !sw.btns.some((b) => b.t.indexOf('列表视图') >= 0 && b.on),
      JSON.stringify(sw.btns))
    check('  切换器旁有一句说明（不必先点一遍才知道两个摆法差在哪）',
      sw.ok && String(sw.hint).length > 6, String(sw.hint))

    // 默认摆法：列视图
    const colState = {
      cols: $$('#board .col').length,
      cards: $$('#board .col > .card').length,
      list: $$('#board .board-list').length,
    }
    check('  默认渲染的是列视图（有 .col 与卡片，没有 .board-list）',
      colState.cols > 0 && colState.cards > 0 && colState.list === 0, JSON.stringify(colState))

    // 切列表视图
    check('★ 能点到「列表视图」', (() => {
      const b = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('列表视图') >= 0)
      if (!b) return false
      b.click(); return true
    })())
    check('★ 列表视图真的渲染出来（.board-list + 状态分区）',
      await waitFor(() => $$('#board .board-list .blgrp').length > 0, 5000, '列表视图分区'))

    const listState = {
      rows: $$('#board .board-list .brow').length,
      cols: $$('#board .col').length,
      cards: $$('#board .card').length,
      pills: $$('#board .board-list .lpill').map((p) => ({
        label: (p.querySelector('.glabel') || {}).textContent || '',
        n: (p.querySelector('.gn') || {}).textContent || '',
      })),
      heights: $$('#board .board-list .brow').slice(0, 3).map((r) => Math.round(r.getBoundingClientRect().height)),
    }
    check('★ 两种摆法互斥：列表视图里不再挂着列视图那份 DOM（否则勾选/计数/焦点全会翻倍）',
      listState.cols === 0 && listState.cards === 0, JSON.stringify(listState))
    check('★ 摆的是同一批任务（行数 = 卡数，不重不漏）',
      listState.rows === colState.cards && colState.cards > 0,
      'rows=' + listState.rows + ' cards=' + colState.cards)
    check('  分区头 = 状态名 + 条数（与列头同源，不是另算一份）',
      listState.pills.length === colState.cols && listState.pills.every((p) => p.label && /^\d+$/.test(p.n)),
      JSON.stringify(listState.pills))
    check('  行是"一行一条"的紧凑行（≤ 40px，不是卡片堆）',
      listState.heights.length > 0 && listState.heights.every((h) => h <= 40), JSON.stringify(listState.heights))
    // 不横滚：内容宽度没有超出容器（这正是列表视图存在的理由）
    const noHScroll = (() => {
      const b = $('#board')
      return { sw: b.scrollWidth, cw: b.clientWidth }
    })()
    check('★ 列表视图不横向滚动（这正是它相对列视图的价值）',
      noHScroll.sw <= noHScroll.cw + 1, JSON.stringify(noHScroll))

    // 折叠共用
    const pick = () => {
      const vis = (g) => $$('.brow').filter((r) => r.offsetParent !== null && g.contains(r)).length
      return $$('#board .board-list .blgrp').filter((g) => vis(g) > 0)[0] || null
    }
    const g0 = pick()
    const mvLabel = g0 ? (g0.querySelector('.glabel') || {}).textContent || '' : ''
    const beforeVis = g0 ? $$('.brow').filter((r) => r.offsetParent !== null && g0.contains(r)).length : 0
    if (g0) g0.querySelector('.lpill').click()
    await sleep(300)
    const afterVis = (() => {
      const g = $$('#board .board-list .blgrp').find((x) => (x.querySelector('.glabel') || {}).textContent === mvLabel)
      return g ? $$('.brow').filter((r) => r.offsetParent !== null && g.contains(r)).length : -1
    })()
    check('★ 分区头可折叠（复用列视图那套折叠机制，不是列表视图重做一遍）',
      beforeVis > 0 && afterVis === 0, beforeVis + ' → ' + afterVis)
    ;(() => {
      const g = $$('#board .board-list .blgrp').find((x) => (x.querySelector('.glabel') || {}).textContent === mvLabel)
      if (g) g.querySelector('.lpill').click()
    })()
    await sleep(300)
    check('  再点能展开回来（折叠不是单向的）', (() => {
      const g = $$('#board .board-list .blgrp').find((x) => (x.querySelector('.glabel') || {}).textContent === mvLabel)
      return !!g && $$('.brow').filter((r) => r.offsetParent !== null && g.contains(r)).length > 0
    })())

    // 换个摆法不丢功能：点行开详情
    ;(() => { const r = $('#board .board-list .brow'); if (r) r.click() })()
    check('★ 列表视图里点一行照样打开详情（不是"只有列视图能点"）',
      await waitFor(() => !!$('#roverlay'), 5000, '详情浮层'))
    ;(() => { const o = $('#roverlay'); if (o) o.click() })()
    await sleep(200)

    // 换个摆法不丢功能：拖到别的分区 = 改状态
    const dropInfo = (() => {
      const row = $('#board .board-list .brow')
      if (!row) return { ok: false }
      const from = row.closest('.blgrp')
      const target = $$('#board .board-list .blgrp').filter((g) => g !== from)[0]
      if (!target) return { ok: false }
      let dt = null
      try { dt = new DataTransfer() } catch (e) { return { ok: false, err: 'DataTransfer 不可用' } }
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      return { ok: true, id: row.dataset.id, to: (target.querySelector('.glabel') || {}).textContent || '' }
    })()
    check('★ 列表视图里拖一行到别的分区 = 改状态（拖拽没在换摆法时丢掉）',
      dropInfo.ok && await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'moveStatus'), 5000, 'moveStatus'),
      JSON.stringify(dropInfo) + ' | ' + JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'moveStatus').map((c) => c.args)))

    // 选择进真身 prefs
    check('★ 视图选择写进真身 prefs（换 origin 不丢，与分组方式同一套机制）',
      await waitFor(() => window.__fcTest.prefs().fc_board_view === 'list', 4000, 'prefs.fc_board_view'),
      JSON.stringify(window.__fcTest.prefs()))
    check('  localStorage 只当读缓存，两边取值一致（这是"真身"的判据）', (() => {
      try { return localStorage.getItem('fc_board_view') === '"list"' } catch (e) { return false }
    })(), String((() => { try { return localStorage.getItem('fc_board_view') } catch (e) { return '(localStorage 不可用)' } })()))

    // ══ 待办 · 多视图 ══════════════════════════════════════════════════
    check('能切到「待办」页签', clickText('待办'))
    await sleep(400)

    const tsw = (() => {
      const head = $('.pagehead')
      if (!head) return { ok: false }
      return {
        ok: true,
        btns: $$('.pagehead button.vsb').map((b) => ({ t: (b.textContent || '').trim(), on: b.classList.contains('on') })),
        grid: !!$('main.todos-view .todos-list.as-grid'),
      }
    })()
    check('★ 待办页头也有切换器（清单 / 卡片网格）',
      tsw.ok && tsw.btns.some((b) => b.t.indexOf('清单') >= 0) && tsw.btns.some((b) => b.t.indexOf('卡片网格') >= 0),
      JSON.stringify(tsw))
    check('★ 待办默认仍是清单（旧视图），初始不是网格',
      tsw.ok && tsw.btns.some((b) => b.t.indexOf('清单') >= 0 && b.on) && tsw.grid === false, JSON.stringify(tsw))
    check('  待办切换器是**另一套**选项（不是把看板那套原样搬过来）', (() => {
      const h = $('.pagehead')
      return !!h && !/列视图/.test(h.textContent)
    })())

    // 2026-09-29 用户第 1 条：小框（+ 添加）已移除 —— 入口只剩「＋ 新建待办」一个
    check('★ 快速小框已移除，工具栏只剩唯一入口「＋ 新建待办」',
      !$('main.todos-view .todos-ctrls input') &&
      $$('main.todos-view .todos-ctrls button').filter((b) => b.textContent.indexOf('新建待办') >= 0).length === 1 &&
      !$$('main.todos-view .todos-ctrls button').some((b) => b.textContent.indexOf('添加') >= 0))

    // 先造一条长标题待办：3 行不截断这条断言需要真长标题才作数
    ;(() => {
      const nb = $$('main.todos-view .todos-ctrls button').find((b) => b.textContent.indexOf('新建待办') >= 0)
      if (nb) nb.click()
    })()
    await waitFor(() => !!$('#todo-edit-modal textarea'), 4000, '新建弹窗')
    ;(() => {
      const ta = $('#todo-edit-modal textarea')
      if (!ta) return
      ta.value = '多视图断言用：这是一条刻意写得很长的待办标题，用来验证卡片网格里标题最多三行不截断而是换行显示完整'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const sb = $$('#todo-edit-modal button').find((b) => (b.textContent || '').trim() === '保存')
      if (sb) sb.click()
    })()
    await waitFor(() => !$('#todo-edit-modal'), 4000, '弹窗关闭')
    check('  造出一条长标题待办（网格断言就位）',
      await waitFor(() => $$('main.todos-view .todo-item').some((it) => (it.textContent || '').indexOf('最多三行不截断') >= 0), 5000, '长标题待办'))

    // ── 待办行＝两行卡（2026-09-29 用户拍板：「待办行改成两行卡」）──────────
    // 判据：上行标题、下行元信息；标题占满整行；行尾三枚按钮收进一个动作区。
    // 顺带钉住 027 卡点名的「改」字按钮 —— 它此前**只有 opacity + font-size**，
    // 于是 border/background/padding 全靠浏览器默认值（灰底方框 + 黑字）。
    const row2 = (() => {
      const items = $$('main.todos-view .todos-list .todo-item')
      const it = items.filter((i) => (i.textContent || '').indexOf('最多三行不截断') >= 0)[0] || items[0]
      if (!it) return { err: '清单里没有待办行' }
      const ttl = it.querySelector('.todo-title')
      const pri = it.querySelector('.todo-prio')
      const acts = it.querySelector('.todo-acts')
      const edit = it.querySelector('.todo-edit')
      const del = it.querySelector('.todo-del')
      const assign = it.querySelector('.todo-assign')
      const meta = it.querySelector('.todo-line.metas')
      const cs = edit ? getComputedStyle(edit) : null
      const mcs = meta ? getComputedStyle(meta) : null
      return {
        lines: it.querySelectorAll('.todo-line').length,
        ttl: rect(ttl), pri: pri ? rect(pri) : null, card: rect(it),
        acts: acts ? rect(acts) : null,
        meta: meta ? rect(meta) : null,
        metaDir: mcs ? mcs.flexDirection : '',
        metaMb: mcs ? mcs.marginBottom : '',
        editH: cs ? Math.round(parseFloat(cs.height)) : 0,
        editR: cs ? cs.borderRadius : '',
        editBg: cs ? cs.backgroundColor : '',
        actsHasAll: !!acts && !!edit && !!del && !!assign
          && acts.contains(edit) && acts.contains(del) && acts.contains(assign),
      }
    })()
    check('★ 待办行是两行卡：上行标题、下行元信息（优先级/项目/到期）',
      !row2.err && row2.lines >= 2 && !!row2.pri && row2.pri.y > row2.ttl.y + 2, JSON.stringify(row2))
    check('  标题占满整行（不再和一堆按钮抢宽度 —— 这正是"两行卡"的动因）',
      !row2.err && row2.ttl.w > row2.card.w * 0.5, JSON.stringify({ ttl: row2.ttl, card: row2.card }))
    check('★ 行尾三枚按钮收进一个动作区，且按 027 的按钮规范（24 高 / 8 圆角 / 透明底）',
      !row2.err && row2.actsHasAll && row2.editH === 24 && row2.editR === '8px'
      && row2.editBg === 'rgba(0, 0, 0, 0)', JSON.stringify(row2))
    // ⚠ 这条是**实测踩出来的**：第二行原先叫 `.meta`，撞上样式表里那条全局 `.meta`
    //   （详情弹窗的字段组，flex-direction:column）→ 优先级被 align-items:center
    //   顶到行的正中，看着像"两行卡没做出来"。所以这里钉死"横排 + 贴左 + 无下边距"。
    check('★ 第二行是横排且内容贴左（不能撞上全局 .meta 变成竖排居中）',
      !row2.err && row2.metaDir === 'row' && !!row2.meta && !!row2.pri
      && Math.abs(row2.pri.x - row2.meta.x) < 2 && row2.metaMb === '0px',
      JSON.stringify({ dir: row2.metaDir, mb: row2.metaMb, meta: row2.meta, pri: row2.pri }))

    check('★ 能点到「卡片网格」', (() => {
      const b = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('卡片网格') >= 0)
      if (!b) return false
      b.click(); return true
    })())
    check('★ 卡片网格真的渲染出来（033 要的「方块卡片式」）',
      await waitFor(() => !!$('main.todos-view .todos-list.as-grid'), 5000, 'as-grid'))

    const cardLayout = (() => {
      const items = $$('main.todos-view .todos-list.as-grid .todo-item')
      const it = items.filter((x) => (x.textContent || '').indexOf('最多三行不截断') >= 0)[0] || items[0]
      if (!it) return { err: '没有卡片' }
      const chk = it.querySelector('.todo-chk')
      const ttl = it.querySelector('.todo-title')
      const pri = it.querySelector('.todo-prio')
      const cs = getComputedStyle(ttl)
      const list = $('main.todos-view .todos-list')
      return {
        n: items.length,
        display: getComputedStyle(it).display,
        wrap: getComputedStyle(it).flexWrap,
        clamp: cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp'),
        whiteSpace: cs.whiteSpace,
        ttlH: Math.round(ttl.getBoundingClientRect().height),
        cardH: Math.round(it.getBoundingClientRect().height),
        chk: rect(chk), ttl: rect(ttl), pri: pri ? rect(pri) : null, card: rect(it),
        cells: getComputedStyle(list).gridTemplateColumns,
      }
    })()
    check('  卡片是网格排布（多列 auto-fill，不是又一行清单）',
      !cardLayout.err && String(cardLayout.cells).split(' ').length >= 2, JSON.stringify(cardLayout))
    check('★ 标题**独占一行且最多 3 行不截断**（-webkit-line-clamp:3，不是 nowrap 省略号）',
      !cardLayout.err && String(cardLayout.clamp) === '3' && cardLayout.whiteSpace !== 'nowrap'
      && cardLayout.ttl.y > cardLayout.chk.y && cardLayout.ttl.w > cardLayout.card.w * 0.7,
      JSON.stringify({ clamp: cardLayout.clamp, ws: cardLayout.whiteSpace, ttl: cardLayout.ttl, chk: cardLayout.chk }))
    check('★ 长标题真的占了多行（高度 > 单行，仍 ≤ 3 行）',
      !cardLayout.err && cardLayout.ttlH > 20 && cardLayout.ttlH <= 3 * 1.45 * 12.5 + 2,
      'ttlH=' + cardLayout.ttlH + ' cardH=' + cardLayout.cardH)
    check('  优先级在标题**下方**那一行（两行卡布局：上行标题、下行元信息）',
      !cardLayout.err && !!cardLayout.pri
      && cardLayout.pri.y > cardLayout.ttl.y + 4
      && cardLayout.pri.x >= cardLayout.card.x
      && cardLayout.pri.y < cardLayout.card.y + cardLayout.card.h,
      JSON.stringify({ pri: cardLayout.pri, ttl: cardLayout.ttl, card: cardLayout.card }))

    // 网格里功能不丢
    ;(() => { const t = $('main.todos-view .todos-list.as-grid .todo-title'); if (t) t.click() })()
    check('★ 网格里点标题进编辑（卡面不放操作按钮 ≠ 不能改）',
      await waitFor(() => !!$('#todo-edit-modal'), 5000, '待办编辑弹窗'))
    ;(() => {
      const b = $$('#todo-edit-modal button').find((x) => x.textContent.trim() === '取消')
      if (b) b.click()
    })()
    await sleep(250)

    window.__fcTest.reset()
    ;(() => {
      const c = $('main.todos-view .todos-list.as-grid .todo-item .todo-chk')
      if (c) c.click()
    })()
    check('★ 网格里勾选照样写回后端（勾选复用同一个 input，没另做一套）',
      await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'todosToggle' || c.name === 'todosUpdate'), 5000, 'todosToggle'),
      JSON.stringify(window.__fcTest.calls().map((c) => c.name)))
    check('★ 待办视图选择也进真身 prefs',
      await waitFor(() => window.__fcTest.prefs().fc_todo_view === 'grid', 4000, 'prefs.fc_todo_view'),
      JSON.stringify(window.__fcTest.prefs()))

    // ── 收尾：切回默认摆法（后面的用例 / 人眼都按默认摆法看）──────────────
    ;(() => {
      const b = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('清单') >= 0)
      if (b) b.click()
    })()
    await sleep(250)
    clickText('看板')
    await sleep(300)
    ;(() => {
      const b = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('列视图') >= 0)
      if (b) b.click()
    })()
    await sleep(300)
    check('  切回默认摆法后列视图恢复（选择可逆，不是单向开关）',
      $$('#board .col').length > 0 && $$('#board .board-list').length === 0)
    check('  切回后真身也同步回默认值（不是只改了界面）',
      await waitFor(() => window.__fcTest.prefs().fc_board_view === 'cols', 4000, 'prefs 回 cols'),
      JSON.stringify(window.__fcTest.prefs()))

    // ══ 弹药库 · 复制为派工单（卡 031 六字段 schema）══════════════════════
    // 真点右键菜单 → 真读走主进程剪贴板通道 → 断言拼出来的文本。
    // 三条铁律现场验：不新建模块（用既有任务卡）· 字段进模板文本不进 JSON · **零智能不派发**。
    const BOARD_TAB = () => clickText('看板')
    BOARD_TAB()
    await sleep(400)

    const CARD_SEL = '#board .col > .card, #board .board-list .brow'
    /** 右键一张卡并等菜单渲染出来（Vue 更新是异步的：同步读 DOM 会读到旧状态） */
    const openCardMenuFor = async (needle) => {
      const row = $$(CARD_SEL).filter((r) => (r.textContent || '').indexOf(needle) >= 0)[0]
      if (!row) return false
      window.__fcTest.reset()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 200 }))
      await sleep(180)
      const m = $('.ctx-menu')
      return !!m && (m.textContent || '').indexOf('复制为派工单') >= 0
    }
    const dispatchText = () => {
      const cs = window.__fcTest.calls().filter((c) => c.name === 'clipboardWriteText')
      return cs.length ? String(cs[cs.length - 1].args[0] || '') : ''
    }
    /** 走完整用户路径：右键 → 点「复制为派工单」→ 读回复制内容 */
    const copyFor = async (needle) => {
      if (!(await openCardMenuFor(needle))) return ''
      const b = $$('.ctx-menu button').filter((x) => (x.textContent || '').indexOf('复制为派工单') >= 0)[0]
      if (!b) return ''
      b.click()
      await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'clipboardWriteText'), 4000, 'clipboardWriteText')
      await sleep(150)
      return dispatchText()
    }

    check('★ 任务卡右键菜单里有「复制为派工单」（弹药库的出口动作）',
      await openCardMenuFor('演示任务'), String(($('.ctx-menu') || {}).textContent || '').slice(0, 120))

    const DISPATCH = await copyFor('演示任务')
    check('  点它真的走主进程剪贴板通道（渲染层不许有裸 navigator.clipboard）',
      DISPATCH.length > 0 && window.__fcTest.calls().some((c) => c.name === 'clipboardWriteText'))
    check('  派工单非空且带卡标题', DISPATCH.length > 300 && DISPATCH.indexOf('演示任务') >= 0, 'len=' + DISPATCH.length)
    check('★ 六字段一个不少：任务目标/工作目录范围/项目事实放置位置/抽象档位/验收判据/驳回上限',
      ['## 1 任务目标', '## 2 工作目录 / 范围', '## 3 项目事实 / 放置位置', '## 4 抽象档位', '## 5 验收判据', '## 6 驳回上限']
        .every((h) => DISPATCH.indexOf(h) >= 0), DISPATCH.slice(0, 90))
    check('★ 纪律段齐：约束卡七条 + 验收四条 + 驳回纪律 + 分诊',
      ['## 约束卡', '## 验收四条', '## 驳回纪律', '## 分诊'].every((h) => DISPATCH.indexOf(h) >= 0)
      && ['只做指定那一步', '范围写死', '自行续做', '实测', '否决', '分批跑', '第三次暴雷'].every((k) => DISPATCH.indexOf(k) >= 0),
      DISPATCH.slice(-160))
    check('  卡内容原文照贴（不改写、不总结）', DISPATCH.indexOf('## 卡内容（原文，不改写、不总结）') >= 0 && DISPATCH.indexOf('正文') >= 0)
    check('★ 判据留空由人写（预填目标会诱发锚定效应 —— 硬规则：只填已知的）',
      DISPATCH.indexOf('留空由人亲手写') >= 0)
    check('  待派状态标注正确（该卡状态=待办）', /弹药库状态：待派/.test(DISPATCH), DISPATCH.split('\n')[3] || '')
    check('  驳回上限取默认 2', /## 6 驳回上限\n2 轮/.test(DISPATCH), DISPATCH.split('## 6 驳回上限')[1]?.slice(0, 24) || '')

    // 零智能：只读剪贴板，没有触发任何派发/执行通道
    const copiedCalls = window.__fcTest.calls().map((c) => c.name)
    check('★ 零智能不派发：这一步只写了剪贴板，没碰任何执行/派发通道',
      copiedCalls.indexOf('clipboardWriteText') >= 0
      && !copiedCalls.some((n) => /dispatch|execute|spawn|run|launch/i.test(n)),
      JSON.stringify(copiedCalls.slice(0, 8)))

    // 已派 / 归档 两种状态的标记
    const D2 = await copyFor('未归属任务')   // 夹具里它是「进行中」
    check('  已派状态标注正确（该卡状态=进行中）', /弹药库状态：已派/.test(D2), (D2.split('\n')[3] || '').slice(0, 40))

    clickText('归档')
    await sleep(500)
    const archRow = $$(CARD_SEL)[0]
    check('  归档视图里有卡可点（夹具）', !!archRow)
    let D3 = ''
    if (archRow) {
      window.__fcTest.reset()
      archRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 200 }))
      await sleep(180)
      const b3 = $$('.ctx-menu button').filter((x) => (x.textContent || '').indexOf('复制为派工单') >= 0)[0]
      if (b3) { b3.click(); await sleep(300); D3 = dispatchText() }
    }
    check('★ 归档状态标注正确（按路径判定，不看 status —— 方寸唯一权威判据）',
      /弹药库状态：归档/.test(D3), (D3.split('\n')[3] || JSON.stringify(D3.slice(0, 60))).slice(0, 60))

    BOARD_TAB()
    await sleep(400)

    // ══ 顶栏「排序」下拉（2026-09-29 修的死控件）══════════════════════════
    // 修前：`sortMode` 只在模板里 v-model 绑了，**全代码零引用** —— 换下拉毫无反应。
    // 夹具故意把「待办」列两张卡的 created / updated 错开，三种顺序两两不同：
    //   默认 001→002 · 按 updated 倒序 002→001 · 按 created 倒序 001→002
    const pickSort = async (v) => {
      const sel = $$('#bar select').filter((s) => Array.prototype.some.call(s.options, (o) => o.value === v))[0]
      if (!sel) return false
      sel.value = v
      sel.dispatchEvent(new Event('change'))
      await sleep(320)
      return sel.value === v
    }
    const statusColOrder = () => {
      const col = $$('#board .col').filter((c) => ((c.querySelector('h3') || {}).textContent || '').indexOf('待办') >= 0)[0]
      if (!col) return []
      return Array.prototype.map.call(col.querySelectorAll('.card'), (c) => c.dataset.id || '?')
    }
    check('  顶栏排序下拉就是那三个值（活跃优先 / 最近更新 / 创建时间）',
      $$('#bar select').some((s) => s.options.length === 3
        && Array.prototype.every.call(s.options, (o) => ['active', 'updated', 'created'].indexOf(o.value) >= 0)),
      JSON.stringify($$('#bar select').map((s) => Array.prototype.map.call(s.options, (o) => o.value)).filter((a) => a.indexOf('active') >= 0)))
    const ordDefault = statusColOrder()
    check('  默认「活跃优先」：待办列按后端顺序（夹具 001 → 002）',
      ordDefault.join(',') === 'task-demo-001,task-demo-002', JSON.stringify(ordDefault))

    check('  能切到「最近更新」', await pickSort('updated'))
    const ordUpd = statusColOrder()
    check('★ 按「最近更新」真的重排了（002 的 updated 更新 → 排到前面）',
      ordUpd.join(',') === 'task-demo-002,task-demo-001', JSON.stringify(ordUpd))

    check('  能切到「最新创建」', await pickSort('created'))
    const ordCre = statusColOrder()
    check('★ 按「最新创建」用的是 created 而不是 updated（001 的 created 更新 → 它排前面）',
      ordCre.join(',') === 'task-demo-001,task-demo-002', JSON.stringify(ordCre))

    check('  切回「活跃优先」', await pickSort('active'))
    check('  恢复后与初始一致（排序可逆）', statusColOrder().join(',') === ordDefault.join(','), JSON.stringify(statusColOrder()))
    check('  排序选择进了真身 prefs（与分组方式同一套机制，换 origin 不丢）',
      ['active', 'updated', 'created'].indexOf(String(window.__fcTest.prefs().fc_board_sort)) >= 0,
      JSON.stringify(window.__fcTest.prefs().fc_board_sort))

    // ══ 日历 · 格子内折叠（2026-09-29 用户选「改法 A」）════════════════════
    // 035 卡原话「看起来很密集很让人畏惧」。底部那排横条墙上一轮已收成一行摘要，
    // 剩下的密在**格子内部** —— 夹具把 4 条事件压在 9-30（001 + 011/012/013）。
    check('能切到「日历」页签', clickText('日历'))
    await sleep(700)
    const calCellOf = () => $$('main.calendar-view .calcell')
      .filter((c) => (c.textContent || '').indexOf('日历密度样例一') >= 0)[0]
    const cal0 = (() => {
      const c = calCellOf()
      if (!c) return { err: '没找到 9-30 那格（夹具日期对不上？）' }
      return {
        evs: c.querySelectorAll('.cev').length,
        more: ((c.querySelector('.cal-cell-more') || {}).textContent || '').trim(),
      }
    })()
    check('★ 一天多条时格子里只铺 2 条，剩下折成「+N 条」（改法 A）',
      !cal0.err && cal0.evs === 2 && /\+2 条/.test(cal0.more), JSON.stringify(cal0))
    check('★ 点「+N 条」就地铺满这一天（不跳页、不弹窗）', await (async () => {
      const c = calCellOf()
      const b = c && c.querySelector('.cal-cell-more')
      if (!b) return false
      b.click()
      return waitFor(() => {
        const c2 = calCellOf()
        return !!c2 && c2.querySelectorAll('.cev').length >= 4 && !!c2.querySelector('.cal-cell-more.less')
      }, 4000, '日历展开')
    })())
    check('  再点「收起」回到 2 条（折叠不是单向开关）', await (async () => {
      const c = calCellOf()
      const b = c && c.querySelector('.cal-cell-more.less')
      if (!b) return false
      b.click()
      return waitFor(() => {
        const c2 = calCellOf()
        return !!c2 && c2.querySelectorAll('.cev').length === 2 && !c2.querySelector('.cal-cell-more.less')
      }, 4000, '日历收起')
    })())
    check('  单条/空白的格子不长出「+N 条」（只在真的挤的时候才出现）',
      await (async () => {
        const others = $$('main.calendar-view .calcell').filter((c) => (c.textContent || '').indexOf('日历密度样例一') < 0)
        return others.every((c) => c.querySelectorAll('.cev').length > 2 || !c.querySelector('.cal-cell-more'))
      })())

    // ══ 项目页签 · 两种新摆法（2026-09-29 用户：「两种视图都要，做成可自选切换」）══
    // 003 卡原话「只是个大号看板入口，不是项目管理」。三个摆法（含旧的项目墙）互斥渲染。
    check('能切到「项目」页签', clickText('项目'))
    await sleep(700)
    const pvTabs = () => $$('.pagehead button.vsb')
      .map((b) => ({ t: (b.textContent || '').trim(), on: b.classList.contains('on') }))
    check('★ 项目页签多出两个可选摆法（概览卡 / 主从）',
      pvTabs().some((b) => b.t.indexOf('概览卡') >= 0) && pvTabs().some((b) => b.t.indexOf('主从') >= 0),
      JSON.stringify(pvTabs()))
    check('★ 默认仍是**旧的项目墙**（旧视图永远是默认，谁都不必重新学一遍）',
      pvTabs().some((b) => b.t.indexOf('项目墙') >= 0 && b.on)
      && $$('#board.pv .pvgrid').length === 1
      && $$('#board.pv .ovgrid').length === 0 && $$('#board.pv .pv-ms').length === 0, JSON.stringify(pvTabs()))
    // 2026-09-29 修：项目页签此前**从不加载方针状态**（`loadPolicyMap()` 只在打开设置页
    // 与结构地图一览时调用）→ 没开过设置的会话里，卡片永远写着「＋ 立项目方针」。
    // 那不是显示瑕疵，是**界面在说假话**（夹具里 demo 明明白白填了方针）。
    const tileTxt = () => (($('#board.pv .tile:not(.tile-add)') || {}).textContent || '')
    check('★ 方针三态进门就准（demo 在夹具里已填方针 → 项目墙上必须说"方针已立"）',
      await waitFor(() => tileTxt().indexOf('方针已立') >= 0, 4000, '方针三态'), tileTxt().slice(0, 90))

    check('能点到「概览卡」', (() => {
      const b = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('概览卡') >= 0)
      if (!b) return false
      b.click(); return true
    })())
    check('★ 概览卡渲染出来，且项目墙**不再同时挂在 DOM 里**（两种摆法互斥）',
      await waitFor(() => $$('#board.pv .ocard:not(.ocard-add)').length >= 2
        && $$('#board.pv .pvgrid').length === 0 && $$('#board.pv .pv-ms').length === 0, 5000, '概览卡'))
    const ov = (() => {
      const cards = $$('#board.pv .ocard:not(.ocard-add)')
      const c = cards.filter((x) => (x.textContent || '').indexOf('演示项目') >= 0)[0] || cards[0]
      if (!c) return { err: '没有概览卡' }
      return {
        cards: cards.length,
        segs: c.querySelectorAll('.stack i').length,
        leg: c.querySelectorAll('.legend span').length,
        acts: c.querySelectorAll('.oacts button').length,
        txt: (c.textContent || '').replace(/\s+/g, ' ').slice(0, 200),
      }
    })()
    check('★ 状态分布条真的按状态分段（段数＝图例条数，不是画着好看的假条）',
      !ov.err && ov.segs >= 2 && ov.segs === ov.leg, JSON.stringify(ov))
    check('★ 缺口入口在卡上（方针 / 结构地图 / 任务）', !ov.err && ov.acts >= 3, JSON.stringify(ov))
    check('  工作目录顺带显示（演示项目在 registry 里登记了 repo）',
      !ov.err && ov.txt.indexOf('E:/CODE/mock/demo') >= 0, ov.txt)
    check('★ 概览卡上的方针三态同样准（不能对着已填的方针说"立方针"）',
      !ov.err && ov.txt.indexOf('立方针') < 0 && ov.txt.indexOf('方针') >= 0, ov.txt)

    check('能点到「主从」', (() => {
      const b = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('主从') >= 0)
      if (!b) return false
      b.click(); return true
    })())
    check('★ 主从渲染出来：左侧项目列表 + 右侧详情',
      await waitFor(() => $$('#board.pv .pv-ms .ms-li').length >= 2 && !!$('#board.pv .ms-detail .ocard'), 5000, '主从'))
    check('★ 点左列另一个项目，右侧详情跟着换（不是一张静态图）', await (async () => {
      const target = $$('#board.pv .ms-li').filter((x) => (x.textContent || '').indexOf('第二个项目') >= 0)[0]
      if (!target) return false
      target.click()
      return waitFor(() => {
        const d = $('#board.pv .ms-detail')
        return !!d && (d.textContent || '').indexOf('第二个项目') >= 0
      }, 4000, '主从切换')
    })())
    check('★ 三个摆法互斥：主从出现时项目墙与概览卡都不在 DOM 里',
      $$('#board.pv .pvgrid').length === 0 && $$('#board.pv .pv-ms').length === 1,
      'pvgrid=' + $$('#board.pv .pvgrid').length + ' ms=' + $$('#board.pv .pv-ms').length)
    check('★ 选择进了真身 prefs（fc_pv_view）—— 换 origin 不丢',
      window.__fcTest.prefs().fc_pv_view === 'master',
      JSON.stringify(window.__fcTest.prefs().fc_pv_view))
    check('  切回项目墙后旧摆法原样回来（可逆，不是单向开关）', await (async () => {
      const b = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('项目墙') >= 0)
      if (!b) return false
      b.click()
      const back = await waitFor(() => $$('#board.pv .tile').length >= 2 && $$('#board.pv .pv-ms').length === 0, 4000, '切回项目墙')
      return back && window.__fcTest.prefs().fc_pv_view === 'tiles'
    })())

    // ══ 日志 · 接力链（2026-09-29 第 3 条方案二）═══════════════════════
    await sleep(300)
    check('能切到「日志」页签', clickText('日志'))
    await sleep(500)
    // 阴性对照（先造「没有链」的数据）：按链视图不该冒出链头 —— 防「按链=全都框起来」的假实现
    window.__fcTest.setLogs([
      { id: 'log-x1', title: '无链甲', content: 'a', status: 'active', project: 'demo', created: '2026-09-28T00:00:00.000Z' },
      { id: 'log-x2', title: '无链乙', content: 'b', status: 'completed', project: 'demo', created: '2026-09-27T00:00:00.000Z' },
    ])
    clickText('看板'); await sleep(400); check('重进日志页（无链数据）', clickText('日志')); await sleep(500)
    check('「按链」开关可点', clickText('按链'))
    await sleep(500)
    check('★ 阴性对照：没有链时不画链头（不是「按链 = 全都框起来」）',
      $$('.chain-header').length === 0, 'chain-header=' + $$('.chain-header').length)

    // 灌入真链：A(已完成) → B(进行中, continuesFrom A)，外加一条孤立 C
    window.__fcTest.setLogs([
      { id: 'log-relay-a', title: '接力源·问题清单', content: '列出14条问题', status: 'completed', project: 'demo',
        created: '2026-09-27T00:00:00.000Z', nextSteps: '清单勾选状态回写、批注导出格式、跨文件引用跳转',
        taskIds: ['task-relay'], agentName: 'hermes' },
      { id: 'log-relay-b', title: '接力后·功能性调整', content: '改三处', status: 'active', running: true, project: 'demo',
        created: '2026-09-29T00:00:00.000Z', continueFrom: 'log-relay-a', agentName: 'hermes' },
      { id: 'log-relay-c', title: '孤立日志', content: '与链无关', status: 'active', project: 'demo',
        created: '2026-09-28T00:00:00.000Z' },
    ])
    clickText('看板'); await sleep(400); clickText('日志'); await sleep(600)
    check('★★ 按链视图：链头出现（链名 旧 → 新 + 段数）',
      await waitFor(() => {
        const h = $('.chain-header')
        return !!h && h.textContent.indexOf('接力源·问题清单 → 接力后·功能性调整') >= 0 && h.textContent.indexOf('2 段') >= 0
      }, 4000, 'chain-header'))
    check('★★ 链成员被竖轨包住（.chain-rail 里两张卡）',
      $$('.chain-rail .log-card').length === 2, 'rail cards=' + $$('.chain-rail .log-card').length)
    check('★ 链头两个动作在（从链尾继续 / 复制链 ID）',
      (() => { const h = $('.chain-header'); return !!h && h.textContent.indexOf('从链尾继续') >= 0 && h.textContent.indexOf('复制链 ID') >= 0 })())
    check('★ 孤立日志单条呈现：卡还在、但不在任何链里',
      $$('.log-card').some(c => (c.textContent || '').indexOf('孤立日志') >= 0) &&
      $$('.chain-header').length === 1 &&
      $$('.log-card').filter(c => (c.textContent || '').indexOf('孤立日志') >= 0).every(c => !c.closest('.chain-rail')),
      'headers=' + $$('.chain-header').length)
    check('★ 卡面链标签 ⛓ 续自（挂在被接力的那张卡上）',
      $$('.chain-tag').length >= 1 &&
      $$('.log-card').some(c => (c.textContent || '').indexOf('续自 log-relay-a') >= 0))
    check('★★ 按链选择落真身 prefs（fc_logs_view_mode = chain，换 origin 不丢）',
      window.__fcTest.prefs().fc_logs_view_mode === 'chain',
      JSON.stringify(window.__fcTest.prefs().fc_logs_view_mode))

    // 切回分区：旧视图原样恢复（加视图不改旧的）
    check('切回「分区」', clickText('分区'))
    await sleep(500)
    check('★★ 分区视图恢复：分区头回来了、链头消失',
      $$('.log-group-sep').length >= 1 && $$('.chain-header').length === 0,
      'sep=' + $$('.log-group-sep').length + ' chain=' + $$('.chain-header').length)
    check('  链标签在分区视图同样可见（链关系不只按链才有）',
      $$('.chain-tag').length >= 1)
    check('  pref 回 groups', window.__fcTest.prefs().fc_logs_view_mode === 'groups',
      JSON.stringify(window.__fcTest.prefs().fc_logs_view_mode))

    // 接力对话框（完成态卡入口）
    check('★ 完成态卡有「⏭ 从这里继续」', $$('.relay-btn').length >= 1, 'relay-btn=' + $$('.relay-btn').length)
    const relayBtn = $('.relay-btn')
    if (relayBtn) relayBtn.click()
    check('★★ 点开接力对话框（#relay-modal 出现）',
      await waitFor(() => !!$('#relay-modal'), 3000, 'relay-modal'))
    check('★ 源摘要条显示源日志 ID',
      !!$('.rs-id') && $('.rs-id').textContent.trim() === 'log-relay-a',
      $('.rs-id') ? $('.rs-id').textContent : 'no .rs-id')
    check('★★ 下一步已从源带入（对话框预填）',
      !!$('#relay-modal textarea') && $('#relay-modal textarea').value.indexOf('清单勾选状态回写') >= 0,
      $('#relay-modal textarea') ? $('#relay-modal textarea').value.slice(0, 60) : 'no textarea')
    check('★ 两个出清开关默认值：源归档 ✓ / 源任务置完成 ✗',
      (() => {
        const opts = $$('#relay-modal .relay-opt input')
        return opts.length === 2 && opts[0].checked === true && opts[1].checked === false
      })(), 'opts=' + $$('#relay-modal .relay-opt input').map(o => o.checked).join(','))
    check('★ 关联任务默认勾选非终态的（task-relay 不在完成态 → 勾上）',
      (() => { const c = $('#relay-modal .log-task-opt input'); return !!c && c.checked === true })())
    check('★ 三按钮：取消 / 创建 / 创建并开跑',
      (() => {
        const t = $$('#relay-modal .acts button').map(b => (b.textContent || '').trim())
        return t.indexOf('取消') >= 0 && t.indexOf('创建') >= 0 && t.indexOf('创建并开跑') >= 0
      })(), $$('#relay-modal .acts button').map(b => b.textContent.trim()).join('|'))
    const cancelBtn = $$('#relay-modal .acts button').find(b => (b.textContent || '').trim() === '取消')
    if (cancelBtn) cancelBtn.click()
    check('取消后对话框关闭', await waitFor(() => !$('#relay-modal'), 2000, 'relay 关闭'))

    // 链头「从链尾继续」：源 = 链尾（最新的那格）
    check('按链后再从链头接力', clickText('按链'))
    await sleep(500)
    const tailBtn = $$('.chain-header button').find(b => (b.textContent || '').indexOf('从链尾继续') >= 0)
    if (tailBtn) tailBtn.click()
    check('★★ 链头「＋ 从链尾继续」→ 对话框的源是链尾（log-relay-b）',
      await waitFor(() => !!$('#relay-modal') && $('.rs-id') && $('.rs-id').textContent.trim() === 'log-relay-b', 3000, '链尾接力'),
      $('#relay-modal') && $('.rs-id') ? $('.rs-id').textContent : '未打开')
    const cancel2 = $$('#relay-modal .acts button').find(b => (b.textContent || '').trim() === '取消')
    if (cancel2) cancel2.click()
    await waitFor(() => !$('#relay-modal'), 2000, 'relay 关闭 2')

    // ══ 待办 · 多选（2026-09-30 用户补充：「待办和回收站也加入多选」）══════
    await sleep(300)
    window.__fcTest.setTodos([
      { id: 'td-1', title: '多选断言：第一件事', priority: '高', done: false, created: 1 },
      { id: 'td-2', title: '多选断言：第二件事', priority: '中', done: false, created: 2 },
      { id: 'td-3', title: '多选断言：已完成的旧事', priority: '低', done: true, created: 3 },
    ])
    clickText('看板'); await sleep(400)
    check('能切到「待办」页签（多选断言）', clickText('待办'))
    check('待办 3 条渲染出来', await waitFor(() => $$('.todos-view .todo-item').length === 3, 4000, 'todos seed'),
      'items=' + $$('.todos-view .todo-item').length)
    check('默认非批量：无批量栏', $$('.todos-view .batch-bar').length === 0)
    const todoBatchBtn = () => $$('.todos-ctrls .batch-mode-btn').find(b => (b.textContent || '').indexOf('多选') >= 0)
    if (todoBatchBtn()) todoBatchBtn().click()
    check('★ 点「☑ 多选」出批量栏（与看板/日志同一套）',
      await waitFor(() => $$('.todos-view .batch-bar').length === 1, 3000, 'todo batch-bar'))
    const tItems = $$('.todos-view .todo-item')
    tItems[0].click(); await sleep(150); tItems[1].click(); await sleep(250)
    check('★★ 点卡片即勾选（selected 类 2 张 + 栏内计数「已选 2」）',
      $$('.todos-view .todo-item.selected').length === 2 &&
      (($('.todos-view .batch-bar .batch-count') || {}).textContent || '').indexOf('已选 2') >= 0,
      'sel=' + $$('.todos-view .todo-item.selected').length + ' count=' + (($('.todos-view .batch-bar .batch-count') || {}).textContent || ''))
    check('★ 批量栏五按钮齐全（全选/批量完成/取消完成/批量删除/取消）',
      (() => {
        const t = $$('.todos-view .batch-bar button').map(b => (b.textContent || '').trim())
        return ['全选', '批量完成', '取消完成', '批量删除', '取消'].every(x => t.some(y => y.indexOf(x) >= 0))
      })(), $$('.todos-view .batch-bar button').map(b => b.textContent.trim()).join('|'))
    check('★ 批量模式下隐藏单条动作（改/×/📅 三个按钮不可见）',
      $$('.todos-view .todo-acts').length === 3 &&
      $$('.todos-view .todo-acts').every(e => e.getClientRects().length === 0),
      'acts=' + $$('.todos-view .todo-acts').length)
    // 全选 → 批量完成（不需 confirm，直接执行）
    const selAll = $$('.todos-view .batch-bar button').find(b => (b.textContent || '').trim() === '全选')
    if (selAll) selAll.click()
    await sleep(250)
    check('全选：3 张全勾上', $$('.todos-view .todo-item.selected').length === 3,
      'sel=' + $$('.todos-view .todo-item.selected').length)
    const doneBtn = $$('.todos-view .batch-bar button').find(b => (b.textContent || '').trim() === '批量完成')
    if (doneBtn) doneBtn.click()
    check('★★ 批量完成：todosUpdate × 3 落到真身调用记录',
      await waitFor(() => window.__fcTest.calls().filter(c => c.name === 'todosUpdate' && c.args && c.args[1] && c.args[1].done === true).length >= 3, 4000, 'todosUpdate×3'),
      JSON.stringify(window.__fcTest.calls().filter(c => c.name === 'todosUpdate').map(c => c.args)))
    check('★★ 批量完成后：全部标为已完成（列表刷新）+ 自动退出多选',
      await waitFor(() => $$('.todos-view .todo-item.done').length === 3 && $$('.todos-view .batch-bar').length === 0, 4000, 'done+exit'),
      'done=' + $$('.todos-view .todo-item.done').length + ' bar=' + $$('.todos-view .batch-bar').length)
    // 批量删除（confirm 需 stub —— 无头浏览器里原生 confirm 恒 false）
    if (todoBatchBtn()) todoBatchBtn().click()
    await sleep(250)
    const selAll2 = $$('.todos-view .batch-bar button').find(b => (b.textContent || '').trim() === '全选')
    if (selAll2) selAll2.click()
    await sleep(250)
    const origConfirm = window.confirm
    window.confirm = () => true
    const delBtn = $$('.todos-view .batch-bar button').find(b => (b.textContent || '').trim() === '批量删除')
    if (delBtn) delBtn.click()
    check('★★ 批量删除（已确认）：todosDelete × 3、列表清空、退出多选',
      await waitFor(() => {
        const d = window.__fcTest.calls().filter(c => c.name === 'todosDelete').length
        return d >= 3 && $$('.todos-view .todo-item').length === 0 && $$('.todos-view .batch-bar').length === 0
      }, 4000, 'todosDelete×3'),
      'del=' + window.__fcTest.calls().filter(c => c.name === 'todosDelete').length +
      ' items=' + $$('.todos-view .todo-item').length)
    window.confirm = origConfirm

    // ══ 回收站 · 多选（同日同条）══════════════════════════════════════════
    window.__fcTest.setTrash([
      { name: 'task-trash-a.md', id: 'task-trash-a', title: '回收站多选：甲', status: '完成', project: '', bytes: 2048, mtime: Date.now() },
      { name: 'task-trash-b.md', id: 'task-trash-b', title: '回收站多选：乙', status: '待办', project: 'demo', bytes: 1024, mtime: Date.now() },
    ])
    clickText('看板'); await sleep(400)
    check('能切到「回收站」页签（多选断言）', clickText('回收站'))
    check('回收站 2 项渲染出来', await waitFor(() => $$('.trash-view .trash-item').length === 2, 4000, 'trash seed'),
      'items=' + $$('.trash-view .trash-item').length)
    check('默认非批量：无批量栏、动作按钮可见', $$('.trash-view .batch-bar').length === 0 &&
      $$('.trash-view .trash-actions').every(e => e.getClientRects().length > 0))
    const trashBatchBtn = () => $$('.trash-header .batch-mode-btn').find(b => (b.textContent || '').indexOf('多选') >= 0)
    if (trashBatchBtn()) trashBatchBtn().click()
    check('★ 回收站点「☑ 多选」出批量栏',
      await waitFor(() => $$('.trash-view .batch-bar').length === 1, 3000, 'trash batch-bar'))
    const tRows = $$('.trash-view .trash-main')
    tRows[0].click(); await sleep(150); tRows[1].click(); await sleep(250)
    check('★★ 点条目即勾选（selected 2 + 计数）',
      $$('.trash-view .trash-item.selected').length === 2 &&
      (($('.trash-view .batch-bar .batch-count') || {}).textContent || '').indexOf('已选 2') >= 0,
      'sel=' + $$('.trash-view .trash-item.selected').length)
    // ── 2026-09-30 卡 task-20260930-005（用户第 5 条）：不灵敏 / 看不清选中 ──
    // ① 热区 = 整行：直接点 .trash-item 本体（行 padding 区，原来 .trash-main 之外是死区）
    const tItem = $$('.trash-view .trash-item')[0]
    const selBefore = $$('.trash-view .trash-item.selected').length
    if (tItem) { tItem.click(); await sleep(150) }
    check('★★ 整行可点：点 .trash-item 本体（原死区）也切换选中',
      $$('.trash-view .trash-item.selected').length !== selBefore,
      `before=${selBefore} after=${$$('.trash-view .trash-item.selected').length}`)
    if (tItem) { tItem.click(); await sleep(150) } // 点回来
    check('★ 再点同一行取消选中（来回切换不卡壳）',
      $$('.trash-view .trash-item.selected').length === selBefore,
      'sel=' + $$('.trash-view .trash-item.selected').length)
    // ② 显式勾选框：每行一个，选中态 class=on（不再只靠底色猜）
    check('★★ 批量模式每行有显式勾选框 .trash-batch-chk',
      $$('.trash-view .trash-batch-chk').length === 2)
    if (tItem) { tItem.click(); await sleep(150) }
    check('★ 勾选框随选中点亮（.on）',
      $$('.trash-view .trash-batch-chk.on').length === 1,
      'on=' + $$('.trash-view .trash-batch-chk.on').length)
    // ③ 选中态压过 hover：悬停时不得退回 .trash-item:hover 的灰边（#d9d2ea），光环保留
    // 注意时序：上面每条检查都靠「点一下切换」，到这一步 item0 是**未选中**的，先点选中。
    if (tItem) {
      if (!tItem.classList.contains('selected')) { tItem.click(); await sleep(150) }
      tItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      const cs = window.getComputedStyle(tItem)
      check('★★ 悬停时选中态仍在（不被 .trash-item:hover 盖掉）',
        tItem.classList.contains('selected') &&
        cs.borderTopColor !== 'rgb(217, 210, 234)' && (cs.boxShadow || '').indexOf('rgba(100, 80, 200') >= 0,
        `sel=${tItem.classList.contains('selected')} border=${cs.borderTopColor} shadow=${cs.boxShadow}`)
      // 不在这里「复原取消选中」—— 手动复原会把选中态打成 1 项，下面「批量还原」断言
      // 期望 2 项全选。此刻恰好回到全选态（2 项），直接交给后续断言。
    }
    check('★ 批量模式下隐藏单条动作（↩ 还原 / 🗑 彻底删除）',
      $$('.trash-view .trash-actions').length === 2 &&
      $$('.trash-view .trash-actions').every(e => e.getClientRects().length === 0))
    check('★ 批量栏三按钮（全选/批量还原/彻底删除）+ 取消',
      (() => {
        const t = $$('.trash-view .batch-bar button').map(b => (b.textContent || '').trim())
        return ['全选', '批量还原', '彻底删除', '取消'].every(x => t.some(y => y.indexOf(x) >= 0))
      })(), $$('.trash-view .batch-bar button').map(b => b.textContent.trim()).join('|'))
    // 批量还原（不需 confirm）
    const resBtn = $$('.trash-view .batch-bar button').find(b => (b.textContent || '').trim() === '批量还原')
    if (resBtn) resBtn.click()
    check('★★ 批量还原：trashRestore × 2、清空回收站、退出多选',
      await waitFor(() => {
        const n = window.__fcTest.calls().filter(c => c.name === 'trashRestore').length
        return n >= 2 && $$('.trash-view .trash-item').length === 0 && $$('.trash-view .batch-bar').length === 0
      }, 4000, 'trashRestore×2'),
      'restore=' + window.__fcTest.calls().filter(c => c.name === 'trashRestore').length)
    // 批量彻底删除（confirm 需 stub）
    window.__fcTest.setTrash([
      { name: 'task-trash-c.md', id: 'task-trash-c', title: '回收站多选：丙', status: '待办', project: '', bytes: 512, mtime: Date.now() },
      { name: 'task-trash-d.md', id: 'task-trash-d', title: '回收站多选：丁', status: '待办', project: '', bytes: 256, mtime: Date.now() },
    ])
    clickText('看板'); await sleep(400); clickText('回收站'); await sleep(500)
    if (trashBatchBtn()) trashBatchBtn().click()
    await sleep(250)
    const selAllT = $$('.trash-view .batch-bar button').find(b => (b.textContent || '').trim() === '全选')
    if (selAllT) selAllT.click()
    await sleep(250)
    const origConfirm2 = window.confirm
    window.confirm = () => true
    const purgeBtn = $$('.trash-view .batch-bar button').find(b => (b.textContent || '').trim() === '彻底删除')
    if (purgeBtn) purgeBtn.click()
    check('★★ 批量彻底删除（已确认）：trashPurge × 2、清空、退出多选',
      await waitFor(() => {
        const n = window.__fcTest.calls().filter(c => c.name === 'trashPurge').length
        return n >= 2 && $$('.trash-view .trash-item').length === 0 && $$('.trash-view .batch-bar').length === 0
      }, 4000, 'trashPurge×2'),
      'purge=' + window.__fcTest.calls().filter(c => c.name === 'trashPurge').length)
    window.confirm = origConfirm2

    // ③ 无未捕获错误：main.ts 把 window.onerror 广播成 fc-app-error，App 顶部会出错误条
    check('渲染层没有未捕获错误（顶部错误条为空）', $$('.errbar').length === 0,
      String((($('.errbar-msg') || {}).textContent || '').slice(0, 160)))
  } catch (e) {
    fail++
    out.push('FAIL  断言脚本自身异常 :: ' + (e && e.stack ? e.stack : e))
  }

  // ⚠ 标记必须**拼接**出来，不能写成连续字面量：
  //   `--dump-dom` 会把本脚本的源码也 dump 出来，源码里若出现完整的标记，
  //   运行器会先匹配到"脚本源码里的那一对"，取出一段 JS 片段当结果（实测踩过）。
  const MB = '[[FC' + '-BEGIN]]'
  const ME = '[[FC' + '-END]]'
  const pre = document.createElement('pre')
  pre.id = 'FC_WEB_RESULT'
  pre.textContent = '\n' + MB + '\n' + out.join('\n') + '\n通过 ' + pass + ' / 失败 ' + fail + '\n' + ME + '\n'
  document.body.appendChild(pre)
  document.title = 'FC ' + pass + '/' + fail
})()
