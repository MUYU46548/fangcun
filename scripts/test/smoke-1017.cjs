/**
 * 定向冒烟（2026-10-17 施工自证）：只跑本轮两件新活 ——
 *   ① 归档快选叠加语义 + 邮箱式全选方框三态
 *   ② 看板分区右键新建（预选该列状态）
 * 为什么存在：全量 renderer-web-assert（553+ 条、几百个 sleep）在无 GPU 沙箱里
 * 虚拟时间跑不完（实测 dump-dom 240s 超时、CDP 90s 预算不够），真机才跑得动。
 * 本脚本用 playwright 常驻实例只执行新增段，渲染慢但断言少，能出真实结果。
 * 结果不替代全量：全量仍以本地 agent 真机跑 renderer-web 全套为准。
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
  const clickText = (t) => { const b = $$('button, .vbtn').find(e => (e.textContent||'').trim() === t); if (b) { b.click(); return true } return false }
  try {
    await sleep(2500)
    ck('切到归档页签', clickText('归档'))
    await sleep(1000)
    ck('快选工具条出现', !!$('.aq-bar'))
    const aqDone = $$('.aq-bar .aq-btn').find(b => (b.textContent||'').indexOf('完成') >= 0)
    const aqRej  = $$('.aq-bar .aq-btn').find(b => (b.textContent||'').indexOf('驳回') >= 0)
    const nOf = (b) => parseInt(((b.querySelector('.aq-n')||{}).textContent||'0').trim(), 10)
    ck('完成/驳回两组都有数', !!aqDone && !aqDone.disabled && !!aqRej && !aqRej.disabled,
      'done=' + (aqDone ? nOf(aqDone) : '-') + ' rej=' + (aqRej ? nOf(aqRej) : '-'))
    const doneN = aqDone ? nOf(aqDone) : 0
    const rejN = aqRej ? nOf(aqRej) : 0
    aqDone.click(); await sleep(500)
    let bc = $('.batch-bar .batch-count')
    ck('点完成 = 选完成组（进入多选）', !!bc && (bc.textContent||'').indexOf('已选 ' + doneN) >= 0, bc && bc.textContent)
    aqRej.click(); await sleep(500)
    bc = $('.batch-bar .batch-count')
    ck('★ 再点驳回 = 两组叠加（上一组不被冲掉）', !!bc && (bc.textContent||'').indexOf('已选 ' + (doneN + rejN)) >= 0, bc && bc.textContent)
    ck('两组按钮都点亮', aqDone.classList.contains('on') && aqRej.classList.contains('on'),
      'done.on=' + aqDone.classList.contains('on') + ' rej.on=' + aqRej.classList.contains('on'))
    aqDone.click(); await sleep(500)
    bc = $('.batch-bar .batch-count')
    ck('★ 完成组再点一下 = 只取消该组（其他保留）', !!bc && (bc.textContent||'').indexOf('已选 ' + rejN) >= 0, bc && bc.textContent)
    ck('按钮态：完成灭 / 驳回亮', !aqDone.classList.contains('on') && aqRej.classList.contains('on'))
    const master = $('.aq-bar .aq-master input')
    ck('全选方框存在', !!master)
    ck('部分选中 = indeterminate 横线且不勾', !!master && master.indeterminate === true && master.checked === false,
      'ind=' + (master && master.indeterminate) + ' checked=' + (master && master.checked))
    master.click(); await sleep(500)
    bc = $('.batch-bar .batch-count')
    ck('★ 方框点一下 = 全选当前看到的', !!bc && (bc.textContent||'').indexOf('已选 ' + (doneN + rejN)) >= 0, bc && bc.textContent)
    ck('全选态 = 勾（横线消失）', master.indeterminate === false && master.checked === true)
    master.click(); await sleep(500)
    bc = $('.batch-bar .batch-count')
    ck('★ 方框再点一下 = 全不选', !!bc && (bc.textContent||'').indexOf('已选 0') >= 0, bc && bc.textContent)
    const cancelBtn = $$('.batch-bar button').find(b => (b.textContent||'').trim() === '取消')
    if (cancelBtn) { cancelBtn.click(); await sleep(450) }
    ck('退出多选（批量栏消失）', !$('.batch-bar'))
    ck('切回看板', clickText('看板'))
    await sleep(1000)
    const col0 = $$('#board .col').filter(c => c.querySelector('[data-id]'))[0]
    ck('列视图有带卡的分区', !!col0, col0 ? col0.getAttribute('data-status') : '(没有)')
    const want = col0 ? (col0.getAttribute('data-status') || '') : ''
    col0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await sleep(500)
    const menu = $('.ctx-menu.ctx-other')
    const newItem = menu ? $$('.ctx-menu.ctx-other button').find(b => (b.textContent||'').indexOf('在此列新建任务') >= 0) : null
    ck('★ 列空白右键 = 分区菜单弹出', !!menu && !!newItem, menu ? (menu.textContent||'').slice(0, 40) : '(菜单没出现)')
    newItem.click(); await sleep(650)
    const overlay = $('#modal-overlay')
    const h3 = overlay ? overlay.querySelector('h3') : null
    ck('★ 点「在此列新建」= 新建弹窗打开', !!overlay && !!h3 && (h3.textContent||'').indexOf('新建任务') >= 0, h3 && h3.textContent)
    const sel = overlay ? $$('#modal-overlay select').find(s => ['待办','进行中','待验收','完成','驳回'].indexOf(s.value) >= 0) : null
    ck('★ 状态预选 = 右键的那一列', !!sel && sel.value === want, 'sel=' + (sel && sel.value) + ' want=' + want)
    const cBtn = overlay ? $$('#modal-overlay button').find(b => (b.textContent||'').trim() === '取消') : null
    if (cBtn) { cBtn.click(); await sleep(450) }
    const card0 = col0.querySelector('[data-id]')
    card0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await sleep(500)
    const menu2 = $('.ctx-menu.ctx-other')
    ck('卡片右键不弹分区菜单（不抢卡片的）', !menu2, 'menu=' + !!menu2)
  } catch (e) {
    out.push('FAIL 异常中断: ' + ((e && e.stack) || e))
  }
  const fails = out.filter(l => l.indexOf('FAIL') === 0).length
  // 结果挂 window，不走 DOM：outerHTML 里连 script 源码都算文本，
  // 结果标记写进源码的话 content() 会在页面还没执行时就"命中源码"（首跑实测踩中）
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
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>FC smoke</title>',
    cssMatch ? `<link rel="stylesheet" href="./${cssMatch[1]}">` : '',
    '<script>', browserPreload(), ACK_SEED, '</script>',
    '</head><body><div id="app"></div>',
    '<script>', bundle, '</script>',
    '<script>', TAIL, '</script>',
    '</body></html>',
  ].join('\n')
  const hp = path.join(DIST, '__smoke-1017.html')
  fs.writeFileSync(hp, doc, 'utf-8')

  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] })
  const page = await browser.newPage()
  await page.goto('file:///' + hp.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded', timeout: 60000 })
  let result = ''
  for (let i = 0; i < 360; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      const done = await page.evaluate(() => window.__FC_DONE === true)
      if (done) { result = await page.evaluate(() => window.__FC_RESULT || ''); break }
    } catch { /* 页面还在跑 */ }
  }
  console.log(result || 'FAIL  6 分钟没等到断言收口')
  try { fs.unlinkSync(hp) } catch { /* 留着也无妨 */ }
  await browser.close()
  const m = (result || '').match(/RESULT (\d+) \/ (\d+)/)
  process.exit(m && Number(m[2]) === 0 ? 0 : 1)
})()
