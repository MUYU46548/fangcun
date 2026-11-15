/**
 * 未完成总清单 · 生成器守卫（2026-11-15）
 *
 * 为什么需要它：`scripts/inventory-unfinished.py` 生成一份几百行的 Markdown，
 * 而它**错了也照样出文件**。本轮写它的过程中连踩三次，每次清单看起来都完全正常：
 *   ① 卡的时间字段名写错（`更新时间` vs 真实键 `更新`）→ 整列"时间不详"；
 *   ② 缺口只认「还欠：」这种句子 → 真身里几乎没有，整列空；
 *   ③ 守卫结果行只认 `RESULT n / m`，而一半守卫写的是 `通过 n / 失败 m` → 那半列永远"未跑到"。
 *
 * 所以这一套**不测"能不能生成"**，测的是"生成出来的东西是否自洽"：
 *   - 数目对得上（表里行数 = 声称的条数）
 *   - 不许大面积空列（占比阈值，不是"至少一条"—— 至少一条挡不住"99% 是空"）
 *   - 已知的假行必须被排除（`.decision-log` 不是问卷）
 *   - 脚本**只读**：跑一遍不许改任何 task-data 文件（逐字节 + mtime）
 *
 * 运行：node scripts/test/e2e-inventory.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'inventory-unfinished.py')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function runPy(args = []) {
  return execFileSync('python', [SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    timeout: 300000,
  })
}

/** task-data 全量指纹（用于证明脚本只读） */
function fingerprint() {
  const out = new Map()
  const walk = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.md')) continue
      const st = fs.statSync(p)
      out.set(path.relative(ROOT, p), st.size + ':' + st.mtimeMs)
    }
  }
  walk(path.join(ROOT, 'task-data'))
  return out
}

console.log('== 未完成总清单 · 自洽性守卫 ==')

// ⚠ 只读断言必须能区分「脚本写了盘」和「别人正在写盘」。
// 2026-11-15 现场：用户在界面上答题，`decisions.md` / `question-bank.md` / `OB37-*.answers.json`
// 在**脚本运行的那一瞬间**被改了 → 守卫红，而脚本其实一个字节没写（另用 530 个文件的
// sha256 前后比对证明过：新增 0 / 删除 0 / 改动 0）。
// 一条"会因为别人正常操作而红"的断言，最后一定会被人改宽 —— 那是假绿的前奏。
// 所以先量一个**空窗漂移**：脚本不跑的时候数据根自己在不在变？
//   · 在变 → 这轮只读性判不了，如实报 SKIP（环境不可用，不是通过也不是失败）
//   · 没变 → 再跑脚本，此时的差异就能算到脚本头上
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const idleA = fingerprint()
sleepMs(700)
const idleB = fingerprint()
const drift = [...idleB.keys()].filter((k) => !idleA.has(k) || idleA.get(k) !== idleB.get(k))
const concurrent = drift.length > 0

const before = fingerprint()
const md = runPy()
const after = fingerprint()

// ── ① 只读（跑一遍不许动任何 task-data 文件）────────────────────────────
{
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed = [...before.keys()].filter((k) => after.has(k) && before.get(k) !== after.get(k))
  const total = added.length + removed.length + changed.length
  if (concurrent && total > 0) {
    console.log('SKIP  ★★ 清单生成器是**只读**的 —— 本轮数据根有别的进程在写（' +
      drift.length + ' 个文件在空窗期内就变了），只读性判不了；不是通过也不是失败')
    console.log('      空窗期内就在变的文件：' + drift.slice(0, 3).join(', '))
  } else {
    check('★★ 清单生成器是**只读**的（task-data 一个文件都不许动）',
      total === 0,
      `新增=${added.length} 删除=${removed.length} 改动=${changed.length}` +
      (changed.length ? ' 首个改动：' + changed[0] : ''))
  }
}

// ── ② 结构：该有的段落都在 ─────────────────────────────────────────────
{
  const need = ['## 0. 一共多少条', '## 1. 未完成卡', '## 2. 日志「下一步」',
    '## 3. 问卷', '## 4. 计划卡', '## 5. 代码层', '## 6. 脚本读不出来的',
    '## 7. 接力的人从哪开始']
  const missing = need.filter((h) => !md.includes(h))
  check('★★ 七段结构齐全（缺一段就等于少一类未完成）', missing.length === 0, missing.join(' | '))
}

// ── ③ 数目自洽：声称的总数 == 各段之和 ─────────────────────────────────
{
  const num = (re) => { const m = re.exec(md); return m ? Number(m[1]) : -1 }
  const cards = num(/未完成卡 \| \*\*(\d+)\*\*/)
  const logs = num(/日志「下一步」没接的 \| \*\*(\d+)\*\*/)
  const decks = num(/问卷待办 \| \*\*(\d+)\*\*/)
  const plans = num(/计划卡待办 \| \*\*(\d+)\*\*/)
  const total = num(/合计\*\* \| \*\*(\d+)\*\*/)
  check('★★ 合计 == 卡 + 日志 + 问卷 + 计划（四段之和）',
    total === cards + logs + decks + plans && total > 0,
    `合计=${total} 卡=${cards} 日志=${logs} 问卷=${decks} 计划=${plans}`)
  // 表里实际行数必须与声称的卡数一致（防"表被截断/多算"）
  // ⚠ 只数 §1 那一段 —— 日志表也以 `| \` 开头，全文数会把日志行算进来（第一版就这么红的）。
  const sec1 = md.slice(md.indexOf('## 1. 未完成卡'), md.indexOf('## 2. 日志'))
  const rows = (sec1.match(/^\| `[^`]+` /gm) || []).length
  check('★★ §1 的表行数与声称的卡数相差 ≤ 2（多算/漏算要在 2 以内）',
    Math.abs(rows - cards) <= 2, `行=${rows} 声称=${cards}`)
}

// ── ④ 不许大面积空列（本轮踩过三次的正是这个）──────────────────────────
{
  const rows = md.split('\n').filter((l) => /^\| `[^`]+` /.test(l) && l.split('|').length >= 6)
  const emptyLast = rows.filter((l) => /\|\s*—\s*\|\s*$/.test(l))
  // "多久没动"列不许大于 5%（真数据里绝大多数卡都有 `更新:`）
  const unknownAge = rows.filter((l) => l.includes('时间不详')).length
  check('★★ "多久没动"列的空值 ≤ 5%（字段名写错会让整列变成"时间不详"）',
    rows.length > 0 && unknownAge / rows.length <= 0.05,
    `空=${unknownAge}/${rows.length}`)
  // "未勾项"列：允许空（有些卡正文没有 checkbox），但不许 100% 空
  check('★ "正文里未勾的项"列不是**全空**（全空说明抓错形态了 —— 本轮踩过一次）',
    emptyLast.length < rows.length,
    `空=${emptyLast.length}/${rows.length}`)
}

// ── ⑤ 已知假行必须被排除 ───────────────────────────────────────────────
{
  // ⚠ 这条断言**改过三次**，每次都是反例自证抓到的，记下来：
  //   ① 只查"输出里没有 .decision-log" → 删掉过滤行它照样绿（那些文件 total==0，
  //      会被后面 `if total == 0: continue` 顺带滤掉）；
  //   ② 改成钉源码里 `deck.endswith(".decision-log")` 这几个字 → 删掉过滤行后
  //      那段变成 `pass`，但**函数里别处也有同样写法**（count_approved_undelivered
  //      里也有一处），于是它仍然命中、仍然绿；
  //   ③ 现在钉的是**行为**：把一个带题目的 decision-log 塞进临时目录，
  //      跑一遍，它**不许出现在问卷段里**。行为对了才算数，字面对不对不重要。
  const os = require('os')
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-inv-'))
  try {
    fs.mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(tmpRoot, 'task-data', 'questionnaires'), { recursive: true })
    fs.mkdirSync(path.join(tmpRoot, 'task-data', 'plans', '_drafts'), { recursive: true })
    // 一份**有题目的** decision-log：不靠 total==0 兜底，必须靠过滤规则
    fs.writeFileSync(path.join(tmpRoot, 'task-data', 'questionnaires', 'X.decision-log.md'),
      '# X\n\n## S1 题一\n问题？\n- **A. 甲**——代价\n- **B. 乙**——代价\n', 'utf-8')
    // 一份正常卷：没答 → 应出现在问卷段
    fs.writeFileSync(path.join(tmpRoot, 'task-data', 'questionnaires', 'Y.md'),
      '# Y\n\n## S1 题一\n问题？\n- **A. 甲**——代价\n- **B. 乙**——代价\n', 'utf-8')
    // ⚠ 不能把脚本复制到临时根再跑：它用 `ROOT = 脚本目录的上级` 找 `tegula.core`，
    //   搬过去就 import 不到（第一版就是这么编不过的）。改成**原地跑 + FC_INV_ROOT 指定数据根**。
    const out = execFileSync('python', [SCRIPT], {
      cwd: ROOT, encoding: 'utf-8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', FC_INV_ROOT: tmpRoot },
      timeout: 300000,
    })
    // 只取问卷段
    const seg = out.slice(out.indexOf('## 3. 问卷'), out.indexOf('## 4. 计划卡'))
    check('★★ 有题目的 `*.decision-log.md` **不进**问卷段（钉行为，不钉字面）',
      !seg.includes('X.decision-log'),
      '问卷段里出现了 X.decision-log；该段前 100 字：' + seg.slice(0, 100))
    check('★ 同一夹具里的正常卷 Y 正常出现（防"什么都筛掉"的假绿）',
      seg.includes('Y'), seg.slice(0, 120))
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  check('★★ 输出里也确实没有 `.decision-log` 被当成卷',
    !md.includes('.decision-log`') && !md.includes('.decision-log |'),
    (md.split('\n').find((l) => l.includes('decision-log')) || '').slice(0, 80))
  const guardRows = md.split('\n').filter((l) => /^\| `check-/.test(l))
  const noResult = guardRows.filter((l) => l.includes('未跑到结果行'))
  check('★★ 守卫结果行两种写法都认（`RESULT n/m` 与 `通过 n/失败 m`）—— 不许一半显示"未跑到"',
    guardRows.length >= 8 && noResult.length === 0,
    `守卫=${guardRows.length} 未跑到=${noResult.length}`)
}

// ── ⑥ 阶段卡解析：两种标题写法都要认（2026-11-15 补）──────────────────
//
// 为什么补这条：上面整套 12 条**全绿**，而清单里同时错了两件事 —— 它们都是"解析上层"的错，
// 不是"输出层"的错，所以自洽性断言看不见：
//   ① 阶段标题只认 `### P0 · 标题`，而真身里 `### P8 结论集落代码…`（无 `·`）有 6 格
//      → memory-sanctuary / project-3 两整个项目 0 条、fangcun-base 少 4 条，
//        而「四段之和 == 合计」照样成立（少算的那部分从来没进过任何一段）；
//   ② 草案一栏**无脑全收**（目录里有几个文件就报几条"待提成"）→ 声称"8 份差一次点击"，
//      真身：4 份早提成完了、4 份重号提不动。
// 所以这里要用**独立实现的解析**（不调脚本里的函数）去对账，脚本自己算错了才拦得住。
{
  const plansDir = path.join(ROOT, 'task-data', 'plans')
  const draftsDir = path.join(plansDir, '_drafts')

  // ① 独立数一遍：真身里到底有多少格是「已冻结 / 待裁决」（两种标题写法都收）
  const wantStages = []
  for (const f of fs.readdirSync(plansDir).filter((x) => x.endsWith('.md') && !x.includes('.bak-'))) {
    const txt = fs.readFileSync(path.join(plansDir, f), 'utf-8')
    const heads = [...txt.matchAll(/^###\s+(P\d+)\s*[·:：]?\s*(.*)$/gm)]
    for (let i = 0; i < heads.length; i++) {
      const seg = txt.slice(heads[i].index + heads[i][0].length,
        i + 1 < heads.length ? heads[i + 1].index : txt.length)
      const st = (/^-\s*状态:\s*(.+)$/m.exec(seg) || [])[1]
      const s = st ? st.trim() : ''
      if (['待裁决', '未冻结', '待裁决（未冻结）', '已冻结'].includes(s)) {
        wantStages.push(`${f}:${heads[i][1]}`)
      }
    }
  }
  const sec4 = md.slice(md.indexOf('## 4. 计划卡'), md.indexOf('## 5. 代码层'))
  const gotStages = [...sec4.matchAll(/^\| 已冻结未推进 \| `task-data\/plans\/([^`]+)` \| (P\d+) /gm)]
    .map((m) => `${m[1]}:${m[2]}`)
  const missingStages = wantStages.filter((x) => !gotStages.includes(x))
  check('★★ 计划卡的格子**一格不漏**（含无 `·` 的标题写法：`### P8 结论集…`）',
    wantStages.length > 0 && missingStages.length === 0,
    `真身=${wantStages.length} 清单=${gotStages.length} 漏=${missingStages.join(',') || '无'}`)
  // ⚠ 反向：清单也不许多报出不存在的格子
  const ghost = gotStages.filter((x) => !wantStages.includes(x))
  check('★ 清单里没有**编出来的**计划格（多报同样要红）', ghost.length === 0, ghost.join(',') || '无')

  // ② 草案：每一份都必须有明确归类，且"待提成"不许把已提成的算进来
  const draftFiles = fs.readdirSync(draftsDir).filter((x) => x.endsWith('.md'))
  const classified = draftFiles.filter((f) => sec4.includes(f))
  check('★★ 每份草案都在 §4 里有**明确归类**（待提成 / 提不进 / 已提成），不许有文件凭空消失',
    draftFiles.length === 0 || classified.length === draftFiles.length,
    `草案=${draftFiles.length} 出现=${classified.length} 缺=${draftFiles.filter((f) => !sec4.includes(f)).join(',') || '无'}`)
  // 逐格比对：能对上的（判据逐条相同）**不许**被列成"待提成"
  let promoted = 0
  const wrongly = []
  for (const f of draftFiles) {
    const pid = f.replace(/\.md$/, '').replace(/-\d{4}-\d{2}-\d{2}.*$/, '')
    const planPath = path.join(plansDir, `${pid}.md`)
    if (!fs.existsSync(planPath)) continue
    const planTxt = fs.readFileSync(planPath, 'utf-8')
    const planCrit = {}
    for (const m of planTxt.matchAll(/^###\s+(P\d+)\s*[·:：]?\s*(.*)$/gm)) {
      const seg = planTxt.slice(m.index + m[0].length)
      const nxt = /^###\s/m.exec(seg)
      const body = nxt ? seg.slice(0, nxt.index) : seg
      planCrit[m[1]] = (body.match(/^\s*-\s*(?:cmd|str|num|file):.*$/gm) || [])
        .map((l) => l.replace(/\s+/g, ' ').trim())
    }
    const dTxt = fs.readFileSync(path.join(draftsDir, f), 'utf-8')
    for (const m of dTxt.matchAll(/^###\s+(P\d+)\s*[·:：]?\s*(.*)$/gm)) {
      const seg = dTxt.slice(m.index + m[0].length)
      const nxt = /^###\s/m.exec(seg)
      const body = nxt ? seg.slice(0, nxt.index) : seg
      const crit = (body.match(/^\s*-\s*(?:cmd|str|num|file):.*$/gm) || [])
        .map((l) => l.replace(/\s+/g, ' ').trim())
      if (crit.length && planCrit[m[1]] && planCrit[m[1]].join('|') === crit.join('|')) promoted++
      // 这一格若已提成，草案行不许把这格记成待提成
      //
      // ⚠ 这条第一版写成 `row.includes(`${m[1]} ·`)` —— **假绿**：脚本实际把格子列成
      //   `（4 格：P8、P9、P10、P11）`，用的是顿号不是 ` · `，所以永远不命中。
      //   是反例自证（把"草案无脑全收"装回去）当场抓到的：注入后 exit=0、零红。
      //   现在按**格子号的词边界**判，不看分隔符长什么样。
      if (crit.length && planCrit[m[1]] && planCrit[m[1]].join('|') === crit.join('|')) {
        const idRe = new RegExp(`(^|[^0-9A-Za-z])${m[1]}(?![0-9])`)
        const row = sec4.split('\n').find((l) => l.includes(f) && l.includes('待提成'))
        if (row && idRe.test(row)) wrongly.push(`${f}:${m[1]}`)
      }
    }
  }
  check('★ 草案里**已提成**的格子不算待提成（"文件还在" ≠ "事情没做"）',
    wrongly.length === 0, wrongly.slice(0, 3).join(',') || '无')
  check('★ 真身里确实存在"已提成"的草案格（防这条断言永远绿）', promoted > 0, `promoted=${promoted}`)
}

// ── ⑦ --check 的退出码语义 ─────────────────────────────────────────────
{
  let code = 0
  let out = ''
  try { out = runPy(['--check']) } catch (e) { code = e.status || 1; out = String(e.stdout || '') }
  check('★★ `--check` 有未完成时**非零退出**（否则它当不了闸）', code !== 0, 'exit=' + code)
  check('★ `--check` 输出带合计数字（不是只有一句话）', /\d+ 条/.test(out), out.trim().slice(0, 80))
}

console.log('')
if (failures.length) { console.log('失败明细：'); failures.forEach((x) => console.log('  · ' + x)) }
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
