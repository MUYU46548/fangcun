/**
 * 「装到别的 agent」目标检测 + 多目标技能安装（2026-10-03 卡 task-20261003-011 / 010）
 *
 * 用户原话：「**DSH 在上一轮已经完成安装，但方寸检测不到 DSH 安装了**。」
 * 真因：`agents.ts` 的目标清单里**根本没有 DSH 这一条**（小尾巴⑩「装卡区加 DSH 第四探测目标」
 * 一直没开工）—— 技能页「装到别的 agent」里自然看不见它。
 *
 * 本测试钉住：
 *   ① 目标清单里有 DSH，且落点/可直装口径与 Hermes 同级（都是实测过的目录）；
 *   ② 「已接入」两问 = 技能副本 + MCP 配置含 fangcun，纯文件探测，落点不可知时给 undefined 而不是 false；
 *   ③ 多目标安装：装到 DSH 真落在 DSH 技能目录、幂等、未知目标显式报错；
 *   ④ **不许往猜出来的目录写**：DSH 不在场（没有 ~/.dsh）时自动安装不得给它造目录。
 *
 * ⚠ 隔离：`FC_DSH_HOME` 与 `LOCALAPPDATA` 都指向临时目录 —— 否则这一步会写进
 *   **用户真实的 ~/.dsh/skills 与 %LOCALAPPDATA%/hermes/skills**。
 *
 * 运行：node scripts/test/e2e-agent-targets.cjs
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

const TEST_ROOT = path.join(os.tmpdir(), 'fc-agents-' + Date.now())
const DSH_HOME = path.join(TEST_ROOT, 'dsh')
const LOCAL = path.join(TEST_ROOT, 'localappdata')
process.env.FC_TEST_USERDATA = TEST_ROOT
process.env.FC_DSH_HOME = DSH_HOME
process.env.LOCALAPPDATA = LOCAL

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

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ } }

/** 造出「装了 DSH」的现场：profiles/<档>/cordis.patch.yml（含 fangcun 段） */
function fakeDsh(withFangcun = true) {
  fs.mkdirSync(path.join(DSH_HOME, 'profiles', 'desktop'), { recursive: true })
  const body = [
    '- id: ui-settings',
    '  name: "@deepseek-ai/dsh-client-ui-settings"',
    '  config:',
    '    enabled: true',
    ...(withFangcun ? [
      '- insert:',
      '    - id: mcp-fangcun',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        serverName: fangcun',
      '        transport: stdio',
      '        command: node',
      '        args: ["/x/tegula-mcp.js"]',
    ] : []),
  ].join('\n')
  fs.writeFileSync(path.join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'), body, 'utf-8')
}

async function main() {
  console.log('== 装卡区目标检测 / 多目标安装测试 ==')
  console.log('sandbox:', TEST_ROOT)

  const agents = require(path.join(DIST, 'services', 'agents.js'))
  const skillsMod = require(path.join(DIST, 'services', 'skillInstaller.js'))
  const hermesSkillsDir = skillsMod.getHermesSkillsDirPath()

  // ── 场景 A：装了 DSH（含 fangcun 配置），但**没装**方寸技能副本 ──────────
  rmrf(DSH_HOME)
  fakeDsh(true)

  let targets = agents.detectAgentTargets(hermesSkillsDir)
  const ids = targets.map(t => t.id)
  check('★ 目标清单里有 DSH（此前根本没有这一条 —— 用户「检测不到」的真因）', ids.includes('dsh'), JSON.stringify(ids))

  const dsh = targets.find(t => t.id === 'dsh')
  check('DSH 是对外可直装目标（落点已知，与 Hermes 同级）', dsh && dsh.mode === 'installable', JSON.stringify(dsh))
  check('★ DSH 技能落点 = <dsh home>/skills（FC_DSH_HOME 重定向生效）',
    dsh && path.resolve(dsh.skillsDir) === path.resolve(path.join(DSH_HOME, 'skills')), dsh && dsh.skillsDir)
  check('★ DSH 被检测到（profiles/desktop/cordis.patch.yml 在）', dsh && dsh.detected === true, dsh && dsh.evidence)
  check('  DSH 的 evidence 指向那份配置文件', dsh && /cordis\.patch\.yml$/.test(String(dsh.evidence)), dsh && dsh.evidence)

  check('★ DSH 已接入里「MCP 配置含 fangcun」为真（读了配置原文）', dsh && dsh.mcpLinked === true, JSON.stringify(dsh && dsh.mcpLinked))
  check('★ DSH 已接入里「技能副本已装」为假（还没装）', dsh && dsh.skillLinked === false, JSON.stringify(dsh && dsh.skillLinked))
  check('  linkDetail 把人话事实写出来', dsh && /技能副本未装/.test(String(dsh.linkDetail)) && /MCP 配置含 fangcun/.test(String(dsh.linkDetail)),
    dsh && dsh.linkDetail)

  // Hermes：可直装 + 落点 = LOCALAPPDATA/hermes/skills
  const h = targets.find(t => t.id === 'hermes')
  check('Hermes 仍是可直装目标，落点落在测试沙盒里（没碰用户真实目录）',
    h && h.mode === 'installable' && path.resolve(h.skillsDir).startsWith(path.resolve(TEST_ROOT)), h && h.skillsDir)

  // WorkBuddy：落点不可知 → 两个事实都必须是 undefined（不是 false！）
  const wb = targets.find(t => t.id === 'workbuddy')
  if (wb) {
    check('★ 落点不可知的目标（WorkBuddy）不给假结论：skillLinked/mcpLinked 都是 undefined',
      wb.skillLinked === undefined && wb.mcpLinked === undefined, JSON.stringify({ s: wb.skillLinked, m: wb.mcpLinked }))
    check('  不可知的 linkDetail 明说"不猜"', /不可知/.test(String(wb.linkDetail)), wb.linkDetail)
  }

  // ── 场景 B：装上技能副本 → skillLinked 变真 ──────────────────────────
  const inst = skillsMod.installSkillsTo('dsh')
  check('★ 装到 DSH：两个技能都落到 DSH 技能目录', inst.installed.length === 2 && inst.errors.length === 0, JSON.stringify(inst))
  const dshSkill = path.join(DSH_HOME, 'skills', 'fangcun-bridge', 'SKILL.md')
  check('  DSH 侧副本真实存在且内容与真源一致',
    fs.existsSync(dshSkill) &&
    fs.readFileSync(dshSkill, 'utf-8') === fs.readFileSync(path.join(REPO, 'skills', 'fangcun-bridge', 'SKILL.md'), 'utf-8'),
    dshSkill)
  check('★ 装到 DSH 没碰 Hermes 侧目录（各目标分账）',
    !fs.existsSync(path.join(LOCAL, 'hermes', 'skills', 'fangcun-bridge', 'SKILL.md')),
    path.join(LOCAL, 'hermes', 'skills'))

  const dshNow = agents.detectAgentTargets(hermesSkillsDir).find(t => t.id === 'dsh')
  check('★ 装完之后 DSH 的「技能副本已装」变真（徽章会显示 已接入）',
    dshNow && dshNow.skillLinked === true, JSON.stringify(dshNow && dshNow.skillLinked))

  // 幂等
  const inst2 = skillsMod.installSkillsTo('dsh')
  check('  再装一次：全部跳过（幂等）', inst2.installed.length === 0 && inst2.skipped.length === 2, JSON.stringify(inst2))

  // 未知目标 → 显式报错，不静默当 Hermes
  const bad = skillsMod.installSkillsTo('nope')
  check('★ 未知安装目标 → 显式 errors（不静默落到 Hermes）',
    bad.errors.length === 1 && /未知安装目标/.test(bad.errors[0].error), JSON.stringify(bad))

  // ── 场景 C：反例 —— 没有 DSH 就不该被检测到、更不该被写 ────────────────
  rmrf(DSH_HOME)
  const noDsh = agents.detectAgentTargets(hermesSkillsDir).find(t => t.id === 'dsh')
  check('★ 反例：没有 ~/.dsh 时 DSH detected=false（不是照列"已检测到"）',
    noDsh && noDsh.detected === false, JSON.stringify(noDsh && noDsh.detected))

  skillsMod.autoCheckSkills()
  check('★ 反例：DSH 不在场时自动安装**不**给它造目录（不许往猜出来的目录写）',
    !fs.existsSync(path.join(DSH_HOME, 'skills')), path.join(DSH_HOME, 'skills'))

  // ── 场景 D：面板数据源带上多目标状态 ────────────────────────────────
  fakeDsh(true)
  skillsMod.installSkillsTo('dsh')
  const payload = skillsMod.listSkillsForUi()
  check('listSkillsForUi 带 targets 数组', Array.isArray(payload.targets) && payload.targets.length >= 2,
    JSON.stringify((payload.targets || []).map(t => t.id)))
  const tDsh = (payload.targets || []).find(t => t.id === 'dsh')
  check('★ 面板里 DSH 目标 present=true（本机装了）且逐技能 installed=true',
    tDsh && tDsh.present === true && tDsh.skills.every(s => s.installed === true), JSON.stringify(tDsh))
  const tHermes = (payload.targets || []).find(t => t.id === 'hermes')
  check('  面板里 Hermes 目标落点在沙盒内',
    tHermes && path.resolve(tHermes.dir).startsWith(path.resolve(TEST_ROOT)), tHermes && tHermes.dir)

  // ── 场景 E：resolveRevealTarget 放行 DSH 侧副本，兄弟目录仍拒绝 ────────
  const rDsh = skillsMod.resolveRevealTarget(dshSkill)
  check('★ DSH 侧副本允许「显示 SKILL.md」（新目标没被白名单漏掉）',
    rDsh.ok === true && /DSH 侧副本/.test(String(rDsh.message)), JSON.stringify(rDsh))
  const evil = path.dirname(path.resolve(DSH_HOME, 'skills')) + path.sep + 'skills-evil'
  fs.mkdirSync(evil, { recursive: true })
  fs.writeFileSync(path.join(evil, 'SKILL.md'), '---\nname: evil\n---\n', 'utf-8')
  const rEvil = skillsMod.resolveRevealTarget(path.join(evil, 'SKILL.md'))
  check('  兄弟目录（skills-evil）即使真存在也不能蒙混过关', rEvil.ok === false, JSON.stringify(rEvil))

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
