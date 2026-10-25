/**
 * 想法 → 待办 正文保真测试（2026-10-25 暮雨第 3 条）
 *
 * 病根：`promoteIdea()` 只把想法的**第一行**当待办标题，其余正文直接丢弃。
 *   注释给的理由是「多行正文塞进去会把列表撑歪」—— 但这句话本身不成立：
 *   待办的内容字段一直是可写长的 textarea（`todoEdit_.title`，placeholder
 *   「待办内容（可以写长一点）」），列表靠 `.todo-title` 的 nowrap+ellipsis 压成一行；
 *   而且「日志 → 待办」那条路（`logToTodoText`）早就把全文塞进 title 了。
 *   → 只有一个方向在丢内容，用户原话：「转进来只剩日志里的标题，甚至不是正文，还被截断了。」
 *
 * 钉住的语义：
 *   ① 多行想法立项 → 待办 title 与原文**逐字符相等**（换行、空行、缩进都不许动）
 *   ② 单行想法立项 → 行为不变（不凭空加「来源」行）
 *   ③ 立项后想法状态 = 已立项，且 promoted.id == 新建待办的 id（双向可查）
 *   ④ 重复立项被拒（防重复建待办）
 *   ⑤ 反例自证：源码里不许再出现「取第一行当标题」的写法
 *   ⑥ 源码守卫：待办 → 日志 必须把全文放进 content 参数，且标题取首行
 *
 * 运行：node scripts/test/e2e-ideas-flow.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-ideas-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const REPO = path.resolve(__dirname, '../..')

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

// 暮雨 2026-10-25 重发的那段（本地图文本标注建议），带空行与长行 —— 就是为了验"一位不丢"
const MULTI = [
  '地图文本标注是地图编辑器品类标配（Tiled、易制地图、MapDesigner 全有），源界只是再一次印证它在清单里。落位建议：',
  '',
  '不需要单独开任务卡。文本标注本质上是"第五种笔刷"——点击放标签、拖拽定位、双击改字、样式面板（字号/颜色/描边）。',
  '架构上直接搭任务卡 B（自由绘制）的便车，作为 B 卡跑通后的追加项，或者并进 C 卡的图层体系一起做',
  '唯一要留心的设计点：标签要挂在图层上随地图一起缩放，别做成浮在画布上的独立控件——这条写进 B/C 卡的验收判据一句话就够',
].join('\n')

function main() {
  console.log('== 想法 → 待办 正文保真测试 ==')
  console.log('root:', TEST_ROOT)
  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  fs.writeFileSync(
    path.join(TEST_ROOT, 'registry.yaml'),
    'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n',
    'utf-8'
  )

  const data = require(path.join(DIST, 'data', 'index.js'))
  const ideas = require(path.join(DIST, 'services', 'ideas.js'))
  const todos = require(path.join(DIST, 'services', 'todos.js'))
  data.setDataDir(TEST_ROOT)

  // ── ① 多行想法：立项后逐字符保真 ─────────────────────────────────────
  {
    const r = ideas.addIdea(MULTI)
    check('① 多行想法已记下（未被长度上限拦）', r.ok === true, JSON.stringify(r).slice(0, 120))
    const ideaId = r.idea.id
    const p = ideas.promoteIdea(ideaId)
    check('① 立项成功', p.ok === true, JSON.stringify(p).slice(0, 200))

    const list = todos.listTodos()
    check('① 待办真的建出来了（1 条）', list.length === 1, String(list.length))
    const todo = list[0]
    check('① 待办内容与原文**逐字符相等**', todo.title === MULTI,
      `实际 ${todo.title.length} 字 / 期望 ${MULTI.length} 字；结尾=${JSON.stringify(todo.title.slice(-30))}`)
    check('① 空行没被吃掉', todo.title.includes('\n\n'), JSON.stringify(todo.title.slice(0, 60)))
    check('① 末行没被截断', todo.title.endsWith('一句话就够'), JSON.stringify(todo.title.slice(-20)))
    check('① 想法状态 = 已立项', ideas.listIdeas().find((x) => x.id === ideaId).status === '已立项')
    check('① 想法记住了待办 id（双向可查）',
      ideas.listIdeas().find((x) => x.id === ideaId).promoted?.id === todo.id)

    // ── ④ 重复立项被拒 ────────────────────────────────────────────────
    const p2 = ideas.promoteIdea(ideaId)
    check('④ 同一条想法再立项被拒', p2.ok === false, JSON.stringify(p2))
    check('④ 待办数量没变（没建出第二条）', todos.listTodos().length === 1, String(todos.listTodos().length))
  }

  // ── ② 单行想法：行为不变 ─────────────────────────────────────────────
  {
    const r = ideas.addIdea('单行念头：给同步按钮加进度')
    const p = ideas.promoteIdea(r.idea.id)
    const t = todos.listTodos().find((x) => x.title.includes('单行念头'))
    check('② 单行想法立项成功', p.ok && !!t, JSON.stringify(p).slice(0, 120))
    check('② 单行内容原样（不加多余来源行）', t.title === '单行念头：给同步按钮加进度', JSON.stringify(t.title))
  }

  // ── ③ 空白与首尾空格按原样处理（只 trim 首尾，不动内部） ──────────────
  {
    const src = '第一段\n  缩进行要保留\n\t制表符也保留'
    const r = ideas.addIdea(src)
    const p = ideas.promoteIdea(r.idea.id)
    const t = todos.listTodos().find((x) => x.title.startsWith('第一段'))
    check('③ 缩进与制表符原样保留', !!t && t.title === src, JSON.stringify(t && t.title))
  }

  // ── ⑦ 长度上限：默认 / 滑块可调 / 硬上限夹紧 / 坏值回落 ────────────────
  //    2026-10-25 暮雨：「MAX_TEXT = 4000 太小了……设个硬上限 20000」。
  //    主进程是真守门人（prefs.json 可以手改，它必须再夹一次），这里只测它。
  {
    const prefsPath = path.join(TEST_ROOT, 'prefs.json')
    const writePrefs = (v) => fs.writeFileSync(prefsPath, JSON.stringify({ fc_idea_max_chars: v }), 'utf-8')
    const filler = (n) => 'a'.repeat(n)

    check('⑦ 默认上限 = 10000', ideas.ideaTextLimit() === 10000, String(ideas.ideaTextLimit()))
    check('⑦ 默认下正好 10000 字可存', ideas.addIdea(filler(10000)).ok === true)
    const over = ideas.addIdea(filler(10001))
    check('⑦ 默认下 10001 字被拒', over.ok === false, JSON.stringify(over).slice(0, 120))
    check('⑦ 拒绝文案给出可调指引（不让人干瞪眼）', /设置/.test(String(over.error)), String(over.error))

    writePrefs(2000)
    check('⑦ 设成 2000 立刻生效（不重启）', ideas.ideaTextLimit() === 2000, String(ideas.ideaTextLimit()))
    check('⑦ 2000 字可存', ideas.addIdea(filler(2000)).ok === true)
    check('⑦ 2001 字被拒', ideas.addIdea(filler(2001)).ok === false)

    writePrefs(999999)
    check('⑦ 手改 prefs 越界 → 夹到硬上限 20000',
      ideas.ideaTextLimit() === 20000, String(ideas.ideaTextLimit()))
    check('⑦ 夹紧后 20001 字仍被拒', ideas.addIdea(filler(20001)).ok === false)

    // ⚠ 坏值必须分两类（「空值/坏值要有分类」这条纪律）：
    //   ① **越界数字**（0 / -5 / 999999）→ 夹到边界。它读得懂，只是超出量程，
    //      夹到 1000/20000 是"你填了但太小/太大"的明确答复；
    //   ② **读不懂**（'abc' / null）→ 回落默认。它不是数字，不该被当成 0 去夹。
    for (const bad of ['abc', null, undefined, {}, [], true, false]) {
      writePrefs(bad)
      check(`⑦ 读不懂的值 ${JSON.stringify(bad)} 回落默认 10000`,
        ideas.ideaTextLimit() === 10000, String(ideas.ideaTextLimit()))
    }
    // `[]` 单列一条 + 注释：`Number([]) === 0`、`Number(true) === 1` 是 JS 强转陷阱，
    // 靠 Number() 兜底会把「读不懂」静默变成 0/1 再夹到下限 —— 本轮测试当场抓到过。
    writePrefs([])
    check('⑦ 陷阱：[] 不许被 Number() 强转成 0（应回落默认而非夹到 1000）',
      ideas.ideaTextLimit() === 10000, String(ideas.ideaTextLimit()))
    // 字符串数字容错：手改 prefs 常带引号，认得出来就该生效
    writePrefs('8000')
    check('⑦ 手改成字符串 "8000" 也认（容错）', ideas.ideaTextLimit() === 8000, String(ideas.ideaTextLimit()))
    for (const small of [0, -5, 500]) {
      writePrefs(small)
      check(`⑦ 越界小数 ${small} 夹到下限 1000`,
        ideas.ideaTextLimit() === 1000, String(ideas.ideaTextLimit()))
    }
  }

  // ── ⑤⑥ 源码守卫 ─────────────────────────────────────────────────────
  {
    const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf-8').replace(/\r\n/g, '\n')
    const ideasSrc = read('desktop/src/main/services/ideas.ts')
    // 反例判据：promoteIdea 里再出现「split('\n')...[0]」就是又回去砍首行了
    const promoteBody = ideasSrc.slice(ideasSrc.indexOf('export function promoteIdea'))
      .split('export function unpromoteIdea')[0]
    check('⑤ promoteIdea 不再「取第一行」',
      !/split\('\\n'\)[\s\S]{0,80}\[0\]/.test(promoteBody),
      '又出现 split 后取 [0] = 正文会再丢一次')
    check('⑤ promoteIdea 把原文整段传给 createTodo',
      /const title = cur\.text\.trim\(\)/.test(promoteBody))

    const app = read('desktop/src/renderer/App.vue')
    const conv = app.slice(app.indexOf('async function convertTodoToLog'))
      .split('function toggleLogBatchMode')[0]
    check('⑥ 待办→日志：标题取首行（titleLines...filter...[0]）',
      /titleLines\.map\(x => x\.trim\(\)\)\.filter\(Boolean\)\[0\]/.test(conv))
    check('⑥ 待办→日志：多行时把全文放进正文',
      /titleLines\.length > 1\)\s*bodyParts\.push\(full\)/.test(conv))
    check('⑥ 待办→日志：正文参数已接线（不再传空串表达式当正文）',
      /bodyParts\.join\('\\n\\n'\)/.test(conv))

    // ⑦b 量程常量两边必须逐字一致 —— 主进程守门、渲染层画滑块，任一边改了另一边没跟上
    //     就会出现"滑块拉到 20000，主进程只认 10000"这种看着像坏了的状态。
    const mainIdeas = read('desktop/src/main/services/ideas.ts')
    const pick = (src, name) => {
      const m = src.match(new RegExp(name + '\\s*=\\s*(\\d+)'))
      return m ? m[1] : null
    }
    for (const k of ['IDEA_TEXT_MIN', 'IDEA_TEXT_DEFAULT', 'IDEA_TEXT_HARD_MAX']) {
      const a = pick(mainIdeas, k)
      const b = pick(app, k)
      check(`⑦ 常量 ${k} 两侧一致（主进程 ${a} / 渲染层 ${b}）`, !!a && a === b)
    }
    check('⑦ 主进程不再有裸 MAX_TEXT = 4000', !/const MAX_TEXT = 4000/.test(mainIdeas))
    check('⑦ 主进程上限走 ideaTextLimit()（不是常量硬编码）',
      /const MAX_TEXT = ideaTextLimit\(\)/.test(mainIdeas))
    check('⑦ 渲染层滑块量程用常量、不写死数字',
      /:min="IDEA_TEXT_MIN" :max="IDEA_TEXT_HARD_MAX"/.test(app))
  }

  console.log(`\n== 结果：${pass}/${fail} ==`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
}

main()
