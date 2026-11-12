#!/usr/bin/env node
/**
 * 日志「下一步」清点（2026-11-12 暮雨第 N 次报「东西又没了」）
 *
 * 真事：方寸有 280 份执行日志、199 条写了真内容的「下一步」，
 *   **其中没有一条被任何卡接住**。你说过的「拷问AI」就躺在
 *   `log_20261111050608_3on1oq` 里，标着「进行中」，18 小时没人动，
 *   而且它的「下一步」栏是空的 —— 连"该干什么"都没记。
 *
 * 为什么这是设计缺陷不是疏忽：
 *   方寸有两种记录 —— 卡（能流转/派活/验收）和日志（只读存档）。
 *   **你说的话、方寸自己提炼的方案，全都沉在日志这一侧，进不了卡那一套。**
 *   于是「提了五六次没做」永远数不出来：多数压根没变成过卡。
 *
 * 本脚本只做一件事：把日志里「提了、但没有任何未完成卡在接」的下一步**列出来**。
 * 不建卡、不改日志（建卡是人的决定，脚本只负责让它浮上来）。
 *
 * 用法：
 *   node scripts/audit-log-nextsteps.cjs            # 列出全部
 *   node scripts/audit-log-nextsteps.cjs --check    # 有未接的就非零退出（给守卫用）
 *   node scripts/audit-log-nextsteps.cjs --json     # 机读
 */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LOGDIR = path.join(ROOT, 'docs', '执行日志')
const TASKDIR = path.join(ROOT, 'task-data')
const DONE = new Set(['完成', '驳回', '已归档', '归档'])

/** 归一化：去掉标点空白，只留可比对的字 */
function norm(s) {
  return String(s || '')
    .replace(/[\s"'“”「」『』（）。，,、：:；;（）()【】\[\]—\-*#>`~～!！?？]/g, '')
    .toLowerCase()
}

/** 读所有未完成卡（标题 + 正文），用来判断"有没有人接" */
function openCards() {
  const out = []
  if (!fs.existsSync(TASKDIR)) return out
  for (const f of fs.readdirSync(TASKDIR)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue
    const txt = fs.readFileSync(path.join(TASKDIR, f), 'utf8')
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) continue
    const fm = m[1]
    const g = (k) => {
      const r = fm.match(new RegExp('^' + k + ':[ \\t]*(.*)$', 'm'))
      return r ? r[1].trim().replace(/^["']|["']$/g, '') : ''
    }
    const st = g('状态') || g('status')
    if (DONE.has(st)) continue
    out.push({ id: f.replace(/\.md$/, ''), title: g('标题') || g('title'), text: norm(txt) })
  }
  return out
}

/** 取一份日志的「下一步」正文 */
function nextStepOf(raw) {
  const m = raw.match(/(?:^|\n)#{1,4}\s*下一步\s*\r?\n+([\s\S]*?)(?=\r?\n#{1,3}\s|\r?\n---|$)/)
  if (!m) return ''
  const body = m[1].trim()
  if (!body || /^（待填写）|^\(待填写\)/.test(body)) return ''
  return body
}

function main() {
  const wantCheck = process.argv.includes('--check')
  const wantJson = process.argv.includes('--json')

  if (!fs.existsSync(LOGDIR)) {
    console.error('找不到日志目录：' + LOGDIR)
    process.exit(2)
  }

  const cards = openCards()
  const rows = []
  const files = fs.readdirSync(LOGDIR).filter((x) => x.endsWith('.md')).sort()

  for (const f of files) {
    const raw = fs.readFileSync(path.join(LOGDIR, f), 'utf8')
    const next = nextStepOf(raw)
    if (!next) continue
    // 只看第一句非空行（"下一步"常常是一段带项目符号的话）
    const first = next.split(/\r?\n/).map((s) => s.replace(/^[\d.、\-*]\s*/, '').trim()).filter(Boolean)[0] || ''
    if (first.length < 6) continue
    const key = norm(first).slice(0, 14)
    // 有卡在接 = 某张未完成卡的标题/正文里出现这段关键词
    const hit = key.length >= 6 && cards.some((c) => c.text.includes(key))
    const titleM = raw.match(/^title:\s*(.+)$/m)
    rows.push({
      log: f.replace(/\.md$/, ''),
      title: titleM ? titleM[1].trim() : f,
      next: first.slice(0, 100),
      covered: hit,
    })
  }

  const uncovered = rows.filter((r) => !r.covered)

  if (wantJson) {
    console.log(JSON.stringify({ total: rows.length, uncovered: uncovered.length, items: uncovered }, null, 2))
  } else {
    console.log('日志总数:', files.length)
    console.log('写了「下一步」的:', rows.length)
    console.log('其中没有任何未完成卡在接:', uncovered.length)
    if (uncovered.length) {
      console.log('\n=== 提了但没人接（最该先处理的在最后）===')
      for (const r of uncovered) console.log('  [' + r.log + '] ' + r.next)
      console.log('\n处置方式（三选一，不许留着）：')
      console.log('  ① 变成卡（create_task，正文引用这条日志 id）')
      console.log('  ② 显式作废（在日志正文补一句「已放弃，理由…」）')
      console.log('  ③ 合并进已有卡（在那张卡正文里写上这条日志 id）')
    }
  }

  if (wantCheck && uncovered.length) {
    console.error('\n未接的「下一步」有 ' + uncovered.length + ' 条 —— 说过的活又沉回日志里了')
    process.exit(1)
  }
}

main()
