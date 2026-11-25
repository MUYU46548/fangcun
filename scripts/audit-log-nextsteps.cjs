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
 *
 * 两种写法，都认：
 *   ① **整份**：`处置：已转卡 <卡id>` —— 盖住这份日志的**全部**条目。
 *      适合"这份日志通篇同一件事"。⚠ 多条目日志用它 = 声明"整份归入某卡"，
 *      引擎仍会在 `--stats` 里提醒"这不等于逐条看过"。
 *   ② **逐条**：`处置：@2 已做 —— <说明>` —— 只盖住这份日志的**第 2 条**。
 *      `@` 后面的数字是 `--items` 打印出来的条目序号（1 起）。
 *      可选再带锚点：`处置：@2#待审批 已转卡 <卡id>` —— `#` 后面写该条开头几个字，
 *      用来在**条目顺序变了之后仍能认出来**（人改日志时常常插一条、删一条）。
 */
const DISPOSE_RE = /^[ \t]*(?:[-*·][ \t]*)?处置[：:][ \t]*(?:@(\d+)(?:#([^ \t]+))?[ \t]+)?(已做|已放弃|已转卡|非本项目|已合并|已废弃|已修|已核实|其他)[ \t]*(.*)$/
const DISPOSE_KINDS = ['已做', '已转卡', '已合并', '已放弃', '已废弃', '已修', '已核实', '非本项目', '其他']

/**
 * 从日志里找**全部**处置标记。
 *
 * 返回：
 *   `whole`  —— 整份级标记（没有 @序号 的那些）；有多个时以最后一个为准（后来者覆盖）
 *   `items`  —— 逐条标记数组 `{ n, anchor, kind, note }`（n = 1 起的条目序号）
 *
 * ⚠ 必须用 `m` 标志逐行找：处置标记**几乎总是写在「下一步」段落末尾**，
 *   第一版用整份 raw + 非 m 正则 → 一行只匹配第一个候选，标记在第二行就漏了。
 */
function disposeOf(raw) {
  const re = new RegExp(DISPOSE_RE.source, 'gm')
  let m
  let whole = null
  const items = []
  while ((m = re.exec(raw)) !== null) {
    const [, num, anchor, kind, note] = m
    if (num) {
      items.push({ n: Number(num), anchor: (anchor || '').trim(), kind, note: (note || '').trim() })
    } else {
      whole = { kind, note: (note || '').trim() }   // 后者覆盖前者
    }
  }
  if (!whole && !items.length) return null
  return { whole, items }
}

/** 兼容旧调用点：拿"整份"那个标记（没有就 null） */
function wholeDisposeOf(raw) {
  const d = disposeOf(raw)
  return d ? d.whole : null
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
  // ⚠ 2026-11-14 发现：日志文件里「下一步」**存两遍** ——
  //   frontmatter 的 `_next_steps: |-`（机器读的）与正文的 `## 下一步`（人读的）内容相同。
  //   这里只取**正文那一份**，否则任何统计都会把同一句话数成两次
  //   （第一次跑 --repeats 时同一份日志就出现了两条一模一样的诉求）。
  //
  // ⚠ 2026-11-24 修（暮雨：「该写任务的不写」）：
  //   原来的正则要求 `## 下一步` **后面立刻换行**。而实际日志里常见带后缀的写法：
  //       ## 下一步（卡 task-20261106-001）
  //       ## 下一步（要暮雨定）
  //       ## 下一步：先修这个
  //   这些**一条都匹配不到** → 被当成"这份日志没有下一步"**静默跳过**。
  //   实测代价：`log_20261106_210109_7f57bd` 与 `log_20261106_220214_ed783a`
  //   各有 2 条真欠账（装包真退再启 / Hermes 接 MCP / 插件注册工具三条路选一），
  //   在清点里**完全不存在** —— 这正是"东西提了没做，而清单说没有"的那种假绿。
  //   现在允许标题行带任意后缀（不含换行），只要求下一行起才是正文。
  const m = raw.match(/(?:^|\n)#{1,4}\s*下一步[^\r\n]*\r?\n+([\s\S]*?)(?=\r?\n#{1,3}\s|\r?\n---|$)/)
  if (!m) return ''
  const body = m[1].trim()
  if (!body || /^（待填写）|^\(待填写\)/.test(body)) return ''
  return body
}

/** 判定一行是不是处置标记（整份或逐条都算） */
function isDisposeLine(s) {
  return new RegExp(DISPOSE_RE.source).test(s)
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
  //   第一版没排除它 → 一条诉求 + 一行标记被算成 2 条欠账，断言当场抓到。
  const flush = () => {
    const t = buf.join(' ').replace(/\s+/g, ' ').trim()
    buf = []
    if (t.length >= 6) items.push(t)
  }
  for (const ln of lines) {
    if (isDisposeLine(ln)) { flush(); continue }     // 批注不进条目
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

/**
 * 某个条目是否已被**逐条标记**处置。
 *
 * 匹配规则（宁松不严，但不错配）：
 *   ① 标记带锚点 `@3#待审批` → 该条文本里含这段锚点字，就认（不管序号对不对）；
 *   ② 否则按序号 `@3` → 第 3 条（1 起）。
 *
 * 为什么要锚点：人会往日志里插一条、删一条，**序号会漂**。
 * 锚点让人在改过日志之后，那条"已处置"仍然跟着同一件事走。
 * ⚠ 锚点太短会误配（如 `#1`），所以要求至少 2 个字符。
 *
 * @param perItem 该日志里所有逐条标记（来自 disposeOf().items）
 * @param text    这一条的正文
 * @param idx     这一条的下标（0 起）
 */
function itemDisposedBy(perItem, text, idx) {
  const body = String(text || '')
  for (const it of perItem || []) {
    if (it.anchor) {
      const a = norm(it.anchor)
      if (a.length >= 2 && norm(body).includes(a)) return it
    } else if (it.n === idx + 1) {
      return it
    }
  }
  return null
}

/**
 * 组装一遍全部条目（含每条是否已被处置）。`--items` / `--stats` / `--json` 共用。
 *
 * 每条 row 带：
 *   `n`            这份日志里的第几条（1 起）—— 就是 `--items` 打印出来的序号
 *   `disposed`     处置类别（空串 = 没处置）
 *   `disposeScope` `'item'`（逐条标记）/ `'whole'`（整份标记盖住它）/ `''`
 *   `disposeNote`  标记里那句说明
 *
 * ⚠ `disposeScope` 是这套机制最关键的一个字段：
 *   `whole` 表示"这份日志被整体归入某卡了"，**不等于这一条被人看过**。
 *   把它和 `item` 混成一个数，就是上次 728 报成 205 的同一种病。
 */
function collect() {
  const cards = openCards()
  const rows = []
  const files = fs.existsSync(LOGDIR)
    ? fs.readdirSync(LOGDIR).filter((x) => x.endsWith('.md')).sort()
    : []
  let multiLogs = 0

  for (const f of files) {
    const raw = fs.readFileSync(path.join(LOGDIR, f), 'utf8')
    const items = nextStepItems(raw)
    if (!items.length) continue
    if (items.length >= 2) multiLogs++
    const titleM = raw.match(/^title:\s*(.+)$/m)
    const disp = disposeOf(raw)
    const whole = disp ? disp.whole : null
    const perItem = disp ? disp.items : []
    items.forEach((it, idx) => {
      const key = norm(it).slice(0, 14)
      const covered = key.length >= 6 && cards.some((c) => c.text.includes(key))
      const one = itemDisposedBy(perItem, it, idx)
      let disposed = ''
      let scope = ''
      let note = ''
      if (one) { disposed = one.kind; scope = 'item'; note = one.note }
      else if (whole) { disposed = whole.kind; scope = 'whole'; note = whole.note }
      rows.push({
        log: f.replace(/\.md$/, ''),
        title: titleM ? titleM[1].trim() : f,
        n: idx + 1,
        total: items.length,
        next: it.slice(0, 120),
        covered,
        disposed,
        disposeScope: scope,
        disposeNote: note,
      })
    })
  }
  return { rows, files, multiLogs }
}

/** `--items <日志id>`：把某份日志的「下一步」逐条列出来（带序号与处置状态） */
function showItems(logId) {
  const want = String(logId || '').replace(/\.md$/, '').trim()
  if (!want) {
    console.error('用法：node scripts/audit-log-nextsteps.cjs --items <日志id>')
    process.exit(2)
  }
  const { rows } = collect()
  const mine = rows.filter((r) => r.log === want)
  if (!mine.length) {
    console.error('这份日志没有可分条的「下一步」，或日志不存在：' + want)
    process.exit(2)
  }
  console.log('日志：' + want + '（' + mine[0].title + '）')
  console.log('共 ' + mine.length + ' 条诉求\n')
  for (const r of mine) {
    const mark = r.disposed
      ? (r.disposeScope === 'item' ? '✅ 已处置（逐条）' : '◐ 被整份标记盖住')
      : (r.covered ? '◻ 有卡在接' : '❌ 未处置')
    console.log(`  [${r.n}] ${mark} ${r.disposed ? '· ' + r.disposed : ''}`)
    console.log(`      ${r.next}`)
    if (r.disposeNote) console.log(`      ↳ ${r.disposeNote}`)
  }
  console.log('\n逐条处置写法（在日志「下一步」段落末尾加一行，序号见上）：')
  console.log('  处置：@2 已做 —— 说清做了什么 + 提交号')
  console.log('  处置：@3 已转卡 <卡 id>')
  console.log('  处置：@5#关键字 非本项目 —— 属于哪个项目   （#关键字 = 该条开头几个字，防序号漂移）')
  console.log('\n⚠ 不带 @序号 的标记会盖住**整份**日志的全部条目。')
}

/**
 * `--todo [N]`：输出**待逐条处置**的工作队列（默认按"条目多的日志"排前面）。
 *
 * 为什么需要它：`--stats` 只说"还剩 570 条"，但没人知道**下一步该看哪一份**。
 * 这个子命令直接给出"N 份日志 + 每份几条 + 前 3 条摘要"，接手的人照着做就行。
 * 它**只读**，不写任何东西。
 */
function showTodo(limit) {
  const { rows } = collect()
  const pending = rows.filter((r) => !r.covered && r.disposeScope !== 'item')
  const by = new Map()
  for (const r of pending) {
    if (!by.has(r.log)) by.set(r.log, [])
    by.get(r.log).push(r)
  }
  const list = Array.from(by.entries()).sort((a, b) => b[1].length - a[1].length)
  console.log('待逐条处置：' + pending.length + ' 条，分布在 ' + list.length + ' 份日志里')
  console.log('（整份标记盖住的不算处置过 —— 那只是"这份日志归入某卡"）\n')
  const n = Number(limit) > 0 ? Number(limit) : 10
  for (const [log, items] of list.slice(0, n)) {
    console.log(`=== ${log}（${items.length} 条）===`)
    for (const it of items.slice(0, 3)) {
      console.log(`  [${it.n}] ${String(it.next).slice(0, 68)}`)
    }
    if (items.length > 3) console.log(`  …… 还有 ${items.length - 3} 条（--items ${log} 看全部）`)
    console.log('')
  }
  if (list.length > n) {
    console.log(`…… 还有 ${list.length - n} 份日志没列（--todo ${list.length} 看全部）`)
  }
  console.log('\n看完某份后，在该日志「下一步」段落末尾写：')
  console.log('  处置：@2 已做 —— <核过什么 / 提交号>')
  console.log('  处置：@3 已转卡 <卡 id>')
  console.log('  处置：@5 非本项目 —— <属于哪个项目>')
}

function main() {
  const wantCheck = process.argv.includes('--check')
  const wantJson = process.argv.includes('--json')
  const wantStats = process.argv.includes('--stats')
  const itemsIdx = process.argv.indexOf('--items')
  const wantItems = itemsIdx >= 0 ? process.argv[itemsIdx + 1] : ''
  const todoIdx = process.argv.indexOf('--todo')
  const wantTodo = todoIdx >= 0
  const wantDispose = process.argv.includes('--dispose')

  if (!fs.existsSync(LOGDIR)) {
    console.error('找不到日志目录：' + LOGDIR)
    process.exit(2)
  }

  if (wantTodo) {
    return showTodo(todoIdx >= 0 ? process.argv[todoIdx + 1] : '')
  }

  if (wantItems !== '' || (itemsIdx >= 0 && !process.argv[itemsIdx + 1])) {
    return showItems(wantItems)
  }

  if (wantDispose) {
    // ⚠ 故意**不提供**写日志的开关：处置是人/agent 在日志正文里写一句话，
    //   脚本自己改日志就等于"机器替人宣布这件事处理过了"，那正是要防的假账。
    console.error('本脚本**不写日志**（只读）。处置标记要写进日志「下一步」段落，')
    console.error('由人或在场的 agent 写 —— 脚本替人宣布"处理过了"就是假账。')
    process.exit(2)
  }

  const { rows, files, multiLogs } = collect()

  // 「未接」= 没有卡在接 **且** 没写处置标记。
  const uncovered = rows.filter((r) => !r.covered && !r.disposed)
  const coveredRows = rows.filter((r) => r.covered)
  const disposedItem = rows.filter((r) => !r.covered && r.disposed && r.disposeScope === 'item')
  const disposedWhole = rows.filter((r) => !r.covered && r.disposed && r.disposeScope === 'whole')

  if (wantJson) {
    // `items`       = 真正没人管的（连整份标记都没有）—— 最该先看
    // `wholeOnly`   = 只被整份标记盖住、**没逐条核实**的 —— 这是"待逐条过"的工作量
    // `disposedItems` = 已处置的（两类合计，向后兼容）
    console.log(JSON.stringify({
      total: rows.length,
      logs: files.length,
      multiItemLogs: multiLogs,
      uncovered: uncovered.length,
      covered: coveredRows.length,
      disposedByItem: disposedItem.length,
      disposedByWhole: disposedWhole.length,
      disposed: disposedItem.length + disposedWhole.length,
      items: uncovered,
      /** 只被整份标记盖住的条目（要逐条过的就是这批） */
      wholeOnly: disposedWhole,
      disposedItems: disposedItem.concat(disposedWhole),
    }, null, 2))
  } else if (wantStats) {
    console.log('日志总数:', files.length)
    console.log('「下一步」条目总数:', rows.length, '（其中 ' + multiLogs + ' 份日志是多条目列表）')
    console.log('  有未完成卡在接:', coveredRows.length)
    console.log('  ✅ 逐条处置过（@序号标记）:', disposedItem.length, '← 这个数才是"真看过"')
    console.log('  ◐ 被**整份**标记盖住（未逐条核实）:', disposedWhole.length)
    console.log('  仍未接（欠账）:', uncovered.length)
    const allKinds = {}
    for (const r of disposedItem.concat(disposedWhole)) allKinds[r.disposed] = (allKinds[r.disposed] || 0) + 1
    if (Object.keys(allKinds).length) {
      console.log('\n处置分布（两类合计）:')
      for (const k of DISPOSE_KINDS) if (allKinds[k]) console.log('  ' + k + ': ' + allKinds[k])
    }
    if (disposedWhole.length) {
      console.log('\n⚠ 口径：上面「◐ 被整份标记盖住」的 ' + disposedWhole.length + ' 条**不算真处置**。')
      console.log('   它们是"这份日志被整体归入某张卡"，不等于那一条被人看过。')
      console.log('   要逐条核实：`--items <日志id>` 看清单 → 在日志里写 `处置：@序号 …`。')
    }
  } else {
    console.log('日志总数:', files.length)
    console.log('「下一步」条目总数:', rows.length)
    console.log('其中没有卡在接、也没逐条处置:', uncovered.length)
    console.log('（另有 ' + disposedItem.length + ' 条逐条处置过、' + disposedWhole.length + ' 条被整份标记盖住）')
    if (uncovered.length) {
      console.log('\n=== 提了但没人接（前 40 条；全量用 --json）===')
      for (const r of uncovered.slice(0, 40)) {
        console.log(`  [${r.log}] (#${r.n}/${r.total}) ${r.next}`)
      }
      if (uncovered.length > 40) console.log(`  …… 还有 ${uncovered.length - 40} 条`)
      console.log('\n处置方式（三选一，不许留着）：')
      console.log('  ① 变成卡（create_task，正文引用这条日志 id）')
      console.log('  ② 显式作废（写 `处置：@序号 已放弃 —— 理由`）')
      console.log('  ③ 合并进已有卡（写 `处置：@序号 已转卡 <卡 id>`）')
      console.log('\n看完某份日志的全部条目：`--items <日志id>`')
    }
  }

  // ⚠ --check 的口径（2026-11-14 收紧）：**只有逐条处置才算清**。
  //   整份标记（"这份日志归入某卡"）不再让它变绿 —— 否则 643 条靠 120 个整份标记
  //   就能让守卫全绿，那是把丢失伪装成完成。
  if (wantCheck) {
    const notDisposed = rows.filter((r) => !r.covered && r.disposeScope !== 'item')
    if (notDisposed.length) {
      console.error('\n还没逐条处置的「下一步」有 ' + notDisposed.length + ' 条')
      console.error('（其中 ' + disposedWhole.length + ' 条只被整份标记盖住 —— 那不等于看过）')
      console.error('看某份日志的全部条目：--items <日志id>')
      process.exit(1)
    }
  }
}

main()
