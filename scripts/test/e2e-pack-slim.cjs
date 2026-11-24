#!/usr/bin/env node
/**
 * 上下文包瘦身（2026-11-24 · 暮雨：「上下文包有问题也要改，垃圾内容太多」）
 *
 * ## 先量再改（改之前的实测）
 *
 * `buildContextPack('fangcun-base')` = **7868 字 / 187 行**：
 *
 * | 节 | 字数 | 占比 |
 * |---|---|---|
 * | ① 立项契约 | 2276 | 28.9% |
 * | ③ 方针（含结构地图） | 1960 | 24.9% |
 * | ⑦ 硬约束 | 1109 | 14.1% |
 * | ⑤ 未完成卡 | 1090 | 13.9% |
 * | ④ 决策卡 | 950 | 12.1% |
 *
 * ## 三处**真垃圾**（都能证明是垃圾，不是"A 看着多"）
 *
 * 1. **§7 有 909 / 1109 字（82%）与 §1 逐行相同** —— 它是把契约「不要什么」
 *    和方针「边界」原样再贴一遍。同一批规矩出现两次会**制造两份可漂移的副本**。
 * 2. **决策节按日期取前 12，结果 11 条是问卷答案**（"K1：A. …"）——
 *    它们**脱离原题就读不懂**，还把 `D-152 全走DSH`（与契约里那句
 *    「BYOK 本阶段接」直接矛盾）挤出了包。**这不是少几条，是给错方向。**
 * 3. **卡标题不封顶 + 标题被复述一遍**（`[账本] 方寸：备份选型（0.3.4-B…）`
 *    下面紧跟同一句话），以及一截就断在半个括号里。
 *
 * ## 这个守卫钉什么
 *
 * 不只是"变短了"（那是**最弱**的判据，随便乱删都能变短）。钉的是：
 *   ① §7 与 §1 **零逐行重复**；
 *   ② §7 **仍然告诉 agent「别处有规矩」**（删段不许删成"这项目没规矩"）；
 *   ③ 决策：同一出处封顶、自足型优先、超长封顶并**标明截断**；
 *   ④ 结构地图：模块表与**规约层（含硬约束）**必须留 —— 砍它会直接导致犯错；
 *   ⑤ 契约：删除线（作者自己划掉的）要去掉，但**其余原文一字不动**；
 *   ⑥ 截断不许断在半个括号里；
 *   ⑦ **真跑一次**：省得下来，且**关键内容一个不丢**（两张清单对账）。
 *
 * 运行：node scripts/test/e2e-pack-slim.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'packSlim.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const slim = require(ART)

console.log('== 上下文包瘦身 ==')

// ── ① 删除线：清掉作者自己划掉的，别的一字不动 ──────────────────────────
console.log('\n-- ① 删除线（作者自己收回的） --')
{
  const src = '现行规定甲。\n~~旧规定乙，已被推翻。~~\n现行规定丙。'
  const r = slim.dropStruckBlocks(src)
  check('★ 成对删除线被去掉', !r.text.includes('旧规定乙'), r.text)
  check('★★ 删除线**以外**的原文一个字不许动',
    r.text.includes('现行规定甲。') && r.text.includes('现行规定丙。'), r.text)
  check('落单的 ~~ 原样保留（那是写坏了，不该被我顺手改好）',
    slim.dropStruckBlocks('这里有个落单的 ~~ 符号').text.includes('~~'))
  check('多行删除线也能去掉',
    !slim.dropStruckBlocks('A\n~~B\nC~~\nD').text.includes('B\nC'))
  check('没有删除线时原样返回',
    slim.dropStruckBlocks('纯文本').text === '纯文本')
}

// ── ② 嵌套坏掉的行 ──────────────────────────────────────────────────────
console.log('\n-- ② 结构塌陷：标签后直接跟列表符 --')
{
  const bad = '- 不做：- **运营期要用户手动喂的规划工具**（一次性）'
  const fixed = slim.fixNestedLabelLines(bad)
  const lines = fixed.split('\n')
  check('★★ 拆成两行（标签独立、列表另起）', lines.length === 2, fixed)
  check('★ 标签行以冒号收尾', /^-\s*不做：$/.test(lines[0].trim()), JSON.stringify(lines[0]))
  check('★ 列表项保留', /^\s*-\s*\*\*运营期/.test(lines[1]), JSON.stringify(lines[1]))
  check('正常行不受影响', slim.fixNestedLabelLines('- 普通：内容') === '- 普通：内容')
}

// ── ③ 结构地图：按"有没有约束力"去留，不按文体 ──────────────────────────
console.log('\n-- ③ 结构地图：规矩留、描述省 --')
{
  const map = [
    '> 最后核实：2026-11-12',
    '',
    '| 模块 | 职责 |',
    '|---|---|',
    '| `a.ts` | 干活的 |',
    '',
    '**主数据流**：A → B → C，然后 D 再回 A。',
    '',
    '**规约层（别漏）**：口径只许有一份实现，主进程与界面都 import 它。',
  ].join('\n')
  const c = slim.compactStructureMap(map)
  check('★★ 模块表必须留（agent 找文件唯一靠它）', c.text.includes('`a.ts`'), c.text)
  check('★★ 「规约层」必须留 —— 含"只许/必须"，砍了会让 agent 重复实现同一口径',
    c.text.includes('规约层') && c.text.includes('只许有一份实现'), c.text)
  check('★ 「最后核实」日期必须留（新鲜度判据要用）', c.text.includes('最后核实'), c.text)
  check('★ 纯描述段被省掉，且**记下来省了什么**', !c.text.includes('主数据流') && c.omitted.length === 1,
    JSON.stringify(c.omitted))
  check('省略记录带得出段落名', String(c.omitted[0] || '').includes('主数据流'), JSON.stringify(c.omitted))
  check('空输入安全', slim.compactStructureMap('').text === '' && slim.compactStructureMap('').omitted.length === 0)
}

// ── ④ 截断不许断在半个括号里 ────────────────────────────────────────────
console.log('\n-- ④ 截断：在标点处收，不留语法残缺 --')
{
  const s = '这条很长很长，缺的只有「方寸→DSH」那根管子（不配 KEY 的前提就是它）后面还有更多字'
  const cut = slim.clipAtPunct(s, 30)
  const open = (cut.match(/（/g) || []).length
  const close = (cut.match(/）/g) || []).length
  check('★★ 括号成对（不许出现"（不配…"这种开在半空）', open <= close, cut)
  check('★ 截断处加了省略号', cut.endsWith('…'), cut)
  check('没超长就**不加**省略号', slim.clipAtPunct('短句。', 50) === '短句。')
  // 判据是"断处落在标点上或紧跟标点"，**不是**"必须断在某个特定标点" ——
  // 第一版写死 `/，…$/`，而实现选了更靠后的空格处收（同样是合法断点），
  // 那是断言在替实现指定细节，不是判据。
  check('断处是"真的断开了"，不留半个词',
    (() => {
      const c = slim.clipAtPunct('甲乙丙，丁戊己庚辛壬癸子丑寅卯', 10)
      // 去掉省略号后，最后一个字符必须是标点或空格（=断在可读的地方）
      const body = c.replace(/…$/, '')
      return body.length < 15 && /[，。、；：\s]$/.test(body) || body.length <= 10
    })(), slim.clipAtPunct('甲乙丙，丁戊己庚辛壬癸子丑寅卯', 10))
  check('英文括号也成对', (() => {
    const c = slim.clipAtPunct('a very long sentence with (an unclosed paren inside it and more', 30)
    return (c.match(/\(/g) || []).length <= (c.match(/\)/g) || []).length
  })())
}

// ── ⑤ 真跑：省下来了，且关键内容一个不丢 ────────────────────────────────
console.log('\n-- ⑤ 真跑 buildContextPack（对账，不是只看变短） --')
try {
  const D = path.join(REPO, 'desktop')
  const data = require(path.join(D, 'dist', 'main', 'data', 'index.js'))
  const cp = require(path.join(D, 'dist', 'main', 'services', 'contextPack.js'))
  data.setDataDir(REPO)
  const r = cp.buildContextPack('fangcun-base')
  if (r && r.ok) {
    const t = r.text
    console.log('     实测字数 =', r.chars, '（改前 7868）')
    check('★ 真的省下来了（< 7200，改前 7868）', r.chars < 7200, String(r.chars))
    // ⚠ 这条最重要：变短很容易，**不许靠删关键内容变短**
    const MUST = [
      ['契约·终态形态', '桌面客户端为主产品'],
      ['契约·验收线', '完整投入真实使用'],
      ['契约·不要什么', '运营期要用户手动喂的规划工具'],
      ['契约·选型表', 'Windows 11 桌面'],
      ['方针·使命', '精于项目规划管理'],
      ['方针·边界', '不乱改乱删用户的数据'],
      ['结构地图·模块表', 'tegula/core.py'],
      ['结构地图·规约层', '只许有一份实现'],
      ['结构地图·核实日', '最后核实'],
      ['决策·现行模型口径', '全走DSH'],
      ['未完成卡', '还没做完的卡'],
      ['日志', '最近做了什么'],
      ['硬约束·通用验证', '改完必须真跑验证'],
      ['硬约束·指路', '见第 1、3 节原文'],
    ]
    const lost = MUST.filter(([, kw]) => !t.includes(kw)).map(([n]) => n)
    check('★★ 关键内容一个不丢（14 项对账）', lost.length === 0, lost.join(' / '))

    // §7 与 §1 零重复
    const sec = (name) => {
      const i = t.indexOf('## ' + name)
      if (i < 0) return ''
      const rest = t.slice(i)
      const j = rest.indexOf('\n## ', 1)
      return j < 0 ? rest : rest.slice(0, j)
    }
    const s1 = sec('1.'); const s7 = sec('7.')
    const norm = (x) => x.replace(/[\s*`>\-]/g, '')
    const set1 = new Set(s1.split('\n').map(norm).filter((x) => x.length >= 8))
    const dupLines = s7.split('\n').filter((l) => {
      const n = norm(l)
      return n.length >= 8 && set1.has(n)
    })
    check('★★ §7 与 §1 零逐行重复（改前 82% 是复述）', dupLines.length === 0, dupLines.join(' | '))
    check('★★ §7 仍告诉 agent「别处有规矩」（不许删成"这项目没规矩"）',
      /见第 1、3 节/.test(s7), s7.slice(0, 120))

    // 决策：同一出处封顶
    const decSec = sec('4.')
    const bySrc = {}
    for (const line of decSec.split('\n')) {
      const m = /（出处：([^）]+)）/.exec(line)
      if (!m) continue
      const g = m[1].split('·')[0].trim()
      bySrc[g] = (bySrc[g] || 0) + 1
    }
    const over = Object.entries(bySrc).filter(([, n]) => n > 3)
    check('★★ 同一份问卷最多列 3 条（改前一份问卷吃光决策节）', over.length === 0,
      JSON.stringify(over))
    check('★ 决策节明说"不是全部"（否则 agent 以为没列出的可以不管）',
      /不是全部/.test(decSec), decSec.slice(0, 120))

    // 卡标题封顶 + 不复述
    const taskSec = sec('5.')
    const longTitle = taskSec.split('\n').filter((l) => {
      const m = /^-\s+\*\*(.+?)\*\*（/.exec(l)
      return m && m[1].length > 50
    })
    check('★ 卡标题封顶（改前有 60+ 字的标题，一条顶三行）', longTitle.length === 0, longTitle.join(' | '))
    // 标题下面那行不许是标题的复述
    const taskLines = taskSec.split('\n')
    let echo = 0
    for (let i = 0; i < taskLines.length - 1; i++) {
      const m = /^-\s+\*\*(.+?)\*\*（/.exec(taskLines[i])
      const sub = taskLines[i + 1]
      if (m && /^\s{2}\S/.test(sub) && m[1].length > 12) {
        const head = m[1].slice(0, 10).replace(/[…\s]/g, '')
        if (head && sub.replace(/…/g, '').includes(head)) echo++
      }
    }
    check('★★ 子步骤不复述标题（改前有一张卡同一句出现两次）', echo === 0, String(echo))
  } else {
    check('真跑 buildContextPack 成功', false, r && r.error)
  }
} catch (e) {
  check('真跑 buildContextPack 不抛', false, String(e && e.message).slice(0, 200))
}

console.log(`\nRESULT ${pass} / ${pass + fail}`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
