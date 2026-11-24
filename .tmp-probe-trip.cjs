const path = require('path')
const fs = require('fs')
const os = require('os')
const { mkTmp } = require('./scripts/test/_tmp.cjs')

const TMP = mkTmp('fc-ask-probe-')
const DATA = path.join(TMP, 'data')
const repoC = path.join(TMP, 'repoC')
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.mkdirSync(repoC, { recursive: true })

fs.writeFileSync(path.join(DATA, 'registry.yaml'), [
  'members: []', 'projects:',
  '  - id: cold', '    name: 冷项目', '    tasks: ""',
  '    repo: ' + repoC.replace(/\\/g, '/'),
  '    tools: []', '    sources: []', '    状态: 停在很久以前',
  '', 'released: []', '',
].join('\n'), 'utf-8')

const T = (n) => Math.floor((Date.now() - n * 86400000) / 1000)
fs.writeFileSync(path.join(DATA, 'task-data', 'c-cold.md'), [
  '---', 'id: c-cold', '标题: 两个月没动的活', '项目: [cold]', "状态: 待办",
  '优先级: 低', '创建: ' + T(70), '更新: ' + T(60), "来源: human", '阻塞: []',
  '---', '## 方案', '', '## 结果记录', '',
].join('\n'), 'utf-8')

const DIST = path.join(__dirname, 'desktop', 'dist', 'main')
const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)

const tb = require(path.join(DIST, 'services', 'tripBoard.js'))
const b = tb.buildTripBoard()
console.log('rows =', b.rows.length, ' hidden =', b.hidden.length, ' mode =', b.mode, ' criteria =', b.criteria)
for (const r of b.rows) console.log('  row:', r.name, r.health.value)
for (const h of b.hidden) console.log('  hidden:', h.name, '|', h.kind, '|', h.reason)
const proj = data.parseRegistry(true)
console.log('registry projects =', proj.map((p) => p.id))
