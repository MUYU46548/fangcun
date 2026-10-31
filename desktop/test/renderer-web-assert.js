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
  /**
   * 切到某个视图页签 —— **低频页签现在收在「更多」里**（2026-10-25 暮雨要求折叠）。
   * 断言不能再假设"页签行一定有那个按钮"：先找页签行，找不到就开「更多」菜单再点。
   * ⚠ 必须是 async：浮层要一帧才渲染出来，同步点不到。
   */
  const openViewTab = async (label) => {
    const direct = $$('#views .vbtn').find((e) => (e.textContent || '').trim().indexOf(label) >= 0)
    if (direct) { direct.click(); await sleep(600); return true }
    const more = $('#views .more-btn')
    if (!more) return false
    more.click()
    await sleep(450)
    const opt = $$('.more-pop .more-opt').find((e) => (e.textContent || '').trim().indexOf(label) >= 0)
    if (!opt) return false
    opt.click()
    await sleep(750)
    return true
  }
  /**
   * 「点遮罩」的正确模拟（2026-10-11 用户第 3 条）。
   *
   * 遮罩的关闭手势已从 `@click.self` 改成 `@mousedown.self` —— 因为在文本框里按住拖选、
   * 光标滑出弹窗再松手时，`click` 的目标是「按下点与松开点的最近公共祖先」＝遮罩本身，
   * 于是 `@click.self` 判定为"点了遮罩"→ 弹窗整个关掉、草稿全丢。
   *
   * ⚠ 所以断言里模拟"点遮罩"**必须派发 mousedown**：只发 click 已经不再触发关闭，
   *   照着老写法写会得到"遮罩点不动"的假红（或更糟：把真回归盖住）。
   */
  const maskClick = (sel) => {
    const el = typeof sel === 'string' ? $(sel) : sel
    if (!el) return false
    const opt = { bubbles: true, cancelable: true, view: window }
    el.dispatchEvent(new MouseEvent('mousedown', opt))
    el.dispatchEvent(new MouseEvent('mouseup', opt))
    el.dispatchEvent(new MouseEvent('click', opt))
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

    // ══ 免责与知情声明 · 首启强制确认（2026-10-16 暮雨第 1 条）══════════════
    // 这一节**必须排在最前**：无头 profile 每次都是全新的（e2e-renderer-web.cjs 现 mkdtemp），
    // 所以 App.onMounted 会判定"没确认过"→ 强制弹窗自己弹出来、**挡着整页**。
    // 这里把它真跑一遍（弹 → 拦遮罩 → 拦 ESC → 滚到底 → 勾选 → 确认），让它退场；
    // 不这么做，后面所有几何断言都会被遮罩污染（那是假红，不是界面坏了）。
    {
      const dlgSel = '[aria-label="免责与知情声明"]'
      check('★★ 首启（本机没确认过声明）自动弹出强制确认框',
        await waitFor(() => !!$(dlgSel), 6000, '免责弹窗出现'))
      const dlg = $(dlgSel)
      if (dlg) {
        check('★★ 弹的是「使用前请确认」强制态（不是随时查看态）',
          (dlg.textContent || '').indexOf('使用前请确认') >= 0,
          String(dlg.textContent || '').slice(0, 60))
        check('★★ 短版把「AI 功能要先看清花钱这件事」摆在显眼位置（暮雨点名的那件事）',
          (dlg.textContent || '').indexOf('AI 功能要先看清花钱这件事') >= 0,
          String(dlg.textContent || '').slice(0, 300))
        check('★ 短版写明费用由你与服务方结算、界面上的花销只是估算',
          (dlg.textContent || '').indexOf('只是估算') >= 0)

        // ① 点遮罩关不掉（强制模式刻意不给 @mousedown.self 的关闭分支）
        const maskEl = dlg.parentElement
        if (maskEl) {
          maskClick(maskEl)
          await sleep(160)
          check('★★ 强制模式下点遮罩**关不掉**（真锁模态，不是视觉遮挡）', !!$(dlgSel))
        }
        // ② ESC 也关不掉（不许有旁路）
        //    ⚠ 上一条（点遮罩关不掉）如果已经红了，说明弹窗**当场就被关掉了** ——
        //    这时 ESC 无对象可测。显式跳过并留一行说明，**不许**静默连锁红
        //    （连锁红会让人以为有两处坏，实际是同一个洞）。
        if ($(dlgSel)) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await sleep(160)
          check('★★ 强制模式下 ESC **也关不掉**（不许有旁路）', !!$(dlgSel))
        } else {
          out.push('    （跳过 ESC 断言：点遮罩那条已经红了 —— 弹窗已被关掉，无对象可测）')
        }

        // ③ 滚到底 → 勾选 → 确认
        //    ⚠ 同样：弹窗若已被上游断言关掉，这一组整组显式跳过（不许连锁出假红，
        //    也不许让"点确认后弹窗退场"变成**假绿**——它必须建立在"点之前弹窗确实在"上）。
        if (!$(dlgSel)) {
          out.push('    （跳过「滚到底 → 勾选 → 确认」一组：弹窗已被上游断言关掉，无对象可测）')
        } else {
          const body = dlg.querySelector('div[class*="overflow-y-auto"]')
          if (body) {
            body.scrollTop = body.scrollHeight + 100
            body.dispatchEvent(new Event('scroll', { bubbles: true }))
          }
          await sleep(200)
          const cb = dlg.querySelector('input[type="checkbox"]')
          check('★ 有「我已阅读并同意」的勾选框', !!cb)
          if (cb) {
            const okBefore = $$(dlgSel + ' button').find((b) => (b.textContent || '').trim() === '我已阅读并同意')
            check('★★ 没勾选之前「我已阅读并同意」**点不动**（disabled）',
              !!okBefore && okBefore.disabled === true, okBefore ? String(okBefore.disabled) : 'no button')
            cb.checked = true
            cb.dispatchEvent(new Event('change', { bubbles: true }))
            await sleep(150)
            const okAfter = $$(dlgSel + ' button').find((b) => (b.textContent || '').trim() === '我已阅读并同意')
            check('★ 勾选之后确认按钮变成可点', !!okAfter && okAfter.disabled === false)
            if (okAfter) okAfter.click()
            check('★★ 点确认后弹窗退场（不再挡着界面）',
              await waitFor(() => !$(dlgSel), 3000, '免责弹窗关闭'))
            let ack = null
            try { ack = JSON.parse(localStorage.getItem('fc_disclaimer_ack') || 'null') } catch (e) { ack = null }
            check('★★ 确认记录真的落盘，且带版本号（声明改版后下次启动能自动再弹）',
              !!ack && typeof ack.v === 'string' && ack.v.length > 0,
              String(localStorage.getItem('fc_disclaimer_ack') || ''))
          }
        }
      }
      await sleep(300)
    }

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
    check('★ 看板页头有视图切换器（列视图 / 列表视图 / 信息卡墙），且都是真 button',
      sw.ok && sw.btns.length >= 3
      && sw.btns.some((b) => b.t.indexOf('列视图') >= 0)
      && sw.btns.some((b) => b.t.indexOf('列表视图') >= 0)
      && sw.btns.some((b) => b.t.indexOf('信息卡墙') >= 0),
      JSON.stringify(sw))
    check('★ 默认仍是**旧视图**（列视图高亮、另两种未选）—— 要的是"旧的可以保留"，不是被换掉',
      sw.ok && sw.btns.some((b) => b.t.indexOf('列视图') >= 0 && b.on)
      && !sw.btns.some((b) => b.t.indexOf('列表视图') >= 0 && b.on)
      && !sw.btns.some((b) => b.t.indexOf('信息卡墙') >= 0 && b.on),
      JSON.stringify(sw.btns))
    check('  切换器旁有一句说明（不必先点一遍才知道各摆法差在哪）',
      sw.ok && String(sw.hint).length > 6, String(sw.hint))

    // ── 状态筛选（2026-10-10 用户要求；2026-10-11 换成「方案 B · 条件标签化」）──────
    // 用户原话：「看板信息卡墙如果能同时按项目+按状态筛选就好了」「待验收和待办混在一起我眼睛很累」
    // 「筛选应该随心所欲，随机应变」；改版理由：「点起来很难受，不自然」——
    // 原来是原生 select（点开→再点一项、选完看不到生效的是什么），现在是一点即生效的标签。
    // ⚠ 类名 `.st-filter` **故意保留**（它是"看板有自己的状态筛选"这件事的锚点）。这里验：
    //   ① 触发按钮在；② 点开面板；③ **一次点击**某个状态即生效；④ 出现可点 ✕ 的生效标签；⑤ 点 ✕ 可撤销。
    const stBtn = $('.fbar-filter-btn')
    check('★ 看板顶栏有状态筛选（触发按钮，类名仍是 .st-filter）', !!stBtn,
      stBtn ? String(stBtn.textContent).trim() : '(没找到 .fbar-filter-btn)')
    // 2026-10-12「看与做分两层」：项目/状态两个独立触发按钮**撤掉了**（功能在筛选浮层里，
    // 当前值由「生效中」标签承担，点击次数不变）。补这条设计断言 —— 防下一个 AI 以为丢了又加回来。
    check('「项目」「状态」「到期」三个独立触发按钮已撤（防有人又加回来）',
      !$('.proj-select') && !$('.st-filter') && !$('.due-filter'),
      'proj=' + !!$('.proj-select') + ' st=' + !!$('.st-filter'))

    const filledCols = () => $$('#board .col').filter((c) => c.querySelectorAll('.card').length > 0)
    if (stBtn) {
      const beforeCols = filledCols().length
      stBtn.click()
      await sleep(300)
      check('★ 点它就地展开一块面板（不是原生下拉 —— 原生要"点开→再点一项"）',
        !!$('.fpop'), 'panel=' + (!!$('.fpop')))
      const opt = $$('.fpop .fpop-opt').find((b) => (b.textContent || '').trim() === '进行中')
      check('  面板里的状态选项本身就是按钮（一次点击即生效）', !!opt)
      if (opt) {
        opt.click()
        await sleep(600)
        const afterStatuses = filledCols().map((c) => c.getAttribute('data-status'))
        check('★★ 一次点击「进行中」→ 只剩该状态的分区有卡（其余分区全空）',
          beforeCols > 1 && afterStatuses.length === 1 && afterStatuses[0] === '进行中',
          `before=${beforeCols} after=${JSON.stringify(afterStatuses)}`)
        // 方案 B 的核心价值：**现在筛了什么一眼可见**（老版藏在四个下拉各自的显示值里）
        const chip = $$('.fbar-chip').find((c) => (c.textContent || '').indexOf('进行中') >= 0)
        check('★★ 生效条件出现在「生效中」标签里（这就是"不自然"被治好的地方）', !!chip,
          $$('.fbar-chip').map((c) => String(c.textContent).trim()).join(' / '))
        const x = chip && chip.querySelector('.fbar-x')
        check('  标签上带 ✕（撤掉不用再打开任何面板）', !!x)
        if (x) {
          x.click()
          await sleep(600)
          check('★ 点 ✕ 就地撤销 → 各分区恢复（筛选可逆，且不要求回头翻下拉）',
            filledCols().length === beforeCols,
            `${filledCols().length} vs ${beforeCols}`)
          check('  撤销后「生效中」那一行整行消失（不留空壳）',
            $$('.fbar-chip').length === 0, 'chips=' + $$('.fbar-chip').length)
        }
      }
      // 面板要能收起来（不然它会一直占着屏幕）
      // ⚠ 收起用 Esc，不用找 ✕：**只有「＋筛选」那个浮层有标题栏和 ✕**（内容多的才需要），
      //   状态/项目/分组/排序这四个是单行 chips，成熟做法就是不给标题栏 —— 靠点外面或 Esc 收。
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(400)
      check('  面板可收起（Esc）', !$('.fpop'), 'still=' + $$('.fpop').length)
    }

    // ══ 用户 2026-10-11 第二条驳回 + **2026-10-12 二次驳回** ═══════════════════════
    // 10-11 原话：「一点筛选顶部直接变肥」「"折叠全部"的文字都飞了」。
    // 10-12 原话：「现在这个搜索框未免太长太恐怖了，看着很难受。人家浏览器顶上写链接，
    //              才需要那么长。**折叠全部按钮的文本都没了，根本认不出来**。
    //              而且**返回按钮也没了**。另外其实我还想加其他主按钮，比如首页、帮助手册、同步等等。」
    // 全部用**几何 / 结构**钉住 —— 这类问题肉眼才看得出来，"元素存在"断言不到。
    {
      const barH0 = $('#bar') ? $('#bar').offsetHeight : -1
      const foldBtn = $('#btn-fold-all')
      const foldH = foldBtn ? Math.round(foldBtn.getBoundingClientRect().height) : -1
      const foldWS = foldBtn ? getComputedStyle(foldBtn).whiteSpace : ''
      // 判据三件，缺一不可：
      //   · 计算样式是 nowrap —— 这是"不折行"的**机制**（改了它下次窗口一窄就复发）
      //   · 高度与同排其它按钮一致 —— 折行的直接后果就是比邻居高一截（几何证据）
      //   · **文案里有「折叠」或「展开」** —— 2026-10-12 暮雨原话「折叠全部按钮的文本都没了，
      //     根本认不出来」：上一轮收成纯 `⊟` 就是这条钉漏了（只钉了"不折行"，没钉"看得懂"）
      const foldTxt = foldBtn ? String(foldBtn.textContent).trim() : ''
      const peer = $$('.fbar-btn').find((b) => b.offsetParent !== null)
      const peerH = peer ? Math.round(peer.getBoundingClientRect().height) : -1
      check('★ 「折叠全部」不折行（用户截图：四个字被压成两行飞了）',
        !!foldBtn && foldWS === 'nowrap' && foldH > 0 && peerH > 0 && Math.abs(foldH - peerH) <= 2,
        `h=${foldH} peer=${peerH} white-space=${foldWS}`)
      check('★★ 「折叠」按钮**带文字**且一眼可读（2026-10-12：收成纯 ⊟ 被用户驳回"认不出来"）',
        /折叠|展开/.test(foldTxt),
        `text="${foldTxt}"`)

      // ── 2026-10-12 新增：顶栏左侧按钮组（暮雨：「放顶栏左侧，参考 Edge」）─────────
      // 四个按钮各有断言：返回必须**常驻**（不再 v-if 时有时无）、首页/帮助/同步必须真的可点。
      const backBtn = $('.nav-back')
      check('★★ 「← 返回」按钮**常驻**（不再 v-if="canGoBack" —— 用户报"返回按钮没了"的真因）',
        !!backBtn && backBtn.offsetParent !== null,
        backBtn ? 'text="' + String(backBtn.textContent).trim() + '"' : '(不在 DOM)')
      check('  没有历史时「← 返回」是 disabled 置灰（还在原位，不是消失）',
        !!backBtn && (backBtn.disabled === true || backBtn.classList.contains('disabled')),
        backBtn ? 'disabled=' + backBtn.disabled : '')
      const homeBtn = $('.navgroup .nav-ico-home, #bar .navgroup button[title*="首页"]')
      const helpBtn = $('#bar .navgroup button[title*="帮助"]')
      const syncBtn = $('#bar .navgroup button[title*="同步"]')
      check('★★ 顶栏有「首页 / 帮助 / 同步」三个入口（2026-10-12 暮雨第 4 条）',
        !!homeBtn && !!helpBtn && !!syncBtn,
        `home=${!!homeBtn} help=${!!helpBtn} sync=${!!syncBtn}`)

      // ── 同步状态胶囊：阶段 + 耗时（2026-10-25 卡 004）────────────────────────
      // 暮雨原话：「Git 同步转圈依然很抽象，能不能搞个进度条或者额外的转圈动画？
      //           全世界那么多软件没见过这样整个按钮拿去旋转的，太傻了。」
      // ⚠ 这里不写真 git：夹具把 push "按住"，手动喂阶段，再手动结束 ——
      //   否则真 git 几百毫秒就跑完，"进行中"那一帧根本抓不到（这也是以前只能验"点了没"的原因）。
      if (syncBtn) {
        const capTxt = () => {
          const el = $('#bar .navgroup .sync-cap-txt')
          return el ? String(el.textContent || '').trim() : ''
        }
        const glyph = () => {
          const g = $('#bar .navgroup .sync-btn .ico-glyph')
          return g ? String(g.textContent || '').trim() : ''
        }
        const syncEl = () => $('#bar .navgroup .sync-btn')

        window.__fcTest.holdSync()
        syncBtn.click()
        await sleep(150)
        check('★★ 点同步后按钮变成**胶囊**（不再只是一个转圈图标）', capTxt() !== '',
          'cap="' + capTxt() + '"')
        // ⚠ 必须跨过**一个计时器周期**再断言：只在 150ms 时看，就算阶段是"按时间猜"的
        //   也还没猜到（第一版反例注入到计时器里就是这么漏过去的 —— 断言绿了，行为是错的）。
        await sleep(800)
        check('★ 还没收到阶段时说「同步中」（不许硬编一个阶段糊弄）',
          /^同步中 \d+s$/.test(capTxt()), capTxt())
        check('★ 阶段不会被计时器猜出来（跨过一个周期后仍不是「推送」）',
          capTxt().indexOf('推送') < 0, capTxt())
        const subs = window.__fcTest.emitSyncProgress('push')
        check('★ 阶段流真的订阅上了（主进程报阶段时渲染层有人接）', subs === 1, 'subs=' + subs)
        await sleep(120)
        // 期望值从**真身**算（此刻已过 0.9 秒，秒数可能是 0 或 1）—— 关键是阶段变了，
        // 不写死 0s（写死就是每月一跳的定时炸弹，这里已经踩过一次）
        check('★★ 主进程报「推送」→ 胶囊立刻显示「推送 Ns」',
          /^推送 \d+s$/.test(capTxt()), capTxt())
        check('★ 不编进度：胶囊里没有百分号', capTxt().indexOf('%') < 0)
        check('★ 转的还是**字符**不是按钮本体',
          !!$('#bar .navgroup .sync-btn.syncing') && !!$('#bar .navgroup .sync-btn .ico-glyph'))

        await sleep(1200)
        const t2 = capTxt()
        check('★★ 秒数是**真实计时**（1.2 秒后 >= 1s）', /(^|\s)([1-9]\d*)s$/.test(t2), t2)
        check('★ 阶段不会被时间悄悄改掉（仍是「推送」）', t2.indexOf('推送') >= 0, t2)

        window.__fcTest.releaseSync(true)
        await sleep(450)
        check('★★ 成功后胶囊变「已同步」', capTxt() === '已同步', capTxt())
        check('★ 图标换成 ✓', glyph() === '✓', 'glyph=' + glyph())
        check('★ 成功态有绿色标记（.sync-ok）', !!$('#bar .navgroup .sync-btn.sync-ok'))
        const toastOk = (($('#toast') || {}).textContent || '')
        check('  toast 说的是同步成功 + 消息原文（不吞消息）',
          toastOk.indexOf('同步成功') >= 0 && toastOk.indexOf('12 个文件') >= 0, toastOk.slice(0, 60))
        check('★ 收尾退订了阶段流（不留监听，否则每同步一次多挂一个）',
          window.__fcTest.syncSubs() === 0, 'subs=' + window.__fcTest.syncSubs())

        await sleep(3300)
        check('★★ 3 秒后回到图标态（胶囊消失，glyph 回 ⟳）',
          capTxt() === '' && glyph() === '⟳', 'cap="' + capTxt() + '" glyph=' + glyph())

        // 失败态：必须说「未同步」，不能糊成成功
        window.__fcTest.holdSync()
        const syncEl2 = syncEl()
        if (syncEl2) syncEl2.click()
        await sleep(150)
        window.__fcTest.releaseSync(false, '连不上远端（网络或地址不可达）')
        await sleep(450)
        check('★★ 失败态是「未同步」+ ⚠（绝不显示已同步）',
          capTxt() === '未同步' && glyph() === '⚠', 'cap="' + capTxt() + '" glyph=' + glyph())
        check('★ 失败态有红色标记（.sync-bad）', !!$('#bar .navgroup .sync-btn.sync-bad'))
        check('★ 失败也退订了（成功失败都不能漏）', window.__fcTest.syncSubs() === 0)
        const toastBad = (($('#toast') || {}).textContent || '')
        check('  失败 toast 里有主进程给的原因（不甩 git stderr 也不吞掉）',
          toastBad.indexOf('连不上远端') >= 0, toastBad.slice(0, 70))
        await sleep(3300)
        check('  失败态同样 3 秒后回图标', capTxt() === '' && glyph() === '⟳',
          'cap="' + capTxt() + '"')
      }

      // ── 顶栏「刷新」= 真的重读全部数据（2026-10-25 暮雨）─────────────────────
      // 原话：「顶栏加一个真的『重读全部数据』，而且要明确写"刷新"，
      //        不然用户会以为是第二个同步按钮。」
      // 三条判据：① 文字里真的有「刷新」两个字（不是纯图标）；② 和左边那个同步是两个按钮；
      //          ③ 点一下**多份数据**都被重读（不是只刷任务）。
      {
        const refreshBtn = $('#views .refresh-all')
        const txt = refreshBtn ? String(refreshBtn.textContent || '').trim() : ''
        check('★★ 顶栏有「刷新」按钮', !!refreshBtn, refreshBtn ? '' : '(没找到 #views .refresh-all)')
        check('★★ 按钮上有**文字**「刷新」（纯图标会被当成第二个同步按钮）',
          txt.indexOf('刷新') >= 0, 'text="' + txt + '"')
        check('★ 它和「同步」是两个不同的按钮（不是同一个换了文案）',
          !!refreshBtn && !!syncBtn && refreshBtn !== syncBtn && !refreshBtn.classList.contains('ico'))
        check('  它的 title 说清"这不是同步"',
          !!refreshBtn && (refreshBtn.getAttribute('title') || '').indexOf('不是同步') >= 0,
          refreshBtn ? String(refreshBtn.getAttribute('title') || '').slice(0, 40) : '')

        if (refreshBtn) {
          const before = {
            tasks: window.__fcTest.callCount('loadTasks'),
            logs: window.__fcTest.callCount('logsList'),
            todos: window.__fcTest.callCount('todosList'),
            ideas: window.__fcTest.callCount('ideasList'),
          }
          refreshBtn.click()
          await sleep(1200)
          const after = {
            tasks: window.__fcTest.callCount('loadTasks'),
            logs: window.__fcTest.callCount('logsList'),
            todos: window.__fcTest.callCount('todosList'),
            ideas: window.__fcTest.callCount('ideasList'),
          }
          check('★★ 点「刷新」= 任务真的被重读', after.tasks > before.tasks,
            before.tasks + ' → ' + after.tasks)
          check('★★ 日志 / 待办 / 想法也一起重读了（不是只刷任务）',
            after.logs > before.logs && after.todos > before.todos && after.ideas > before.ideas,
            JSON.stringify({ logs: [before.logs, after.logs], todos: [before.todos, after.todos], ideas: [before.ideas, after.ideas] }))
          const toastTxt = (($('#toast') || {}).textContent || '')
          check('  刷完有反馈（toast 说重读了 / 或点名哪几项失败）',
            toastTxt.indexOf('重读') >= 0 || toastTxt.indexOf('失败') >= 0, toastTxt.slice(0, 60))
        }
      }

      // ── 设置 → Agent → 模型单价（2026-10-25 卡 005 B 档）────────────────────
      // 这块的立场：**空表就是一律未折算**，方寸不预置任何默认价（暮雨 19:00 那次异议）。
      {
        // 顶栏的 ⚙ 没有 title，按文字找（`:has()` 别用 —— 选择器一抛，整份断言就断了）
        const gearBtn = $$('#views button, #bar button').find((b) => (b.textContent || '').trim() === '⚙')
        if (gearBtn) gearBtn.click()
        await sleep(700)
        const navAgent = $$('#smodal .settings-nav-btn').find((b) => (b.textContent || '').indexOf('Agent') >= 0)
        check('★ 设置侧边栏有「Agent」分类', !!navAgent)
        if (navAgent) {
          navAgent.click()
          await sleep(500)
          const sect = $$('#smodal .sect').find((x) => {
            const h = x.querySelector('h4')
            return x.offsetParent !== null && h && (h.textContent || '').indexOf('模型单价') >= 0
          })
          check('★★ Agent 分类里有「模型单价（可选）」小节', !!sect)
          if (sect) {
            const st = (sect.textContent || '').replace(/\s+/g, ' ')
            check('★ 说明写明单位「元 / 百万 tokens」', st.indexOf('元 / 百万 tokens') >= 0, st.slice(0, 90))
            check('★★ 说明写明「不填就是未折算」与「不内置任何默认价」（口径不许含糊）',
              st.indexOf('不填就是') >= 0 && st.indexOf('不内置任何默认价') >= 0, st.slice(0, 160))
            const rows0 = $$('#smodal .price-row').length
            check('★ 夹具那一行单价读出来了（deepseek-chat）',
              st.indexOf('deepseek-chat') >= 0
              || $$('#smodal .price-model').some((i) => (i.value || '').indexOf('deepseek-chat') >= 0), st.slice(0, 120))

            const addBtn = $$('#smodal button').find((b) => (b.textContent || '').indexOf('加一行') >= 0)
            check('★ 有「＋ 加一行」', !!addBtn)
            if (addBtn) {
              addBtn.click()
              await sleep(250)
              check('★ 点它能多一行输入', $$('#smodal .price-row').length === rows0 + 1,
                rows0 + ' → ' + $$('#smodal .price-row').length)
              // 填一行新单价并保存 → 真过桥、真落盘（读 __fcTest.prices() 真身）
              const last = $$('#smodal .price-row').pop()
              const inputs = last ? last.querySelectorAll('input') : []
              if (inputs.length === 3) {
                const set = (el, v) => {
                  el.value = v
                  el.dispatchEvent(new Event('input', { bubbles: true }))
                  el.dispatchEvent(new Event('change', { bubbles: true }))
                }
                set(inputs[0], 'mimo-v2.6-flash')
                set(inputs[1], '0.5')
                set(inputs[2], '1')
                await sleep(200)
                const n0 = window.__fcTest.callCount('llmSetPrices')
                const saveBtn = $$('#smodal button').find((b) => (b.textContent || '').indexOf('保存单价') >= 0)
                check('★ 有「保存单价」按钮', !!saveBtn)
                if (saveBtn) {
                  saveBtn.click()
                  await sleep(600)
                  check('★★ 点保存真的过桥（llmSetPrices 被调用）',
                    window.__fcTest.callCount('llmSetPrices') > n0,
                    n0 + ' → ' + window.__fcTest.callCount('llmSetPrices'))
                  const saved = window.__fcTest.prices()
                  check('★★ 存下来的真身里有这一行（不是界面自说自话）',
                    saved.some((r) => r.model === 'mimo-v2.6-flash'), JSON.stringify(saved))
                  check('★ 保存后给了明确的落地反馈', (($('#toast') || {}).textContent || '').indexOf('单价已保存') >= 0,
                    (($('#toast') || {}).textContent || '').slice(0, 50))
                }
              }
            }
          }
        }
        // 收尾：把夹具改回去，别污染后面的断言
        window.__fcTest.restorePrices && window.__fcTest.restorePrices()
        const closeS = $$('#smodal button').find((b) => (b.textContent || '').trim() === '关闭')
        if (closeS) closeS.click()
        await sleep(400)
        check('  收尾：设置已关闭', !$('#smodal'))
      }

      // ── 顶栏「更多」：低频页签折叠（2026-10-25 暮雨）────────────────────────
      // 原话：「帮我搞个更多菜单，该折叠的就折叠。我认为"技能""服务""启动台"都可以收起来……
      //        最少维持 7 个功能按钮在场。」
      // 判据：① 那三个默认不在页签行；② 在「更多」里；③ 点它能切过去且按钮显示当前页名。
      {
        const tabTexts = $$('#views .vbtn').map((b) => (b.textContent || '').trim())
        const moreBtn = $('#views .more-btn')
        check('★★ 顶栏有「更多」按钮', !!moreBtn, tabTexts.join(' | '))
        check('★★ 默认收起「技能 / 服务 / 启动台」三个低频页签（不在页签行）',
          tabTexts.every((t) => t.indexOf('技能') < 0 && t.indexOf('服务') < 0 && t.indexOf('启动台') < 0),
          tabTexts.join(' | '))
        check('★ 页签行仍有 >= 7 个页签在场（最少维持 7 个）',
          tabTexts.filter((t) => t && t.indexOf('更多') < 0).length >= 7,
          '在场 ' + tabTexts.filter((t) => t && t.indexOf('更多') < 0).length + ' 个')

        if (moreBtn) {
          moreBtn.click()
          await sleep(500)
          const pop = $('.more-pop')
          check('★★ 点「更多」弹出被收起的页签', !!pop, pop ? '' : '(没有 .more-pop)')
          const rows = pop ? $$('.more-pop .more-opt') : []
          const labels = rows.map((b) => ((b.querySelector('.more-txt') || b).textContent || '').trim())
          check('★★ 菜单 = 三个页签 + 一条设置入口（四行，不多不少）',
            labels.length === 4
            && ['技能', '服务', '启动台'].every((t) => labels.some((x) => x.indexOf(t) >= 0))
            && labels[3].indexOf('设置') >= 0,
            JSON.stringify(labels))

          // ── 形状（2026-10-25 第二轮，暮雨拿系统菜单截图对比后否掉第一版）─────────
          // 原话：「收起页签太丑了，底下那坨文本把框挤长而且完全没必要。」
          // 所以这三条钉的是**菜单不是面板**：无标题栏、无说明段落、整体不臃肿。
          check('★★ 菜单里没有标题栏（旧版「收起的页签」+ ✕ 已删）',
            !!pop && !pop.querySelector('.fpop-h') && !pop.querySelector('.fpop-close'))
          check('★★ 菜单里没有底部说明段落（就是它把框撑长的）',
            !!pop && !pop.querySelector('.more-hint')
            && (pop.textContent || '').indexOf('想改哪些收起来') < 0,
            pop ? (pop.textContent || '').replace(/\s+/g, ' ').slice(0, 90) : '')
          if (pop) {
            const ph = pop.getBoundingClientRect().height
            // 层级（2026-10-27 暮雨截图抓到的真 bug）：菜单在日志页被 sticky 栏压在下面，
          // 只露出下半截。真因是重做时把 `.fpop` 去掉、**连带丢了它的 z-index**，
          // 而 reka-ui 是靠 getComputedStyle(内容).zIndex 读走写到外层 wrapper 的 —— 没有就是 auto。
          check('★★ 浮层有显式 z-index（没有就会被页面 sticky 栏压住、只露半截）', (() => {
            const el = $('.more-pop')
            if (!el) return false
            const wrap = el.closest('[data-reka-popper-content-wrapper]') || el.parentElement
            const z = wrap ? getComputedStyle(wrap).zIndex : ''
            return z !== '' && z !== 'auto' && Number(z) >= 20
          })(), (() => {
            const el = $('.more-pop')
            const wrap = el && (el.closest('[data-reka-popper-content-wrapper]') || el.parentElement)
            return 'wrapper z=' + (wrap ? getComputedStyle(wrap).zIndex : '?')
          })())

          check('★★ 浮层不臃肿（整体高度 <= 160px；旧版光那段说明就占两行）',
              ph > 0 && ph <= 160, 'height=' + ph.toFixed(1))
            const rowHs = rows.map((b) => b.getBoundingClientRect().height)
            check('  四行等高（28px ± 2），不像一排输入框',
              rowHs.length === 4 && rowHs.every((h) => Math.abs(h - 28) <= 2),
              JSON.stringify(rowHs.map((h) => Math.round(h))))
          }

          const skillOpt = rows.find((b) => (b.textContent || '').indexOf('技能') >= 0) || null
          if (skillOpt) {
            skillOpt.click()
            await sleep(800)
            check('★★ 点菜单项真的切过去了（技能页渲染）', !!$('#board.skills-view, .skills-view'),
              '当前 DOM 里没有 .skills-view')
            const moreTxt = ($('#views .more-btn') || {}).textContent || ''
            check('★★ 停在被收起的页签里时，「更多」按钮显示那一页的名字（不许"不知道自己在哪"）',
              moreTxt.indexOf('技能') >= 0, 'more-btn="' + moreTxt.trim() + '"')
            check('  且它是高亮态', !!$('#views .more-btn.on'))
            // 收尾：回看板
            clickText('看板')
            await sleep(600)
            check('  收尾：回到看板，「更多」按钮恢复成"更多"两个字',
              (($('#views .more-btn') || {}).textContent || '').indexOf('看板') < 0)
          } else {
            check('  菜单里有「技能」项', false, '没找到')
          }

          // 最后一条：底部那句话改成的菜单项**真能点**（纯文本换成一个入口，不是删了了事）
          const moreBtn2 = $('#views .more-btn')
          if (moreBtn2) {
            moreBtn2.click()
            await sleep(450)
            const setOpt = $$('.more-pop .more-opt').find((b) => (b.textContent || '').indexOf('顶栏页签设置') >= 0)
            check('★★ 「顶栏页签设置…」是一条真菜单项（不是干巴巴的说明文字）', !!setOpt,
              $$('.more-pop .more-opt').map((b) => (b.textContent || '').trim()).join(' | '))
            if (setOpt) {
              setOpt.click()
              await sleep(900)
              check('★★ 点它 → 设置打开且停在「通用」（能直接勾页签）',
                !!$('#smodal') && $('.sect:not([style*="display: none"]) h4') !== null)
              const generalOn = $$('#smodal .sect').some((x) => {
                const h = x.querySelector('h4')
                const vis = x.offsetParent !== null
                return vis && h && (h.textContent || '').indexOf('顶栏页签') >= 0
              })
              check('★★ 停的那一页里真能看到「顶栏页签」小节', generalOn)
              const closeS = $$('#smodal button').find((b) => (b.textContent || '').trim() === '关闭')
              if (closeS) closeS.click()
              await sleep(500)
              check('  收尾：设置已关闭（不污染后面的断言）', !$('#smodal'))
            }
          }
        }
      }

      // ── 顶栏「⚠ N 个文件无法解析」（2026-10-23 补：这条此前**零断言**）──────────
      // 为什么它值得单独立断言：parseTask 失败返 null 被静默跳过 = 任务卡"人间蒸发"，
      // 这是用户几个月后才发现的那类事故。这条红 chip 就是唯一的防线，
      // 而假 preload 的 `parseErrors` 一直恒返回 [] → 防线等于没测。
      const pw = $('#bar .parse-warn')
      check('★★ 顶栏有「⚠ N 个文件无法解析」红 chip（任务静默消失的唯一防线）',
        !!pw && pw.offsetWidth > 0, pw ? String(pw.textContent).trim() : '(不在 DOM)')
      check('★ 数字来自 parseErrors 的条数（2 个 → 显示 2，不是写死的文案）',
        !!pw && /2\s*个文件无法解析/.test(String(pw.textContent || '')),
        pw ? String(pw.textContent).trim() : '')
      check('★★ 悬停 title 里逐个列出坏文件名（光说"有 2 个"没法去修）',
        !!pw && String(pw.getAttribute('title') || '').indexOf('task-20261001-001.md') >= 0
        && String(pw.getAttribute('title') || '').indexOf('task-20261002-002.md') >= 0,
        String((pw && pw.getAttribute('title')) || '(无 title)'))

      const stB = $('.fbar-filter-btn')
      if (stB) {
        stB.click()
        await sleep(450)
        // ⚠⚠ 量浮层要量 **reka 的外层 wrapper**，不是我的 `.fpop`：
        //   reka 的 PopoverContent = <div data-reka-popper-content-wrapper>（**被定位的是这层**）
        //                            └ <div class="fpop">…</div>（我的 class 在内层）
        //   第一版量内层 → 内层是 static，断言红；更早那版还给内层写了 position:fixed，
        //   直接让外层量出 0×0、浮层被算到视口外（详见 App.vue 里 .fpop 的注释）。
        //   **量错层 = 假红/假绿**，这类断言必须量"真正被定位的那个元素"。
        const popWrap = () => $('[data-reka-popper-content-wrapper]')
        const popBody = () => $('.fpop')          // 内容层：点选项、找 ✕ 用它
        const wrap = popWrap()
        check('★★ 筛选面板是**浮层**（被定位的那层脱离文档流）—— 这正是"不把顶栏撑肥"的关键',
          !!wrap && getComputedStyle(wrap).position !== 'static',
          wrap ? ('pos=' + getComputedStyle(wrap).position + ' side=' + wrap.getAttribute('data-side')
            + ' align=' + wrap.getAttribute('data-align')) : '(没有 wrapper)')
        check('  内容层就在 wrapper 里（别把 class 挂错层）',
          !!popBody() && !!wrap && wrap.contains(popBody()),
          'body=' + !!popBody() + ' nested=' + (!!wrap && !!popBody() ? wrap.contains(popBody()) : '?'))
        const barH1 = $('#bar') ? $('#bar').offsetHeight : -1
        check('★★ 开面板前后**顶栏高度不变**（第一版铺在顶栏里 → 一点就涨成三大行、内容被顶下去）',
          barH0 > 0 && barH1 === barH0, `before=${barH0} after=${barH1}`)
        check('  浮层贴在触发按钮下方（定位交给 reka-ui 的 floating-ui，不再手算 rect）', (() => {
          if (!wrap || !stB) return false
          const pr = wrap.getBoundingClientRect(), br = stB.getBoundingClientRect()
          return pr.top >= br.bottom - 2 && pr.top <= br.bottom + 40
        })(), '')
        check('  浮层没跑出视口（越界会 flip/shift 往回收）', (() => {
          if (!wrap) return false
          const pr = wrap.getBoundingClientRect()
          return pr.left >= -1 && pr.right <= window.innerWidth + 1 && pr.width > 0
        })(), (() => {
          const pr = wrap ? wrap.getBoundingClientRect() : null
          const br = $('.fbar-filter-btn') ? $('.fbar-filter-btn').getBoundingClientRect() : null
          return (pr ? `wrap l=${Math.round(pr.left)} r=${Math.round(pr.right)} w=${Math.round(pr.width)}` : 'no wrapper')
            + (br ? ` | trigger l=${Math.round(br.left)} r=${Math.round(br.right)}` : ' | no trigger')
            + ` | vw=${window.innerWidth}`
        })())
        check('★ 浮层宽度是内容宽而不是 0（外层的 min-width:max-content 得能量到东西）',
          !!wrap && Math.round(wrap.getBoundingClientRect().width) > 100,
          wrap ? 'w=' + Math.round(wrap.getBoundingClientRect().width) : 'no wrapper')
        // 顶栏两条硬要求（2026-10-11 用户两条反馈各自钉一条）：
        //  ① **不许横向溢出** —— 里面的按钮都是 `flex: none`（不许压字折行），溢出的后果不只是
        //     "看着挤"：触发按钮跑到视口外之后，**浮层会跟着锚到视口外**（实测 vw=756 时右边缘 805）。
        //  ② **筛选控件必须和标题在同一行** —— 用户原话「还损失一个返回按钮，不知道去哪里了」：
        //     `#bar` 是 flex + `space-between` + wrap，`.ctrls` 一撑宽就整体换行，
        //     space-between 随即把「← 返回」**甩到上一行最右端**（它没消失，是离开了原位）。
        // 2026-10-12（重做丙案）新增两条 —— 都是**用户看得见的坏症状**的判据：
        //  ① 搜索框被压到占位文字截断：14 控件时代它只剩一半宽，占位文字在中间被切断；
        //  ② 标题与控件之间一大片空白：`#bar` 是 space-between，`.ctrls` 不撑满就会这样。
        // 2026-10-12 二次驳回**再修一条**：搜索框从"太短被切断"变成"太长太恐怖"——
        //   上一轮写 `flex: 1 1 220px` 让它吸走全部余量（实测 **877px**，暮雨：
        //   「人家浏览器顶上写链接，才需要那么长」）。**上限**必须钉住：吸满是这版的病。
        check('★ 搜索框宽度**上限** 340px（2026-10-12：上一版吸满全宽 877px，用户嫌"太长太恐怖"）',
          (() => {
            const inp = $('.fbar .search')
            if (!inp) return false
            const w = Math.round(inp.getBoundingClientRect().width)
            return w >= 180 && w <= 340
          })(),
          (() => {
            const inp = $('.fbar .search')
            return inp ? 'w=' + Math.round(inp.getBoundingClientRect().width) : 'no .fbar .search'
          })())
        check('  搜索框不许再吸余量（计算样式的 flex-grow 必须是 0，否则窗口一变宽就复发）',
          (() => {
            const inp = $('.fbar .search')
            return !!inp && getComputedStyle(inp).flexGrow === '0'
          })(),
          (() => {
            const inp = $('.fbar .search')
            return inp ? 'flex-grow=' + getComputedStyle(inp).flexGrow : 'no .fbar .search'
          })())
        check('★ 控件区撑满顶栏（标题与控件之间不许留一大片空白）',
          (() => {
            const bar = $('#bar'), c = $('#bar .ctrls')
            if (!bar || !c) return false
            return c.getBoundingClientRect().width >= bar.clientWidth * 0.6
          })(),
          (() => {
            const bar = $('#bar'), c = $('#bar .ctrls')
            return (bar && c) ? `ctrls=${Math.round(c.getBoundingClientRect().width)} bar=${bar.clientWidth}` : 'no bar'
          })())
        // ── 自然语言搜索（2026-10-23 补：这条路此前**一条断言都没有**）────────────
        // 桩 `naturalQuery` 一直返回 `[]`，而 App 读的是 `result.tasks` ——
        // 所以「回车搜 #标签 @项目」从头到尾没被验过：真调没调、参数对不对、
        // 结果有没有真的把板子收窄，三件事全是空白。
        {
          const sin = $('.fbar .search')
          check('前置：顶栏搜索框在（否则下面的回车无从谈起）', !!sin)
          const nQ0 = window.__fcTest.callCount('naturalQuery')
          if (sin) {
            sin.value = '#bug @demo'
            sin.dispatchEvent(new Event('input', { bubbles: true }))
            await sleep(80)
            sin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          }
          check('★★ 搜索框回车 → 真调 naturalQuery（不是本地字符串过滤）',
            await waitFor(() => window.__fcTest.callCount('naturalQuery') > nQ0, 4000, 'naturalQuery'),
            'calls=' + window.__fcTest.callCount('naturalQuery'))
          const nqArgs = (window.__fcTest.calls().filter((c) => c.name === 'naturalQuery').pop() || {}).args || []
          check('★★ 原文整串传下去（解析在主进程，界面不许自己拆 #标签 @项目）',
            nqArgs[0] === '#bug @demo', JSON.stringify(nqArgs))
          check('★ 「含归档」开关一起传（此前主进程硬跳过 archive，勾了也搜不到）',
            !!nqArgs[1] && typeof nqArgs[1].includeArchive === 'boolean', JSON.stringify(nqArgs[1]))
          check('★★ 结果真的收窄板子（只剩主进程返回的那张卡）',
            await waitFor(() => $$('#board .card, #board .task-card, #board .tcard').length === 1, 4000, '1 张卡'),
            'cards=' + $$('#board .card, #board .task-card, #board .tcard').length)
          // 收尾：清空搜索，别把"只剩 1 张"留给后面的断言（几乎每条都假设板子是全的）
          if (sin) {
            sin.value = ''
            sin.dispatchEvent(new Event('input', { bubbles: true }))
            await sleep(300)
          }
          check('  清空搜索后恢复全部卡（自然查询状态被重置，不是粘住）',
            await waitFor(() => $$('#board .card, #board .task-card, #board .tcard').length > 1, 4000, '恢复'),
            'cards=' + $$('#board .card, #board .task-card, #board .tcard').length)
        }

        // 2026-10-12：搜索框固定宽之后，"把筛选控件推到右端"的活由 `.fbar-grow` 撑杆干。
        // 判据用**可用空间**而不是"已用尺寸占比"（memory：几何断言别拿占比当判据）：
        //   排序按钮的右缘 应当贴近 顶栏右缘（中间的空白由撑杆吸收）。
        check('★ 筛选/分组/排序仍贴右端（搜索框固定宽后，余量交给撑杆吸收而不是留成缺口）',
          (() => {
            const bar = $('#bar')
            const sortBtn = $('.fbar-sort-btn')
            const grow = $('.fbar-grow')
            if (!bar || !sortBtn || !grow) return false
            const br = bar.getBoundingClientRect(), sr = sortBtn.getBoundingClientRect()
            const gr = grow.getBoundingClientRect()
            return (br.right - sr.right) <= 22 && gr.width >= 0
          })(),
          (() => {
            const bar = $('#bar'), sortBtn = $('.fbar-sort-btn'), grow = $('.fbar-grow')
            if (!bar || !sortBtn) return 'no bar/sort'
            return `barRight=${Math.round(bar.getBoundingClientRect().right)}`
              + ` sortRight=${Math.round(sortBtn.getBoundingClientRect().right)}`
              + (grow ? ` grow=${Math.round(grow.getBoundingClientRect().width)}` : ' no grow')
          })())
        // ── 顶栏几何（2026-10-15 拆成两条）──────────────────────────────────
        // 旧版把三件事塞进一条，其中"筛选控件与标题同排"在**窄视口**下必然为假 ——
        // 于是这条长期红着（`长期红 = 没保护`）。而真正的回归项只有：
        //   ① 不许横向溢出
        //   ② 左侧按钮组与标题必须同排（用户原话「还损失一个返回按钮，不知道去哪里了」
        //      —— 那不是消失，是被 space-between 甩到了别处）
        //   ③ **屏宽真放得下时**，筛选控件也必须同排（放不下时整行换行是既定行为，不是回归）
        // ③ 的"放得下"用**实测宽度**算，不用魔法常数：nav + title + ctrls 内容宽 + 内边距/间距。
        const barGeom = (() => {
          const bar = $('#bar'), ttl = $('#bar .title'), ctrls = $('#bar .ctrls'), nav = $('#bar .navgroup')
          if (!bar || !ttl || !ctrls) return null
          const top = (el) => Math.round(el.getBoundingClientRect().top)
          const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0)
          const cs = getComputedStyle(bar)
          const chrome = (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0)
            + 2 * (parseFloat(cs.columnGap || cs.gap) || 0)   // nav/title/ctrls 之间两个缝
          const need = w(nav) + w(ttl) + ctrls.scrollWidth + chrome
          return {
            noOverflow: bar.scrollWidth <= bar.clientWidth + 1,
            navSameRow: !nav || Math.abs(top(nav) - top(ttl)) <= 6,
            ctrlsSameRow: Math.abs(top(ctrls) - top(ttl)) <= 6,
            barClient: bar.clientWidth,
            need: Math.round(need),
          }
        })()

        check('★★ 顶栏不横向溢出 且 左侧按钮组与标题**同一行**（否则「← 返回」会被甩到别处）',
          !!barGeom && barGeom.noOverflow && barGeom.navSameRow,
          barGeom ? `scrollWidth/clientWidth 或 navTop 不合：${JSON.stringify(barGeom)}` : 'no bar')

        check('★★ 顶栏只占一行：屏宽放得下筛选控件时必须同排（放不下时整行换行 = 既定行为，不算回归）',
          !!barGeom && (barGeom.ctrlsSameRow || barGeom.barClient < barGeom.need),
          barGeom ? `barClient=${barGeom.barClient} need≈${barGeom.need} ctrlsSameRow=${barGeom.ctrlsSameRow}` : 'no bar')

        // ⚠ 下面两条是"用成熟原语"换来的行为（2026-10-11：改用 reka-ui 的 Popover）——
        //   上一版手搓的遮罩只能关"点遮罩"，Esc 与焦点归还得自己写。既然换成库，就把这两条
        //   钉住：**以后再手搓回去，这两条会立刻红**。
        // ⚠ reka 的 DismissableLayer 监听的是 **pointerdown**（不是 mousedown）——
        //   只发 mousedown 会得到"点外面关不掉"的**假红**。
        const PE = window.PointerEvent || MouseEvent
        document.body.dispatchEvent(new PE('pointerdown', { bubbles: true, cancelable: true }))
        document.body.dispatchEvent(new PE('pointerup', { bubbles: true, cancelable: true }))
        await sleep(400)
        check('★ 点浮层外面就关（库自带，不用自己写遮罩）', !$('.fpop'))

        stB.click(); await sleep(300)
        check('  能重新打开（关掉不是单向的）', !!$('.fpop'))
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(300)
        check('★ Esc 也能关（无障碍原语自带；手搓版没有这个）', !$('.fpop'))

        // ✕ 按钮只装在内容最多的「＋筛选」浮层上（其余四个是单行 chips，不给标题栏）
        const filterBtn = $('.fbar-filter-btn')
        if (filterBtn) {
          filterBtn.click(); await sleep(300)
          const c2 = $('.fpop .fpop-close')
          check('  内容多的浮层有标题栏与 ✕', !!c2)
          if (c2) c2.click()
          await sleep(300)
          check('  点 ✕ 也能关', !$('.fpop'))
        }
      }
    }

    // ── 分组 / 排序也走同一个面板（同一个入口模式，不搞第二套交互）──────────
    const groupBtn = $('.fbar-group-btn')   // 稳定类名（文案已改成只留当前值）
    check('★ 分组按钮显示**当前值**（老版下拉看不出选了什么）',
      !!groupBtn && (groupBtn.textContent || '').indexOf('按状态') >= 0,
      groupBtn ? String(groupBtn.textContent).trim() : '(没找到)')
    if (groupBtn) {
      groupBtn.click()
      await sleep(250)
      const gOpt = $$('.fpop .fpop-opt').find((b) => (b.textContent || '').trim() === '按项目')
      check('  点分组按钮开的是**同一个浮层**（不做嵌套下拉）', !!gOpt)
      if (gOpt) {
        gOpt.click()
        await sleep(500)
        check('★ 一次点击切到「按项目」分组，按钮文案跟着变',
          (groupBtn.textContent || '').indexOf('按项目') >= 0,
          String(groupBtn.textContent).trim())
        // ⚠ 切回原状时必须**先收浮层再点触发按钮**：触发按钮是 toggle，
        //   浮层开着时再点它只会把它关掉（第一版就踩了这个，导致后面按状态的断言全红）。
        // ⚠ 分组浮层是单行 chips，**没有 ✕**（成熟做法：点外面或 Esc 收）→ 这里用 Esc。
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(320)
        groupBtn.click(); await sleep(320)
        const back = $$('.fpop .fpop-opt').find((b) => (b.textContent || '').trim() === '按状态')
        check('  能从面板切回「按状态」（分组是可逆的）', !!back)
        if (back) back.click()
        await sleep(450)
        check('★ 结果：分组回到按状态（按钮上看得见），后面的按状态列断言才成立',
          (groupBtn.textContent || '').indexOf('按状态') >= 0, String(groupBtn.textContent).trim())
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(280)
    }

    // ── 信息卡墙（2026-10-10，卡 20261010-003）──────────────────────────────
    // 首版直接把 filteredTasks 铺成网格 → **分组整个丢失**，一百多张卡糊成一面没有结构的墙
    // （用户截图反馈「压迫感十足」，且选了「按项目」不生效）。下面是修复后的**浏览器级**行为：
    // 先分区、区内网格、每张卡带 ID、开关默认关且真的过滤。跑完这一段要切回列视图。
    const clickVsb = (txt) => {
      const b = $$('.pagehead button.vsb').find((x) => (x.textContent || '').indexOf(txt) >= 0)
      if (b) b.click()
      return !!b
    }
    check('能切到「信息卡墙」', clickVsb('信息卡墙'))
    await sleep(500)

    const wall = (() => {
      const root = $('.pvwall')
      return {
        ok: !!root,
        groups: $$('.pvwall .pwg').length,
        heads: $$('.pvwall .pwg-head .lpill').length,
        cards: $$('.pvwall .pvcard').length,
        ids: $$('.pvwall .pvcard .pwc-id').filter((x) => (x.textContent || '').trim()).length,
        switcher: !!$('.pagehead .pvw-switch'),
      }
    })()
    check('★ 信息卡墙是「分区 + 区内网格」，不是一个根容器平铺到底',
      wall.ok && wall.groups >= 1 && wall.heads === wall.groups, JSON.stringify(wall))
    check('★ 每张卡都带任务 ID（卡 20261010-003 的核心承诺）',
      wall.cards > 0 && wall.ids === wall.cards, JSON.stringify(wall))
    check('★ 卡片墙专属「只看未完成」开关在页头',
      wall.switcher, JSON.stringify(wall))

    // 开关真的过滤 —— **用「归档」页签验**：活跃区的夹具里没有已完成任务
    // （在那儿测会得到 before=after，那是用例无对象可过滤，不是产品没生效）；
    // 归档区清一色「完成」态，正好同时验「过滤生效」与「全被过滤时的提示语」。
    clickText('归档')
    await sleep(700)
    const archBefore = $$('.pvwall .pvcard').length
    const chk = $('.pagehead .pvw-switch .pvw-switch-chk')
    if (chk) chk.click()
    await sleep(700)
    const archAfter = $$('.pvwall .pvcard').length
    check('★ 「只看未完成」真的会过滤：归档区（全是完成态）勾选后一张不剩',
      archBefore > 0 && archAfter === 0, `before=${archBefore} after=${archAfter}`)
    check('★ 全被过滤掉时给的是提示语，不是一片空白',
      !!$('.pvwall .pvw-allhidden'),
      ($('.pvwall .pvw-allhidden') || {}).textContent || '(没找到提示语)')
    if (chk) chk.click()
    await sleep(700)
    check('  取消勾选后归档区的卡回来了', $$('.pvwall .pvcard').length === archBefore,
      `${$$('.pvwall .pvcard').length} vs ${archBefore}`)

    // ══ 归档 · 按状态快选（2026-10-17 暮雨第 1 条：「我想一键全选已完成的归档任务，然后删掉它们」）══
    // 判据：点一下要**真的全选**（不是只选一张，也不是只开多选模式不选东西）。
    check('★ 归档页有「按状态快选」工具条', !!$('.aq-bar'))
    const aqDone = $$('.aq-bar .aq-btn').find((b) => (b.textContent || '').indexOf('完成') >= 0)
    check('  工具条上带该状态的条数（完成档有数、可点）',
      !!aqDone && !aqDone.disabled, aqDone ? aqDone.textContent : '(没有完成档按钮)')
    if (aqDone) {
      const doneN = parseInt(((aqDone.querySelector('.aq-n') || {}).textContent || '0').trim(), 10)
      aqDone.click()
      await sleep(400)
      const bc = $('.batch-bar .batch-count')
      check('★★ 点一下 = 进入多选 + 选中该状态全部（不是只选一张）',
        !!bc && (bc.textContent || '').indexOf('已选 ' + doneN) >= 0,
        (bc ? bc.textContent : '(没有批量栏)') + ' 期望已选 ' + doneN)

      // ── 2026-10-17 暮雨第 2 条：快选必须**叠加**（首版整桶替换 = 点一组冲一组）──
      const aqRej = $$('.aq-bar .aq-btn').find((b) => (b.textContent || '').indexOf('驳回') >= 0)
      const rejN = aqRej && !aqRej.disabled ? parseInt(((aqRej.querySelector('.aq-n') || {}).textContent || '0').trim(), 10) : 0
      check('  叠加前提：归档区有两种状态（假数据补了「驳回」一条）', rejN > 0, 'rejN=' + rejN)
      if (rejN > 0 && aqRej) {
        aqRej.click()
        await sleep(300)
        const bc2 = $('.batch-bar .batch-count')
        check('★★ 点第二个状态 = 两组叠加（上一组不被冲掉）',
          !!bc2 && (bc2.textContent || '').indexOf('已选 ' + (doneN + rejN)) >= 0,
          (bc2 ? bc2.textContent : '') + ' 期望已选 ' + (doneN + rejN))
        check('  两组的按钮都点亮（一眼看出选了哪几组）',
          aqDone.classList.contains('on') && aqRej.classList.contains('on'),
          'done.on=' + aqDone.classList.contains('on') + ' rej.on=' + aqRej.classList.contains('on'))

        aqDone.click()
        await sleep(300)
        const bc3 = $('.batch-bar .batch-count')
        check('★★ 同一个状态点第二下 = 只取消这一组（其他组原样保留）',
          !!bc3 && (bc3.textContent || '').indexOf('已选 ' + rejN) >= 0,
          (bc3 ? bc3.textContent : '') + ' 期望已选 ' + rejN)
        check('  取消后该组按钮熄灭、另一组仍亮',
          !aqDone.classList.contains('on') && aqRej.classList.contains('on'),
          'done.on=' + aqDone.classList.contains('on') + ' rej.on=' + aqRej.classList.contains('on'))

        // ── 邮箱式「全选」方框：三态（勾 / 部分选中呈横线 / 空）──
        const master = $('.aq-bar .aq-master input')
        check('★ 工具条开头有「全选」方框', !!master)
        check('  部分选中时方框呈横线（indeterminate）且不勾',
          !!master && master.indeterminate === true && master.checked === false,
          'indeterminate=' + (master || {}).indeterminate + ' checked=' + (master || {}).checked)
        if (master) {
          master.click()
          await sleep(300)
          const bc4 = $('.batch-bar .batch-count')
          check('★★ 方框点一下 = 全选当前看到的（已选 = 归档区总数）',
            !!bc4 && (bc4.textContent || '').indexOf('已选 ' + archBefore) >= 0,
            (bc4 ? bc4.textContent : '') + ' 期望已选 ' + archBefore)
          check('  全选后方框呈勾选态（横线消失）',
            master.indeterminate === false && master.checked === true,
            'indeterminate=' + master.indeterminate + ' checked=' + master.checked)
          master.click()
          await sleep(300)
          const bc5 = $('.batch-bar .batch-count')
          check('★★ 方框再点一下 = 全不选（可见批全摘掉）',
            !!bc5 && (bc5.textContent || '').indexOf('已选 0') >= 0,
            (bc5 ? bc5.textContent : '') + ' 期望已选 0')
        }
      }
      const aqCancel = $$('.batch-bar button').find((b) => (b.textContent || '').trim() === '取消')
      if (aqCancel) aqCancel.click()
      await sleep(300)
      check('  取消后退出多选（不残留选中）', !$('.batch-bar'))
    }

    // ⚠ 后面的断言都建立在「看板 + 列视图」上，这里必须切回去
    //    （页签切换**不会**改摆法 —— 摆法是记住的，所以要显式切回列视图）
    clickText('看板')
    await sleep(700)
    clickVsb('列视图')
    await sleep(500)
    check('  切回列视图后卡片墙根容器消失（互斥渲染）', !$('.pvwall'))

    // 默认摆法：列视图
    const colState = {
      cols: $$('#board .col').length,
      cards: $$('#board .col > .card').length,
      list: $$('#board .board-list').length,
    }
    check('  默认渲染的是列视图（有 .col 与卡片，没有 .board-list）',
      colState.cols > 0 && colState.cards > 0 && colState.list === 0, JSON.stringify(colState))

    // ══ 看板右键新建（2026-10-17 暮雨第 3 条：右键列空白 → 「在此列新建任务」）══
    // 判据：① 分区空白处右键真的弹菜单（以前什么都没有，用户测试归档时被卡住）；
    //       ② 点「在此列新建任务」弹的是新建弹窗，且状态预选 = 右键的那一列（不是永远「待办」）；
    //       ③ 指针落在卡片上时不抢卡片的右键菜单（列菜单里不该出现「新建」）。
    {
      const col0 = $$('#board .col').filter((c) => c.querySelector('[data-id]'))[0]
      check('★ 列视图有可右键的分区（有卡的一列）', !!col0,
        col0 ? (col0.getAttribute('data-status') || '') : '(没有列)')
      if (col0) {
        const want = col0.getAttribute('data-status') || ''
        col0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        await sleep(300)
        const menu = $('.ctx-menu.ctx-other')
        const newItem = menu ? $$('.ctx-menu.ctx-other button').find((b) => (b.textContent || '').indexOf('在此列新建任务') >= 0) : null
        check('★★ 列空白处右键 = 弹出分区菜单（带「在此列新建任务」）',
          !!menu && !!newItem,
          menu ? (menu.textContent || '').slice(0, 60) : '(菜单没出现)')
        if (newItem) {
          newItem.click()
          await sleep(400)
          const overlay = $('#modal-overlay')
          const h3 = overlay ? overlay.querySelector('h3') : null
          // ⚠ 状态下拉在弹窗里是**动态生成**的（v-for spec，没有 id/class 标注），
          //   原来按"value 为空或属于状态列表"去找会命中项目/优先级那类空值 select（2026-10-17 实测：
          //   报 select= want=待办，其实找错了元素）。改成按**选项集**认：状态下拉必然含「待验收」。
          const sel = overlay
            ? Array.prototype.slice.call(overlay.querySelectorAll('select')).filter((s) =>
                Array.prototype.slice.call(s.options || []).some((o) => (o.textContent || '').trim() === '待验收'))[0]
            : null
          check('★★ 点「在此列新建任务」= 弹新建弹窗（不是编辑）',
            !!overlay && !!h3 && (h3.textContent || '').indexOf('新建任务') >= 0,
            h3 ? h3.textContent : '(弹窗没出现)')
          check('★★ 状态预选 = 右键的那一列（不是写死的「待办」）',
            !!sel && sel.value === want,
            'select=' + (sel ? sel.value : '(没有状态下拉)') + ' want=' + want)
          // 收尾：点弹窗「取消」关掉（弹窗只有 mousedown.self / 取消两个出口，没有 Esc），
          // 别让草稿弹窗盖住后面的断言
          const cancelBtn = overlay ? $$('#modal-overlay button').find((b) => (b.textContent || '').trim() === '取消') : null
          if (cancelBtn) { cancelBtn.click(); await sleep(300) }
        }
        // ③ 卡片上右键不弹分区菜单（卡片有自己的菜单；分区菜单只是空白处的加速器）
        const card0 = col0.querySelector('[data-id]')
        if (card0) {
          const menuBefore = !!$('.ctx-menu.ctx-other')
          card0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
          await sleep(300)
          const menu2 = $('.ctx-menu.ctx-other')
          const hasNew = menu2 ? $$('.ctx-menu.ctx-other button').some((b) => (b.textContent || '').indexOf('在此列新建任务') >= 0) : false
          check('  卡片上右键不弹分区菜单（不抢卡片自己的菜单）',
            (!menu2 || menuBefore) && !hasNew,
            'menu=' + !!menu2 + ' hasNew=' + hasNew)
          // 清理：这一步会真的打开**卡片的 reka 菜单**，不收掉的话后面 CTX 段
          // 再派发 contextmenu 会撞上"菜单已开"的状态 → 一路 no menu（2026-10-17 实测红 17 条）。
          // reka 只认 Esc / pointerdown outside，`.ctx-backdrop` 是手搓那个菜单的遮罩，关不掉它。
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await sleep(200)
          document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          await sleep(300)
        }
      }
    }

    // ══ 看板 · 批量改期（2026-10-18 Bundle A「超期任务批量改期」）══════════
    // 典型路径：顶栏日期筛选「超期」→ 批量模式 → 全选 → 📅 改期 → 一次推走。
    // 这里用真点击验 UI 交互链：按钮在 → 面板展开且预填今天+7 → 快捷 +30 天 →
    // 确定改期 → mock 真改 store（batchEdit 已记录调用）→ toast 说清数量 → 退多选。
    // 数据层逐字落盘由 e2e-task-fields 的 batchEdit 用例钉死（无头里 IPC 是 mock）。
    // ⚠ 本段会真改 demo-001 的 deadline —— 后面日历断言的期望值走 fixTodayCount()
    //   （与渲染同源读 store，改完两边一起变），所以不踩；别在**本段之前**插日期断言。
    {
      const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const plus7 = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 7))
      const plus30 = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 30))

      const boardBatchBtn = $$('#views .batch-mode-btn').find((b) => (b.textContent || '').indexOf('任务多选') >= 0)
      check('★ 看板页头有「任务多选」入口', !!boardBatchBtn, boardBatchBtn ? '' : '(没找到 .batch-mode-btn)')
      if (boardBatchBtn) {
        boardBatchBtn.click()
        await sleep(400)
        const bar = $('.batch-bar')
        const postponeBtn = bar ? $$('.batch-bar button').find((b) => (b.textContent || '').indexOf('改期') >= 0) : null
        check('★★ 多选模式批量栏里有「📅 改期」', !!bar && !!postponeBtn,
          bar ? '(批量栏在但没有改期按钮)' : '(批量栏没出现)')

        if (postponeBtn) {
          postponeBtn.click()
          await sleep(300)
          const panel = $('.batch-bar .bp-panel')
          const dateInp = panel ? panel.querySelector('input[type="date"]') : null
          check('★★ 点「改期」= 面板展开且日期预填「今天+7」',
            !!panel && !!dateInp && dateInp.value === plus7,
            'value=' + (dateInp ? dateInp.value : '(没有日期框)') + ' want=' + plus7)

          const aCard = $$('#board .col > .card[data-id]')[0]
          check('  改期前置：列视图里有可勾选的卡', !!aCard)
          if (aCard) {
            aCard.click()
            await sleep(250)
            const cnt = $('.batch-bar .batch-count')
            check('  多选模式下点卡 = 勾进选择（已选 1）',
              !!cnt && (cnt.textContent || '').indexOf('已选 1') >= 0,
              cnt ? cnt.textContent : '(批量栏没了)')

            const confirmBtn = $$('.bp-panel button').find((b) => (b.textContent || '').trim() === '确定改期')
            check('  「确定改期」按钮在', !!confirmBtn)
            if (confirmBtn) {
              confirmBtn.click()
              await sleep(700)
              check('★★ 确定改期 = batchEdit 按日期框值（今天+7）真的调了',
                window.__fcTest.calls().some((c) => c.name === 'batchEdit' && c.args && c.args[1] && c.args[1].deadline === plus7),
                JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'batchEdit').map((c) => c.args)))
              check('★★ 改完自动退多选（批量栏收起，不残留）', !$('.batch-bar'))
              const toastTxt = (($('#toast') || {}).textContent || '')
              check('  toast 说清数量与目标日（不静默）',
                toastTxt.indexOf('1 个任务的截止日') >= 0 && toastTxt.indexOf(plus7) >= 0,
                toastTxt)
            }
          }
        }

        // 第二轮：快捷「+30 天」= 不经日期框直接执行（最高频：整体推一个月）
        // 第一轮改完已自动退多选，这里重开一轮：多选 → 勾卡 → 改期面板 → +30 天
        const boardBatchBtn2 = $$('#views .batch-mode-btn').find((b) => (b.textContent || '').indexOf('任务多选') >= 0)
        if (boardBatchBtn2) {
          boardBatchBtn2.click()
          await sleep(400)
          const card2 = $$('#board .col > .card[data-id]')[0]
          if (card2) {
            card2.click()
            await sleep(250)
            const pBtn2 = $$('.batch-bar button').find((b) => (b.textContent || '').indexOf('改期') >= 0)
            if (pBtn2) {
              pBtn2.click()
              await sleep(300)
              const quick = $$('.bp-panel button').find((b) => (b.textContent || '').trim() === '+30 天')
              check('  快捷「+30 天」在面板上', !!quick)
              if (quick) {
                quick.click()
                await sleep(700)
                check('★★ 点「+30 天」= 直接改期到今天+30（不经确定，最高频路径）',
                  window.__fcTest.calls().some((c) => c.name === 'batchEdit' && c.args && c.args[1] && c.args[1].deadline === plus30),
                  JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'batchEdit').map((c) => c.args)))
                check('  快捷改完同样退多选', !$('.batch-bar'))
              }
            }
          }
        }

        // 收尾：面板/多选若因前面失败分支还开着，一律收掉，别污染后面的断言
        if ($('.bp-panel')) {
          const collapse = $$('.bp-panel button').find((b) => (b.textContent || '').trim() === '收起')
          if (collapse) collapse.click()
          await sleep(200)
        }
        if ($('.batch-bar')) {
          const cancel = $$('.batch-bar button').find((b) => (b.textContent || '').trim() === '取消')
          if (cancel) cancel.click()
          await sleep(300)
        }
        check('  收尾：多选已退出', !$('.batch-bar'))
      }
    }

    // ══ 看板 · 分区头整组勾选（2026-10-25 暮雨第 11 条）══════════════════
    // 原话：「一堆空草稿想全部归档，发现不能一键选所有草稿，只能一个个点」。
    // 判据：点某分区的组选框 = 只选中该组；其他组不受影响；再点一次 = 只取消该组。
    {
      const batchBtn = $$('#views .batch-mode-btn').find((b) => (b.textContent || '').indexOf('任务多选') >= 0)
      if (batchBtn) {
        batchBtn.click()
        await sleep(400)

        const cols = $$('#board .col')
        const nonEmpty = cols.filter((c) => c.querySelectorAll('.card[data-id]').length > 0)
        const withBox = nonEmpty.filter((c) => c.querySelector('h3 .grp-chk input'))
        check('★★ 多选模式下「每个有卡的分区头」都出现组选框',
          nonEmpty.length > 0 && withBox.length === nonEmpty.length,
          '有框 ' + withBox.length + ' / 有卡分区 ' + nonEmpty.length)

        const idx = cols.findIndex((c) => c.querySelector('h3 .grp-chk input') && c.querySelectorAll('.card[data-id]').length > 1)
        check('  找一个卡数 >1 的分区做实验', idx >= 0, 'idx=' + idx)
        if (idx >= 0) {
          const col = cols[idx]
          const ids = Array.prototype.slice.call(col.querySelectorAll('.card[data-id]')).map((c) => c.getAttribute('data-id'))
          const box = col.querySelector('h3 .grp-chk input')
          const otherCol = cols.find((c, i) => i !== idx && c.querySelectorAll('.card[data-id]').length > 0)
          const otherIds = otherCol ? Array.prototype.slice.call(otherCol.querySelectorAll('.card[data-id]')).map((c) => c.getAttribute('data-id')) : []

          box.click()
          await sleep(400)
          const cnt1 = $('.batch-bar .batch-count')
          check('★★ 点组选框 = 这一组整组进选择（已选 ' + ids.length + '）',
            !!cnt1 && (cnt1.textContent || '').indexOf('已选 ' + ids.length) >= 0,
            cnt1 ? cnt1.textContent : '(批量栏没了)')
          const selectedNow = $$('#board .card.selected').map((c) => c.getAttribute('data-id'))
          check('★★ 选中集合 = 该组全部，且**不含**其他分区的卡',
            ids.every((id) => selectedNow.indexOf(id) >= 0) && !otherIds.some((id) => selectedNow.indexOf(id) >= 0),
            'selected=' + JSON.stringify(selectedNow))

          box.click()
          await sleep(350)
          const cnt2 = $('.batch-bar .batch-count')
          check('★★ 再点一次 = 只取消这一组（已选 0，其他组的选择保留）',
            !!cnt2 && (cnt2.textContent || '').indexOf('已选 0') >= 0,
            cnt2 ? cnt2.textContent : '(批量栏没了)')
        }

        const cancel2 = $$('.batch-bar button').find((b) => (b.textContent || '').trim() === '取消')
        if (cancel2) cancel2.click()
        await sleep(300)
        check('  收尾：退出多选后组选框也消失（它只属于多选模式）',
          !$('.batch-bar') && !$('#board .col h3 .grp-chk'))
      }
    }

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
    maskClick('#roverlay')
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

    // ══ 待办的「📅 指派到期日」→ 真打开指派弹窗（2026-10-23 补）══════════════════
    // 这条断言是被真事逼出来的：抽 calendar composable 时把 `parseCalDate` 的 import
    // 一起删了，而**只有这条路径**（openCalAssignTodo）还在用它。
    // 结果：无头断言 686/0 全绿、真 Electron 真点击红 2 条（ReferenceError）。
    // 补上这条之后，无头这层也能咬住"某个只在特定点击路径才用到的符号被删"。
    const assignDiag = await (async () => {
      // 列表是异步拉的 → 等按钮出现，别用"此刻没看到"当结论
      // ⚠ waitFor 返回的是**布尔**，不是元素 —— 直接 `btn.click()` 会炸
      //   「btn.click is not a function」（2026-10-23 踩过）。等到了再取一次。
      const appeared = await waitFor(() => !!$('main.todos-view .todo-assign'), 4000, 'todo-assign')
      if (!appeared) return { err: '没有 .todo-assign' }
      const btn = $('main.todos-view .todo-assign')
      btn.click()
      await sleep(400)
      const d = {
        overlays: document.querySelectorAll('.overlay').length,
        modal: !!document.querySelector('#cal-assign-modal'),
        btnVisible: btn.offsetParent !== null,
        hasHandler: typeof btn.onclick === 'function' || !!btn.__vueParentComponent,
        btns: document.querySelectorAll('main.todos-view .todo-assign').length,
      }
      if (d.modal) {
        // 关掉，别把弹窗留给后面的断言（遮罩用 @mousedown.self → 派发 mousedown 到遮罩本体）
        const ov = document.querySelector('.overlay')
        if (ov) ov.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        await sleep(250)
      }
      return d
    })()
    check('★★ 待办上的 📅 能真打开「指派时间」弹窗（parseCalDate 只在这条路径上用）',
      assignDiag && assignDiag.modal === true, JSON.stringify(assignDiag))
    check('  关掉之后弹窗真的没了（不然下一个断言会在遮罩上面点空）',
      !$('#cal-assign-modal'))


    // ══ 待办的**可选到期时间**（2026-10-12 暮雨：「待办只有到期日，建议再加一个可选的时间字段。
    //    如 WorkBuddy 额度 21:33:59 重置，让用户选个 21:39」）══════════════════════════
    // 四件事必须同时成立，缺一条这个功能就是"看着有、用不了"：
    //   ① 编辑弹窗里真有时间输入框；② 保存时 dueTime **真的传下去**（不是只改界面）；
    //   ③ 列表上**看得见**时分；④ 能清空（填错了要能去掉 —— 清空 = 字段消失，不是存空串）。
    {
      const nb2 = $$('main.todos-view .todos-ctrls button').find((b) => b.textContent.indexOf('新建待办') >= 0)
      if (nb2) nb2.click()
      const opened = await waitFor(() => !!$('#todo-edit-modal'), 4000, '时间字段用的新建弹窗')
      check('★ 待办弹窗里有「时间（可选）」输入框（2026-10-12 新增）',
        opened && !!$('#todo-edit-modal input[type="time"]'),
        'modal=' + opened + ' timeInput=' + !!$('#todo-edit-modal input[type="time"]'))
      if (opened) {
        const ta = $('#todo-edit-modal textarea')
        const dInp = $('#todo-edit-modal input[type="date"]')
        const tInp = $('#todo-edit-modal input[type="time"]')
        const setVal = (el, v) => {
          el.value = v
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
        if (ta) setVal(ta, '断言用：额度重置后抢跑（带时间）')
        if (dInp) setVal(dInp, '2026-10-12')
        if (tInp) setVal(tInp, '21:39')
        const beforeC = window.__fcTest.callCount('todosCreate')
        const sb = $$('#todo-edit-modal button').find((b) => (b.textContent || '').trim() === '保存')
        if (sb) sb.click()
        await waitFor(() => window.__fcTest.callCount('todosCreate') > beforeC, 4000, '带时间的 todosCreate')
        const call = window.__fcTest.calls().filter((c) => c.name === 'todosCreate').pop()
        const args = (call && call.args) || []
        check('★★ 保存时 dueTime **真的传下去**了（第 6 个参数 = 21:39，不是只改了界面）',
          args[5] === '21:39' && args[2] === '2026-10-12',
          'date=' + JSON.stringify(args[2]) + ' dueTime=' + JSON.stringify(args[5]))
        await waitFor(() => !$('#todo-edit-modal'), 4000, '带时间弹窗关闭')
        check('★★ 列表上**看得见时分**（到期那格显示 21:39，而不是只显示日期）',
          await waitFor(() => $$('main.todos-view .todo-item').some((it) => {
            const d = it.querySelector('.todo-due')
            return d && (d.textContent || '').indexOf('21:39') >= 0
          }), 5000, '列表显示 21:39'))
        // 清空：再打开同一条，清掉时间 → 保存 → 字段应消失（不是存成空串）
        const item = $$('main.todos-view .todo-item').find((it) => (it.textContent || '').indexOf('额度重置后抢跑') >= 0)
        const eb = item && item.querySelector('.todo-edit')
        if (eb) {
          eb.click()
          const reopened = await waitFor(() => !!$('#todo-edit-modal input[type="time"]'), 4000, '重开编辑')
          if (reopened) {
            check('  重开编辑时时间**回填**成 21:39（不是空白 —— 否则用户以为没设过）',
              $('#todo-edit-modal input[type="time"]').value === '21:39',
              'value=' + JSON.stringify($('#todo-edit-modal input[type="time"]').value))
            const clr = $('.te-time-clear')
            if (clr) clr.click()
            await sleep(120)
            const beforeU = window.__fcTest.callCount('todosUpdate')
            const sb2 = $$('#todo-edit-modal button').find((b) => (b.textContent || '').trim() === '保存')
            if (sb2) sb2.click()
            await waitFor(() => window.__fcTest.callCount('todosUpdate') > beforeU, 4000, '清空时间的 todosUpdate')
            const uCall = window.__fcTest.calls().filter((c) => c.name === 'todosUpdate').pop()
            const patch = (uCall && uCall.args && uCall.args[1]) || {}
            check('★★ 清空时间：保存时 dueTime 传**空串**（清空 ≠ 存空串 —— 服务端据此把字段整个删掉）',
              'dueTime' in patch && patch.dueTime === '',
              'patch.dueTime=' + JSON.stringify(patch.dueTime))
            await waitFor(() => !$('#todo-edit-modal'), 4000, '清空后弹窗关闭')
            check('  清空后列表那格**不再显示时分**（回到只按天）',
              await waitFor(() => $$('main.todos-view .todo-item')
                .filter((it) => (it.textContent || '').indexOf('额度重置后抢跑') >= 0)
                .every((it) => {
                  const d = it.querySelector('.todo-due')
                  return !d || (d.textContent || '').indexOf('21:39') < 0
                }), 4000, '清空后无时分'))
          } else {
            check('  重开编辑（时间回填断言的就位前提）', false, '重开失败')
          }
        }
      }
    }

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
    // ⚠ 判据在 2026-10-11 改过一次，原因值得记：原判据是「标题**已用**宽度 > 卡片宽 50%」，
    //   但那是个**视口相关的近似** —— `.todo-title` 不换行、宽度随文字走（不是 flex:1），
    //   于是宽窗口下长标题也才占 46% → 同一条断言在窗口宽 756 时绿、宽 1440 时红。
    //   真正要守的是「标题这一行**不被按钮挤**」= 它的**可用宽度**（动作区左边缘 − 标题左边缘）
    //   占卡片的大头，且标题确实没压进动作区。这个判据与视口宽度无关。
    const availW = row2.acts ? row2.acts.x - row2.ttl.x : 0
    check('  标题占满整行（不再和一堆按钮抢宽度 —— 这正是"两行卡"的动因）',
      !row2.err && availW > row2.card.w * 0.7 && row2.ttl.w <= availW + 1,
      JSON.stringify({ ttl: row2.ttl, acts: row2.acts, card: row2.card, availW: Math.round(availW) }))
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

    // ── 族2（2026-10-11 用户第 3 条）：文本框里按住拖选、光标滑出弹窗再松手 → 不许关 ──
    // 真因：`click` 的目标是「按下点与松开点的最近公共祖先」＝遮罩，于是 `@click.self`
    // 判定为"点了遮罩"→ 弹窗整个关掉、草稿全丢（用户累计触发十几次）。
    // 修法：遮罩关闭手势换成 `@mousedown.self`（只在**按下那一刻**光标就在遮罩上才触发）。
    ;(() => { const t = $('main.todos-view .todos-list.as-grid .todo-title'); if (t) t.click() })()
    await waitFor(() => !!$('#todo-edit-modal'), 5000, '待办编辑弹窗（拖选回归）')
    const dragOv = $('#todo-edit-overlay')
    const dragTa = $('#todo-edit-modal textarea')
    if (dragOv && dragTa) {
      const me = { bubbles: true, cancelable: true, view: window }
      dragTa.dispatchEvent(new MouseEvent('mousedown', me))   // 按下：光标在文本框里
      dragOv.dispatchEvent(new MouseEvent('mouseup', me))     // 松开：已经拖出弹窗、落在遮罩上
      dragOv.dispatchEvent(new MouseEvent('click', me))       // 浏览器这时还会补一个 click（目标是遮罩）
    }
    await sleep(250)
    check('★★ 族2：文本框里按住拖选、光标滑出弹窗再松手 → 弹窗**不许**被关掉（老代码这里直接全丢）',
      !!$('#todo-edit-modal'), 'modal=' + !!$('#todo-edit-modal'))
    // 反向验证关闭手势还在：按下就在遮罩上 → 该关还是得关（别把 bug 修成"关不掉了"）
    maskClick('#todo-edit-overlay')
    await sleep(250)
    check('★ 族2：真正点遮罩（按下就在遮罩上）仍然关得掉 —— 修复没把关闭手势一起弄没',
      !$('#todo-edit-modal'), 'modal=' + !!$('#todo-edit-modal'))

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

    // ══ 待办的筛选 / 排序 / 统计（2026-10-23 补：把「只看未完成」整段注释掉都全绿，
    //    说明这三条路径此前**零断言**。勾选/撤销/多选/编辑都有，唯独它们没有。）══
    {
      const ago = (n) => new Date(Date.now() - n * 86400000).toISOString()
      const dstr = (n) => ago(n).slice(0, 10)
      // ⚠ 必须备份并还原：这一段后面还有「网格/编辑弹窗/勾选写回」一整套待办断言，
      //   它们依赖前文建出来的待办。我第一版收尾写 `setTodos([])`，直接把它们全打红（706/16）。
      const todosBackup = JSON.parse(JSON.stringify(window.__fcTest.todos()))
      window.__fcTest.setTodos([
        { id: 'tf-1', title: '夹具·逾期的高', done: false, priority: '高', due: dstr(2), createdAt: ago(3), updatedAt: ago(3) },
        { id: 'tf-2', title: '夹具·明天到期的高', done: false, priority: '高', due: dstr(-1), createdAt: ago(2), updatedAt: ago(2) },
        { id: 'tf-3', title: '夹具·已完成的低', done: true, priority: '低', createdAt: ago(1), updatedAt: ago(1) },
      ])
      clickText('看板'); await sleep(300); clickText('待办'); await sleep(600)
      const stats = () => (($('main.todos-view .todos-stats') || {}).textContent || '').replace(/\s+/g, ' ')
      check('★★ 统计口径与数据一致（共 3 · 未完成 2 · 已完成 1）',
        /共 3 条/.test(stats()) && /未完成 2/.test(stats()) && /已完成 1/.test(stats()), stats())
      check('★★ 逾期单独算（只有那条 due 在前天且未完成 → 逾期 1）',
        /逾期 1/.test(stats()), stats())
      const selOf = (val) => $$('main.todos-view select.todo-filter')
        .find((x) => Array.prototype.slice.call(x.options).some((o) => o.value === val))
      const pick = async (val, idx) => {
        const el = selOf(val)
        if (!el) return false
        el.value = val
        el.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(350)
        return true
      }
      const titles = () => $$('main.todos-view .todo-item').map((x) => (x.textContent || '').trim())
      check('前置：三张卡都在（否则下面几条会在空列表上假绿）',
        titles().length === 3, 'n=' + titles().length)
      await pick('active')
      check('★★ 筛选「未完成」→ 只剩 2 张（已完成那张被筛掉）',
        await waitFor(() => titles().length === 2, 3000, '未完成 2'),
        JSON.stringify(titles()))
      check('★ 遮住的条数明说（当前筛选遮住 1 条）+ 给「清除筛选」',
        /遮住 1 条/.test(stats()) && !!$('main.todos-view .todos-clear'), stats())
      await pick('done')
      check('★★ 筛选「已完成」→ 只剩 1 张', await waitFor(() => titles().length === 1, 3000, '已完成 1'),
        JSON.stringify(titles()))
      await pick('all')
      check('  切回「全部」→ 3 张都回来', await waitFor(() => titles().length === 3, 3000, '全部 3'),
        JSON.stringify(titles()))
      // 排序：优先级从高到低（前两张都是「高」，第三张是「低」）
      await pick('priority')
      await sleep(250)
      const t3 = $$('main.todos-view .todo-item')
      check('★★ 排序「优先级从高到低」：最后一张一定是「低」那条（排序真生效，不是摆设）',
        t3.length === 3 && (t3[2].textContent || '').indexOf('已完成的低') >= 0,
        JSON.stringify(t3.map((x) => (x.textContent || '').slice(0, 14))))
      await pick('default')
      // 收尾：还原成进来时的样子，再回看板（后面那批待办断言接着用）
      window.__fcTest.setTodos(todosBackup)
      clickText('看板'); await sleep(300)
    }

    // ══ 想法（2026-10-22 · 暮雨：「随手记一个念头，之后决定做/不做/搁置，
    //    现有待办、日志、任务都放不下」）══════════════════════════════════
    // 这条功能的价值不在"能记"，而在**边界**：它不许影响待办/任务/逾期/阻塞。
    // 所以断言分两半 —— 前半：能记、能决定；后半：点「做」之后**待办里真多了一条**
    // （只改状态不算，那正是主进程刻意拦掉的那条假账路）。
    check('★ 页签行里有「想法」（念头有地方去）',
      $$('#views .vbtn').some((b) => (b.textContent || '').trim() === '想法'),
      JSON.stringify($$('#views .vbtn').map((b) => (b.textContent || '').trim())))
    clickText('想法')
    await sleep(400)

    check('★★ 页面是**纵向单栏**（几何门禁：标题 / 输入区 / 待定区左边缘齐、上下依次排）', (() => {
      // 与问答页同一个坑：`#board` 是 flex 横排，不显式 display:block 会排成三列挤在左边
      const h = $('#board.ideas-view .ideas-head')
      const b = $('#board.ideas-view .ideas-box')
      const sec = $('#board.ideas-view .ideas-sec')
      if (!h || !b || !sec) return false
      const rh = h.getBoundingClientRect(), rb = b.getBoundingClientRect(), rs = sec.getBoundingClientRect()
      return Math.abs(rh.left - rb.left) < 1 && Math.abs(rb.left - rs.left) < 1
        && rb.top > rh.top && rs.top > rb.top
    })(), '取的 .ideas-head / .ideas-box / .ideas-sec 三块')
    check('★★ 三块**宽度也相同**且都够宽（被拆成并排几列时宽度会各不相同；上一条只验了左边缘）', (() => {
      const els = ['#board.ideas-view .ideas-head', '#board.ideas-view .ideas-box', '#board.ideas-view .ideas-sec']
        .map((sel) => $(sel))
      if (els.some((e) => !e)) return false
      const ws = els.map((e) => e.getBoundingClientRect().width)
      // ws[0] > 200：防"三块都宽 0"（那样也相等，是假绿）
      return ws[0] > 200 && ws.every((w) => Math.abs(w - ws[0]) < 1)
    })(), (() => {
      const ws = ['#board.ideas-view .ideas-head', '#board.ideas-view .ideas-box', '#board.ideas-view .ideas-sec']
        .map((sel) => Math.round(((($(sel) || {}).getBoundingClientRect) ? $(sel).getBoundingClientRect().width : -1)))
      return JSON.stringify(ws)
    })())
    check('★ 主角是那个输入框（随手记，不是填表）',
      !!$('#board.ideas-view textarea.ideas-in'))
    check('★★ 空输入时「记下来」是禁用的（不许存空念头）', (() => {
      const b = $('#board.ideas-view .ideas-save')
      return !!b && b.disabled === true
    })())
    check('★ 待定区/已决区分开：还没决定 1 条、已经有结论 2 条', (() => {
      const heads = $$('#board.ideas-view .ideas-sec-h').map((x) => (x.textContent || '').replace(/\s+/g, ' '))
      return heads.length === 2 && /还没决定 1/.test(heads[0]) && /已经有结论 2/.test(heads[1])
    })(), JSON.stringify($$('#board.ideas-view .ideas-sec-h').map((x) => (x.textContent || '').replace(/\s+/g, ' '))))
    check('★★ 「已经有结论」默认收起（这一页的主角是还没决定的那堆，不是历史账）',
      $$('#board.ideas-view .idea-decided').length === 0)
    check('★ 念头上没有优先级、没有截止日（加了就又变待办了）', (() => {
      const t = ($('#board.ideas-view .ideas-sec .idea') || {}).textContent || ''
      return t.indexOf('优先级') < 0 && t.indexOf('截止') < 0 && t.indexOf('到期') < 0
    })(), (($('#board.ideas-view .ideas-sec .idea') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 60))

    // ── 记一条：真调通道 + 参数是原文 + 存下才清空输入 ──
    const ideaRes = await (async () => {
      const ta = $('#board.ideas-view textarea.ideas-in')
      if (!ta) return { err: '没有输入框' }
      ta.value = '  给想法页加个快捷键  '
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(90)
      const n0 = window.__fcTest.callCount('ideasAdd')
      const btn = $('#board.ideas-view .ideas-save')
      const wasDisabled = btn.disabled
      btn.click()
      const hit = await waitFor(() => window.__fcTest.callCount('ideasAdd') > n0, 4000, 'ideasAdd')
      return { hit, wasDisabled, args: (window.__fcTest.calls().filter((c) => c.name === 'ideasAdd').pop() || {}).args }
    })()
    check('★ 有内容时「记下来」才可点', ideaRes.wasDisabled === false, JSON.stringify(ideaRes))
    check('★★ 真调 ideasAdd，且传的是**去掉首尾空白的原文**（界面不替用户改写念头）',
      ideaRes.hit && ideaRes.args && ideaRes.args[0] === '给想法页加个快捷键', JSON.stringify(ideaRes.args))
    check('★★ 存下之后输入框清空（没清空 = 用户会以为没存上，或者连点存两条）',
      await waitFor(() => $('#board.ideas-view textarea.ideas-in').value === '', 3000, '清空输入'),
      JSON.stringify($('#board.ideas-view textarea.ideas-in').value))
    check('  待定区跟着变 2 条（不是要刷新页面才看得到）',
      await waitFor(() => $$('#board.ideas-view .ideas-sec .idea').length === 2, 4000, '待定 2 条'),
      String($$('#board.ideas-view .ideas-sec .idea').length))

    // ── 「做」= 立项 = 待办里**真多一条**（这一条是整块功能的核心）──
    const doRes = await (async () => {
      const todosBefore = window.__fcTest.todos().length
      // 精确取"刚记的那条"的 id —— 断言要按 id 对，不能只判"传了个字符串"
      // （`typeof args[0] === 'string'` 那种写法等于没验，任何 id 都能过）
      const target = window.__fcTest.ideas().find((i) => i.text === '给想法页加个快捷键')
      const row = $$('#board.ideas-view .ideas-sec .idea').find((x) => (x.textContent || '').indexOf('给想法页加个快捷键') >= 0)
      if (!row || !target) return { err: '没找到刚记的那条' }
      const btn = Array.from(row.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '做')
      if (!btn) return { err: '这条上没有「做」' }
      const n0 = window.__fcTest.callCount('ideasPromote')
      btn.click()
      const hit = await waitFor(() => window.__fcTest.callCount('ideasPromote') > n0, 4000, 'ideasPromote')
      await sleep(300)
      return {
        hit,
        args: (window.__fcTest.calls().filter((c) => c.name === 'ideasPromote').pop() || {}).args,
        todosBefore,
        targetId: target.id,
        todosAfter: window.__fcTest.todos().length,
        added: window.__fcTest.todos().map((t) => String(t.title || '')).filter((t) => t.indexOf('给想法页加个快捷键') >= 0),
        toast: ($('#toast') || {}).textContent || '',
      }
    })()
    check('★ 点「做」→ 真调 ideasPromote，且 id 是**这一条**（不是"随便一个字符串"）',
      !doRes.err && doRes.hit && doRes.args && doRes.args[0] === doRes.targetId,
      doRes.err || JSON.stringify({ got: doRes.args && doRes.args[0], want: doRes.targetId }))
    check('★★★ 立项之后**待办里真多了一条**（只把状态改成「已立项」＝假账，主进程刻意拦了那条路）',
      !doRes.err && doRes.todosAfter === doRes.todosBefore + 1,
      doRes.err || `${doRes.todosBefore} → ${doRes.todosAfter}`)
    check('★★ 新那条待办的标题就是念头的第一行（用户一眼能对上）',
      !doRes.err && doRes.added.length === 1, JSON.stringify(doRes.added))
    check('★★ toast 说清"去了哪"（只看到条目挪进已决区，用户会怀疑到底建没建）',
      doRes.toast.indexOf('待办里多了一条') >= 0, doRes.toast.slice(0, 60))
    check('★ 立项后挂撤销条（一步退得回）', await waitFor(() => {
      const ub = $('#undo-bar')
      return !!ub && (ub.textContent || '').indexOf('已立项') >= 0
    }, 4000, '立项撤销条'), (($('#undo-bar') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 50))

    // 撤销立项：待办那条一起撤（否则就是留了个孤儿待办）
    check('★★ 点撤销 → 真调 ideasUnpromote，且待办数回到立项前', await (async () => {
      const btn = Array.from($$('#undo-bar button')).find((b) => (b.textContent || '').indexOf('撤销') >= 0)
      if (!btn) return false
      const n0 = window.__fcTest.callCount('ideasUnpromote')
      btn.click()
      const hit = await waitFor(() => window.__fcTest.callCount('ideasUnpromote') > n0, 4000, 'ideasUnpromote')
      if (!hit) return false
      await sleep(250)
      return window.__fcTest.todos().length === doRes.todosBefore
    })(), String(window.__fcTest.todos().length))

    // ── 「搁置」：改状态 + 挂撤销 ──
    const holdRes = await (async () => {
      const row = $$('#board.ideas-view .ideas-sec .idea').find((x) => (x.textContent || '').indexOf('给启动台加个搜索框') >= 0)
      if (!row) return { err: '没找到新记的那条夹具' }
      const btn = Array.from(row.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '搁置')
      if (!btn) return { err: '这条上没有「搁置」' }
      const n0 = window.__fcTest.callCount('ideasSetStatus')
      btn.click()
      const hit = await waitFor(() => window.__fcTest.callCount('ideasSetStatus') > n0, 4000, 'ideasSetStatus')
      await sleep(250)
      return { hit, args: (window.__fcTest.calls().filter((c) => c.name === 'ideasSetStatus').pop() || {}).args }
    })()
    check('★★ 点「搁置」→ 真调 ideasSetStatus(项目, 「已搁置」)，不是只改本地状态',
      !holdRes.err && holdRes.hit && holdRes.args && holdRes.args[0] === 'idea-a' && holdRes.args[1] === '已搁置',
      JSON.stringify(holdRes))
    check('★ 搁置也挂撤销条（三个决定都能退）', await waitFor(() => {
      const ub = $('#undo-bar')
      return !!ub && (ub.textContent || '').indexOf('搁置') >= 0
    }, 4000, '搁置撤销条'))

    // ── 已决区：展开才有，徽章与「撤销立项」都在 ──
    check('★ 展开「已经有结论」→ 三种结论都看得见（徽章）', await (async () => {
      const tog = $('#board.ideas-view .ideas-toggle')
      if (!tog) return false
      tog.click()
      const ok = await waitFor(() => $$('#board.ideas-view .idea-decided').length >= 2, 4000, '已决展开')
      if (!ok) return false
      const badges = $$('#board.ideas-view .idea-badge').map((b) => (b.textContent || '').trim())
      return badges.indexOf('已搁置') >= 0 && badges.indexOf('已立项') >= 0
    })(), JSON.stringify($$('#board.ideas-view .idea-badge').map((b) => (b.textContent || '').trim())))
    check('★ 已立项那条给的是「撤销立项」（不是"捡回来"——它已经有待办了）', await (async () => {
      const row = $$('#board.ideas-view .idea-decided').find((x) => (x.textContent || '').indexOf('做个一键导出周报') >= 0)
      if (!row) return false
      const texts = Array.from(row.querySelectorAll('button')).map((b) => (b.textContent || '').trim())
      return texts.indexOf('撤销立项') >= 0 && texts.indexOf('捡回来') < 0
    })())
    check('★ 已搁置那条给的是「捡回来」', await (async () => {
      const row = $$('#board.ideas-view .idea-decided').find((x) => (x.textContent || '').indexOf('端口面板要不要合并') >= 0)
      if (!row) return false
      return Array.from(row.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '捡回来')
    })())

    // ── 删 + 撤销删除：原 id、原 createdAt 回来（当没删过）──
    const delRes = await (async () => {
      const rows = $$('#board.ideas-view .idea')
      const row = rows.find((x) => (x.textContent || '').indexOf('给想法页加个快捷键') >= 0)
      if (!row) return { err: '没找到要删的那条' }
      const btn = Array.from(row.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '×')
      if (!btn) return { err: '这条上没有 ×' }
      const before = window.__fcTest.ideas().filter((i) => i.text === '给想法页加个快捷键')[0]
      const n0 = window.__fcTest.callCount('ideasDelete')
      btn.click()
      const hit = await waitFor(() => window.__fcTest.callCount('ideasDelete') > n0, 4000, 'ideasDelete')
      await sleep(200)
      return { hit, before, left: window.__fcTest.ideas().filter((i) => i.text === '给想法页加个快捷键').length }
    })()
    check('★ 点 × → 真删掉（不是只从界面上藏起来）',
      !delRes.err && delRes.hit && delRes.left === 0, JSON.stringify(delRes))
    check('★★ 撤销删除 → ideasRestore 收到的是**原样那条**（原 id 原 createdAt，当没删过）', await (async () => {
      const btn = Array.from($$('#undo-bar button')).find((b) => (b.textContent || '').indexOf('撤销') >= 0)
      if (!btn) return false
      const n0 = window.__fcTest.callCount('ideasRestore')
      btn.click()
      const hit = await waitFor(() => window.__fcTest.callCount('ideasRestore') > n0, 4000, 'ideasRestore')
      if (!hit) return false
      const a = (window.__fcTest.calls().filter((c) => c.name === 'ideasRestore').pop() || {}).args[0] || {}
      return a.id === delRes.before.id && a.createdAt === delRes.before.createdAt
    })(), JSON.stringify((window.__fcTest.calls().filter((c) => c.name === 'ideasRestore').pop() || {}).args))

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

    // 2026-10-17 暮雨第 8 条：「部分看板任务不能验收裁决……我手动拖到待验收一栏才能点」。
    // 真因是菜单项的 v-if 绑成了 status==='待验收'。夹具这张卡是「待办」—— 正好验"不必先拖"。
    check('★★ 非「待验收」的卡也有「验收裁决」（不该逼人先拖一列）',
      (($('.ctx-menu') || {}).textContent || '').indexOf('验收裁决') >= 0,
      String(($('.ctx-menu') || {}).textContent || '').slice(0, 120))

    // ══ 右键菜单换成 reka-ui ContextMenu（2026-10-14 第 ④ 步第二单）══
    // 钉的是"**真的换了原语**"，而不是把 class 改个名字继续手搓。
    {
      const m = $('.ctx-menu')
      check('★ 菜单是 role=menu（reka-ui ContextMenu 渲染的，不是手搓 div）',
        !!m && m.getAttribute('role') === 'menu', m ? String(m.getAttribute('role')) : 'no menu')
      const items = $$('.ctx-menu [role="menuitem"]')
      const itemBtns = $$('.ctx-menu button[role="menuitem"]')
      check('★ 菜单项是 role=menuitem 的真 <button>（真 Electron 那套 e2e 按 `.ctx-menu button` 选元素）',
        items.length >= 8 && itemBtns.length === items.length,
        `items=${items.length} buttons=${itemBtns.length}`)
      check('★ 手搓版的三个特征全消失：无全屏遮罩 / 无 left-top 内联坐标 / 内容不在触发卡内部',
        !$('.ctx-backdrop') && !/left\s*:/.test(String((m && m.getAttribute('style')) || ''))
        && !!m && !$('#board .card').contains(m),
        `backdrop=${!!$('.ctx-backdrop')} style=${m && m.getAttribute('style')}`)
    }
    {
      // ★★ 贴右下角右键：手搓那版只按指针坐标画（`left:clientX/top:clientY`），菜单必然出屏。
      //    floating-ui 会自己翻转/平移回来 —— 这条就是"换了原语"换来的实际能力。
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(150)
      const row = $$(CARD_SEL).filter((r) => (r.textContent || '').indexOf('演示任务') >= 0)[0]
      const W = window.innerWidth
      const H = window.innerHeight
      if (row) {
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: W - 2, clientY: H - 2 }))
        await sleep(250)
      }
      const el = $('.ctx-menu')
      const r2 = el ? el.getBoundingClientRect() : null
      check('★★ 贴右下角右键，菜单不出屏（手搓版没有 flip/shift，这是换原语换来的真能力）',
        !!r2 && r2.right <= W + 1 && r2.bottom <= H + 1 && r2.left >= -1 && r2.top >= -1,
        r2 ? `menu=[${Math.round(r2.left)},${Math.round(r2.top)},${Math.round(r2.right)},${Math.round(r2.bottom)}] win=[${W},${H}]` : 'no menu')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(150)
      check('  按 Esc 能关掉菜单（手搓版只能点全屏遮罩）', !$('.ctx-menu'))
    }

    // 2026-10-30（暮雨第 3 条）：待验收的卡在列表里必须**当场能裁决** ——
    // 以前只有"点开详情 → 滚到底"这一条路，用户的原话是"点不了验收也点不了驳回"。
    {
      const vc = $$(CARD_SEL).find((r) => (r.textContent || '').indexOf('数组项目的任务') >= 0)
      const vbtns = vc ? Array.prototype.slice.call(vc.querySelectorAll('.card-verdict button')) : []
      check('★★ 「待验收」卡上直接有「通过 / 驳回」两个出口',
        vbtns.length === 2
        && (vbtns[0].textContent || '').indexOf('通过') >= 0
        && (vbtns[1].textContent || '').indexOf('驳回') >= 0,
        vbtns.map((b) => (b.textContent || '').trim()).join('|'))
      if (vbtns.length === 2) {
        vbtns[0].click()
        await sleep(300)
        check('★ 点卡上的「通过」→ 裁决框打开（不用先点开详情）',
          !!$('#review-modal') && ($('#review-modal').textContent || '').indexOf('验收') >= 0)
        const cx = $$('#review-modal .acts button').find((b) => (b.textContent || '').trim() === '取消')
        if (cx) cx.click()
        await sleep(250)
        const vbtns2 = vc ? Array.prototype.slice.call(vc.querySelectorAll('.card-verdict button')) : []
        if (vbtns2[1]) vbtns2[1].click()
        await sleep(300)
        check('★ 点卡上的「驳回」→ 同一个裁决框，且焦点落在理由框（驳回必填）',
          !!$('#review-modal') && document.activeElement === $('#review-modal textarea'),
          'active=' + (document.activeElement && document.activeElement.tagName))
        const cx2 = $$('#review-modal .acts button').find((b) => (b.textContent || '').trim() === '取消')
        if (cx2) cx2.click()
        await sleep(200)
      }
    }

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

    // ══ 顶栏「排序」（2026-09-29 修的死控件；2026-10-11 换成方案 B 的面板入口）════
    // 修前：`sortMode` 只在模板里 v-model 绑了，**全代码零引用** —— 换下拉毫无反应。
    // 夹具故意把「待办」列两张卡的 created / updated 错开，三种顺序两两不同：
    //   默认 001→002 · 按 updated 倒序 002→001 · 按 created 倒序 001→002
    // ⚠ 2026-10-11 起不再是 `<select>`：改点「排序 · <当前值>」按钮 → 同一块内联面板里点选项。
    const SORT_TEXT = { active: '活跃优先', updated: '最近更新', created: '创建时间', prio: '优先级' }
    const SORT_BTN = () => $('.fbar-sort-btn')   // 稳定类名（文案已改成「排序 <当前值>」）
    // 收起统一走 Esc：单行 chips 的浮层**没有 ✕**（只有内容多的「＋筛选」才有标题栏），
    // 而 reka 的 Popover 自带 Esc 关闭 —— 这也是"用成熟原语"省下来的代码。
    const closeFbarPanel = async () => {
      if (!$('.fpop')) return
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(280)
    }
    const openSortPanel = async () => {
      await closeFbarPanel()
      const btn = SORT_BTN()
      if (!btn) return null
      btn.click()
      await sleep(250)
      return $('.fpop') ? btn : null
    }
    const pickSort = async (v) => {
      const btn = await openSortPanel()
      if (!btn) return false
      const opt = $$('.fpop .fpop-opt').find((o) => (o.textContent || '').trim() === SORT_TEXT[v])
      if (!opt) return false
      opt.click()
      await sleep(320)
      // 判据用**按钮上显示的当前值**（方案 B 就是要让"现在选的是什么"直接看得见）
      return (btn.textContent || '').indexOf(SORT_TEXT[v]) >= 0
    }
    const statusColOrder = () => {
      const col = $$('#board .col').filter((c) => ((c.querySelector('h3') || {}).textContent || '').indexOf('待办') >= 0)[0]
      if (!col) return []
      return Array.prototype.map.call(col.querySelectorAll('.card'), (c) => c.dataset.id || '?')
    }
    check('★★ 排序有四个值（活跃优先 / 最近更新 / 创建时间 / 优先级 —— 2026-10-01 用户第 2 条）',
      await (async () => {
        const btn = await openSortPanel()
        if (!btn) return false
        const labels = $$('.fpop .fpop-opt').map((o) => String(o.textContent).trim())
        await closeFbarPanel()
        return ['活跃优先', '最近更新', '创建时间', '优先级'].every((t) => labels.indexOf(t) >= 0)
      })(),
      JSON.stringify($$('.fbar-btn').map((b) => String(b.textContent).trim())))
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
    // 剩下的密在**格子内部** —— 夹具把若干条事件压在「今天」（001 + 011/012/013…，
    // 日期跟随运行日，见 renderer-preload.cjs 的 FIX_DEADLINE：写死 9-30 会在每月 1 号假红）。
    //
    // ⚠ 2026-10-12：原先这里把「今天」的事件条数**写死成 4**（`evs === 2` + `+2 条`）。
    //   后来待办改版往「今天」又加了一条（待办也上日历）→ 变成 5 条 → `+3 条` → 假红。
    //   真规格是「格子里最多铺 CAP 条，其余折成 +N 条」，不是某个具体数字。所以：
    //   ① 期望值从**夹具真身**（window.__fcTest.fixTodayCount()）算 —— 夹具增删它自动跟上；
    //   ② CAP 同步读 window.__fcTest.calCellCap()，与 App.vue 用同一个常量，不各写一份。
    check('能切到「日历」页签', clickText('日历'))
    await sleep(700)
    const CAL_CAP = Number((window.__fcTest && window.__fcTest.calCellCap && window.__fcTest.calCellCap()) || 2)
    const CAL_TODAY_N = Number((window.__fcTest && window.__fcTest.fixTodayCount && window.__fcTest.fixTodayCount()) || 0)
    // 夹具没暴露这两个数就退回老期望（4 条 / 2 条上限），至少不会静默跳过
    const todayN = CAL_TODAY_N > 0 ? CAL_TODAY_N : (CAL_CAP + 2)
    const expEvs = Math.min(CAL_CAP, todayN)
    const expMore = todayN > CAL_CAP ? `+${todayN - CAL_CAP} 条` : ''
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
    check(`★ 一天多条时格子里最多铺 ${CAL_CAP} 条，剩下折成「${expMore || '+N 条'}」（改法 A）`,
      !cal0.err && cal0.evs === expEvs && (expMore ? cal0.more.indexOf(expMore) >= 0 : cal0.more === ''),
      JSON.stringify(Object.assign({ todayN, cap: CAL_CAP, expEvs, expMore }, cal0)))
    check('★ 点「+N 条」就地铺满这一天（不跳页、不弹窗）', await (async () => {
      const c = calCellOf()
      const b = c && c.querySelector('.cal-cell-more')
      if (!b) return false
      b.click()
      return waitFor(() => {
        const c2 = calCellOf()
        return !!c2 && c2.querySelectorAll('.cev').length >= todayN && !!c2.querySelector('.cal-cell-more.less')
      }, 4000, '日历展开')
    })())
    check('  再点「收起」回到折叠态（折叠不是单向开关）', await (async () => {
      const c = calCellOf()
      const b = c && c.querySelector('.cal-cell-more.less')
      if (!b) return false
      b.click()
      return waitFor(() => {
        const c2 = calCellOf()
        return !!c2 && c2.querySelectorAll('.cev').length === expEvs && !c2.querySelector('.cal-cell-more.less')
      }, 4000, '日历收起')
    })())
    check('  单条/空白的格子不长出「+N 条」（只在真的挤的时候才出现）',
      await (async () => {
        const others = $$('main.calendar-view .calcell').filter((c) => (c.textContent || '').indexOf('日历密度样例一') < 0)
        return others.every((c) => c.querySelectorAll('.cev').length > CAL_CAP || !c.querySelector('.cal-cell-more'))
      })())

    // ══ 项目页签 · 两种新摆法（2026-09-29 用户：「两种视图都要，做成可自选切换」）══
    // 003 卡原话「只是个大号看板入口，不是项目管理」。三个摆法（含旧的项目墙）互斥渲染。
    check('能切到「项目」页签', clickText('项目'))
    await sleep(700)
    // ══ 项目页「新建项目 / 删除项目」入口（2026-10-17 暮雨第 6 条）══
    // 原话：「项目里面不能新建项目，点进去是新建任务……我至少提过两次」。
    // 真因是新建项目弹窗与 confirmNewProject 早就写好，**但项目页没有任何按钮去打开它**。
    // 判据：① 按钮常在；② 点开真出「新建项目」弹窗（不是新建任务）。
    {
      const newProjBtn = $$('#board.pv button').find((b) => (b.textContent || '').indexOf('新建项目') >= 0)
      check('★★ 项目页有「＋ 新建项目」按钮（不再是死入口）', !!newProjBtn,
        $$('#board.pv button').map((b) => (b.textContent || '').trim()).slice(0, 8).join(' | '))
      if (newProjBtn) {
        newProjBtn.click()
        await sleep(400)
        const modal = $('#proj-new-modal')
        check('★ 点「新建项目」→ 弹出的是新建项目弹窗（不是新建任务）',
          !!modal && (modal.textContent || '').indexOf('项目 ID') >= 0,
          modal ? (modal.textContent || '').slice(0, 50) : '(没有弹窗)')
        const cancel = modal ? Array.prototype.slice.call(modal.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '取消') : null
        if (cancel) { cancel.click(); await sleep(300) }
        check('  取消后弹窗收起（没留下遮罩挡住后面）', !$('#proj-new-modal'))
      }
    }
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

    // ══ 项目监控台（卡 task-20261009-001 · 879b2f8 落地，2026-10-09 补断言）════
    // 要点：完成率环形图 / KPI 大数字 / 健康左缘色条「异常才显示」/ 阻塞源入口 /
    //       git 缺数据给拉取按钮、dirty=null 显「—」不编 0 / 0 卡不画假环。
    // 反向判据 3 条：空闲不加色条、0 卡无 ring-arc、null 不显 0。
    const pickMs = async (name) => {
      const li = $$('#board.pv .ms-li').find((x) => (x.textContent || '').indexOf(name) >= 0)
      if (!li) return false
      li.click()
      return waitFor(() => {
        const d = $('#board.pv .ms-detail')
        return !!d && (d.textContent || '').indexOf(name) >= 0
      }, 3000, '选中 ' + name)
    }
    const msSnap = () => {
      const d = $('#board.pv .ms-detail')
      if (!d) return { err: '没有 .ms-detail' }
      const ring = d.querySelector('.ms-ring')
      const arc = d.querySelector('.ring-arc')
      const git = d.querySelector('.ms-git')
      return {
        cls: d.className,
        bar: getComputedStyle(d, '::before').backgroundColor,
        ringEmpty: !!ring && ring.classList.contains('empty'),
        arcs: d.querySelectorAll('.ring-arc').length,
        arcDash: arc ? arc.style.strokeDasharray : null,
        ringnum: ((d.querySelector('.ms-ringnum') || {}).textContent || '').trim(),
        nums: $$('#board.pv .ms-detail .ms-num').map(n =>
          ((n.querySelector('span') || {}).textContent || '') + '=' + ((n.querySelector('b') || {}).textContent || '')),
        segs: d.querySelectorAll('.stack i').length,
        legend: ((d.querySelector('.legend') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
        hl: ((d.querySelector('.hl') || {}).textContent || '').trim(),
        blockers: $$('#board.pv .ms-blockers').map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()),
        gitRow: git ? (git.textContent || '').replace(/\s+/g, ' ').trim() : null,
        gitBtn: !!d.querySelector('.ms-gitbtn'),
        // 监控台两块（2026-10-11，P0）：最近执行日志流 + 僵尸卡
        feed: d.querySelectorAll('.ms-log').length,
        feedGo: !!d.querySelector('.ms-feed-go'),
        stalled: (d.querySelector('.ms-stalled') || {}).textContent || null,
      }
    }

    check('选回演示项目（监控台断言起点）', await pickMs('演示项目'))
    const s1 = msSnap()
    check('★ 完成率环形图在（有卡项目画真环，不是空态占位）',
      !s1.err && !s1.ringEmpty && s1.arcs === 1, JSON.stringify(s1))
    check('  环的 stroke-dasharray = 「已完成段 剩余段」两段数（入场缓动就靠它；读回时浏览器可能序列化成逗号分隔）',
      s1.arcDash !== null && /^\d+(\.\d+)?[,\s]+\d+$/.test(s1.arcDash), String(s1.arcDash))
    check('  环心是「数字 + %」', /^\d+%$/.test(s1.ringnum), s1.ringnum)
    check('★ KPI 大数字行三枚齐：进行中 / 已完成 / 总任务（都是数出来的，不是文案）',
      ['进行中', '已完成', '总任务'].every(k =>
        s1.nums.some(n => n.indexOf(k + '=') === 0 && /^\d+$/.test(n.slice(k.length + 1)))),
      JSON.stringify(s1.nums))
    check('★ 状态分布条有分段（宽度按占比，0 卡才该是空条）', s1.segs >= 1, 'segs=' + s1.segs)
    check('  图例与分段同源：状态名 + 条数',
      /待办|进行中|待验收|完成|驳回/.test(s1.legend) && /\d/.test(s1.legend), s1.legend)
    // 健康度：demo 夹具最后更新 2026-09-01（>30 天不写）→ 休眠 = 异常 → 色条必须在
    check('★ 健康度异常（休眠）→ 左缘色条出现 + 徽章说「休眠」（正向）',
      s1.cls.indexOf('hs-dormant') >= 0 && s1.bar !== 'rgba(0, 0, 0, 0)' && s1.bar !== 'transparent' && s1.hl === '休眠',
      JSON.stringify({ cls: s1.cls, bar: s1.bar, hl: s1.hl }))
    check('★ 阻塞源入口出现，文案说清「几个 + 去哪看」',
      s1.blockers.length === 1 && /个阻塞源/.test(s1.blockers[0]) && /看卡在谁/.test(s1.blockers[0]),
      JSON.stringify(s1.blockers))
    check('  KPI 行同步给「阻塞源」计数（同一份数据两个入口）',
      s1.nums.some(n => n === '阻塞源=1'), JSON.stringify(s1.nums))
    check('★ git 数据没拉过 → 只给「拉取提交信息」按钮，不摆空值行（不编数据）',
      s1.gitBtn && !s1.gitRow, JSON.stringify({ gitBtn: s1.gitBtn, gitRow: s1.gitRow }))

    // ── 监控台两块（2026-10-11，P0 两件）─────────────────────────────────────
    // ① 最近执行日志流：只说"最近在干什么"，看全部回日志页（那边才是主场）
    // ② 僵尸卡：判据与通知中心同源（findStalledTasks），这里只是把它放到监控台上
    check('★ 监控台有「最近执行日志」流，且都是**这个项目**的日志（demo 夹具 3 条）+ 有「看全部」入口',
      s1.feed === 3 && s1.feedGo, JSON.stringify({ feed: s1.feed, feedGo: s1.feedGo }))
    check('★ 僵尸卡提醒出现，文案带「几个 + 多久没动静」',
      !!s1.stalled && /1 个任务/.test(s1.stalled) && /24 小时/.test(s1.stalled), String(s1.stalled))

    // ── 自仓启动同步 · 「待同步」一行（2026-10-21 · W1-1C）────────────────────
    // 施工单验收：本地领先/分叉时重启 → 显示「待同步」，数据无损（不 merge 不强拉）。
    // 反向判据同样重要：一切正常/不是 git 仓库时**不许**占位 —— 否则每天开机多一行噪音。
    check('★ 同步状态「待同步」→ 监控台出现一行人话（带原因，不是只甩一个词）', await (async () => {
      window.__fcTest.setSelfSync({
        state: 'behind', at: '2026-10-21T00:00:00.000Z', repo: 'C:/mock/repo',
        message: '本地有未推送的提交或与远端分叉 —— 已按规矩不合并、不强拉，数据未动',
      })
      clickText('看板'); await sleep(400); clickText('项目'); await sleep(600)
      await pickMs('演示项目')
      return waitFor(() => {
        const el = $('#board.pv .ms-detail .ms-sync')
        const t = (el || {}).textContent || ''
        return !!el && /待同步/.test(t) && /不合并/.test(t) && el.classList.contains('ms-sync-warn')
      }, 4000, '待同步一行')
    })(), ((($('#board.pv .ms-detail .ms-sync') || {}).textContent) || '(没有 .ms-sync)').trim())
    // ⚠ 2026-10-21 暮雨实测改：原来正常态不渲染 —— 他装好后想确认"同步没同步"，
    //   界面上什么都没有，只能来问"待同步在哪看"。**看不见 = 不存在**，所以改成常驻一行。
    check('★★ 同步正常 → 也常驻一行灰字（"已是最新（今天 hh:mm）"），不再是空白', await (async () => {
      window.__fcTest.setSelfSync({ state: 'ok', at: '2026-10-21T09:26:00.000Z', message: '已是最新', repo: 'C:/mock/repo' })
      clickText('看板'); await sleep(350); clickText('项目'); await sleep(600)
      await pickMs('演示项目'); await sleep(250)
      const el = $('#board.pv .ms-detail .ms-sync')
      const t = (el || {}).textContent || ''
      return !!el && /同步：已是最新/.test(t) && /（今天 \d{2}:\d{2}）/.test(t) && el.classList.contains('ms-sync-ok')
    })(), (($('#board.pv .ms-detail .ms-sync') || {}).textContent || '(没有这一行)').trim())
    check('★ 非 git 仓库（skipped = 安装版常态）→ **不渲染**（唯一不显示的状态：报出来就是噪音）', await (async () => {
      window.__fcTest.setSelfSync({ state: 'skipped', at: '2026-10-21T00:00:00.000Z', message: '数据根不是 git 仓库（安装版常态），跳过自动同步', repo: '' })
      clickText('看板'); await sleep(350); clickText('项目'); await sleep(600)
      await pickMs('演示项目'); await sleep(250)
      return !$('#board.pv .ms-detail .ms-sync')
    })())
    window.__fcTest.setSelfSync(null)

    // ── 监控台「建议动作 / 可并行机会」（2026-10-23 补：两条死通道接回后零断言）──
    // 它们是 10-11「A 组死通道收口」接回来的，桩却一直返回 [] —— 于是「接了但没渲染」
    // 和「渲染了但字段名写错（o.reason）」两种坏法都不会被发现。
    check('★★ 建议动作真渲染（suggestActions 按项目 id 调，不是全局糊一把）', await (async () => {
      clickText('看板'); await sleep(350); clickText('项目'); await sleep(600)
      await pickMs('演示项目')
      const ok = await waitFor(() => $$('#board.pv .ms-suggest-item').length >= 2, 4000, '建议两条')
      if (!ok) return false
      const args = (window.__fcTest.calls().filter((c) => c.name === 'suggestActions').pop() || {}).args || []
      return args[0] === 'demo'
    })(), JSON.stringify((window.__fcTest.calls().filter((c) => c.name === 'suggestActions').pop() || {}).args))
    check('★ 建议文案来自主进程（界面不自己编）',
      (($('#board.pv .ms-detail') || {}).textContent || '').indexOf('夹具建议') >= 0,
      (($('#board.pv .ms-suggest') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 60))
    check('★★ 可并行机会只显示「跨项目 + 本项目」的，别的项目那条不许串进来', (() => {
      const box = $$('#board.pv .ms-suggest').map((e) => e.textContent || '').join(' | ')
      return box.indexOf('跨项目可并行') >= 0 && box.indexOf('本项目两个批次') >= 0
        && box.indexOf('别的项目的机会') < 0
    })(), (($('#board.pv .ms-suggest') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 90))

    check('★ 点阻塞源入口 → 真跳「阻塞」页签（不是死按钮）', await (async () => {
      const b = $('#board.pv .ms-blockers')
      if (!b) return false
      b.click()
      return waitFor(() => !!$('main.blockers-view'), 4000, '跳到阻塞页签')
    })())
    // 2026-10-22 拆成 views/BlockersView.vue 之后补内容断言：
    // 只验"页面出现"是不够的 —— 组件拆坏了（props 没接上）页照样出现，只是里面空的。
    check('★★ 阻塞页内容还是真的（拆组件后）：链卡片 / 计数 / 关键路径建议',
      await (async () => {
        const cards = $$('main.blockers-view .chain-card')
        const head = ($('main.blockers-view .blockers-count') || {}).textContent || ''
        const advice = $('main.blockers-view .blocker-advice')
        return cards.length === 1
          && ((cards[0].textContent || '').indexOf('演示任务') >= 0 || cards[0].querySelector('.chain-title'))
          && /个阻塞源/.test(head) && /影响/.test(head)
          && !!advice
      })(), (($('main.blockers-view') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 90))
    check('  传递效应算进建议里（unlock 数字来自 shared/blockers，不是拍脑袋）', await (async () => {
      const note = ($('main.blockers-view .ba-note') || {}).textContent || ''
      return /\d+\s*个任务就不再被卡/.test(note)
    })(), (($('main.blockers-view .ba-note') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 60))
    check('  回到项目页签（主从摆法还在）', await (async () => {
      if (!clickText('项目')) return false
      return waitFor(() => $$('#board.pv .pv-ms .ms-li').length >= 2, 4000, '回到主从')
    })())

    // ── 路线文档实况（2026-10-21 · W1-批次 2）───────────────────────────────
    // 施工单：监控台除了 git 活动，还要能看见「文档级实况」，与手写值**并列**、标来源、不覆盖手写。
    // 这一节验四件：①块在且标了来源；②README/ROADMAP 各一行 + 一句话摘要；③docs 变更那行；
    // ④反向：读不到时给原因，**不虚构**文档行（空数据冒充"没有进展"是这类功能最容易犯的错）。
    check('★★ 监控台多了「路线文档」块，且标了来源（自动 · 只读）', (() => {
      const d = $('#board.pv .ms-detail .ms-docs')
      if (!d) return false
      return /自动/.test(((d.querySelector('.ms-docs-src') || {}).textContent) || '')
    })(), (($('#board.pv .ms-detail .ms-docs') || {}).textContent || '(没有 .ms-docs)').replace(/\s+/g, ' ').slice(0, 90))
    check('★★ ROADMAP 在前、README 在后（路线才是监控台要回答的问题；README 只是对外说明）', (() => {
      const ks = $$('#board.pv .ms-detail .ms-doc-k').map((e) => (e.textContent || '').trim())
      return ks.length === 2 && ks[0] === 'ROADMAP' && ks[1] === 'README'
    })(), JSON.stringify($$('#board.pv .ms-detail .ms-doc-k').map((e) => (e.textContent || '').trim())))
    // 2026-10-21 暮雨反馈「README 只截一行，通常没什么有用信息」→ 摘要改成**前两段**
    check('★★ 摘要收的是**两段**（不是一句标语就算完），且默认只有 2 行高度', (() => {
      const row = $$('#board.pv .ms-detail .ms-doc').find((r) => /README/.test((r.textContent || '')))
      const t = row && row.querySelector('.ms-doc-t')
      if (!t) return false
      const txt = (t.textContent || '')
      const clamp = getComputedStyle(t).webkitLineClamp || getComputedStyle(t).getPropertyValue('-webkit-line-clamp')
      return /两行摘要/.test(txt) && /第二段也进摘要/.test(txt) && String(clamp).trim() === '2'
    })(), (() => {
      const row = $$('#board.pv .ms-detail .ms-doc').find((r) => /README/.test((r.textContent || '')))
      const t = row && row.querySelector('.ms-doc-t')
      return t ? ('clamp=' + (getComputedStyle(t).webkitLineClamp || '(空)') + ' len=' + (t.textContent || '').length) : '(没有 README 行)'
    })())
    check('★★ 点一下 README 行 → 展开成 more 全文；再点收起（内容真读到了，不是只看两行）', await (async () => {
      const row = () => $$('#board.pv .ms-detail .ms-doc').find((r) => /README/.test((r.textContent || '')))
      const before = ((row().querySelector('.ms-doc-t') || {}).textContent || '').length
      row().click()
      const opened = await waitFor(() => {
        const r2 = row()
        return r2 && r2.classList.contains('open')
          && ((r2.querySelector('.ms-doc-t') || {}).textContent || '').length > before
      }, 2000, '展开')
      const after = ((row().querySelector('.ms-doc-t') || {}).textContent || '').length
      row().click()
      const closed = await waitFor(() => !row().classList.contains('open'), 2000, '收起')
      return opened && closed && after > before
    })(), 'len=' + ((($$('#board.pv .ms-detail .ms-doc').find((r) => /README/.test((r.textContent || ''))) || { querySelector: () => ({}) }).querySelector('.ms-doc-t') || {}).textContent || '').length)
    check('★ 「最近 docs 变更」那行在：条数 + 最后一条标题（施工日志的文档级实况，不是又列一遍 git 活动）', (() => {
      const t = (($('#board.pv .ms-detail .ms-docs-log') || {}).textContent) || ''
      return /最近 docs 变更/.test(t) && /W1 施工单/.test(t) && /2026-10-20/.test(t)
    })(), (($('#board.pv .ms-detail .ms-docs-log') || {}).textContent || '(没有 docs-log)').replace(/\s+/g, ' '))
    check('★ 缓存命中（cached=true）→ 写「今天读过」（不冒充刚刷新过）', await (async () => {
      window.__fcTest.setProjectDocs({
        ok: true, repo: 'E:/CODE/mock/demo', cached: true, readAt: '2026-10-21T00:00:00.000Z', note: '',
        readme: { rel: 'README.md', title: '演示项目', excerpt: '今天的缓存。', bytes: 10, mtime: '2026-10-19T00:00:00.000Z' },
        roadmap: null,
        docsCommits: [{ hash: 'abc1234', date: '2026-10-20', subject: 'docs: 补 W1 施工单', files: [] }],
      })
      clickText('看板'); await sleep(350); clickText('项目'); await sleep(600)
      await pickMs('演示项目')
      return waitFor(() => /今天读过/.test((($('#board.pv .ms-detail .ms-docs-at') || {}).textContent) || ''), 3000, '今天读过')
    })())
    // 只有 README、没有 ROADMAP 时，必须明说 —— 否则用户会把"对外说明"当成路线
    check('★★ 有 README 没 ROADMAP → 明说"没找到 ROADMAP"（不让人把对外说明当路线）', await (async () => {
      window.__fcTest.setProjectDocs({
        ok: true, repo: 'E:/CODE/mock/demo', cached: false, readAt: '2026-10-21T00:00:00.000Z',
        note: '没找到 ROADMAP —— 下面的 README 是项目对外说明，不一定有"接下来做什么"',
        readme: { rel: 'README.md', title: '演示项目', excerpt: '只有 README。', more: '只有 README。', bytes: 10, mtime: '2026-10-19T00:00:00.000Z' },
        roadmap: null, docsCommits: [],
      })
      clickText('看板'); await sleep(350); clickText('项目'); await sleep(600)
      await pickMs('演示项目')
      return waitFor(() => {
        const d = $('#board.pv .ms-detail .ms-docs')
        const t = (d && d.textContent) || ''
        return $$('#board.pv .ms-detail .ms-doc').length === 1 && /没找到 ROADMAP/.test(t)
      }, 3000, '缺 ROADMAP 提示')
    })(), ((($('#board.pv .ms-detail .ms-docs') || {}).textContent) || '').replace(/\s+/g, ' ').slice(0, 90))

    check('★★ 反例：读不到（没登记工作目录）→ 给原因，且**不虚构** README/ROADMAP 行', await (async () => {
      window.__fcTest.setProjectDocs({
        ok: false, repo: '', cached: false, readAt: '2026-10-21T00:00:00.000Z',
        note: '项目没登记工作目录 —— 读不到路线文档', readme: null, roadmap: null, docsCommits: [],
      })
      clickText('看板'); await sleep(350); clickText('项目'); await sleep(600)
      await pickMs('演示项目')
      const ok = await waitFor(() => {
        const d = $('#board.pv .ms-detail .ms-docs')
        return !!d && $$('#board.pv .ms-detail .ms-doc').length === 0
      }, 3000, '空态')
      const t = (($('#board.pv .ms-detail .ms-doc-none') || {}).textContent) || ''
      return ok && /没登记工作目录/.test(t)
    })(), (($('#board.pv .ms-detail .ms-docs') || {}).textContent || '(没有 .ms-docs)').replace(/\s+/g, ' ').slice(0, 100))
    window.__fcTest.setProjectDocs(null)

    // git 行：注入 dirty=null 的夹具 → 拉取后 demo 显真数、demo2 显「—」（反向：绝不显 0）
    window.__fcTest.setTripBoard({
      generatedAt: '2026-10-09 09:00', mode: 'auto', criteria: 'cards_or_commit',
      rows: [
        {
          id: 'demo', name: '演示项目', repo: 'E:/CODE/mock/demo',
          contract: { exists: true, path: 'E:/CODE/mock/demo/立项契约.md', endState: '桌面客户端为主产品。', acceptLine: '', notWant: '', choice: '' },
          current: { text: '正在做的事', from: 'task', sub: '' },
          next: { text: '要做的下一件', from: 'task', sub: '1 张待办（最高：中）' },
          who: { text: 'hermes（执行）', kind: 'exec' },
          health: { value: 'active', locked: false },
          counts: { todo: 1, doing: 1, review: 0, logs: 0 },
          lastCommit: '1 天前', recentCommit: true, dirty: 3,
          flags: { noCards: false, noLogs: true },
        },
        {
          id: 'demo2', name: '第二个项目', repo: '',
          contract: { exists: false, path: '', endState: '', acceptLine: '', notWant: '', choice: '' },
          current: { text: '进度日志1001', from: 'log', sub: '3 天前' },
          next: { text: '', from: '', sub: '' },
          who: { text: '', kind: 'none' },
          health: { value: 'paused', locked: true },
          counts: { todo: 0, doing: 0, review: 0, logs: 7 },
          lastCommit: '3 天前', recentCommit: true, dirty: null,   // ← 读不到 git 的真形态
          flags: { noCards: true, noLogs: false },
        },
      ],
      hidden: [
        { id: 'demo3', name: '还没开工的项目', kind: 'no-activity', reason: '没有任务卡、没有执行日志，30 天内也没有提交' },
      ],
    })
    check('★ 点「拉取提交信息」→ git 行出现，数字来自数据（最近提交 1 天前 / 未提交 3）', await (async () => {
      const btn = $('#board.pv .ms-gitbtn')
      if (!btn) return false
      btn.click()
      const got = await waitFor(() => {
        const d = $('#board.pv .ms-detail')
        return !!d && !!d.querySelector('.ms-git')
      }, 4000, 'git 行渲染')
      const row = msSnap().gitRow || ''
      return got && row.indexOf('最近提交') >= 0 && row.indexOf('1 天前') >= 0 && /未提交\s*3/.test(row)
    })())
    let demo2GitRow = ''
    check('★ dirty=null → 显示「—」，绝不编 0（反向判据：不许出现「未提交 0」）', await (async () => {
      if (!(await pickMs('第二个项目'))) return false
      demo2GitRow = msSnap().gitRow || ''
      return /未提交\s*—/.test(demo2GitRow) && !/未提交\s*0/.test(demo2GitRow)
    })(), demo2GitRow || '(没有 git 行)')

    // 0 卡空态：临时抽掉 demo2 的那张卡（还原动作也在断言里 —— 后续整轮都跑在还原后的数据上）
    const origTasks = window.__fcTest.tasks()
    window.__fcTest.setTasks(origTasks.filter(t => t.id !== 'task-demo-004'))
    clickText('看板'); await sleep(300)
    check('  数据重拉：切回项目页签', clickText('项目'))
    await sleep(400)
    check('选中 0 卡的第二个项目（空态断言起点）', await pickMs('第二个项目'))
    const s2 = msSnap()
    check('★★ 0 卡不画假环：环是虚线空态，SVG 弧线一段都没有（反向判据）',
      !s2.err && s2.ringEmpty && s2.arcs === 0, JSON.stringify(s2))
    check('  空态环心给「—」，图例说「还没有任务卡」',
      s2.ringnum === '—' && s2.legend.indexOf('还没有任务卡') >= 0,
      JSON.stringify({ ringnum: s2.ringnum, legend: s2.legend }))
    check('  KPI 总任务 = 0（数出来的 0，不是没渲染）',
      s2.nums.some(n => n === '总任务=0'), JSON.stringify(s2.nums))
    check('★★ 健康度「异常才显示」：0 卡 = 空闲 → 左缘一个像素都不加（反向判据）',
      s2.cls.indexOf('hs-idle') >= 0 && (s2.bar === 'rgba(0, 0, 0, 0)' || s2.bar === 'transparent') && s2.hl === '空闲',
      JSON.stringify({ cls: s2.cls, bar: s2.bar, hl: s2.hl }))
    check('  空闲项目没有阻塞源入口（没有异常就不报警）',
      s2.blockers.length === 0, JSON.stringify(s2.blockers))
    window.__fcTest.setTasks(origTasks)
    window.__fcTest.setTripBoard(null)
    clickText('看板'); await sleep(300)
    clickText('项目'); await sleep(400)
    const s3 = msSnap()
    check('  夹具还原成功：第二个项目回到 1 张卡',
      s3.nums.some(n => n === '总任务=1'), JSON.stringify(s3.nums))
    check('  还原后演示项目的阻塞源入口仍在', (await pickMs('演示项目')) && msSnap().blockers.length === 1,
      JSON.stringify(msSnap().blockers))

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
    // ── 四栏台账第四栏「欠着什么」（2026-10-22 · 03 任务三）──────────────
    check('★★ 「欠着什么」列在（到哪了 / 下一步 / 在等谁 / 欠着什么 四栏齐）',
      !tp.err && tp.heads.some((h) => h === '欠着什么'), JSON.stringify(tp.heads))
    const oweCells = $$('#board.pv .trip-table .trip-owe')
    check('★ 有说明的行显示 registry 里的欠账原文',
      oweCells.length >= 2 && (oweCells[0].textContent || '').indexOf('夹具欠账') >= 0,
      JSON.stringify(oweCells.map((c) => (c.textContent || '').trim())))
    check('★★ 没写说明的行显示「未写」（不许糊一句"暂无欠账"冒充有结论）',
      oweCells.some((c) => (c.textContent || '').trim() === '未写'),
      JSON.stringify(oweCells.map((c) => (c.textContent || '').trim())))
    check('  长文本挂 title（一眼看不全也能悬停看全文）',
      !!oweCells[0] && !!oweCells[0].querySelector('.trip-owe-t')
      && !!oweCells[0].querySelector('.trip-owe-t').getAttribute('title'))
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
    // 文件在、但终态读不出来 —— 旧版会并进「未填」分支，于是只剩一个会被主进程拒绝的
    // 「建契约文件」。**2026-10-11 起还要把"为什么读不出来"分类说清**（真事：绒花墨坊的契约
    // 用「① 终态三段」这套自定义小节名，界面写「内容未填」，用户当场反问「已经有内容了啊？」）。
    // 这里注入两种夹具，把两条分支各逼一次。
    const tripWithContract = (contract, name) => {
      window.__fcTest.setTripBoard({
        generatedAt: '2026-10-08 12:00', mode: 'auto', criteria: 'cards_or_commit',
        rows: [{
          id: 'demo', name: name || '演示项目', repo: 'E:/CODE/mock/demo',
          contract,
          current: { text: '', from: '', sub: '' }, next: { text: '', from: '', sub: '' },
          who: { text: '', kind: 'none' }, health: { value: 'active', locked: false },
          counts: { todo: 0, doing: 0, review: 0, logs: 0 }, lastCommit: '', recentCommit: false, dirty: 0,
          flags: { noCards: false, noLogs: true },
        }],
        hidden: [],
      })
    }
    const tripReEnter = async () => {
      const wall = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('项目墙') >= 0)
      if (wall) wall.click()
      await sleep(300)
      const back = $$('.pagehead button.vsb').find((x) => x.textContent.indexOf('在途一屏') >= 0)
      if (back) back.click()
      if (!(await waitFor(() => $$('#board.pv .tripboard').length === 1, 5000, '回到在途一屏'))) return null
      return $$('#board.pv .trip-table tbody tr')[0] || null
    }

    check('★★ 契约有文件但小节名对不上 → 必须说「小节名不在标准六节里」，'
      + '**不许**说成「内容未填」（用户 2026-10-11 就是被这句误导的）', await (async () => {
      tripWithContract({
        exists: true, path: 'E:/CODE/mock/demo/立项契约.md',
        endState: '', acceptLine: '', notWant: '', choice: '',
        sections: [{ name: '① 终态三段（产线）', field: null }],
        filled: [], placeholderFields: [], unmatched: ['① 终态三段（产线）'],
      })
      const row = await tripReEnter()
      if (!row) return false
      const txt = (row.textContent || '').replace(/\s+/g, ' ')
      const minis = Array.prototype.slice.call(row.querySelectorAll('.trip-mini'))
        .map((b) => (b.textContent || '').trim())
      const ok = txt.indexOf('文件已建 · 小节名不在标准六节里') >= 0
        && txt.indexOf('内容未填') < 0
        && minis.some((t) => t.indexOf('打开契约') >= 0)
        && !minis.some((t) => t.indexOf('建契约文件') >= 0)
      window.__fcTest.setTripBoard(null)
      return ok
    })())

    check('★ 契约六节都是模板占位（司天那种空表）→ 必须说「还是模板占位（没填）」，'
      + '**不许**把骨架文案当成已填内容显示', await (async () => {
      tripWithContract({
        exists: true, path: 'E:/CODE/mock/demo/立项契约.md',
        endState: '', acceptLine: '', notWant: '', choice: '',
        sections: [{ name: '① 终态形态', field: '终态形态' }],
        filled: [], placeholderFields: ['终态形态', '验收线'], unmatched: [],
      })
      const row = await tripReEnter()
      if (!row) return false
      const txt = (row.textContent || '').replace(/\s+/g, ' ')
      window.__fcTest.setTripBoard(null)
      return txt.indexOf('文件已建 · 还是模板占位（没填）') >= 0
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

    // ══ 卡 006（2026-10-09 拍板 A）：点项目卡 → 项目详情，不再是空看板 ═══════
    // 旧行为 = curProj + 跳看板活跃视图；Quartz 这类 0 卡项目点进去必然是空屏。
    const tile006 = $('#board.pv .tile:not(.tile-add)')
    const tileName006 = tile006 ? (((tile006.querySelector('.tname') || {}).textContent) || '').trim() : ''
    check('★ 点项目墙的卡片 → 进项目详情（复用主从 ms-detail），不再跳空看板', await (async () => {
      if (!tile006 || !tileName006) return false
      tile006.click()
      const got = await waitFor(() => $$('#board.pv .pv-ms').length === 1
        && $$('#board.pv .pvgrid').length === 0
        && !!$('#board.pv .ms-detail .ocard'), 4000, '进项目详情')
      const d = $('#board.pv .ms-detail')
      return got && !!d && ((d.textContent || '').indexOf(tileName006) >= 0)
    })(), 'tile=' + tileName006)
    check('★ 导航不写偏好：fc_pv_view 仍是 tiles（点卡是浏览，摆法偏好不被顺手改掉）',
      window.__fcTest.prefs().fc_pv_view === 'tiles',
      JSON.stringify(window.__fcTest.prefs().fc_pv_view))
    check('★ 详情里的「📦 看任务」仍跳看板（点卡进详情 / 点按钮进看板，两条路分开）', await (async () => {
      const b = $$('#board.pv .ms-detail .oacts button').find((x) => (x.textContent || '').indexOf('看任务') >= 0)
      if (!b) return false
      b.click()
      const ok = await waitFor(() => !$('#board.pv') && !!$('#board'), 4000, '跳看板')
      // 看板带项目筛选了 —— 还原成「全部项目」，别污染后面的断言。
      // 2026-10-11 起项目筛选是「触发按钮 + 面板」：走面板里的「全部项目」选项（仍是一次点击）。
      // 2026-10-12：项目筛选没有独立按钮了 -> 从筛选浮层里选「全部」归零。
      const fbtn = $('.fbar-filter-btn')
      if (fbtn) {
        fbtn.click(); await sleep(280)
        const all = $$('.fpop .fpop-opt').find((b) => (b.textContent || '').trim() === '全部')
        if (all) all.click()
        await sleep(300)
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(200)
      }
      return ok
    })())

    // ══ 日志 · 接力链（2026-09-29 第 3 条方案二）═══════════════════════
    await sleep(300)
    check('能切到「日志」页签', clickText('日志'))
    await sleep(500)

    // ── 吸顶工具栏满宽（2026-10-11 视觉修复）────────────────────────────────
    // 用户：「日志顶部工具栏与背景略有些不协调，尤其左侧」。真因是**特异性** ——
    // `#board { padding: 14px; align-items: flex-start }`（ID 选择器）把 `.logs-view`（类）的
    // padding 整条压掉了，于是吸顶条只覆盖"内容宽"、左右各露 14px 底色。
    // 这类视觉 bug 肉眼才看得出来，所以这里直接量几何把它钉住。
    const stickyW = $('.logs-sticky') ? Math.round($('.logs-sticky').getBoundingClientRect().width) : -1
    const viewW = $('.logs-view') ? $('.logs-view').clientWidth : -1
    check('★ 吸顶工具栏宽度 == 容器内容宽（背景满宽，两侧不露底色）',
      stickyW > 0 && viewW > 0 && Math.abs(stickyW - viewW) < 2,
      `sticky=${stickyW} view=${viewW}`)

    // 2026-10-30 暮雨第 2 轮：「分区头别写解释」——
    // 旧版写「还没派出去（要派给 AI 就点那张卡的…）」，用户原话「直接什么都不写都更好」。
    check('★★ 分区头不再画蛇添足地解释状态（用户已明确说不要）',
      $$('.log-group-sep .log-group-hint').length === 0,
      $$('.log-group-sep .log-group-hint').map(h => (h.textContent || '').trim()).join(' | ') || '(none)')

    // ══ 日志 · 主日志 + 附属（2026-10-30 暮雨第 2/3 条返工）══════════════
    // 现场：主日志点「进行中」只改了自己 → 附属还散在「待处理」区，视觉极乱；
    // 绑定弹窗是一张没有查询能力的裸名单；「开工单」三个字没人知道是复制还是干活。
    window.__fcTest.setLogs([
      { id: 'log-grp-main', title: '主日志·本轮六件事', content: '主日志正文', status: 'active',
        project: 'demo', created: '2026-10-30T03:00:00.000Z', attached: ['log-grp-a', 'log-grp-b'] },
      { id: 'log-grp-a', title: '附属·白屏修复', content: 'A 正文', status: 'active',
        project: 'demo', created: '2026-10-30T02:00:00.000Z', agentName: 'hermes' },
      { id: 'log-grp-b', title: '附属·附件策略', content: 'B 正文', status: 'active',
        project: 'demo', created: '2026-10-30T01:00:00.000Z' },
      { id: 'log-grp-other', title: '别的主日志', content: 'C', status: 'active', project: 'demo',
        created: '2026-10-29T00:00:00.000Z', attached: ['log-grp-x'] },
      { id: 'log-grp-x', title: '别人的附属', content: 'X', status: 'active', project: 'demo',
        created: '2026-10-28T00:00:00.000Z' },
      { id: 'log-grp-free', title: '可绑的独立日志', content: 'free', status: 'active', project: 'demo',
        created: '2026-10-27T00:00:00.000Z' },
    ])
    clickText('看板'); await sleep(300); check('重进日志页（附属夹具就位）', clickText('日志')); await sleep(700)
    const groupCard = () => $('.log-card[data-log-id="log-grp-main"]')
    check('★★ 附属收进主日志下面的框（.log-group-box 出现）',
      !!groupCard() && !!groupCard().querySelector('.log-group-box'),
      groupCard() ? groupCard().textContent.replace(/\s+/g, ' ').slice(0, 120) : 'no main card')
    check('★★ 附属不再作为顶层卡重复出现（log-grp-a / log-grp-b 各 0 张）',
      $$('.log-card[data-log-id="log-grp-a"]').length === 0 &&
      $$('.log-card[data-log-id="log-grp-b"]').length === 0,
      'a=' + $$('.log-card[data-log-id="log-grp-a"]').length + ' b=' + $$('.log-card[data-log-id="log-grp-b"]').length)
    check('★ 顶层只剩两张主日志 + 一张独立日志（3 张）', $$('.log-card').length === 3,
      'cards=' + $$('.log-card').map(c => c.getAttribute('data-log-id')).join(','))
    check('★ 主日志框里逐条列出 2 行附属',
      !!groupCard() && groupCard().querySelectorAll('.log-kid-row').length === 2,
      'rows=' + (groupCard() ? groupCard().querySelectorAll('.log-kid-row').length : -1))
    check('★ 每一行都有自己的 ▶ / 完成 / 编辑 三个出口',
      (() => {
        const rows = groupCard() ? groupCard().querySelectorAll('.log-kid-row') : []
        return rows.length === 2 && Array.prototype.every.call(rows, r =>
          !!r.querySelector('.lk-run') && !!r.querySelector('.lk-done') && !!r.querySelector('.lk-edit'))
      })())
    check('  几何：附属框不溢出主卡、每行高度在可点范围内（不是挤成一条线）',
      (() => {
        const card = groupCard()
        const box = card && card.querySelector('.log-group-box')
        const row = card && card.querySelector('.log-kid-row')
        if (!card || !box || !row) return false
        const cr = card.getBoundingClientRect(), br = box.getBoundingClientRect(), rr = row.getBoundingClientRect()
        return br.width <= cr.width + 1 && br.left >= cr.left - 1 && rr.height >= 22 && rr.height <= 52
      })(),
      (() => {
        const card = groupCard()
        const box = card && card.querySelector('.log-group-box')
        const row = card && card.querySelector('.log-kid-row')
        if (!card || !box || !row) return 'no box/row'
        const cr = card.getBoundingClientRect(), br = box.getBoundingClientRect(), rr = row.getBoundingClientRect()
        return `card=${Math.round(cr.width)} box=${Math.round(br.width)} rowH=${Math.round(rr.height)}`
      })())
    check('★★ 「开工单」写明只复制、不改状态（不再是三个字的黑盒）',
      (() => {
        const box = groupCard() && groupCard().querySelector('.log-group-box')
        const t = (box && box.textContent) || ''
        return t.indexOf('复制开工单') >= 0 && t.indexOf('只复制') >= 0 && t.indexOf('不改状态') >= 0
      })(), ((groupCard() && groupCard().querySelector('.lg-box-hint') || {}).textContent || '(no hint)').trim())

    // 点主日志的「进行中」= 全组进行中（用户实测期望）
    const runCalls = () => window.__fcTest.calls().filter(c => c.name === 'logsGroupRunning')
    const beforeGroupRun = runCalls().length
    const runBtn = groupCard() && groupCard().querySelector('.log-run-btn')
    check('★★ 主日志上的运行开关写的是「全组进行中」（不是单条）',
      !!runBtn && (runBtn.textContent || '').indexOf('全组进行中') >= 0,
      runBtn ? String(runBtn.textContent).trim() : 'no run btn')
    if (runBtn) runBtn.click()
    check('★★ 点主日志「进行中」真走全组通道（logsGroupRunning 主日志 id + true）',
      await waitFor(() => runCalls().length > beforeGroupRun, 4000, 'group running') &&
      (() => { const c = runCalls().pop(); return c.args[0] === 'log-grp-main' && c.args[1] === true })(),
      JSON.stringify(runCalls().pop() || null))
    check('★★ 附属跟着变成「进行中」（不再出现主日志在跑、附属还待处理的乱象）',
      await waitFor(() => {
        const c = groupCard()
        if (!c) return false
        const rows = c.querySelectorAll('.log-kid-row')
        return rows.length === 2 && Array.prototype.every.call(rows, r => /进行中/.test(r.textContent || ''))
      }, 5000, 'children running'),
      groupCard() ? Array.prototype.map.call(groupCard().querySelectorAll('.log-kid-row'), r => (r.textContent || '').slice(0, 20)).join(' | ') : 'no card')

    // 附属行仍可单独控制（关系不丢，但每条是独立日志）
    const kidRunCalls = () => window.__fcTest.calls().filter(c => c.name === 'logsSetRunning' && c.args[0] === 'log-grp-a')
    const beforeKid = kidRunCalls().length
    const kidA = groupCard() && groupCard().querySelector('.log-kid-row[data-kid-id="log-grp-a"]')
    if (kidA) kidA.querySelector('.lk-run').click()
    check('★★ 附属行能单独撤销「进行中」（不碰主日志、不碰别的附属）',
      await waitFor(() => kidRunCalls().length > beforeKid, 4000, 'kid run') &&
      kidRunCalls().pop().args[1] === false,
      JSON.stringify(kidRunCalls().pop() || null))

    // 单独完成打开的是**这一条**的完成框，不是整组
    const doneCalls = () => window.__fcTest.calls().filter(c => c.name === 'logsComplete')
    const beforeKidDone = doneCalls().length
    const kidA2 = groupCard() && groupCard().querySelector('.log-kid-row[data-kid-id="log-grp-a"]')
    if (kidA2) kidA2.querySelector('.lk-done').click()
    check('★ 附属行「完成」打开这条日志的完成框',
      await waitFor(() => !!$('#log-edit-modal'), 3000, 'kid complete modal') &&
      (() => {
        const t = $('#log-edit-modal input[placeholder="日志标题"]')
        return !!t && t.value === '附属·白屏修复'
          && /完成日志/.test((($('#log-edit-modal h3') || {}).textContent) || '')
      })(),
      (() => {
        const t = $('#log-edit-modal input[placeholder="日志标题"]')
        return 'title=' + (t ? t.value : '(none)') + ' h3=' + ((($('#log-edit-modal h3') || {}).textContent) || '')
      })())
    const cancelKidDone = $$('#log-edit-modal .acts button').find(b => (b.textContent || '').trim() === '取消')
    if (cancelKidDone) cancelKidDone.click()
    await sleep(250)
    check('  取消后没有写完成（不是点开就等于完成）', doneCalls().length === beforeKidDone)

    // 点行 = 打开这一条的只读预览（每条都能单独看）
    const kidB = groupCard() && groupCard().querySelector('.log-kid-row[data-kid-id="log-grp-b"]')
    if (kidB) kidB.click()
    check('★ 点附属行能单独打开只读预览',
      await waitFor(() => !!$('#log-preview-modal'), 3000, 'kid preview') &&
      (($('#log-preview-modal') || {}).textContent || '').indexOf('附属·附件策略') >= 0)
    const closeKidPreview = $$('#log-preview-modal .acts button').find(b => /关闭|取消/.test(b.textContent || ''))
    if (closeKidPreview) closeKidPreview.click()
    await sleep(250)

    // 开工单：真把主日志 + 全部附属按顺序送进 injectMany（只复制，不改状态）
    const injectCalls = () => window.__fcTest.calls().filter(c => c.name === 'logsInjectMany')
    const beforeInject = injectCalls().length
    const promptBtn = groupCard() && groupCard().querySelector('.lg-prompt')
    if (promptBtn) promptBtn.click()
    check('★★ 「复制开工单」真走 logsInjectMany（主日志在第一位 + 全部附属）',
      await waitFor(() => injectCalls().length > beforeInject, 4000, 'inject group') &&
      JSON.stringify(injectCalls().pop().args[0]) === JSON.stringify(['log-grp-main', 'log-grp-a', 'log-grp-b']),
      JSON.stringify((injectCalls().pop() || {}).args || null))

    // 绑定弹窗：六个查询维度 + 全量候选 + 已占用原因
    const bindBtn = groupCard() && groupCard().querySelector('.lg-bind')
    if (bindBtn) bindBtn.click()
    check('打开绑定附属弹窗', await waitFor(() => !!$('#log-attach-modal'), 3000, 'attach modal'))
    check('★★ 弹窗里有搜索 / 项目 / 状态 / Agent / 优先级 / 日期 六个查询维度',
      !!$('#log-attach-modal .la-search') &&
      $$('#log-attach-modal .la-filters select').length >= 4 &&
      $$('#log-attach-modal .la-filters input[type="date"]').length === 2,
      'selects=' + $$('#log-attach-modal .la-filters select').length +
      ' dates=' + $$('#log-attach-modal .la-filters input[type="date"]').length)
    const attachRows = () => $$('#log-attach-modal .la-row')
    check('★★ 候选来自全量日志（主界面筛选影响不到它）',
      await waitFor(() => attachRows().some(r => /可绑的独立日志/.test(r.textContent || '')), 4000, 'attach all logs'),
      attachRows().map(r => (r.textContent || '').replace(/\s+/g, ' ').slice(0, 18)).join(' | '))
    check('  已被别的组占用的日志默认不列',
      !attachRows().some(r => /别人的附属/.test(r.textContent || '')))
    // 清空已选后再验筛选（否则「已选」会为了不丢选择而越过筛选）
    const clearPick = $$('#log-attach-modal .la-countline button').find(b => /清空已选/.test(b.textContent || ''))
    if (clearPick) clearPick.click()
    await sleep(150)

    const q = $('#log-attach-modal .la-search')
    if (q) { q.value = '可绑'; q.dispatchEvent(new Event('input', { bubbles: true })) }
    check('★★ 关键词筛选真缩小候选（只剩「可绑的独立日志」）',
      await waitFor(() => attachRows().length === 1 && /可绑的独立日志/.test(attachRows()[0].textContent || ''), 3000, 'attach query'),
      'rows=' + attachRows().length)
    if (q) { q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })) }
    await sleep(200)

    const selByOption = (txt) => $$('#log-attach-modal .la-filters select')
      .find(s => Array.prototype.some.call(s.options, o => (o.textContent || '').trim() === txt))
    const statusSel = selByOption('全部状态')
    if (statusSel) { statusSel.value = 'completed'; statusSel.dispatchEvent(new Event('change', { bubbles: true })) }
    check('★ 状态筛选真生效（没有已完成 → 空结果并说明怎么放宽）',
      await waitFor(() => attachRows().length === 0 && !!$('#log-attach-modal .la-empty'), 3000, 'attach status'),
      'rows=' + attachRows().length)
    if (statusSel) { statusSel.value = ''; statusSel.dispatchEvent(new Event('change', { bubbles: true })) }
    await sleep(200)

    const showBlocked = $('#log-attach-modal .la-toggle input')
    if (showBlocked) { showBlocked.checked = true; showBlocked.dispatchEvent(new Event('change', { bubbles: true })) }
    check('★★ 打开「显示已占用」能看到被别的组占走的日志，并写明原因',
      await waitFor(() => attachRows().some(r => /别人的附属/.test(r.textContent || '')
        && /已被/.test(r.textContent || '')), 3000, 'attach blocked'),
      attachRows().map(r => (r.textContent || '').replace(/\s+/g, ' ').slice(0, 28)).join(' | '))

    // 勾一条 → 保存：主日志 + 勾选结果送进 logsSetAttached
    const freeRow = attachRows().find(r => /可绑的独立日志/.test(r.textContent || ''))
    const freeCb = freeRow && freeRow.querySelector('input[type="checkbox"]')
    if (freeCb) { freeCb.checked = true; freeCb.dispatchEvent(new Event('change', { bubbles: true })) }
    await sleep(200)
    const saveAttach = $$('#log-attach-modal .acts button').find(b => /保存绑定/.test(b.textContent || ''))
    if (saveAttach) saveAttach.click()
    check('★★ 保存绑定把主日志 + 勾选结果一起送进 logsSetAttached',
      await waitFor(() => window.__fcTest.calls().some(c => c.name === 'logsSetAttached'
        && c.args[0] === 'log-grp-main' && Array.isArray(c.args[1]) && c.args[1].length === 1
        && c.args[1][0] === 'log-grp-free'), 4000, 'setAttached'),
      JSON.stringify((window.__fcTest.calls().filter(c => c.name === 'logsSetAttached').pop() || {}).args || null))
    await sleep(300)

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
    check('★ 分区头仍只有状态名，不再附一句「已经派给 AI」',
      !/已经派给 AI/.test((($('.log-group-sep.g-running') || {}).textContent) || ''),
      (($('.log-group-sep.g-running') || {}).textContent || '(no running section)').trim())
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
    // 2026-10-30（暮雨第 6 条）：会话 ID 必须能在接力对话框里一次填完 ——
    // 以前要"先创建，再点编辑，再贴 ID"，一个字段强制点两次。
    check('★★ 接力对话框里能直接填「本次会话 ID」（不用建完再点编辑）',
      (() => {
        const lab = $$('#relay-modal label').find(l => (l.textContent || '').indexOf('本次会话 ID') >= 0)
        return !!lab && lab.nextElementSibling && lab.nextElementSibling.tagName === 'INPUT'
      })(), $$('#relay-modal label').map(l => (l.textContent || '').slice(0, 8)).join(' | '))
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
    maskClick('#relay-overlay')
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

    // 2026-10-30（暮雨第 6 条）：会话 ID 一次填完 —— 真的建一条，验 IPC 收到 sessionId
    {
      const rb4 = $$('.relay-btn')[0]
      if (rb4) rb4.click()
      await waitFor(() => !!$('#relay-modal'), 3000, 'relay session modal')
      const t = $('#relay-modal input[placeholder*="标题"]')
      if (t) {
        t.value = '会话ID接力验证'
        t.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const sessLab = $$('#relay-modal label').find(l => (l.textContent || '').indexOf('本次会话 ID') >= 0)
      const sessIn = sessLab && sessLab.nextElementSibling
      if (sessIn) {
        sessIn.value = 'sess-e2e-001'
        sessIn.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const createBtn = $$('#relay-modal .acts button').find(b => (b.textContent || '').trim() === '创建')
      const beforeCreate = window.__fcTest.callCount('logsCreate')
      if (createBtn) createBtn.click()
      check('★★ 接力创建时把「本次会话 ID」一起送进 logsCreate（不再建完再编辑）',
        await waitFor(() => window.__fcTest.callCount('logsCreate') > beforeCreate, 4000, 'relay create'),
        'before=' + beforeCreate + ' after=' + window.__fcTest.callCount('logsCreate'))
      const created = window.__fcTest.calls().filter(c => c.name === 'logsCreate').pop()
      check('  传的是刚填的 sess-e2e-001（不是继承源会话）',
        !!created && !!created.args && !!created.args[4] && created.args[4].sessionId === 'sess-e2e-001',
        JSON.stringify(created && created.args && created.args[4] && created.args[4].sessionId))
      await waitFor(() => !$('#relay-modal'), 3000, 'relay session closed')
    }

    // ══ 2026-10-30 暮雨第 5 条：撤销条串对象（重大 bug）════════════════════
    // 现场：误点「标为进行中」→ 按 Ctrl+Z / 点顶部撤销 → 进行中没撤掉，
    // 反而把 60 秒前那条「已完成」撤回了「待处理」。
    // 真因：`toggleLogRunning` 当时**没有登记自己的撤销**，旧条子一直挂着，Ctrl+Z 撤的是旧对象。
    {
      window.__fcTest.clearUndo?.()
      window.__fcTest.setLogs([
        { id: 'log-undo-a', title: '撤销串对象A', content: '', status: 'active', project: 'demo', created: '2026-10-30T00:00:00.000Z' },
        { id: 'log-undo-b', title: '撤销串对象B', content: '', status: 'active', project: 'demo', created: '2026-10-30T00:01:00.000Z' },
      ])
      clickText('看板'); await sleep(300); clickText('日志'); await sleep(700)
      const cardOf = (t) => $$('.log-card').find((c) => (c.textContent || '').indexOf(t) >= 0)
      const ca = cardOf('撤销串对象A')
      const doneA = ca && Array.prototype.slice.call(ca.querySelectorAll('.log-card-actions button'))
        .find((b) => (b.textContent || '').trim() === '完成')
      if (doneA) doneA.click()
      await waitFor(() => !!$('#log-edit-modal'), 3000, 'complete modal')
      const confirmDone = $$('#log-edit-modal .acts button').find((b) => (b.textContent || '').trim() === '确认完成')
      if (confirmDone) confirmDone.click()
      await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'logsComplete'), 4000, 'logsComplete')
      await sleep(400)
      const bar1 = $('#undo-bar') ? ($('#undo-bar').textContent || '') : ''
      check('  前置：完成 A 之后撤销条记的是这一笔', bar1.indexOf('撤销串对象A') >= 0, bar1)

      const cb = cardOf('撤销串对象B')
      const runB = cb && Array.prototype.slice.call(cb.querySelectorAll('.log-card-actions button'))
        .find((b) => (b.textContent || '').indexOf('标为进行中') >= 0)
      if (runB) runB.click()
      await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'logsSetRunning'
        && c.args[0] === 'log-undo-b' && c.args[1] === true), 4000, 'run B')
      await sleep(300)
      const bar2 = $('#undo-bar') ? ($('#undo-bar').textContent || '') : ''
      check('★★ 点「进行中」后撤销条立刻换成这一笔（不是 60 秒前的「完成」）',
        bar2.indexOf('进行中') >= 0 && bar2.indexOf('撤销串对象B') >= 0, bar2)
      const ub = $('#undo-bar .ub-btn')
      if (ub) ub.click()
      check('★★ 撤销真的撤掉了 B 的「进行中」',
        await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'logsSetRunning'
          && c.args[0] === 'log-undo-b' && c.args[1] === false), 4000, 'undo B'))
      check('★★ 已完成的 A 没有被退回待处理（原 bug：撤 B 却把 A 改成待处理）',
        !window.__fcTest.calls().some((c) => c.name === 'logsReopen' && c.args[0] === 'log-undo-a'))
      const caAfter = cardOf('撤销串对象A')
      check('  A 卡仍然是「已完成」', !!caAfter && (caAfter.textContent || '').indexOf('已完成') >= 0,
        caAfter ? (caAfter.textContent || '').slice(0, 60) : 'no card')
    }

    // ══ 2026-10-30 用户拍板：AI 只能申请收口，完成必须人点 ══════════════════
    // 现场：agent 调 set_log_status complete 直接把日志完成了，用户没机会看。
    // 现在 agent 只能 request_close → 卡上出现「⏳ 等你确认」+「✅ 确认完成」，
    // 点下去才真的进 completed（这里走真按钮 + 真 logsComplete）。
    {
      window.__fcTest.setLogs([
        { id: 'log-close-req', title: '等你确认样例', content: '这一轮做完了', status: 'active',
          agentDone: true, project: 'demo', created: '2026-10-30T01:00:00.000Z' },
      ])
      clickText('看板'); await sleep(250); clickText('日志'); await sleep(600)
      const card = $$('.log-card').find((c) => (c.textContent || '').indexOf('等你确认样例') >= 0)
      check('★★ AI 申请收口后卡上出现「⏳ 等你确认」（不是完成态）',
        !!card && !!card.querySelector('.log-agent-done')
        && (card.querySelector('.log-agent-done').textContent || '').indexOf('等你确认') >= 0,
        card ? (card.textContent || '').slice(0, 80) : 'no card')
      const confirm = card && Array.prototype.slice.call(card.querySelectorAll('.log-card-actions button'))
        .find((b) => (b.textContent || '').indexOf('确认完成') >= 0)
      check('★★ 卡上给用户「✅ 确认完成」按钮（签字入口在人这边）', !!confirm,
        card ? Array.prototype.slice.call(card.querySelectorAll('.log-card-actions button')).map((b) => b.textContent.trim()).join('|') : 'no card')
      if (confirm) {
        confirm.click()
        await waitFor(() => !!$('#log-edit-modal'), 3000, 'complete modal')
        const okBtn = $$('#log-edit-modal .acts button').find((b) => (b.textContent || '').trim() === '确认完成')
        if (okBtn) okBtn.click()
        check('★★ 用户点「确认完成」才真的走 logsComplete',
          await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'logsComplete' && c.args[0] === 'log-close-req'), 4000, 'logsComplete'))
        await sleep(400)
        const card2 = $$('.log-card').find((c) => (c.textContent || '').indexOf('等你确认样例') >= 0)
        check('  完成后「等你确认」标记消失（不会留成假待办）',
          !!card2 && !card2.querySelector('.log-agent-done'))
      }
    }

    // ══ 日志 → 待办：内容**一条不丢**（2026-10-11 用户实测的丢内容 bug）══════════
    // 原话：「我把 log_20260925113550_0z73dy 转待办，发现内容全丢，变成空待办。本以为文本会留住的。」
    // 真因两处：① 只取「下一步」首条当标题，而那条日志的下一步是占位 `（待填写）`；
    //          ② 日志**正文一个字都不带**（旧实现只搬一行）。夹具照那条日志的形态复刻。
    {
      const savedLogs = window.__fcTest.logs()
      const savedTodos = window.__fcTest.todos()
      const LOST_LOG = {
        id: 'log-lost-1', title: '角色设定待审0925', project: 'demo', status: 'active',
        created: '2026-09-25T11:35:50.161Z',
        content: '- 成功生成：2 项（凛视.md / 霜痕.md）\n- 输出目录：E:\\图书馆\\ROSA\\Obsidian_AI_Sandbox\\10_Inbox\\',
        nextSteps: '（待填写）',
      }
      window.__fcTest.setLogs([LOST_LOG])
      clickText('看板'); await sleep(300)
      check('  重进日志页（丢内容用例就位）', clickText('日志'))
      await sleep(500)
      const before = window.__fcTest.callCount('todosCreate')
      const card = $$('.log-card').find((c) => (c.textContent || '').indexOf('角色设定待审0925') >= 0)
      const btn = card && Array.prototype.slice.call(card.querySelectorAll('button'))
        .find((b) => (b.textContent || '').indexOf('转待办') >= 0)
      check('  日志卡上有「⤴ 转待办」入口', !!btn)
      if (btn) {
        btn.click()
        await waitFor(() => !!$('#conv-modal'), 4000, '转换确认框')
        const go = $$('#conv-modal button').find((b) => (b.textContent || '').trim() === '转换')
        if (go) go.click()
        await waitFor(() => window.__fcTest.callCount('todosCreate') > before, 4000, 'todosCreate')
        const call = window.__fcTest.calls().filter((c) => c.name === 'todosCreate').pop()
        const text = call ? String(call.args[0] || '') : ''
        check('★★ 待办里带着日志**正文全文**（旧版把正文整个丢了 —— 这才是"内容全丢"的真因）',
          text.indexOf('成功生成：2 项') >= 0 && text.indexOf('Obsidian_AI_Sandbox') >= 0,
          JSON.stringify(text.slice(0, 120)))
        check('★★ 占位「（待填写）」不许当内容（旧版拿它当标题，整条待办只剩这四个字）',
          !text.startsWith('（待填写）') && text.split('\n')[0].indexOf('（待填写）') < 0,
          JSON.stringify(text.split('\n')[0]))
        check('  首行落回日志标题（下一步是占位时的正确退路）',
          text.split('\n')[0].indexOf('角色设定待审0925') >= 0, JSON.stringify(text.split('\n')[0]))
        check('  来源行标出「由哪条日志转来」（转完还追得回去）',
          text.indexOf('由日志') >= 0 && text.indexOf('log-lost-1') >= 0)
      }
      // ⚠ 用完**还原现场**：本段插在日志段的中间，后面还有接力/附件的断言要用原夹具。
      //   只 clear 不还原会连带打红一大片（第一版就是这么红的）。
      window.__fcTest.setLogs(savedLogs)
      window.__fcTest.setTodos(savedTodos)
      clickText('看板'); await sleep(250)
      clickText('日志'); await sleep(450)
    }

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

    // ══ 安装包附件不直接运行（2026-10-30 暮雨白屏事故）════════════════════════
    // 现场：点日志里挂的安装包 → 方寸白屏成空壳，只能退出重进。
    // 根因是旧实现把所有附件都交给 shell.openPath，`.exe` 会直接启动安装程序。
    // 现在：可执行文件只返回 needsReveal，界面确认后走「在文件夹中显示」。
    {
      window.__fcTest.setLogs([
        { id: 'log-att-exe', title: '安装包附件样例', content: 'x', status: 'active', project: 'demo',
          created: '2026-10-30T00:00:00.000Z',
          attachments: ['docs/执行日志/_attachments/log-att-exe/Fangcun-Setup.0.5.0.exe'] },
      ])
      clickText('看板'); await sleep(300); clickText('日志'); await sleep(600)
      const c = $$('.log-card').find(x => (x.textContent || '').indexOf('安装包附件样例') >= 0)
      if (c) c.click()
      check('  安装包附件的预览打开', await waitFor(() => !!$('#log-preview-modal'), 3000, 'exe preview'))
      const fileRow = $('#log-preview-modal .attach-file')
      check('★★ 可执行附件的悬停提示写明"不会直接运行"',
        !!fileRow && /不会直接运行|文件夹/.test(fileRow.getAttribute('title') || ''),
        fileRow ? fileRow.getAttribute('title') : 'no .attach-file')
      const origConfirmExe = window.confirm
      let confirmMsg = ''
      window.confirm = (m) => { confirmMsg = String(m); return true }
      window.__fcTest.reset()
      if (fileRow) fileRow.click()
      check('★★ 点安装包 → 真走 logs:openAttachment（由主进程判策略）',
        await waitFor(() => window.__fcTest.callCount('logsOpenAttachment') > 0, 3000, 'openAttachment'),
        JSON.stringify(window.__fcTest.calls().map((x) => x.name)))
      check('★★ 主进程回 needsReveal 后，界面弹确认并改走「在文件夹中显示」',
        await waitFor(() => window.__fcTest.callCount('logsRevealAttachment') > 0, 3000, 'revealAttachment'),
        JSON.stringify(window.__fcTest.calls().map((x) => x.name)))
      check('★ 确认框说清风险（可执行 / 安装 / 白屏），不是一句"打开失败"',
        /可执行|安装/.test(confirmMsg) && /文件夹|双击/.test(confirmMsg),
        confirmMsg.slice(0, 100))
      window.confirm = origConfirmExe
      const close2 = $$('#log-preview-modal .acts button').find(b => (b.textContent || '').indexOf('关闭') >= 0)
      if (close2) close2.click()
      await sleep(250)
    }

    // ══ 新建日志 + 待挂附件（2026-10-29 暮雨第 5 条：「创建日志加附件则不能保存」）══════
    // 真机现场（应用日志 2026-10-28 21:51）：新建弹窗里挂了 7 张粘贴图 → 点创建 →
    // 弹窗不关、附件永远挂不上、**重试永远同一个结果**；主进程日志里一条 IPC 失败都没有。
    // 根因：`[...logPendingData.value]` 展开出来的元素是 **Vue 响应式代理**，
    // 过 contextBridge 在「页面 → 隔离世界」那一跳抛 `could not be cloned` —— 报文根本没进主进程。
    // 这条断言就是钉住它：**创建要成功、两条附件通道都要被真的调用到**。
    check('回到日志页（新建 + 附件断言前置）', clickText('日志'))
    await sleep(400)
    const lgCallsBefore = window.__fcTest.calls().length
    const lgNewBtn = $$('button').find(b => (b.textContent || '').indexOf('新建日志') >= 0)
    if (lgNewBtn) lgNewBtn.click()
    check('★ 新建日志弹窗打开', await waitFor(() => !!$('#log-edit-modal'), 3000, 'log edit modal'))
    const lgPickBtn = $('#log-edit-modal .attach-add')
    if (lgPickBtn) lgPickBtn.click()
    check('★★ 新建态也能选附件，且进「待挂」清单（不必先创建再回来挂）',
      await waitFor(() => $$('#log-edit-modal .attach-pending-item').length === 1, 3000, 'pending path'),
      'items=' + $$('#log-edit-modal .attach-pending-item').length)
    // 拖一张真图进去 —— 走的是「内存字节」那条通道（真机出事的正是它）
    const lgDropInfo = await (async () => {
      const modal = $('#log-edit-modal')
      if (!modal) return { ok: false, why: 'no modal' }
      try {
        const dt = new DataTransfer()
        dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], '拖入截图.png', { type: 'image/png' }))
        modal.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
        return { ok: true }
      } catch (e) { return { ok: false, why: String(e && e.message) } }
    })()
    check('  夹具可用：能构造一次真实 drop', lgDropInfo.ok, JSON.stringify(lgDropInfo))
    check('★★ 拖进来的图也进「待挂」（两条通道共用一份清单）',
      await waitFor(() => $$('#log-edit-modal .attach-pending-item').length === 2, 4000, 'pending data'),
      'items=' + $$('#log-edit-modal .attach-pending-item').length)
    const lgTitle = $('#log-edit-modal input[placeholder="日志标题"]')
    if (lgTitle) {
      lgTitle.value = '带附件的日志'
      lgTitle.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const lgCreateBtn = $$('#log-edit-modal .acts button').find(b => (b.textContent || '').trim() === '创建')
    if (lgCreateBtn) lgCreateBtn.click()
    const lgCalls = () => window.__fcTest.calls().slice(lgCallsBefore)
    check('★★ 点「创建」真的走了 logsCreate', await waitFor(() => lgCalls().some(c => c.name === 'logsCreate'), 4000, 'logsCreate'),
      JSON.stringify(lgCalls().map(c => c.name)))
    check('★★ 附件真的送进了主进程（两条通道都要到：按路径复制 + 按内存字节）',
      await waitFor(() => {
        const cs = lgCalls()
        const byPath = cs.some(c => c.name === 'logsAttachFiles' && Array.isArray(c.args && c.args[1]) && c.args[1].length > 0)
        const byData = cs.some(c => c.name === 'logsAttachData' && Array.isArray(c.args && c.args[1]) && c.args[1].length > 0)
        return byPath && byData
      }, 5000, 'attach calls'),
      JSON.stringify(lgCalls().filter(c => /attach/i.test(c.name)).map(c => c.name)))
    check('★★ 创建 + 挂附件之后弹窗**关掉**了（不再卡在"看起来没保存"）',
      await waitFor(() => !$('#log-edit-modal'), 4000, 'modal closed'))
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

    // ══ 关联任务 chips 改造（2026-10-09 用户第 3 条）════════════════════════
    // 「每次都加载一堆任务让我头疼，于是干脆什么都不选」→ 索引字段不做任务浏览器：
    // 默认折叠（候选 0 渲染 = 反向判据）、按需展开、过滤、勾选成 chip、× 摘除。
    const chipsToggle = () => $$('#log-edit-modal .log-task-head button')[0]
    check('打开新建日志（chips 断言前置）', await (async () => {
      const b = $$('.logs-view button, #board button').find(x => (x.textContent || '').indexOf('新建日志') >= 0)
      if (!b) return false
      b.click()
      return waitFor(() => !!$('#log-edit-modal'), 3000, 'chips: new log')
    })())
    check('★★ 关联任务默认折叠：候选列表根本不在 DOM 里（不再全量铺一屏 —— 反向判据）',
      $$('#log-edit-modal .log-task-opt').length === 0 && $$('#log-edit-modal .log-task-multi').length === 0,
      'opts=' + $$('#log-edit-modal .log-task-opt').length)
    check('  默认态说清「还没有关联任务」+ 给展开入口（不是空一片）',
      (($('#log-edit-modal .log-task-head') || {}).textContent || '').indexOf('还没有关联任务') >= 0
      && !!chipsToggle() && (chipsToggle().textContent || '').indexOf('＋ 关联任务') >= 0)
    check('★ 点「＋ 关联任务」→ 候选按需展开（带过滤框），按钮变「收起」', await (async () => {
      const b = chipsToggle()
      if (!b) return false
      b.click()
      const got = await waitFor(() => $$('#log-edit-modal .log-task-opt').length > 0
        && !!$('#log-edit-modal .log-task-search'), 3000, '展开候选')
      return got && (chipsToggle().textContent || '').indexOf('收起') >= 0
    })())
    const chipsOptBefore = $$('#log-edit-modal .log-task-opt').length
    check('★ 过滤「011」→ 只剩匹配的那条（全量列表被过滤吃掉）', await (async () => {
      const inp = $('#log-edit-modal .log-task-search')
      if (!inp) return false
      inp.value = '011'
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return waitFor(() => {
        const opts = $$('#log-edit-modal .log-task-opt')
        return opts.length === 1 && (opts[0].textContent || '').indexOf('task-demo-011') >= 0
      }, 3000, '过滤 011')
    })(), 'before=' + chipsOptBefore)
    check('★ 勾选 → chip 立刻出现（标题回显，不是裸 id）', await (async () => {
      const cb = $('#log-edit-modal .log-task-opt input')
      if (!cb) return false
      cb.click()
      return waitFor(() => {
        const chip = $$('#log-edit-modal .lt-chip')[0]
        return !!chip && (chip.textContent || '').indexOf('日历密度样例一') >= 0
      }, 3000, 'chip 出现')
    })())
    check('★ 点 chip 的 × → 关联被摘掉（复选框同步取消 —— 一条数据两条路）', await (async () => {
      const x = $('#log-edit-modal .lt-chip .lt-x')
      if (!x) return false
      x.click()
      return waitFor(() => {
        const i2 = $('#log-edit-modal .log-task-opt input')
        return $$('#log-edit-modal .lt-chip').length === 0 && !!i2 && i2.checked === false
      }, 3000, '摘除 chip')
    })())
    check('  摘干净回到「还没有关联任务」，关窗不弹丢弃确认（状态与打开时一致）', await (async () => {
      const head = (($('#log-edit-modal .log-task-head') || {}).textContent || '')
      if (head.indexOf('还没有关联任务') < 0) return false
      const cancel = $$('#log-edit-modal .acts button').find(b2 => (b2.textContent || '').trim() === '取消')
      if (!cancel) return false
      cancel.click()
      return waitFor(() => !$('#log-edit-modal'), 3000, '取消关窗')
    })())

    // ══ 完成/归档弹窗不再丢改动（2026-10-17 用户报障「点完成后保存按钮会被替换，输入一万字也会全丢」）══
    // 病灶：完成/归档弹窗表单照常可编辑，但主按钮只调 logsComplete/logsArchive —— 字段零回写，
    // 改动静默蒸发。修法三层：①主按钮 dirty 时叫「保存并完成/保存并归档」，点了先 logsUpdate
    // 全字段再走状态；②「保存修改」次按钮只存内容不碰状态；③回写失败中止不标完成。
    window.__fcTest.setLogs([
      { id: 'log-fin-1', title: '完成弹窗保存样例', content: '原始正文', nextSteps: '原下一步', status: 'active', project: 'demo', created: '2026-10-16T00:00:00.000Z' },
      { id: 'log-fin-2', title: '归档弹窗保存样例', content: '原始正文', status: 'active', project: 'demo', created: '2026-10-16T01:00:00.000Z' },
    ])
    clickText('看板'); await sleep(400); clickText('日志'); await sleep(600)
    const btnOnCard = (title, txt) => {
      const card = $$('.log-card').find(c => (((c.querySelector('.log-card-title') || {}).textContent) || '').indexOf(title) >= 0)
      if (!card) return null
      return Array.prototype.slice.call(card.querySelectorAll('.log-card-actions button'))
        .find(b => (b.textContent || '').trim() === txt) || null
    }
    check('打开完成弹窗（保存修复断言前置）', await (async () => {
      const b = btnOnCard('完成弹窗保存样例', '完成')
      if (!b) return false
      b.click()
      return waitFor(() => !!$('#log-edit-modal'), 3000, '完成弹窗')
    })())
    check('★ 完成弹窗主按钮未改动时叫「确认完成」（不冒充保存）', (() => {
      const b = $$('#log-edit-modal .acts button.pri')[0]
      return !!b && (b.textContent || '').trim() === '确认完成'
    })(), (($('#log-edit-modal .acts button.pri') || {}).textContent || '(没读到)').trim())
    check('★★ 改正文 → 主按钮 dirty 感知变「保存并完成」（字面即承诺先落盘）', await (async () => {
      const ta = $('#log-edit-modal textarea[placeholder="执行内容..."]')
      if (!ta) return false
      ta.value = '一万字的补充内容'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return waitFor(() => (($$('#log-edit-modal .acts button.pri')[0] || {}).textContent || '').trim() === '保存并完成', 3000, 'dirty 文案')
    })())
    const finUpdBefore = window.__fcTest.callCount('logsUpdate')
    const finCmpBefore = window.__fcTest.callCount('logsComplete')
    const finPri = $$('#log-edit-modal .acts button.pri')[0]
    if (finPri) finPri.click()
    check('★★ 「保存并完成」= 先 logsUpdate 全字段（一万字进 updates）再 logsComplete', await (async () => {
      const got = await waitFor(() => window.__fcTest.callCount('logsUpdate') > finUpdBefore
        && window.__fcTest.callCount('logsComplete') > finCmpBefore, 4000, 'update→complete')
      const ups = window.__fcTest.calls().filter(c => c.name === 'logsUpdate')
      const cmp = window.__fcTest.calls().filter(c => c.name === 'logsComplete')
      const up = (ups[ups.length - 1] || {}).args || []
      return got && up[0] === 'log-fin-1'
        && (up[1] || {}).content === '一万字的补充内容'
        && (up[1] || {}).title === '完成弹窗保存样例'
        && ((cmp[cmp.length - 1] || {}).args || [])[0] === 'log-fin-1'
    })(), JSON.stringify((window.__fcTest.calls().filter(c => c.name === 'logsUpdate').pop() || {}).args))
    check('★ 完成后弹窗关闭（老路径不变）', await waitFor(() => !$('#log-edit-modal'), 3000, '关窗'))
    check('打开归档弹窗（同病验证前置）', await (async () => {
      const b = btnOnCard('归档弹窗保存样例', '归档')
      if (!b) return false
      b.click()
      return waitFor(() => !!$('#log-edit-modal'), 3000, '归档弹窗')
    })())
    check('★ 归档弹窗主按钮未改动叫「确认归档」；「保存修改」次按钮在场', (() => {
      const pri = $$('#log-edit-modal .acts button.pri')[0]
      const keep = $$('#log-edit-modal .acts button').find(b2 => (b2.textContent || '').trim() === '保存修改')
      return !!pri && (pri.textContent || '').trim() === '确认归档' && !!keep
    })())
    const arcUpdBefore = window.__fcTest.callCount('logsUpdate')
    const arcCmpBefore = window.__fcTest.callCount('logsArchive')
    check('★★ 归档弹窗点「保存修改」→ 只送 logsUpdate、不碰 logsArchive（状态未变出口）', await (async () => {
      const ta = $('#log-edit-modal textarea[placeholder="执行内容..."]')
      if (!ta) return false
      ta.value = '只想存，不想归档'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const keep = $$('#log-edit-modal .acts button').find(b2 => (b2.textContent || '').trim() === '保存修改')
      if (!keep) return false
      keep.click()
      return waitFor(() => window.__fcTest.callCount('logsUpdate') > arcUpdBefore
        && window.__fcTest.callCount('logsArchive') === arcCmpBefore, 4000, '只存不归档')
    })())
    const arcUpd = (window.__fcTest.calls().filter(c => c.name === 'logsUpdate').pop() || {}).args || []
    check('★★ 「保存修改」的内容真进了 updates（content=只想存，不想归档）',
      arcUpd[1] && arcUpd[1].content === '只想存，不想归档', JSON.stringify(arcUpd))
    check('★ 「保存修改」后弹窗关闭、日志仍在待处理区（没被顺手完成/归档）', await waitFor(() => !$('#log-edit-modal'), 3000, '关窗'))

    // ══ 撤销条 + Ctrl+Z（2026-10-21 暮雨第 1 条）══════════════════════════════
    // 原话：「我点错了日志，把另一个日志点了完成，虽然撤销按钮在，但快捷键无用。
    //         左上角只有返回，没有撤销按钮。」
    // 病灶不是"没有撤销能力"（`logs:reopen` 早就在），是**撤销入口跟着卡片走**：
    // 状态一改，那条卡就滑到别的分区去了，人只剩"回头翻"一条路；而 Ctrl+Z 是
    // 刻意不接管的（原生撤销）。修法：状态动作成功后当场挂一条撤销条 + Ctrl+Z 等价。
    // 这一节验四条：①条子当场出现且带标题；②点它=真 logsReopen（撤的是这条）；
    // ③Ctrl+Z 与点它等价；④**反例**：焦点在输入框里时 Ctrl+Z 不许被抢。
    window.__fcTest.clearUndo?.()
    window.__fcTest.setLogs([
      { id: 'log-undo-1', title: '撤销条样例·甲', content: 'x', status: 'active', project: 'demo', created: '2026-10-20T00:00:00.000Z' },
      { id: 'log-undo-2', title: '撤销条样例·乙', content: 'x', status: 'active', project: 'demo', created: '2026-10-20T01:00:00.000Z' },
    ])
    clickText('看板'); await sleep(400); clickText('日志'); await sleep(600)
    check('撤销条前置：完成「撤销条样例·甲」', await (async () => {
      const b = btnOnCard('撤销条样例·甲', '完成')
      if (!b) return false
      b.click()
      const opened = await waitFor(() => !!$('#log-edit-modal'), 3000, '完成弹窗')
      const pri = $$('#log-edit-modal .acts button.pri')[0]
      if (opened && pri) pri.click()
      return opened
    })())
    check('★★ 完成后**当场**出现撤销条（#undo-bar 在，且点的是哪条就写哪条标题）',
      await waitFor(() => {
        const b = $('#undo-bar')
        return !!b && (b.textContent || '').indexOf('撤销条样例·甲') >= 0
      }, 4000, '撤销条出现'),
      (($('#undo-bar') || {}).textContent || '(没读到)').slice(0, 80))
    // ⚠ 2026-10-21 暮雨实测改：原来放**底部**，而他是在**顶部**那条提示上找撤销 —— 找不到就认为"没有"。
    //   现在撤销条在顶部居中，与 toast 同一视觉带；两者同时出现时 toast 下移一格（不叠在一起）。
    check('  撤销条贴屏幕**顶部**居中（与 toast 同一视觉带：两条 y 都在上半屏）', (() => {
      const ub = $('#undo-bar'); const ts = $('#toast')
      if (!ub || !ts) return false
      const rb = rect(ub); const rt = rect(ts)
      return rb.y < window.innerHeight / 2 && rt.y < window.innerHeight / 2
        && Math.abs((rb.x + rb.w / 2) - (rt.x + rt.w / 2)) < 8
    })(), (() => {
      const u = $('#undo-bar'); const t2 = $('#toast')
      return (u ? 'undo.y=' + Math.round(rect(u).y) : '(无撤销条)') + ' ' + (t2 ? 'toast.y=' + Math.round(rect(t2).y) : '(无 toast)')
    })())
    check('★ 撤销条上写着快捷键 Ctrl+Z（用户按了没反应时会以为"没这功能"）',
      /Ctrl\+Z/.test((($('#undo-bar .ub-key') || {}).textContent) || ''),
      (($('#undo-bar') || {}).textContent || '').slice(0, 60))
    // 连锁红收口：撤销条都没出现的话，后面"点它 / Ctrl+Z / 不抢输入框"全都无从谈起 ——
    // 只报一次原因，不连坐成一排红（连锁红会盖住真正的第一条）。
    if (!$('#undo-bar')) {
      out.push('SKIP  撤销条后续 4 条断言（前置未成立：完成后没出现撤销条）')
    } else {
    const undoReopenBefore = window.__fcTest.callCount('logsRestoreState')
    check('★ 点撤销条「↩ 撤销」→ 真按快照还原（撤的是那一条），条子自己消失', await (async () => {
      const btn = $('#undo-bar .ub-btn')
      if (!btn) return false
      btn.click()
      const got = await waitFor(() => window.__fcTest.callCount('logsRestoreState') > undoReopenBefore
        && !$('#undo-bar'), 4000, 'restore + 条子消失')
      const last = window.__fcTest.calls().filter(c => c.name === 'logsRestoreState').pop() || {}
      return got && ((last.args || [])[0] === 'log-undo-1')
    })(), JSON.stringify((window.__fcTest.calls().filter(c => c.name === 'logsRestoreState').pop() || {}).args))

    // Ctrl+Z：再造一笔（乙），焦点在 body（不在输入框）→ 必须等价于点按钮
    window.__fcTest.clearUndo?.()
    check('Ctrl+Z 前置：完成「撤销条样例·乙」', await (async () => {
      const b = btnOnCard('撤销条样例·乙', '完成')
      if (!b) return false
      b.click()
      const opened = await waitFor(() => !!$('#log-edit-modal'), 3000, '完成弹窗乙')
      const pri = $$('#log-edit-modal .acts button.pri')[0]
      if (opened && pri) pri.click()
      return opened && await waitFor(() => !!$('#undo-bar'), 4000, '撤销条乙')
    })())
    const zReopenBefore = window.__fcTest.callCount('logsRestoreState')
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    check('★★ Ctrl+Z（焦点不在输入框）= 点撤销条：真按快照还原且条子消失', await (async () => {
      const got = await waitFor(() => window.__fcTest.callCount('logsRestoreState') > zReopenBefore && !$('#undo-bar'), 4000, 'ctrl+z restore')
      const last = window.__fcTest.calls().filter(c => c.name === 'logsRestoreState').pop() || {}
      return got && ((last.args || [])[0] === 'log-undo-2')
    })(), JSON.stringify((window.__fcTest.calls().filter(c => c.name === 'logsRestoreState').pop() || {}).args))

    // ⚠ 反例（缺这条，上面那条照样绿 —— 因为"抢不抢输入框"根本没人管）：
    //   焦点在 textarea 里按 Ctrl+Z，必须**放行原生撤销**：不调 logsReopen，条子也不消失。
    window.__fcTest.clearUndo?.()
    check('Ctrl+Z 反例前置：再完成一笔并打开一个带输入框的弹窗', await (async () => {
      window.__fcTest.setLogs([
        { id: 'log-undo-3', title: '撤销条样例·丙', content: 'x', status: 'active', project: 'demo', created: '2026-10-20T02:00:00.000Z' },
      ])
      clickText('看板'); await sleep(350); clickText('日志'); await sleep(600)
      const b = btnOnCard('撤销条样例·丙', '完成')
      if (!b) return false
      b.click()
      const opened = await waitFor(() => !!$('#log-edit-modal'), 3000, '完成弹窗丙')
      const pri = $$('#log-edit-modal .acts button.pri')[0]
      if (opened && pri) pri.click()
      const bar = await waitFor(() => !!$('#undo-bar'), 4000, '撤销条丙')
      const nb = $$('.logs-view button, #board button').find(x => (x.textContent || '').indexOf('新建日志') >= 0)
      if (nb) nb.click()
      return bar && await waitFor(() => !!$('#log-edit-modal'), 3000, '新建弹窗')
    })())
    // ⚠ 规则在 2026-10-21 晚被用户实测推翻了：原来"焦点在输入框就放行原生撤销"，
    //   结果他点完完成、焦点落在某处，按 Ctrl+Z 毫无反应 → 判定"快捷键无用"。
    //   新规则 = **只要撤销条还在，Ctrl+Z 就撤这一步数据动作（不管焦点在哪）**。
    check('★★ 焦点在输入框里按 Ctrl+Z **也接管**（用户实测：否则他按了没反应）', await (async () => {
      const ta = $('#log-edit-modal textarea')
      if (!ta) return false
      ta.focus()
      // ⚠ 必须先确认焦点**真的**落进了输入框，否则这条测的是"没焦点时能撤"，不是它想说的那件事
      if (document.activeElement !== ta) return false
      const before = window.__fcTest.callCount('logsRestoreState')
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
      const got = await waitFor(() => window.__fcTest.callCount('logsRestoreState') > before && !$('#undo-bar'), 4000, '输入框里也撤')
      const last = window.__fcTest.calls().filter(c => c.name === 'logsRestoreState').pop() || {}
      return got && ((last.args || [])[0] === 'log-undo-3')
    })(), 'focus=' + ((document.activeElement || {}).tagName || '(none)') + ' bar=' + !!$('#undo-bar'))

    // 反向判据（新规则的另一半）：**没有待撤动作**时，输入框里的 Ctrl+Z 必须还给原生撤销
    check('★★ 反例：没有待撤动作时，输入框里的 Ctrl+Z 不接管（还给原生撤销）', await (async () => {
      if ($('#undo-bar')) return false          // 前提：条子已经没了（上一条刚撤完）
      const ta = $('#log-edit-modal textarea')
      if (!ta) return false
      ta.focus()
      if (document.activeElement !== ta) return false
      const before = window.__fcTest.callCount('logsRestoreState')
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
      await sleep(500)
      return window.__fcTest.callCount('logsRestoreState') === before && !$('#undo-bar')
    })(), 'bar=' + !!$('#undo-bar') + ' focus=' + ((document.activeElement || {}).tagName || '(none)'))
    // 收尾：关掉弹窗（丢弃草稿），别把弹窗留给后面的断言
    {
      const bar = $('#log-edit-modal .relay-discard')
      const cancelBtn = $$('#log-edit-modal .acts button').find(b => (b.textContent || '').trim() === '取消')
      if (cancelBtn) cancelBtn.click()
      await sleep(300)
      const discard = $$('#log-edit-modal .relay-discard button').find(b => (b.textContent || '').indexOf('丢弃') >= 0)
      if (discard) discard.click()
      await sleep(300)
    }
    }

    // ══ 任务详情「关联日志」：完成后原地就有撤销（同一病灶的第二个出口）══════════
    // 用户说的"没有撤销按钮"就发生在这一块：一键「✓ 完成」是无二次确认的，
    // 点错之后**这一行原本只剩一个状态角标**，撤销得跑去日志页翻分区。
    check('任务详情：关联日志行里，已完成的那条给「↩ 撤销」、待处理的那条给「✓ 完成」（对称）', await (async () => {
      window.__fcTest.setLogs([
        { id: 'log-td-1', title: '关联日志·待处理', content: 'x', status: 'active', project: 'demo', created: '2026-10-20T03:00:00.000Z', taskIds: ['task-demo-011'] },
        { id: 'log-td-2', title: '关联日志·已完成', content: 'x', status: 'completed', project: 'demo', created: '2026-10-19T03:00:00.000Z', taskIds: ['task-demo-011'] },
      ])
      clickText('看板'); await sleep(500)
      const card = $$('#board .card').find(c => (c.textContent || '').indexOf('日历密度样例一') >= 0)
      if (!card) return false
      card.click()
      const opened = await waitFor(() => $$('.task-logs-list .task-log-item').length === 2, 5000, '关联日志行')
      if (!opened) return false
      const rows = $$('.task-logs-list .task-log-item')
      const act = (r) => ((r.querySelector('.task-log-done') || {}).textContent || '').trim()
      const byTitle = (t) => rows.find(r => (r.textContent || '').indexOf(t) >= 0)
      return act(byTitle('关联日志·待处理')) === '✓ 完成' && act(byTitle('关联日志·已完成')) === '↩ 撤销'
    })(), JSON.stringify($$('.task-logs-list .task-log-item').map(r => ((r.querySelector('.task-log-done') || {}).textContent || '').trim())))
    check('★ 点行内「↩ 撤销」→ 真调 logsReopen（原地回退，不用去日志页翻卡片）', await (async () => {
      const rows = $$('.task-logs-list .task-log-item')
      const row = rows.find(r => (r.textContent || '').indexOf('关联日志·已完成') >= 0)
      const btn = row && row.querySelector('.task-log-done')
      if (!btn) return false
      const before = window.__fcTest.callCount('logsReopen')
      btn.click()
      const got = await waitFor(() => window.__fcTest.callCount('logsReopen') > before, 4000, '行内 reopen')
      const last = window.__fcTest.calls().filter(c => c.name === 'logsReopen').pop() || {}
      return got && ((last.args || [])[0] === 'log-td-2')
    })(), JSON.stringify((window.__fcTest.calls().filter(c => c.name === 'logsReopen').pop() || {}).args))
    {
      const close = $$('.overlay .acts button').find(b => (b.textContent || '').trim() === '关闭')
      if (close) close.click()
      await sleep(300)
    }

    // ══ 撤销覆盖到「数据改动」类动作（2026-10-21 · 1B 修正版）══════════════════
    // 只解决"刚点错这一下"，不新建全站撤销栈：待办勾选（一行一个 checkbox，最容易手滑）
    // 与决策三态下拉（"已撤销/已合并"挨着）各接一条。判据两条：
    // ①改完当场出现撤销条且写清"哪条 + 原值"；②点撤销 = 真把数据改回原样（不是只弹个提示）。
    window.__fcTest.clearUndo?.()
    window.__fcTest.setTodos([
      { id: 'td-undo-1', title: '撤销样例待办', priority: '中', done: false, created: 1 },
    ])
    clickText('看板'); await sleep(350); clickText('待办'); await sleep(600)
    check('待办勾选 → 当场出现撤销条（写清哪条 + 变成了什么）', await (async () => {
      const it = $$('main.todos-view .todo-item').find((x) => (x.textContent || '').indexOf('撤销样例待办') >= 0)
      const chk = it && it.querySelector('.todo-chk')
      if (!chk) return false
      chk.click()
      return waitFor(() => {
        const b = $('#undo-bar')
        return !!b && /已完成：撤销样例待办/.test((b.textContent || ''))
      }, 4000, '待办撤销条')
    })(), ((($('#undo-bar') || {}).textContent) || '(没有撤销条)').slice(0, 40))
    check('★★ 点撤销 → 待办真的改回未完成（todosUpdate 带 done=false，不是只弹提示）', await (async () => {
      const beforeN = window.__fcTest.callCount('todosUpdate')
      const btn = $('#undo-bar .ub-btn')
      if (!btn) return false
      btn.click()
      const got = await waitFor(() => window.__fcTest.callCount('todosUpdate') > beforeN && !$('#undo-bar'), 4000, '回滚')
      const last = window.__fcTest.calls().filter((c) => c.name === 'todosUpdate').pop() || {}
      const args = last.args || []
      const still = (window.__fcTest.todos().find((t) => t.id === 'td-undo-1') || {}).done
      return got && args[0] === 'td-undo-1' && (args[1] || {}).done === false && still === false
    })(), JSON.stringify((window.__fcTest.calls().filter((c) => c.name === 'todosUpdate').pop() || {}).args))

    // 决策改状态 → 撤销回原状态
    window.__fcTest.clearUndo?.()
    clickText('看板'); await sleep(350); clickText('决策'); await sleep(700)
    check('决策改状态 → 撤销条写清「从什么改成什么」', await (async () => {
      const sel = $('[data-dec="status"]')
      if (!sel) return false
      const prev = sel.value
      sel.value = '已撤销'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return waitFor(() => {
        const t = (($('#undo-bar') || {}).textContent) || ''
        return /已撤销/.test(t) && t.indexOf(prev) >= 0
      }, 4000, '决策撤销条')
    })(), ((($('#undo-bar') || {}).textContent) || '(没有撤销条)').replace(/\s+/g, ' ').slice(0, 60))
    check('★★ 点撤销 → 决策状态改回原值（decisionSetStatus 两次：先改、再撤）', await (async () => {
      const btn = $('#undo-bar .ub-btn')
      if (!btn) return false
      const beforeN = window.__fcTest.callCount('decisionSetStatus')
      btn.click()
      const got = await waitFor(() => window.__fcTest.callCount('decisionSetStatus') > beforeN && !$('#undo-bar'), 4000, '决策回滚')
      const calls = window.__fcTest.calls().filter((c) => c.name === 'decisionSetStatus')
      const first = (calls[calls.length - 2] || {}).args || []
      const last = (calls[calls.length - 1] || {}).args || []
      return got && first[1] === '已撤销' && last[1] === '有效'
    })(), JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'decisionSetStatus').slice(-2).map((c) => c.args)))


    // ══ 日志多选 · 批量优先级（2026-10-09 用户第 4 条「日志多选更智能」）══════
    // 已有多选底座（☑ 多选 + 全选/完成/归档/彻底删除），补的是**批量改优先级**：
    // 改元数据可逆 → 不弹确认、做完不退出多选；非「待处理」后端拒改 → 跳过如实报。
    window.__fcTest.setLogs([
      { id: 'log-bp-1', title: '批量优先级：待处理甲', content: 'x', status: 'active', project: 'demo', created: '2026-10-08T00:00:00.000Z' },
      { id: 'log-bp-2', title: '批量优先级：待处理乙', content: 'x', status: 'active', project: 'demo', created: '2026-10-08T01:00:00.000Z' },
      { id: 'log-bp-3', title: '批量优先级：已完成', content: 'x', status: 'completed', project: 'demo', created: '2026-10-07T00:00:00.000Z' },
      { id: 'log-bp-4', title: '批量优先级：已归档', content: 'x', status: 'archived', project: 'demo', created: '2026-10-06T00:00:00.000Z' },
    ])
    clickText('看板'); await sleep(400); clickText('日志'); await sleep(600)
    const logBatchBtn = () => $$('.logs-view .batch-mode-btn').find(b => (b.textContent || '').indexOf('多选') >= 0)
    check('打开日志多选（批量优先级断言前置）', await (async () => {
      const b = logBatchBtn()
      if (!b) return false
      b.click()
      return waitFor(() => $$('.logs-view .batch-bar').length === 1, 3000, '日志批量栏')
    })())
    check('★ 批量栏六件套（全选/批量优先级/批量完成/批量归档/批量彻底删除/取消）', (() => {
      const t = $$('.logs-view .batch-bar button').map(b => (b.textContent || '').trim())
      return !!$('.logs-view .batch-bar select.batch-prio')
        && ['全选', '批量完成', '批量归档', '批量彻底删除', '取消'].every(x => t.some(y => y.indexOf(x) >= 0))
    })(), $$('.logs-view .batch-bar button').map(b => (b.textContent || '').trim()).join('|'))
    check('  优先级下拉四档（高/中/低/清除）+ 占位「批量优先级…」', (() => {
      const s = $('.logs-view .batch-bar select.batch-prio')
      if (!s) return false
      const opts = Array.prototype.slice.call(s.options).map(o => o.textContent)
      return opts.some(t => t.indexOf('批量优先级') >= 0) && ['高', '中', '低', '清除'].every(x => opts.some(t => t === x))
    })())
    const selAllL = $$('.logs-view .batch-bar button').find(b => (b.textContent || '').trim() === '全选')
    if (selAllL) selAllL.click()
    await sleep(250)
    check('★ 全选吃下当前列表（已选 4：2 待处理 + 1 已完成 + 1 已归档）',
      (($('.logs-view .batch-bar .batch-count') || {}).textContent || '').indexOf('已选 4') >= 0,
      (($('.logs-view .batch-bar .batch-count') || {}).textContent || '(没读到)'))
    const bpCallsBefore = window.__fcTest.callCount('logsUpdate')
    check('★★ 批量优先级「中」→ 每条都送进 logsUpdate（priority=中 × 4）', await (async () => {
      const s = $('.logs-view .batch-bar select.batch-prio')
      if (!s) return false
      s.value = '中'
      s.dispatchEvent(new Event('change', { bubbles: true }))
      const got = await waitFor(() => window.__fcTest.callCount('logsUpdate') >= bpCallsBefore + 4, 4000, 'logsUpdate×4')
      const ups = window.__fcTest.calls().filter(c => c.name === 'logsUpdate')
        .slice(-4).map(c => JSON.stringify(c.args[1]))
      return got && ups.every(u => u.indexOf('"priority":"中"') >= 0)
    })(), 'before=' + bpCallsBefore + ' now=' + window.__fcTest.callCount('logsUpdate'))
    check('★★ 2 条待处理成功、2 条非待处理如实跳过（toast 说 2/4 + 跳过，不静默）',
      await waitFor(() => {
        const t = (($('#toast') || {}).textContent || '')
        return t.indexOf('2/4') >= 0 && t.indexOf('跳过') >= 0
      }, 3000, '跳过 toast'),
      (($('#toast') || {}).textContent || '(没读到 toast)'))
    check('★ 元数据批量不踢人：仍在多选模式、选择保留（可连着调下一批）',
      $$('.logs-view .batch-bar').length === 1
      && (($('.logs-view .batch-bar .batch-count') || {}).textContent || '').indexOf('已选 4') >= 0,
      (($('.logs-view .batch-bar .batch-count') || {}).textContent || '(没读到)'))
    check('  下拉用完即复位（占位重新可见，不是停在「中」）', (() => {
      const s = $('.logs-view .batch-bar select.batch-prio')
      return !!s && s.value === ''
    })())
    const exitL = $$('.logs-view .batch-bar button').find(b => (b.textContent || '').trim() === '取消')
    if (exitL) exitL.click()
    check('取消退出多选（批量栏收起）', await waitFor(() => $$('.logs-view .batch-bar').length === 0, 3000, '退出多选'))

    // ══ 主日志 + 附属日志（2026-10-30 暮雨第 4 条）════════════════════════
    // 用户原话：「我要的就是一篇主日志带若干附属日志，一起绑定，一键全进行中，一键全完成，
    // 有那么难吗？而且你搞得还要点多选才出来，那么隐蔽。」
    // 所以这一块钉的不是"有复制按钮"，而是：
    //   ① 绑定在主日志**卡上**（不是藏在多选栏）；② 关系落盘（logsSetAttached）；
    //   ③ 全组进行中 / 全组完成各一次调用；④ 开工单按 [主, 副...] 顺序灌。
    {
      const btns = (root) => root ? Array.prototype.slice.call(root.querySelectorAll('button')) : []
      window.__fcTest.setLogs([
        { id: 'log-multi-a', title: '主日志：这一轮做了什么', content: 'MAIN-A', status: 'active', project: 'demo', created: '2026-10-29T01:00:00.000Z' },
        { id: 'log-multi-b', title: '副日志：并行通道进度', content: 'SIDE-B', status: 'active', project: 'demo', created: '2026-10-29T02:00:00.000Z' },
      ])
      clickText('看板'); await sleep(350); clickText('日志'); await sleep(600)
      const cardsM = $$('.logs-view .log-card')
      const mainCard = $('.logs-view .log-card[data-log-id="log-multi-a"]')
      const sideCard = $('.logs-view .log-card[data-log-id="log-multi-b"]')
      check('  夹具里主/副两条日志都在', !!mainCard && !!sideCard)
      const bindBtn = mainCard && btns(mainCard).find(b => (b.textContent || '').indexOf('绑定附属') >= 0)
      check('★★ 绑定入口在**主日志卡上**（不用先点多选）', !!bindBtn,
        mainCard ? btns(mainCard).map(b => (b.textContent || '').trim()).join('|') : 'no main card')
      window.__fcTest.reset()
      if (bindBtn) bindBtn.click()
      const picker = await waitFor(() => !!$('#log-attach-modal'), 3000, '绑定弹窗')
      check('★★ 点它打开绑定弹窗（候选是真日志）', !!picker && $$('#log-attach-modal .la-row').length >= 1,
        String($$('#log-attach-modal .la-row').length))
      const sideRow = $$('#log-attach-modal .la-row').find(r => (r.textContent || '').indexOf('副日志：并行通道进度') >= 0)
      if (sideRow) {
        const cb = sideRow.querySelector('input[type=checkbox]')
        if (cb) cb.click()
      }
      await sleep(150)
      const saveBind = $$('#log-attach-modal button').find(b => (b.textContent || '').indexOf('保存绑定') >= 0)
      if (saveBind) saveBind.click()
      check('★★ 保存绑定真走 logsSetAttached（关系落盘，不是只在界面上挂着）',
        await waitFor(() => window.__fcTest.callCount('logsSetAttached') > 0, 4000, 'logsSetAttached'),
        JSON.stringify(window.__fcTest.calls().map(c => c.name)))
      check('★ 传给主进程的是 [主日志自己, 副日志] 的落盘关系', (() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'logsSetAttached').pop()
        return !!c && c.args[0] === 'log-multi-a' && Array.isArray(c.args[1]) && c.args[1][0] === 'log-multi-b'
      })(), JSON.stringify((window.__fcTest.calls().filter(x => x.name === 'logsSetAttached').pop() || {}).args))
      await sleep(500)
      const mainCard2 = $('.logs-view .log-card[data-log-id="log-multi-a"]')
      check('★★ 主日志卡上标出「主日志 · 附属 1」', !!mainCard2 && (mainCard2.textContent || '').indexOf('主日志 · 附属 1') >= 0,
        mainCard2 ? (mainCard2.textContent || '').slice(0, 120) : 'no card')
      check('★ 主日志卡内列出附属那条（点得到，不用去别的分区翻）',
        !!mainCard2 && (mainCard2.textContent || '').indexOf('副日志：并行通道进度') >= 0)
      check('★★ 卡上有「全组进行中 / 全组完成 / 开工单」三个出口', !!mainCard2 && (() => {
        const t = btns(mainCard2).map(b => (b.textContent || '').trim()).join('|')
        return t.indexOf('全组进行中') >= 0 && t.indexOf('全组完成') >= 0 && t.indexOf('开工单') >= 0
      })(), mainCard2 ? btns(mainCard2).map(b => (b.textContent || '').trim()).join('|') : 'no card')
      check('★ 多选栏里不再藏一个「开工单」（语义已经移到卡上）',
        !$$('.logs-view .batch-bar button').some(b => (b.textContent || '').indexOf('开工单') >= 0))

      window.__fcTest.reset()
      const groupRun = mainCard2 && btns(mainCard2).find(b => (b.textContent || '').indexOf('全组进行中') >= 0)
      if (groupRun) groupRun.click()
      check('★★ 一键「全组进行中」真走 logsGroupRunning（不是逐条点）',
        await waitFor(() => window.__fcTest.callCount('logsGroupRunning') > 0, 3000, 'logsGroupRunning'),
        JSON.stringify(window.__fcTest.calls().map(c => c.name)))
      check('★ 传的是主日志 id + running=true', (() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'logsGroupRunning').pop()
        return !!c && c.args[0] === 'log-multi-a' && c.args[1] === true
      })(), JSON.stringify((window.__fcTest.calls().filter(x => x.name === 'logsGroupRunning').pop() || {}).args))
      await sleep(400)
      const mainCard3 = $('.logs-view .log-card[data-log-id="log-multi-a"]')
      const groupDone = mainCard3 && btns(mainCard3).find(b => (b.textContent || '').indexOf('全组完成') >= 0)
      if (groupDone) groupDone.click()
      check('★★ 一键「全组完成」真走 logsGroupComplete', await waitFor(() => window.__fcTest.callCount('logsGroupComplete') > 0, 3000, 'logsGroupComplete'),
        JSON.stringify(window.__fcTest.calls().map(c => c.name)))
      await sleep(400)
      const mainCard4 = $('.logs-view .log-card[data-log-id="log-multi-a"]')
      const promptBtn = mainCard4 && btns(mainCard4).find(b => (b.textContent || '').indexOf('开工单') >= 0)
      window.__fcTest.reset()
      if (promptBtn) promptBtn.click()
      check('★★ 卡上的「开工单」把主 + 附属一次灌进去（顺序：主日志在前）',
        await waitFor(() => window.__fcTest.calls().some(c => c.name === 'logsInjectMany'), 4000, 'logsInjectMany'),
        JSON.stringify(window.__fcTest.calls().map(c => c.name)))
      check('★ 传入 id 顺序 = [主日志, 副日志]（不再靠勾选顺序）', (() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'logsInjectMany').pop()
        const ids = (c && c.args && c.args[0]) || []
        return Array.isArray(ids) && ids[0] === 'log-multi-a' && ids[1] === 'log-multi-b'
      })(), JSON.stringify((window.__fcTest.calls().filter(x => x.name === 'logsInjectMany').pop() || {}).args))
    }

    // ══ 多级撤销 + 误点「通过」（2026-10-30 暮雨第 5 条）══════════════════
    // 现场：误点了通过（卡变完成），想改驳回；狂按 Ctrl+Z 一点用都没有 ——
    // 因为 acceptTask 根本没登记撤销，条子上挂的是更早的旧动作。
    {
      window.__fcTest.clearUndo?.()
      const savedTasks = window.__fcTest.tasks()
      const st = { status: '待验收', priority: '中', project: 'demo', tags: [], body: '' }
      window.__fcTest.setTasks([
        { id: 'task-undo-pass', title: '误点通过的卡', ...st, created: '2026-10-30T00:00:00.000Z',
          fm: { id: 'task-undo-pass', title: '误点通过的卡', ...st }, path: 'C:/mock/task-data/task-undo-pass.md' },
      ])
      clickText('看板'); await sleep(450)
      const card = $$('#board .card').find((c) => (c.textContent || '').indexOf('误点通过的卡') >= 0)
      check('  夹具：待验收卡在板上', !!card)
      if (card) card.click()
      await waitFor(() => !!$('#roverlay'), 3000, '任务详情')
      const reviewBtn = $$('#roverlay button').find((b) => (b.textContent || '').indexOf('验收裁决') >= 0)
      check('★★ 待验收卡有「验收裁决」入口', !!reviewBtn)
      if (reviewBtn) reviewBtn.click()
      await waitFor(() => !!$('#review-modal'), 3000, '裁决弹窗')
      check('★★ 驳回理由改为可选（弹窗里不再写"必填"、且有常用理由）',
        (($('#review-modal') || {}).textContent || '').indexOf('可选') >= 0
        && $$('#review-modal .review-presets .rp').length >= 3,
        (($('#review-modal') || {}).textContent || '').slice(0, 120))
      window.__fcTest.reset()
      const passBtn = $('#review-modal .acts .ok')
      if (passBtn) passBtn.click()
      check('  前置：通过真走 reviewAccept', await waitFor(() => window.__fcTest.callCount('reviewAccept') > 0, 4000, 'reviewAccept'))
      const bar = await waitFor(() => !!$('#undo-bar'), 4000, '通过后的撤销条')
      check('★★ 误点「通过」后当场出现撤销条（写清哪张卡）',
        !!bar && (($('#undo-bar') || {}).textContent || '').indexOf('误点通过的卡') >= 0,
        (($('#undo-bar') || {}).textContent || '').slice(0, 80))
      const undoBtn = $('#undo-bar .ub-btn')
      if (undoBtn) undoBtn.click()
      check('★★ 点撤销 → 任务回到「待验收」（不是只弹提示、也不是退回待办）', await waitFor(() => {
        const e = window.__fcTest.calls().filter((c) => c.name === 'editTask').pop()
        return !!e && e.args[0] === 'task-undo-pass' && e.args[1] && e.args[1].status === '待验收'
      }, 4000, 'editTask restore'), JSON.stringify((window.__fcTest.calls().filter((c) => c.name === 'editTask').pop() || {}).args))
      await sleep(300)
      window.__fcTest.setTasks(savedTasks)
      window.__fcTest.clearUndo?.()
    }

    // 多级栈：两笔动作 → 条上写「共 2 步」→ Ctrl+Z 一笔一笔往回走
    {
      window.__fcTest.clearUndo?.()
      window.__fcTest.setLogs([
        { id: 'log-multiundo-a', title: '多级撤销甲', content: '', status: 'active', project: 'demo', created: '2026-10-30T02:00:00.000Z' },
        { id: 'log-multiundo-b', title: '多级撤销乙', content: '', status: 'active', project: 'demo', created: '2026-10-30T02:01:00.000Z' },
      ])
      clickText('看板'); await sleep(250); clickText('日志'); await sleep(600)
      const cardBtn = (title, label) => {
        const c = $$('.log-card').find((x) => (x.textContent || '').indexOf(title) >= 0)
        return c && Array.prototype.slice.call(c.querySelectorAll('.log-card-actions button')).find((b) => (b.textContent || '').indexOf(label) >= 0)
      }
      const runA = cardBtn('多级撤销甲', '标为进行中')
      if (runA) runA.click()
      await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'logsSetRunning' && c.args[0] === 'log-multiundo-a' && c.args[1] === true), 3000, 'A running')
      const runB = cardBtn('多级撤销乙', '标为进行中')
      if (runB) runB.click()
      await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'logsSetRunning' && c.args[0] === 'log-multiundo-b' && c.args[1] === true), 3000, 'B running')
      await sleep(300)
      check('★★ 两笔动作都在栈里（条上写「共 2 步」，不是只记上一笔）',
        (($('#undo-bar') || {}).textContent || '').indexOf('共 2 步') >= 0,
        (($('#undo-bar') || {}).textContent || '').slice(0, 80))
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
      check('★ Ctrl+Z 第一次：撤掉最近那笔（乙）',
        await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'logsSetRunning' && c.args[0] === 'log-multiundo-b' && c.args[1] === false), 3000, 'undo B'),
        JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'logsSetRunning').slice(-3).map((c) => c.args)))
      check('★ 再按一次 Ctrl+Z：继续撤更早那笔（甲）—— 不是「一次就没了」',
        await (async () => {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
          return waitFor(() => window.__fcTest.calls().some((c) => c.name === 'logsSetRunning' && c.args[0] === 'log-multiundo-a' && c.args[1] === false), 3000, 'undo A')
        })(), JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'logsSetRunning').slice(-3).map((c) => c.args)))
      await sleep(250)
      check('★ 栈清空后撤销条消失', !$('#undo-bar'), (($('#undo-bar') || {}).textContent || '').slice(0, 60))
    }

    // ══ 日志的搜索 / 排序写回父组件（2026-10-23 补 · 第 11 块拆分后新增）
    //  为什么单列这一块：这两个控件都是 `v-model` 写在**子组件**里、状态真身在父组件。
    //  拆分时若把 `toRef` 写成直接解构（拿到快照），界面看着完全正常（能打字、能选），
    //  但值永远回不到父组件：搜索词进不了 IPC、排序永远按默认 —— 用户只会说"搜了没反应"。
    //  桩 logsList 现在会记账 + 真按 filter 过滤，这条才验得出来。
    {
      window.__fcTest.setLogs([
        { id: 'log-s1', title: '搜索断言：甲方案', content: 'x', status: 'active', project: 'demo', created: '2026-10-01T00:00:00.000Z' },
        { id: 'log-s2', title: '搜索断言：乙方案', content: 'x', status: 'active', project: 'demo', created: '2026-10-05T00:00:00.000Z' },
        { id: 'log-s3', title: '搜索断言：丙方案', content: 'x', status: 'active', project: 'demo', created: '2026-10-03T00:00:00.000Z' },
      ])
      clickText('看板'); await sleep(300); clickText('日志'); await sleep(600)
      const cardCount = () => $$('.logs-view .log-card').length
      const firstTitle = () => (($('.logs-view .log-card .log-card-title') || {}).textContent || '')
      check('  三张日志卡就位（搜索/排序断言前置）', cardCount() === 3, 'cards=' + cardCount())

      // ① 排序：改成「最早创建在前」→ 首条必须是 10-01 那张
      const sortSel = $$('.logs-view select.log-filter')[1]
      check('  日志页有排序下拉', !!sortSel, 'selects=' + $$('.logs-view select.log-filter').length)
      if (sortSel) {
        sortSel.value = 'created_asc'
        sortSel.dispatchEvent(new Event('change', { bubbles: true }))
      }
      check('★★ 排序下拉写回父组件（改成「最早创建在前」→ 首条变最早那张）',
        await waitFor(() => firstTitle().indexOf('甲方案') >= 0, 3000, 'sort asc'),
        'first=' + firstTitle())

      // ② 搜索：输入 → 300ms 防抖 → 真落到 IPC 的 filter.query 上 + 列表真被过滤
      const box = $('.logs-view input.log-search')
      check('  日志页有搜索框', !!box)
      if (box) {
        box.value = '乙方案'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const qHit = await waitFor(() => {
        const cs = window.__fcTest.calls().filter((c) => c.name === 'logsList')
        const last = cs[cs.length - 1]
        return !!last && !!last.args[0] && last.args[0].query === '乙方案'
      }, 4000, 'logsList(query)')
      check('★★ 搜索词写回父组件（真进了 IPC 的 filter.query，不是只改了输入框）', qHit,
        JSON.stringify((window.__fcTest.calls().filter((c) => c.name === 'logsList').pop() || {}).args))
      check('★★ 搜索真过滤列表（只剩命中的那一张）',
        await waitFor(() => cardCount() === 1 && firstTitle().indexOf('乙方案') >= 0, 3000, 'search filtered'),
        'cards=' + cardCount() + ' first=' + firstTitle())

      // 收尾：清空搜索 + 排序复位、并按默认序重新加载（后面的日志断言要用完整夹具）
      if (box) { box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })) }
      check('  清空搜索后列表复原（否则后面的日志断言只剩 1 条卡）',
        await waitFor(() => cardCount() === 3, 3000, '搜索已清空'), 'cards=' + cardCount())
      if (sortSel) { sortSel.value = 'created_desc'; sortSel.dispatchEvent(new Event('change', { bubbles: true })) }
      await sleep(400)
    }

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
    // 方向一：日志 → 待办（2026-10-09 起先开转换确认框 —— 源怎么办是勾选项）
    const convCreateBefore = window.__fcTest.callCount('todosCreate')
    const convConfirmBtn = () => $$('#conv-modal .acts button').find(x => (x.textContent || '').trim() === '转换')
    const convLogBtn = $$('.log-card-actions button').find(b => (b.textContent || '').indexOf('转待办') >= 0)
    check('★★ 日志卡上有「⤴ 转待办」入口', !!convLogBtn,
      JSON.stringify($$('.log-card-actions button').map(b => (b.textContent || '').trim())))
    if (convLogBtn) convLogBtn.click()
    check('★★ 点「转待办」先开转换确认框：源怎么办说得清（2026-10-09 用户第 1 条）', await (async () => {
      if (!(await waitFor(() => !!$('#conv-modal'), 3000, 'conv 框'))) return false
      const txt = (($('#conv-modal') || {}).textContent || '')
      return txt.indexOf('日志 → 待办') >= 0 && txt.indexOf('不勾 = 源原样保留') >= 0
    })())
    check('★ 归档源勾选项**默认不勾**（卡 004「源保留」铁律 —— 反向判据：默认不动源）', (() => {
      const c = $('#conv-modal .conv-opt input')
      return !!c && c.checked === false
    })())
    check('★ 点「取消」零副作用（关框，一条都没建）', await (async () => {
      const b = $$('#conv-modal .acts button').find(x => (x.textContent || '').trim() === '取消')
      if (!b) return false
      b.click()
      const closed = await waitFor(() => !$('#conv-modal'), 2000, '关 conv 框')
      return closed && window.__fcTest.callCount('todosCreate') === convCreateBefore
    })())
    // 重开并确认转换
    const convLogBtn1b = $$('.log-card-actions button').find(b2 => (b2.textContent || '').indexOf('转待办') >= 0)
    if (convLogBtn1b) convLogBtn1b.click()
    check('  确认框重开', await waitFor(() => !!$('#conv-modal'), 3000, 'conv 重开'))
    const convGo1 = convConfirmBtn()
    if (convGo1) convGo1.click()
    // ⚠ 这条判据在 2026-10-11 改过 —— 而且它**原本把 bug 当成了规格**：
    //   旧版断言 `a[0] === '补一个失败重试'`（**整段内容 === 一行**），恰好锁死了
    //   "只搬一行、正文全丢"那个丢东西的行为（用户实测「内容全丢，变成空待办」）。
    //   现在待办的「内容」= 摘要首行 + 来源行 + 正文 + 下一步全文，
    //   所以判据改成「**首行**是那条下一步」+ 其它字段照旧。
    check('★★ 日志→待办：真调 todosCreate（首行=下一步首条 + 正文也带过来 + priority/project/fromLog 跟着走）',
      await waitFor(() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'todosCreate')
        if (!c.length) return false
        const a = c[c.length - 1].args || []
        const lines = String(a[0] || '').split('\n')
        return lines[0] === '补一个失败重试'
          && String(a[0]).indexOf('查了鉴权中间件') >= 0   // 正文必须带过来（这是这次修的那个 bug）
          && a[1] === '高' && a[3] === 'demo' && a[4] === 'log-conv-1'
      }, 4000, 'todosCreate 反转'),
      JSON.stringify((window.__fcTest.calls().filter(x => x.name === 'todosCreate').pop() || {}).args))
    check('★ 日志→待办后**源日志还在**（默认不归档，卡 004 铁律）',
      $$('.log-card').length >= 1
      && $$('.log-card').some(c => (c.textContent || '').indexOf('排查登录失败') >= 0),
      'logCards=' + $$('.log-card').length)
    // 防重：再走一遍确认框，转换必须被拦（store 里已有 fromLog=log-conv-1 的待办）
    const convLogBtn2 = $$('.log-card-actions button').find(b3 => (b3.textContent || '').indexOf('转待办') >= 0)
    const beforeDup = window.__fcTest.callCount('todosCreate')
    if (convLogBtn2) convLogBtn2.click()
    if (await waitFor(() => !!$('#conv-modal'), 3000, '防重 conv 框')) {
      const goDup = convConfirmBtn()
      if (goDup) goDup.click()
    }
    await sleep(600)
    check('★★ 防重：同一条日志再转被拦下（todosCreate 调用数不增）',
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
    check('  待办侧同一套确认框（标题=待办 → 日志，勾选项说「标已转出」）', await (async () => {
      if (!(await waitFor(() => !!$('#conv-modal'), 3000, 'conv todo2log'))) return false
      const txt = (($('#conv-modal') || {}).textContent || '')
      return txt.indexOf('待办 → 日志') >= 0 && txt.indexOf('标「已转出」') >= 0
    })())
    const convGo2 = $$('#conv-modal .acts button').find(x => (x.textContent || '').trim() === '转换')
    if (convGo2) convGo2.click()
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
    // 防重（反向）——同样要穿过确认框
    const convTodoBtn2 = $$('.todo-acts .todo-conv')[0]
    const beforeDup2 = window.__fcTest.callCount('logsCreate')
    if (convTodoBtn2) convTodoBtn2.click()
    if (await waitFor(() => !!$('#conv-modal'), 3000, '防重 conv 框 2')) {
      const goDup2 = $$('#conv-modal .acts button').find(x => (x.textContent || '').trim() === '转换')
      if (goDup2) goDup2.click()
    }
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

    // ── 勾选路径：顺手归档源（2026-10-09 用户第 1 条的勾选项，两个方向都验真）──
    window.__fcTest.setLogs([
      { id: 'log-arch-1', title: '转换归档源：日志甲', content: 'x', nextSteps: '- [ ] 归档源这条待办',
        status: 'active', project: 'demo', created: '2026-10-09T00:00:00.000Z' },
    ])
    window.__fcTest.setTodos([
      { id: 'todo-fold-1', title: '折叠源待办：转出后默认藏起来', done: false, priority: '中', project: 'demo',
        createdAt: '2026-10-09T01:00:00.000Z', updatedAt: '2026-10-09T01:00:00.000Z' },
    ])
    clickText('看板'); await sleep(400); clickText('日志'); await sleep(600)
    const convLogBtnA = $$('.log-card-actions button').find(b4 => (b4.textContent || '').indexOf('转待办') >= 0)
    if (convLogBtnA) convLogBtnA.click()
    check('★★ 勾「顺手归档源」→ 转换后源日志真归档（logsArchive 带对 id）', await (async () => {
      if (!(await waitFor(() => !!$('#conv-modal'), 3000, 'conv 勾选路径'))) return false
      const cb = $('#conv-modal .conv-opt input')
      if (!cb) return false
      cb.click()
      await sleep(150)
      const go = $$('#conv-modal .acts button').find(x => (x.textContent || '').trim() === '转换')
      if (!go) return false
      go.click()
      const got = await waitFor(() => window.__fcTest.callCount('logsArchive') >= 1, 4000, 'logsArchive')
      const last = window.__fcTest.calls().filter(c => c.name === 'logsArchive').pop()
      return got && !!last && last.args[0] === 'log-arch-1'
    })())
    check('  toast 说清源去哪了（「已归档…可找回」，不是静默动源）', await waitFor(() => {
      const t = (($('#toast') || {}).textContent || '')
      return t.indexOf('已归档') >= 0 && t.indexOf('可找回') >= 0
    }, 3000, '归档 toast'), (($('#toast') || {}).textContent || '(没读到)'))
    check('  源日志卡进「已归档」分区（.archived 类，不是从列表里蒸发）', await (async () => {
      await sleep(300)
      return $$('.log-card').some(c =>
        (c.textContent || '').indexOf('转换归档源：日志甲') >= 0 && c.classList.contains('archived'))
    })())
    // 待办侧：勾「标已转出」→ 折叠 + 徽章 + 可撤销
    clickText('看板'); await sleep(400); clickText('待办'); await sleep(600)
    const convTodoBtnA = $$('.todo-acts .todo-conv')[0]
    if (convTodoBtnA) convTodoBtnA.click()
    check('★★ 勾「标已转出」→ 源待办记 converted=目标日志 id（todosUpdate 真调）', await (async () => {
      if (!(await waitFor(() => !!$('#conv-modal'), 3000, 'conv 折叠路径'))) return false
      const cb = $('#conv-modal .conv-opt input')
      if (!cb) return false
      cb.click()
      await sleep(150)
      const go = $$('#conv-modal .acts button').find(x => (x.textContent || '').trim() === '转换')
      if (!go) return false
      go.click()
      return waitFor(() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'todosUpdate')
        if (!c.length) return false
        const a = c[c.length - 1].args || []
        return a[0] === 'todo-fold-1' && !!a[1] && typeof a[1].converted === 'string' && a[1].converted.length > 0
      }, 4000, 'todosUpdate converted')
    })())
    check('★★ 转出后源待办默认折叠：列表看不到它 + 尾部出现「已转出 1 条 · 展开」（反向：折叠≠删除）', await (async () => {
      const gone = await waitFor(() =>
        !$$('.todos-view .todo-item').some(x => (x.textContent || '').indexOf('折叠源待办') >= 0),
        3000, '折叠隐藏')
      const fold = $$('.todos-view .todos-converted-fold button')
        .find(b5 => (b5.textContent || '').indexOf('已转出 1 条') >= 0)
      return gone && !!fold
    })())
    check('★ 展开后看得到源 + 「⤴ 已转出」徽章（藏起来 ≠ 找不回）', await (async () => {
      const foldBtn = $$('.todos-view .todos-converted-fold button')
        .find(b5 => (b5.textContent || '').indexOf('已转出 1 条') >= 0)
      if (!foldBtn) return false
      foldBtn.click()
      return waitFor(() => {
        const it = $$('.todos-view .todo-item')
          .find(x => (x.textContent || '').indexOf('折叠源待办') >= 0)
        return !!it && (it.textContent || '').indexOf('已转出') >= 0
      }, 3000, '展开可见')
    })())
    let undoDiag = ''
    check('★★ 一键撤销：↩ 清掉 converted、源回常规列表（折叠完全可逆 —— 不是删除）', await (async () => {
      const it = $$('.todos-view .todo-item')
        .find(x => (x.textContent || '').indexOf('折叠源待办') >= 0)
      const undo = it ? it.querySelector('.todo-conv-undo') : null
      undoDiag = 'it=' + !!it + ' undo=' + !!undo + (it ? ' html=' + it.outerHTML.replace(/\s+/g, ' ').slice(0, 400) : '')
      if (!undo) return false
      undo.click()
      const got = await waitFor(() => {
        const c = window.__fcTest.calls().filter(x => x.name === 'todosUpdate')
        const last = c[c.length - 1]
        return !!last && !!last.args[1] && last.args[1].converted === ''
      }, 3000, 'undo converted')
      const lastUpd = window.__fcTest.calls().filter(x => x.name === 'todosUpdate').pop()
      undoDiag += ' got=' + got + ' lastUpd=' + JSON.stringify((lastUpd || {}).args)
      // ⚠ 拿到调用记录 ≠ 界面刷完：loadTodos + Vue 重渲染是异步的，必须等折叠条真收起
      const cleared = await waitFor(() => $$('.todos-view .todos-converted-fold').length === 0, 3000, '折叠条收起')
      undoDiag += ' cleared=' + cleared
      return got && cleared
        && $$('.todos-view .todo-item').some(x => (x.textContent || '').indexOf('折叠源待办') >= 0)
    })(), undoDiag)

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

    // ══ 回收站 · 按日期清理（2026-10-17 暮雨第 2 条：「我想选择特定日期，删除此之前的所有内容」）══
    // 判据：预览必须**按日期算**（不是把全部算命中），确认后**只删命中那批**（不是清空）。
    {
      const ago = (n) => new Date(Date.now() - n * 86400000).toISOString()
      window.__fcTest.setTrash([
        { name: 'old-1.md', id: 'old-1', title: '很老的甲', status: '待办', project: '', bytes: 100, mtime: ago(100) },
        { name: 'old-2.md', id: 'old-2', title: '很老的乙', status: '完成', project: '', bytes: 100, mtime: ago(60) },
        { name: 'new-1.md', id: 'new-1', title: '很新的丙', status: '待办', project: '', bytes: 100, mtime: ago(2) },
      ])
      clickText('看板'); await sleep(300); clickText('回收站'); await sleep(600)
      const openBtn = $$('.trash-view button').find((b) => (b.textContent || '').indexOf('按日期清理') >= 0)
      check('★ 回收站有「按日期清理」入口', !!openBtn)
      if (openBtn) openBtn.click()
      check('  点开 → 弹窗真的出现（有底有框，不是裸块）',
        await waitFor(() => !!$('#trash-purge-modal'), 3000, 'purge modal'))
      const mBtn = (t) => $$('#trash-purge-modal button').find((b) => (b.textContent || '').trim() === t)
      // 90 天前：只有「100 天前」那条命中；60 天与 2 天那两条不该被算进来
      const b90 = mBtn('90 天前')
      if (b90) b90.click()
      await sleep(150)
      const pv = mBtn('预览命中')
      if (pv) pv.click()
      check('★★ 预览按日期算命中（90 天前 → 只剩 100 天那条，1 项）',
        await waitFor(() => (($('.lpurge-preview') || {}).textContent || '').indexOf('将彻底删除 1 项') >= 0, 3000, 'purge preview'),
        (($('.lpurge-preview') || {}).textContent || '').slice(0, 60))
      const okBtn = mBtn('确认彻底删除')
      check('  确认按钮在预览后才可用', !!okBtn && !okBtn.disabled)
      if (okBtn) okBtn.click()
      check('★★ 确认后只删命中那条（trashPurge 的 name = old-1.md）',
        await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'trashPurge' && (c.args || [])[0] === 'old-1.md'), 4000, 'purge old-1'),
        JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'trashPurge').map((c) => (c.args || [])[0])))
      await sleep(500)
      check('  没命中的两条还在（按日期删 ≠ 清空回收站）',
        $$('.trash-view .trash-item').length === 2, 'left=' + $$('.trash-view .trash-item').length)
    }

    // ══ 回收站 · 点卡片看正文预览（2026-10-23 补：此前这条**零断言**）══════════
    // 这块是用户原话逼出来的：「每个卡片都是不能点的死卡，确认这是设计意图？我可没想要这个」。
    // 桩 `trashRead` 一直有、`rec` 也一直在记 —— 但**没有任何断言点过卡片**，
    // 于是"点了没反应""读不出正文""markdown 没渲染"三种坏法都不会被发现。
    {
      window.__fcTest.setTrash([
        { name: 'pv-1.md', id: 'pv-1', title: '预览用甲', status: '待办', project: 'demo', bytes: 777, mtime: '2026-09-20T00:00:00.000Z' },
        { name: 'pv-2.2.md', id: 'pv-2', title: '预览用乙', status: '完成', project: '', bytes: 100, mtime: '2026-09-19T00:00:00.000Z' },
      ])
      clickText('看板'); await sleep(300); clickText('回收站'); await sleep(600)
      check('前置：两张卡都在（否则下一条会在空列表上假绿）',
        await waitFor(() => $$('.trash-view .trash-item').length === 2, 3000, '2 张卡'),
        'n=' + $$('.trash-view .trash-item').length)
      const nRead = window.__fcTest.callCount('trashRead')
      const cardMain = $('.trash-view .trash-item .trash-main')
      if (cardMain) cardMain.click()
      check('★ 点卡片 → 真去读正文（trashRead 被调用）',
        await waitFor(() => window.__fcTest.callCount('trashRead') > nRead, 3000, 'trashRead'),
        'calls=' + window.__fcTest.callCount('trashRead'))
      const readArgs = (window.__fcTest.calls().filter((c) => c.name === 'trashRead').pop() || {}).args || []
      check('★★ 传的是**文件名**不是 id（同一 id 可能有多份历史副本 x.md / x.2.md）',
        readArgs[0] === 'pv-1.md', JSON.stringify(readArgs))
      check('★ 预览弹窗出现', await waitFor(() => !!$('#trash-preview-modal'), 3000, 'preview modal'))
      const pvText = (($('#trash-preview-modal') || {}).textContent || '').replace(/\s+/g, ' ')
      check('  弹窗里写明文件名 / 大小 / 项目（删之前要能认出来是哪份）',
        pvText.indexOf('pv-1.md') >= 0 && pvText.indexOf('777') >= 0 && pvText.indexOf('demo') >= 0,
        pvText.slice(0, 90))
      check('★★ 正文按 markdown 渲染成 HTML（桩返回 "# 预览用甲" → 真出 h1，不是一段纯文本）',
        !!$('#trash-preview-modal .trash-preview-text h1'),
        (($('#trash-preview-modal .trash-preview-text') || {}).innerHTML || '').slice(0, 70))
      // 遮罩关闭：.overlay 用 @mousedown.self → 派发 mousedown 到遮罩本体
      const pvOpened = !!$('#trash-preview-modal')
      const ovPv = $('#trash-preview-overlay')
      if (ovPv) ovPv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      // ⚠ 必须要求「先前真的打开过」：否则弹窗根本没开时 `!$('#trash-preview-modal')` 恒真 → 假绿
      check('★ 点遮罩关掉预览（遮罩用 @mousedown.self，不是 @click.self）',
        pvOpened && await waitFor(() => !$('#trash-preview-modal'), 3000, 'preview closed'),
        'opened=' + pvOpened)
    }

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
    // 关预览（overlay 自身 @mousedown.self —— 2026-10-11 起遮罩手势改用 mousedown）
    maskClick('#roverlay')
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
    check('能切到「技能」页签', await openViewTab('技能'))
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
    // ── MCP 接入材料区（2026-10-23 补：这块此前**一条断言都没有**）────────────
    // 为什么会漏：假 preload 里连 `mcpInfo` 都没有 → `typeof t.mcpInfo !== 'function'` 恒真 →
    // 这一区在任何测试里都是空的。拆组件时把它搬坏了也不会有人知道。
    const mcpBox = $('.skills-view .mcp-connect')
    check('★ MCP 接入区渲染出来（不是停在「检测中…」）', !!mcpBox
      && !mcpBox.querySelector('.skills-agent'), mcpBox ? (mcpBox.textContent || '').slice(0, 40) : '(没有 .mcp-connect)')
    const mcpRows = mcpBox ? Array.prototype.slice.call(mcpBox.querySelectorAll('.agent-row')) : []
    check('★ MCP 区按本机检测结果列目标（检测到的 + 没检测到的都在，没检测到的标灰）',
      mcpRows.length === 2 && mcpRows.some((r) => r.className.indexOf('agent-off') >= 0),
      'rows=' + mcpRows.length)
    const entryBtns = mcpBox ? Array.prototype.slice.call(mcpBox.querySelectorAll('.mcp-entry-pick button')) : []
    check('★★ 入口切换按可用性禁用（B 不可用就是 disabled，不做成"点了没反应"的死按钮）',
      entryBtns.length === 2 && !!entryBtns.find((b) => b.disabled === true)
      && !!entryBtns.find((b) => b.disabled === false),
      JSON.stringify(entryBtns.map((b) => ({ t: (b.textContent || '').trim(), d: b.disabled }))))
    const hermesMcp = mcpRows.find((r) => (((r.querySelector('.agent-name') || {}).textContent) || '') === 'Hermes')
    const snippetBtn = hermesMcp
      ? Array.prototype.slice.call(hermesMcp.querySelectorAll('button')).find((b) => (b.textContent || '').indexOf('复制配置段') >= 0)
      : null
    check('★ Hermes 行有「📋 复制配置段」', !!snippetBtn)
    if (snippetBtn) {
      snippetBtn.click()
      check('★★ 点「复制配置段」真调 mcpSnippet(hermes, A) 并把配置段写进剪贴板',
        await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'mcpSnippet'
          && c.args && c.args[0] === 'hermes' && c.args[1] === 'A'), 4000, 'mcpSnippet')
        && window.__fcTest.calls().some((c) => c.name === 'clipboardWriteText'
          && String((c.args || [])[0] || '').indexOf('mcp_servers.fangcun') >= 0),
        JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'mcpSnippet' || c.name === 'clipboardWriteText').map((c) => c.name)))
    }
    const selfBtn = hermesMcp
      ? Array.prototype.slice.call(hermesMcp.querySelectorAll('button')).find((b) => (b.textContent || '').indexOf('让它自装') >= 0)
      : null
    check('★ Hermes 行有「🤖 让它自装」', !!selfBtn)
    if (selfBtn) {
      selfBtn.click()
      check('★ 点「让它自装」真调 mcpSelfInstall（方寸只出材料、不写别人的配置）',
        await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'mcpSelfInstall'), 4000, 'mcpSelfInstall'),
        JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'mcpSelfInstall').map((c) => c.args)))
    }

    await sleep(300)

    // ══ 设置页 · 侧边栏分类（2026-10-03 用户：设置项不要挤在一条长名单里）══════
    // 2026-10-12「看与做分两层」后，设置图标从 #bar 搬到了页签行右端 ——
    // 判据改成**全页找**（不绑定容器）：这条守的是「有设置入口」，不是「它在哪个容器里」。
    const gear = $$('button').find((b) => (b.textContent || '').trim() === '⚙')
    check('有设置入口（设置图标，现位于页签行右端）', !!gear)
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

    // ⚠ 这是「通用」类的**小节清单 + 顺序**（产品事实，不是夹具数量）。
    //   2026-10-25 加了「念头长度上限」，旧断言写死 length===2 当场变红 —— 它挡对了：
    //   万一哪天分类隔离失效、别类小节漏出来，这条也会同样响。加小节时同步这张清单。
    const GENERAL_SECTS = ['版本与更新', '外观主题', '外观形态', '念头长度上限', '顶栏页签']
    check('★ 默认停在第 1 类「通用」：右侧只渲染该分类的小节（不再全挤在一起）',
      sectTitles().length === GENERAL_SECTS.length
      && GENERAL_SECTS.every((t, i) => sectTitles()[i] === t),
      JSON.stringify(sectTitles()))
    // 「梯度榜」是**项目页的一种摆法**，不是独立顶级页签（2026-10-25 暮雨：
    // 「放进项目页签里面就好。这玩意纯属小玩具，没必要提到那么高级」）
    check('★ 顶栏没有独立「优先级」页签（它在项目页里）',
      !$$('#views .vbtn').some((b) => (b.textContent || '').trim() === '优先级'))
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

    // ══ 导入被拦下时，界面必须把**主进程那句话**带出来（开发清单第 6 条 + 第 7 条的通信层）══
    // 老实现写死 `showToast('导入失败')`：主进程刚点名"第几条 / 哪个字段"，界面又给吞回去。
    {
      const realClick = HTMLInputElement.prototype.click
      const realFR = window.FileReader
      let captured = null
      HTMLInputElement.prototype.click = function () {
        if (this && this.type === 'file') { captured = this; return }
        return realClick.call(this)
      }
      // 只仿真「读到了一段 JSON 文本」这一步 —— 无头里给文件输入塞自造 File 再走真 FileReader
      // 不稳（读到空串）。真正被测的是**导入处理器把主进程那句话带不带出来**。
      window.FileReader = function () {
        this.readAsText = () => {
          this.result = '[{"题目":"字段名写错了"}]'
          this.onload({ target: this })
        }
      }
      const impBtn = $$('.settings-foot button').find((b) => (b.textContent || '').indexOf('导入任务 JSON') >= 0)
      check('★ 设置页底部有「导入任务 JSON」入口', !!impBtn)
      if (impBtn) {
        impBtn.click()
        await sleep(150)
        if (captured) {
          // 处理器第一句是 `e.target.files?.[0]`，得先有个"选中的文件"；内容由上面的桩给
          Object.defineProperty(captured, 'files', { value: [{}], configurable: true })
          captured.onchange({ target: captured })
          await waitFor(() => window.__fcTest.callCount('importTasks') >= 1, 3000, 'importTasks')
          await sleep(400)
        }
      }
      window.FileReader = realFR
      HTMLInputElement.prototype.click = realClick
      const toastTxt = (($('#toast') || {}).textContent) || ''
      check('★★ 导入被拦下时，界面显示的是**主进程那句话**（点名「题目」），不是干巴巴的「导入失败」',
        captured !== null && toastTxt.indexOf('题目') >= 0 && toastTxt.trim() !== '导入失败',
        `toast=${toastTxt.slice(0, 90)} captured=${captured !== null} calls=${window.__fcTest.callCount('importTasks')}`)
    }

    maskClick('#soverlay')
    await sleep(300)
    check('设置面板已关闭（点遮罩 = mousedown.self 才关）', !$('#smodal'))

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

    // ══ 死通道接回验收（2026-10-11，卡 20261006-002 E/C 组收口）══════════════
    // 这批通道一直躺在主进程里、界面从来没有入口（全是 `check-ipc-parity` 第 ⑤ 类扫出来的）。
    // 断言盯的是「**能从界面真用上**」，不是「通道存在」—— 后者早就是真的，前者才是有意义的判据。
    clickText('看板'); await sleep(400)

    // ① 快速记（quickAdd）
    const qaBtn = $$('button').find((b) => (b.textContent || '').trim() === '⚡ 快速记')
    check('★ 顶栏有「快速记」入口（quickAdd 通道此前**没有任何界面入口**）', !!qaBtn)
    if (qaBtn) {
      qaBtn.click(); await sleep(300)
      check('★ 点开是自建模态（**不是 window.prompt** —— Electron 里调用即抛）', !!$('#quickadd-modal'))
      const qi = $('#quickadd-modal .quickadd-in')
      if (qi) { qi.value = 'p0 修登录 #bug @hermes'; qi.dispatchEvent(new Event('input', { bubbles: true })) }
      await sleep(150)
      const qaCreate = $$('#quickadd-modal button').find((b) => (b.textContent || '').trim() === '创建')
      check('  有「创建」按钮', !!qaCreate)
      if (qaCreate) qaCreate.click()
      check('★★ 创建真调了 quickAdd', await waitFor(() => window.__fcTest.callCount('quickAdd') >= 1, 4000, 'quickAdd'),
        'calls=' + window.__fcTest.callCount('quickAdd'))
      const qaCall = window.__fcTest.calls().filter((c) => c.name === 'quickAdd').pop()
      check('★★ 原样把**简写串整段**传下去（解析在主进程 quickAdd 里，界面不许自己拆字段）',
        !!qaCall && qaCall.args[0] === 'p0 修登录 #bug @hermes', JSON.stringify(qaCall && qaCall.args))
      check('  创建成功后模态自动关闭', await waitFor(() => !$('#quickadd-modal'), 4000, '快速记关闭'))
    }

    // ② 跨项目建议条（suggestCrossProject）
    clickText('项目'); await sleep(800)
    check('★ 项目页顶部渲染出跨项目建议条（suggestCrossProject 通道接回）',
      await waitFor(() => !!$('.cross-suggest'), 4000, '跨项目建议条'),
      'items=' + $$('.cross-suggest .cs-item').length)
    check('  文案来自主进程返回值（不是前端编的）',
      String((($('.cross-suggest .cs-item') || {}).textContent || '')).indexOf('卡住项目') >= 0,
      String((($('.cross-suggest .cs-item') || {}).textContent || '')))

    // ③ 阶段里程碑（suggestMilestones）
    check('能切到「路线图」页签', clickText('路线图'))
    await sleep(800)
    check('★ 路线图页渲染出阶段里程碑（suggestMilestones 通道接回）',
      await waitFor(() => !!$('.rms-strip'), 4000, '里程碑条'),
      'items=' + $$('.rms-strip .rms-item').length)
    check('  里程碑文案来自主进程（含「阶段」字样）',
      String((($('.rms-item') || {}).textContent || '')).indexOf('阶段') >= 0,
      String((($('.rms-item') || {}).textContent || '')))

    // ── 路线图本体（2026-10-23 补：此前夹具恒为 `{projects:[]}`，这四种渲染一条都没验过）──
    check('★★ 路线图**不是空的**（项目块渲染出来，不再停在「暂无路线图数据」）',
      !!$('.roadmap-view .roadmap-project') && !$('.roadmap-view .empty-state'),
      'projects=' + $$('.roadmap-view .roadmap-project').length)
    const rpEl = $('.roadmap-view .roadmap-project')
    check('★ 项目名 + 健康度标签（active → 「活跃」，映射不是硬编码在模板里）',
      !!rpEl && ((rpEl.querySelector('.rp-name') || {}).textContent || '').trim() === '演示项目'
      && ((rpEl.querySelector('.rp-health') || {}).textContent || '').trim() === '活跃',
      rpEl ? ((rpEl.querySelector('.rp-name') || {}).textContent || '') + '/' + ((rpEl.querySelector('.rp-health') || {}).textContent || '') : '(无)')
    const rbEls = $$('.roadmap-view .rp-batch')
    check('★ 批次卡片：done/total 与状态 class 都来自数据（完成 2/2、进行 2 条）',
      rbEls.length === 2
      && ((rbEls[0].querySelector('.rb-count') || {}).textContent || '').trim() === '2/2'
      && /rb-completed/.test(rbEls[0].className)
      && /rb-active/.test(rbEls[1].className),
      JSON.stringify(rbEls.map((b) => ((b.querySelector('.rb-count') || {}).textContent || '').trim() + '|' + b.className)))
    check('★ 任务状态胶囊的 class 来自 shared/status（完成→st-done、进行中→st-doing）',
      $$('.roadmap-view .rb-task .st').map((x) => x.className).join('|').indexOf('st-done') >= 0
      && $$('.roadmap-view .rb-task .st').map((x) => x.className).join('|').indexOf('st-doing') >= 0,
      JSON.stringify($$('.roadmap-view .rb-task .st').map((x) => x.className)))
    const rpActs = $$('.roadmap-view .rp-action')
    check('★ 「下一步」列出行动项，高优先级标红（st-review）',
      rpActs.length === 2 && /st-review/.test(rpActs[0].className + ' ' + ((rpActs[0].querySelector('.st') || {}).className || '')),
      JSON.stringify(rpActs.map((a) => (a.textContent || '').trim())))

    // ④ 设置 → 诊断页三块（selfCheck / skillsCheck / loadActivity）
    clickText('⚙'); await sleep(900)
    const diagNav = $$('.settings-nav-btn').find((b) => (b.textContent || '').indexOf('诊断') >= 0)
    check('  设置页有「诊断」分类', !!diagNav)
    if (diagNav) {
      diagNav.click(); await sleep(700)
      check('★★ 数据自检进门就跑完并显示结果（selfCheck 通道接回）',
        await waitFor(() => !!$('.diag-result'), 4000, '自检结果'),
        'result=' + String((($('.diag-result') || {}).textContent || '')).slice(0, 40))
      check('★ 技能副本检查渲染出逐个技能行（skillsCheck 通道接回）',
        await waitFor(() => $$('.diag-skill-row').length >= 1, 4000, '技能副本行'),
        'rows=' + $$('.diag-skill-row').length)
      check('★ 最近活动日志渲染成行（loadActivity 通道接回）',
        await waitFor(() => $$('.diag-act-row').length >= 1, 4000, '活动日志行'),
        'rows=' + $$('.diag-act-row').length)
      check('  技能检查显示的副本状态是主进程给的（Hermes / 一致）',
        String((($('.diag-skills-head') || {}).textContent || '')).indexOf('Hermes') >= 0,
        String((($('.diag-skills-head') || {}).textContent || '')))
    }

    // ⑤ 设置 → 备份：刷新按钮 + 教程 + 动作分组 + 块顺序（用户 2026-10-11 三条要求）
    const bkNav = $$('.settings-nav-btn').find((b) => (b.textContent || '').indexOf('备份') >= 0)
    if (bkNav) {
      bkNav.click(); await sleep(700)
      const bkRef = $('.bk-tabs .bk-refresh')
      check('★ 备份列表有刷新按钮（此前只有切页签才会重读列表）', !!bkRef)
      if (bkRef) {
        const before = window.__fcTest.callCount('backupListLocal')
        bkRef.click()
        check('★ 点刷新真的重读了备份列表',
          await waitFor(() => window.__fcTest.callCount('backupListLocal') > before, 4000, '重读备份列表'),
          `before=${before} after=${window.__fcTest.callCount('backupListLocal')}`)
      }

      // ⚠ 顺序断言必须用**文档序**（DOM 里的先后），不能只看"元素存在" ——
      //   用户提的正是"谁在上面"，存在性断言对顺序一无所知。
      const ord = (sel) => {
        const el = $(sel)
        if (!el) return -1
        return Array.prototype.indexOf.call(document.querySelectorAll('*'), el)
      }
      const bkSect = $('.backup-sect') || document.body
      check('★ 备份教程块存在且在配置表**之前**（先讲流程，再让人填表）',
        !!$('.bk-guide') && String(($('.bk-guide') || {}).textContent || '').indexOf('30 秒') >= 0
        && ord('.bk-guide') < ord('.bk-grid'),
        'guide=' + ord('.bk-guide') + ' grid=' + ord('.bk-grid'))
      check('★ 动作已按用途分组（每组一个小标题，不再一排七个按钮平铺）',
        $$('.bk-act-group').length >= 3 && $$('.bk-act-group .bk-act-label').length === $$('.bk-act-group').length,
        'groups=' + $$('.bk-act-group').length + ' labels=' + $$('.bk-act-group .bk-act-label').length)
      check('★★ 瘦身块在「数据安全须知」**上面**（用户第 1 条原话：「瘦身块应该放在数据安全须知上面」）',
        !!$('.bk-slim') && !!$('.bk-notice') && ord('.bk-slim') < ord('.bk-notice'),
        'slim=' + ord('.bk-slim') + ' notice=' + ord('.bk-notice'))
      check('★★ Git 通道在「备份范围：…」说明**下面**（用户第 1 条：防止和手动备份压缩包混在一起）',
        !!$('.bk-git') && ord('.bk-git') > ord('.bk-sect-hint'),
        'git=' + ord('.bk-git') + ' hint=' + ord('.bk-sect-hint'))

      // ── 2026-10-23：三处「空桩」补上夹具之后的真界面断言 ─────────────────
      // 背景：假 preload 里 backupLog / backupListRemote 原本返回**裸数组**，
      //   而真主进程回的是 `{ ok, lines }` / `{ ok, items }`。形状不对 → 渲染层
      //   `r.ok ? … : …` 恒走空分支 → 这两个界面**从来没被真渲染过**，
      //   空桩让整块界面等于没测（本项目踩过六次的同一个洞）。
      {
        const t = $('.bk-log-toggle')
        check('★ 备份区有「查看备份日志」入口', !!t, t ? (t.textContent || '').trim() : 'null')
        if (t) {
          t.click()
          check('★★ 备份日志面板真显示主进程给的行（桩形状 { ok, lines }）',
            await waitFor(() => {
              const pre = $('.bk-log')
              return !!pre && (pre.textContent || '').indexOf('已打包') >= 0
            }, 4000, '备份日志行'),
            String((($('.bk-log') || {}).textContent || '').slice(0, 80)))
          // 收起来，别把下面的块挤下去（几何断言按实测位置判，多一截日志会改动布局）
          if ($('.bk-log')) t.click()
        }

        const remoteTab = $$('.bk-tabs span').find((s) => (s.textContent || '').indexOf('远端') === 0)
        check('  备份区有「远端」页签', !!remoteTab, remoteTab ? remoteTab.textContent : 'null')
        if (remoteTab) {
          remoteTab.click()
          check('★★ 切到「远端」真列出远端备份（此前桩返回裸数组，这一页永远是空的）',
            await waitFor(() => $$('.bk-item-name').some((n) => (n.textContent || '').indexOf('20261021') >= 0), 4000, '远端备份行'),
            $$('.bk-item-name').map((n) => n.textContent).join('|'))
          check('  远端页签计数跟着列表走（不是写死 0）',
            (($$('.bk-tabs span')[1] || {}).textContent || '').indexOf('(1)') >= 0,
            String(($$('.bk-tabs span')[1] || {}).textContent || ''))
        }
      }

      // 远端恢复**必须传 name**（远端没有本地路径可给）—— 这条只有真点一次才验得到：
      // 传成 path 的话主进程会去本地找这个"路径"，用户看到的是"远端备份恢复不了"。
      {
        const rb = $$('.bk-item .bk-restore')[0]
        check('  远端行上有「恢复」按钮', !!rb)
        if (rb) {
          const realConfirm2 = window.confirm
          window.confirm = () => true
          const n0 = window.__fcTest.callCount('backupRestore')
          rb.click()
          const hit = await waitFor(() => window.__fcTest.callCount('backupRestore') > n0, 4000, 'backupRestore(remote)')
          window.confirm = realConfirm2
          const src = hit ? (window.__fcTest.calls().filter((c) => c.name === 'backupRestore').pop() || {}).args : null
          check('★★ 远端恢复传的是 { kind: remote, name }（不是本地路径）',
            !!src && src[0] && src[0].kind === 'remote' && String(src[0].name || '').indexOf('20261021') >= 0,
            JSON.stringify(src && src[0]))
        }
      }
      void bkSect
    }
    maskClick('#soverlay'); await sleep(300)

    // ⚠ 合入（2026-10-12）：下面这一整段「决策卡」断言来自外部整包，
    //   与上面「死通道接回验收」是**两块独立**的断言 —— 冲突只是**位置重叠**
    //   （两边都往文件末尾追加），**两块都要留**，不许丢任何一边（这就是逐段合的意义）。
    // ══ 决策卡 · 决策记录（2026-10-12 AI 规划包第 3 件）
    //    2026-10-14：术语白话化（页签「拍板」→「决策」、三态「作数/已作废/已并入」→「有效/已撤销/已合并」）
    //    ＋ UI 基座第 ④ 步第一单 —— 视图本体已切到组件 `components/DecisionBoard.vue`（shadcn-vue 口径）。
    //    选择器随之改走 `data-dec="…"` 钩子：类名只承载样式，测试找属性，两边改起来互不牵连。══
    clickText('看板'); await sleep(300)
    check('能切到「决策」页签', clickText('决策'))
    check('决策卡 3 张渲染（mock 三态各一）', await waitFor(() => $$('[data-dec="card"]').length === 3, 4000, 'dec seed'))
    check('  三态徽章各就位（DOM 序=mock 数据序 有效/已撤销/已合并）',
      $$('[data-dec="badge"]').map((x) => x.textContent.trim()).join('|') === '有效|已撤销|已合并',
      $$('[data-dec="badge"]').map((x) => x.textContent.trim()).join('|'))
    check('  已撤销的卡整体降调（视觉死账）',
      $$('[data-dec="card"]').some((c) => (c.textContent || '').indexOf('已撤销') >= 0 && /line-through/.test(String(c.innerHTML))))
    // ── 2026-10-29 暮雨第 3 条：「决策的 UI 疑似没和其他页签统一，按钮还是带阴影」──
    // 不靠印象，直接量计算样式：决策卡必须与**看板老卡 `.card`** 同一档圆角/阴影，
    // 且决策页里的按钮一律不许自带投影（老按钮全是扁平的）。
    {
      const decCard = $('[data-dec="card"]')
      const decCS = decCard ? getComputedStyle(decCard) : null
      // ⚠ 立刻把值取成字符串：换页签后组件会被卸载，CSSStyleDeclaration 会变空
      const decRadius = decCS ? decCS.borderTopLeftRadius : ''
      const decShadow = decCS ? decCS.boxShadow : ''
      // 换个页签把老卡的实测值取回来（同一份 CSS，同一屏比）
      clickText('看板'); await sleep(350)
      const boardCard = $('.card')
      const boardCS = boardCard ? getComputedStyle(boardCard) : null
      const boardRadius = boardCS ? boardCS.borderTopLeftRadius : ''
      const boardShadow = boardCS ? boardCS.boxShadow : ''
      clickText('决策'); await sleep(500)
      check('★★ 决策卡与看板老卡**同圆角**（两套 UI 的分界线就在这两个值上）',
        !!decRadius && decRadius === boardRadius,
        `dec=${decRadius} board=${boardRadius}`)
      // ⚠ 不能直接比字符串：Tailwind 的 box-shadow 会带两层**全透明占位**
      // 按**整层**删掉全透明占位（不能按逗号切：rgba(0, 0, 0, 0) 自己就带逗号）。
      const normShadow = (v) => String(v || '')
        .replace(/rgba?\(0,\s*0,\s*0,\s*0\)[^,]*?(,\s*|$)/g, '')
        .replace(/,\s*$/, '')
        .trim()
      /** 没有影子 = 空 或 计算值 'none'；"两边同阴影"那条要用原值比较，不能把 none 抹成空 */
      const isEmptyShadow = (v) => { const s = normShadow(v); return !s || s === 'none' }
      const decN = normShadow(decShadow)
      const boardN = normShadow(boardShadow)
      check('★★ 决策卡与看板老卡**同阴影**（此前是 14px 圆角 + 独立投影 = 一眼两套）',
        !!decN && decN === boardN,
        `dec=${decN} board=${boardN}`)
      // 2026-10-31（用户：外观只影响卡片，按钮从不变）：按钮也必须跟着外观走。
      // 判据不是"永远没有影子"，而是**扁平归零、阴影浮起、切回归零**三态。
      const decBtn = $('[data-dec="select-mode"]')
      const flatBtnShadow = decBtn ? getComputedStyle(decBtn).boxShadow : 'X'
      check('★★ 扁平外观下决策页按钮没有投影（与老按钮一致）', isEmptyShadow(flatBtnShadow),
        flatBtnShadow)
      const beforeAppearance = document.documentElement.dataset.appearance || 'flat'
      document.documentElement.dataset.appearance = 'shadow'
      await sleep(120)
      const shadowBtn = decBtn ? getComputedStyle(decBtn).boxShadow : ''
      // ⚠ 必须重新查：换过页签后旧 `decCard` 已经脱离 DOM，量它是空值（本断言第一版就栽在这）
      const decCardNow = $('[data-dec="card"]')
      const shadowCard2 = decCardNow ? getComputedStyle(decCardNow).boxShadow : ''
      check('★★ 切「阴影」外观 → 按钮真的浮起来（不再只有卡片变）', !isEmptyShadow(shadowBtn),
        `btn=${shadowBtn || '(none)'} cls=${decBtn ? String(decBtn.className) : '(null)'}`)
      check('★★ 切「阴影」外观 → 卡片与按钮同一档高度都在',
        !isEmptyShadow(shadowCard2) && !isEmptyShadow(shadowBtn),
        `card=${shadowCard2 || '(none)'} btn=${shadowBtn || '(none)'}`)
      document.documentElement.dataset.appearance = beforeAppearance
      await sleep(120)
      const flatAgain = decBtn ? getComputedStyle(decBtn).boxShadow : 'X'
      check('★★ 切回扁平 → 按钮投影归零（不是只加不减）', isEmptyShadow(flatAgain), flatAgain)
      // 2026-10-30 暮雨第 4 条（第三次提）真因：preflight 关着 → `<button>` 的 UA
      // `border-style: outset` 还在，Tailwind 的 border 只设宽度不设样式。屏幕上看起来就是
      // 一圈"外凸阴影"——量 box-shadow 永远是 none，所以前几次断言全绿而问题还在。
      const badBorder = $$('.decisions-view button').filter(b => {
        const cs = getComputedStyle(b)
        return cs.borderTopStyle !== 'solid' || cs.borderBottomStyle !== 'solid'
      })
      check('★★ 决策页按钮的边框是 solid（UA 的 outset 就是用户看到的"阴影"）',
        badBorder.length === 0,
        badBorder.map(b => (b.textContent || '').trim().slice(0, 10) + ':' + getComputedStyle(b).borderTopStyle).join(' | '))
      const nativeLook = $$('.decisions-view button').filter(b => {
        const ap = getComputedStyle(b).appearance || getComputedStyle(b).webkitAppearance || ''
        return ap && ap !== 'none'
      })
      check('★ 决策页按钮不是系统原生外观（appearance:none）', nativeLook.length === 0,
        nativeLook.map(b => (b.textContent || '').trim().slice(0, 10) + ':' + (getComputedStyle(b).appearance || '?')).join(' | '))
    }
    check('★ 界面只说白话中文（决策页签/视图里不许再出现「拍板」「作数」「已并入」「已作废」）',
      ((($('#bar') || {}).textContent || '') + (($('.decisions-view') || {}).textContent || ''))
        .match(/拍板|作数|已并入|已作废/) === null)
    check('★ 状态筛选是分段控件（四个 tab，且计数跟着数据走）',
      $$('[data-dec="tab"]').map((b) => (b.textContent || '').trim()).join('|') === '全部3|有效1|已撤销1|已合并1',
      $$('[data-dec="tab"]').map((b) => (b.textContent || '').trim()).join('|'))
    // ── 开发清单第 4 条：按项目筛选（数据早就支持项目列，界面前面一直缺）──
    {
      const pj = $('[data-dec="proj-filter"]')
      check('★ 决策页有「按项目筛选」', !!pj, 'no proj-filter')
      if (pj) {
        const opts = [...pj.options].map((o) => o.value)
        check('  筛选项 = 全部项目 + 数据里出现过的项目 +（未归属）',
          opts[0] === '全部项目' && opts.includes('司天') && opts.includes('绒花墨坊') && opts.includes('（未归属）'),
          opts.join('|'))
        pj.value = '司天'
        pj.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(250)
        check('★★ 选「司天」→ 只剩该项目的 1 张，且**计数跟着项目筛走**（不是全局数）',
          $$('[data-dec="card"]').length === 1
          && $$('[data-dec="tab"]').map((b) => (b.textContent || '').trim()).join('|') === '全部1|有效1|已撤销0|已合并0',
          'cards=' + $$('[data-dec="card"]').length + ' tabs=' + $$('[data-dec="tab"]').map((b) => (b.textContent || '').trim()).join('|'))
        pj.value = '全部项目'
        pj.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(250)
        check('  切回「全部项目」→ 3 张回来', $$('[data-dec="card"]').length === 3, 'cards=' + $$('[data-dec="card"]').length)
      }
    }

    // ── 开发清单第 5 条：贴一句话自动拆字段（只**预填**，不直接落库）──────
    {
      const si = $('[data-dec="smart-input"]')
      check('★ 决策页有「贴一句话自动拆字段」入口', !!si, 'no smart-input')
      if (si) {
        si.value = '10月12日 定：司天不发版，唯一目标=标注+导出真图（出自 10-12 群 09:42）'
        si.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(120)
        const sb = $$('.decisions-view button').find((b) => (b.textContent || '').trim() === '拆分')
        check('  「拆分」按钮可点', !!sb)
        if (sb) sb.click()
        await sleep(300)
        const gv = (sel) => String((($(sel) || {}).value) || '')
        check('★★ 拆完四栏被预填：内容 / 日期 / 项目 / 出处',
          gv('[data-dec="add-input"]').indexOf('司天不发版') >= 0
          && gv('[data-dec="add-date"]') === '2026-10-12'
          && gv('[data-dec="add-project"]') === '司天'
          && gv('[data-dec="add-source"]').indexOf('10-12 群 09:42') >= 0,
          `内容=${gv('[data-dec="add-input"]').slice(0, 24)} 日期=${gv('[data-dec="add-date"]')} 项目=${gv('[data-dec="add-project"]')} 出处=${gv('[data-dec="add-source"]')}`)
        check('★★ 拆分只是预填：没有偷偷落库（这时 decisionAdd 一次都还没被调）',
          window.__fcTest.callCount('decisionAdd') === 0, 'calls=' + window.__fcTest.callCount('decisionAdd'))
      }
    }

    // 记一条：输入 → 点「记下」→ mock IPC decisionAdd → 输入清空（mock 无状态，故断言按钮/输入）
    const decInp = $('[data-dec="add-input"]')
    if (decInp) {
      decInp.value = '断言用：这条决策是测试记的'
      decInp.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(150)
      const decBtn = $$('.decisions-view button').find((b) => (b.textContent || '').trim() === '记下')
      check('  「记下」按钮可点（内容非空）', !!decBtn && !decBtn.disabled)
      if (decBtn) decBtn.click()
      check('  记一条真走 IPC（decisionAdd 被调）',
        await waitFor(() => window.__fcTest.callCount('decisionAdd') >= 1, 3000, 'decAdd'),
        'calls=' + window.__fcTest.callCount('decisionAdd'))
      // ★ 项目 / 日期 / 出处 必须**一起**发出去 —— 只发内容 = 界面填了不落库（第 4 条的一半价值）
      check('★ 记一条时项目 / 日期 / 出处 一起进 IPC（不是只发内容）',
        (() => {
          const d = (window.__fcTest.calls().filter((c) => c.name === 'decisionAdd').pop() || {}).args || []
          const a = d[0] || {}
          return a.项目 === '司天' && a.日期 === '2026-10-12' && String(a.出处).indexOf('10-12 群') >= 0
        })(),
        JSON.stringify(((window.__fcTest.calls().filter((c) => c.name === 'decisionAdd').pop() || {}).args || [])[0]))
      check('  记完输入框清空（成功路径）', await waitFor(() => !($('[data-dec="add-input"]') || {}).value, 3000, 'dec clear'))
    } else {
      check('  新增输入框存在', false, 'add-input not found')
    }
    // 改状态：下拉换「已合并」→ decisionSetStatus mock → toast
    const decSel = $('[data-dec="status"]')
    if (decSel) {
      decSel.value = '已合并'
      decSel.dispatchEvent(new Event('change', { bubbles: true }))
      check('  改状态走 IPC（decisionSetStatus 被调）',
        await waitFor(() => window.__fcTest.callCount('decisionSetStatus') >= 1, 3000, 'decSet'),
        'calls=' + window.__fcTest.callCount('decisionSetStatus'))
    } else {
      check('  状态下拉存在', false, 'status not found')
    }
    // ══ 编辑 / 删除（2026-10-17 暮雨第 5 条：「决策并不能编辑和删除，给人失控感」）══
    // 判据三条：① 每张卡都有入口；② 编辑是**就地展开**（改一句话不该跨三层）；
    //          ③ 删除是**两段式**——第一次点只出确认，确认前 IPC 一次都不许发。
    const decEdits = $$('[data-dec="edit"]')
    const decDels = $$('[data-dec="delete"]')
    check('★★ 每张决策卡都有「编辑 / 删除」入口',
      decEdits.length === 3 && decDels.length === 3,
      `edit=${decEdits.length} delete=${decDels.length}`)
    if (decEdits[0]) {
      decEdits[0].click()
      check('★★ 点「编辑」→ 就地展开表单（不是弹新窗）',
        await waitFor(() => $$('[data-dec="edit-form"]').length === 1, 3000, 'dec edit form'),
        'forms=' + $$('[data-dec="edit-form"]').length)
      check('  表单带出原内容（不是空白框）',
        (($('[data-dec="edit-content"]') || {}).value || '').indexOf('司天不发版') >= 0,
        (($('[data-dec="edit-content"]') || {}).value || '').slice(0, 30))
      check('  备注用的是多行 textarea（"可多行"不是假话）',
        (($('[data-dec="edit-note"]') || {}).tagName || '') === 'TEXTAREA',
        String((($('[data-dec="edit-note"]') || {}).tagName || '')))
      // 真存一次：改内容 → 保存 → decisionUpdate 必须带上新内容（只开框不改 = 假功能）
      const updBefore = window.__fcTest.callCount('decisionUpdate')
      const ecInp = $('[data-dec="edit-content"]')
      if (ecInp) {
        ecInp.value = '改过的一句话：决策要能编辑'
        ecInp.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(150)
      }
      const esBtn = $('[data-dec="edit-save"]')
      if (esBtn) esBtn.click()
      check('★★ 保存 → 走 decisionUpdate，且带的是改后的内容',
        await waitFor(() => window.__fcTest.callCount('decisionUpdate') > updBefore, 3000, 'dec update'),
        'calls=' + window.__fcTest.callCount('decisionUpdate'))
      check('  保存参数：id = D-001、内容 = 新填的那句',
        (() => {
          const a = ((window.__fcTest.calls().filter((c) => c.name === 'decisionUpdate').pop() || {}).args || [])
          return a[0] === 'D-001' && String(((a[1] || {}).内容 || '')).indexOf('决策要能编辑') >= 0
        })(),
        JSON.stringify(((window.__fcTest.calls().filter((c) => c.name === 'decisionUpdate').pop() || {}).args || [])))
      await sleep(300)
      check('  保存后表单收起（回到只读卡）', $$('[data-dec="edit-form"]').length === 0,
        'forms=' + $$('[data-dec="edit-form"]').length)
      // 再开一次只为验「取消」这条路
      if ($$('[data-dec="edit"]')[0]) $$('[data-dec="edit"]')[0].click()
      await sleep(300)
      const ecBtn = $('[data-dec="edit-cancel"]')
      if (ecBtn) ecBtn.click()
      await sleep(300)
      check('  取消 → 表单收起，卡片回到只读', $$('[data-dec="edit-form"]').length === 0,
        'forms=' + $$('[data-dec="edit-form"]').length)
    }
    const delBefore = window.__fcTest.callCount('decisionDelete')
    if ($$('[data-dec="delete"]')[0]) {
      $$('[data-dec="delete"]')[0].click()
      await sleep(250)
      check('★★ 点「删除」只是两段式第一步（还没真删）',
        $$('[data-dec="delete-confirm"]').length === 1
          && window.__fcTest.callCount('decisionDelete') === delBefore,
        'confirm=' + $$('[data-dec="delete-confirm"]').length + ' calls=' + window.__fcTest.callCount('decisionDelete'))
      const dcBtn = $('[data-dec="delete-cancel"]')
      if (dcBtn) dcBtn.click()
      await sleep(250)
      check('  点「取消」→ 确认按钮收起，仍然没删',
        $$('[data-dec="delete-confirm"]').length === 0
          && window.__fcTest.callCount('decisionDelete') === delBefore,
        'confirm=' + $$('[data-dec="delete-confirm"]').length + ' calls=' + window.__fcTest.callCount('decisionDelete'))
      // 真删一次：删除 → 确认
      if ($$('[data-dec="delete"]')[0]) $$('[data-dec="delete"]')[0].click()
      await sleep(250)
      const dOk = $('[data-dec="delete-confirm"]')
      if (dOk) dOk.click()
      check('★ 二次确认后才真删（decisionDelete 被调）',
        await waitFor(() => window.__fcTest.callCount('decisionDelete') > delBefore, 3000, 'dec delete'),
        'calls=' + window.__fcTest.callCount('decisionDelete'))
      check('  删除参数是那张卡的 id（不是空/不是 index）',
        ((window.__fcTest.calls().filter((c) => c.name === 'decisionDelete').pop() || {}).args || [])[0] === 'D-001',
        JSON.stringify(((window.__fcTest.calls().filter((c) => c.name === 'decisionDelete').pop() || {}).args || [])))
    } else {
      check('  删除按钮存在', false, 'delete not found')
    }

    // ══ 决策 · 生命周期管理（2026-10-17 暮雨：「决策卡当然需要有生命周期管理」）══
    // 判据：找得到（搜索）→ 成批动（多选 / 批量改状态 / 批量删除）→ 批量删除同样两段式。
    {
      // ① 搜索
      const sq = $('[data-dec="search"]')
      check('★ 决策页有搜索框', !!sq)
      if (sq) {
        sq.value = '绒花'
        sq.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(450)
        check('★★ 搜索真的收窄列表（搜「绒花」→ 1 张）', $$('[data-dec="card"]').length === 1,
          'cards=' + $$('[data-dec="card"]').length)
        check('  页签计数跟着搜索走（全部1，不是还写着全部3）',
          (($$('[data-dec="tab"]')[0] || {}).textContent || '').trim() === '全部1',
          (($$('[data-dec="tab"]')[0] || {}).textContent || '').trim())
        sq.value = ''
        sq.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(450)
        check('  清空搜索 → 3 张回来（可逆）', $$('[data-dec="card"]').length === 3,
          'cards=' + $$('[data-dec="card"]').length)
      }
      // ② 多选 + 全选
      const smBtn = $('[data-dec="select-mode"]')
      check('★ 决策页有多选开关', !!smBtn)
      if (smBtn) {
        smBtn.click()
        check('  多选模式 → 批量栏出现', await waitFor(() => !!$('[data-dec="batch-bar"]'), 3000, 'dec batch bar'))
        check('  多选模式 → 每张卡都有勾选框', $$('[data-dec="pick"]').length === 3,
          'pick=' + $$('[data-dec="pick"]').length)
        const allBtn = $$('[data-dec="batch-bar"] button').find((b) => (b.textContent || '').trim() === '全选当前')
        if (allBtn) allBtn.click()
        await sleep(350)
        check('★★ 全选当前 → 已选 3（不是只选一张）',
          (($('[data-dec="batch-bar"]') || {}).textContent || '').indexOf('已选 3') >= 0,
          (($('[data-dec="batch-bar"]') || {}).textContent || '').slice(0, 40))
        // ③ 批量改状态
        const bBefore = window.__fcTest.callCount('decisionSetStatus')
        const revBtn = $$('[data-dec="batch-bar"] button').find((b) => (b.textContent || '').trim() === '已撤销')
        if (revBtn) revBtn.click()
        check('★★ 批量设「已撤销」→ 逐条走 IPC（3 次，不绕过留痕通道）',
          await waitFor(() => window.__fcTest.callCount('decisionSetStatus') >= bBefore + 3, 4000, 'dec batch set'),
          'delta=' + (window.__fcTest.callCount('decisionSetStatus') - bBefore))
        await sleep(450)
        // ④ 批量删除仍是两段式
        if (!$('[data-dec="batch-bar"]')) {
          const again = $('[data-dec="select-mode"]')
          if (again) again.click()
          await sleep(300)
        }
        const all2 = $$('[data-dec="batch-bar"] button').find((b) => (b.textContent || '').trim() === '全选当前')
        if (all2) all2.click()
        await sleep(300)
        const delBefore2 = window.__fcTest.callCount('decisionDelete')
        const delBtn = $$('[data-dec="batch-bar"] button').find((b) => (b.textContent || '').trim() === '删除所选')
        if (delBtn) delBtn.click()
        await sleep(350)
        check('★★ 批量删除也是两段式（点一次只出确认，一条都没删）',
          window.__fcTest.callCount('decisionDelete') === delBefore2
            && $$('[data-dec="batch-bar"] button').some((b) => (b.textContent || '').indexOf('确认删除') >= 0),
          'calls=' + window.__fcTest.callCount('decisionDelete'))
        const cancelDel = $$('[data-dec="batch-bar"] button').find((b) => (b.textContent || '').trim() === '取消')
        if (cancelDel) cancelDel.click()
        await sleep(250)
        const quit = $$('[data-dec="batch-bar"] button').find((b) => (b.textContent || '').trim() === '退出多选')
        if (quit) quit.click()
        await sleep(350)
        check('  退出多选后批量栏消失、勾选框收起',
          !$('[data-dec="batch-bar"]') && $$('[data-dec="pick"]').length === 0,
          'bar=' + (!!$('[data-dec="batch-bar"]')) + ' pick=' + $$('[data-dec="pick"]').length)
      }
    }

    // ══ 控件统一（2026-10-17 暮雨第 4 条：「决策页混着两种按钮和文本框」）══
    // 判据必须是**几何**，不是"看起来差不多"：同一页里输入框 / 下拉 / 按钮 高 32、圆角 8。
    // （卡片里的动作按钮走密集档 24，那是另一档，单独放行。）
    {
      const box = (el) => el
        ? { h: Math.round(el.getBoundingClientRect().height), r: getComputedStyle(el).borderTopLeftRadius }
        : null
      const okBox = (b) => !!b && b.h === 32 && parseFloat(b.r) === 8
      const addBtn = $$('.decisions-view button').find((b) => (b.textContent || '').trim() === '记下')
      const probes = [
        ['搜索输入框', box($('[data-dec="search"]'))],
        ['项目下拉', box($('[data-dec="proj-filter"]'))],
        ['多选按钮', box($('[data-dec="select-mode"]'))],
        ['记下按钮', box(addBtn)],
        ['卡片状态下拉', box($('[data-dec="status"]'))],
        ['新增内容输入框', box($('[data-dec="add-input"]'))],
      ]
      const bad = probes.filter(([, b]) => !okBox(b))
      check('★★ 决策页控件尺寸统一：输入框 / 下拉 / 按钮 一律 h=32、圆角=8px',
        bad.length === 0,
        bad.length ? JSON.stringify(bad) : JSON.stringify(probes.map(([n, b]) => n + ':' + (b ? b.h + '/' + b.r : 'null'))))
      // 卡片内的动作按钮是密集档（24）—— 与老界面 --btn-h-sm 同档，不是"另一种按钮"
      const editBtn = $('[data-dec="edit"]')
      check('  卡片内动作按钮走密集档 24（与老界面 --btn-h-sm 同档）',
        !editBtn || Math.round(editBtn.getBoundingClientRect().height) === 24,
        editBtn ? String(Math.round(editBtn.getBoundingClientRect().height)) : 'no edit btn')
    }

    // 筛选：只看「已撤销」→ 列表剩 1 张
    const decTab = $$('[data-dec="tab"]').find((b) => (b.textContent || '').trim().indexOf('已撤销') === 0)
    if (decTab) {
      // ⚠ reka-ui 的 TabsTrigger **只认 mousedown**（源码里只有 `onMousedown`，没有 click 处理）——
      //    合成 `.click()` 不带 mousedown，点了等于没点。真用户点鼠标天然先有 mousedown，所以
      //    这个坑只在测试里现形（与「遮罩关闭必须派发 mousedown」是同一类）。
      decTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      decTab.click()
      check('  筛「已撤销」后只剩死账（1 张）',
        await waitFor(() => $$('[data-dec="card"]').length === 1, 3000, 'dec filter'),
        'count=' + $$('[data-dec="card"]').length)
    } else {
      check('  「已撤销」筛选项存在', false, 'tab not found')
    }
    // ⚠ 合入（2026-10-12）：这一整段「决策卡」断言来自外部整包，与上面「死通道接回验收」是**两块独立**
    //   的断言 —— 冲突只是**位置重叠**（两边都往文件末尾追加），**两块都要留**，不许丢任何一边。

    // ══ 规划管理（2026-10-16 第 1 项）：「🗂 规划」弹窗三态 —— 列表 / 决策点留痕回看 / 新建落 IPC。
    //    四条通道真 preload 早就暴露、渲染层今天接（「电路铺好了开关没装」第二排开关）。
    //    假 preload plans 夹具：1 条「0.3.7 发版计划」（project=demo），2 决策点（dp_001 已定 / dp_002 待定）。
    {
      // ⚠ 2026-10-17 修断言前置（外部整包原写法 `clickText('看板')` + 300ms 直接取
      //   `#board.pv .tile` 恒红 4 条）：①「看板」不是项目页签的入口名（那条 nav 叫「项目」）；
      //   ②项目页签有三种摆法（项目墙/概览卡/主从）且**用户选择会落盘**，上一段断言切到过
      //   主从/概览卡，这里不能假定自己站在项目墙上；③本块要点的按钮挂在**主从**的
      //   详情面板 `.ms-detail .oacts` 里，所以先确保主从、选中演示项目。
      clickText('项目'); await sleep(700)
      const msTab = $$('.pagehead button.vsb').find((b) => (b.textContent || '').indexOf('主从') >= 0)
      if (msTab && !$('#board.pv .pv-ms')) { msTab.click(); await sleep(500) }
      const msLi = $$('#board.pv .pv-ms .ms-li').find((x) => (x.textContent || '').indexOf('演示项目') >= 0)
      if (msLi) { msLi.click(); await sleep(300) }
      const tileP = msLi || $('#board.pv .tile:not(.tile-add)')
      check('★ 进项目详情后有「🗂 规划」按钮（规划四通道的界面开关装上了）', await (async () => {
        if (!tileP) return false
        if (!msLi) tileP.click()
        const ok = await waitFor(() => !!$('#board.pv .ms-detail .oacts'), 4000, '进详情')
        return ok && $$('#board.pv .ms-detail .oacts button').some((b) => (b.textContent || '').indexOf('🗂') >= 0)
      })(), 'tile=' + ((tileP || {}).textContent || '').slice(0, 12))
      // 项目说明条（2026-10-16 批次第 2 项）：registry「说明」字段转正，详情页一句话定位
      check('★ 项目说明条显示（registry 说明字段透传到详情页）',
        !!$('#board.pv .ms-detail .ms-note')
        && (($('#board.pv .ms-detail .ms-note') || {}).textContent || '').indexOf('说明条转正断言') >= 0,
        (($('#board.pv .ms-detail .ms-note') || {}).textContent || '').slice(0, 24))
      // ══ 项目三字段就地编辑（2026-10-22 · 施工单包 06「13 行写回」）══════════
      // 判据：① 三行并列摆出来（不是只有说明一条）；② 编辑块就在页面上（不是设置页/弹窗链）；
      //      ③ 保存真调主进程、且**只提交改过的字段**；④ 撤销真写回旧值。
      const noteTxt = () => (($('#board.pv .ms-detail .ms-note') || {}).textContent || '').replace(/\s+/g, ' ')
      check('★★ 详情页把 状态 / 路线图 / 说明 三行都摆出来',
        !!$('#board.pv .ms-detail .ms-note') && $$('#board.pv .ms-detail .msn-row').length === 3,
        'rows=' + $$('#board.pv .ms-detail .msn-row').length)
      check('  三行的值来自 registry（不是占位符）',
        noteTxt().indexOf('活跃开发中（演示夹具）') >= 0 && noteTxt().indexOf('跑通第一单') >= 0,
        noteTxt().slice(0, 60))
      check('★★ 三字段两列对齐：三个值的左边缘在同一条竖线上（标签列宽固定，不是流水账）', (() => {
        const vs = $$('#board.pv .ms-detail .msn-v')
        if (vs.length < 2) return false
        const lefts = vs.map((v) => v.getBoundingClientRect().left)
        return lefts.every((l) => Math.abs(l - lefts[0]) < 1)
      })(), JSON.stringify($$('#board.pv .ms-detail .msn-v').map((v) => Math.round(v.getBoundingClientRect().left))))
      check('★ 编辑入口是一个按钮（06 单：不加设置页、不加确认弹窗链）',
        !!$('#board.pv .ms-detail .ms-editbtn') && !$('#board.pv .ms-detail .ms-fields'))
      check('★ 点「✎ 改状态 / 路线图 / 说明」→ 就地展开编辑块（不跳页、不弹窗）', await (async () => {
        const b = $('#board.pv .ms-detail .ms-editbtn')
        if (!b) return false
        b.click()
        return waitFor(() => !!$('#board.pv .ms-detail .ms-fields'), 4000, '编辑块')
      })())
      check('★★ 编辑块里值已填好（不是空白让人重打一遍）',
        $$('#board.pv .ms-detail .msf-i').length === 2
        && ($$('#board.pv .ms-detail .msf-i')[0] || {}).value === '活跃开发中（演示夹具）',
        JSON.stringify($$('#board.pv .ms-detail .msf-i').map((i) => i.value)))
      check('  编辑块出现时只读那条不再同时挂着（同一块内容不重复渲染）',
        !$('#board.pv .ms-detail .ms-note'))
      const saveRes = await (async () => {
        const f = $('#board.pv .ms-detail .ms-fields')
        if (!f) return { err: '没有编辑块' }
        const st = f.querySelectorAll('.msf-i')[0]
        st.value = '已改：新状态（夹具）'
        st.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(60)
        const saveBtn = Array.from(f.querySelectorAll('.msf-acts button')).find((b) => (b.textContent || '').indexOf('保存') >= 0)
        if (!saveBtn) return { err: '没有保存按钮' }
        const n0 = window.__fcTest.callCount('registryUpdateFields')
        saveBtn.click()
        const hit = await waitFor(() => window.__fcTest.callCount('registryUpdateFields') > n0, 4000, 'updateFields')
        if (!hit) return { err: '没调到 registryUpdateFields' }
        const c = window.__fcTest.calls().filter((x) => x.name === 'registryUpdateFields').pop()
        return { args: c.args }
      })()
      check('★★ 保存真调主进程 registryUpdateFields（不是在界面上自娱自乐）',
        !saveRes.err && saveRes.args && saveRes.args[0] === 'demo', JSON.stringify(saveRes))
      check('★★ 只提交真改过的那一个字段（状态），另两个不跟着写回',
        !saveRes.err && saveRes.args && Object.keys(saveRes.args[1] || {}).join(',') === '状态',
        !saveRes.err ? JSON.stringify(saveRes.args && saveRes.args[1]) : saveRes.err)
      check('★ 保存后详情页立刻显示新值（不用手动刷新）',
        await waitFor(() => noteTxt().indexOf('已改：新状态（夹具）') >= 0, 4000, '新值'), noteTxt().slice(0, 40))
      check('★ 保存后编辑块收起（不是原地留着让人以为没保存）', !$('#board.pv .ms-detail .ms-fields'))
      check('★★ 撤销条出现，且写明「哪个项目的哪些字段」', await waitFor(() => {
        const ub = $('#undo-bar')
        if (!ub) return false
        const t = (ub.textContent || '').replace(/\s+/g, ' ')
        return t.indexOf('演示项目') >= 0 && t.indexOf('状态') >= 0
      }, 4000, '撤销条'), (($('#undo-bar') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 40))
      check('★★ 点撤销 → 真写回旧值，字段回原样（撤销栈对 registry 改动同样生效）', await (async () => {
        const btn = Array.from($$('#undo-bar button')).find((b) => (b.textContent || '').indexOf('撤销') >= 0)
        if (!btn) return false
        const n0 = window.__fcTest.callCount('registryUpdateFields')
        btn.click()
        const hit = await waitFor(() => window.__fcTest.callCount('registryUpdateFields') > n0, 4000, '撤销写回')
        if (!hit) return false
        return waitFor(() => noteTxt().indexOf('活跃开发中（演示夹具）') >= 0, 4000, '回原值')
      })(), noteTxt().slice(0, 40))
      check('  撤销后用 before 写回的是**旧值本身**（不是清空/猜值）', await (async () => {
        const c = window.__fcTest.calls().filter((x) => x.name === 'registryUpdateFields').pop()
        return !!c && c.args[1] && c.args[1]['状态'] === '活跃开发中（演示夹具）'
      })(), JSON.stringify((window.__fcTest.calls().filter((x) => x.name === 'registryUpdateFields').pop() || {}).args))
      const plansBtn = $$('#board.pv .ms-detail .oacts button').find((b) => (b.textContent || '').indexOf('🗂') >= 0)
      if (plansBtn) {
        plansBtn.click()
        check('★★ 点「🗂 规划」→ 弹窗开 + 夹具规划进列表（listPlans 走通 + 按项目过滤）',
          await waitFor(() => !!$('#plans-modal') && $$('#plans-modal .plan-row').length === 1, 4000, 'plans list'),
          'rows=' + $$('#plans-modal .plan-row').length)
        check('  徽标显示「草稿」（plan_status=draft → 人话，不许英文露脸）',
          (($('#plans-modal .plan-badge[data-plan-status="draft"]') || {}).textContent || '').trim() === '草稿',
          (($('#plans-modal .plan-badge') || {}).textContent || '').trim())
        // ── 详情态：决策点选择 + 留痕回看 ──
        const seeDp = $$('#plans-modal button').find((b) => (b.textContent || '').indexOf('看决策点') >= 0)
        check('  「看决策点 →」在（列表 → 详情态入口）', !!seeDp)
        if (seeDp) {
          seeDp.click()
          check('★★ 详情态：2 个决策点都渲染（getPlan 走通）',
            await waitFor(() => $$('#plans-modal .plan-dp').length === 2, 4000, 'plan detail'),
            'dps=' + $$('#plans-modal .plan-dp').length)
          check('  已定决策点回看：「✓ 已选」+ 选项文本都在（dp_001 留痕显示）',
            (($('#plans-modal .plan-dp[data-dp-id="dp_001"]') || {}).textContent || '').indexOf('已选') >= 0
            && (($('#plans-modal .plan-dp[data-dp-id="dp_001"]') || {}).textContent || '').indexOf('端口=观测结果') >= 0)
          const friBtn = $$('#plans-modal .plan-dp[data-dp-id="dp_002"] button').find((b) => (b.textContent || '').trim() === '周五')
          check('  待定决策点的选项按钮在（周五 / 下周一）', !!friBtn)
          if (friBtn) {
            friBtn.click()
            check('★★ 点选项 → decidePlanPoint 走 IPC，重读后留痕显示「已选：周五」',
              await waitFor(() => (($('#plans-modal .plan-dp[data-dp-id="dp_002"]') || {}).textContent || '').indexOf('已选') >= 0
                && (($('#plans-modal .plan-dp[data-dp-id="dp_002"]') || {}).textContent || '').indexOf('周五') >= 0, 4000, 'decide dp'))
            check('  全定完提示出现（决策点全定完 → 规划自动转「进行中」的人话说明）',
              ($('#plans-modal').textContent || '').indexOf('决策点全定完') >= 0)
          }
          const backBtn = $$('#plans-modal button').find((b) => (b.textContent || '').indexOf('回列表') >= 0)
          if (backBtn) {
            backBtn.click()
            check('★★ 回列表徽标转「进行中」（全 decided → active，假 preload 同 main 语义）',
              await waitFor(() => !!$('#plans-modal .plan-badge[data-plan-status="active"]'), 4000, 'active badge'),
              'badge=' + (($('#plans-modal .plan-badge') || {}).textContent || '').trim())
          }
        }
        // ── 新建态：填表 → 建规划 → 载荷齐发 ──
        const newBtn = $$('#plans-modal button').find((b) => (b.textContent || '').indexOf('新建规划') >= 0)
        check('  「＋ 新建规划」在', !!newBtn)
        if (newBtn) {
          newBtn.click()
          await sleep(200)
          const ins = $$('#plans-modal input')
          const tas = $$('#plans-modal textarea')
          check('  表单态结构：标题/目标/决策点问题 input + 里程碑/选项 textarea',
            ins.length >= 3 && tas.length >= 2, `ins=${ins.length} tas=${tas.length}`)
          if (ins.length >= 3 && tas.length >= 2) {
            const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
            set(ins[0], '断言用规划')
            set(ins[1], '把规划管理收口')
            set(ins[2], '端口模型走哪版？')
            set(tas[1], '端口=配置项\n端口=观测结果')   // tas[0]=里程碑（刻意留空，断言空段过滤）
            await sleep(150)
            const mkBtn = $$('#plans-modal button').find((b) => (b.textContent || '').trim() === '建规划')
            check('  标题非空后「建规划」可点', !!mkBtn && !mkBtn.disabled)
            if (mkBtn) {
              mkBtn.click()
              check('★★ 建规划走 IPC 且列表多一条（createPlan → refresh 当场可见）',
                await waitFor(() => $$('#plans-modal .plan-row').length === 2, 4000, 'plan created'),
                'rows=' + $$('#plans-modal .plan-row').length)
              check('★ 建规划载荷齐发：title/project/objective/milestones/decisions 一起进 IPC（决策点空段被滤掉）',
                (() => {
                  const a = ((window.__fcTest.calls().filter((c) => c.name === 'createPlan').pop() || {}).args || [])[0] || {}
                  return a.title === '断言用规划' && a.project === 'demo' && a.objective === '把规划管理收口'
                    && Array.isArray(a.milestones) && a.milestones.length === 0
                    && Array.isArray(a.decisions) && a.decisions.length === 1
                    && a.decisions[0].question === '端口模型走哪版？' && a.decisions[0].options.length === 2
                })(), JSON.stringify(((window.__fcTest.calls().filter((c) => c.name === 'createPlan').pop() || {}).args || [])[0]))
            }
          }
        }
        const closeBtn = $$('#plans-modal button').find((b) => (b.textContent || '').trim() === '关闭')
        if (closeBtn) closeBtn.click()
        check('  「关闭」收弹窗', await waitFor(() => !$('#plans-modal'), 3000, 'close plans'))
      } else {
        check('「🗂 规划」按钮存在', false, 'no plansBtn')
      }
    }

    // ══ 随问（2026-10-22 · 施工单包 03 任务一）══════════════════════════════
    // 判据：① 页签里有「问」；② 常用问题文案来自主进程（界面不许自己写一份）；
    //      ③ 点预设 → 把**问题串原样**传下去；④ 结构化答案渲染结论/明细/来源；
    //      ⑤ needsLlm=false 时**不给**「交给 AI」按钮（结构化能答就别把成本口子敞着）；
    //      ⑥ needsLlm=true 才有，且**点了才**真调模型、花销当场印出来。
    {
      const askTab = $$('#views .vbtn').find((b) => (b.textContent || '').trim() === '问答')
      check('★ 页签行里有「问答」（两个字的说法才看得懂；一个「问」字会被当成"问号/帮助"）', !!askTab)
      if (askTab) {
        askTab.click()
        check('★ 点进「问答」→ 查询面渲染（输入框 + 常用问题）',
          await waitFor(() => !!$('#board.ask-view .ask-in') && $$('#board.ask-view .ask-chip').length > 0, 4000, 'ask view'))
        check('★★ 问答页是**纵向单栏**（几何门禁：标题/输入框区/月报表左边缘对齐、上下依次排）', (() => {
          // 2026-10-22 目检踩过两次：#board 是 flex 横排，不显式改成 block 会把
          // 「输入框区 / 答案 / 月报表」排成三列、挤在左边 1/3；改成 column 又会因为
          // 继承 align-items:flex-start 让各块按内容宽各排各的。只有 block 是确定的。
          const h = $('#board.ask-view .ask-head')
          const b = $('#board.ask-view .ask-box')
          const r = $('#board.ask-view .ask-report')
          if (!h || !b || !r) return false
          const rh = h.getBoundingClientRect(), rb = b.getBoundingClientRect(), rr = r.getBoundingClientRect()
          return Math.abs(rh.left - rb.left) < 1 && Math.abs(rb.left - rr.left) < 1
            && rb.top > rh.top && rr.top > rb.top
        })(), '取的 .ask-head / .ask-box / .ask-report 三块')
        check('★ 常用问题按组排（不是九个按钮挤一行、最后孤零零剩一个）',
          $$('#board.ask-view .ask-group').length >= 2, String($$('#board.ask-view .ask-group').length))
        check('  进视图就去主进程取常用问题（界面不自己写文案）',
          window.__fcTest.callCount('askPresets') >= 1, String(window.__fcTest.callCount('askPresets')))
        check('★ 常用问题够用（≥8 个快捷点选，03 单验收线）',
          $$('#board.ask-view .ask-chip').length >= 8, String($$('#board.ask-view .ask-chip').length))
        check('★ 空输入时「问」按钮是禁用的（不让点一个必然为空的查询）',
          !!$('#board.ask-view .ask-go') && $('#board.ask-view .ask-go').disabled === true)
        const oweChip = $$('#board.ask-view .ask-chip').find((b) => (b.textContent || '').trim() === '欠着什么')
        check('  有「欠着什么」这个常用问题（最常用的一条）', !!oweChip)
        if (oweChip) {
          const n0 = window.__fcTest.callCount('askQuery')
          oweChip.click()
          const hit = await waitFor(() => window.__fcTest.callCount('askQuery') > n0, 4000, 'askQuery')
          const last = window.__fcTest.calls().filter((c) => c.name === 'askQuery').pop()
          check('★★ 点预设 → 真调 askQuery，且**原样**传问题串（不是传 label）',
            hit && last && last.args[0] === '欠着什么',
            hit ? JSON.stringify(last && last.args) : 'no call')
          check('★ 结构化答案渲染出来：结论 + 明细 + 来源',
            await waitFor(() => {
              const a = $('#board.ask-view .ask-ans')
              if (!a) return false
              return !!a.querySelector('.ask-title') && a.querySelectorAll('.ask-item').length >= 1
                && ((a.querySelector('.ask-src') || {}).textContent || '').indexOf('项目登记表') >= 0
            }, 4000, 'answer'),
            (($('#board.ask-view .ask-ans') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 60))
          check('★★ needsLlm=false 的答案**不给**「交给 AI」按钮（能结构化答就别敞着成本口子）',
            !$('#board.ask-view .ask-llm-btn:not(.ask-batch-btn)'))
        }
        const llmBefore = window.__fcTest.callCount('llmAsk')
        const askIn = $('#board.ask-view .ask-in')
        askIn.value = '你觉得这个方向对不对'
        askIn.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(80)
        $('#board.ask-view .ask-go').click()
        check('★ 含糊句 → 出现「交给 AI 答（会花 token）」按钮',
          await waitFor(() => !!$('#board.ask-view .ask-llm-btn:not(.ask-batch-btn)'), 4000, 'llm btn'),
          (($('#board.ask-view .ask-ans') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 50))
        check('★★ 光问不点 → **一次模型都没调**（结构化答不了也不许偷偷烧钱）',
          window.__fcTest.callCount('llmAsk') === llmBefore, String(window.__fcTest.callCount('llmAsk')))
        const llmBtn = $('#board.ask-view .ask-llm-btn:not(.ask-batch-btn)')
        if (llmBtn) {
          llmBtn.click()
          check('★★ 点「交给 AI 答」才真调 llmAsk', await waitFor(() => window.__fcTest.callCount('llmAsk') > llmBefore, 4000, 'llmAsk'))
          const lastLlm = window.__fcTest.calls().filter((c) => c.name === 'llmAsk').pop()
          check('  传给 AI 的是**同一个问题串**（不是 chip 的 label）',
            !!lastLlm && lastLlm.args[0] === '你觉得这个方向对不对', JSON.stringify(lastLlm && lastLlm.args))
          check('★ AI 回答连同**花销**一起显示（03 单：花销每次可见）',
            await waitFor(() => {
              const t = ($('#board.ask-view .ask-llm-ans') || {}).textContent || ''
              return t.indexOf('AI 回答夹具') >= 0 && t.indexOf('321') >= 0
            }, 4000, 'llm ans'),
            (($('#board.ask-view .ask-llm-ans') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 60))
        }
        // ── 随纠（2026-10-22 · 03 任务二）：从答案直接改这个项目的方向 ──────
        // 判据：有项目才有入口；一句话 → 真调 correctApply（参数齐全且不填表单）；
        //      改完挂撤销条；撤销把**旧值**原样传回去；含糊句（无项目）→ 不给纠偏入口。
        check('★ 答案命中了项目 → 出现「✎ 一句话改掉…」入口', await (async () => {
          // 必须用**点名了项目**的问题：问「欠着什么」不指名时 projectId 为空 ——
          // 那种情况下不给纠偏入口才对（没有目标就无从纠），所以这里走 progress 那条。
          const ins = $$('#board.ask-view .ask-in')
          if (!ins.length) return false
          ins[0].value = '演示项目到哪了'
          ins[0].dispatchEvent(new Event('input', { bubbles: true }))
          await sleep(80)
          const go = $('#board.ask-view .ask-go')
          if (!go) return false
          go.click()
          return waitFor(() => {
            const a = $('#board.ask-view .ask-ans')
            return !!a && !!a.querySelector('.ask-correct-open')
          }, 4000, '纠偏入口')
        })())
        check('★ 点入口 → 就地出输入框（不跳页、不弹窗）', await (async () => {
          const b = $('#board.ask-view .ask-correct-open')
          if (!b) return false
          b.click()
          return waitFor(() => !!$('#board.ask-view .ask-correct-row .ask-in'), 3000, '纠偏输入框')
        })())
        check('★ 空输入时「就这么改」是禁用的', await (async () => {
          const btns = $$('#board.ask-view .ask-correct-row button')
          const go = btns.find((b) => (b.textContent || '').indexOf('就这么改') >= 0)
          return !!go && go.disabled === true
        })())
        const correctRes = await (async () => {
          const ins = $$('#board.ask-view .ask-correct-row .ask-in')
          if (!ins.length) return { err: '没有输入框' }
          ins[0].value = '改 路线图 为 新路线（夹具）'
          ins[0].dispatchEvent(new Event('input', { bubbles: true }))
          await sleep(80)
          const go = $$('#board.ask-view .ask-correct-row button').find((b) => (b.textContent || '').indexOf('就这么改') >= 0)
          if (!go) return { err: '没有提交按钮' }
          const n0 = window.__fcTest.callCount('correctApply')
          go.click()
          const hit = await waitFor(() => window.__fcTest.callCount('correctApply') > n0, 4000, 'correctApply')
          return { hit, args: (window.__fcTest.calls().filter((c) => c.name === 'correctApply').pop() || {}).args }
        })()
        check('★★ 一句话 → 真调 correctApply，问题串原样 + 项目 id 一起传（不填表单）',
          !correctRes.err && correctRes.hit && correctRes.args
          && correctRes.args[0] === '改 路线图 为 新路线（夹具）' && correctRes.args[1] === 'demo',
          JSON.stringify(correctRes))
        check('★★ 改完挂撤销条，且写明改了什么', await waitFor(() => {
          const ub = $('#undo-bar')
          if (!ub) return false
          const t = (ub.textContent || '').replace(/\s+/g, ' ')
          return t.indexOf('已改') >= 0 && t.indexOf('路线图') >= 0
        }, 4000, '纠偏撤销条'), (($('#undo-bar') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 60))
        check('★★ 点撤销 → correctUndo 收到的是**旧值本身**（不是让主进程去猜）', await (async () => {
          const btn = Array.from($$('#undo-bar button')).find((b) => (b.textContent || '').indexOf('撤销') >= 0)
          if (!btn) return false
          const n0 = window.__fcTest.callCount('correctUndo')
          btn.click()
          const hit = await waitFor(() => window.__fcTest.callCount('correctUndo') > n0, 4000, 'correctUndo')
          if (!hit) return false
          const a = (window.__fcTest.calls().filter((c) => c.name === 'correctUndo').pop() || {}).args[0] || {}
          return a.projectId === 'demo' && a.field === '路线图' && a.before === '跑通第一单' && a.decisionId === 'dec-e2e-1'
        })(), JSON.stringify((window.__fcTest.calls().filter((c) => c.name === 'correctUndo').pop() || {}).args))
        // ── 出单（2026-10-22 · 03 任务三）：从台账派生下一批待审批卡 ──────────
        check('★ 有项目的答案 → 出现「出下一批任务卡」入口（标了会花 token）', await (async () => {
          // 上一步改完撤销后 askQ 还是「演示项目到哪了」，答案带 projectId
          return waitFor(() => {
            const btn = $$('#board.ask-view .ask-foot button')
              .find((b) => (b.textContent || '').indexOf('出下一批') >= 0)
            return !!btn && (btn.textContent || '').indexOf('会计费') >= 0
          }, 4000, '出单入口')
        })())
        check('★★ 点出单 → 真调 llmPlanBatch，项目 id 传对；toast 说清出了几张 + 花销', await (async () => {
          const btn = $$('#board.ask-view .ask-foot button')
            .find((b) => (b.textContent || '').indexOf('出下一批') >= 0)
          if (!btn) return false
          const n0 = window.__fcTest.callCount('llmPlanBatch')
          btn.click()
          const hit = await waitFor(() => window.__fcTest.callCount('llmPlanBatch') > n0, 4000, 'llmPlanBatch')
          if (!hit) return false
          const a = (window.__fcTest.calls().filter((c) => c.name === 'llmPlanBatch').pop() || {}).args
          if (!a || a[0] !== 'demo') return false
          return waitFor(() => {
            const t = ($('#toast') || {}).textContent || ''
            return t.indexOf('2 张') >= 0 && t.indexOf('待审批') >= 0 && t.indexOf('999') >= 0
          }, 4000, '出单 toast')
        })(), (($('#toast') || {}).textContent || '').slice(0, 60))

        // 含糊句（没有 projectId）→ 不许给纠偏入口（没有目标就无从纠）
        const askIn2 = $('#board.ask-view .ask-in')
        askIn2.value = '你觉得这个方向对不对'
        askIn2.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(80)
        $('#board.ask-view .ask-go').click()
        check('★ 含糊句（没命中项目）→ 不给纠偏入口（没有目标就无从纠）',
          await waitFor(() => {
            const a = $('#board.ask-view .ask-ans')
            return !!a && (a.textContent || '').indexOf('答不了') >= 0
          }, 4000, 'vague') && !$('#board.ask-view .ask-correct-open'))
        check('★ 含糊句同样不给「出下一批」入口（出单得先说清给哪个项目出）',
          !$('#board.ask-view .ask-batch-btn'))
        // 回到「欠着什么」，后面的报表断言要看这一屏
        const chipBack = $$('#board.ask-view .ask-chip').find((b) => (b.textContent || '').trim() === '欠着什么')
        if (chipBack) { chipBack.click(); await sleep(400) }

        // ── 月度花销报表（2026-10-22 · 03 任务三）：常驻在这一页，不用翻设置页 ──
        check('★ 月度花销报表常驻在「问」页底部',
          await waitFor(() => $$('#board.ask-view .ask-report').length === 1, 4000, 'report'),
          String($$('#board.ask-view .ask-report').length))
        const rp = (($('#board.ask-view .ask-report') || {}).textContent || '').replace(/\s+/g, ' ')
        check('★ 按月列（两个月两行，token 带千分位）',
          $$('#board.ask-view .ask-report-row').length === 2
          && rp.indexOf('2026-10') >= 0 && rp.indexOf('1,300') >= 0, rp.slice(0, 80))
        check('★ 没给用量数字的那次明说「只计数」（不拿字符数折算 token）',
          rp.indexOf('没给数字') >= 0, rp.slice(0, 100))

        // ── 逐笔金额（2026-10-25 卡 005 B 档）────────────────────────────────
        // 有金额就写「≈ ¥X」并带上"还有几笔没折算"；一笔都没有就写「未折算」。
        // ⚠ 绝不出现「¥0」：那会把"没数据"说成"没花钱"。
        {
          const rows = $$('#board.ask-view .ask-report-row')
          const t10 = rows[0] ? (rows[0].textContent || '') : ''
          const t09 = rows[1] ? (rows[1].textContent || '') : ''
          check('★★ 有金额的月显示「≈ ¥0.42」（夹具真身，不是写死的）', t10.indexOf('¥0.42') >= 0, t10)
          check('★★ 同一行点名还有 1 笔未折算（否则金额像全量账）', t10.indexOf('1 次未折算') >= 0, t10)
          check('★★ 一笔金额都没有的月写「未折算」，**不许写 ¥0**',
            t09.indexOf('未折算') >= 0 && t09.indexOf('¥') < 0, t09)
          // 外部上报（MCP usage_report）必须**单列**，不许混进"方寸自己的账"
          check('★★ 有外部上报的月点名「其中 1 笔是外部上报」', t10.indexOf('其中 1 笔是外部上报') >= 0, t10)
          check('  没有外部上报的月不出现这句（不留空话）', t09.indexOf('外部上报') < 0, t09)
          const rh = (($('#board.ask-view .ask-report-h') || {}).textContent || '')
          check('★★ 标题里的口径说清"外部上报另计、不混算"',
            rh.indexOf('外部客户端经 MCP 上报的另计') >= 0, rh.slice(0, 100))
        }

        // ── 账户口径 · 余额差值（2026-10-25 卡 005）──────────────────────────
        // 暮雨给的参考实现（DSH 小鲸鱼）点破关键：金额准不是因为价格表准，而是
        // **根本不经过价格表** —— 余额下降额就是真扣的钱。所以这块必须：
        // ① 标题写清来源；② 消费与充值分开；③ 明说"归不到具体某一次调用"；④ 没有接口就说没有。
        {
          const acc = () => $('#board.ask-view .ask-acc')
          check('★★ 问答页底部有「账户口径 · 余额差值」块（不是只有 token）', !!acc())
          const at = ((acc() || {}).textContent || '').replace(/\s+/g, ' ')
          check('★★ 标题写明来源：「来自供应商余额接口，不是按 token 估算」',
            at.indexOf('余额差值') >= 0 && at.indexOf('不是按 token 估算') >= 0, at.slice(0, 80))
          check('★★ 账户真实扣款显示出来了（夹具 3.60 CNY）',
            at.indexOf('已观测消费') >= 0 && at.indexOf('3.60') >= 0 && at.indexOf('CNY') >= 0, at.slice(0, 90))
          check('★ 充值单列（100.00），不与消费混成一个数',
            at.indexOf('充值') >= 0 && at.indexOf('100.00') >= 0, at.slice(0, 110))
          check('★★ 明说粒度代价：**归不到具体某一次调用**（这句不许省）',
            at.indexOf('归不到具体某一次调用') >= 0, at.slice(-80))

          const n0 = window.__fcTest.callCount('llmBalanceObserve')
          const btn = $('#board.ask-view .ask-acc-btn')
          check('★ 有「⟳ 立刻查一次」按钮（不想等下次调用也能核）', !!btn)
          if (btn) {
            btn.click()
            await sleep(700)
            check('★★ 点它真的发请求', window.__fcTest.callCount('llmBalanceObserve') > n0,
              n0 + ' → ' + window.__fcTest.callCount('llmBalanceObserve'))
            const at2 = ((acc() || {}).textContent || '').replace(/\s+/g, ' ')
            check('★★ 查完数字跟着变（3.60 → 4.80，不是只弹一句 toast）',
              at2.indexOf('4.80') >= 0, at2.slice(0, 90))
            const tst = (($('#toast') || {}).textContent || '')
            check('  同时把本次观测结果说清（消费多少 / 余额多少）',
              tst.indexOf('消费') >= 0 && tst.indexOf('195.20') >= 0, tst.slice(0, 70))
          }

          // 降级：多数中转 / MiMo 根本没有余额接口 —— 这条路径必须验，否则上线就被当成"坏了"
          window.__fcTest.setBalanceUnsupported(true)
          clickText('看板'); await sleep(500)
          clickText('问答'); await sleep(900)
          const at3 = ((($('#board.ask-view .ask-acc') || {}).textContent) || '').replace(/\s+/g, ' ')
          check('★★ 端点没有余额接口时：如实说原因，不编数字',
            at3.indexOf('没有官方余额接口') >= 0, at3.slice(0, 90))
          check('★★ 而且**不显示**「已观测消费」（半个字都不许让人误会）',
            at3.indexOf('已观测消费') < 0 && at3.indexOf('0.00') < 0, at3.slice(0, 90))
          check('  也没有「立刻查一次」按钮（查不了就别给按钮）',
            !$('#board.ask-view .ask-acc-btn'))
          window.__fcTest.setBalanceUnsupported(false)
        }
      }
    }

    // ══ 帮助手册视图（2026-10-12 暮雨第 4 条：「想加其他主按钮，比如首页、帮助手册、同步」）
    //    它只从**顶栏「?」**进入（页签行不重复放一个）—— 这里就按用户的真实路径点。
    {
      const helpBtn = $('#bar .navgroup button[title*="帮助"]')
      check('★ 顶栏「? 帮助」按钮点得动（先把视图切回看板，确保有可回退来源）',
        !!helpBtn && (clickText('看板'), true), helpBtn ? 'yes' : 'no helpBtn')
      if (helpBtn) {
        helpBtn.click()
        check('★★ 点「?」真的进了帮助手册视图（.help-view 渲染出来）',
          await waitFor(() => !!$('.help-view'), 4000, 'help view'))
        check('  手册里确实有内容（不是空壳）：至少 5 节 + 至少 2 张表',
          $$('.help-view .help-sec').length >= 5 && $$('.help-view .help-table').length >= 2,
          'secs=' + $$('.help-view .help-sec').length + ' tables=' + $$('.help-view .help-table').length)
        check('  手册讲清了搜索语法（含 due: 这种真实可用的写法）',
          $$('.help-view').length && ($('.help-view').textContent || '').indexOf('due:') >= 0)
        check('  ★ 帮助**不在页签行里重复出现**（入口唯一：顶栏「?」）',
          !$$('nav#views .vbtn').some((b) => (b.textContent || '').indexOf('帮助') >= 0),
          $$('nav#views .vbtn').map((b) => b.textContent.trim()).join('/'))
        // 返回：帮助是走 navigateTo 进的，所以「← 返回」应当能把我们送回看板
        const back = $('.nav-back')
        if (back) {
          back.click()
          check('★★ 「← 返回」能从帮助视图退回上一视图（返回栈真的接了帮助）',
            await waitFor(() => !$('.help-view'), 4000, 'back from help'))
        }
      }
      // 首页：切到别的视图 → 点 ⌂ → 必须回看板
      await openViewTab('服务')
      const homeBtn = $('#bar .navgroup button[title*="首页"]')
      if (homeBtn) {
        homeBtn.click()
        check('★★ 点「⌂ 首页」回到看板（不是只切视图 —— 搜索/筛选也一起复位）',
          await waitFor(() => !$('.services-view') && !$('.help-view'), 4000, 'goHome'))
      } else {
        check('  ⌂ 首页按钮存在', false, 'no homeBtn')
      }
      // 同步：暮雨 2026-10-12「只做按钮，状态由它自己报」——
      // 判据两条：① 真调 backupGitPush（不是假按钮）；② 调完按钮**回到可点**（不许卡在"进行中"）。
      const syncBtn = $('#bar .navgroup button[title*="同步"]')
      if (syncBtn) {
        const beforeSync = window.__fcTest.callCount('backupGitPush')
        syncBtn.click()
        check('★★ 点「⟳ 同步」真调 backupGitPush（不是个看着像按钮的装饰）',
          await waitFor(() => window.__fcTest.callCount('backupGitPush') > beforeSync, 4000, 'backupGitPush'),
          'calls=' + window.__fcTest.callCount('backupGitPush'))
        check('  跑完之后按钮**回到可点**（不许永久卡在"进行中"）',
          await waitFor(() => {
            const b = $('#bar .navgroup button[title*="同步"]')
            return !!b && b.disabled !== true
          }, 4000, 'sync done'))
        // ★★ 2026-10-16 用户第 9 条：同步时「整个方块都在旋转，把我气笑了」——
        //    真因是动画挂在 button 本体（.ico.syncing）上，边框与底色跟着一起转。
        //    判据：⟳ 必须单独包在 .ico-glyph 里（动画挂字符，按钮本体不动）。
        {
          const b = $('#bar .navgroup button[title*="同步"]')
          const g = b && b.querySelector('.ico-glyph')
          // 2026-10-25 卡 004：同步结束后按钮先在**结束态**停 3 秒（✓ 已同步 / ⚠ 未同步），
          // 再回 ⟳。所以这里必须等它回图标再断言字符 —— 否则抓到的是结束态字形（假红，
          // 本行就是这么红的：glyph=⚠）。等不到也要显式失败，不许跳过。
          const back = await waitFor(() => {
            const gg = $('#bar .navgroup .sync-btn .ico-glyph')
            return !!gg && gg.textContent.trim() === '⟳'
          }, 4500, 'sync glyph back to arrow')
          check('★★ 同步按钮的 ⟳ 单独包在 .ico-glyph 里（旋转的是字符，不是整个方块）',
            !!g && back, (g ? 'glyph=' + g.textContent.trim() : 'no .ico-glyph') + ' back=' + back)
        }
      } else {
        check('  ⟳ 同步按钮存在', false, 'no syncBtn')
      }
    }

    // ══ 日志页「清理归档…」接线（2026-10-13 暮雨第 2 条）════════════════════
    //  后台逻辑在 e2e-logs 里真跑；这里只验**按钮真接线**：假 preload 缺键 / 通道名打错
    //  → 预览永远 0 条，是"看着像按钮的装饰"（check-ipc-parity 抓不到这种）。
    {
      window.__fcTest.setLogs([
        { id: 'log-p1', title: '老归档', project: 'demo', status: 'archived', created: '2026-09-01T00:00:00.000Z', content: 'x' },
        { id: 'log-p2', title: '新归档', project: 'demo', status: 'archived', created: '2026-10-05T00:00:00.000Z', content: 'y' },
        { id: 'log-p3', title: '还在跑', project: 'demo', status: 'active', running: true, created: '2026-09-01T00:00:00.000Z', content: 'z' },
      ])
      clickText('看板'); await sleep(300)
      clickText('日志'); await sleep(500)
      window.__fcTest.reset()
      check('  日志页有「清理归档…」入口', clickText('清理归档…'))
      await sleep(300)
      check('★★ 点开「清理归档…」弹出清理框（#log-purge-modal）',
        await waitFor(() => !!$('#log-purge-modal'), 3000, 'log-purge-modal'))
      // 日期设成 2026-10-01：只该命中 9-01 的老归档（10-05 那条"新"、active 那条都不算）
      const dateInput = $('#log-purge-modal input[type="date"]')
      if (dateInput) {
        dateInput.value = '2026-10-01'
        dateInput.dispatchEvent(new Event('input', { bubbles: true }))
        dateInput.dispatchEvent(new Event('change', { bubbles: true }))
      }
      await sleep(200)
      const pv = $$('#log-purge-modal button').find((b) => (b.textContent || '').indexOf('预览命中') >= 0)
      if (pv) pv.click()
      check('★★ 点「预览命中」真调 logsPurgeArchived 且 dryRun=true（不是装饰按钮）',
        await waitFor(() => window.__fcTest.calls().some((c) => c.name === 'logsPurgeArchived' && c.args[1] && c.args[1].dryRun === true), 4000, 'purge dryRun'),
        JSON.stringify(window.__fcTest.calls().filter((c) => c.name === 'logsPurgeArchived').map((c) => c.args)))
      check('★ 预览按日期报出命中 1 条（只有 9-01 那条老归档）',
        await waitFor(() => { const e = $('#log-purge-modal .lpurge-preview'); return !!e && e.textContent.indexOf('将清理 1 条') >= 0 }, 3000, 'preview count'),
        ($('#log-purge-modal .lpurge-preview') || {}).textContent)
      check('★★ 预览是纯读：三条日志一条没少（dryRun 不许动 store）',
        window.__fcTest.logs().length === 3, 'logs=' + window.__fcTest.logs().length)
      // 确认清理：走原生 confirm 二次确认（无头环境把它桩成通过）
      const realConfirm = window.confirm
      window.confirm = () => true
      const go = $$('#log-purge-modal button').find((b) => (b.textContent || '').indexOf('确认清理') >= 0)
      if (go) go.click()
      check('★★ 点「确认清理」真删：发出 dryRun=false 且日志只剩 2 条（老归档被移走）',
        await waitFor(() => window.__fcTest.logs().length === 2
          && window.__fcTest.calls().some((c) => c.name === 'logsPurgeArchived' && c.args[1] && c.args[1].dryRun === false), 4000, 'purge real'),
        'logs=' + window.__fcTest.logs().length + ' | ' + JSON.stringify(window.__fcTest.logs().map((l) => l.id)))
      window.confirm = realConfirm
      check('  清理完自动关上清理框', await waitFor(() => !$('#log-purge-modal'), 2000, 'modal closed'))
    }

    // ══ 日志页「清理超期」→ toast 说清条数（2026-10-23 补）
    //  此前这条**没法验**：假 preload 的 logsCleanup 恒返回空数组，界面永远只走
    //  「没有超期日志」那一支，`已将 N 条…` 里的 N 从来没不是 0。
    //  桩补上两条 id 之后，这条才真正可断言（空集上的断言等于没写）。
    {
      const n0 = window.__fcTest.callCount('logsCleanup')
      const btn = $$('.logs-view button').find((b) => (b.textContent || '').trim() === '清理超期')
      check('  日志页有「清理超期」入口', !!btn)
      if (btn) {
        btn.click()
        check('★★ 点「清理超期」真调 logsCleanup（不是看着像按钮的装饰）',
          await waitFor(() => window.__fcTest.callCount('logsCleanup') > n0, 4000, 'logsCleanup'),
          'before=' + n0 + ' after=' + window.__fcTest.callCount('logsCleanup'))
        check('★★ toast 说出**条数**（2 条），而不是糊成「没有超期日志」',
          await waitFor(() => (($('#toast') || {}).textContent || '').indexOf('已将 2 条') >= 0, 4000, 'cleanup toast'),
          (($('#toast') || {}).textContent || '').slice(0, 60))
      }
    }

    // ══ 项目说明卡内嵌架构图（2026-10-13 暮雨第 2 条 · 方案 A）════════════════
    //  纯函数本身在 e2e-layer-diagram 里真跑；这里验的是**接线**：任务 previewTask.architecture
    //  → JSON.parse → buildLayerDiagram → v-html。坏 JSON 必须说人话（不静默留白）。
    {
      const ARCH = {
        lanes: [
          { name: '客户端层', cards: [{ label: 'Web App' }] },
          { name: '核心层', color: 'success', cards: [{ label: '用户' }] },
        ],
        between: ['HTTP / WSS'], width: 680, caption: '单测架构',
      }
      const saved = window.__fcTest.tasks()
      window.__fcTest.setTasks([
        {
          id: 'task-arch-1', title: '项目说明：带架构图', status: '待办', priority: '中', project: 'demo',
          tags: [], body: '', architecture: JSON.stringify(ARCH),
          fm: { id: 'task-arch-1', title: '项目说明：带架构图', status: '待办', priority: '中', project: 'demo' },
          path: 'C:/mock/task-data/task-arch-1.md',
        },
      ])
      clickText('看板'); await sleep(400)
      const card = $$('#board .card, #board .brow').find((c) => (c.textContent || '').indexOf('带架构图') >= 0)
      check('  带架构图的任务渲染到看板上', !!card)
      if (card) card.click()
      check('★★ 打开详情后架构图真的画出来了（#roverlay 里出现 .arch-svg svg）',
        await waitFor(() => !!$('#roverlay .arch-svg svg'), 4000, 'arch svg'),
        (($('#roverlay .arch-section') || {}).textContent || '').slice(0, 80))
      check('★ 图里带着 spec 的层名与层间协议标注（不是画了个空壳）',
        !!$('#roverlay .arch-svg') && $('#roverlay .arch-svg').innerHTML.indexOf('客户端层') >= 0
        && $('#roverlay .arch-svg').innerHTML.indexOf('HTTP / WSS') >= 0)
      maskClick('#roverlay'); await sleep(200)

      // 坏 JSON：必须说人话，不许静默留白（否则用户以为"填了没生效"）
      window.__fcTest.setTasks([
        {
          id: 'task-arch-2', title: '项目说明：架构图坏了', status: '待办', priority: '中', project: 'demo',
          tags: [], body: '', architecture: '{这不是 JSON',
          fm: { id: 'task-arch-2', title: '项目说明：架构图坏了', status: '待办', priority: '中', project: 'demo' },
          path: 'C:/mock/task-data/task-arch-2.md',
        },
      ])
      clickText('看板'); await sleep(400)
      const card2 = $$('#board .card, #board .brow').find((c) => (c.textContent || '').indexOf('架构图坏了') >= 0)
      if (card2) card2.click()
      check('★★ 架构图 JSON 坏了 → 界面说人话（.arch-error），不静默留白',
        await waitFor(() => !!$('#roverlay .arch-error'), 4000, 'arch error'),
        (($('#roverlay .arch-section') || {}).textContent || '').slice(0, 80))
      maskClick('#roverlay'); await sleep(200)

      // ── archify 技能卡（2026-10-14 中长期清单第 9 条）─────────────────────
      //  它和方寸的分层图**不是一回事**。界面要：① 不硬转（硬转会丢信息）
      //  ② **不许误报「JSON 读不出来」**（JSON 明明是好的，只是格式不同 —— 那是误导）
      //  ③ 照实说明它是什么，并把图型/条目数摊开。
      const ARCHIFY = {
        schema_version: 1, diagram_type: 'architecture',
        meta: { title: '验证用架构图', views: [{ id: 'v1', label: '主路径' }] },
        components: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        connections: [{ from: 'a', to: 'b' }],
      }
      window.__fcTest.setTasks([
        {
          id: 'task-arch-3', title: '项目说明：archify 导入卡', status: '待办', priority: '中', project: 'demo',
          tags: [], body: '', architecture: JSON.stringify(ARCHIFY),
          fm: { id: 'task-arch-3', title: '项目说明：archify 导入卡', status: '待办', priority: '中', project: 'demo' },
          path: 'C:/mock/task-data/task-arch-3.md',
        },
      ])
      clickText('看板'); await sleep(400)
      const card3 = $$('#board .card, #board .brow').find((c) => (c.textContent || '').indexOf('archify 导入卡') >= 0)
      if (card3) card3.click()
      const gotArchify = await waitFor(() => !!$('#roverlay .arch-archify'), 4000, 'archify 提示')
      const archTxt = gotArchify && $('#roverlay .arch-archify') ? ($('#roverlay .arch-archify').textContent || '') : ''
      check('★★ archify 卡不误报「JSON 读不出来」—— 照实说明格式不同，也不硬画图',
        gotArchify && !$('#roverlay .arch-error:not(.arch-archify)') && archTxt.indexOf('archify') >= 0,
        archTxt.slice(0, 110))
      check('  提示里带出图型与条目数（不是一句干话），并指向正文摘要 + 架构字段',
        archTxt.indexOf('architecture') >= 0 && archTxt.indexOf('components 2') >= 0
        && archTxt.indexOf('架构') >= 0, archTxt.slice(0, 110))
      maskClick('#roverlay'); await sleep(200)

      window.__fcTest.setTasks(saved)
      clickText('看板'); await sleep(200)
    }

    // ══ 「架构图」字段的条件显示（2026-10-13 暮雨第 3 条）════════════════════
    //  规格：只在「填过值」或「项目说明卡」（标签/标题）时才出现在编辑器里。
    //  ⚠ 隐藏 ≠ 丢值：保存仍按全量 spec 收集（这条另有 e2e-task-fields 兜底）。
    {
      const ARCHV = '{"lanes":[{"name":"层","cards":[{"label":"A"}]}],"width":680}'
      const saved = window.__fcTest.tasks()
      // ⚠ 表单读的是 `task.fm[key]`（taskToFormValues 只认 fm，不认扁平键）——
      //   夹具必须照真身形状把字段同时放进 fm 与顶层，否则断言验的是"夹具写错了"。
      const mkT = (id, title, extra) => Object.assign({}, {
        id, title, status: '待办', priority: '中', project: 'demo', tags: [], body: '',
      }, extra || {}, {
        fm: Object.assign({ id, title, status: '待办', priority: '中', project: 'demo' }, extra || {}),
        path: 'C:/mock/task-data/' + id + '.md',
      })
      window.__fcTest.setTasks([
        mkT('task-vis-1', '普通卡'),
        mkT('task-vis-2', '项目说明：测试卡', { tags: ['项目说明'] }),
        mkT('task-vis-3', '带值的卡', { architecture: ARCHV }),
      ])
      clickText('看板'); await sleep(400)

      const labelsFor = async (titlePart) => {
        const card = $$('#board .card, #board .brow').find((c) => (c.textContent || '').indexOf(titlePart) >= 0)
        if (!card) return null
        card.click()
        if (!await waitFor(() => !!$('#roverlay'), 3000, 'roverlay')) return null
        const eb = $$('#rmodal button').find((b) => (b.textContent || '').indexOf('编辑') >= 0)
        if (!eb) return null
        eb.click()
        if (!await waitFor(() => !!$('#modal-overlay'), 3000, 'modal-overlay')) return null
        const labels = $$('#modal .tf-field label').map((l) => (l.textContent || '').trim())
        const cxl = $$('#modal button').find((b) => (b.textContent || '').trim() === '取消')
        if (cxl) cxl.click()
        await sleep(200)
        if ($('#modal-overlay')) maskClick('#modal-overlay')
        await sleep(200)
        if ($('#roverlay')) maskClick('#roverlay')
        await sleep(200)
        return labels
      }

      const l1 = await labelsFor('普通卡')
      check('★★ 普通卡编辑器里没有「架构图」（不是每张卡都塞一个空文本框）',
        !!l1 && !l1.includes('架构图'), JSON.stringify(l1 && l1.slice(-4)))
      const l2 = await labelsFor('项目说明：测试卡')
      check('★★ 项目说明卡里出现「架构图」字段（标签命中）',
        !!l2 && l2.includes('架构图'), JSON.stringify(l2 && l2.slice(-4)))
      const l3 = await labelsFor('带值的卡')
      check('★★ 填过值的卡也显示「架构图」（填过就还在，不因没标签而藏起来）',
        !!l3 && l3.includes('架构图'), JSON.stringify(l3 && l3.slice(-4)))

      window.__fcTest.setTasks(saved)
      clickText('看板'); await sleep(200)
    }

    // ══ 启动台 / 服务页（2026-10-16 用户第 2 条：启动台是快捷入口，不是服务管理）══
    // 用户原话给的类比：「这玩意本质是类似 steam 启动非 steam 游戏的快捷启动入口，
    //   玩家自愿使用，方寸本身不提供服务，只提供集成快捷入口。」
    // 所以这一节钉两件事：
    //   ① 启动台 = 纯启动器：点卡片就开，卡片上**不出现端口**（端口不属于这里）；
    //   ② 服务页 = 纯端口监控：**不再**列启动台应用（那块已搬走），只留"已登记 + 方寸扫到的"。
    {
      await openViewTab('启动台')
      const lpCards = $$('.lp-card')
      check('★ 启动台渲染出登记的卡片（夹具 2 张）', lpCards.length === 2, 'cards=' + lpCards.length)

      if (lpCards.length) {
        // ① 点卡片正文 = 启动
        const before = window.__fcTest.callCount('launchpadLaunchApp')
        const info = lpCards[0].querySelector('.lp-info')
        ;(info || lpCards[0]).click()
        check('★★ 启动台：**点卡片正文 = 启动**（真调 launchpadLaunchApp，不是打开编辑框）',
          await waitFor(() => window.__fcTest.callCount('launchpadLaunchApp') > before, 3000, 'lp launch'),
          'calls=' + window.__fcTest.callCount('launchpadLaunchApp'))
        check('★★ 启动台：点卡片**不**弹出编辑框（编辑挪到独立按钮）',
          !$('#app-edit-overlay'), 'edit overlay open')

        // ② 独立的编辑按钮：点它打开编辑框，且**不**触发启动
        const editBtn = lpCards[1] && lpCards[1].querySelector('.lp-edit')
        if (editBtn) {
          const beforeE = window.__fcTest.callCount('launchpadLaunchApp')
          editBtn.click()
          check('★★ 启动台：卡片上有独立「✏️ 编辑」按钮，点它打开编辑框',
            await waitFor(() => !!$('#app-edit-overlay'), 3000, 'edit open'))
          check('★★ 点「编辑」**不**触发启动（两个动作彻底分开）',
            window.__fcTest.callCount('launchpadLaunchApp') === beforeE,
            'calls=' + window.__fcTest.callCount('launchpadLaunchApp'))
          // ⚠ 判据只看 placeholder 里的中文「端口」：编辑表单里有一栏是**启动参数**，
          //   它的示例文案就叫 `--port 8080` —— 那是合法的参数例子，不是"让用户配端口"。
          check('★★ 启动台编辑表单里**没有端口输入框**（端口不该由用户配置）',
            !$$('#app-edit-overlay input').some(i => /端口/.test(i.placeholder || '')),
            $$('#app-edit-overlay input').map(i => i.placeholder || '(无)').join(' | '))
          // 关闭要用「取消」（.acts .ghost）——第一个 .ghost 是「浏览…」，点了不会关
          const closeBtn = $('#app-edit-overlay .acts .ghost')
          if (closeBtn) closeBtn.click()
          await waitFor(() => !$('#app-edit-overlay'), 3000, 'edit closed')
        } else {
          check('★ 卡片上有独立「✏️ 编辑」按钮', false, 'no .lp-edit')
        }

        // ③ ★★ 2026-10-16 新判据：启动台里**不许**出现端口
        check('★★ 启动台卡片上**没有**端口那一行（这里是快捷入口，端口属于服务页）',
          $$('.lp-card .lp-ports').length === 0, 'lp-ports=' + $$('.lp-card .lp-ports').length)
        check('★★ 启动台整页**不出现"端口"字样**（端口观感不许污染快捷入口）',
          String(($('.launchpad') || {}).textContent || '').indexOf('端口') < 0,
          String((($('.launchpad') || {}).textContent || '').slice(0, 180)))

        // ④ 右键菜单（2026-10-17 暮雨：「不能右键卡片进行编辑和删除」）
        //    判据：右键真的出菜单，且菜单里**直达**编辑与删除（不用先进编辑弹窗再找删除）。
        const lpCard0 = $$('.lp-card')[0]
        if (lpCard0) {
          lpCard0.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: 320, clientY: 300,
          }))
          await sleep(700)
          const menuItems = $$('.ctx-menu button').map((b) => (b.textContent || '').trim())
          check('★★ 启动台卡片右键出菜单', menuItems.length > 0, menuItems.join(' | '))
          check('★ 菜单里有「编辑登记」（右键直达编辑）',
            menuItems.some((t) => t.indexOf('编辑登记') >= 0), menuItems.join(' | '))
          check('★ 菜单里有「删除这条登记」（右键直达删除）',
            menuItems.some((t) => t.indexOf('删除这条登记') >= 0), menuItems.join(' | '))
          const delMenu = $$('.ctx-menu button').find((b) => (b.textContent || '').indexOf('删除这条登记') >= 0)
          if (delMenu) {
            const beforeDel = window.__fcTest.callCount('launchpadRemoveApp')
            const origConfirm3 = window.confirm
            window.confirm = () => true
            delMenu.click()
            check('★★ 菜单「删除」真走 launchpadRemoveApp（不是只关菜单）',
              await waitFor(() => window.__fcTest.callCount('launchpadRemoveApp') > beforeDel, 3000, 'lp remove'),
              'calls=' + window.__fcTest.callCount('launchpadRemoveApp'))
            window.confirm = origConfirm3
          }
        }
      }

      // 服务页（2026-10-16 用户第 2 条：应用分区已搬走，本页回归纯端口监控）
      await openViewTab('服务')
      check('  进得了服务页（.services-view）', !!$('.services-view'))
      check('★★ 服务页**不再**有「启动台应用」分区（启动回启动台，这页只管端口）',
        !$$('.svc-group-title').some(t => (t.textContent || '').indexOf('启动台应用') >= 0),
        $$('.svc-group-title').map(t => t.textContent).join(' | '))
      check('★★ 服务页**没有**"手敲端口号"的输入框（旧模型的老毛病）',
        !$$('.svc-input').some(i => /端口/.test(i.placeholder || '')),
        $$('.svc-input').map(i => i.placeholder).join(' | '))

      const allRows = $$('.svc-item').filter(r => r.querySelector('.svc-name'))
      const nameRow = (n) => allRows.find(r => ((r.querySelector('.svc-name') || {}).textContent || '').trim() === n)
      const rowManual = nameRow('方寸看板')
      check('★★ 已登记（用户认领的）行还在 —— 这页的正事是"谁在监听、谁占着"',
        !!rowManual, JSON.stringify(allRows.map(r => ((r.querySelector('.svc-name') || {}).textContent || '').trim())))
      check('★★ 服务页里**没有**"启动"按钮（那属于启动台；这页只读、只登记）',
        !$$('.services-view button').some(b => /启动/.test(b.textContent || '')),
        JSON.stringify($$('.services-view button').map(b => b.textContent)))
      check('★★ 没有任何"结束/杀掉占用进程"的按钮（只读 A 档，不许偷偷加）',
        !$$('.services-view button').some(b => /结束|杀掉|杀进程|停止进程|kill/i.test(b.textContent || '')),
        JSON.stringify($$('.services-view button').map(b => b.textContent)))

      clickText('看板'); await sleep(300)
    }

    // ══ 错误日志抽屉（2026-10-23 补）
    //  此前假 preload 的 applogTail 恒返回空数组 → 抽屉里永远只有「（日志为空）」，
    //  于是「抽屉里显示的行到底是不是主进程给的」从来没被验过（又是空桩造的真空）。
    {
      // 造一条错误：main.ts 的 window.onerror 就是广播成这个事件，App 监听同一个名字
      window.dispatchEvent(new CustomEvent('fc-app-error', {
        detail: { scope: 'e2e', message: 'e2e 造的错误（日志抽屉断言用）' },
      }))
      const barOk = await waitFor(() => $$('.errbar').length > 0, 3000, 'errbar')
      check('★ 渲染层出错时顶部出错误条（失败有可见出口，不静默）', barOk,
        String((($('.errbar-msg') || {}).textContent || '').slice(0, 60)))
      const openBtn = $$('.errbar button').find((b) => (b.textContent || '').trim() === '查看日志')
      check('  错误条上有「查看日志」入口', !!openBtn)
      if (openBtn) {
        openBtn.click()
        check('★★ 日志抽屉显示的是主进程 applogTail 给的行（不是「（日志为空）」）',
          await waitFor(() => {
            const p = $('.errpanel-body')
            return !!p && (p.textContent || '').indexOf('远端连接超时') >= 0
          }, 4000, 'applog 行'),
          String((($('.errpanel-body') || {}).textContent || '').slice(0, 80)))
        check('  抽屉里带日志文件路径（用户能自己去翻）',
          (($('.errpanel-head') || {}).textContent || '').indexOf('fangcun-20260922.log') >= 0,
          String((($('.errpanel-head') || {}).textContent || '').slice(0, 80)))
      }
      // 收尾：按「忽略」清空错误条 + 收起抽屉 —— 最后一条断言要求错误条为空
      const ignore = $$('.errbar button').find((b) => (b.textContent || '').trim() === '忽略')
      if (ignore) ignore.click()
      const closePanel = $$('.errpanel-head button').find((b) => (b.textContent || '').trim() === '收起')
      if (closePanel) closePanel.click()
      // ⚠ 必须等一拍：Vue 的状态更新走 nextTick，点完立刻查 DOM 还是旧样子 ——
      //   第一版就是没等，两条"收掉了"的断言当场假红（DOM 里 errbar 还在）。
      await sleep(300)
      check('  收尾：错误条与抽屉都收掉了（不会污染后面的断言）',
        $$('.errbar').length === 0 && !$('.errpanel'))
    }

    // ══ 项目梯度榜（2026-10-25 暮雨）════════════════════════════════════
    // 原话：「放进项目页签里面就好。这玩意纯属小玩具，没必要提到那么高级。
    //        而且当前形态为列表，和我丢的参考图里的**梯度榜**完全不同。」
    // 判据三条：它是项目页的一种**摆法**（不是顶级页签）· 分档渲染（不是一维名次）· 拖完真落盘。
    {
      clickText('项目')
      await sleep(700)
      const tabLabels = $$('.pagehead button.vsb').map((b) => (b.textContent || '').trim())
      const tierTab = $$('.pagehead button.vsb').find((b) => (b.textContent || '').indexOf('梯度榜') >= 0)
      check('★★ 项目页多出「梯度榜」摆法（小玩具归位到项目页）', !!tierTab, tabLabels.join(' | '))
      check('★ 顶栏仍然没有独立「优先级」页签（没被提到顶级）',
        !$$('#views .vbtn').some((b) => (b.textContent || '').trim() === '优先级'))
      if (tierTab) {
        tierTab.click()
        await sleep(900)
        const rows = $$('.tierboard .tier-row')
        check('★★ 渲染成**分档**而不是一维名次（>=2 个 .tier-row）', rows.length >= 2, 'rows=' + rows.length)
        check('  有「未分档」池（新登记的项目不会凭空消失）', !!$('.tierboard .tier-pool'))
        check('  档位标签可点着改名（.tier-label-txt 在）', $$('.tierboard .tier-label-txt').length > 0)
        check('  有「＋ 加一档」入口',
          $$('.tierboard button').some((b) => (b.textContent || '').indexOf('加一档') >= 0))

        const chips = $$('.tierboard .tier-chip')
        check('  档位里有项目胶囊（夹具 demo / demo2 已分档）', chips.length >= 1, 'chips=' + chips.length)
        if (chips.length >= 1) {
          const chip = chips[0]
          const pid = chip.getAttribute('data-pid')
          const poolRow = $('.tierboard .tier-pool')
          const beforeCalls = window.__fcTest.callCount('projectTiersSet')
          const dt = new DataTransfer()
          chip.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
          await sleep(150)
          poolRow.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
          await sleep(150)
          poolRow.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
          await sleep(700)
          check('★★ 拖进「未分档」→ 立刻落盘（projectTiersSet 真被调用，没有保存按钮）',
            window.__fcTest.callCount('projectTiersSet') > beforeCalls,
            'calls=' + window.__fcTest.callCount('projectTiersSet'))
          const tiersNow = window.__fcTest.projectTiers()
          const allIds = tiersNow.reduce((a, t) => a.concat(t.items || []), [])
          check('★★ 落盘后这个项目**不在任何档**（一个项目只能在一档）',
            pid && allIds.indexOf(pid) < 0, 'pid=' + pid + ' 档内=' + JSON.stringify(allIds))
          check('  未分档池里出现了它', $$('.tierboard .tier-pool .tier-chip').some((c) => c.getAttribute('data-pid') === pid),
            '池=' + $$('.tierboard .tier-pool .tier-chip').map((c) => c.getAttribute('data-pid')).join(','))
        }

        // 收尾：切回项目墙，别污染后面的断言
        const tilesTab = $$('.pagehead button.vsb').find((b) => (b.textContent || '').indexOf('项目墙') >= 0)
        if (tilesTab) { tilesTab.click(); await sleep(500) }
        check('  收尾：切回项目墙后梯度榜不在 DOM 里', !$('.tierboard'))
      }

    // ══ 需求优先级矩阵（2026-10-30 第 4/5/6 条：去 RICE / 去拍板 / 项目切换 / 筛选真生效）══
    // 原型（docs/小样-RICE决策矩阵-20261025）的四个设计判断，判据都在**页面上看得见**，
    // 不是只活在 shared/rice.ts 里（e2e-rice 已验逻辑，这里验露没露出来）：
    //   ① 容量护栏（排满 = 一次线上故障就让整轮延期）② 立场句写在显眼处
    //   ③ 「为什么做，为什么砍」独立一节，定了没写理由要被点名 ④ 重评触发条件
    {
      clickText('项目'); await sleep(400)
      const riceTab = $$('.pagehead button.vsb').find((b) => (b.textContent || '').indexOf('需求优先级矩阵') >= 0)
      if (riceTab) riceTab.click()
      check('★★ 项目页能切到「需求优先级矩阵」', await waitFor(() => !!$('.rice'), 4000, 'rice view'))
      check('★★ 正式名称就是「需求优先级矩阵」',
        (($('.rice-ttl') || {}).textContent || '').trim() === '需求优先级矩阵',
        (($('.rice-ttl') || {}).textContent || '').trim())
      check('★★ 界面不再出现 RICE 这个词（用户：放出来太怪）',
        !/RICE/.test(($('.rice') || {}).textContent || ''),
        (($('.rice') || {}).textContent || '').match(/.{0,20}RICE.{0,20}/)?.[0] || '(none)')
      check('★★ 界面不再出现「拍板」这个词（用户：根本看不懂）',
        !/拍板/.test(($('.rice') || {}).textContent || ''),
        (($('.rice') || {}).textContent || '').match(/.{0,20}拍板.{0,20}/)?.[0] || '(none)')
      check('  页面显示池文件绝对路径（防"找不到在哪"）',
        (($('.rice-where') || {}).textContent || '').indexOf('rice-pool.md') >= 0,
        (($('.rice-where') || {}).textContent || '').slice(0, 80))
      check('★★ 有项目切换（不再只能看全池）', (() => {
        const sel = $('.rice-projsel select')
        if (!sel) return false
        const opts = Array.prototype.map.call(sel.options, (o) => o.textContent.trim())
        return opts.some((t) => t.indexOf('全部项目') === 0) && opts.some((t) => t.indexOf('演示项目') === 0)
      })(), (() => {
        const sel = $('.rice-projsel select')
        return sel ? Array.prototype.map.call(sel.options, (o) => o.textContent.trim()).join('|') : '(no select)'
      })())
      check('★★ 项目下拉直接写出条数（免得切过去才发现是空的）', (() => {
        const sel = $('.rice-projsel select')
        if (!sel) return false
        const opts = Array.prototype.map.call(sel.options, (o) => o.textContent.trim())
        return opts.every((t) => /（\d+ 条）$/.test(t)) &&
          opts.some((t) => /^演示项目（1 条）$/.test(t)) &&
          opts.some((t) => /^第二个项目（0 条）$/.test(t))
      })(), (() => {
        const sel = $('.rice-projsel select')
        return sel ? Array.prototype.map.call(sel.options, (o) => o.textContent.trim()).join('|') : '(no select)'
      })())
      // 2026-10-31 第 1 条：hover 表格行时画面剧烈抖动。
      // 根因 = 明细面板挂在表格上方，内容一变高就把整张表推下去 → 指针离开那一行 →
      // 面板缩回 → 表又回来，如此反复。判据不是"高度是多少"，而是 **hover 前后表格位置不动**。
      const riceW0 = Math.round(($('.rice') || { getBoundingClientRect: () => ({ width: -1 }) }).getBoundingClientRect().width)
      const riceRow0 = $('.rice-table tbody tr')
      const riceTableTop0 = $('.rice-table') ? $('.rice-table').getBoundingClientRect().top : -1
      const riceDetailH0 = $('.rice-detail') ? $('.rice-detail').getBoundingClientRect().height : -1
      if (riceRow0) riceRow0.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      await sleep(300)
      check('★★ hover 表格行不会把表格推走（明细面板固定高度，抖动根因已堵）', (() => {
        if (!riceRow0 || !$('.rice-table') || !$('.rice-detail')) return false
        const top = $('.rice-table').getBoundingClientRect().top
        const h = $('.rice-detail').getBoundingClientRect().height
        return Math.abs(top - riceTableTop0) <= 1 && Math.abs(h - riceDetailH0) <= 1 &&
          (($('.rice-detail') || {}).textContent || '').indexOf('优先级分') >= 0
      })(), `tableTop ${Math.round(riceTableTop0)} → ${$('.rice-table') ? Math.round($('.rice-table').getBoundingClientRect().top) : 'n/a'} · detailH ${Math.round(riceDetailH0)} → ${$('.rice-detail') ? Math.round($('.rice-detail').getBoundingClientRect().height) : 'n/a'}`)
      if (riceRow0) riceRow0.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
      await sleep(150)
      check('★★ 界面不再有"人天 / E天 / E元"这类黑话（用户第 3 条）',
        !/人天|E天|E元/.test(($('.rice') || {}).textContent || ''),
        (($('.rice') || {}).textContent || '').match(/.{0,16}(人天|E天|E元).{0,16}/)?.[0] || '(none)')
      check('★ 打分表表头说人话（每周用几次 / 省多少事 / 把握多大 / 要做几天 / 花多少钱）', (() => {
        const th = $$('.rice-table th').map((x) => (x.textContent || '').trim())
        return ['每周用几次', '省多少事', '把握多大', '要做几天', '花多少钱', '优先级分', '你的决定']
          .every((t) => th.indexOf(t) >= 0)
      })(), $$('.rice-table th').map((x) => (x.textContent || '').trim()).join('|'))
      check('★★ 立场句写在显眼处（不是只混在底部五条局限里）', (() => {
        const el = $('.rice-stance')
        return !!el && (el.textContent || '').indexOf('不替你做决定') >= 0
      })(), (($('.rice-stance') || {}).textContent || '').slice(0, 80))
      // 夹具：P0 花费 85 / 预算 100 → tight（85%）
      check('★★ 容量护栏给判定 + 余量（85% → tight，话说"排满等于把风险押给线上故障"）', (() => {
        const g = $('.rice-guard')
        return !!g && /tight|over/.test(g.className) && (g.textContent || '').indexOf('线上故障') >= 0
      })(), (($('.rice-guard') || {}).className || '') + '|' + (($('.rice-guard') || {}).textContent || '').slice(0, 80))
      check('  预算行同时给余量（数字与话术在一起，不是只有百分比）',
        (($('.rice-budget') || {}).textContent || '').indexOf('余量') >= 0,
        (($('.rice-budget') || {}).textContent || '').slice(0, 100))
      check('★★ 「为什么做，为什么砍」独立一节', !!$('.rice-why') &&
        (($('.rice-why-h') || {}).textContent || '').indexOf('为什么做') >= 0)
      check('★★ 做/砍分两栏（分数只是入口，理由逐条写）',
        $$('.rice-why-col').length === 2 &&
        /做（2）/.test((($$('.rice-why-t')[0] || {}).textContent) || '') &&
        /砍（1）/.test((($$('.rice-why-t')[1] || {}).textContent) || ''),
        $$('.rice-why-t').map((x) => (x.textContent || '').trim()).join('|'))
      check('★★ 定了没写理由的那条被点名（说不清为什么就是没决定）',
        $$('.rice-why-reason.missing').length >= 1,
        $$('.rice-why-reason').map((x) => (x.textContent || '').trim().slice(0, 20)).join('|'))
      // 点名之后必须给出口：否则「不算决定」只是一句骂人的话（2026-10-31 补）
      const whyFix = $$('.rice-why-act button').find((b) => (b.textContent || '').indexOf('补一句理由') >= 0)
      check('★★ 缺理由的决定能当场补（不是只点名）', !!whyFix,
        $$('.rice-why-act button').map((b) => (b.textContent || '').trim()).join('|'))
      if (whyFix) whyFix.click()
      await sleep(150)
      check('★ 点了「补一句理由」出现输入框', !!$('.rice-why-edit textarea'))
      const upCount0 = window.__fcTest.callCount('riceUpsert')
      if ($('.rice-why-edit textarea')) {
        const ta = $('.rice-why-edit textarea')
        ta.value = '补上的理由：每周省三次手工'
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        const saveBtn = $$('.rice-why-edit-act button')[0]
        if (saveBtn) saveBtn.click()
      }
      check('★★ 补的理由真走 riceUpsert 落盘（不是只改界面）',
        await waitFor(() => window.__fcTest.callCount('riceUpsert') > upCount0, 3000, 'reason save') &&
        (() => {
          const c = window.__fcTest.calls().filter((x) => x.name === 'riceUpsert').pop()
          const row = c && c.args && c.args[0] && c.args[0][0]
          return !!row && row.note === '补上的理由：每周省三次手工'
        })(),
        (() => {
          const c = window.__fcTest.calls().filter((x) => x.name === 'riceUpsert').pop()
          return JSON.stringify(c && c.args && c.args[0] && c.args[0][0] || null).slice(0, 200)
        })())
      check('★★ 重评触发条件写在页面上（容量变动 20%）',
        (($('.rice-why-foot') || {}).textContent || '').indexOf('20%') >= 0,
        (($('.rice-why-foot') || {}).textContent || '').slice(0, 80))
      check('  局限仍在（数字旁边必须带"证明不了什么"）', $$('.rice-limit').length >= 4,
        String($$('.rice-limit').length))
      // ── 视觉按原型重画（2026-10-30 暮雨：「视觉还没照原型重画」）─────────────
      // 原型是 docs/小样-RICE决策矩阵-20261025：先给 KPI，再给散点，再给打分表，
      // 最后是「为什么做，为什么砍」+ 四格结论。断言只钉**结构与口径**，不钉像素。
      check('★★ 顶部四格 KPI（候选 / P0 / P0 成本 / 预算占用）', $$('.rice-kpi').length === 4,
        $$('.rice-kpi').map((k) => (k.textContent || '').trim().slice(0, 18)).join(' | '))
      check('★ KPI 第一格就是「候选需求」且数字来自夹具（4 项，不写死）', (() => {
        const t = (($$('.rice-kpi')[0] || {}).textContent || '').replace(/\s+/g, ' ')
        return t.indexOf('候选需求') >= 0 && t.indexOf('4') >= 0
      })(), (($$('.rice-kpi')[0] || {}).textContent || '').slice(0, 60))
      check('★★ 三节结构带编号（1 散点 / 2 打分 / 3 做砍）', (() => {
        const nos = $$('.rice-no').map((n) => (n.textContent || '').trim())
        return nos.join(',') === '1,2,3'
      })(), $$('.rice-no').map((n) => (n.textContent || '').trim()).join(','))
      check('★★ 散点有象限底色 / 网格 / 坐标轴标题（照原型的矩阵，不是一个空框）',
        $$('.rice-quad-fill').length === 4 && $$('.rice-grid').length >= 4 &&
        $$('.rice-axis-title').length === 2,
        `quad=${$$('.rice-quad-fill').length} grid=${$$('.rice-grid').length} axis=${$$('.rice-axis-title').length}`)
      check('★★ 气泡按池内条目真身画（4 条都算得出分）+ 气泡编号与表格 # 同一套',
        $$('.rice-bubble').length === 4 && $$('.rice-bubble-n').length >= 3,
        `bubbles=${$$('.rice-bubble').length} nums=${$$('.rice-bubble-n').length}`)
      check('★ P0 阈值线画出来了（阈值 = 最低的那个 P0 分，不是写死的分数线）',
        !!$('.rice-threshold') && (($('.rice-threshold-t') || {}).textContent || '').indexOf('P0 分界线') >= 0,
        (($('.rice-threshold-t') || {}).textContent || '').slice(0, 24))
      check('★ 筛选 chips 带条数（原型那样：勾哪个显哪个）', $$('.rice-chip').length === 6,
        $$('.rice-chip').map((c) => (c.textContent || '').trim()).join(' | '))
      check('★★ 打分表有 # 排名 + 条形长度 + 等级徽章（不只一个数字）', (() => {
        const ranks = $$('.rice-rank').map((x) => (x.textContent || '').trim())
        const bars = $$('.rice-bar i').filter((i) => (i.getAttribute('style') || '').indexOf('width') >= 0)
        const badges = $$('.rice-badge').map((b) => (b.textContent || '').trim())
        return ranks[0] === '1' && ranks.length >= 4 && bars.length >= 4 &&
          ['P0', 'P1', 'P2', 'CUT'].every((lv) => badges.indexOf(lv) >= 0)
      })(), `ranks=${$$('.rice-rank').map((x) => (x.textContent || '').trim()).join(',')} badges=${$$('.rice-badge').map((b) => (b.textContent || '').trim()).join(',')}`)
      check('★★ 结尾四格结论（立即启动 / 排队候补 / 有余量再说 / 砍掉）', $$('.rice-vd-block').length === 4,
        $$('.rice-vd-block').map((b) => (b.textContent || '').trim().slice(0, 14)).join(' | '))
      check('  页脚公式常驻（优先级分 = 每周用几次 × 省多少事 × 把握 ÷ 要做几天）',
        (($('.rice-formula') || {}).textContent || '').indexOf('每周用几次 × 省多少事 × 把握 ÷ 要做几天') >= 0,
        (($('.rice-formula') || {}).textContent || '').slice(0, 60))
      check('  点气泡/悬停有明细区（不是只能靠 title 猜）', !!$('.rice-detail'))
      // 2026-10-30 第 7 条：矩阵要能把「先问清楚 → 规格 → 能验收的工单 → TDD/双路 review」
      // 交给 agent，而不是只给一个分数。它是复制动作，不改任何状态。
      const firstPt = $('.rice-pt')
      if (firstPt) firstPt.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await sleep(250)
      check('★★ 点气泡后明细里有「复制开工交接单」', !!$('.rice-kick'),
        (($('.rice-detail') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 80))
      const beforeKick = window.__fcTest.callCount('clipboardWriteText')
      if ($('.rice-kick')) $('.rice-kick').click()
      check('★★ 交接单真的复制出去，且包含澄清 / 规格 / 可验收工单 / 双路 review 四段',
        await waitFor(() => window.__fcTest.callCount('clipboardWriteText') > beforeKick, 3000, 'kickoff copy') &&
        (() => {
          const c = window.__fcTest.calls().filter(x => x.name === 'clipboardWriteText').pop()
          const t = String(c && c.args && c.args[0] || '')
          return t.indexOf('先问清楚') >= 0 && t.indexOf('to-spec') >= 0 &&
            t.indexOf('能验收的一件事') >= 0 && t.indexOf('双路 review') >= 0
        })(),
        (() => {
          const c = window.__fcTest.calls().filter(x => x.name === 'clipboardWriteText').pop()
          return String(c && c.args && c.args[0] || '').slice(0, 160).replace(/\n/g, ' | ')
        })())

      // ── P1 筛选必须同时动散点和表格（2026-10-30 第 5 条：点了没反应）────────
      const p1Chip = $$('.rice-chip').find((c) => (c.textContent || '').indexOf('P1') >= 0)
      if (p1Chip) p1Chip.click()
      await sleep(350)
      check('★★ 点 P1 不是"没反应"：散点气泡和表格行一起缩小到 P1',
        $$('.rice-bubble').length === 1 && $$('.rice-rank').length === 1,
        `bubbles=${$$('.rice-bubble').length} rows=${$$('.rice-rank').length}`)
      check('★ 表格行只剩 P1 徽章', $$('.rice-badge').length >= 1 &&
        $$('.rice-badge').every((b) => (b.textContent || '').trim() === 'P1'))
      // 切到 demo 项目 + CUT：0 条，但面板不许缩窄
      const projSel = $('.rice-projsel select')
      if (projSel) { projSel.value = 'demo'; projSel.dispatchEvent(new Event('change', { bubbles: true })) }
      await sleep(400)
      const cutChip = $$('.rice-chip').find((c) => (c.textContent || '').indexOf('CUT') >= 0)
      if (cutChip) cutChip.click()
      await sleep(400)
      check('★★ CUT 0 条时表格区不塌（仍有最小高度 + 明说"这个筛选下没有"）',
        (() => {
          const w = $('.rice-tablewrap')
          return !!w && w.getBoundingClientRect().height >= 200 &&
            !!$('.rice-none') && !!$('.rice-plot-empty')
        })(),
        (() => {
          const w = $('.rice-tablewrap')
          return `h=${w ? Math.round(w.getBoundingClientRect().height) : -1} none=${!!$('.rice-none')} plotEmpty=${!!$('.rice-plot-empty')}`
        })())
      // 2026-10-31 第 2/4 条：切到一个**没有需求**的项目 ——
      // 页面宽度不许跟着内容收缩（此前 .rice 是 flex 项 + margin:0 auto，auto 边距取消 stretch，
      // 整块按内容宽度收缩，条目一少就突然变窄）；空状态也不许只甩一句"还没有需求"。
      if (projSel) { projSel.value = 'demo2'; projSel.dispatchEvent(new Event('change', { bubbles: true })) }
      await sleep(400)
      check('★★ 切到 0 条的项目：页面宽度不变（不是按内容收缩）', (() => {
        const el = $('.rice')
        if (!el) return false
        return Math.abs(el.getBoundingClientRect().width - riceW0) <= 1
      })(), (() => {
        const el = $('.rice')
        return `rice ${Math.round(riceW0)} → ${el ? Math.round(el.getBoundingClientRect().width) : 'n/a'}`
      })())
      check('★★ 切到 0 条的项目：预算仍是全池口径（不许变成 0% 假装没花钱）', (() => {
        const k = $$('.rice-kpi')
        const budget = k.length ? (k[k.length - 1].textContent || '').replace(/\s+/g, ' ') : ''
        return budget.indexOf('85') >= 0 && budget.indexOf('全池') >= 0
      })(), (() => {
        const k = $$('.rice-kpi')
        return k.length ? (k[k.length - 1].textContent || '').replace(/\s+/g, ' ') : '(no kpi)'
      })())
      check('★ 空项目的副标题说清「全池还有几条」（不是"池里还没有条目"）', (() => {
        const t = (($('.rice-sub') || {}).textContent || '').trim()
        return t.indexOf('第二个项目') >= 0 && t.indexOf('全池 4 条') >= 0
      })(), (($('.rice-sub') || {}).textContent || '').slice(0, 80))
      check('★★ 空项目给的是出口而不是死胡同（说明归属 + 看全部项目 + 可复制给 agent 的指令）', (() => {
        const t = ($('.rice-empty') || {}).textContent || ''
        const btns = $$('.rice-empty-act button').map((b) => (b.textContent || '').trim())
        return !!$('.rice-empty-t') && t.indexOf('第二个项目') >= 0 && t.indexOf('任务卡') >= 0 &&
          btns.some((x) => x.indexOf('看全部项目') >= 0) &&
          btns.some((x) => x.indexOf('复制') >= 0)
      })(), ($('.rice-empty') ? ($('.rice-empty').textContent || '').replace(/\s+/g, ' ').slice(0, 180) : '(no empty)'))
      check('★ 空状态的「看全部项目」真能点回去', (() => {
        const b = $$('.rice-empty-act button').find((x) => (x.textContent || '').indexOf('看全部项目') >= 0)
        return !!b
      })(), $$('.rice-empty-act button').map((b) => (b.textContent || '').trim()).join('|'))
      // 切回全部项目 / 全部筛选，别污染后面的断言
      if (projSel) { projSel.value = 'all'; projSel.dispatchEvent(new Event('change', { bubbles: true })) }
      const allChip = $$('.rice-chip').find((c) => (c.textContent || '').indexOf('全部') >= 0)
      if (allChip) allChip.click()
      await sleep(350)
      // 收尾：回项目墙
      const backTab = $$('.pagehead button.vsb').find((b) => (b.textContent || '').indexOf('项目墙') >= 0)
      if (backTab) { backTab.click(); await sleep(400) }
      check('  收尾：切回项目墙后需求优先级矩阵不在 DOM 里', !$('.rice'))
    }

    // ══ 项目架构图（2026-10-29 暮雨第 2 条；2026-10-30 再改）══════════════
    // 第一版是错的：拿任务数据画分层图还叫"项目结构图"。暮雨当场否掉，并明确：
    //   ① 不要世界地图 Emoji；② 它打开的是**架构图**；③ 方寸自绘是目标（还没做）。
    // archify 的产物是一份架构图 HTML，方寸只负责**指到它**；找不到就说清怎么生成。
    {
      clickText('项目'); await sleep(400)
      const tileBtn = $$('.tile .pv-diagram').find((b) => (b.textContent || '').indexOf('架构图') >= 0)
      check('★★ 项目卡上有「架构图」入口（不叫「结构图」、不带地图 Emoji）', !!tileBtn,
        $$('.tile button').map((b) => (b.textContent || '').trim()).slice(0, 8).join('|'))
      window.__fcTest.reset()
      if (tileBtn) tileBtn.click()
      check('★★ 点了真走 project:diagram IPC', await waitFor(() => window.__fcTest.callCount('projectDiagram') > 0, 4000, 'projectDiagram'),
        JSON.stringify(window.__fcTest.calls().map((c) => c.name)))
      check('★★ 找不到产物时**说清怎么生成**（点名 archify 与 docs/，不许静默）',
        await waitFor(() => {
          const t = (($('#toast') || {}).textContent || '')
          return t.indexOf('archify') >= 0 && t.indexOf('docs/') >= 0
        }, 4000, 'toast 指引'),
        (($('#toast') || {}).textContent || '').slice(0, 120))
      check('★★ 不再有本地画的「结构图」模态（旧的那套必须删干净，不许新旧并存）', !$('#proj-diagram'))
      clickText('看板'); await sleep(300)
    }

    // ══ 方寸绘制架构图（2026-10-30，卡 task-20261030-002；同日第 3 条重做）════
    // 判据不是"能出图"，而是：① 与「架构图」收成一个分段控件；② 七道校验门逐条摆出来；
    // ③ 每一块都能被人工剔除/放回；④ 驳回后真按诊断重画；⑤ **通过之后才允许导出**。
    {
      clickText('项目'); await sleep(400)
      const archGroup = $$('.tile .pv-arch-group')[0]
      const selfBtn = $$('.tile .pv-archself').find((b) => (b.textContent || '').indexOf('绘制架构图') >= 0)
      check('★★ 「架构图 / 绘制架构图」收成一个分段控件（不再是两个抢位置的按钮）',
        !!archGroup && !!selfBtn, $$('.tile button').map((b) => (b.textContent || '').trim()).slice(0, 10).join('|'))
      check('★ 不再叫「自绘架构图」（用户点名要改的名字）',
        !$$('.tile button').some((b) => (b.textContent || '').indexOf('自绘架构图') >= 0))
      window.__fcTest.reset()
      if (selfBtn) selfBtn.click()
      check('★★ 点了真走 arch:get IPC', await waitFor(() => window.__fcTest.callCount('archGet') > 0, 4000, 'archGet'),
        JSON.stringify(window.__fcTest.calls().map((c) => c.name)))
      const opened = await waitFor(() => !!$('#arch-modal'), 4000, 'arch modal')
      check('★★ 面板打开且标题带项目名（不是一张没头没尾的图）',
        opened && (($('.archd-ttl') || {}).textContent || '').indexOf('演示项目') >= 0,
        (($('.archd-ttl') || {}).textContent || '').slice(0, 40))
      check('★★ 图里 6 个节点都能点（data-node 逐个渲染出来，不是一张死图）',
        $$('#arch-modal [data-node]').length === 6, String($$('#arch-modal [data-node]').length))
      check('★ 连线按证据类型分组（import / ipc / bridge 三组都在）',
        $$('#arch-modal .archd-edge').length === 3,
        $$('#arch-modal .archd-edge').map((e) => e.getAttribute('class')).join(' | '))
      check('★★ 分层校验门逐条摆出来（不是一句"生成成功"）',
        $$('#arch-modal .archd-gate').length >= 9, String($$('#arch-modal .archd-gate').length))
      check('★ 校验结论带通过数与分数', /道通过|分/.test(($('.archd-side') || {}).textContent || ''),
        (($('.archd-side') || {}).textContent || '').slice(0, 120))
      check('★★ 缺项摆出来（端口清单 + 为什么没列）',
        (($('.archd-side') || {}).textContent || '').indexOf('端口清单') >= 0)
      check('★ 证据清单摆出来（package.json + 只读扫描）', (() => {
        const t = (($('.archd-side') || {}).textContent || '')
        return t.indexOf('package.json') >= 0 && t.indexOf('只读扫描') >= 0
      })(), (($('.archd-side') || {}).textContent || '').slice(0, 120))
      // 点一个节点 → 右侧换成它的文件明细
      const mainNode = $$('#arch-modal [data-node]').find((g) => g.getAttribute('data-node') === 'src/main')
      if (mainNode) {
        const box = mainNode.querySelector('rect') || mainNode
        box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
      await sleep(350)
      check('★★ 点节点 → 右侧显示它的文件样例（选中真的有反应）',
        (($('.archd-side') || {}).textContent || '').indexOf('src/main/index.ts') >= 0,
        (($('.archd-side') || {}).textContent || '').slice(0, 100))

      // ── 逐块审批（2026-10-30 第 3 条）：不认可这一笔就剔掉，能放回 ──
      const beforeNodes = $$('#arch-modal [data-node]').length
      const excludeBtn = $$('#arch-modal button').find((b) => (b.textContent || '').indexOf('剔除这一块') >= 0)
      check('★ 选中块有「剔除这一块」（画一笔也要人点头）', !!excludeBtn)
      if (excludeBtn) { excludeBtn.click(); await sleep(350) }
      check('★★ 剔除后图里真的少了一块',
        $$('#arch-modal [data-node]').length === beforeNodes - 1,
        `${$$('#arch-modal [data-node]').length} vs ${beforeNodes}`)
      check('★ 剔除的块在侧栏列出来并标明可放回',
        (($('.archd-side') || {}).textContent || '').indexOf('已剔除的块') >= 0)
      const backBtn = $$('#arch-modal button').find((b) => (b.textContent || '').trim() === '放回')
      if (backBtn) { backBtn.click(); await sleep(350) }
      check('★ 放回后块数恢复', $$('#arch-modal [data-node]').length === beforeNodes,
        String($$('#arch-modal [data-node]').length))

      // ── 驳回重画：真按 strict 再扫一版，并记版本 ──
      window.__fcTest.reset()
      const rejectBtn = $$('#arch-modal button').find((b) => (b.textContent || '').indexOf('驳回重画') >= 0)
      check('★ 面板上有「驳回重画」', !!rejectBtn)
      if (rejectBtn) { rejectBtn.click(); await sleep(250) }
      const whyIn = $('#arch-modal .archd-reject-in')
      check('★ 驳回要写一句哪里不行（不是静默重扫）', !!whyIn)
      if (whyIn) {
        whyIn.value = '主进程太碎，看不清边界'
        whyIn.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const redoBtn = $$('#arch-modal button').find((b) => (b.textContent || '').indexOf('驳回并按诊断重画') >= 0)
      if (redoBtn) redoBtn.click()
      check('★★ 驳回后真按 strict 重画（不是把原图再贴一遍）',
        await waitFor(() => {
          const last = window.__fcTest.calls().filter((c) => c.name === 'archGet').pop()
          return !!last && last.args[1] && last.args[1].strict === true
        }, 4000, 'strict archGet'),
        JSON.stringify((window.__fcTest.calls().filter((c) => c.name === 'archGet').pop() || {}).args))
      check('★ 重画后标出「第 N 版」', (($('.archd-ver') || {}).textContent || '').indexOf('2') >= 0,
        (($('.archd-ver') || {}).textContent || '').slice(0, 20))
      // 重画是异步的（archGet → 校验 → 重新渲染）：等按钮真的可用再点，别测出"点了没反应"的假象
      await sleep(600)

      // ── 通过之后才允许导出（没签字的图不落盘）──
      const expBtn = () => $$('#arch-modal button').find((b) => (b.textContent || '').indexOf('导出') >= 0)
      check('★★ 没点「通过」之前导出是禁用的', !!expBtn() && expBtn().disabled === true)
      const approveBtn = () => $$('#arch-modal button').find((b) => (b.textContent || '').indexOf('通过这张图') >= 0)
      check('★ 面板上有「通过这张图」', !!approveBtn())
      check('  重画完成后「通过」按钮可用（不是卡在 busy）',
        await waitFor(() => !!approveBtn() && approveBtn().disabled === false, 3000, 'approve enabled'))
      if (approveBtn()) { approveBtn().click(); await sleep(350) }
      check('★ 通过后显示「已通过」', (($('.archd-ok') || {}).textContent || '').indexOf('已通过') >= 0,
        (($('.archd-ok') || {}).textContent || '').slice(0, 20))
      window.__fcTest.reset()
      if (expBtn()) expBtn().click()
      check('★★ 「导出」真走 arch:export IPC', await waitFor(() => window.__fcTest.callCount('archExport') > 0, 4000, 'archExport'),
        JSON.stringify(window.__fcTest.calls().map((c) => c.name)))
      check('★ 导出成功后明说落到哪（不是静默）',
        await waitFor(() => (($('#toast') || {}).textContent || '').indexOf('已导出') >= 0, 3000, 'toast'),
        (($('#toast') || {}).textContent || '').slice(0, 100))
      const closeBtn = $$('#arch-modal button').find((b) => (b.textContent || '').trim() === '关闭')
      if (closeBtn) closeBtn.click()
      await sleep(300)
      check('  关闭后从 DOM 消失', !$('#arch-modal'))
      clickText('看板'); await sleep(300)
    }


    }

    // ══ 读取情况「哪些待办其实没人碰过」（卡 20261025-006 第三件）════════════
    // 这一节守的是**口径**，不是布局。三件事：
    //   ① 数字必须跟口径文案**并排**出现 —— 「2 张没人碰过」孤零零摆着会被读成
    //      "这 2 张从来没人看过"，而它只代表"没有 agent 经 MCP 读过"；
    //   ② 计量还没开始时（windowEvents=0）**不许**报「N 张没人碰过」——
    //      那会把全部未完成卡一起冤枉成"没人碰过"，而且看起来像是工具坏了；
    //   ③ 选了它，看板必须**真的只剩那几张** —— 只换标签不改数据的假筛选要被抓住。
    {
      // ⚠ 先**自己灌一份有区分度**的任务夹具（2026-10-27 反例自证抓到的坑）：
      //   上一版依赖"当时恰好在板上的卡"，而那一刻板上只有 2 张、读卡夹具也只给 2 张 ——
      //   "筛完只剩那几张"在**不筛选**的情况下也成立 → 把过滤逻辑整个删掉照样全绿。
      //   现在固定 4 张未完成、读卡夹具只认其中 2 张，删掉过滤必然红。
      const NR = (id, st) => ({
        id, title: '读卡样例 ' + id, status: st, priority: '中', project: 'demo', tags: [], body: '',
        created: '2026-08-01T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z',
        fm: { id, title: '读卡样例 ' + id, status: st, priority: '中', project: 'demo' },
        path: 'C:/mock/task-data/' + id + '.md',
      })
      window.__fcTest.setTasks([NR('nr-a', '待办'), NR('nr-b', '进行中'), NR('nr-c', '待办'), NR('nr-d', '待审批')])
      // 切走再切回，逼界面重读（否则还是旧的一批卡）
      await openViewTab('待办')
      await sleep(400)
      await openViewTab('看板')
      await sleep(700)
      // 前面几节可能留下项目/状态筛选 —— 先清干净，否则"筛前 4 张"这个前提不成立
      const clearAllBtn = $('.fbar-clear')
      if (clearAllBtn) { clearAllBtn.click(); await sleep(400) }
      const beforeCount = $$('#board .card').length
      check('  （自检）灌进来的 4 张未完成卡都在板上（本节的前提）', beforeCount === 4, 'before=' + beforeCount)

      const fbtn = $('.fbar-filter-btn')
      check('  看板上有筛选入口（本节的落点）', !!fbtn)
      if (fbtn) {
        fbtn.click()
        await sleep(700)
        check('★ 打开筛选面板时真去拉了读卡记录（usageNeverRead 被调用，不是拿进页面时的旧值）',
          window.__fcTest.callCount('usageNeverRead') >= 1,
          'calls=' + window.__fcTest.callCount('usageNeverRead'))

        const fx = window.__fcTest.neverRead()
        const noteEl0 = $('.fpop .fpop-note')
        const note0 = noteEl0 ? (noteEl0.textContent || '').trim() : ''
        check('★★ 口径文案跟数字并排出现（常驻，不是只塞进 title）',
          !!noteEl0 && note0.length > 0, 'note=' + note0)
        check('★★ 文案把口径说明白：只算 agent 经 MCP 读卡，界面里点开不算',
          note0.indexOf('agent') >= 0 && note0.indexOf('MCP') >= 0 && note0.indexOf('界面') >= 0,
          note0)

        const neverBtn = $$('.fpop .fpop-opt').find((b) => (b.textContent || '').indexOf('没人碰过') >= 0)
        check('★ 筛选里出现「没人碰过 N」，N 来自夹具真身（不写死数字）',
          !!neverBtn && (neverBtn.textContent || '').indexOf(String(fx.count)) >= 0,
          neverBtn ? (neverBtn.textContent || '').trim() : '(没有这个选项)')

        if (neverBtn) {
          neverBtn.click()
          await sleep(450)
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await sleep(500)
          const wantIds = fx.rows.map((r) => r.id).sort()
          // 自检：夹具 rows 里的 id 必须真在任务夹具里 —— 否则"筛选后 0 张"是夹具问题，
          // 不是筛选坏了（这条先红会省掉一轮瞎猜）。
          const taskIds = window.__fcTest.tasks().map((t) => t.id)
          const overlap = wantIds.filter((id) => taskIds.indexOf(id) >= 0)
          check('  （自检）读卡夹具的 id 真在任务夹具里（不是两套对不上的夹具）',
            overlap.length === wantIds.length,
            'overlap=' + overlap.join(',') + ' / want=' + wantIds.join(',') + ' / tasks=' + taskIds.length)
          // ★★ 这条是"区分度"自检：筛前张数必须**多于**筛后，否则把过滤逻辑删掉也照样绿
          //    （2026-10-27 实测踩过：板上恰好只有那几张时，假筛选反例没变红）
          check('  （自检）筛前张数多于筛后（这条断言有区分度，不是恒真）',
            beforeCount > wantIds.length, 'before=' + beforeCount + ' 筛后=' + wantIds.length)
          await waitFor(() => $$('#board .card').length === wantIds.length, 4000, '筛选后卡片数')
          const gotIds = $$('#board .card').map((c) => c.getAttribute('data-id')).sort()
          check('★★ 选了「没人碰过」→ 看板真的只剩那几张（不是只换了标签）',
            gotIds.length === wantIds.length && gotIds.join(',') === wantIds.join(','),
            '期望=' + wantIds.join(',') + ' 实际=' + gotIds.join(',')
            + ' | board=' + !!$('#board') + ' 所有data-id=' + $$('#board [data-id]').map((c) => c.getAttribute('data-id')).join(','))
          check('★ 「生效中」区出现「没人碰过」标签（一眼看到筛了什么）',
            $$('.fbar-chip').some((c) => (c.textContent || '').indexOf('没人碰过') >= 0),
            'chips=' + $$('.fbar-chip').map((c) => (c.textContent || '').trim()).join(' | '))

          // 反例①：一条读卡记录都没有 → 文案必须换掉，不许继续报「N 张没人碰过」
          window.__fcTest.setNeverRead({ rows: [], count: 0, openTotal: fx.openTotal, windowEvents: 0 })
          fbtn.click()
          await sleep(700)
          const noteEmpty = (($('.fpop .fpop-note') || {}).textContent || '').trim()
          check('★★ 反例：一条读卡记录都没有时，不许报「N 张没人碰过」',
            noteEmpty.indexOf('还没有任何 agent 读卡记录') >= 0 &&
            noteEmpty.indexOf('张 / 共') < 0 &&
            noteEmpty.indexOf(' 张') < 0,
            'note=' + noteEmpty)
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await sleep(300)

          // 收尾两件都得做：撤掉筛选（否则后面的断言在空板上跑）+ 恢复夹具
          const chipNow = $$('.fbar-chip').find((c) => (c.textContent || '').indexOf('没人碰过') >= 0)
          const chipX = chipNow ? chipNow.querySelector('.fbar-x') : null
          if (chipX) { chipX.click(); await sleep(500) }
          check('  收尾：撤掉「没人碰过」后筛选标签消失', !$$('.fbar-chip').some((c) => (c.textContent || '').indexOf('没人碰过') >= 0))
          window.__fcTest.restoreNeverRead()
          await sleep(200)
        }
      }
    }

    // ③ 无未捕获错误：main.ts 把 window.onerror 广播成 fc-app-error，App 顶部会出错误条

    // ══ 点系统通知 → 回到具体对象（2026-10-29 · dsh-notify-tray 借鉴 #2）══════
    // 判据不是"能不能收事件"，而是**点了之后用户看到的是不是那件东西**：
    // 通知说「任务逾期：X」，点开必须看到 X 那张卡，而不是一屏卡片让人自己找。
    {
      // 夹具不写死：取当前 fixture 里第一张有 id 的卡（前面的用例会换 fixture）
      const anyTask = (window.__fcTest.tasks() || []).find((t) => t && t.id) || {}
      const wantId = String(anyTask.id || '')
      const wantTitle = String((anyTask.fm && anyTask.fm.title) || anyTask.title || '')
      const subs = window.__fcTest.emitNotifyFocus('task-deadline', wantId)
      check('★ 渲染层订阅了 notify:focus（preload 通道真接上了）', subs >= 1, 'subs=' + subs)
      const opened = await waitFor(() => !!$('#roverlay') &&
        (($('#rmodal') || {}).textContent || '').indexOf(wantTitle) >= 0, 4000, 'notify focus → 开卡')
      check('★★ 点「任务逾期」通知 → 切到看板并**打开那张卡**（不是只把窗口拉到前台）', opened,
        'want=' + wantTitle + ' | got=' + (($('#rmodal') || {}).textContent || '').slice(0, 60))
      const closeR = $$('#roverlay .acts button, #rmodal .acts button').find((b) => (b.textContent || '').trim() === '关闭')
      if (closeR) closeR.click()
      await sleep(250)
      // 对象不在了不能装没事 —— 要明说
      window.__fcTest.emitNotifyFocus('task-deadline', 'task-does-not-exist')
      const said = await waitFor(() => (($('#toast') || {}).textContent || '').indexOf('已经不在了') >= 0, 3000, 'missing toast')
      check('★★ 通知指向的对象已不存在 → 明说（不许静默什么都不做）', said,
        (($('#toast') || {}).textContent || '').slice(0, 80))
    }


    // ══ 全局外观：扁平 / 阴影两套（2026-10-30，卡 task-20261030-004）════════
    // 判据不是"设置里有俩按钮"，而是**真按下去、真量计算样式、真落盘**：
    //   ① 默认扁平 → 看板卡片 box-shadow 必须是 none（不是"看起来很淡"）；
    //   ② 切阴影 → <html data-appearance=shadow> 且卡片真的浮起来；
    //   ③ 切回扁平 → 又归零；④ 选择落进 prefs.json（换 origin 也不丢）。
    {
      const T = (id, title, extra = {}) => Object.assign({
        id, title, status: '待办', priority: '中', project: 'demo', tags: [], body: '',
        created: '2026-10-01T00:00:00.000Z', updated: '2026-10-02T00:00:00.000Z',
        fm: { id, title, status: '待办', project: 'demo' }, path: 'C:/mock/task-data/' + id + '.md',
      }, extra)
      window.__fcTest.setTasks([T('ap-1', '外观样例甲'), T('ap-2', '外观样例乙')])
      await openViewTab('待办'); await sleep(300)
      await openViewTab('看板'); await sleep(800)
      const cardEl = $$('#board .card')[0]
      check('  （自检）板上有卡片可量样式', !!cardEl, String($$('#board .card').length))
      check('★★ 默认扁平：看板卡片计算样式里没有阴影（box-shadow: none）',
        !!cardEl && getComputedStyle(cardEl).boxShadow === 'none',
        cardEl ? getComputedStyle(cardEl).boxShadow : '(无卡)')

      const gear = $$('#views button, #bar button').filter((b) => (b.textContent || '').trim() === '⚙')[0]
      if (gear) gear.click()
      await sleep(700)
      const apBtns = $$('#smodal .appearance-btn')
      check('★ 设置页有「外观形态」两档（扁平 / 阴影）', apBtns.length === 2,
        apBtns.map((b) => (b.textContent || '').trim()).join(' | '))
      const nameOf = (b) => ((b.querySelector('.ap-name') || {}).textContent || '').trim()
      const shadowBtn = apBtns.find((b) => nameOf(b) === '阴影')
      check('  两档里有一档叫「阴影」', !!shadowBtn,
        apBtns.map((b) => nameOf(b)).join('|'))
      if (shadowBtn) {
        shadowBtn.click()
        await sleep(450)
        check('★★ 切阴影 → <html data-appearance="shadow">（纯 CSS 生效）',
          document.documentElement.getAttribute('data-appearance') === 'shadow',
          String(document.documentElement.getAttribute('data-appearance')))
        check('★★ 卡片真的浮起来了（计算样式不再是 none）',
          !!cardEl && getComputedStyle(cardEl).boxShadow !== 'none',
          cardEl ? getComputedStyle(cardEl).boxShadow.slice(0, 80) : '(无卡)')
        check('★★ 选择落进 prefs.json（fc_appearance=shadow，换 origin 也不丢）',
          window.__fcTest.prefs().fc_appearance === 'shadow',
          JSON.stringify(window.__fcTest.prefs().fc_appearance))
        check('★ 换外观不动主题（data-theme 保持原样）',
          (document.documentElement.getAttribute('data-theme') || 'default') ===
          (window.__fcTest.prefs().fc_theme || 'default'),
          'theme=' + String(document.documentElement.getAttribute('data-theme')))

        const flatBtn = $$('#smodal .appearance-btn').find((b) => ((b.querySelector('.ap-name') || {}).textContent || '').trim() === '扁平')
        if (flatBtn) flatBtn.click()
        await sleep(450)
        check('★★ 切回扁平 → 又归零（不是"再加一层"）',
          document.documentElement.getAttribute('data-appearance') === 'flat' &&
          !!cardEl && getComputedStyle(cardEl).boxShadow === 'none',
          String(document.documentElement.getAttribute('data-appearance')) + ' / ' +
          (cardEl ? getComputedStyle(cardEl).boxShadow : '(无卡)'))
        check('★ 切回扁平也落盘（fc_appearance=flat）',
          window.__fcTest.prefs().fc_appearance === 'flat',
          JSON.stringify(window.__fcTest.prefs().fc_appearance))
      }
      const closeS = $$('#smodal button').find((b) => (b.textContent || '').trim() === '关闭')
      if (closeS) closeS.click()
      await sleep(300)
    }

    // ══ 整理体检：never_read 接进「整理/体检」（2026-10-30，卡 20261025-006）══
    // 用户原话是「看板一堆待办，不知道到底做了没有」。判据：
    //   ① 两个数字并排出现（没人碰过 / 驳回没人管）；② 口径文案跟数字一起（不是优先级）；
    //   ③ 两个出口真能用 —— 回看板真筛出那批卡、看返工台真展开。
    {
      const T = (id, title, st) => ({
        id, title, status: st, priority: '中', project: 'demo', tags: [], body: '',
        created: '2026-09-01T00:00:00.000Z', updated: '2026-09-02T00:00:00.000Z',
        fm: { id, title, status: st, project: 'demo' }, path: 'C:/mock/task-data/' + id + '.md',
      })
      // 驳回卡真喂一张，这样「看返工台」才验得到（不能只验按钮存在）
      window.__fcTest.setTasks([T('ck-1', '体检样例甲', '待办'), T('ck-2', '被驳回的乙', '驳回')])
      await openViewTab('待办'); await sleep(300)
      await openViewTab('看板'); await sleep(700)

      const gearC = $$('#views button, #bar button').filter((b) => (b.textContent || '').trim() === '⚙')[0]
      if (gearC) gearC.click()
      await sleep(700)
      const dataNav = $$('#smodal .settings-nav-btn').find((b) => (b.textContent || '').indexOf('数据') >= 0)
      check('  设置里有「数据」分类（体检的落点）', !!dataNav)
      if (dataNav) dataNav.click()
      await sleep(500)

      const ckBtn = $$('#smodal button').find((b) => (b.textContent || '').indexOf('整理体检') >= 0)
      check('★ 数据页有「跑一次整理体检」入口', !!ckBtn,
        $$('#smodal h4').map((h) => (h.textContent || '').trim()).join('|'))
      window.__fcTest.reset()
      if (ckBtn) ckBtn.click()
      check('★★ 点体检真走 cleanup:scan（不是本地凑数）',
        await waitFor(() => window.__fcTest.callCount('cleanupScan') > 0, 4000, 'cleanupScan'),
        JSON.stringify(window.__fcTest.calls().map((c) => c.name)))
      // IPC 是异步的：callCount 先动，状态落进页面还要一帧 —— 等结果块出来再断言
      check('★★ 体检结果块渲染出来', await waitFor(() => !!$('.cleanup'), 4000, '.cleanup'))
      check('★★ 两个数字并排出现（没人碰过 2 / 驳回没人管 1）', (() => {
        const t = (($('.cleanup') || {}).textContent || '')
        return t.indexOf('没人碰过') >= 0 && t.indexOf('2') >= 0 && t.indexOf('驳回') >= 0 && t.indexOf('1') >= 0
      })(), (($('.cleanup') || {}).textContent || '').slice(0, 120))
      check('★★ 口径跟着数字（清理候选，不是优先级）',
        (($('.cleanup-rule') || {}).textContent || '').indexOf('不是优先级') >= 0,
        (($('.cleanup-rule') || {}).textContent || '').slice(0, 80))
      check('★ 清单里能看到具体是哪张卡（不是只有一个数）',
        (($('.cleanup-list') || {}).textContent || '').indexOf('没人读过的甲') >= 0)

      const toNR = $$('#smodal .cleanup-row button').find((b) => (b.textContent || '').indexOf('回看板筛出来') >= 0)
      check('  体检结果里有「回看板筛出来」出口', !!toNR)
      if (toNR) toNR.click()
      await sleep(900)
      check('★★ 点了真回到看板并筛出「没人碰过」（设置关了、筛选生效）', (() => {
        const t = (($('#toast') || {}).textContent || '')
        return !$('#smodal') && ($$('.fbar-chip').some((c) => (c.textContent || '').indexOf('没人碰过') >= 0) ||
          (($('.fbar') || {}).textContent || '').indexOf('没人碰过') >= 0)
      })(), $$('.fbar-chip').map((c) => (c.textContent || '').trim()).join('|'))
      // 收尾：撤掉筛选，别把后面几节拖进空板
      const clearAllC = $('.fbar-clear')
      if (clearAllC) { clearAllC.click(); await sleep(400) }
      const chipXC = $$('.fbar-chip').find((c) => (c.textContent || '').indexOf('没人碰过') >= 0)
      if (chipXC) { const x = chipXC.querySelector('.fbar-x'); if (x) { x.click(); await sleep(400) } }

      // 出口二：看返工台 → 板子上的返工台要真的展开
      const gearD = $$('#views button, #bar button').filter((b) => (b.textContent || '').trim() === '⚙')[0]
      if (gearD) gearD.click()
      await sleep(600)
      const dataNav2 = $$('#smodal .settings-nav-btn').find((b) => (b.textContent || '').indexOf('数据') >= 0)
      if (dataNav2) dataNav2.click()
      await sleep(400)
      // 设置弹窗关掉再开，面板是重新挂载的（结果不跨会话留存）—— 再体检一次，模拟真实第二次使用
      const ckBtn2 = $$('#smodal button').find((b) => (b.textContent || '').indexOf('整理体检') >= 0)
      if (ckBtn2) ckBtn2.click()
      await waitFor(() => !!$('.cleanup'), 4000, '.cleanup 第二次')
      const toRW = $$('#smodal .cleanup-row button').find((b) => (b.textContent || '').indexOf('看返工台') >= 0)
      check('  体检结果里有「看返工台」出口', !!toRW)
      if (toRW) toRW.click()
      await sleep(900)
      check('★★ 点了真回看板并展开返工台（逐张处置那一栏出现）',
        !$('#smodal') && !!$('.rework-panel') &&
        (($('.rework-panel') || {}).textContent || '').indexOf('被驳回的乙') >= 0,
        'panel=' + !!$('.rework-panel'))
      // 收尾：折叠返工台，别让下一节（它要验"展开"这一步）拿到已展开的状态
      const collapse = $$('.rework-bar button').find((b) => (b.textContent || '').trim() === '收起')
      if (collapse) { collapse.click(); await sleep(350) }
    }

    // ══ 驳回返工台（2026-10-30 暮雨第 3 条）════════════════════════════════
    // 「驳回的东西好像也永远不看，是方寸的缺陷吗？」——是，两层：
    //   ① 看板把「完成 / 驳回」默认折叠，驳回卡和做完的一样被收起来；
    //   ② 驳回不是终态：它欠一个返工或一个"算了"。这条要把它重新推回眼前。
    // 判据：条数来自夹具真身、理由取**最后一条**、没写理由要点名、两个出口真走通道。
    {
      const rw = (id, extra = {}) => Object.assign({
        id, title: '返工样例 ' + id, status: '驳回', priority: '中', project: 'demo', tags: [], body: '',
        created: '2026-09-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z',
        result_log: '[2026-10-01 10:00] 验收驳回：第一次：按钮点不动\n[2026-10-20 09:30] 验收驳回：第二次：驳回后没人管了',
        fm: { id, title: '返工样例 ' + id, status: '驳回', project: 'demo' },
        path: 'C:/mock/task-data/' + id + '.md',
      }, extra)
      window.__fcTest.setTasks([
        rw('rw-old'),
        // 最新一条只写「验收驳回」不写理由：必须被点名，而不是继承上一条的旧理由
        rw('rw-new', { updated: '2026-10-28T00:00:00.000Z', result_log: '[2026-10-28 09:30] 验收驳回' }),
        rw('rw-done', { status: '完成', title: '做完的不算' }),
        rw('rw-todo', { status: '待办', title: '在做的也不算' }),
      ])
      await openViewTab('待办'); await sleep(300)
      await openViewTab('看板'); await sleep(800)

      const bar = $('.rework-bar')
      check('★★ 被驳回后没人管的卡会重新推到眼前（提示条出现）', !!bar,
        $$('#board .card').length + ' 张卡 / bar=' + !!bar)
      check('★ 条数来自夹具真身（2 张，完成与待办不算）',
        !!bar && (bar.textContent || '').indexOf('2') >= 0, ((bar || {}).textContent || '').slice(0, 80))
      check('★ 文案说清为什么要这条（两列默认折叠，不推就石沉大海）',
        !!bar && (bar.textContent || '').indexOf('折叠') >= 0, ((bar || {}).textContent || '').slice(0, 120))

      const openBtn = $$('.rework-bar button').find((b) => (b.textContent || '').indexOf('逐张过一遍') >= 0)
      check('  有「逐张过一遍」入口', !!openBtn)
      if (openBtn) {
        openBtn.click()
        await sleep(350)
        const rows = $$('.rework-row')
        check('★★ 展开后逐张列出（2 行，不含完成/待办）', rows.length === 2,
          rows.map((r) => (r.textContent || '').trim().slice(0, 16)).join(' | '))
        check('★ 晾得最久的排最前（rw-old 第一行）',
          !!rows[0] && (rows[0].textContent || '').indexOf('rw-old') >= 0,
          (rows[0] ? (rows[0].textContent || '') : '').slice(0, 40))
        check('★★ 理由取**最后一条**驳回记录（第二次，不是第一次）', (() => {
          const t = (rows[0] || {}).textContent || ''
          return t.indexOf('第二次：驳回后没人管了') >= 0 && t.indexOf('第一次') < 0
        })(), (rows[0] ? (rows[0].textContent || '') : '').slice(0, 120))
        check('★★ 最新驳回没写理由的那条被点名（不继承旧理由、不装没问题）', (() => {
          const r = rows.find((x) => (x.textContent || '').indexOf('rw-new') >= 0)
          return !!r && (r.textContent || '').indexOf('没写理由') >= 0 && (r.textContent || '').indexOf('第二次') < 0
        })(), (rows.find((x) => (x.textContent || '').indexOf('rw-new') >= 0) || {}).textContent || '')

        // 出口一：退回返工 —— 真走通道（unarchiveTask），不是只把行藏起来
        const _oc = window.confirm
        const confirms = []
        window.confirm = (m) => { confirms.push(String(m)); return true }
        window.__fcTest.reset()
        const backBtn = $$('.rework-row button').find((b) => (b.textContent || '').indexOf('退回返工') >= 0)
        check('  每行有「退回返工」出口', !!backBtn)
        if (backBtn) {
          backBtn.click()
          await sleep(600)
          check('★★ 点「退回返工」真走 unarchiveTask（不是假动作）',
            window.__fcTest.callCount('unarchiveTask') > 0, JSON.stringify(window.__fcTest.calls().map((c) => c.name)))
          check('★ 确认框说清后果（回到待办、理由保留）',
            confirms.some((m) => m.indexOf('待办') >= 0), confirms.join(' | ').slice(0, 120))
        }
        // 出口二：归档 —— 真走 archiveTask
        window.__fcTest.reset()
        const archBtn = $$('.rework-row button').find((b) => (b.textContent || '').indexOf('归档') >= 0)
        check('  每行有「归档」出口', !!archBtn)
        if (archBtn) {
          archBtn.click()
          await sleep(600)
          check('★★ 点「归档」真走 archiveTask', window.__fcTest.callCount('archiveTask') > 0,
            JSON.stringify(window.__fcTest.calls().map((c) => c.name)))
        }
        window.confirm = _oc
      }

      // 反例：全部处置完（没有驳回卡）→ 这条不许出现（否则它会变成常驻噪音）
      window.__fcTest.setTasks([rw('rw-x', { status: '完成' })])
      await openViewTab('待办'); await sleep(300)
      await openViewTab('看板'); await sleep(700)
      check('★★ 反例：没有驳回卡时提示条消失（不常驻、不吓人）', !$('.rework-bar'))
    }

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
