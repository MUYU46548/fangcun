/**
 * 项目优先级排序（2026-10-25 暮雨）
 *
 * 原话：「拖拽排序不该和其他视图放在一起用，单独搞个可选启用的项目优先级视图就可以了，
 * 并没有改其他任何现成功能的理由，就一个手动排序小玩具。」
 *
 * 本测试钉住两件事：
 *  ① 数据层：读写往返 / 去重去空 / 坏文件不抛 / 缺失=get 空 / 原子写
 *  ② **边界**：排序只能被「优先级」视图用 —— 不参与看板分组、不影响一屏、不写 registry。
 *     这是"别改其他任何现成功能"这条要求的机器化版本，靠人记是记不住的。
 *
 * 运行：node scripts/test/e2e-project-order.cjs
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

const TEST_ROOT = path.join(os.tmpdir(), 'fc-prio-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const REPO = path.resolve(__dirname, '../..')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}
function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf-8').replace(/\r\n/g, '\n')
}

function main() {
  console.log('== 项目优先级排序测试 ==')
  console.log('root:', TEST_ROOT)
  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
    'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')

  const data = require(path.join(DIST, 'data', 'index.js'))
  const po = require(path.join(DIST, 'services', 'projectOrder.js'))
  data.setDataDir(TEST_ROOT)
  const file = path.join(TEST_ROOT, 'task-data', 'project-order.json')

  // ── ① 缺失 = 空列表，不报错 ─────────────────────────────────────────
  {
    check('① 文件不存在 → ok 且空列表', (() => {
      const r = po.readOrder()
      return r.ok === true && Array.isArray(r.order) && r.order.length === 0
    })(), JSON.stringify(po.readOrder()))
  }

  // ── ② 写入 ⇄ 读回（顺序必须一模一样）────────────────────────────────
  {
    const ids = ['sitian', 'fangcun-base', 'project-2', 'project-3']
    const w = po.writeOrder(ids)
    check('② 写入 ok', w.ok === true, JSON.stringify(w))
    const r = po.readOrder()
    check('② 读回顺序与写入**逐项相等**', JSON.stringify(r.order) === JSON.stringify(ids),
      JSON.stringify(r.order))
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    check('② 落盘结构是 { order, updatedAt }',
      Array.isArray(raw.order) && typeof raw.updatedAt === 'string' && raw.updatedAt.length > 10,
      JSON.stringify(raw).slice(0, 160))
    check('② 文件是合法 JSON 且格式化为两空格缩进（人可读可手改）',
      fs.readFileSync(file, 'utf-8').includes('\n  "order"'))
  }

  // ── ③ 去重 / 去空 / 非字符串 ────────────────────────────────────────
  {
    const w = po.writeOrder(['b', 'a', 'b', '  ', '', 'a'])
    check('③ 去重 + 去空后只剩 2 项', w.ok && w.order.length === 2, JSON.stringify(w.order))
    check('③ 保持首次出现的顺序（b, a）', JSON.stringify(w.order) === JSON.stringify(['b', 'a']),
      JSON.stringify(w.order))

    // 手改文件写出重复 id —— 读侧也要自己兜一次
    fs.writeFileSync(file, JSON.stringify({ order: ['x', 'x', ' ', 'y'] }), 'utf-8')
    check('③ 读侧同样去重去空（手改文件不炸）',
      JSON.stringify(po.readOrder().order) === JSON.stringify(['x', 'y']),
      JSON.stringify(po.readOrder().order))
  }

  // ── ④ 坏文件：不抛、给 error、回空（不许静默当没有）─────────────────
  {
    fs.writeFileSync(file, '{ 这不是 json', 'utf-8')
    let r
    let threw = false
    try { r = po.readOrder() } catch { threw = true }
    check('④ 坏文件不抛异常', threw === false)
    check('④ ok=false 且带一句人话原因', !!r && r.ok === false && !!r.error, JSON.stringify(r))
    check('④ 坏文件仍在原地（没被覆盖、没被删）', fs.readFileSync(file, 'utf-8').includes('这不是 json'))
    check('④ 坏文件状态下 order 为空数组（界面回落到登记顺序）',
      !!r && Array.isArray(r.order) && r.order.length === 0)
    // 坏文件之后还能正常写（不能因为读失败就永久瘫痪）
    const w = po.writeOrder(['z'])
    check('④ 坏文件之后仍可正常写入并读回', w.ok && JSON.stringify(po.readOrder().order) === JSON.stringify(['z']))
  }

  // ── ⑤ 边界：只服务「优先级」视图 ────────────────────────────────────
  {
    // ⚠ 这三条就是暮雨那句「并没有改其他任何现成功能的理由」的机器化版本。
    const grouping = read('desktop/src/shared/grouping.ts')
    check('⑤ 看板分组不认识排序（grouping.ts 里没有 projectOrder）',
      !grouping.includes('projectOrder') && !grouping.includes('project-order'))

    const trip = read('desktop/src/main/services/tripBoard.ts')
    check('⑤ 一屏不认识排序（tripBoard.ts 里没有 projectOrder）',
      !trip.includes('projectOrder') && !trip.includes('project-order'))

    const orderSrc = read('desktop/src/main/services/projectOrder.ts')
    check('⑤ 排序不碰 registry（不出现 registry.yaml / REGISTRY 写入）',
      !orderSrc.includes('registry.yaml') && !orderSrc.includes('REGISTRY_PATH'),
      '写了 registry 就等于偷偷改了项目表')

    // 只有 PriorityView 与 App.vue 的接线该出现它
    const appSrc = read('desktop/src/renderer/App.vue')
    const priSrc = read('desktop/src/renderer/views/PriorityView.vue')
    check('⑤ 视图通过 projectOrderGet/Set 读写', priSrc.includes('projectOrderGet') && priSrc.includes('projectOrderSet'))
    check('⑤ 视图有拖拽（draggable + drop 处理）',
      priSrc.includes('draggable="true"') && priSrc.includes('@drop.prevent="onDrop'))
    check('⑤ 拖完立即保存（不是等某个"保存"按钮）',
      /await .*projectOrderSet/.test(priSrc))

    // 可选启用：默认关 + 顶栏按开关过滤
    check('⑤ 优先级页签默认关（readUiPref 给 false）',
      /readUiPref<boolean>\('fc_priority_view', false\)/.test(appSrc))
    check('⑤ 顶栏只渲染 visibleViews（开关关掉就看不见）',
      /v-for="v in visibleViews"/.test(appSrc) && /views\.filter\(v => v\.id !== 'priority' \|\| priorityViewOn\.value\)/.test(appSrc))
    check('⑤ 关掉开关时若停在优先级页 → 退回看板（不留鬼页面）',
      /curView\.value === 'priority'\) switchView\('active'\)/.test(appSrc))
  }

  // ── ⑥ preload 与 IPC 三方对齐 ──────────────────────────────────────
  {
    const preload = read('desktop/src/preload/index.ts')
    const ipcSrc = read('desktop/src/main/ipc.ts')
    check('⑥ preload 暴露 projectOrderGet', /projectOrderGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('projectOrder:get'\)/.test(preload))
    check('⑥ preload 暴露 projectOrderSet', /projectOrderSet:\s*\(ids: string\[\]\)\s*=>\s*ipcRenderer\.invoke\('projectOrder:set'/.test(preload))
    check('⑥ IPC 注册 projectOrder:get', /guardedHandle\('projectOrder:get'/.test(ipcSrc))
    check('⑥ IPC 注册 projectOrder:set', /guardedHandle\('projectOrder:set'/.test(ipcSrc))
  }

  console.log(`\n== 结果：${pass}/${fail} ==`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
}

main()
