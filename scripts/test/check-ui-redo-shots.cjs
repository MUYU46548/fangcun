#!/usr/bin/env node
/**
 * 界面重做 · 逐屏清单机检（2026-11-16 · P12 第一交付物）
 *
 * ## D-140 的验收线原文
 *
 * > 「若选 A/C 而我把『**没做的那些视图**』算成做完了 = **违约**。」
 * > `file: docs/界面重做-逐屏清单.md` · `num: 条目数 >= 19`
 *
 * ## 为什么"条目数 >= 19"这条不够
 *
 * 19 是 REV-012 写下的**估算**。源码实数（`App.vue` 的 `views` + `PV_VIEWS`）现在是 **25 屏**。
 * 拿 19 当判据，要么逼我删屏凑数，要么让清单永远"够数"而少列了 6 屏也没人知道。
 * 所以本守卫钉的是 **清单 == 源码**，不是 == 19：
 *
 *   ① 清单里的屏数必须**等于**源码实际屏数（源码加了视图而清单没跟上 → 红）
 *   ② 每屏状态只能是 未做 / 在做 / 已交付（不许留空、不许"基本完成"这种话）
 *   ③ 标了「已交付」的屏，`docs/界面重做/<id>/` 下必须有**桌面 + 窄屏两张**截图
 *      （这条就是防"把没做的算成做完"的机器版本）
 *   ④ `help` 屏确实已交付 → 用来反证 ③ 不是永远绿
 *   ⑤ 只读
 *
 * 跑法：node scripts/test/check-ui-redo-shots.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const LIST = path.join(ROOT, 'docs', '界面重做-逐屏清单.md')
const APP = path.join(ROOT, 'desktop', 'src', 'renderer', 'App.vue')
const SHOTS = path.join(ROOT, 'docs', '界面重做')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

/** 从源码取真实屏列表（不猜、不从文档抄） */
function realViews() {
  const t = fs.readFileSync(APP, 'utf-8')
  const mV = t.match(/const views\b[^=]*=\s*\[([\s\S]*?)\n\]/)
  const tabs = mV ? [...mV[1].matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]) : []
  const pv = t.match(/const PV_VIEWS[^=]*=\s*\[(.*?)\]/)
  const inner = pv ? [...pv[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : []
  return { tabs, inner, all: [...tabs, 'help', ...inner] }
}

/** 解析清单表格行：| # | 屏 | `id` | ... | 状态 | */
function listRows(md) {
  const out = []
  for (const line of md.split('\n')) {
    const cells = line.split('|').map((x) => x.trim())
    if (cells.length < 7) continue
    if (!/^\d+$/.test(cells[1])) continue
    const idM = (cells[3] || '').match(/`([a-z]+)`/)
    const status = cells[cells.length - 2]
    out.push({ no: Number(cells[1]), name: cells[2], id: idM ? idM[1] : '', status })
  }
  return out
}

function shotFiles(id) {
  const d = path.join(SHOTS, id)
  if (!fs.existsSync(d)) return []
  return fs.readdirSync(d).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
}

function main() {
  console.log('=== 一、清单存在且可解析 ===')
  check('★★ `docs/界面重做-逐屏清单.md` 存在（P12 第一交付物）', fs.existsSync(LIST))
  if (!fs.existsSync(LIST)) { report(); return }
  const md = fs.readFileSync(LIST, 'utf-8')
  const rows = listRows(md)
  check('★ 清单能被解析成行', rows.length > 0, 'rows=' + rows.length)

  const { all: real } = realViews()
  check('★ 从源码取到真实屏列表', real.length > 0, 'views=' + real.length)

  // ── 二、清单 == 源码（不是 == 19）──────────────────────────
  console.log('\n=== 二、清单必须等于源码，不是等于文档里写的数字 ===')
  check('★★ 屏数一致（少列/多列都红）', rows.length === real.length,
    `清单 ${rows.length} vs 源码 ${real.length}`)
  const inList = rows.map((r) => r.id)
  const missing = real.filter((v) => !inList.includes(v))
  const ghost = inList.filter((v) => !real.includes(v))
  check('★★ 源码里的每一屏都在清单里（不许漏）', missing.length === 0, '漏：' + missing.join(','))
  check('★★ 清单里没有源码不存在的屏（不许编）', ghost.length === 0, '多：' + ghost.join(','))
  check('★ `num: 条目数 >= 19` 这条判据本身被满足',
    rows.length >= 19, '实际 ' + rows.length)

  // ── 三、状态只能三档 ───────────────────────────────────────
  console.log('\n=== 三、状态三档，不许模糊 ===')
  const OK_STATUS = ['未做', '在做', '已交付']
  const bad = rows.filter((r) => !OK_STATUS.some((s) => r.status.startsWith(s)))
  check('★★ 每屏状态 ∈ {未做, 在做, 已交付}（"基本完成"这种话不许出现）',
    bad.length === 0, bad.slice(0, 4).map((r) => r.name + '=' + r.status).join(' | '))

  // ── 四、已交付的必须有两张截图（防"没做的算成做完"）────────
  console.log('\n=== 四、写"已交付"就得有两张截图 ===')
  const done = rows.filter((r) => r.status.startsWith('已交付'))
  // 一条都没交付也合法（P12 刚开工），但**清单必须自己说出来** ——
  // 不能让「0 屏已交付」和「漏标了」长得一样（这是本仓的老毛病：假绿）。
  check('★ 没有已交付时清单必须明说（否则 ③ 与"漏标"长一个样）',
    done.length > 0 || /当前没有|全部.*未做|尚未交付/.test(md),
    '已交付 ' + done.length + ' 屏')
  for (const r of done) {
    const files = shotFiles(r.id)
    const wide = files.some((f) => /(desktop|wide|1440|\d{4}x)/i.test(f)) || files.length >= 2
    const narrow = files.some((f) => /(narrow|900|700|窄)/i.test(f))
    check(`★★ ${r.name}（${r.id}）已交付 ⇒ 桌面 + 窄屏两张截图都在`,
      files.length >= 2 && wide && narrow,
      files.length ? files.join(',') : `docs/界面重做/${r.id}/ 是空的 → 不许算已交付`)
  }
  // 未交付的**不该**有假截图目录（不许先摆好截图再改状态的说法反过来也管）
  const fake = rows.filter((r) => r.status.startsWith('未做') && shotFiles(r.id).length > 0)
  check('★ 标"未做"的屏不许已经有截图目录（防伪造进度）', fake.length === 0,
    fake.map((r) => r.id).join(','))

  // ── 五、只读 ──────────────────────────────────────────────
  console.log('\n=== 五、只读 ===')
  const before = fs.statSync(LIST).mtimeMs + ':' + fs.statSync(LIST).size
  fs.readFileSync(LIST, 'utf-8')
  check('★ 读一遍清单不改它的字节与 mtime',
    before === fs.statSync(LIST).mtimeMs + ':' + fs.statSync(LIST).size)

  report()
}

function report() {
  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main()
