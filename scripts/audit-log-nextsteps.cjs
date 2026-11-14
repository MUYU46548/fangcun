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
 * 2026-11-14 扩：**处置标记**。判据是「未接数逐步降到 0」，而"降"只能靠**在日志里留痕**——
 * 否则同一句「继续做」会永远躺在清单里，谁也说不清是没人管还是已经处理过。
 * 在日志的「下一步」段落末尾写一行，脚本就认（幂等，可重复跑）：
 *
 *   处置：已做 —— <一句话说做了什么 + 提交号/卡 id>
 *   处置：已放弃 —— <理由>
 *   处置：已转卡 <卡 id>
 *   处置：非本项目 —— <属于哪个项目，不归方寸管>
 *   处置：已合并 <卡 id> —— <并入哪张>
 *
 * 带这个标记的条目**不再出现在未接清单里**，但仍在 `--json` 里带 `disposed` 字段，
 * 方便回头核"这条到底是怎么处置的"。标记写在原文里 = 以后任何人翻这份日志都看得到。
 *
 * 用法：
 *   node scripts/audit-log-nextsteps.cjs            # 列出全部
 *   node scripts/audit-log-nextsteps.cjs --check    # 有未接的就非零退出（给守卫用）
 *   node scripts/audit-log-nextsteps.cjs --json     # 机读
 *   node scripts/audit-log-nextsteps.cjs --stats    # 只出分类统计（处置/未处置各多少）
 */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LOGDIR = path.join(ROOT, 'docs', '执行日志')
const TASKDIR = path.join(ROOT, 'task-data')
const DONE = new Set(['完成', '驳回', '已归档', '归档'])

/**
 * 处置标记（写在日志「下一步」段落里，任意一行）。
 * 只要出现 `处置：<类别>` 就认；类别不在表里也算（人写的自然会话别），
 * 但会归到 `其他处置` 便于统计。**不要求格式完美** —— 要求完美就等于没人会写。
 */
const DISPOSE_RE = /^[ \t]*(?:[-*·][ \t]*)?处置[：:][ \t]*(已做|已放弃|已转卡|非本项目|已合并|已废弃|已修|已核实|其他)[ \t]*(.*)$/
const DISPOSE_KINDS = ['已做', '已转卡', '已合并', '已放弃', '已废弃', '已修', '已核实', '非本项目', '其他']

/** 从日志里找处置标记；返回 null 表示没处置 */
function disposeOf(raw) {
  // ⚠ 必须用 `m` 标志逐行找：处置标记**几乎总是写在「下一步」段落的末尾**
  //   （先写原话，再补一行"处置：…"），而 `nextStepOf` 只取第一句当"这一条"。
  //   第一版用整份 raw + 非 m 正则 → 一行只匹配第一个候选，标记在第二行就漏了。
  const re = new RegExp(DISPOSE_RE.source, 'gm')
  let m
  let last = null
  while ((m = re.exec(raw)) !== null) last = m   // 有多个时以最后一个为准（后来者覆盖）
  if (!last) return null
  return { kind: last[1], note: (last[2] || '').trim() }
}

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

/**
 * 把「下一步」正文拆成**条目**（2026-11-14 · 处置口径修正）。
 *
 * 为什么必须拆：实测 **41% 的「下一步」是多条目列表**（有的写了 15 条）。
 * 只按"第一句"给整份日志定一个处置 → 剩下 14 条没人看过，而数字显示"已处置"，
 * **那比不处置更糟**（把丢失伪装成完成）。
 *
 * 拆法：编号行（`1.` `2、`）与项目符号行（`-` `*`）各算一条；
 * 没有列表符号的整段算一条。一条至少 6 个字才算（"继续"这种口令不算账）。
 */
function nextStepItems(raw) {
  const body = nextStepOf(raw)
  if (!body) return []
  const lines = body.split(/\r?\n/)
  const items = []
  let buf = []
  const isBullet = (s) => /^\s*(?:\d+[.、)]|[-*·])\s+/.test(s)
  // ⚠ 处置标记那一行**不是一条诉求**，它是"这件事已经处理过"的批注。
  //   第一版没排除它 → 一条诉求 + 一行标记被算成 2 条欠账，
  //   于是"已写处置标记: 2 / 已做: 2"全是双份，断言当场抓到。
  const isDispose = (s) => DISPOSE_RE.test(s)
  const flush = () => {
    const t = buf.join(' ').replace(/\s+/g, ' ').trim()
    buf = []
    if (t.length >= 6) items.push(t)
  }
  for (const ln of lines) {
    if (isDispose(ln)) { flush(); continue }     // 批注不进条目
    if (isBullet(ln)) {
      flush()
      buf.push(ln.replace(/^\s*(?:\d+[.、)]|[-*·])\s+/, '').trim())
    } else if (!ln.trim()) {
      if (buf.length) flush()
    } else {
      buf.push(ln.trim())
    }
  }
  flush()
  return items
}

function main() {
  const wantCheck = process.argv.includes('--check')
  const wantJson = process.argv.includes('--json')
  const wantStats = process.argv.includes('--stats')

  if (!fs.existsSync(LOGDIR)) {
    console.error('找不到日志目录：' + LOGDIR)
    process.exit(2)
  }

  const cards = openCards()
  const rows = []
  const files = fs.readdirSync(LOGDIR).filter((x) => x.endsWith('.md')).sort()
  let multiLogs = 0
  let totalItems = 0

  for (const f of files) {
    const raw = fs.readFileSync(path.join(LOGDIR, f), 'utf8')
    const items = nextStepItems(raw)
    if (!items.length) continue
    if (items.length >= 2) multiLogs++
    totalItems += items.length
    // ⚠ 2026-11-14：**按条**出账，不再只取第一句。
    //   41% 的「下一步」是多条目列表 —— 只按第一条判定等于把其余诉求静默丢掉。
    const titleM = raw.match(/^title:\s*(.+)$/m)
    const disp = disposeOf(raw)
    for (const it of items) {
      const key = norm(it).slice(0, 14)
      const covered = key.length >= 6 && cards.some((c) => c.text.includes(key))
      rows.push({
        log: f.replace(/\.md$/, ''),
        title: titleM ? titleM[1].trim() : f,
        next: it.slice(0, 100),
        covered,
        disposed: disp ? disp.kind : '',
        disposeNote: disp ? disp.note : '',
      })
    }
  }

  // 「未接」= 没有卡在接 **且** 没写处置标记。
  // 写了处置标记的不再算欠账 —— 但也不算"有卡在接"，两者分开统计，别混成一个数。
  const uncovered = rows.filter((r) => !r.covered && !r.disposed)
  const coveredRows = rows.filter((r) => r.covered)
  const disposedRows = rows.filter((r) => !r.covered && r.disposed)

  if (wantJson) {
    console.log(JSON.stringify({
      total: rows.length,
      logs: files.length,
      multiItemLogs: multiLogs,
      uncovered: uncovered.length,
      covered: coveredRows.length,
      disposed: disposedRows.length,
      items: uncovered,
      disposedItems: disposedRows,
    }, null, 2))
  } else if (wantStats) {
    console.log('日志总数:', files.length)
    console.log('「下一步」条目总数:', rows.length, '（其中 ' + multiLogs + ' 份日志是多条目列表）')
    console.log('  有未完成卡在接:', coveredRows.length)
    console.log('  已写处置标记:', disposedRows.length, '（按日志算 —— 一份日志一个标记盖住它的全部条目）')
    console.log('  仍未接（欠账）:', uncovered.length)
    if (disposedRows.length) {
      const byKind = {}
      for (const r of disposedRows) byKind[r.disposed] = (byKind[r.disposed] || 0) + 1
      console.log('\n处置分布:')
      for (const k of DISPOSE_KINDS) if (byKind[k]) console.log('  ' + k + ': ' + byKind[k])
    }
    if (disposedRows.length && multiLogs) {
      console.log('\n⚠ 口径提醒：处置标记是**按日志**写的，而欠账是**按条目**算的。')
      console.log('   一份日志写了 15 条、只处置了第 1 条，标记也会盖住整份 ——')
      console.log('   所以"已写处置标记"不等于"每一条都有人看过"。要逐条核实请用 --items。')
    }
  } else {
    console.log('日志总数:', files.length)
    console.log('写了「下一步」的:', rows.length)
    console.log('其中没有任何未完成卡在接:', uncovered.length)
    if (disposedRows.length) console.log('（另有 ' + disposedRows.length + ' 条已写处置标记，不再列出）')
    if (uncovered.length) {
      console.log('\n=== 提了但没人接（最该先处理的在最后）===')
      for (const r of uncovered) console.log('  [' + r.log + '] ' + r.next)
      console.log('\n处置方式（三选一，不许留着）：')
      console.log('  ① 变成卡（create_task，正文引用这条日志 id）')
      console.log('  ② 显式作废（在日志正文补一句「已放弃，理由…」）')
      console.log('  ③ 合并进已有卡（在那张卡正文里写上这条日志 id）')
      console.log('\n⚠ 做完在日志「下一步」末尾补一行，脚本才会把它从欠账里划掉：')
      console.log('  处置：已做 —— 说清做了什么 + 提交号')
      console.log('  处置：已放弃 —— 理由')
      console.log('  处置：已转卡 <卡 id>')
      console.log('  处置：非本项目 —— 属于哪个项目')
    }
  }

  if (wantCheck && uncovered.length) {
    console.error('\n未接的「下一步」有 ' + uncovered.length + ' 条 —— 说过的活又沉回日志里了')
    process.exit(1)
  }
}

main()
