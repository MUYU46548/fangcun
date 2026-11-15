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

const before = fingerprint()
const md = runPy()
const after = fingerprint()

// ── ① 只读（跑一遍不许动任何 task-data 文件）────────────────────────────
{
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed = [...before.keys()].filter((k) => after.has(k) && before.get(k) !== after.get(k))
  check('★★ 清单生成器是**只读**的（task-data 一个文件都不许动）',
    added.length === 0 && removed.length === 0 && changed.length === 0,
    `新增=${added.length} 删除=${removed.length} 改动=${changed.length}` +
    (changed.length ? ' 首个改动：' + changed[0] : ''))
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

// ── ⑥ --check 的退出码语义 ─────────────────────────────────────────────
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
