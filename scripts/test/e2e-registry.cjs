#!/usr/bin/env node
/**
 * registry 增删项目测试（2026-10-05 用户：「项目页签里似乎没有添加和删除项目的入口」）
 *
 * 真跑编译产物 `dist/main/data/index.js` + **临时数据目录**（不碰真实 registry.yaml / task-data）。
 *
 * 为什么值得单列一套：registry.yaml 是**人也要手改**的文件 —— 顶部有注释、字段是中文、
 * 顺序有意义。所以"增/删一个项目"绝不能靠 yaml.load + yaml.dump 重写（注释会全丢、顺序会乱），
 * 必须是**文本块**级别的插入 / 删除。本套就是钉住这条：
 *   · 增：注释与既有字段逐字节保留，项目数恰好 +1
 *   · 删：只吃掉目标项目的块 —— **不吃掉隔壁项目、不吃掉 released 段、不吃掉注释**
 *   · 两者都：写前自校验不过就**放弃写入**（宁可不写，也不破坏注册表）
 *   · 删不存在的 / 非法 id → 显式报错且文件一个字节没变
 *   · 删登记**不动 task-data**（任务卡还在，只是变「未归属」）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-e2e-'))
const DATA = path.join(TMP, 'data')
const USERDATA = path.join(TMP, 'userdata')
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(USERDATA, { recursive: true })
process.env.FC_TEST_USERDATA = USERDATA

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const ORIGINAL = [
  '# 方寸 (tegula) 项目注册表',
  '# 新项目在此登记即可，无需改代码。',
  '# ⚠ 这段注释必须活下来（dump 重写会把它全丢掉）',
  '',
  'members:',
  '  - hermes',
  '  - 暮雨',
  '',
  'projects:',
  '  - id: keep-a',
  '    name: 保留A',
  '    tasks: ""',
  '    repo: E:/x/a',
  '    tools: [python]',
  '    sources: []',
  '    状态: 活跃开发中',
  '  - id: drop-me',
  '    name: 待删项目',
  '    tasks: ""',
  '    repo: E:/x/b',
  '    tools: []',
  '    sources: []',
  '    状态: 内容创作期',
  '  - id: keep-b',
  '    name: 保留B',
  '    tasks: ""',
  '    repo: E:/x/c',
  '    tools: []',
  '    sources: []',
  '    状态: 低频维护',
  '',
  '# 已发布 / 历史项目：已稳定运行、无后续开发计划的项目移此段。',
  '# 报告里会折叠为独立小节，健康度统一标 released，不参与活跃排序。',
  '',
  'released:',
  '  - id: old-one',
  '    name: 老项目',
  '    tasks: ""',
  '    repo: E:/x/old',
  '    tools: []',
  '    sources: []',
  '',
].join('\n')

const REG = path.join(DATA, 'registry.yaml')
const TASKDIR = path.join(DATA, 'task-data')
fs.mkdirSync(TASKDIR, { recursive: true })
fs.writeFileSync(REG, ORIGINAL, 'utf-8')
// 一张属于 drop-me 的任务卡：删登记后它必须还在
fs.writeFileSync(path.join(TASKDIR, 't1.md'), [
  '---', 'id: t1', '标题: 待删项目的任务', '项目: [drop-me]', '状态: 待办', '优先级: 中',
  '创建: 1791000000', '更新: 1791000000', '来源: human', '指派: hermes', '验收: 暮雨',
  '---', '## 方案', '- [ ] 做点事', '', '## 结果记录', ''].join('\n'), 'utf-8')

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}
const raw = () => fs.readFileSync(REG, 'utf-8')
const ids = () => data.parseRegistry(true).map((p) => String(p.id))

console.log('---- 1. 起点 ----')
check('夹具起点：3 个 projects + 1 个 released', ids().length === 4, ids().join(','))

console.log('\n---- 2. 增：文本块追加，注释与既有字段逐字节保留 ----')
const added = data.addProjectToRegistry({ id: 'new-one', name: '新项目', repo: 'E:/x/new' })
check('新增项目成功', added.ok, added.error)
check('★ 顶部注释一行没丢（dump 重写会把它们全丢掉）',
  raw().includes('# ⚠ 这段注释必须活下来') && raw().includes('# 新项目在此登记即可'))
check('★ 既有项目的自定义中文字段仍在（状态: 活跃开发中）', raw().includes('    状态: 活跃开发中'))
check('项目数恰好 +1 且新 id 可解析', ids().length === 5 && ids().includes('new-one'), ids().join(','))
check('重复 id 被拒（不覆盖既有登记）',
  data.addProjectToRegistry({ id: 'keep-a', name: '撞名' }).ok === false)
check('非法 id 被拒（字符集约束）',
  data.addProjectToRegistry({ id: 'a b/c', name: 'x' }).ok === false)
// 2026-10-05 真 bug：插入点定在 `released:` 那行 → 新项目落到**描述已发布段的注释下面**，
// 看起来像"已发布项目"；而 Python 侧解析器又因注释丢段（已在 verify.py 第 26 组钉住）。
check('★ 新项目插在「已发布」注释**之前**（不落到注释下面冒充已发布项目）',
  raw().indexOf('id: new-one') < raw().indexOf('# 已发布 / 历史项目'),
  `new-one@${raw().indexOf('id: new-one')} note@${raw().indexOf('# 已发布 / 历史项目')}`)
check('★ 注释仍在（插入点移动不许删掉它们）', raw().includes('# 已发布 / 历史项目'))

console.log('\n---- 3. 删：只吃掉目标块，不吃隔壁 ----')
const before = raw()
const rm = data.removeProjectFromRegistry('drop-me')
check('移除项目成功', rm.ok, rm.error)
check('★ 目标 id 已消失', !ids().includes('drop-me'), ids().join(','))
check('★ 隔壁项目一个没伤（keep-a / keep-b 都在，且字段完整）',
  ids().includes('keep-a') && ids().includes('keep-b')
  && raw().includes('    repo: E:/x/a') && raw().includes('    repo: E:/x/c'), ids().join(','))
check('★ released 段没被吃掉（old-one 还在，released: 键还在）',
  ids().includes('old-one') && /^released:\s*$/m.test(raw()))
check('★ 注释仍然活下来', raw().includes('# ⚠ 这段注释必须活下来'))
check('★ 只少了「待删项目」那一块：新增行数 = 原行数 - 它自己的行数',
  before.split('\n').length - raw().split('\n').length === 7,
  `before=${before.split('\n').length} after=${raw().split('\n').length}`)
check('★ 任务卡没被动（删的是登记，不是数据）',
  fs.existsSync(path.join(TASKDIR, 't1.md'))
  && fs.readFileSync(path.join(TASKDIR, 't1.md'), 'utf-8').includes('项目: [drop-me]'))

console.log('\n---- 4. 拒绝路径：报错且文件零改动 ----')
const snapshot = raw()
const rmMissing = data.removeProjectFromRegistry('never-existed')
check('删不存在的项目 → 显式报错（不是静默成功）',
  rmMissing.ok === false && /没有项目/.test(rmMissing.error || ''), rmMissing.error)
check('非法 id → 显式报错', data.removeProjectFromRegistry('a b/c').ok === false)
check('空 id → 显式报错', data.removeProjectFromRegistry('').ok === false)
check('★ 上述三次失败都没动文件一个字节', raw() === snapshot)

console.log('\n---- 5. released 段也能删 ----')
const rmReleased = data.removeProjectFromRegistry('old-one')
check('released 里的项目同样可移除', rmReleased.ok, rmReleased.error)
check('移除后不再出现，且 projects 段不受影响',
  !ids().includes('old-one') && ids().includes('keep-a') && ids().includes('keep-b'), ids().join(','))
check('★ 内容仍可被 yaml 正常解析（写前自校验的意义）',
  (() => { try { return Array.isArray(data.parseRegistry(true)) } catch { return false } })())

console.log('\n---- 6. 全删干净后仍是合法注册表 ----')
data.removeProjectFromRegistry('keep-a')
data.removeProjectFromRegistry('keep-b')
data.removeProjectFromRegistry('new-one')   // 第 2 节加进来的那个
check('projects 空 / released 空，注释还在，仍可解析',
  ids().length === 0 && raw().includes('# ⚠ 这段注释必须活下来'), ids().join(','))

console.log(`\n通过 ${PASS} / 失败 ${FAILS.length}`)
if (FAILS.length) {
  console.log('失败项：' + FAILS.join('、'))
  process.exit(1)
}
console.log('全部通过。')
