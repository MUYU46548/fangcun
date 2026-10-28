/**
 * 项目梯度榜（Tier List）数据层与边界 —— 2026-10-25 暮雨
 *
 * 两轮口径：「就一个手动排序小玩具」+「放进项目页签里面就好……和我丢的参考图里的梯度榜完全不同」。
 * 所以形状是**分档**（几档 + 每档若干项目），不是一维名次。
 *
 * 本测试钉住：
 *  ① 读写往返 / 默认四档 / 跨档去重（一个项目只能在一档）/ 坏文件不抛
 *  ② **边界**：只能被项目页的「梯度榜」摆法用 —— 不参与看板分组、不影响一屏、不写 registry
 *
 * 运行：node scripts/test/e2e-project-tiers.cjs
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

const TEST_ROOT = path.join(os.tmpdir(), 'fc-tiers-' + Date.now())
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
  console.log('== 项目梯度榜测试 ==')
  console.log('root:', TEST_ROOT)
  fs.mkdirSync(path.join(TEST_ROOT, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(TEST_ROOT, 'registry.yaml'),
    'members:\n  - 暮雨\nprojects:\n  - id: demo\n    name: 演示\n', 'utf-8')

  const data = require(path.join(DIST, 'data', 'index.js'))
  const pt = require(path.join(DIST, 'services', 'projectTiers.js'))
  data.setDataDir(TEST_ROOT)
  const file = path.join(TEST_ROOT, 'task-data', 'project-tiers.json')

  // ── ① 缺失 = 默认四档（开箱就能拖，不是一片空白）───────────────────
  {
    const r = pt.readTiers()
    check('① 文件不存在 → ok 且给默认四档', r.ok === true && r.tiers.length === 4, JSON.stringify(r.tiers))
    check('① 默认最后一档叫「搁置」（对应"没钱做、先放着"的场景）',
      r.tiers[3].label === '搁置', r.tiers.map((t) => t.label).join('/'))
    check('① 默认档位都是空的（不替用户预设归属）',
      r.tiers.every((t) => t.items.length === 0))
  }

  // ── ② 写入 ⇄ 读回（分档结构完整） ───────────────────────────────────
  {
    const input = [
      { id: 'core', label: '核心', items: ['sitian', 'fangcun-base'] },
      { id: 'hold', label: '搁置', items: ['project-2'] },
    ]
    const w = pt.writeTiers(input)
    check('② 写入 ok', w.ok === true, JSON.stringify(w))
    const r = pt.readTiers()
    check('② 读回档数与每档项目**逐项相等**',
      JSON.stringify(r.tiers) === JSON.stringify(input), JSON.stringify(r.tiers))
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    check('② 落盘结构是 { tiers, updatedAt }',
      Array.isArray(raw.tiers) && typeof raw.updatedAt === 'string', JSON.stringify(raw).slice(0, 120))
  }

  // ── ③ 一个项目只能在一档（跨档去重，先出现的赢）────────────────────
  {
    const w = pt.writeTiers([
      { id: 'a', label: 'A', items: ['x', 'y'] },
      { id: 'b', label: 'B', items: ['y', 'z'] },
    ])
    const got = w.tiers.map((t) => t.items)
    check('③ 重复项目只留在先出现的档里', JSON.stringify(got) === JSON.stringify([['x', 'y'], ['z']]),
      JSON.stringify(got))
    check('③ 档内重复也去重', (() => {
      const r = pt.writeTiers([{ id: 'a', label: 'A', items: ['x', 'x', 'x'] }])
      return r.tiers[0].items.length === 1
    })())
    // 手改文件写出跨档重复 —— 读侧也要兜一次
    fs.writeFileSync(file, JSON.stringify({ tiers: [{ id: 'a', label: 'A', items: ['q'] }, { id: 'b', label: 'B', items: ['q'] }] }), 'utf-8')
    const r = pt.readTiers()
    check('③ 读侧同样跨档去重（手改文件不炸）',
      JSON.stringify(r.tiers.map((t) => t.items)) === JSON.stringify([['q'], []]),
      JSON.stringify(r.tiers.map((t) => t.items)))
  }

  // ── ④ 坏档位条目：缺 id 的档丢弃、缺 label 用 id 顶 ────────────────
  {
    fs.writeFileSync(file, JSON.stringify({
      tiers: [{ label: '没有 id 的档', items: ['a'] }, { id: 't2', items: ['b'] }],
    }), 'utf-8')
    const r = pt.readTiers()
    check('④ 缺 id 的档被丢弃（不然删不掉也改不了名）', r.tiers.length === 1, JSON.stringify(r.tiers))
    check('④ 缺 label 的档用 id 顶上（不留空标签）', r.tiers[0].label === 't2', r.tiers[0].label)
  }

  // ── ⑤ 空数组 = 用户把档全删了：尊重，不塞回默认 ─────────────────────
  {
    const w = pt.writeTiers([])
    check('⑤ 全部删光 → 落盘为空（尊重用户）', w.ok && w.tiers.length === 0, JSON.stringify(w.tiers))
    const r = pt.readTiers()
    check('⑤ 读回也是空（不会偷偷塞回默认四档）', r.ok && r.tiers.length === 0, JSON.stringify(r.tiers))
  }

  // ── ⑥ 坏文件：不抛、给原因、不覆盖、之后仍可写 ─────────────────────
  {
    fs.writeFileSync(file, '{ 这不是 json', 'utf-8')
    let r
    let threw = false
    try { r = pt.readTiers() } catch { threw = true }
    check('⑥ 坏文件不抛异常', threw === false)
    check('⑥ ok=false 且带人话原因', !!r && r.ok === false && !!r.error, JSON.stringify(r && r.error))
    check('⑥ 坏文件时回落默认四档（界面不瘫）', !!r && r.tiers.length === 4, JSON.stringify(r && r.tiers.length))
    check('⑥ 坏文件留在原地（没被覆盖/删掉）', fs.readFileSync(file, 'utf-8').includes('这不是 json'))
    const w = pt.writeTiers([{ id: 'core', label: '核心', items: ['z'] }])
    check('⑥ 坏文件之后仍能正常写入并读回',
      w.ok && JSON.stringify(pt.readTiers().tiers.map((t) => t.items)) === JSON.stringify([['z']]))
  }

  // ── ⑦ 边界：只服务项目页的「梯度榜」摆法 ───────────────────────────
  {
    const grouping = read('desktop/src/shared/grouping.ts')
    check('⑦ 看板分组不认识梯度榜（grouping.ts 里没有 projectTiers/project-tiers）',
      !grouping.includes('projectTiers') && !grouping.includes('project-tiers'))

    const trip = read('desktop/src/main/services/tripBoard.ts')
    check('⑦ 一屏不认识梯度榜（tripBoard.ts 里没有 projectTiers/project-tiers）',
      !trip.includes('projectTiers') && !trip.includes('project-tiers'))

    const svc = read('desktop/src/main/services/projectTiers.ts')
    check('⑦ 梯度榜不碰 registry（不出现 registry.yaml / REGISTRY_PATH）',
      !svc.includes('registry.yaml') && !svc.includes('REGISTRY_PATH'))

    const board = read('desktop/src/renderer/views/ProjectTierBoard.vue')
    check('⑦ 胶囊可拖 + 落点有 drop 处理',
      board.includes('draggable="true"') && board.includes('@drop.prevent="onDrop'))
    check('⑦ 拖完立即保存（没有"保存"按钮）', /await .*projectTiersSet/.test(board))
    // ⚠ 这条是真 bug 的回归：tiers.value 是 Vue 代理，直接过桥必抛「could not be cloned」
    check('⑦ 过桥前过了 toPlain（Vue 代理不能直接进 IPC）',
      /projectTiersSet\(toPlain\(tiers\.value\)\)/.test(board),
      '直接传 tiers.value 会在结构化克隆那一跳抛错，界面表现为"拖了没反应"')
    check('⑦ 删档有确认（项目会回「未分档」而不是消失）',
      /confirm\(`删掉「\$\{t\.label\}」这一档/.test(board))

    const appSrc = read('desktop/src/renderer/App.vue')
    // ⚠ 别再钉死整个数组：每加一种摆法（trip/tier/mismatch/rice…）都会让「逐字相等」变红，
    //   而红的原因与梯度榜毫无关系。判据是"它在这个列表里"，不是"列表恰好只有这五个"。
    check('⑦ 它是项目页的一种摆法（PV_VIEWS 含 tier）',
      /const PV_VIEWS: string\[\] = \[[^\]]*'tier'/.test(appSrc))
    check('⑦ 顶栏没有独立 priority 页签（没被提到顶级）',
      !/\{ id: 'priority', label: '优先级' \}/.test(appSrc))
  }

  // ── ⑧ preload / IPC 三方对齐 ────────────────────────────────────────
  {
    const preload = read('desktop/src/preload/index.ts')
    const ipcSrc = read('desktop/src/main/ipc.ts')
    check('⑧ preload 暴露 projectTiersGet', /projectTiersGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('projectTiers:get'\)/.test(preload))
    check('⑧ preload 暴露 projectTiersSet', /projectTiersSet:\s*\(tiers: unknown\)\s*=>\s*ipcRenderer\.invoke\('projectTiers:set'/.test(preload))
    check('⑧ IPC 注册 projectTiers:get', /guardedHandle\('projectTiers:get'/.test(ipcSrc))
    check('⑧ IPC 注册 projectTiers:set', /guardedHandle\('projectTiers:set'/.test(ipcSrc))
  }

  console.log(`\n== 结果：${pass}/${fail} ==`)
  if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
}

main()
