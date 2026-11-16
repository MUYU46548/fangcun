/**
 * 骨架发现 · 守卫（2026-11-16 · 骨架继承试点第一批）
 *
 * 修的 bug（2026-11-15 深夜实测）：方寸当时只认 `README.md` / `ROADMAP.md`，
 * 而司天的骨架**一份都不在那两份里**：
 *
 * | 文件 | 字数 | 旧清单读得到吗 |
 * |---|---:|---|
 * | `README.md` | 22,461 | ✅ **唯一读得到的** |
 * | `AGENTS.md` | **87,773** | ❌ 项目的宪法 |
 * | `docs/guides/…/06-司天-中长期施工计划-v1.2.md` | 21,071 | ❌ 写着"此后以本文为唯一现行总纲" |
 * | `docs/plan/PLAN_20261109_3MONTH.md` | 35,528 | ❌ |
 * | Hermes skill `obsidian/sitian-development` | 17,476 | ❌ **在仓库外** |
 * | `ROADMAP.md` | — | **不存在** |
 *
 * 暮雨的两条判断必须被断言钉住：
 *  ① 「README 本来就是不读都无所谓的东西（正规也不该放过多技术细节，只做面向用户的说明书）」
 *     → 所以骨架**不是** README 的补充；`ok` 不许只看 README/ROADMAP。
 *  ② 「只读提交标题更是残废」→ 读的是**正文**（excerpt / more），不是 diff 标题。
 *
 * 跑法：node scripts/test/e2e-skeleton-docs.cjs（需先 cd desktop && npm run build）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-skel-'))
const DATA = path.join(TMP, 'data')
process.env.FC_TEST_USERDATA = path.join(TMP, 'userdata')
fs.mkdirSync(path.join(DATA, 'task-data'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'registry.yaml'), 'projects: []\n', 'utf-8')

// 主进程代码 require('electron') —— 纯 Node 下必须桩掉（本仓既有做法，见 e2e-app-mode）
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
  return origResolve.call(this, request, ...rest)
}

const data = require(path.join(DIST, 'data', 'index.js'))
data.setDataDir(DATA)

const MOD = path.join(DIST, 'services', 'repoDocs.js')
if (!fs.existsSync(MOD)) {
  console.error('FAIL  找不到 dist/main/services/repoDocs.js —— 请先 cd desktop && npm run build')
  process.exit(1)
}
const rd = require(MOD)

function writeFile(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s, 'utf-8')
}

async function main() {
  // ══ 一、骨架发现：五类位置逐条 ══
  console.log('=== 一、骨架发现（旧清单一份都读不到那五种文件） ===')
  const repo = fs.mkdtempSync(path.join(TMP, 'repo-'))
  writeFile(path.join(repo, 'README.md'), '# 演示项目\n\n对外说明，一句话。\n')
  writeFile(path.join(repo, 'AGENTS.md'),
    '# 演示项目宪法\n\n## 硬规矩\n\n1. 不许提交密钥\n2. 改解析必跑 verify\n')
  writeFile(path.join(repo, 'docs', 'plan', 'PLAN_20261109.md'),
    '# 三个月方案\n\n这是现行总纲，此后不再新开散件。\n')
  writeFile(path.join(repo, 'docs', 'plan', 'HANDOFF.md'), '# 接力单\n\n下一步从这里开始。\n')
  writeFile(path.join(repo, 'docs', 'guides', '20261023', '00-开发指南.md'),
    '# 开发指南\n\n九条施工铁律。\n')
  writeFile(path.join(repo, 'src', 'ledger', 'README.md'),
    '# 账本模块\n\n这个模块自己怎么用。\n')
  // 不该被当成骨架的
  writeFile(path.join(repo, 'node_modules', 'x', 'AGENTS.md'), '# 依赖里的，不许捞上来\n')

  const sk = rd.discoverSkeleton(repo, [])
  const byRel = new Map(sk.files.map((f) => [f.rel, f]))

  check('★ 读到 AGENTS.md（旧清单读不到的宪法）', byRel.has('AGENTS.md'), [...byRel.keys()].join(','))
  check('★ AGENTS.md 归「宪法」且排在最前（优先级：宪法 > 规划 > 技能 > 模块说明）',
    sk.files[0] && sk.files[0].kind === '宪法', sk.files[0] && sk.files[0].kind)
  check('★ 读到 docs/plan/*.md（两份）',
    byRel.has('docs/plan/PLAN_20261109.md') && byRel.has('docs/plan/HANDOFF.md'),
    [...byRel.keys()].join(','))
  check('★ 读到 docs/guides/<日期>/x.md（只再进一层，不深扫一年散件）',
    byRel.has('docs/guides/20261023/00-开发指南.md'), [...byRel.keys()].join(','))
  check('★ 读到模块级 src/ledger/README.md，归「模块说明」且排最后',
    byRel.get('src/ledger/README.md') && byRel.get('src/ledger/README.md').kind === '模块说明')
  check('★ node_modules 里的 AGENTS.md 不许被捞上来',
    ![...byRel.keys()].some((r) => r.includes('node_modules')), [...byRel.keys()].join(','))

  // ② 「只读提交标题是残废」—— 必须给正文，不只是路径
  const agents = byRel.get('AGENTS.md')
  check('★ 读到的是**正文**（excerpt 里有真内容），不是只有路径',
    agents && /不许提交密钥|改解析必跑/.test(agents.excerpt || agents.more || ''),
    agents && JSON.stringify(agents.excerpt))
  check('★ 给了 title（一级标题）', agents && agents.title.includes('宪法'), agents && agents.title)
  check('★ 给了 mtime + bytes（判断"多久没更新了"要靠它们）',
    agents && agents.bytes > 0 && !!agents.mtime)

  // 反例自证：把 AGENTS.md 改名成别的东西 → 必须 missing，不是静默返回空
  const repo2 = fs.mkdtempSync(path.join(TMP, 'repo2-'))
  writeFile(path.join(repo2, 'README.md'), '# 只有 README\n\n说明。\n')
  const sk2 = rd.discoverSkeleton(repo2, [])
  check('★ 反例：只有 README 的仓库，宪法那项必须进 missing（说明"这些位置都没有"）',
    sk2.missing.some((m) => /AGENTS\.md/.test(m.pattern)), JSON.stringify(sk2.missing))
  check('★ 反例：一份骨架都没有时，note 必须说「不是这个项目没有骨架，是这些位置都没有」',
    sk2.files.length === 0 && /不是"这个项目没有骨架"/.test(sk2.note), sk2.note)

  // ══ 二、ok 的语义：有骨架就算读到了（这正是旧 bug 的形状） ══
  console.log('\n=== 二、ok 不许只看 README / ROADMAP ===')
  {
    // 只有 AGENTS.md + docs/plan，**没有** README/ROADMAP → 旧实现会判 ok=false
    const repo3 = fs.mkdtempSync(path.join(TMP, 'repo3-'))
    writeFile(path.join(repo3, 'AGENTS.md'), '# 宪法\n\n硬规矩若干。\n')
    writeFile(path.join(repo3, 'docs', 'plan', 'X.md'), '# 方案\n\n总纲。\n')
    const r = await rd.readProjectDocs(repo3, { projectHints: [] })
    check('★ 没有 README/ROADMAP 但有 AGENTS.md + docs/plan → ok = true（旧实现这里会判成"没文档"）',
      r.ok === true, `ok=${r.ok} note=${r.note}`)
    check('★ readme / roadmap 真的是 null（不造空壳）',
      r.readme === null && r.roadmap === null)
    check('★ skeleton 里有 2 份', r.skeleton.files.length === 2, JSON.stringify(r.skeleton.files.map((f) => f.rel)))
  }

  // ══ 三、Hermes skill（仓库外那份） ══
  console.log('\n=== 三、Hermes skill（60+ 条铁律不在仓库里） ===')
  {
    const hh = path.join(TMP, 'hermes-home')
    writeFile(path.join(hh, 'skills', 'obsidian', 'demo-development', 'SKILL.md'),
      '# demo 开发铁律\n\n动代码前先加载本卡。\n')
    writeFile(path.join(hh, 'skills', 'obsidian', 'other-thing', 'SKILL.md'), '# 别的项目\n\n不算数。\n')
    process.env.HERMES_HOME = hh

    const repo4 = fs.mkdtempSync(path.join(TMP, 'repo4-'))
    writeFile(path.join(repo4, 'AGENTS.md'), '# 宪法\n\n见 skill。\n')
    const sk4 = rd.discoverSkeleton(repo4, ['demo'])
    const skillRel = sk4.files.filter((f) => f.kind === '技能').map((f) => f.rel)
    check('★ 按项目名匹配到 Hermes skill（demo-development）',
      skillRel.some((r) => r.includes('demo-development')), JSON.stringify(skillRel))
    check('★ 仓库外的 skill 路径带 `~skill:` 前缀（用户得知道它不在自己仓库里）',
      skillRel.every((r) => r.startsWith('~skill:')), JSON.stringify(skillRel))
    check('★ 不匹配的 skill 不许混进来（other-thing）',
      !skillRel.some((r) => r.includes('other-thing')), JSON.stringify(skillRel))
    check('★ 技能排在宪法与规划之后',
      sk4.files.findIndex((f) => f.kind === '技能') > sk4.files.findIndex((f) => f.kind === '宪法'))
    delete process.env.HERMES_HOME
  }

  // ══ 四、真项目：司天那五份必须都在 ══
  console.log('\n=== 四、真项目司天（2026-11-15 实测读不到的那五份） ===')
  const SITIAN = 'E:/CODE/CangKu/SiTian'
  if (!fs.existsSync(SITIAN)) {
    console.log('SKIP  本机没有司天仓库 —— 真项目那节不跑（不伪装通过）')
  } else {
    const sk5 = rd.discoverSkeleton(SITIAN, ['sitian'])
    const all = sk5.files.map((f) => f.rel + '|' + f.foundAs).join('\n')
    check('★ 读到 AGENTS.md（87,773 字那份宪法）',
      /AGENTS\.md/.test(all), all.slice(0, 200))
    check('★ 读到 docs/guides/…/06-司天-中长期施工计划（写着"唯一现行总纲"那份）',
      /06-司天-中长期施工计划/.test(all), all.slice(0, 300))
    check('★ 读到 docs/plan/PLAN_20261109_3MONTH.md（35,528 字那份）',
      /PLAN_20261109_3MONTH/.test(all), all.slice(0, 300))
    check('★ 读到 docs/plan/HANDOFF_20261115.md（施工接力单）',
      /HANDOFF_20261115/.test(all), all.slice(0, 300))
    check('★ 读到 Hermes skill `sitian-development`（60+ 条铁律，在仓库外）',
      /sitian-development/.test(all),
      sk5.files.filter((f) => f.kind === '技能').map((f) => f.rel).join(','))

    // 只读断言**只盯我们真读的那些文件**，不盯整仓：
    // 2026-11-16 实测，司天 `build/run_tests_a21_clean.log` 正被**另一个进程**追加写
    // （整仓指纹因此每跑一次都变），那不是我们写的。盯整仓 = 别人的写入会把它判成我们的红。
    // 真正的声明是"读不改被读的东西"，所以盯被读的文件才是准确的那条。
    const statOf = (rels) => rels.map((r) => {
      const p = path.join(SITIAN, r.split('/').join(path.sep))
      const st = fs.statSync(p)
      return r + ':' + st.size + ':' + st.mtimeMs
    }).join('\n')

    const sk6 = rd.discoverSkeleton(SITIAN, ['sitian'])
    const inRepo = sk6.files.filter((f) => !f.rel.startsWith('~skill:')).map((f) => f.rel)
    check('司天骨架里有仓库内的文件（否则这条断言是空转）', inRepo.length > 0, `inRepo=${inRepo.length}`)

    const before = statOf(inRepo)
    rd.discoverSkeleton(SITIAN, ['sitian'])
    const after = statOf(inRepo)
    check('★ 只读：被读的骨架文件 size + mtime 一个不变', before === after,
      before === after ? '' : '读数变了 —— 有人在写')

    // 文件**集合**不许变（读操作不该新建/删除文件）；内容级的整仓比对会被上面那个
    // 正在跑的日志文件污染，所以这里只比"这些骨架文件还在、没多出同名的"。
    check('★ 只读：读完这些骨架文件仍然存在（没被读操作搬走）',
      inRepo.every((r) => fs.existsSync(path.join(SITIAN, r.split('/').join(path.sep)))),
      inRepo.join(','))
  }

  // ══ 五、源码守卫：这个模块只许读 ══
  console.log('\n=== 五、源码守卫（repoDocs 不许写盘） ===')
  {
    const src = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'repoDocs.ts'), 'utf-8')
      .split('\n').filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      }).join('\n')
    for (const bad of ['writeFile', 'mkdirSync', 'rmSync', 'renameSync', 'appendFile', 'copyFile', 'unlinkSync']) {
      check(`repoDocs 源码里没有 ${bad}（契约③：只读别人仓库）`, !src.includes(bad))
    }
    // 「只读提交标题是残废」—— 读正文这件事要有实现证据
    check('★ 实现了读正文（extractTitleAndExcerpt 被真的调用了）',
      /extractTitleAndExcerpt\(/.test(src))
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('FAIL  未捕获异常：', e && e.stack || e)
  process.exit(1)
})
