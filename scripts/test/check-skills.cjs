/**
 * 技能真源一致性守卫（2026-10-03 用户：「方寸自带 skill 后续应该如何保持更新和维护？」）
 *
 * 背景：技能真源是 `skills/manifest.json` + `skills/<id>/SKILL.md`，随方寸安装包分发到
 * `resources/skills/`，再由主进程同步到 Hermes / DSH 的技能目录；`docs/agents/<id>/` 是仓库内的
 * 第二份副本（给手工导入用的）。**四份东西靠人手动同步 → 一定会漂**。
 *
 * 首跑实测就是这个后果：`fangcun-bridge/SKILL.md` 的 frontmatter 写着 `version: 1.2.0`，
 * 而 manifest 已记 `1.3.0` —— 内容对得上、**版本号对不上**，谁也不知道这台机器上装的是哪一版。
 *
 * 本守卫钉住五件事（都不需要 electron / 不起子进程，本机可跑）：
 *   ① manifest.json 可解析且有 version / lastUpdated；
 *   ② 每个技能文件真的存在，frontmatter 有 name + description；
 *   ③ **frontmatter.version === manifest 里登记的 version**（防漂移 —— 核心那条）；
 *   ④ frontmatter.name === manifest 的 id（改了文件名忘改 id 会在这里现形）；
 *   ⑤ `docs/agents/<id>/SKILL.md` 副本若存在，必须与真源**逐字节一致**（防分叉）；
 *   ⑥ 磁盘上有 SKILL.md 却没登记进 manifest 的目录要报出来（会漏装）。
 * 顺带打印每个技能的 md5 —— 人拿它对照 agent 侧装的那份是不是这一版。
 *
 * 运行：node scripts/test/check-skills.cjs
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const REPO = path.resolve(__dirname, '../..')
const SKILLS = path.join(REPO, 'skills')
const MANIFEST = path.join(SKILLS, 'manifest.json')
const DOCS_AGENTS = path.join(REPO, 'docs', 'agents')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

function md5(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')
}

/** 极简 frontmatter 解析：只取 `---` 之间第一层的 `key: value`（技能卡的 frontmatter 很浅）
 *  ⚠ 必须逐行去掉行尾 `\r` —— 这些文件是 CRLF，`(.*)$` 抓到的值会带一个 `\r`，
 *     拼进版本号比较就是"1.3.0\r" ≠ "1.3.0"（首版就这么误报过）。 */
function readFrontmatter(file) {
  const txt = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')
  if (!txt.startsWith('---')) return null
  const end = txt.indexOf('\n---', 3)
  if (end < 0) return null
  const fm = {}
  for (const raw of txt.slice(3, end).split('\n')) {
    const line = raw.replace(/\r$/, '')
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return fm
}

function main() {
  console.log('== 技能真源一致性守卫 ==')

  check('manifest.json 存在', fs.existsSync(MANIFEST), MANIFEST)
  if (!fs.existsSync(MANIFEST)) { finish(); return }

  let manifest = null
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) } catch (e) {
    check('manifest.json 可解析', false, e.message)
    finish(); return
  }
  check('manifest.json 可解析', true)
  check('manifest 有 version 与 lastUpdated', !!manifest.version && !!manifest.lastUpdated,
    JSON.stringify({ v: manifest.version, u: manifest.lastUpdated }))
  // 与 app 版本对齐：技能随安装包分发，用户看"清单版本"能直接对上"方寸版本"，才不会问"我装的是哪版技能"
  const appVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop', 'package.json'), 'utf-8')).version
  check('★ manifest.version 与 desktop/package.json 版本一致（技能随包分发 —— 数字要对得上）',
    String(manifest.version) === String(appVersion), `manifest=${manifest.version} app=${appVersion}`)

  const entries = Array.isArray(manifest.skills) ? manifest.skills : []
  check('manifest 登记了技能', entries.length > 0, 'n=' + entries.length)

  const registered = new Set()
  for (const e of entries) {
    const id = String(e.id || '')
    const ver = String(e.version || '')
    if (!id) continue
    registered.add(id)

    const src = path.join(SKILLS, id, 'SKILL.md')
    console.log(`  · ${id}  v${ver}  ${fs.existsSync(src) ? md5(src) : '(文件缺失)'}`)
    if (!check(`「${id}」技能文件存在`, fs.existsSync(src), src)) continue

    const fm = readFrontmatter(src)
    check(`「${id}」frontmatter 可解析`, !!fm, src)
    if (!fm) continue
    check(`「${id}」frontmatter 有 name 与 description`, !!fm.name && !!fm.description,
      JSON.stringify({ name: fm.name, desc: (fm.description || '').slice(0, 20) }))
    check(`★ 「${id}」frontmatter.name 与 manifest 的 id 一致（改了目录忘改 name 会在这里现形）`,
      fm.name === id, `fm.name=${fm.name} id=${id}`)
    check(`★ 「${id}」frontmatter.version 与 manifest 登记一致（防版本号漂移 —— 本守卫的核心）`,
      String(fm.version) === ver, `SKILL.md=${fm.version} manifest=${ver}`)
    check(`「${id}」version 是 x.y.z 形状`, /^\d+\.\d+\.\d+$/.test(String(fm.version)), String(fm.version))

    // 仓库内第二份副本（docs/agents/<id>/）—— 给人手工导入用的，必须与真源逐字节一致
    const copy = path.join(DOCS_AGENTS, id, 'SKILL.md')
    if (fs.existsSync(copy)) {
      check(`★ 「${id}」docs/agents 副本与真源逐字节一致（防两处分叉）`,
        md5(copy) === md5(src), `真实=${md5(src)} 副本=${md5(copy)}`)
    }
  }

  // 磁盘上有、manifest 没登记 → 会漏装
  let unlisted = []
  try {
    unlisted = fs.readdirSync(SKILLS, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(SKILLS, d.name, 'SKILL.md')))
      .map(d => d.name)
      .filter(n => !registered.has(n))
  } catch { /* 目录不存在 → 上面已经报过 */ }
  check('★ 没有"有 SKILL.md 却没登记进 manifest"的目录（会静默漏装）',
    unlisted.length === 0, JSON.stringify(unlisted))

  finish()
}

function finish() {
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
