/**
 * 定向冒烟（2026-10-18 Bundle A 施工自证）：只跑本轮新活 ——
 *   超期任务批量改期：批量栏「📅 改期」→ 面板（预填今天+7）→ 确定改期 / 快捷 +30 天
 * 为什么存在：全量 renderer-web-assert（590+ 条、几百个 sleep）在无 GPU 沙箱里
 * 虚拟时间跑不完，真机才跑得动。本脚本用 playwright 常驻实例只执行新增段，
 * 渲染慢但断言少，能出真实结果。结果不替代全量：全量仍以真机跑 renderer-web 为准。
 *
 * 铁律沿 smoke-1017：结果挂 window.__FC_RESULT，别把标记字面写进页面 script 源码
 * （outerHTML 会把源码当文本命中，立刻假成功）。
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright/index.js')

const ROOT = '/home/z/my-project/agents/6ab68a094266f8b7083e2e0a/repos/fangcun'
const DIST = path.join(ROOT, 'desktop', 'dist', 'renderer')
const INDEX = path.join(DIST, 'index.html')
const PRELOAD = path.join(ROOT, 'desktop', 'test', 'renderer-preload.cjs')
const EXE = '/home/z/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'

function browserPreload() {
  const src = fs.readFileSync(PRELOAD, 'utf-8')
  const patched = src.replace(
    /const \{ contextBridge \} = require\('electron'\)/,
    'const contextBridge = { exposeInMainWorld: (k, v) => { window[k] = v } }'
  )
  if (patched === src) throw new Error('假 preload 的 contextBridge 引入方式变了')
  return '(function () {\n' + patched + '\n})();\n'
}

const dmSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'src', 'renderer', 'disclaimer.ts'), 'utf-8')
const dmVer = (dmSrc.match(/DISCLAIMER_VERSION\s*=\s*'([^']+)'/) || [])[1]
const ACK_SEED = "try{localStorage.setItem('fc_disclaimer_ack',JSON.stringify({v:'" + dmVer + "',at:'2026-10-16T00:00:00.000Z'}))}catch(e){}\n"

const TAIL = `(async () => {
  const out = []
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s))
  const ck = (name, ok, info) => out.push((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  [' + String(info).slice(0, 90) + ']' : ''))
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  const plus7 = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 7))
  const plus30 = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 30))
  try {
    await sleep(2500)
    ck('看板列视图渲染（有列有卡）', $$('#board .col').length > 0 && $$('#board .col > .card[data-id]').length > 0,
      'cols=' + $$('#board .col').length + ' cards=' + $$('#board .col > .card[data-id]').length)

    const today0 = window.__fcTest.fixTodayCount()

    // ── 第一轮：面板预填 +7 → 确定改期 ──────────────────────────────
    const bb = $$('#views .batch-mode-btn').find(b => (b.textContent || '').indexOf('任务多选') >= 0)
    ck('页头有「任务多选」入口', !!bb)
    if (bb) {
      bb.click(); await sleep(500)
      const bar = $('.batch-bar')
      const pBtn = bar ? $$('.batch-bar button').find(b => (b.textContent || '').indexOf('改期') >= 0) : null
      ck('批量栏有「📅 改期」', !!pBtn)
      if (pBtn) {
        pBtn.click(); await sleep(300)
        const panel = $('.batch-bar .bp-panel')
        const inp = panel ? panel.querySelector('input[type="date"]') : null
        ck('★ 面板展开且日期预填「今天+7」', !!panel && !!inp && inp.value === plus7,
          'value=' + (inp ? inp.value : '(无)') + ' want=' + plus7)
        const card = $$('#board .col > .card[data-id]')[0]
        if (card) {
          card.click(); await sleep(250)
          const bc = $('.batch-bar .batch-count')
          ck('点卡 = 勾进选择（已选 1）', !!bc && (bc.textContent || '').indexOf('已选 1') >= 0, bc && bc.textContent)
          const okBtn = $$('.bp-panel button').find(b => (b.textContent || '').trim() === '确定改期')
          if (okBtn) {
            okBtn.click(); await sleep(800)
            const call = window.__fcTest.calls().filter(c => c.name === 'batchEdit')
            ck('★★ 确定改期 = batchEdit 按框值（今天+7）真调了',
              call.some(c => c.args && c.args[1] && c.args[1].deadline === plus7),
              JSON.stringify(call.map(c => c.args)))
            ck('改完自动退多选', !$('.batch-bar'))
            const toast = ($('#toast') || {}).textContent || ''
            ck('toast 说清数量与目标日', toast.indexOf('1 个任务的截止日') >= 0 && toast.indexOf(plus7) >= 0, toast)
            const today1 = window.__fcTest.fixTodayCount()
            ck('★★ mock 真落 store：卡从「今天格」被改走（今天格压力 -1）', today1 === today0 - 1,
              'before=' + today0 + ' after=' + today1)
          }
        }
      }
    }
    if ($('.bp-panel')) { const c = $$('.bp-panel button').find(b => (b.textContent || '').trim() === '收起'); if (c) c.click(); await sleep(200) }
    if ($('.batch-bar')) { const c = $$('.batch-bar button').find(b => (b.textContent || '').trim() === '取消'); if (c) c.click(); await sleep(300) }

    // ── 第二轮：快捷 +30 天（不经确定，直接执行）──────────────────────
    const bb2 = $$('#views .batch-mode-btn').find(b => (b.textContent || '').indexOf('任务多选') >= 0)
    if (bb2) {
      bb2.click(); await sleep(500)
      const card2 = $$('#board .col > .card[data-id]')[0]
      if (card2) {
        card2.click(); await sleep(250)
        const pBtn2 = $$('.batch-bar button').find(b => (b.textContent || '').indexOf('改期') >= 0)
        if (pBtn2) {
          pBtn2.click(); await sleep(300)
          const quick = $$('.bp-panel button').find(b => (b.textContent || '').trim() === '+30 天')
          ck('快捷「+30 天」在面板上', !!quick)
          if (quick) {
            quick.click(); await sleep(800)
            const call2 = window.__fcTest.calls().filter(c => c.name === 'batchEdit')
            ck('★★ 点「+30 天」= 直接改期到今天+30（不经确定）',
              call2.some(c => c.args && c.args[1] && c.args[1].deadline === plus30),
              JSON.stringify(call2.map(c => c.args)))
            ck('快捷改完同样退多选', !$('.batch-bar'))
            const today2 = window.__fcTest.fixTodayCount()
            ck('第二轮后「今天格」压力不变（卡已在 +7，不再占今天）', today2 === today0 - 1,
              'want=' + (today0 - 1) + ' got=' + today2)
          }
        }
      }
    }
    if ($('.batch-bar')) { const c = $$('.batch-bar button').find(b => (b.textContent || '').trim() === '取消'); if (c) c.click(); await sleep(300) }
    ck('收尾：多选已退出', !$('.batch-bar'))
  } catch (e) {
    out.push('FAIL 冒烟异常 :: ' + ((e && e.stack) || e))
  }
  const fails = out.filter(l => l.indexOf('FAIL') === 0).length
  window.__FC_RESULT = out.join('\\n') + '\\nRESULT ' + (out.length - fails) + ' / ' + fails
  window.__FC_DONE = true
})()
`

;(async () => {
  const html = fs.readFileSync(INDEX, 'utf-8')
  const jsMatch = html.match(/src="\.\/(assets\/[^"]+\.js)"/)
  const cssMatch = html.match(/href="\.\/(assets\/[^"]+\.css)"/)
  const bundle = fs.readFileSync(path.join(DIST, jsMatch[1]), 'utf-8')
  const doc = [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>FC smoke 1018</title>',
    cssMatch ? `<link rel="stylesheet" href="./${cssMatch[1]}">` : '',
    '<script>', browserPreload(), ACK_SEED, '</script>',
    '</head><body><div id="app"></div>',
    '<script>', bundle, '</script>',
    '<script>', TAIL, '</script>',
    '</body></html>',
  ].join('\n')
  const hp = path.join(DIST, '__smoke-1018.html')
  fs.writeFileSync(hp, doc, 'utf-8')

  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] })
  const page = await browser.newPage()
  await page.goto('file:///' + hp.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded', timeout: 60000 })
  let result = ''
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      const done = await page.evaluate(() => window.__FC_DONE === true)
      if (done) { result = await page.evaluate(() => window.__FC_RESULT || ''); break }
    } catch { /* 页面还在跑 */ }
  }
  console.log(result || '（150s 内没拿到结果）')
  const fails = String(result).split('\n').filter((l) => l.indexOf('FAIL') === 0).length
  const total = String(result).split('\n').filter((l) => l.indexOf('PASS') === 0 || l.indexOf('FAIL') === 0).length
  await browser.close()
  process.exit(fails === 0 && total > 0 ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(2) })
