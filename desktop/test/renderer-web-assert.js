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
    // ── 族1（2026-10-03 卡 task-20261003-004）：改过内容点取消必须被拦（快照口径）──
    const _origConfirm = window.confirm
    const _confirmLog = []
    window.confirm = (msg) => { _confirmLog.push(String(msg)); return false }
    ;(() => {
      const ta = $('#todo-edit-modal textarea')
      if (ta) { ta.value = '改了但不保存'; ta.dispatchEvent(new Event('input', { bubbles: true })) }
    })()
    await sleep(200)
    ;(() => {
      const b = $$('#todo-edit-modal button').find((x) => x.textContent.trim() === '取消')
      if (b) b.click()
    })()
    await sleep(250)
    check('★★ 族1：待办改过内容点「取消」不静默关（confirm 拦下，弹窗仍在）',
      !!$('#todo-edit-modal') && _confirmLog.length >= 1,
      'modal=' + !!$('#todo-edit-modal') + ' confirms=' + JSON.stringify(_confirmLog))
    window.confirm = () => true
    ;(() => {
      const b = $$('#todo-edit-modal button').find((x) => x.textContent.trim() === '取消')
      if (b) b.click()
    })()
    await sleep(250)
    check('★ 族1：confirm 放行才关（唯一丢弃入口），未保存内容不落库',
      !$('#todo-edit-modal') &&
      !(typeof window.__fcTest.todos === 'function'
        ? window.__fcTest.todos().some(t => t.title === '改了但不保存') : false),
      JSON.stringify(typeof window.__fcTest.todos === 'function'
        ? window.__fcTest.todos().map(t => t.title) : 'no todos() api'))
    window.confirm = _origConfirm

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
    check('★★ 顶栏排序下拉四个值（活跃优先 / 最近更新 / 创建时间 / 优先级 —— 2026-10-01 用户第 2 条）',
      $$('#bar select').some((s) => s.options.length === 4
        && Array.prototype.every.call(s.options, (o) => ['active', 'updated', 'created', 'prio'].indexOf(o.value) >= 0)),
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

    check('  能切到「优先级」（2026-10-01 用户第 2 条：看板补的排法）', await pickSort('prio'))
    check('★★ 优先级排法落真身 prefs（不是只改了下拉没接线）',
      String(window.__fcTest.prefs().fc_board_sort) === 'prio',
      JSON.stringify(window.__fcTest.prefs().fc_board_sort))

    check('  切回「活跃优先」', await pickSort('active'))
    check('  恢复后与初始一致（排序可逆）', statusColOrder().join(',') === ordDefault.join(','), JSON.stringify(statusColOrder()))
    check('  排序选择进了真身 prefs（与分组方式同一套机制，换 origin 不丢）',
      ['active', 'updated', 'created', 'prio'].indexOf(String(window.__fcTest.prefs().fc_board_sort)) >= 0,
      JSON.stringify(window.__fcTest.prefs().fc_board_sort))

    // ══ 日历 · 格子内折叠（2026-09-29 用户选「改法 A」）════════════════════
    // 035 卡原话「看起来很密集很让人畏惧」。底部那排横条墙上一轮已收成一行摘要，
    // 剩下的密在**格子内部** —— 夹具把 4 条事件压在「今天」（001 + 011/012/013，
    // 日期跟随运行日，见 renderer-preload.cjs 的 FIX_DEADLINE：写死 9-30 会在每月 1 号假红）。
    check('能切到「日历」页签', clickText('日历'))
    await sleep(700)
    const calCellOf = () => $$('main.calendar-view .calcell')
      .filter((c) => (c.textContent || '').indexOf('日历密度样例一') >= 0)[0]
    const cal0 = (() => {
      const c = calCellOf()
      if (!c) return { err: '没找到「今天」那格（夹具日期对不上？见 FIX_DEADLINE）' }
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

    // ══ 项目页签 · 第 4 摆法「在途一屏」（2026-10-05 Q2 · 立项契约 ② 验收线之①）══
    // 要点：四摆法互斥、六列齐、缺契约显式「未填」、无卡项目 current 回落到日志、
    //       健康度人工锁定可见、设置入口在（裁断权在人）。
    check('能点到「在途一屏」', (() => {
      const b = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('在途一屏') >= 0)
      if (!b) return false
      b.click(); return true
    })())
    check('★ 在途一屏渲染出来，且另外三种摆法都不在 DOM 里（四种摆法互斥）',
      await waitFor(() => $$('#board.pv .tripboard').length === 1
        && $$('#board.pv .pvgrid').length === 0 && $$('#board.pv .ovgrid').length === 0
        && $$('#board.pv .pv-ms').length === 0, 6000, '在途一屏'))
    const tripSnap = () => {
      const tb = $('#board.pv .tripboard')
      if (!tb) return { err: '没有 .tripboard' }
      return {
        rows: $$('#board.pv .trip-table tbody tr').length,
        heads: $$('#board.pv .trip-table th').map((th) => (th.textContent || '').trim()),
        txt: (tb.textContent || '').replace(/\s+/g, ' '),
        unset: $$('#board.pv .trip-unset').length,
        minis: $$('#board.pv .trip-mini').length,
        from: $$('#board.pv .trip-from').length,
        locks: $$('#board.pv .trip-lock').length,
      }
    }
    await waitFor(() => tripSnap().rows >= 2, 5000, '一屏表格')
    const tp = tripSnap()
    check('★ 六列都在（终态 / 当前步骤 / 下一步 / 卡在谁 / 健康度 / 卡·日志）',
      !tp.err && ['终态', '当前步骤', '下一步', '卡在谁', '健康度']
        .every((k) => tp.heads.some((h) => h.indexOf(k) >= 0)), JSON.stringify(tp.heads))
    check('★ 契约「未填」显式可见 + 两个按钮（复制模板 / 打开 repo）',
      !tp.err && tp.unset >= 1 && tp.minis >= 2, JSON.stringify({ unset: tp.unset, minis: tp.minis }))
    check('★ 无卡项目的「当前步骤」来自执行日志（挂了「日志」来源标签，不冒充任务卡）',
      !tp.err && tp.from >= 1, JSON.stringify({ from: tp.from }))
    check('★ 人工锁定的健康度带锁标（机器算不出的状态由人裁断）',
      !tp.err && tp.locks >= 1, JSON.stringify({ locks: tp.locks }))
    check('★ 选在途一屏也进真身 prefs（fc_pv_view=trip）',
      window.__fcTest.prefs().fc_pv_view === 'trip', JSON.stringify(window.__fcTest.prefs().fc_pv_view))
    check('★ 设置入口在（⚙ 显示设置）—— 裁断权在人，不是写死的清单',
      !tp.err && $$('#board.pv .tripboard button')
        .some((b) => (b.textContent || '').indexOf('显示设置') >= 0))
    check('点开设置面板 → 「收哪些项目 / 哪些项目算在途 / 显示哪些列」三块都在', await (async () => {
      const b = $$('#board.pv .tripboard button')
        .find((x) => (x.textContent || '').indexOf('显示设置') >= 0)
      if (!b) return false
      b.click()
      const got = await waitFor(() => {
        const m = $('#board.pv .trip-modal')
        return !!m && m.querySelectorAll('.trip-chk').length >= 3
      }, 3000, '设置面板')
      const txt = (($('#board.pv .trip-modal') || {}).textContent || '')
      return got && txt.indexOf('收哪些项目') >= 0 && txt.indexOf('在途') >= 0 && txt.indexOf('显示哪些列') >= 0
    })())
    check('关掉设置面板', await (async () => {
      const c = $$('#board.pv .trip-modal button')
        .find((x) => (x.textContent || '').trim() === '保存')
      if (!c) return false
      c.click()
      return waitFor(() => !$('#board.pv .trip-modal'), 3000, '关闭设置')
    })())
    // ⚠ 2026-10-05 用户实测 bug：「提示保存了，但每次重新勾选都被取消」。
    //   根因 A：loadTripBoard 里曾把 rows 的 id 回填给勾选清单 —— 用户勾的正是"没进屏"的项目，
    //          回填等于当场抹掉他的勾选。
    //   根因 B：写盘只落了字符串键（fc_trip_mode），数组键（fc_trip_projects）根本没写，界面照样说"已保存"。
    //          现已改为**一次 IPC 写完四个键 + 回读校验**，校验不过就报错（不假成功）；
    //          「保存」保留（用户口径：不需要理解运行机制，看到保存成功就行），改动同时即时落盘。
    //   这条断言：勾一个项目 → 关面板 → **重开面板，勾选还在**。
    check('★ 勾选项目 → 关面板 → 重开勾选仍在（改动即时生效，不存在"存没存"）', await (async () => {
      const openPanel = () => {
        const b = $$('#board.pv .tripboard button')
          .find((x) => (x.textContent || '').indexOf('显示设置') >= 0)
        if (!b) return false
        b.click()
        return true
      }
      const closePanel = async () => {
        const c = $$('#board.pv .trip-modal button')
          .find((x) => (x.textContent || '').trim() === '保存')
        if (!c) return false
        c.click()
        return waitFor(() => !$('#board.pv .trip-modal'), 3000, '关面板')
      }
      if (!openPanel()) return false
      if (!(await waitFor(() => !!$('#board.pv .trip-modal'), 3000, '开面板'))) return false
      const target = $$('#board.pv .trip-modal .trip-chk')
        .find((x) => (x.textContent || '').indexOf('第二个项目') >= 0)
      if (!target) return false
      const inp = target.querySelector('input')
      if (inp) inp.click()
      await sleep(400)
      const saved = window.__fcTest.prefs().fc_trip_projects
      if (!(await closePanel())) return false
      if (!openPanel()) return false
      if (!(await waitFor(() => !!$('#board.pv .trip-modal'), 3000, '重开面板'))) return false
      const stillOn = $$('#board.pv .trip-modal .trip-chk')
        .filter((x) => x.classList.contains('on'))
        .map((x) => (x.textContent || '').trim())
      await closePanel()
      return Array.isArray(saved) && saved.length > 0
        && stillOn.some((t) => t.indexOf('第二个项目') >= 0)
        && window.__fcTest.prefs().fc_trip_mode === 'manual'
    })())
    // 2026-10-05 用户：「项目页签里似乎没有添加和删除项目的入口」——
    // 添加：旧三摆法各自有（tile-add/ocard-add/ms-add），**新加的第 4 摆法当时漏了**；
    // 删除：全仓此前根本没有这个能力。两条都钉住。
    check('★ 第 4 摆法也有「＋ 添加项目」入口（不能只有旧三摆法有）',
      $$('#board.pv .trip-actions button').some((b) => (b.textContent || '').indexOf('添加项目') >= 0),
      JSON.stringify($$('#board.pv .trip-actions button').map((b) => (b.textContent || '').trim())))
    check('★ 每行都有「移除登记」入口（🗑）—— 删除项目此前没有任何入口',
      $$('#board.pv .trip-table .proj-del').length >= 2,
      'proj-del=' + $$('#board.pv .trip-table .proj-del').length)
    // 2026-10-05 用户：「添加完项目刷新几遍根本看不到」——它确实不在这一屏（判据没命中），
    // 但界面必须**说出来**，不能一个字不提（用户只会以为自己加失败了）。
    check('★ 没进这一屏的项目被显式说出来（含名字 + 为什么 + 怎么让它显示）',
      $$('#board.pv .trip-hidden').length === 1
      && (($('#board.pv .trip-hidden') || {}).textContent || '').indexOf('还没开工的项目') >= 0
      && (($('#board.pv .trip-hidden') || {}).textContent || '').indexOf('显示设置') >= 0,
      'trip-hidden=' + $$('#board.pv .trip-hidden').length)
    check('★ 「建契约文件」按钮在（方寸代写，2026-10-05 用户：打字输错一个字就可能不识别）',
      $$('#board.pv .trip-table .trip-mini').some((b) => (b.textContent || '').indexOf('建契约文件') >= 0),
      JSON.stringify($$('#board.pv .trip-table .trip-mini').map((b) => (b.textContent || '').trim())))

    // ══ 卡 002（2026-10-08 用户反馈「创完就改不了」+「行点不开」）══════════
    // ① exists 分支此前**只有首行文本**：建契约/复制模板/打开文件夹全在 else ——
    //    文件一旦存在，界面上连"打开它"的入口都没了。
    // ② trip 行 tr 没有任何整行点击处理，只有健康度按钮与 🗑 有交互。
    check('★ 契约已存在的行有「📄 打开契约」入口（文件建了就得有地方改）',
      $$('#board.pv .trip-table .trip-mini').some((b) => (b.textContent || '').indexOf('打开契约') >= 0),
      JSON.stringify($$('#board.pv .trip-table .trip-mini').map((b) => (b.textContent || '').trim())))
    check('★ 点「打开契约」真调 openFile 且路径就是那份契约（不是僵尸按钮）', await (async () => {
      const before = window.__fcTest.callCount('openFile')
      const b = $$('#board.pv .trip-table .trip-mini').find((x) => (x.textContent || '').indexOf('打开契约') >= 0)
      if (!b) return false
      b.click()
      const got = await waitFor(() => window.__fcTest.callCount('openFile') > before, 3000, 'openFile 被调用')
      const calls = window.__fcTest.calls().filter((c) => c.name === 'openFile')
      const last = calls[calls.length - 1]
      return got && !!last && last.args[0] === 'E:/CODE/mock/demo/立项契约.md'
        && window.__fcTest.callCount('openFile') === before + 1
    })())
    // 文件在、但 ① 终态形态 还没填 —— 旧版会并进「未填」分支，于是只剩一个
    // 会被主进程拒绝的「建契约文件」。注入夹具把这条分支逼出来。
    check('★ 文件已建但内容为空 → 说「文件已建 · 内容未填」，不冒充「未填」、不摆会被拒的「建契约文件」', await (async () => {
      window.__fcTest.setTripBoard({
        generatedAt: '2026-10-08 12:00', mode: 'auto', criteria: 'cards_or_commit',
        rows: [{
          id: 'demo', name: '演示项目', repo: 'E:/CODE/mock/demo',
          contract: { exists: true, path: 'E:/CODE/mock/demo/立项契约.md', endState: '', acceptLine: '', notWant: '', choice: '' },
          current: { text: '', from: '', sub: '' }, next: { text: '', from: '', sub: '' },
          who: { text: '', kind: 'none' }, health: { value: 'active', locked: false },
          counts: { todo: 0, doing: 0, review: 0, logs: 0 }, lastCommit: '', recentCommit: false, dirty: 0,
          flags: { noCards: false, noLogs: true },
        }],
        hidden: [],
      })
      // 切走再切回来，逼它用新夹具重新拉一次
      const wall = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('项目墙') >= 0)
      if (wall) wall.click()
      await sleep(300)
      const back = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('在途一屏') >= 0)
      if (back) back.click()
      if (!(await waitFor(() => $$('#board.pv .tripboard').length === 1, 5000, '回到在途一屏'))) return false
      const row = $$('#board.pv .trip-table tbody tr')[0]
      if (!row) return false
      const txt = (row.textContent || '').replace(/\s+/g, ' ')
      const minis = Array.prototype.slice.call(row.querySelectorAll('.trip-mini'))
        .map((b) => (b.textContent || '').trim())
      // 判据：说「文件已建 · 内容未填」、给「打开契约」、**不**给会被主进程拒绝的「建契约文件」
      const ok = txt.indexOf('文件已建 · 内容未填') >= 0
        && minis.some((t) => t.indexOf('打开契约') >= 0)
        && !minis.some((t) => t.indexOf('建契约文件') >= 0)
      window.__fcTest.setTripBoard(null)
      return ok
    })())
    check('  （恢复默认夹具后在途一屏照常渲染）', await (async () => {
      const wall = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('项目墙') >= 0)
      if (wall) wall.click()
      await sleep(300)
      const back = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('在途一屏') >= 0)
      if (back) back.click()
      // ⚠ 必须真 await：`waitFor(...) && tripSnap()...` 会立即求值右操作数 = 行还没渲染就判红
      const got = await waitFor(() => tripSnap().rows >= 2, 5000, '夹具恢复')
      return got && tripSnap().rows >= 2
    })())
    // 行内按钮有自己的语义（切健康度），不能连带把整行点开 —— .stop 兜住。
    check('★ 行内按钮点击不触发行点击（点健康度不会把人甩出在途一屏）', await (async () => {
      if (!(await waitFor(() => $('#board.pv .trip-table .trip-hbtn'), 5000, '健康度按钮渲染'))) return false
      const btn = $('#board.pv .trip-table .trip-hbtn')
      if (!btn) return false
      btn.click()
      await sleep(400)
      return $$('#board.pv .tripboard').length === 1
    })())
    // 点整行 → 详情。⚠ check 的 cond 只认布尔：IIFE 里返回诊断字符串会因"非空即真"误判 PASS，
    // 所以诊断写进外置变量、当 detail 传（参数从左到右求值，IIFE 先跑完）。
    let rowOpenDetail = ''
    check('★ 点整行 → 进这个项目的详情（复用主从 ms-detail，不新造详情页）', await (async () => {
      const cell = $$('#board.pv .trip-table tbody .trip-pj b')
        .find((x) => (x.textContent || '').indexOf('演示项目') >= 0)
      if (!cell) { rowOpenDetail = '找不到演示项目行'; return false }
      cell.click()
      const got = await waitFor(() => $$('#board.pv .pv-ms').length === 1
        && $$('#board.pv .tripboard').length === 0, 4000, '切到主从')
      const detail = (($('#board.pv .ms-detail') || {}).textContent || '')
      if (!(got && detail.indexOf('演示项目') >= 0)) {
        rowOpenDetail = 'got=' + got + ' detail=' + detail.replace(/\s+/g, ' ').slice(0, 80)
        return false
      }
      return true
    })(), rowOpenDetail)
    check('★ 行点击不覆写用户选好的摆法（导航不是偏好，fc_pv_view 仍是 trip）',
      window.__fcTest.prefs().fc_pv_view === 'trip',
      JSON.stringify(window.__fcTest.prefs().fc_pv_view))
    // 主从里点回在途一屏，把视图还原给后续断言
    check('  切回在途一屏（还原现场）', await (async () => {
      const b = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('在途一屏') >= 0)
      if (!b) return false
      b.click()
      return waitFor(() => $$('#board.pv .tripboard').length === 1, 4000, '回到在途一屏')
    })())

    // ══ 空屏不许是死局（2026-10-05 用户实测「一屏是空的」）═══════════════
    // 用户当时的状态：prefs 里 fc_trip_mode=manual，而 fc_trip_projects 键根本没写进去
    //   （旧写法四次裸写只落了字符串键）→ 手动清单为空 → 15 个项目全出局 → 一屏空白，
    //   而下面那句统一文案还写着"它们没有未完结任务"（方寸自己有几十张卡 = 说假话）。
    // 修法两头：数据层「键不存在 = 从没做过选择」兜底回自动；界面给一步就能走出去的出口。
    check('★ 空屏不是死局：手动指定 + 一个都没勾 → 「改回自动」出口在', await (async () => {
      window.__fcTest.setTripBoard({
        ok: true, generatedAt: '2026-10-05 12:30', mode: 'manual', criteria: 'cards_or_commit',
        modeFallback: false, rows: [],
        hidden: [{ id: 'demo3', name: '还没开工的项目', kind: 'not-picked', reason: '你选的是「手动指定」，但没勾它' }],
      })
      // 切走再切回来，逼它重新拉一次
      const wall = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('项目墙') >= 0)
      if (wall) wall.click()
      await sleep(300)
      const back = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('在途一屏') >= 0)
      if (back) back.click()
      if (!(await waitFor(() => $$('#board.pv .tripboard').length === 1, 5000, '回到在途一屏'))) return false
      const act = $('#board.pv .trip-empty-act')
      return !!$('#board.pv .trip-empty') && !!act && (act.textContent || '').indexOf('改回自动') >= 0
    })())
    check('★ 空屏的原因说实话（写「手动指定」，不许说「没有未完结任务」）',
      (($('#board.pv .trip-hidden') || {}).textContent || '').indexOf('手动指定') >= 0
      && (($('#board.pv .trip-hidden') || {}).textContent || '').indexOf('没有未完结任务') < 0,
      (($('#board.pv .trip-hidden') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 70))
    check('★ 点「改回自动」→ 真的写进真身（空屏一步可走出去）', await (async () => {
      const act = $('#board.pv .trip-empty-act')
      if (!act) return false
      act.click()
      const okMode = await waitFor(() => window.__fcTest.prefs().fc_trip_mode === 'auto', 3000, '模式改回自动')
      const saved = window.__fcTest.prefs()
      return okMode && Array.isArray(saved.fc_trip_projects) && saved.fc_trip_projects.length === 0
    })())
    window.__fcTest.setTripBoard(null)  // 恢复默认夹具，后面的断言继续用
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
        created: '2026-09-29T00:00:00.000Z', continueFrom: 'log-relay-a', agentName: 'hermes', prevAgentName: 'DSH' },
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

    // 2026-10-03 反馈1（卡 task-20261003-001）：上次的执行 Agent 卡面必须标清楚
    check('★ 卡面标出「⤴ 上次」执行 Agent（夹具 log-relay-b.prevAgentName=DSH）',
      $$('.log-card').some(c => (c.textContent || '').indexOf('上次 DSH') >= 0),
      'prev-chip=' + $$('.log-prev-agent').length)

    // 接力对话框（完成态卡入口）
    check('★ 完成态卡有「⏭ 从这里继续」', $$('.relay-btn').length >= 1, 'relay-btn=' + $$('.relay-btn').length)
    const relayBtn = $('.relay-btn')
    if (relayBtn) relayBtn.click()
    check('★★ 点开接力对话框（#relay-modal 出现）',
      await waitFor(() => !!$('#relay-modal'), 3000, 'relay-modal'))
    check('★ 源摘要条显示源日志 ID',
      !!$('.rs-id') && $('.rs-id').textContent.trim() === 'log-relay-a',
      $('.rs-id') ? $('.rs-id').textContent : 'no .rs-id')
    // ── 2026-10-03 反馈1/2（卡 task-20261003-001/002）──
    check('★★ 标题不再沿用源（反馈2）：「新日志标题」默认留空，每个日志创建新标题',
      (() => {
        const lab = $$('#relay-modal label').find(l => (l.textContent || '').indexOf('新日志标题') >= 0)
        const inp = lab && lab.nextElementSibling
        return !!inp && inp.tagName === 'INPUT' && inp.value === ''
      })(), 'title=' + (($('#relay-modal input') || {}).value ?? '?'))
    check('★★ 拆两字段（反馈1）：「上次的执行 Agent」与「本次执行 Agent」两个标签都在',
      (() => {
        const texts = $$('#relay-modal label').map(l => l.textContent || '')
        return texts.some(t => t.indexOf('上次的执行 Agent') >= 0) && texts.some(t => t.indexOf('本次执行 Agent') >= 0)
      })(), $$('#relay-modal label').map(l => (l.textContent || '').slice(0, 10)).join(' | '))
    check('★ 上次字段预填源日志的执行 Agent（hermes，可改可补）',
      (() => {
        const lab = $$('#relay-modal label').find(l => (l.textContent || '').indexOf('上次的执行 Agent') >= 0)
        const sel = lab && lab.nextElementSibling
        return !!sel && sel.tagName === 'SELECT' && sel.value === 'hermes'
      })(), 'sel=' + ((() => {
        const lab = $$('#relay-modal label').find(l => (l.textContent || '').indexOf('上次的执行 Agent') >= 0)
        const sel = lab && lab.nextElementSibling
        return sel ? sel.tagName + ':' + sel.value : 'none'
      })()))
    const relayTaOf = (labelPart) => {
      const labs = $$('#relay-modal label')
      const lab = labs.find(l => (l.textContent || '').indexOf(labelPart) >= 0 &&
        l.nextElementSibling && l.nextElementSibling.tagName === 'TEXTAREA')
      return lab ? lab.nextElementSibling : null
    }
    check('★★ 顺序符合认知（卡 006）：执行内容在上、下一步在下（与日志卡读序一致）',
      (() => {
        const tas = $$('#relay-modal textarea')
        const first = tas[0] && tas[0].previousElementSibling
        const second = tas[1] && tas[1].previousElementSibling
        return tas.length === 2 && !!first && first.textContent.indexOf('执行内容') >= 0 &&
          !!second && second.textContent.indexOf('下一步') >= 0
      })(),
      $$('#relay-modal textarea').map(t => {
        const l = t.previousElementSibling
        return l ? l.textContent.slice(0, 6) : '(no label)'
      }).join(' | '))
    check('★★ 下一步**默认留空**（2026-10-02 用户：「依旧每次都直接挪用上次的输入结果」——不再预填）',
      !!relayTaOf('下一步') && relayTaOf('下一步').value === '',
      relayTaOf('下一步') ? JSON.stringify(relayTaOf('下一步').value) : 'no 下一步 textarea')
    check('★★「带入源的下一步」按钮在位（取回源内容的唯一入口，常显不藏 hover）',
      $$('#relay-modal .relay-bring').length === 1 &&
      ($('#relay-modal .relay-bring').textContent || '').indexOf('带入源的下一步') >= 0,
      'bring=' + $$('#relay-modal .relay-bring').length)
    check('★ 执行内容默认留空（不继承源正文）',
      !!relayTaOf('执行内容') && relayTaOf('执行内容').value === '',
      JSON.stringify(relayTaOf('执行内容') ? relayTaOf('执行内容').value : null))
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
    // 2026-10-02：先测「带入」再关 —— 带入的内容同样受防丢保护，顺带把这一点断言掉
    const bringBtn = $('#relay-modal .relay-bring')
    if (bringBtn) bringBtn.click()
    await sleep(250)
    check('★★ 点「带入」才把源的下一步原文放进框（主动取，不是自动挪用）',
      !!relayTaOf('下一步') && relayTaOf('下一步').value.indexOf('清单勾选状态回写') >= 0,
      relayTaOf('下一步') ? relayTaOf('下一步').value.slice(0, 60) : 'no 下一步 textarea')
    const cancelBtn = $$('#relay-modal .acts button').find(b => (b.textContent || '').trim() === '取消')
    if (cancelBtn) cancelBtn.click()
    check('★ 带入也算改动：点取消不直接关，先出对话框内防丢条',
      await waitFor(() => !!$('.relay-discard'), 2000, 'relay-discard'))
    const dropOnRelay = $$('.relay-discard button').find(b => (b.textContent || '').trim() === '丢弃并关闭')
    if (dropOnRelay) dropOnRelay.click()
    check('丢弃并关闭后对话框关闭', await waitFor(() => !$('#relay-modal'), 2000, 'relay 关闭'))

    // ── 卡 006（2026-09-30 用户第 2 条）：关闭防丢 = 对话框内确认条，取代原生 confirm ──
    const rb2 = $$('.relay-btn')[0]
    if (rb2) rb2.click()
    check('重开接力对话框（防丢断言用）', await waitFor(() => !!$('#relay-modal'), 3000, 'relay 重开'))
    const cta = $$('#relay-modal textarea')[0]
    if (cta) {
      cta.value = '用户贴的上次会话完成情况'
      cta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await sleep(250)
    const cancel3 = $$('#relay-modal .acts button').find(b => (b.textContent || '').trim() === '取消')
    if (cancel3) cancel3.click()
    await sleep(300)
    check('★★ 有未创建内容时点「取消」不关：出对话框内确认条（不再原生 confirm，也不静默关）',
      !!$('#relay-modal') && !!$('#relay-modal .relay-discard'),
      'modal=' + !!$('#relay-modal') + ' bar=' + !!$('#relay-modal .relay-discard'))
    check('★ 确认条点名改了什么（脏检查覆盖执行内容等字段）',
      !!$('.relay-discard') && $('.relay-discard').textContent.indexOf('执行内容') >= 0,
      $('.relay-discard') ? $('.relay-discard').textContent.replace(/\s+/g, ' ').slice(0, 90) : 'no bar')
    check('★ 确认条两按钮：继续填写 / 丢弃并关闭',
      (() => {
        const t = $$('.relay-discard button').map(b => (b.textContent || '').trim())
        return t.indexOf('继续填写') >= 0 && t.indexOf('丢弃并关闭') >= 0
      })(), $$('.relay-discard button').map(b => b.textContent.trim()).join('|'))
    const keepBtn = $$('.relay-discard button').find(b => (b.textContent || '').trim() === '继续填写')
    if (keepBtn) keepBtn.click()
    await sleep(250)
    check('★ 「继续填写」收起条、内容还在（对话框不关）',
      !!$('#relay-modal') && !$('#relay-modal .relay-discard') &&
      ($$('#relay-modal textarea')[0] || { value: '' }).value.indexOf('上次会话完成情况') >= 0)
    const ovRelay = document.querySelector('#relay-overlay')
    if (ovRelay) ovRelay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(250)
    check('★★ 点遮罩同样拦下：对话框仍在 + 确认条再次出现（老代码这里直接全丢）',
      !!$('#relay-modal') && !!$('#relay-modal .relay-discard'))
    const dropBtn = $$('.relay-discard button').find(b => (b.textContent || '').trim() === '丢弃并关闭')
    if (dropBtn) dropBtn.click()
    check('★★ 只有点「丢弃并关闭」才真关（唯一丢弃入口）',
      await waitFor(() => !$('#relay-modal'), 2000, '丢弃后关闭'))

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

    // ══ 附件（2026-10-01 用户第 1 条 → 卡 036）═══════════════════
    // 卡 036 的验收原话：真实需求是「报修时截图有地方放」——所以这里断言的是
    // **入口真通**：角标 → 预览附件区 → 点添加多一项 → 点 ✕ 少一项，而不是只看数据层。
    check('切回分区视图（附件断言前置）', clickText('分区'))
    await sleep(400)
    window.__fcTest.setLogs([
      { id: 'log-att-1', title: '报修：白屏', content: '点了保存没反应', status: 'active', project: 'demo',
        created: '2026-09-30T00:00:00.000Z', attachments: ['docs/执行日志/_attachments/log-att-1/截图1.png'] },
      { id: 'log-att-2', title: '无附件日志', content: 'x', status: 'active', project: 'demo',
        created: '2026-09-30T01:00:00.000Z' },
    ])
    clickText('看板'); await sleep(400); clickText('日志'); await sleep(600)
    check('★★ 日志卡带附件角标 📎1（一眼看出这条附没附东西）',
      $$('.log-card').some(c => /📎1/.test(c.textContent || '')),
      $$('.log-card').map(c => (c.textContent || '').replace(/\s+/g, ' ').slice(0, 34)).join(' | '))
    check('★ 没附件的卡不长角标（不是"每张都挂 0"）',
      $$('.log-card').filter(c => (c.textContent || '').indexOf('无附件日志') >= 0)
        .every(c => (c.textContent || '').indexOf('📎') < 0))
    const attCard = $$('.log-card').find(c => (c.textContent || '').indexOf('报修：白屏') >= 0)
    if (attCard) attCard.click()
    check('点开只读预览（附件断言前置）', await waitFor(() => !!$('#log-preview-modal'), 3000, 'log preview'))
    check('★★ 只读预览里有附件区（"数据层通了但界面没入口"是本项目的老坑）',
      !!$('#log-preview-modal [data-attach-block]'))
    check('★★ 图片缩略图真渲染出来（data URL 通道，不碰 file://）',
      await waitFor(() => $$('#log-preview-modal .attach-item img').length === 1 &&
        /截图1.png/.test($('#log-preview-modal .attach-grid').textContent || ''), 3000, 'attach img'),
      'items=' + $$('#log-preview-modal .attach-item').length)
    const attAddBtn = $('#log-preview-modal .attach-add')
    if (attAddBtn) attAddBtn.click()
    check('★★ 点「＋添加文件…」→ 网格多一项（入口真通，不是死按钮）',
      await waitFor(() => $$('#log-preview-modal .attach-item').length === 2, 3000, 'attach add'),
      'items=' + $$('#log-preview-modal .attach-item').length)
    const attX = $$('#log-preview-modal .attach-x')[0]
    if (attX) attX.click()
    check('★★ 点 ✕ 少一项（解除关联，而不是弹窗问半天）',
      await waitFor(() => $$('#log-preview-modal .attach-item').length === 1, 3000, 'attach remove'),
      'items=' + $$('#log-preview-modal .attach-item').length)
    const attClose = $$('#log-preview-modal .acts button').find(b => (b.textContent || '').indexOf('关闭') >= 0)
    if (attClose) attClose.click()
    await sleep(300)

    // ══ 日志优先级（2026-10-08 卡 task-20261008-001，拍板=新增字段）════════
    // 数据层往返由 e2e-logs（198）与 e2e-fm-contract（25）钉住；这里只测**界面链路**：
    // 编辑框有这个下拉 → 保存真把它送进 IPC → 卡面看得见 → 排序真的按它排。
    window.__fcTest.setLogs([
      { id: 'log-prio-h', title: '要紧的排查', content: 'x', status: 'active', project: 'demo', priority: '高',
        created: '2026-10-07T00:00:00.000Z' },
      { id: 'log-prio-m', title: '普通跟进', content: 'x', status: 'active', project: 'demo', priority: '中',
        created: '2026-10-07T01:00:00.000Z' },
      { id: 'log-prio-l', title: '有空再说', content: 'x', status: 'active', project: 'demo', priority: '低',
        created: '2026-10-07T02:00:00.000Z' },
      { id: 'log-prio-n', title: '没标过的老日志', content: 'x', status: 'active', project: 'demo',
        created: '2026-10-07T03:00:00.000Z' },
    ])
    clickText('看板'); await sleep(400); clickText('日志'); await sleep(600)
    check('★★ 标了优先级的卡面直接有徽章（未标的不占位）', (() => {
      const badges = $$('.log-card .log-prio-badge').map(b => (b.textContent || '').trim())
      return badges.length === 3 && badges.join('').indexOf('高') >= 0
        && $$('.log-card').filter(c => (c.textContent || '').indexOf('没标过的老日志') >= 0)
             .every(c => c.querySelectorAll('.log-prio-badge').length === 0)
    })(), $$('.log-card .log-prio-badge').map(b => (b.textContent || '').trim()).join(','))
    check('★ 徽章三档 class 是 ASCII key（lp-high/lp-mid/lp-low）', (() => {
      const ks = $$('.log-card .log-prio-badge').map(b => (b.className || ''))
      return ks.some(k => k.indexOf('lp-high') >= 0) && ks.some(k => k.indexOf('lp-mid') >= 0) && ks.some(k => k.indexOf('lp-low') >= 0)
    })(), $$('.log-card .log-prio-badge').map(b => b.className).join(' | '))
    // 排序下拉：切到「按优先级」→ 高→中→低→未标（未标沉底）
    check('★★ 排序下拉有「按优先级（高→低）」选项（卡 001 之前只有 4 项）', (() => {
      const sel = $$('.logs-view select, #board select').find(s =>
        Array.prototype.slice.call(s.options || []).some(o => (o.textContent || '').indexOf('按优先级') >= 0))
      if (!sel) return false
      sel.value = 'prio_desc'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })())
    check('★★ 按优先级排：高 → 中 → 低 → 未标沉底', await (async () => {
      const got = await waitFor(() => {
        const titles = $$('.log-card .log-card-title').map(t => (t.textContent || '').trim())
        if (titles.length < 4) return false
        const idx = (s) => titles.findIndex(t => t.indexOf(s) >= 0)
        return idx('要紧的排查') < idx('普通跟进')
          && idx('普通跟进') < idx('有空再说')
          && idx('有空再说') < idx('没标过的老日志')
      }, 4000, 'prio 排序')
      return got
    })(), $$('.log-card .log-card-title').map(t => (t.textContent || '').trim()).join(' → '))
    check('★ 排序选择写进真身 prefs（fc_log_sort=prio_desc）',
      window.__fcTest.prefs().fc_log_sort === 'prio_desc',
      JSON.stringify(window.__fcTest.prefs().fc_log_sort))
    // 编辑框有优先级下拉，且保存真把值送进 IPC（logsUpdate 的 updates.priority）
    const prioEditBtn = $$('.log-card-actions button').find(b => (b.textContent || '').indexOf('编辑') >= 0)
    if (prioEditBtn) prioEditBtn.click()
    check('打开日志编辑框（优先级断言前置）', await waitFor(() => !!$('#log-edit-modal'), 3000, 'log edit'))
    check('★★ 编辑框有「优先级」下拉（四档：不标/高/中/低）', (() => {
      const sel = $$('#log-edit-modal select.logsel').find(s => {
        const opts = Array.prototype.slice.call(s.options || []).map(o => o.textContent)
        return opts.some(t => t === '不标') && opts.some(t => t === '高') && opts.some(t => t === '低')
      })
      return !!sel
    })(), JSON.stringify($$('#log-edit-modal select.logsel').map(s =>
      Array.prototype.slice.call(s.options).map(o => o.textContent).join('/'))))
    check('★★ 编辑框打开即回显当前优先级（不是每次打开都从「不标」重来）', (() => {
      const sel = $$('#log-edit-modal select.logsel').find(s =>
        Array.prototype.slice.call(s.options || []).some(o => o.textContent === '高'))
      return !!sel && sel.value === '高'
    })(), JSON.stringify(($$('#log-edit-modal select.logsel').find(s =>
      Array.prototype.slice.call(s.options || []).some(o => o.textContent === '高')) || {}).value))
    check('★ 优先级下拉改动纳入「未保存」防丢快照（整表 JSON 比对）', (() => {
      const sel = $$('#log-edit-modal select.logsel').find(s =>
        Array.prototype.slice.call(s.options || []).some(o => o.textContent === '低'))
      if (!sel) return false
      sel.value = '低'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      // 防丢是关窗时才拦 —— 这里只验证值真的绑上了（v-model 生效）
      return sel.value === '低'
    })())
    const prioSave = $$('#log-edit-modal .acts button').find(b => (b.textContent || '').trim() === '保存')
    if (prioSave) prioSave.click()
    check('★★ 保存 → logsUpdate 的 updates 带 priority（此前编辑框压根没这个字段）',
      await waitFor(() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'logsUpdate')
        if (!c.length) return false
        const upd = (c[c.length - 1].args || [])[1] || {}
        return upd.priority === '低'
      }, 4000, 'logsUpdate priority'),
      JSON.stringify((window.__fcTest.calls().filter(x => x.name === 'logsUpdate').pop() || {}).args))
    // 新建：默认「不标」，且创建链路同样带 priority
    const newLogBtn = $$('.logs-view button, #board button').find(b => (b.textContent || '').indexOf('新建日志') >= 0)
    if (newLogBtn) newLogBtn.click()
    check('打开新建日志（卡 001 新建分支前置）', await waitFor(() => !!$('#log-edit-modal'), 3000, 'new log'))
    check('★ 新建默认「不标」（历史日志零迁移：老日志不会因此多出字段）', (() => {
      const sel = $$('#log-edit-modal select.logsel').find(s =>
        Array.prototype.slice.call(s.options || []).some(o => o.textContent === '不标'))
      return !!sel && sel.value === ''
    })())
    const newTitle = $('#log-edit-modal input[placeholder="日志标题"]')
    if (newTitle) {
      newTitle.value = '带优先级的新日志'
      newTitle.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const selNew = $$('#log-edit-modal select.logsel').find(s =>
      Array.prototype.slice.call(s.options || []).some(o => o.textContent === '高'))
    if (selNew) { selNew.value = '高'; selNew.dispatchEvent(new Event('change', { bubbles: true })) }
    const createBtn = $$('#log-edit-modal .acts button').find(b => (b.textContent || '').trim() === '创建')
    if (createBtn) createBtn.click()
    check('★★ 创建链路把 priority 送进 IPC（logsCreate extra.priority=高）',
      await waitFor(() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'logsCreate')
        if (!c.length) return false
        const extra = (c[c.length - 1].args || [])[4] || {}
        return extra.priority === '高'
      }, 4000, 'logsCreate priority'),
      JSON.stringify((window.__fcTest.calls().filter(x => x.name === 'logsCreate').pop() || {}).args))

    // ══ 日志 ⇄ 待办互转（2026-10-08 卡 task-20261008-004，拍板=双向）════════════
    // 三个判据：① 两个方向的入口真在、真调 IPC；② **源保留不删**；③ 同一条只转一次（防重靠来源字段）。
    window.__fcTest.setLogs([
      { id: 'log-conv-1', title: '排查登录失败', content: '查了鉴权中间件', nextSteps: '- [ ] 补一个失败重试\n- [ ] 写回归',
        status: 'active', project: 'demo', priority: '高', created: '2026-10-08T00:00:00.000Z' },
    ])
    window.__fcTest.setTodos([
      { id: 'todo-conv-1', title: '整理发布说明', done: false, priority: '中', project: 'demo',
        due: '2026-10-12', createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-08T01:00:00.000Z' },
    ])
    clickText('看板'); await sleep(400); clickText('日志'); await sleep(600)
    // 方向一：日志 → 待办
    const convLogBtn = $$('.log-card-actions button').find(b => (b.textContent || '').indexOf('转待办') >= 0)
    check('★★ 日志卡上有「⤴ 转待办」入口', !!convLogBtn,
      JSON.stringify($$('.log-card-actions button').map(b => (b.textContent || '').trim())))
    if (convLogBtn) convLogBtn.click()
    check('★★ 日志→待办：真调 todosCreate（下一步首条做标题 + priority/project 跟着走 + fromLog 防重）',
      await waitFor(() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'todosCreate')
        if (!c.length) return false
        const a = c[c.length - 1].args || []
        return a[0] === '补一个失败重试' && a[1] === '高' && a[3] === 'demo' && a[4] === 'log-conv-1'
      }, 4000, 'todosCreate 反转'),
      JSON.stringify((window.__fcTest.calls().filter(x => x.name === 'todosCreate').pop() || {}).args))
    check('★ 日志→待办后**源日志还在**（转换不删源，卡 004 铁律）',
      window.__fcTest.calls().length > 0 && $$('.log-card').length >= 1,
      'logCards=' + $$('.log-card').length)
    // 防重：再点一次必须被拦（store 里已有 fromLog=log-conv-1 的待办）
    const convLogBtn2 = $$('.log-card-actions button').find(b => (b.textContent || '').indexOf('转待办') >= 0)
    const beforeDup = window.__fcTest.callCount('todosCreate')
    if (convLogBtn2) convLogBtn2.click()
    await sleep(600)
    check('★★ 防重：同一条日志再点「转待办」被拦下（todosCreate 调用数不增）',
      window.__fcTest.callCount('todosCreate') === beforeDup,
      `before=${beforeDup} after=${window.__fcTest.callCount('todosCreate')}`)
    check('★ 防重提示说得清（不是静默失败）',
      (($('#toast') || {}).textContent || '').indexOf('已经转过') >= 0,
      (($('#toast') || {}).textContent || '').slice(0, 60))
    // 方向二：待办 → 日志
    check('能切到「待办」页签（反转断言前置）', clickText('待办'))
    await sleep(600)
    const convTodoBtn = $$('.todo-acts .todo-conv')[0]
    check('★★ 待办行上有「⤴ 转日志」入口（.todo-conv）', !!convTodoBtn,
      'acts=' + $$('.todo-acts').length + ' conv=' + $$('.todo-acts .todo-conv').length)
    if (convTodoBtn) convTodoBtn.click()
    check('★★ 待办→日志：真调 logsCreate（title/project/priority/due 压进去 + fromTodo 防重）',
      await waitFor(() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'logsCreate')
        if (!c.length) return false
        const a = c[c.length - 1].args || []
        const extra = a[4] || {}
        return a[0] === '整理发布说明' && a[1] === 'demo'
          && String(a[2] || '').indexOf('2026-10-12') >= 0
          && extra.priority === '中' && extra.fromTodo === 'todo-conv-1'
      }, 4000, 'logsCreate 正转'),
      JSON.stringify((window.__fcTest.calls().filter(x => x.name === 'logsCreate').pop() || {}).args))
    // 防重（反向）
    const convTodoBtn2 = $$('.todo-acts .todo-conv')[0]
    const beforeDup2 = window.__fcTest.callCount('logsCreate')
    if (convTodoBtn2) convTodoBtn2.click()
    await sleep(600)
    check('★★ 防重：同一条待办再点「转日志」被拦下（logsCreate 调用数不增）',
      window.__fcTest.callCount('logsCreate') === beforeDup2,
      `before=${beforeDup2} after=${window.__fcTest.callCount('logsCreate')}`)
    check('★ 源待办仍在列表里（转换不删源）',
      $$('.todos-view .todo-item').some(x => (x.textContent || '').indexOf('整理发布说明') >= 0),
      $$('.todos-view .todo-item').map(x => (x.textContent || '').replace(/\s+/g, ' ').slice(0, 24)).join(' | '))
    // 来源徽章：回到日志页看 ⤴ 待办 徽章
    clickText('看板'); await sleep(400); clickText('日志'); await sleep(600)
    check('★★ 转出来的日志带「⤴ 待办」来源徽章（prev 范式，与接力链同款）',
      $$('.log-card .log-from').length >= 1,
      'log-from=' + $$('.log-card .log-from').length)

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

    // ── P0-1 脏检查快照：判「改没改」而不是「有没有字」（2026-10-01）──
    const origConfirmD = window.confirm
    let confirmHits = 0
    window.confirm = () => { confirmHits += 1; return false }   // 默认"不关"，才能验出"确实拦住了"
    const hitReset = () => { confirmHits = 0 }
    const cancelLogBtn = () =>
      $$('#log-edit-modal button').find(b => (b.textContent || '').trim() === '取消')
    clickText('日志'); await sleep(600)

    // A. 新建日志一字未改 → 安静关掉（守住别退化成误报）
    clickText('+ 新建日志'); await sleep(400)
    hitReset(); const cbA = cancelLogBtn(); if (cbA) cbA.click(); await sleep(300)
    check('★ 新建日志一字未改 → 关窗不弹确认（不误报）',
      confirmHits === 0 && $('#log-edit-overlay') === null, 'hits=' + confirmHits)

    // B. 新建日志**只改下拉** → 必须拦；拦法 = 与接力**同一套**对话框内警告条（2026-10-03 卡005 统一）
    clickText('+ 新建日志'); await sleep(400)
    let selChanged = false
    for (const s of $$('#log-edit-modal select.logsel')) {
      const opt = Array.prototype.slice.call(s.options).find(o => o.value && o.value !== s.value)
      if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change')); selChanged = true; break }
    }
    hitReset(); const cbB = cancelLogBtn(); if (cbB) cbB.click(); await sleep(300)
    check('★★ 卡005：只改下拉 → 出对话框内警告条（非原生 confirm）且拦住不关',
      selChanged && confirmHits === 0 && !!$('#log-edit-modal') && !!$('#log-edit-modal .relay-discard'),
      'hits=' + confirmHits + ' selChanged=' + selChanged + ' bar=' + !!$('#log-edit-modal .relay-discard'))
    check('★ 警告条点名改了什么 + 两按钮与接力同款',
      (() => {
        const bar = $('#log-edit-modal .relay-discard')
        const t = bar ? (bar.textContent || '') : ''
        return t.indexOf('关掉就没了') >= 0 && t.indexOf('继续填写') >= 0 && t.indexOf('丢弃并关闭') >= 0
      })())
    const cbB2 = cancelLogBtn(); if (cbB2) cbB2.click(); await sleep(250)
    check('  条子出着时再点取消仍不关（与接力同交互，唯一丢弃入口在条上）',
      !!$('#log-edit-modal'), 'modal=' + !!$('#log-edit-modal'))
    const dropB = $$('#log-edit-modal .relay-discard button').find(b => (b.textContent || '').trim() === '丢弃并关闭')
    if (dropB) dropB.click(); await sleep(300)
    check('★★ 点条上的「丢弃并关闭」才真关', $('#log-edit-overlay') === null)

    // C. 编辑已有日志一字未改 → 老逻辑三键非空必弹（确认疲劳），现在应安静关掉
    const editLogBtn = $$('.log-card-actions button').find(b => (b.textContent || '').indexOf('编辑') >= 0)
    if (editLogBtn) editLogBtn.click()
    await sleep(400)
    hitReset(); const cbC = cancelLogBtn(); if (cbC) cbC.click(); await sleep(300)
    check('★★ 编辑已有日志一字未改 → 不再误报「尚未保存」（老逻辑必弹 = 确认疲劳）',
      !!editLogBtn && confirmHits === 0 && $('#log-edit-overlay') === null,
      'hits=' + confirmHits + ' editBtn=' + !!editLogBtn)

    // D. 编辑已有日志**真改了** → 警告条拦住（卡005：与 B 同一套实现，原生 confirm 彻底移除）
    if (editLogBtn) editLogBtn.click()
    await sleep(400)
    const titleIn = $('#log-edit-modal input[placeholder="日志标题"]')
    if (titleIn) {
      titleIn.value = (titleIn.value || '') + '（改动）'
      titleIn.dispatchEvent(new Event('input'))
    }
    hitReset(); const cbD = cancelLogBtn(); if (cbD) cbD.click(); await sleep(300)
    check('★★ 卡005：编辑真改了 → 警告条拦住不关（confirmHits 恒 0 = 原生 confirm 已移除）',
      !!titleIn && confirmHits === 0 && !!$('#log-edit-modal') && !!$('#log-edit-modal .relay-discard'),
      'hits=' + confirmHits + ' titleIn=' + !!titleIn)
    check('  警告条点名「标题」',
      (($('#log-edit-modal .relay-discard') || {}).textContent || '').indexOf('标题') >= 0,
      (($('#log-edit-modal .relay-discard') || {}).textContent || '').slice(0, 80))
    const dropD = $$('#log-edit-modal .relay-discard button').find(b => (b.textContent || '').trim() === '丢弃并关闭')
    if (dropD) dropD.click(); await sleep(300)
    check('★★ 丢弃并关闭 → 真关（唯一丢弃入口）', $('#log-edit-overlay') === null)
    window.confirm = origConfirmD

    // ── 通知中心点击跳转（2026-10-01 用户第 1 条：「点下去是无效按钮」）──
    window.__fcTest.setTasks([
      { id: 'nt-task-1', title: '通知跳转目标任务', status: '进行中', project: 'demo',
        priority: 'P1', created: new Date().toISOString(), updated: new Date().toISOString() },
    ])
    const ncNow = new Date().toISOString()
    window.__fcTest.setNotifications([
      { id: 'nc-1', type: 'task-stalled', level: 'warning', title: '任务没动静：通知跳转目标任务',
        body: '任务文件已 72 小时没有任何写入', sourceId: 'nt-task-1', key: 'stalled',
        read: false, createdAt: ncNow, updatedAt: ncNow },
      { id: 'nc-2', type: 'todo-due', level: 'warning', title: '待办到期：示例',
        body: '今天到期', sourceId: 'nt-todo-1', key: 'due',
        read: true, createdAt: ncNow, updatedAt: ncNow },
    ])
    clickText('看板'); await sleep(400)
    const bellBtn = $('.nc-bell')
    check('★ 通知中心铃铛入口存在', !!bellBtn)
    if (bellBtn) bellBtn.click()
    await sleep(500)
    // 2026-10-08 默认页签改为「未读」：第一条 read=false 可见，第二条 read=true 被筛掉
    check('★★ 打开面板默认「未读」页签：只渲染未读那一条', $$('.nc-item').length === 1,
      String($$('.nc-item').length))
    // ⚠ 上一轮只同步了上面那条条数，下面整段还按「默认全部、两条都在」写 ——
    //   于是 go 行数恒 1≠2、拿不到第 2 条、面板没被点关、后续铃铛反而把面板关了（5 连红）。
    //   正确流：先验默认未读 → 切「全部」再验跳转/逐条点击（页签切换本身就是该测的行为）。
    check('★★ 切到「全部」页签 → 两条都渲染（页签是活的）', await (async () => {
      const allBtn = $$('.nc-filters .nc-seg button').find((b) => (b.textContent || '').indexOf('全部') >= 0)
      if (!allBtn) return false
      allBtn.click()
      return waitFor(() => $$('.nc-item').length === 2, 3000, '全部两条')
    })(), 'items=' + $$('.nc-item').length)
    check('★ 能跳的行带 title 提示 + 行尾箭头（不再是死按钮）',
      $$('.nc-item.go').length === 2 && $$('.nc-go').length === 2 &&
      (($$('.nc-item')[0] || {}).getAttribute?.('title') === '跳到这个任务'),
      (($$('.nc-item')[0] || {}).getAttribute?.('title') || 'null'))
    // 点第 1 条（任务类）→ 关面板 + getTask + 切看板 + 打开任务预览
    const ncItem1 = $$('.nc-item')[0]
    if (ncItem1) ncItem1.click()
    check('★★ 点任务通知：关面板 + 取任务 + 打开任务预览',
      await waitFor(() => $('#roverlay') !== null && $('.nc-wrap') === null &&
        window.__fcTest.calls().filter(c => c.name === 'getTask').length >= 1, 5000, 'roverlay+getTask'),
      'getTask=' + window.__fcTest.calls().filter(c => c.name === 'getTask').length)
    check('★ 预览打开的正是通知指向的那条任务',
      !!$('#roverlay') && String((($('#rmodal h3') || {}).textContent || '')).indexOf('通知跳转目标任务') >= 0,
      String((($('#rmodal h3') || {}).textContent || '').slice(0, 60)))
    // 关预览（overlay 自身 @click.self）
    const ovNc = $('#roverlay'); if (ovNc) ovNc.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(300)
    // 点第 2 条（待办类）→ 关面板 + 切到待办视图
    if (bellBtn) bellBtn.click()
    await sleep(400)
    const ncItem2 = $$('.nc-item')[1]
    if (ncItem2) ncItem2.click()
    check('★★ 点待办通知：切到待办视图（面板同步关闭）',
      await waitFor(() => $('.todos-view') !== null && $('.nc-wrap') === null, 4000, 'todos 视图'),
      'todos=' + $$('.todos-view').length)

    // ── P0-4 / P0-5：扫描器状态可见 + 被静音提醒可恢复（2026-10-01）──
    window.__fcTest.setNcExtras(
      { running: true, lastScanAt: new Date(Date.now() - 120000).toISOString() },
      ['stalled:task-x', 'blocker-broken:task-y'], 2)
    const bell2 = $('.nc-bell')
    if (bell2) bell2.click()
    await sleep(500)
    const scanEl = $('.nc-foot .nc-scan')
    check('★★ 扫描器状态在面板页脚可见（「停摆」与「扫不到」此前长得一模一样）',
      !!scanEl && /扫描器运行中/.test(scanEl.textContent || '') && /上次扫描/.test(scanEl.textContent || ''),
      scanEl ? String(scanEl.textContent) : '无 .nc-scan')
    const mutedRow = $('.nc-muted')
    check('★★ 被静音（删过）的提醒显示出来（此前 7 天内彻底消失且用户不知情）',
      !!mutedRow && /被忽略 2 条/.test(mutedRow.textContent || ''),
      mutedRow ? String(mutedRow.textContent) : '无 .nc-muted')
    const unmuteBtn = mutedRow ? mutedRow.querySelector('button') : null
    if (unmuteBtn) unmuteBtn.click()
    check('★★ 点「全部恢复」→ 调 IPC + 行消失',
      await waitFor(() => {
        const n = window.__fcTest.calls().filter(c => c.name === 'notificationsUnmuteAll').length
        return n >= 1 && !$('.nc-muted')
      }, 4000, 'unmuteAll + 行消失'),
      'calls=' + window.__fcTest.calls().filter(c => c.name === 'notificationsUnmuteAll').length)
    if ($('.nc-wrap')) {
      const bell3 = $('.nc-bell')
      if (bell3) bell3.click()
      await sleep(200)
    }

    // ══ 技能页 · 多目标装机状态（2026-10-03 卡 010/011）══════════════════
    //   用户原话：「DSH 在上一轮已经完成安装，但方寸**检测不到** DSH 安装了」——
    //   装卡区此前连 DSH 这一行都没有。这里把它钉在**真渲染出来的 DOM** 上。
    check('能切到「技能」页签', clickText('技能'))
    await sleep(500)
    check('技能页渲染出来（.skills-view 在）', await waitFor(() => !!$('.skills-view'), 4000, '技能视图'))

    // ⚠ 只取**自发布**技能卡（`.skills-list` 下）；外部导入的卡片也带 `.skill-card` class
    //   （`.skill-card.imported`），不限定就会把"导入卡没有目标徽章"误判成缺陷。
    const skillCards = $$('.skills-view .skills-list .skill-card')
    check('技能卡片渲染出来', skillCards.length >= 2, 'n=' + skillCards.length)

    const targetsEls = $$('.skills-view .skill-targets')
    check('★ 每张技能卡都有「装到：」逐目标徽章行',
      targetsEls.length === skillCards.length && targetsEls.length > 0,
      'targets=' + targetsEls.length + ' cards=' + skillCards.length)

    const tgtTexts = $$('.skills-view .skill-tgt').map((e) => ({ t: (e.textContent || '').trim(), cls: e.className }))
    check('★ 徽章里同时出现 Hermes 与 DSH 两个目标（不再只认 Hermes）',
      tgtTexts.some((x) => x.t.indexOf('Hermes') === 0) && tgtTexts.some((x) => x.t.indexOf('DSH') === 0),
      JSON.stringify(tgtTexts.map((x) => x.t)))
    check('★ 三种状态都真渲染：✓最新 / ⬆有更新 / （不在场）',
      tgtTexts.some((x) => x.t.indexOf('✓最新') >= 0) && tgtTexts.some((x) => x.t.indexOf('⬆有更新') >= 0)
      && tgtTexts.some((x) => x.t.indexOf('不在场') >= 0),
      JSON.stringify(tgtTexts.map((x) => x.t)))
    check('  状态靠 class 区分（不是只有文案差别）',
      tgtTexts.some((x) => /skill-tgt-ok/.test(x.cls)) && tgtTexts.some((x) => /skill-tgt-warn/.test(x.cls))
      && tgtTexts.some((x) => /skill-tgt-absent/.test(x.cls)),
      JSON.stringify(tgtTexts.map((x) => x.cls)))
    check('  卡片上有真源指纹（只能手动导入的 agent 拿它对账）',
      $$('.skills-view .skill-hash').length === skillCards.length
      && (($('.skills-view .skill-hash') || {}).textContent || '').trim().length > 0,
      (($('.skills-view .skill-hash') || {}).textContent || '(无)'))

    // 装卡区
    const agentRows = $$('.skills-view .agent-row')
    const rowOf = (name) => agentRows.find((r) => (((r.querySelector('.agent-name') || {}).textContent) || '').indexOf(name) >= 0)
    const dshRow = rowOf('DSH')
    check('★ 装卡区列出 DSH 这一行（此前根本没有）', !!dshRow, 'rows=' + agentRows.length)
    check('★ DSH 行标着「可直装」',
      !!dshRow && /可直装/.test(((dshRow.querySelector('.agent-mode') || {}).textContent) || ''),
      dshRow ? ((dshRow.querySelector('.agent-mode') || {}).textContent) : '(无)')
    const dshBtn = dshRow
      ? Array.prototype.slice.call(dshRow.querySelectorAll('button')).find((b) => (b.textContent || '').indexOf('装到 DSH') >= 0)
      : null
    check('★ DSH 行的「⚡ 装到 DSH」是**真按钮**（不是 disabled 死按钮）',
      !!dshBtn && !dshBtn.disabled, dshBtn ? ('disabled=' + dshBtn.disabled) : '(没找到按钮)')
    check('  Hermes 行不再摆第二个安装按钮（同一个动作不重复两遍）',
      !agentRows.some((r) => (((r.querySelector('.agent-name') || {}).textContent) || '').indexOf('Hermes') >= 0
        && Array.prototype.slice.call(r.querySelectorAll('button')).some((b) => (b.textContent || '').indexOf('装到 Hermes') >= 0)))

    const linkBadges = $$('.skills-view .agent-link').map((e) => ({ t: (e.textContent || '').trim(), cls: e.className }))
    check('★ 「已接入」徽章渲染出来（技能副本 + MCP 配置两个文件事实的合体，不用 LLM）',
      linkBadges.length >= 2 && linkBadges.some((x) => /部分接入|已接入|未接入/.test(x.t)),
      JSON.stringify(linkBadges))

    if (dshBtn) {
      dshBtn.click()
      check('★ 点「⚡ 装到 DSH」真调 IPC skillsInstallTo(target=dsh)',
        await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'skillsInstallTo' && c.args && c.args[0] === 'dsh'), 4000, 'installTo(dsh)'),
        'calls=' + JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'skillsInstallTo').map((c) => c.args)))
    }
    await sleep(300)

    // ══ 设置页 · 侧边栏分类（2026-10-03 用户：设置项不要挤在一条长名单里）══════
    const gear = $$('#bar button').find((b) => (b.textContent || '').trim() === '⚙')
    check('顶栏有设置入口（⚙）', !!gear)
    if (gear) gear.click()
    await sleep(400)
    check('设置面板打开', await waitFor(() => !!$('#smodal'), 4000, '设置面板'))

    const navBtns = () => $$('#smodal .settings-nav-btn')
    const navNames = navBtns().map((b) => (b.textContent || '').trim())
    check('★ 设置页左侧是分类导航（不再是一条长名单）', navBtns().length >= 5, 'n=' + navBtns().length)
    check('★ 六个分类齐全（通用 / 数据与归档 / Agent / 项目 / 备份与恢复 / 诊断）',
      ['通用', '数据与归档', 'Agent', '项目', '备份与恢复', '诊断']
        .every((n) => navNames.some((x) => x.indexOf(n) >= 0)),
      JSON.stringify(navNames))

    const visibleSects = () => $$('#smodal .settings-body .sect').filter((s) => s.offsetParent !== null)
    const sectTitles = () => visibleSects().map((s) => (((s.querySelector('h4') || {}).textContent) || '').trim())
    const clickNav = (n) => {
      const b = navBtns().find((x) => (x.textContent || '').indexOf(n) >= 0)
      if (!b) return false
      b.click(); return true
    }

    check('★ 默认停在第 1 类「通用」：右侧只渲染该分类的小节（不再全挤在一起）',
      sectTitles().length === 2 && sectTitles().join('|').indexOf('版本与更新') >= 0
      && sectTitles().join('|').indexOf('外观主题') >= 0,
      JSON.stringify(sectTitles()))
    check('  「通用」在导航上高亮',
      navBtns().some((b) => (b.textContent || '').indexOf('通用') >= 0 && b.classList.contains('on')))

    check('能切到「备份与恢复」', clickNav('备份与恢复'))
    await sleep(250)
    check('★ 切换分类后右侧只剩该分类（上一类真的消失，不是叠在一起）',
      sectTitles().length === 1 && sectTitles()[0].indexOf('备份与恢复') >= 0, JSON.stringify(sectTitles()))
    check('★ 当前分类写进真身 prefs（fc_settings_tab=backup）—— 下次打开还停在这页',
      window.__fcTest.prefs().fc_settings_tab === 'backup', JSON.stringify(window.__fcTest.prefs().fc_settings_tab))

    check('能切到「项目」', clickNav('项目'))
    await sleep(250)
    check('★ 「项目」类下两个小节都在（项目列表 + 项目方针 —— 方针从备份区里挪出来了）',
      sectTitles().some((t) => t.indexOf('项目列表') >= 0) && sectTitles().some((t) => t.indexOf('项目方针') >= 0),
      JSON.stringify(sectTitles()))

    // ══ 设置页 · 看板归档（2026-10-03 卡 012；入口在「数据与归档」分类下）════════
    //  先注入「有 2 条超期」，这样等下把天数改成 30 时那次 refresh 就能拿到数。
    window.__fcTest.setOverdue(2)
    check('能切到「数据与归档」', clickNav('数据与归档'))
    await sleep(300)
    check('★ 「数据与归档」下三节都在（数据目录 / 日志清理 / 看板归档）',
      sectTitles().some((t) => t.indexOf('数据目录') >= 0) && sectTitles().some((t) => t.indexOf('日志清理') >= 0)
      && sectTitles().some((t) => t.indexOf('看板归档') >= 0),
      JSON.stringify(sectTitles()))
    const archSect = visibleSects().find((s) => (((s.querySelector('h4') || {}).textContent) || '').indexOf('看板归档') >= 0)
    check('  看板归档有保留天数输入框（0 = 关闭）', !!archSect && !!archSect.querySelector('input[type=number]'))
    const archInput = archSect ? archSect.querySelector('input[type=number]') : null
    const archAuto = archSect ? archSect.querySelector('input[type=checkbox]') : null
    check('★ 「启动时自动执行」默认**关**（归档会移动文件，默认不许动）', !!archAuto && archAuto.checked === false)
    if (archInput) {
      archInput.value = '30'
      archInput.dispatchEvent(new Event('input', { bubbles: true }))
      archInput.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(400)
    }
    check('  填 30 天后写入真身 prefs（fc_archive_days=30）',
      Number(window.__fcTest.prefs().fc_archive_days) === 30, JSON.stringify(window.__fcTest.prefs().fc_archive_days))

    const sov = $('#soverlay')
    if (sov) sov.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(300)
    check('设置面板已关闭', !$('#smodal'))

    check('能切回「看板」页签', clickText('看板'))
    check('★ 保留天数 > 0 且真有超期任务 → 看板顶部出现提示条（只提示，不静默动手）',
      await waitFor(() => !!$('.archive-overdue-bar'), 4000, '归档提示条'),
      'bar=' + $$('.archive-overdue-bar').length)
    const barBtn = $$('.archive-overdue-bar button').find((b) => (b.textContent || '').indexOf('移进归档区') >= 0)
    check('  提示条上有「移进归档区」按钮', !!barBtn)
    if (barBtn) {
      const origConfirm = window.confirm
      window.confirm = () => false
      barBtn.click()
      await sleep(300)
      check('★ 点按钮先弹二次确认；点「取消」→ **不动任何文件**（不静默归档）',
        window.__fcTest.callCount('tasksArchiveOverdue') === 0,
        'calls=' + window.__fcTest.callCount('tasksArchiveOverdue'))
      window.confirm = () => true
      barBtn.click()
      check('★ 确认之后才真调 IPC 归档',
        await waitFor(() => window.__fcTest.callCount('tasksArchiveOverdue') >= 1, 4000, 'archiveOverdue'),
        'calls=' + window.__fcTest.callCount('tasksArchiveOverdue'))
      window.confirm = origConfirm
    }

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
