/**
 * ts-parse.mjs — 跨语言 roundtrip 校验辅助脚本
 * 用纯 Node.js 复现 TypeScript data/index.ts 的 parseTask 逻辑
 * 输出 JSON 供 verify.py 比对
 */
import * as fs from 'fs'
import * as path from 'path'

const FIELD_MAP = {
  '标题': 'title',
  '项目': 'project',
  '状态': 'status',
  '批次': 'batch',
  '截止': 'deadline',
  '优先级': 'priority',
  '创建': 'created',
  '更新': 'updated',
  '来源': 'source',
  '指派': 'assignee',
  '验收': 'review',
  '阻塞': 'blockers',
  '标签': 'tags',
  '附言': 'memo',
  '资源': 'resources',
  '方案': 'plan',
  '结果记录': 'result_log',
  '派活时间': 'dispatch_time',
  'agent': 'agent',
  '验收清单': 'review_checklist',
  '预算': 'budget',
  'cron': 'cron',
  'context': 'context',
  'id': 'id',
  'tags': 'tags',
}

function coerce(v) {
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))
  }
  if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) {
    return v.slice(1, -1)
  }
  return v
}

function parseTask(filePath) {
  if (!fs.existsSync(filePath)) return null
  const content = fs.readFileSync(filePath, 'utf-8')
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/) ||
                 content.match(/^===\r?\n([\s\S]*?)\r?\n===\r?\n([\s\S]*)$/) ||
                 content.match(/^---\r?\n([\s\S]*?)\r?\n===\r?\n([\s\S]*)$/) ||
                 content.match(/^===\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!fmMatch) return null
  const fmText = fmMatch[1]
  const body = fmMatch[2]
  const fm = { id: '' }
  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = line.match(/^([^:]+):\s*(.*)$/)
    if (m) {
      const rawKey = m[1].trim()
      const val = m[2].trim()
      const key = FIELD_MAP[rawKey] || rawKey
      if (val.startsWith('[')) {
        fm[key] = coerce(val)
      } else {
        fm[key] = val
      }
    }
  }
  fm.id = fm.id || path.basename(filePath, '.md')
  if (fm.created && /^\d+$/.test(fm.created)) {
    fm.created = new Date(parseInt(fm.created) * 1000).toISOString()
  }
  if (fm.updated && /^\d+$/.test(fm.updated)) {
    fm.updated = new Date(parseInt(fm.updated) * 1000).toISOString()
  }
  return { id: fm.id, fm, body, path: filePath }
}

const filePath = process.argv[2]
const task = parseTask(filePath)
if (task) {
  const result = {
    id: task.id,
    title: task.fm.title || null,
    project: task.fm.project || null,
    status: task.fm.status || null,
    priority: task.fm.priority || null,
    created: task.fm.created || null,
    updated: task.fm.updated || null,
    tags: task.fm.tags || null,
    body: task.body,
  }
  console.log(JSON.stringify(result))
} else {
  console.log('null')
}
