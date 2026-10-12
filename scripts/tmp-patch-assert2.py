# 一次性补丁（用完即删）：顶栏「看与做分两层」后同步断言选择器
import io
p = 'desktop/test/renderer-web-assert.js'
s = io.open(p, encoding='utf-8').read()
n = 0


def rep(old, new, tag):
    global s, n
    assert old in s, tag
    s = s.replace(old, new)
    n += 1


rep("    const gear = $$('#bar button').find((b) => (b.textContent || '').trim() === '⚙')\n    check('顶栏有设置入口（⚙）', !!gear)",
    "    // ⚠ 2026-10-12「看与做分两层」后，⚙ 从 #bar 搬到了页签行右端 ——\n"
    "    //   判据改成**全页找**（不绑定容器）：这条守的是「有设置入口」，不是「它在哪个容器里」。\n"
    "    const gear = $$('button').find((b) => (b.textContent || '').trim() === '⚙')\n"
    "    check('有设置入口（⚙，现位于页签行右端）', !!gear)", 'gear')

rep("    // ⚠ 类名 `.st-filter` **故意保留**（它是\"看板有自己的状态筛选\"这件事的锚点）。这里验：\n"
    "    const stBtn = $('.st-filter')\n"
    "    check('★ 看板顶栏有状态筛选（触发按钮，类名仍是 .st-filter）', !!stBtn,\n"
    "      stBtn ? String(stBtn.textContent).trim() : '(没找到 .st-filter)')",
    "    // ⚠ 2026-10-12「看与做分两层」后：**「项目」「状态」两个独立触发按钮撤掉了** ——\n"
    "    //   功能本来就在筛选浮层里，当前值由「生效中」标签承担，**点击次数不变、信息不丢**。\n"
    "    //   所以这里改测**筛选入口**，并补一条「独立按钮确实不在」的设计断言（防下一个 AI 又加回来）。\n"
    "    const stBtn = $('.fbar-filter-btn')\n"
    "    check('★ 看板顶栏有筛选入口（＋筛选；项目/状态两个独立按钮已按分两层撤掉）', !!stBtn,\n"
    "      stBtn ? String(stBtn.textContent).trim() : '(没找到 .fbar-filter-btn)')\n"
    "    check('★ 「项目」「状态」独立触发按钮已撤（防有人又加回来）',\n"
    "      !$('.proj-select') && !$('.st-filter') && !$('.due-filter'),\n"
    "      'proj=' + !!$('.proj-select') + ' st=' + !!$('.st-filter'))", 'stBtn')

rep("      const stB = $('.st-filter')", "      const stB = $('.fbar-filter-btn')", 'stB geo')

rep("    const groupBtn = $$('.fbar-btn').find((b) => (b.textContent || '').indexOf('分组 ·') >= 0)",
    "    const groupBtn = $('.fbar-group-btn')   // 稳定类名（文案已改成只留当前值）", 'groupBtn')

rep("    const SORT_BTN = () => $$('.fbar-btn').find((b) => (b.textContent || '').indexOf('排序 ·') >= 0)",
    "    const SORT_BTN = () => $('.fbar-sort-btn')   // 稳定类名（文案已改成「排序 <当前值>」）", 'SORT_BTN')

rep("""      const sel = $('.proj-select')
      if (sel) {
        sel.click(); await sleep(250)
        const all = $$('.fpop .fpop-opt').find((b) => (b.textContent || '').trim() === '全部项目')
        if (all) all.click()
        await sleep(300)
      }""",
    """      // ⚠ 2026-10-12：项目筛选没有独立按钮了 → 从筛选浮层里选「全部」归零。
      const fbtn = $('.fbar-filter-btn')
      if (fbtn) {
        fbtn.click(); await sleep(280)
        const all = $$('.fpop .fpop-opt').find((b) => (b.textContent || '').trim() === '全部')
        if (all) all.click()
        await sleep(300)
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(200)
      }""", 'proj reset')

io.open(p, 'w', encoding='utf-8').write(s)
print('改了', n, '处')
