/**
 * 技能安装专区（2026-09-26 卡 038「方寸技能毫无存在感」）
 *
 * 本轮真因：主进程早就有 checkSkillsStatus / installSkills 和 `skills:check` /
 * `skills:install` 两条通道，**渲染层从来没有入口** —— 功能在、界面不在。
 * 本测试钉住四件事：
 *   ① 面板数据源（listSkillsForUi）与 `skills/manifest.json` 逐条对齐，且文件真的在磁盘上；
 *   ② 条目带绝对路径 + 正文，安装提示词里必须出现绝对路径（这就是"杜绝手抄"的落点）；
 *   ③ 磁盘上有 SKILL.md 但没登记的目录要显式报出来（unlisted），不许静默漏装；
 *   ④ 安装链路幂等：装 → 跳过 → 被改动 → 重装，且全程只落在测试沙盒里。
 *
 * ⚠ 安全性：getHermesSkillsDir() 读的是 LOCALAPPDATA，测试里先把它指向临时目录，
 *   否则会把技能写进**用户真实的 ~/.hermes/skills**。断言里也钉了这一点。
 *
 * 运行：node scripts/test/e2e-skills.cjs
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

// ── electron 桩注入（必须在业务模块之前）────────────────────────────
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

const TEST_ROOT = path.join(os.tmpdir(), 'fc-skills-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
process.env.LOCALAPPDATA = path.join(TEST_ROOT, 'localappdata')   // ← 见文件头安全说明

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const REPO = path.resolve(__dirname, '../..')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

async function main() {
  console.log('== 技能安装专区测试 ==')
  console.log('sandbox:', TEST_ROOT)

  const skillsMod = require(path.join(DIST, 'services', 'skillInstaller.js'))
  const electronStub = require(STUB)

  const manifestPath = path.join(REPO, 'skills', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const skillsDir = path.join(REPO, 'skills')

  // ── 1. 面板数据源与 manifest 对齐 ─────────────────────────────────
  const payload = skillsMod.listSkillsForUi()
  check('listSkillsForUi 返回 ok', payload.ok === true, JSON.stringify({ ok: payload.ok, error: payload.error }))
  check('清单版本与 skills/manifest.json 一致', payload.version === String(manifest.version), `${payload.version} vs ${manifest.version}`)
  check('技能条数与 manifest 登记数一致', payload.skills.length === manifest.skills.length, `${payload.skills.length} vs ${manifest.skills.length}`)
  check('skillsDir 指向仓库 skills/（开发态真源）', path.resolve(payload.skillsDir) === path.resolve(skillsDir), payload.skillsDir)
  check('★ hermesDir 落在测试沙盒里（没碰用户真实 ~/.hermes）',
    path.resolve(payload.hermesDir).startsWith(path.resolve(TEST_ROOT)), payload.hermesDir)

  for (const e of manifest.skills) {
    const it = payload.skills.find(x => x.id === e.id)
    check(`manifest 登记的「${e.id}」出现在面板里`, !!it)
    if (!it) continue
    check(`「${e.id}」文件真的在磁盘上（登记了就必须存在）`, it.exists === true, it.absPath)
    check(`「${e.id}」给的是绝对路径`, path.isAbsolute(it.absPath), it.absPath)
    check(`「${e.id}」路径与 manifest 的 file 字段一致`,
      path.resolve(it.absPath) === path.resolve(skillsDir, String(e.file).replace(/^skills[\\/]/, '')), it.absPath)
    check(`「${e.id}」带正文（供「复制全文」）`, typeof it.body === 'string' && it.body.length > 100, String(it.body || '').length)
    check(`「${e.id}」正文就是 SKILL.md 原文（以 --- 开头）`, String(it.body || '').startsWith('---'))
    check(`「${e.id}」正文与磁盘文件逐字节一致`,
      String(it.body || '') === fs.readFileSync(it.absPath, 'utf-8'), '')
    check(`★ 「${e.id}」安装提示词里带绝对路径（这就是杜绝手抄的落点）`, it.prompt.includes(it.absPath))
    check(`「${e.id}」提示词带技能 ID 与目标 agent`, it.prompt.includes(it.id) && it.prompt.includes(String(e.target)))
    check(`「${e.id}」target/version 透传自 manifest`,
      it.target === String(e.target) && it.version === String(e.version), `${it.target}/${it.version}`)
    check(`「${e.id}」hash 是 32 位 md5`, /^[0-9a-f]{32}$/.test(it.hash), it.hash)
    check(`「${e.id}」未装时 installed=false / outdated=true`, it.installed === false && it.outdated === true)
  }

  // ── 2. 磁盘上有、manifest 没登记的 → 必须报出来（不静默漏装）────────
  const diskDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
    .map(d => d.name)
  const regIds = manifest.skills.map(s => s.id)
  const expectedUnlisted = diskDirs.filter(d => !regIds.includes(d)).sort()
  check('★ 未登记技能目录被显式报出（unlisted）',
    JSON.stringify(payload.unlisted.slice().sort()) === JSON.stringify(expectedUnlisted),
    `面板=${JSON.stringify(payload.unlisted)} 磁盘差集=${JSON.stringify(expectedUnlisted)}`)

  // ── 3. 安装链路：装 → 幂等跳过 → 被改动 → 重装 ────────────────────
  const first = skillsMod.installSkills()
  check('★ 首次安装：两个技能都装上', first.installed.length === manifest.skills.length && first.errors.length === 0,
    JSON.stringify(first))
  for (const e of manifest.skills) {
    const dest = path.join(payload.hermesDir, e.id, 'SKILL.md')
    check(`「${e.id}」落到 Hermes 技能目录`, fs.existsSync(dest), dest)
    check(`「${e.id}」落位内容与真源一致`,
      fs.existsSync(dest) && fs.readFileSync(dest, 'utf-8') === fs.readFileSync(path.join(skillsDir, e.id, 'SKILL.md'), 'utf-8'))
  }
  const installedManifest = JSON.parse(fs.readFileSync(path.join(payload.hermesDir, '.fangcun-installed.json'), 'utf-8'))
  check('安装后写入 .fangcun-installed.json（记 hash 才能判断过时）',
    Object.keys(installedManifest).length === manifest.skills.length, JSON.stringify(Object.keys(installedManifest)))

  const second = skillsMod.installSkills()
  check('★ 再装一次：全部跳过（幂等，hash 一致）',
    second.installed.length === 0 && second.skipped.length === manifest.skills.length, JSON.stringify(second))

  const statusAfter = skillsMod.checkSkillsStatus()
  check('装完之后 checkSkillsStatus 说不需要装', statusAfter.needsInstall === false, JSON.stringify(statusAfter))
  check('状态里每条都 installed 且非 outdated',
    statusAfter.skills.every(s => s.installed && !s.outdated), JSON.stringify(statusAfter.skills))

  // 模拟「用户手上那份被改脏了」→ 必须能识别并重装
  const victim = manifest.skills[0].id
  const victimDest = path.join(payload.hermesDir, victim, 'SKILL.md')
  fs.writeFileSync(victimDest, '---\nname: 被改坏的\n---\n', 'utf-8')
  const third = skillsMod.installSkills()
  check('★ 已被改动的那份会被重装（不是"已存在就永远跳过"）',
    third.installed.includes(victim), JSON.stringify(third))
  check('重装后内容恢复成真源',
    fs.readFileSync(victimDest, 'utf-8') === fs.readFileSync(path.join(skillsDir, victim, 'SKILL.md'), 'utf-8'))

  // 装了之后再查面板：installed=true
  const payload2 = skillsMod.listSkillsForUi()
  check('装完后面板显示已装（installed=true）',
    payload2.skills.every(s => s.installed === true), JSON.stringify(payload2.skills.map(s => [s.id, s.installed])))

  // ── 4. 打开目录（走真 shell.openPath 桩）─────────────────────────
  electronStub.shell.opened.length = 0
  const openRes = await skillsMod.openSkillsDir('resources')
  check('★ openSkillsDir("resources") 走 shell.openPath', openRes.ok === true && electronStub.shell.opened.length === 1,
    JSON.stringify({ res: openRes, opened: electronStub.shell.opened }))
  check('打开的是技能真源目录', path.resolve(electronStub.shell.opened[0] || '') === path.resolve(skillsDir))

  const openHermes = await skillsMod.openSkillsDir('hermes')
  check('openSkillsDir("hermes") 打开 Hermes 侧目录并落在沙盒里',
    openHermes.ok === true && path.resolve(openHermes.dir).startsWith(path.resolve(TEST_ROOT)),
    JSON.stringify(openHermes))

  electronStub.shell.failNext = '被拒绝'
  const openFail = await skillsMod.openSkillsDir('resources')
  check('★ 打开失败要返回原因（不是静默 ok）', openFail.ok === false && !!openFail.error, JSON.stringify(openFail))

  // ── 5. 「📂 显示 SKILL.md」的路径裁决（resolveRevealTarget）──────────────
  // 2026-09-28 用户实测报障：「安装方寸技能会显示路径问题，导致错误」。
  // 真因（在 userData/logs 的当日日志里，4 条 `路径不在技能目录内`）：
  // 白名单只放行 Hermes 侧，而技能页那张卡传的是**方寸真源**的路径
  // （`skills/<id>/SKILL.md`）→ 按钮在自发布技能上 100% 失败。
  // 而那个按钮的用户故事恰恰是"装到 WorkBuddy 这类只能手动导入的 agent"——
  // 要拖进对方导入面板的就是真源这一份。
  const hermesDir = skillsMod.getHermesSkillsDirPath()

  const rSrc = skillsMod.resolveRevealTarget(path.join(skillsDir, 'fangcun-hermes-bridge', 'SKILL.md'))
  check('★ 真源 SKILL.md 允许显示（此前必定失败 —— 用户报的「路径问题」）',
    rSrc.ok === true && rSrc.skillMd === path.join(skillsDir, 'fangcun-hermes-bridge', 'SKILL.md'),
    JSON.stringify(rSrc))
  check('  真源那条的提示里写明是「方寸真源」', /方寸真源/.test(String(rSrc.message)), String(rSrc.message))

  const rDir = skillsMod.resolveRevealTarget(path.join(skillsDir, 'skill-management-policy'))
  check('  传目录时自动补成 <目录>/SKILL.md',
    rDir.ok === true && path.basename(String(rDir.skillMd)) === 'SKILL.md', JSON.stringify(rDir))

  const rHermes = skillsMod.resolveRevealTarget(path.join(hermesDir, 'fangcun-hermes-bridge', 'SKILL.md'))
  check('★ Hermes 侧副本仍允许显示（原有行为不能被修坏）', rHermes.ok === true, JSON.stringify(rHermes))
  check('  Hermes 那条的提示里写明是「Hermes 侧副本」', /Hermes 侧副本/.test(String(rHermes.message)), String(rHermes.message))

  const rOut = skillsMod.resolveRevealTarget('C:/Windows/System32/drivers/etc/hosts')
  check('★ 技能目录之外的任意路径一律拒绝（白名单没被放宽成"什么都能开"）',
    rOut.ok === false && /路径不在技能目录内/.test(String(rOut.message)), JSON.stringify(rOut))
  const rEmpty = skillsMod.resolveRevealTarget('')
  check('  空路径给明确原因而不是崩/静默', rEmpty.ok === false && !!rEmpty.message, JSON.stringify(rEmpty))
  // ⚠ 前缀攻击：`startsWith(root)` 不带 path.sep 时 `<root>-evil` 会被放行。
  // 这一条**必须把文件真造出来**，否则拒绝会由"找不到文件"顺手兜住 —— 断言看着绿，
  // 实际没测到白名单（首版就是这么写的，去掉 path.sep 做反例时它照样绿，才发现是空断言）。
  const evilDir = path.dirname(hermesDir) + path.sep + 'skills-evil'
  fs.mkdirSync(evilDir, { recursive: true })
  const evilMd = path.join(evilDir, 'SKILL.md')
  fs.writeFileSync(evilMd, '---\nname: evil\ndescription: 兄弟目录，不该被放行\n---\n', 'utf-8')
  const rEvil = skillsMod.resolveRevealTarget(evilMd)
  check('★ 兄弟目录「skills-evil」（真实存在）不能蒙混过关 —— 前缀判定必须带分隔符',
    rEvil.ok === false && /路径不在技能目录内/.test(String(rEvil.message)), JSON.stringify(rEvil))
  const rNoFile = skillsMod.resolveRevealTarget(path.join(skillsDir, '不存在的技能', 'SKILL.md'))
  check('  目录内但文件不存在 → 明确说找不到，不是假 ok',
    rNoFile.ok === false && /找不到 SKILL.md/.test(String(rNoFile.message)), JSON.stringify(rNoFile))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log('FAIL  测试自身异常:', (e && e.stack) || e)
  console.log('RESULT 0 / 1')
  process.exit(1)
})
