#!/usr/bin/env node
/**
 * registry 项目说明三字段写回测试（2026-10-22 · 施工单包 06「13 行写回小单」）
 *
 * 真跑编译产物 `dist/main/data/index.js` + **临时数据目录**（不碰真实 registry.yaml）。
 *
 * 这套钉的是「改三个中文字段」这件事的边界：
 *   · **文本块级替换** —— 注释 / 字段顺序 / 隔壁项目 / released 段逐字节保留（不许 dump 重写）；
 *   · **白名单** —— 传 name / repo / members 之类不认识的键 → 显式报错且文件零改动（不静默忽略）；
 *   · **写前自校验** —— 项目数不变、读回值 === 期望值，任一不过就放弃写入；
 *   · **回传 before** —— 撤销条靠它反推回滚（不是靠"再猜一次原值"）；
 *   · **缺失字段追加在块内** —— 不能跑到下一个项目下面去（YAML 里那就是张冠李戴）；
 *   · **含特殊字符的值必须转义** —— 全角冒号 / # / 引号，不加引号会被 yaml 解析错。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-fields-e2e-'))
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
  '    状态: 旧状态A',
  '    路线图: 旧路线A',
  '    说明: 旧说明A',
  '  - id: thin-b',
  '    name: 缺字段B',
  '    tasks: ""',
  '    repo: E:/x/b',
  '    tools: []',
  '    sources: []',
  '    状态: 旧状态B',
  '  - id: keep-c',
  '    name: 保留C',
  '    tasks: ""',
  '    repo: E:/x/c',
  '    tools: []',
  '    sources: []',
  '    状态: 旧状态C',
  '',
  '# 已发布 / 历史项目：已稳定运行、无后续开发计划的项目移此段。',
  '',
  'released:',
  '  - id: old-one',
  '    name: 老项目',
  '    tasks: ""',
  '    repo: E:/x/old',
  '    tools: []',
  '    sources: []',
  '    说明: 老说明',
  '',
].join('\n')

const REG = path.join(DATA, 'registry.yaml')
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.writeFileSync(REG, ORIGINAL, 'utf-8')

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)

let PASS = 0
const FAILS = []
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name) }
  else { FAILS.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')) }
}
const raw = () => fs.readFileSync(REG, 'utf-8')
const proj = (id) => data.parseRegistry(true).find((p) => String(p.id) === id) || null

console.log('---- 1. 起点 ----')
check('夹具起点：3 个 projects + 1 个 released', data.parseRegistry(true).length === 4)

console.log('\n---- 2. 改三字段：值变了、别的字节没动 ----')
const r1 = data.updateProjectFields('keep-a', {
  状态: '新状态A（0.3.9，10-21）',
  路线图: '新路线A：跑通第一单',
  说明: '欠着：①第一件 ②第二件',
})
check('三字段写回成功', r1.ok, r1.error)
check('回传 changed 恰好这三个字段',
  (r1.changed || []).length === 3
  && ['状态', '路线图', '说明'].every((f) => (r1.changed || []).includes(f)),
  String(r1.changed))
check('回传 before = 改之前的旧值（撤销要用它）',
  r1.before && r1.before['状态'] === '旧状态A' && r1.before['路线图'] === '旧路线A' && r1.before['说明'] === '旧说明A',
  JSON.stringify(r1.before))
check('解析回来的值就是新值', proj('keep-a')['状态'] === '新状态A（0.3.9，10-21）', String(proj('keep-a')['状态']))
check('★ 顶部注释一行没丢', raw().includes('# ⚠ 这段注释必须活下来'))
check('★ members 段没被碰', /^members:\s*$/m.test(raw()) && raw().includes('  - 暮雨'))
check('★ 隔壁项目 keep-c 字段原样', proj('keep-c')['状态'] === '旧状态C')
check('★ released 段原样（old-one 还在、说明没变）',
  proj('old-one') && proj('old-one')['说明'] === '老说明')
check('★ 项目总数没变', data.parseRegistry(true).length === 4)
check('★ 行数没变（三字段都是就地替换，不是插新行）',
  raw().split('\n').length === ORIGINAL.split('\n').length,
  `${ORIGINAL.split('\n').length} → ${raw().split('\n').length}`)
check('name / repo 等未在白名单里的字段一个没动',
  proj('keep-a')['name'] === '保留A' && proj('keep-a')['repo'] === 'E:/x/a')

console.log('\n---- 3. 白名单：不认识的键显式报错，文件零改动 ----')
const snap = raw()
const bad1 = data.updateProjectFields('keep-a', { name: '偷偷改名' })
check('传 name → 显式失败', bad1.ok === false, bad1.error)
check('报错说清只允许哪三个字段',
  bad1.ok === false && /状态|路线图|说明/.test(bad1.error || ''), bad1.error)
check('★ 文件一个字节没变（失败 = 不写，不是写了再回滚）', raw() === snap)
check('传混合键（一个合法一个非法）→ 整体拒绝，合法那个也不写',
  data.updateProjectFields('keep-a', { 状态: '不应该生效', repo: 'E:/hack' }).ok === false
  && proj('keep-a')['状态'] === '新状态A（0.3.9，10-21）')

console.log('\n---- 4. 不存在 / 非法 id ----')
check('改不存在的项目 → 显式报错', data.updateProjectFields('nope', { 状态: 'x' }).ok === false)
check('★ 文件一个字节没变', raw() === snap)
check('非法 id（含空格斜杠）→ 拒绝', data.updateProjectFields('a b/c', { 状态: 'x' }).ok === false)
check('空 patch → 拒绝（不是"成功但什么都没做"）',
  data.updateProjectFields('keep-a', {}).ok === false)

console.log('\n---- 5. 缺字段：追加在**本项目块内**，不许落到下一个项目下面 ----')
const r2 = data.updateProjectFields('thin-b', { 路线图: '新路线B', 说明: '新说明B' })
check('缺失字段写回成功', r2.ok, r2.error)
check('★ 解析后属于 thin-b（不是被 keep-c 抢走）',
  proj('thin-b')['路线图'] === '新路线B' && proj('thin-b')['说明'] === '新说明B',
  JSON.stringify(proj('thin-b')))
check('★ keep-c 一个字没被污染（状态还是旧状态C，且没有路线图）',
  proj('keep-c')['状态'] === '旧状态C' && proj('keep-c')['路线图'] === undefined,
  JSON.stringify(proj('keep-c')))
check('插入顺序：块尾之前，且 thin-b 的块仍以 keep-c 收尾',
  raw().indexOf('    路线图: 新路线B') < raw().indexOf('- id: keep-c'))
check('新行用了与块内一致的缩进（4 空格）', raw().includes('\n    路线图: 新路线B\n'))

console.log('\n---- 6. 特殊字符：全角冒号 / # / 引号都必须转义对 ----')
const tricky = '欠着：①"AI 规划"还是零单 #TODO ②模板确认'
const r3 = data.updateProjectFields('keep-c', { 说明: tricky })
check('含特殊字符的说明写回成功', r3.ok, r3.error)
check('★ 读回来逐字相等（没被 YAML 当成注释/键值分隔吃掉）',
  proj('keep-c')['说明'] === tricky, JSON.stringify(proj('keep-c')['说明']))
check('★ # 后面那段没被当注释丢掉', String(proj('keep-c')['说明']).includes('#TODO ②模板确认'))

console.log('\n---- 7. 撤销：用 before 反推回滚，字段回原值 ----')
const before3 = r3.before
const undo = data.updateProjectFields('keep-c', {
  说明: before3['说明'],
})
check('回滚成功', undo.ok, undo.error)
check('★ 字段回到改之前的样子（keep-c 原本没有说明 → before 是空串，回滚写回空串）',
  proj('keep-c')['说明'] === '', `实际=${JSON.stringify(proj('keep-c')['说明'])}`)
// 上面那类"原本没有该字段"的口径是：撤销 = 恢复"改之前的样子"，而"改之前"就是空。
// 下面独立验一遍"原本有值"的那种 —— 这才是撤销条在 13 行写回里的主场景：
const r4 = data.updateProjectFields('keep-a', { 状态: '临时状态' })
const back = data.updateProjectFields('keep-a', { 状态: r4.before['状态'] })
check('原本有值 → 撤销后精确回原值',
  back.ok && proj('keep-a')['状态'] === '新状态A（0.3.9，10-21）',
  String(proj('keep-a')['状态']))
check('★ 空串是"显式清空"，会落成 `""` 而不是把键删掉（两种都读到空值，但文件语义不同）',
  data.updateProjectFields('thin-b', { 说明: '' }).ok && /^\s+说明: ""$/m.test(raw()))

console.log('\n---- 8. released 段也能改（弈局残响那种） ----')
const r5 = data.updateProjectFields('old-one', { 状态: '已稳定、无后续开发计划' })
check('released 段项目可写回', r5.ok, r5.error)
check('值生效', proj('old-one')['状态'] === '已稳定、无后续开发计划')
check('released 段标记还在（没被改成 projects）', /^released:\s*$/m.test(raw()))

console.log('\n---- 9. readProjectFields ----')
const rd = data.readProjectFields('keep-a')
check('读回三字段成功', rd.ok, rd.error)
check('读到的是当前值（不是旧值）', rd.fields['状态'] === '新状态A（0.3.9，10-21）')
check('不存在的项目 → 显式报错', data.readProjectFields('nope').ok === false)

console.log('\n---- 10. 幂等：同值再写一次 = 不算改动、文件不动 ----')
const snap2 = raw()
const same = data.updateProjectFields('keep-a', { 状态: '新状态A（0.3.9，10-21）' })
check('同值写回成功但 changed 为空', same.ok && (same.changed || []).length === 0, String(same.changed))
check('★ 文件一个字节没变（不做无意义的写盘，避免 mtime 乱跳触发备份）', raw() === snap2)

console.log(`\n==== ${PASS} 通过 / ${FAILS.length} 失败 ====`)
if (FAILS.length) { FAILS.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1) }
