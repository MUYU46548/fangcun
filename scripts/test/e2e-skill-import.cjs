/**
 * 技能「直接导入」（2026-09-26 卡 005）
 *
 * 用户给的参照是 WorkBuddy 的导入面板，原话：
 *   「拖拽文件或点击上传 / 文件要求：文件夹或者 .zip 需要包含 SKILL.md 文件；
 *     .md 文件需包含 YAML 格式的技能名称和描述」
 *
 * 本测试钉住的不是"能导入"，而是四类**会真出事**的边界：
 *   ① 三种输入（目录 / zip / 单个 .md）都能装成 `<name>/SKILL.md` 的正确形状；
 *   ② 真实世界的 zip 两种花样都要吃下 —— 带**目录条目**的（资源管理器打的包）与
 *      deflate 压缩的（Compress-Archive 默认）。（旧解压器会对 `xxx/` 直接写文件 → 直接失败）
 *   ③ 失败**必须零写入**：没有 SKILL.md / YAML 头缺 name·description / 路径穿越，
 *      都不许在技能目录里留下半个目录；
 *   ④ 安全闸门：自发布技能不许被外部覆盖、不许被"移除"；没有导入标记的目录一律不删。
 *
 * ⚠ 安全性：getHermesSkillsDir() 读 LOCALAPPDATA，本测试先把它指向临时沙盒，
 *   否则会往**用户真实的 ~/.hermes/skills** 里写东西。
 *
 * 运行：node scripts/test/e2e-skill-import.cjs
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

const TEST_ROOT = path.join(os.tmpdir(), 'fc-skill-import-' + Date.now())
process.env.FC_TEST_USERDATA = TEST_ROOT
process.env.LOCALAPPDATA = path.join(TEST_ROOT, 'localappdata')

const { makeZip } = require('./zip-fixture.cjs')

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
const HERMES_SKILLS = path.join(TEST_ROOT, 'localappdata', 'hermes', 'skills')
const FIX = path.join(TEST_ROOT, 'fixtures')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
}

/** 技能目录里当前的子目录名（用来断言"失败 = 零写入"） */
function dirsNow() {
  try {
    return fs.readdirSync(HERMES_SKILLS, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name).sort()
  } catch { return [] }
}

const SKILL_MD = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\nversion: 1.2.3\n---\n\n# ${name}\n\n正文内容。\n`

function writeFixture(rel, content) {
  const p = path.join(FIX, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

async function main() {
  console.log('== 技能直接导入测试 ==')
  console.log('sandbox:', TEST_ROOT)
  fs.mkdirSync(FIX, { recursive: true })

  const imp = require(path.join(DIST, 'services', 'skillImport.js'))
  const installer = require(path.join(DIST, 'services', 'skillInstaller.js'))
  const stub = require(STUB)

  check('★ 技能目录落在测试沙盒里（没碰用户真实 ~/.hermes）',
    path.resolve(installer.getHermesSkillsDirPath()).startsWith(path.resolve(TEST_ROOT)),
    installer.getHermesSkillsDirPath())

  // ── A. 目录导入 ────────────────────────────────────────────────────
  const dirSkill = path.join(FIX, 'demo-dir')
  fs.mkdirSync(path.join(dirSkill, 'references'), { recursive: true })
  fs.writeFileSync(path.join(dirSkill, 'SKILL.md'), SKILL_MD('demo-dir', '从文件夹导入的示例技能'))
  fs.writeFileSync(path.join(dirSkill, 'references', 'api.md'), '# API 参考\n')

  const before = dirsNow()
  const rA = imp.importSkillFromPath(dirSkill)
  check('★ 目录导入成功', rA.ok === true, JSON.stringify(rA))
  check('导入后技能名取自 SKILL.md 的 YAML name', rA.name === 'demo-dir', String(rA.name))
  check('落位到 <hermes技能目录>/<name>/', rA.target === path.join(HERMES_SKILLS, 'demo-dir'), String(rA.target))
  check('SKILL.md 落位', fs.existsSync(path.join(HERMES_SKILLS, 'demo-dir', 'SKILL.md')))
  check('★ 子目录一并带过来（references/api.md）', fs.existsSync(path.join(HERMES_SKILLS, 'demo-dir', 'references', 'api.md')))
  check('写入导入标记 .fangcun-imported.json', fs.existsSync(path.join(HERMES_SKILLS, 'demo-dir', imp.IMPORT_MARKER)))
  check('标记里记了来源路径', JSON.parse(fs.readFileSync(path.join(HERMES_SKILLS, 'demo-dir', imp.IMPORT_MARKER), 'utf-8')).source === dirSkill)
  check('★ 不写进 skills/manifest.json（外部技能不进方寸的账本）',
    !fs.existsSync(path.join(path.resolve(__dirname, '../..'), 'skills', 'manifest.json')) ||
    !JSON.parse(fs.readFileSync(path.join(path.resolve(__dirname, '../..'), 'skills', 'manifest.json'), 'utf-8')).skills
      .some(s => s.id === 'demo-dir'))

  const listed = imp.listImportedSkills()
  check('listImportedSkills 列出刚导入的技能', listed.some(x => x.name === 'demo-dir'), JSON.stringify(listed.map(x => x.name)))
  check('列表带 description（读自 SKILL.md）', listed.find(x => x.name === 'demo-dir')?.description === '从文件夹导入的示例技能')
  check('列表带文件数与体积', (listed.find(x => x.name === 'demo-dir')?.files || 0) >= 2)

  // ── B. zip：带目录条目 + deflate（真实世界的包）────────────────────
  const zipBuf = makeZip([
    { name: 'demo-zip/', dir: true },
    { name: 'demo-zip/SKILL.md', content: SKILL_MD('demo-zip', '从 zip 导入的示例技能'), compress: true },
    { name: 'demo-zip/assets/', dir: true },
    { name: 'demo-zip/assets/note.txt', content: 'x'.repeat(2000), compress: true },
  ])
  const zipPath = writeFixture('demo.zip', zipBuf)
  const rB = imp.importSkillFromPath(zipPath)
  check('★ zip 导入成功（含目录条目 + deflate 压缩）', rB.ok === true, JSON.stringify(rB))
  check('zip 里的 SKILL.md 落位', fs.existsSync(path.join(HERMES_SKILLS, 'demo-zip', 'SKILL.md')))
  check('zip 里的压缩文件解压后内容完整',
    fs.readFileSync(path.join(HERMES_SKILLS, 'demo-zip', 'assets', 'note.txt'), 'utf-8').length === 2000)

  // ── C. zip：一层外壳目录 ───────────────────────────────────────────
  const nestedZip = writeFixture('nested.zip', makeZip([
    { name: 'my-skill-pack/SKILL.md', content: SKILL_MD('nested-skill', '包了一层外壳目录的技能') },
    { name: 'my-skill-pack/README.md', content: '# hi' },
  ]))
  const rC = imp.importSkillFromPath(nestedZip)
  check('★ 一层外壳目录的 zip 也能导入', rC.ok === true && rC.name === 'nested-skill', JSON.stringify(rC))

  // ── D~K. 失败必须零写入 ────────────────────────────────────────────
  // ⚠ 快照必须取在**所有成功导入之后**（含下面那个单 .md 成功案例）——
  //   否则成功导入出来的目录会被算成"失败泄漏"（本测试第一版就这样冤枉过自己一次）

  const noSkillZip = writeFixture('no-skillmd.zip', makeZip([
    { name: 'whatever/readme.txt', content: 'no skill here' },
  ]))
  const rD = imp.importSkillFromPath(noSkillZip)
  check('★ 没有 SKILL.md 的 zip 被拒（code=invalid）', rD.ok === false && rD.code === 'invalid', JSON.stringify(rD))
  check('  拒绝原因说清了"包里没有 SKILL.md"', String(rD.error || '').includes('SKILL.md'), String(rD.error))

  const badMd = writeFixture('bad.md', '# 只是一个普通 md\n\n没有 YAML 头。\n')
  const rE = imp.importSkillFromPath(badMd)
  check('★ 没有 YAML 头的 .md 被拒（这是用户给的判据）', rE.ok === false && rE.code === 'invalid', JSON.stringify(rE))
  check('  拒绝原因提到 name / description', /name/.test(String(rE.error)) && /description/.test(String(rE.error)), String(rE.error))

  const halfMd = writeFixture('half.md', '---\nname: only-name\n---\n\n只有 name 没有 description。\n')
  const rE2 = imp.importSkillFromPath(halfMd)
  check('只写了 name 没写 description 也被拒', rE2.ok === false && rE2.code === 'invalid', JSON.stringify(rE2))

  const goodMd = writeFixture('single.md', SKILL_MD('md-only-skill', '单个 md 文件导进来的技能'))
  const rF = imp.importSkillFromPath(goodMd)
  check('★ 单个 .md 能导入', rF.ok === true && rF.name === 'md-only-skill', JSON.stringify(rF))
  check('  单文件导入后形状是 <name>/SKILL.md（不是裸 md 丢进目录）',
    fs.existsSync(path.join(HERMES_SKILLS, 'md-only-skill', 'SKILL.md')))

  const snapshot = dirsNow()   // ← 成功导入之后的基线

  const slipZip = writeFixture('slip.zip', makeZip([
    { name: 'evil-skill/SKILL.md', content: SKILL_MD('evil-skill', '试图穿越目录') },
    { name: 'evil-skill/../../evil.txt', content: 'pwned' },
  ]))
  const rG = imp.importSkillFromPath(slipZip)
  check('★ 含 `../` 条目的 zip 被拒（zip slip）', rG.ok === false && rG.code === 'invalid', JSON.stringify(rG))
  check('★ 穿越目标没有被写出来（沙盒根、技能目录上一级都没有 evil.txt）',
    !fs.existsSync(path.join(TEST_ROOT, 'evil.txt')) &&
    !fs.existsSync(path.join(HERMES_SKILLS, '..', 'evil.txt')) &&
    !fs.existsSync(path.join(HERMES_SKILLS, 'evil-skill')))
  check('  拒绝原因提到路径非法', /非法/.test(String(rG.error)), String(rG.error))

  const rK = imp.importSkillFromPath(path.join(FIX, '不存在的包.zip'))
  check('不存在的路径 → code=not-found', rK.ok === false && rK.code === 'not-found', JSON.stringify(rK))

  const txtPath = writeFixture('notes.txt', 'just text')
  const rK2 = imp.importSkillFromPath(txtPath)
  check('不认的扩展名被拒（只说清"只认三种输入"）', rK2.ok === false && /只认/.test(String(rK2.error)), JSON.stringify(rK2))

  // 文件数超限（防 zip 炸弹的一侧）
  const many = [{ name: 'many-files/SKILL.md', content: SKILL_MD('many-files', '文件数超限的包') }]
  for (let i = 0; i < 510; i++) many.push({ name: `many-files/f${i}.txt`, content: 'x' })
  const rJ = imp.importSkillFromPath(writeFixture('many.zip', makeZip(many)))
  check('★ 文件数超上限被拒（code=too-many）', rJ.ok === false && rJ.code === 'too-many', JSON.stringify(rJ))

  const afterFails = dirsNow()
  const leaked = afterFails.filter(d => !snapshot.includes(d))
  check('★★ 上面所有失败加起来 = 零写入（技能目录里没多出任何目录）', leaked.length === 0, JSON.stringify(leaked))

  // ── H. 重名：先拒，overwrite 才覆盖 ───────────────────────────────
  const dupDir = path.join(FIX, 'demo-dir-v2')
  fs.mkdirSync(dupDir, { recursive: true })
  fs.writeFileSync(path.join(dupDir, 'SKILL.md'), SKILL_MD('demo-dir', '第二版技能描述'))
  fs.writeFileSync(path.join(dupDir, 'V2.txt'), 'v2')
  const rH1 = imp.importSkillFromPath(dupDir)
  check('★ 重名默认被拒（code=exists，交给界面问用户）', rH1.ok === false && rH1.code === 'exists', JSON.stringify(rH1))
  check('  拒绝时不做任何改动（旧 SKILL.md 还是第一版）',
    fs.readFileSync(path.join(HERMES_SKILLS, 'demo-dir', 'SKILL.md'), 'utf-8').includes('从文件夹导入的示例技能'))
  const rH2 = imp.importSkillFromPath(dupDir, { overwrite: true })
  check('★ overwrite=true 才覆盖', rH2.ok === true, JSON.stringify(rH2))
  check('  覆盖后内容是第二版', fs.readFileSync(path.join(HERMES_SKILLS, 'demo-dir', 'SKILL.md'), 'utf-8').includes('第二版技能描述'))
  check('  覆盖后 V2.txt 在（整目录替换，不是合并残留）', fs.existsSync(path.join(HERMES_SKILLS, 'demo-dir', 'V2.txt')))
  check('★ 覆盖不留半成品目录（没有 .fangcun-incoming-* / .fangcun-old-* 残渣）',
    !fs.readdirSync(HERMES_SKILLS).some(n => n.startsWith('.fangcun-incoming-') || n.startsWith('.fangcun-old-')))

  // ── I. 自发布技能不许被外部覆盖 ────────────────────────────────────
  const published = [...installer.getPublishedSkillIds()]
  check('getPublishedSkillIds 至少认得一个自发布技能', published.length > 0, JSON.stringify(published))
  const resDir = path.join(FIX, 'reserved')
  fs.mkdirSync(resDir, { recursive: true })
  fs.writeFileSync(path.join(resDir, 'SKILL.md'), SKILL_MD(published[0], '企图覆盖方寸自发布技能'))
  const rI = imp.importSkillFromPath(resDir, { overwrite: true })
  check('★ 与自发布技能同名 → 拒（code=reserved，即使 overwrite=true）',
    rI.ok === false && rI.code === 'reserved', JSON.stringify(rI))

  // ── L. 移除的安全闸门 ─────────────────────────────────────────────
  check('★ 移除外部导入的技能成功', imp.removeImportedSkill('md-only-skill').ok === true)
  check('移除后目录消失', !fs.existsSync(path.join(HERMES_SKILLS, 'md-only-skill')))

  // 造一个"没有导入标记"的目录（模拟别的 agent 手动放的技能）→ 绝不许删
  const manual = path.join(HERMES_SKILLS, 'manually-installed')
  fs.mkdirSync(manual, { recursive: true })
  fs.writeFileSync(path.join(manual, 'SKILL.md'), SKILL_MD('manually-installed', '手动放的'))
  const rL1 = imp.removeImportedSkill('manually-installed')
  check('★ 没有导入标记的目录拒绝移除（别人的技能不能被误删）',
    rL1.ok === false && /标记/.test(String(rL1.error)), JSON.stringify(rL1))
  check('  拒绝后目录还在', fs.existsSync(manual))

  const rL2 = imp.removeImportedSkill(published[0])
  check('★ 自发布技能拒绝移除', rL2.ok === false && /自发布/.test(String(rL2.error)), JSON.stringify(rL2))

  const rL3 = imp.removeImportedSkill('../escape')
  check('名字带穿越的移除请求被拒', rL3.ok === false, JSON.stringify(rL3))

  // ── M. 选包入口（dialog 桩）────────────────────────────────────────
  stub.dialog.calls.length = 0
  stub.dialog.next = { canceled: false, filePaths: [zipPath] }
  const picked = await imp.pickSkillFile()
  check('★ pickSkillFile 走 dialog 并回传路径', picked.ok === true && picked.path === zipPath, JSON.stringify(picked))
  check('  选文件时限定 zip/md 过滤器', JSON.stringify(stub.dialog.calls[0]?.filters || []).includes('zip'), JSON.stringify(stub.dialog.calls[0]?.filters))
  const picked2 = await imp.pickSkillFile()
  check('用户取消 → canceled=true（不是报错）', picked2.ok === false && picked2.canceled === true, JSON.stringify(picked2))
  stub.dialog.next = { canceled: false, filePaths: [dirSkill] }
  const pickedFolder = await imp.pickSkillFolder()
  check('★ pickSkillFolder 用 openDirectory（Windows 上不能与 openFile 同时用）',
    pickedFolder.ok === true && JSON.stringify(stub.dialog.calls[2]?.properties || []).includes('openDirectory'),
    JSON.stringify(stub.dialog.calls[2]?.properties))

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
