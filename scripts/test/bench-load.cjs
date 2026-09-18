/**
 * 数据层压测 —— 找 loadTasks 全量扫描的性能拐点
 *
 * 背景：loadTasks/loadAllTasks 是「全量扫描目录 + 全量 readFileSync + 全量 yaml.load」，
 * 无任何索引或缓存。26 个任务时无感，但拐点在哪从未测过。
 *
 * 本脚本在临时目录造 N 个真实格式任务，分阶段计时，回答三个问题：
 *   1. 每个环节（I/O / YAML 解析 / 序列化 / 过滤）各占多少
 *   2. 规模到多少开始肉眼可感
 *   3. 一次页面刷新到底触发了几次全量扫描
 *
 * 只读真实数据，全部在 os.tmpdir() 下造数据，不碰 task-data/
 *
 * 运行：
 *   node scripts/test/bench-load.cjs
 *   node scripts/test/bench-load.cjs --levels=100,1000,5000 --rounds=5
 *   node scripts/test/bench-load.cjs --body=heavy        # 4KB 正文（压力上限）
 *   node scripts/test/bench-load.cjs --projects=12
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── 1. electron 桩注入（必须在业务模块之前） ────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const argOf = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : dflt
}
const LEVELS = argOf('levels', '100,500,1000,2000,5000').split(',').map(Number)
const ROUNDS = Number(argOf('rounds', '3'))
const BODY_MODE = argOf('body', 'real')          // real | heavy
const PROJ_COUNT = Number(argOf('projects', '12'))

const TEST_ROOT = path.join(os.tmpdir(), 'fc-bench-' + Date.now())
const TASK_DIR = path.join(TEST_ROOT, 'task-data')
const ARCHIVE_DIR = path.join(TASK_DIR, 'archive')

// ── 2. 数据生成（贴近真实 task-data 格式：中文键 frontmatter） ─────────
const STATUSES = ['草稿', '待审批', '待办', '进行中', '待验收', '完成', '驳回']
const PROJ_IDS = Array.from({ length: PROJ_COUNT }, (_, i) => `proj-${String(i + 1).padStart(2, '0')}`)
const BATCHES = ['A', 'B', 'C', '']
// 与真实数据一致：标签值不带 # 前缀（带 # 会被 YAML 当注释，js-yaml 直接报错）
// 参考 task-data/task-20260909-001.md → `标签: [看板, 优化]`
const TAGS = ['重构', '文档', '测试', '性能', 'ui', '备份']

// 正文长度按真实分布：多数短，少数带长记录
function makeBody(i) {
  const head = `## 方案\n- [${i % 3 ? 'x' : ' '}] 步骤一：核对现有实现\n- [ ] 步骤二：补断言\n- [ ] 步骤三：跑回归\n## 结果记录\n`
  if (BODY_MODE === 'heavy' || i % 10 === 0) {
    // 长正文：模拟带大段记录/粘贴日志的任务
    const para = '本轮改动涉及数据层解析与渲染两侧，需要同时验证往返保真与未知字段透传。'
    return head + Array.from({ length: BODY_MODE === 'heavy' ? 55 : 22 }, (_, k) => `${k + 1}. ${para}`).join('\n') + '\n'
  }
  return head + `完成度 ${i % 100}%\n`
}

function makeTaskFile(i, archived) {
  const status = archived ? '完成' : STATUSES[i % STATUSES.length]
  const proj = PROJ_IDS[i % PROJ_IDS.length]
  const ts = 1787000000 + i * 37
  const fm = [
    `id: task-bench-${String(i).padStart(6, '0')}`,
    `标题: 压测任务 ${i} —— ${['核对解析', '补测试', '重构视图', '验证备份'][i % 4]}`,
    `项目: [${proj}]`,
    `状态: ${status}`,
    `批次: ${BATCHES[i % BATCHES.length]}`,
    `截止: ${i % 5 === 0 ? '2026-09-30' : ''}`,
    `优先级: ${['高', '中', '低', ''][i % 4]}`,
    `创建: ${ts}`,
    `更新: ${ts + 1000}`,
    `来源: human`,
    `指派: hermes`,
    `验收: 暮雨`,
    `标签: ${i % 3 === 0 ? `[${TAGS[i % TAGS.length]}, ${TAGS[(i + 1) % TAGS.length]}]` : '[]'}`,
    `阻塞: ${i % 17 === 0 ? '[task-bench-000001]' : '[]'}`,
  ].join('\n')
  return `---\n${fm}\n---\n${makeBody(i)}`
}

let generated = 0
function growTo(n) {
  const t0 = Date.now()
  while (generated < n) {
    const i = generated
    // 20% 进 archive
    const archived = i % 5 === 0
    const dir = archived ? ARCHIVE_DIR : TASK_DIR
    fs.writeFileSync(path.join(dir, `task-bench-${String(i).padStart(6, '0')}.md`), makeTaskFile(i, archived), 'utf-8')
    generated++
  }
  return Date.now() - t0
}

// ── 3. 计时工具 ─────────────────────────────────────────────────────────
function timeIt(fn, rounds = ROUNDS) {
  const s = []
  for (let r = 0; r < rounds; r++) {
    const t0 = process.hrtime.bigint()
    fn()
    s.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  s.sort((a, b) => a - b)
  return { med: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] }
}
const f2 = n => (n >= 100 ? n.toFixed(0) : n.toFixed(1))

// ── 4. 前端等价实现（与 App.vue / ipc.ts 保持一致） ─────────────────────
// ipc.ts:41 flattenTask —— 展开式，勿手写字段列表
function flattenTask(t) {
  return { ...t.fm, id: t.id, fm: t.fm, body: t.body, path: t.path, archived: /[\\/]archive[\\/]/i.test(t.path || '') }
}
// App.vue:2686 filteredTasks 的过滤分支（项目过滤 + 关键词过滤）
function frontendFilter(rows, projId, keyword) {
  let result = rows
  if (projId !== '__all__') result = result.filter(t => t.project === projId)
  if (keyword) {
    const lq = keyword.toLowerCase()
    result = result.filter(t =>
      t.title?.toLowerCase().includes(lq) ||
      t.id?.toLowerCase().includes(lq) ||
      t.project?.toLowerCase().includes(lq) ||
      t.tags?.join(' ').toLowerCase().includes(lq)
    )
  }
  return result
}

// ── 5. 主流程 ───────────────────────────────────────────────────────────
function main() {
  console.log('== 方寸数据层压测 ==')
  console.log(`规模档: ${LEVELS.join(' / ')}   轮次: ${ROUNDS}   正文档: ${BODY_MODE}   项目数: ${PROJ_COUNT}`)

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true })
  // registry：12 个活跃项目，贴近真实
  fs.writeFileSync(
    path.join(TEST_ROOT, 'registry.yaml'),
    'members:\n  - 暮雨\n  - hermes\nprojects:\n' +
      PROJ_IDS.map(id => `  - id: ${id}\n    name: 项目${id}\n    path: E:/tmp/${id}`).join('\n') + '\n',
    'utf-8'
  )

  const data = require(path.join(__dirname, '../../desktop/dist/main/data/index.js'))
  const tasks = require(path.join(__dirname, '../../desktop/dist/main/data/tasks.js'))
  data.setDataDir(TEST_ROOT)

  const rows = []
  let genAcc = 0

  for (const level of LEVELS) {
    genAcc += growTo(level)

    // 收集所有文件路径（供"纯 I/O"对照测量）
    const allFiles = []
    ;(function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== '.backup' && e.name !== '.trash') walk(p) }
        else if (e.name.endsWith('.md') && !e.name.startsWith('_')) allFiles.push(p)
      }
    })(TASK_DIR)

    const activeRows = data.loadTasks('active').map(flattenTask)
    const archiveRows = data.loadTasks('archive').map(flattenTask)
    const sampleId = activeRows[0]?.id

    const m = {}
    // 冷：先让缓存失效，再单次计时 —— 代表进程刚起来/数据刚被外部改动
    const coldOnce = (fn) => {
      data.invalidateTaskCache()
      const t0 = process.hrtime.bigint()
      fn()
      return Number(process.hrtime.bigint() - t0) / 1e6
    }
    // A. 纯 I/O：只 readFileSync，不解析
    m.fsRead = timeIt(() => { for (const f of allFiles) fs.readFileSync(f, 'utf-8') })
    // B. 单文件全解析 = 正则 + yaml.load + 字段归一
    m.parseAll = timeIt(() => { for (const f of allFiles) data.parseTask(f) })
    // C. loadTasks：冷（缓存失效后首次）/ 热（目录签名命中，跳过解析）
    m.loadActive = { med: coldOnce(() => data.loadTasks('active')) }
    m.loadActiveWarm = timeIt(() => data.loadTasks('active'))
    m.loadArchive = { med: coldOnce(() => data.loadTasks('archive')) }
    m.loadArchiveWarm = timeIt(() => data.loadTasks('archive'))
    // D. IPC 载荷：flatten + JSON 序列化
    m.flattenJson = timeIt(() => JSON.stringify(data.loadTasks('active').map(flattenTask)))
    // E. 前端过滤（拿到的已是 flatten 数据，不重复扫描）
    m.uiFilter = timeIt(() => frontendFilter(activeRows, PROJ_IDS[3], '压测'))
    m.uiFilterTag = timeIt(() => frontendFilter(activeRows, '__all__', ''))
    // F. 启动路径里的重型项
    m.blockers = timeIt(() => tasks.getBlockerChains())
    m.progress1 = timeIt(() => tasks.getProjectProgress(PROJ_IDS[0]))
    m.progressBatch = timeIt(() => tasks.getAllProjectProgress())
    m.progressLegacy = timeIt(() => { for (const p of PROJ_IDS) tasks.getProjectProgress(p) })
    m.roadmap = timeIt(() => tasks.aggregateRoadmap())
    m.projStatus = timeIt(() => tasks.scanProjectStatus())
    // G. 一次 loadAll() 等价（前端真实路径：active + archive + blockers + 批量进度）
    const loadAllOnce = () => {
      data.loadTasks('active').map(flattenTask)
      data.loadTasks('archive').map(flattenTask)
      tasks.getBlockerChains()
      tasks.getAllProjectProgress()
    }
    m.loadAllEqCold = { med: coldOnce(loadAllOnce) }
    m.loadAllEq = timeIt(loadAllOnce, Math.min(ROUNDS, 3))

    // 正确性守卫：缓存不得改变结果（改动数据层缓存后这道断言必须绿）
    data.invalidateTaskCache()
    const coldN = data.loadTasks('active').length
    const warmN = data.loadTasks('active').length
    if (coldN !== warmN) throw new Error(`缓存一致性失败: cold=${coldN} warm=${warmN}`)
    const sigCheck = (() => {
      const before = data.loadTasks('active').length
      // 注意：探针文件名不能以 _ 开头 —— 那是「模板文件」约定，会被扫描跳过
      const probe = path.join(TASK_DIR, 'bench-probe.md')
      fs.writeFileSync(probe, '---\nid: bench-probe\n标题: 探针\n状态: 草稿\n---\nbody\n', 'utf-8')
      const after = data.loadTasks('active').length
      fs.unlinkSync(probe)
      const restored = data.loadTasks('active').length
      return { before, after, restored }
    })()
    if (sigCheck.after !== sigCheck.before + 1 || sigCheck.restored !== sigCheck.before) {
      throw new Error(`缓存未跟随外部改动失效: ${JSON.stringify(sigCheck)}`)
    }
    // H. 写路径：单次 updateTask（含 atomicWrite + rotateBackup）
    m.write1 = timeIt(() => tasks.updateTask(sampleId, { 更新: Date.now() }), ROUNDS)

    const jsonBytes = JSON.stringify(activeRows).length

    rows.push({ level, genAcc, files: allFiles.length, m, jsonMB: jsonBytes / 1048576, activeN: activeRows.length, archiveN: archiveRows.length })
    console.log(`  [${level}] 生成 ${allFiles.length} 文件耗时 ${genAcc}ms（累计）`)
  }

  // ── 输出表格 ──
  const cols = [
    ['fsRead', '纯读文件 I/O'],
    ['parseAll', '全解析(正则+YAML)'],
    ['loadActive', 'loadTasks(active) 冷'],
    ['loadActiveWarm', 'loadTasks(active) 缓存命中'],
    ['loadArchive', 'loadTasks(archive) 冷'],
    ['loadArchiveWarm', 'loadTasks(archive) 缓存命中'],
    ['flattenJson', 'flatten+JSON 序列化'],
    ['uiFilter', '前端过滤(项目+关键词)'],
    ['blockers', 'getBlockerChains'],
    ['progress1', 'getProjectProgress ×1'],
    ['progressLegacy', `getProjectProgress ×${PROJ_COUNT}（旧路径）`],
    ['progressBatch', 'getAllProjectProgress 批量'],
    ['roadmap', 'aggregateRoadmap'],
    ['projStatus', 'scanProjectStatus'],
    ['loadAllEqCold', '★ 一次刷新（冷）'],
    ['loadAllEq', '★ 一次刷新（缓存命中）'],
    ['write1', 'updateTask（写单条）'],
  ]

  const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)) }
  const head = ['指标(ms)', ...LEVELS.map(l => pad(l + '任务', 11))].map((s, i) => pad(s, i === 0 ? 26 : 11)).join('')
  console.log('\n' + head)
  console.log('-'.repeat(head.length + 4))
  for (const [key, label] of cols) {
    const line = [pad(label, 26), ...rows.map(r => pad(f2(r.m[key].med) + (r.m[key].med > 300 ? ' !' : r.m[key].med > 100 ? ' ~' : ''), 11))].join('')
    console.log(line)
  }
  console.log('-'.repeat(head.length + 4))
  console.log('  图例:  ! = >300ms 明显卡顿   ~ = >100ms 可感知')
  console.log('  [载荷] flatten 后 JSON 体积(MB):', rows.map(r => `${r.level}:${r.jsonMB.toFixed(2)}`).join('  '))
  console.log('  [任务分布] active/archive:', rows.map(r => `${r.level}:${r.activeN}/${r.archiveN}`).join('  '))
  // 解析失败必须显性化 —— parseTask 遇到坏 YAML 返回 null，任务会静默消失
  const lost = rows.filter(r => r.activeN + r.archiveN !== r.files)
  console.log('  [解析完整性]', lost.length === 0
    ? '全部文件解析成功 ✓'
    : '⚠ 有文件解析失败：' + lost.map(r => `${r.level}档 丢${r.files - r.activeN - r.archiveN}`).join(' '))

  // ── 缓存效果 ──
  console.log('\n== 缓存效果（冷 vs 签名命中）==')
  for (const r of rows) {
    const cold = r.m.loadAllEqCold.med
    const warm = r.m.loadAllEq.med
    const once = r.m.loadActive.med
    console.log(`  ${r.level} 任务: 冷 ${f2(cold)}ms → 命中 ${f2(warm)}ms（${(cold / Math.max(warm, 0.01)).toFixed(1)}× 提速）  单次全量扫描 ${f2(once)}ms`)
  }
  console.log('  [正确性守卫] 缓存一致性 + 外部改动失效探测 通过 ✓')

  // ── 单任务均摊 ──
  console.log('\n== 单任务均摊成本 ==')
  for (const r of rows) {
    console.log(`  ${r.level} 任务: 读取=${(r.m.fsRead.med / r.files * 1000).toFixed(0)}µs  解析=${(r.m.parseAll.med / r.files * 1000).toFixed(0)}µs  合计=${((r.m.parseAll.med) / r.files).toFixed(3)}ms/条`)
  }

  // 清理
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
  console.log('\n临时数据已清理:', TEST_ROOT)
}

main()
