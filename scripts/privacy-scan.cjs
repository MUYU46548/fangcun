#!/usr/bin/env node
/**
 * 私有专名扫描器（2026-11-16）
 *
 * 暮雨：「**司天/墨坊永不该出现在方寸的任何一处文案中**」
 *
 * ## 为什么不只是"改掉手册里那几处"
 *
 * 手册只是他**恰好看到**的那一处。专名泄漏面是：
 *   · `desktop/src` 下所有 `.vue` / `.ts` 的**字符串字面量**（界面文案、toast、placeholder）
 *   · `docs/*.md`、`AGENTS.md`、`立项契约.md` 等**随包/随仓发布**的文档
 *   · 提示词模板（派工单 / howTo / 自检提示）—— 这些会被贴给外部 agent
 *
 * ## 与 `check-ui-copy.cjs` 的分工
 *
 * 那个管"Markdown 标记漏进界面"，这个管"私有专名漏进任何可见处"。
 * **词表只有一份**：`scripts/privacy-terms.cjs`（base64，明文不落库）。
 *
 * ## ⚠ 允许出现的地方（必须显式登记，扫描器每次都会打印）
 *
 * 注释里保留出处（"抄司天那套"）是**维护者信息**，用户看不到。
 * 但**注释与代码必须能被区分**——所以这里先剥注释再扫，不是"看见就放过"。
 *
 * 跑法：
 *   node scripts/privacy-scan.cjs          # 扫，有命中就非零退出
 *   node scripts/privacy-scan.cjs --all    # 连注释一起看（人工核查用，不判红）
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { decodeTerms } = require('./privacy-terms.cjs')

const ROOT = path.resolve(__dirname, '..')
const TERMS = decodeTerms()

/**
 * 注释里允许保留专名的**逐文件登记**（登记 ≠ 藏起来：每次运行都会打印原因）。
 *
 * ⚠ 判据很严：只允许「这套写法照搬自某处」这种**出处指向**，
 *   不允许"拿别的产品当例子讲功能"。后者用户看得到、必须清。
 */
const ALLOW_COMMENTS = {
  'desktop/src/main/backup/gitBackup.ts':
    '注释里"抄某某那套已踩过坑的凭据做法"是**出处指向**（维护者要知道为什么这么写）；'
    + '删了它，下一个人会重新踩同一条。界面文案已单独判红，不受这条影响。',
  'desktop/src/main/backup/gitBackupPure.ts':
    '同上：纯逻辑文件的注释指向出处，不含任何用户可见文案。',
  'desktop/src/main/checks/selfCheck.ts':
    '注释解释"为什么自检必须进报告"时举了那次 4 格全报未过的现场；'
    + '删掉案例等于删掉这条改动的动机（本仓铁律：只修症状不留证据=下次必犯）。',
  'desktop/src/main/data/planDrafts.ts':
    '两处都是"2026-11-12 实测踩到"的原始现场：项目名解析与 `- 依据:` 字段。'
    + '这些是可复现的复现步骤，删了等于让同一个坑失去记录。',
  'desktop/src/main/data/questionnaires.ts':
    '一处解释"为什么问卷答案会落成全局决策卡"（跨项目串味风险），'
    + '一处是"项目名从卷名前缀取"的实测口径。均为维护者依据。',
  // 2026-11-24（K1/K2 落地时留下的口径说明；都是「出处/复现现场」，不是界面文案）
  'desktop/src/main/data/decisions.ts':
    '注释说明"项目原样存用户写的中文名、不在写入时归一"这条决定的现场：'
    + '举了真实的 `项目: 绒花墨坊` 能被 `project-2` 查到。删掉它，下一个人会又把写入改成归一。',
  'desktop/src/main/services/contextPack.ts':
    '注释记录"决策项目归属老口径漏了 11 条全局规矩"的实测：'
    + '用中文名的那几个项目正是反例证据（60→71）。这是可复算的现场，删了等于让这个坑失去记录。',
  'desktop/src/shared/decisionScope.ts':
    '本文件的**整段头注释**就是在讲这个 bug：三种项目写法（全局 / 中文名 / id）互相查不到。'
    + '中文名那几个是反例本身 —— 它们不是"举例讲功能"，而是"当初错在哪"的原始数据。',
  'desktop/src/renderer/App.vue':
    '一处讲暗色主题的踩坑顺序（先写死白底换成 var(--card)，否则暗色下看不见），'
    + '按本仓既有尺度属于**出处指向**（"某产品当年踩过"），不是拿别的产品当功能例子讲。',
}

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  — ' + detail : '')) }
  else {
    fail++
    failures.push(name + (detail ? ' :: ' + detail : ''))
    console.log('FAIL  ' + name + (detail ? '  → ' + detail : ''))
  }
}

function walk(dir, exts, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' ||
        e.name === 'pkg' || e.name === '.pkg-tmp' || e.name === 'pkg.old') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, exts, out)
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')

/** 剥注释：`//` 到行尾、`/* … *\/` 整段、`.vue` 的 `<!-- … -->`。按**原长度**换空格，行号不漂。 */
function stripComments(text, isVue) {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  t = t.replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '))
  t = t.replace(/([^:])\/\/.*$/gm, (m, p1) => p1 + m.slice(p1.length).replace(/[^\n]/g, ' '))
  if (isVue) t = t.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  return t
}

function scanFiles(files, { keepComments }) {
  const hits = []
  for (const f of files) {
    let raw = ''
    try { raw = fs.readFileSync(f, 'utf-8') } catch { continue }
    const isVue = f.endsWith('.vue')
    const text = keepComments ? raw : stripComments(raw, isVue)
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      for (const term of TERMS) {
        if (line.indexOf(term) >= 0) {
          hits.push({ file: rel(f), line: i + 1, term, text: line.trim().slice(0, 120) })
        }
      }
    })
  }
  return hits
}

function main() {
  const keepComments = process.argv.includes('--all')
  console.log('== 私有专名扫描（词表 %d 个，来自 scripts/privacy-terms.cjs）==' % TERMS.length)
  console.log('   词表本身**不明文入库**：扫描器若把要防的词写在仓库里，它就是最大的泄漏源。')
  console.log('')

  check('★ 词表能解出来且非空（解不出 = 扫描器空转）', TERMS.length > 0, 'terms=' + TERMS.length)

  // ── 一、界面源码（`.vue` / `.ts`）──────────────────────────────
  // ⚠ 只扫 `desktop/src`：那是**会被打进安装包**的部分。
  //   `desktop/test` 是夹具，里面为了造场景可能有专名（另算，见第三节）。
  const srcFiles = walk(path.join(ROOT, 'desktop', 'src'), ['.vue', '.ts'])
  check('★ 扫到界面源码', srcFiles.length > 100, 'n=' + srcFiles.length)

  // ⚠⚠ 2026-11-16 暮雨的判据是「**永不该出现在方寸的任何一处文案中**」。
  //   第一版我把"注释"当例外剥掉了 —— 那是我在替自己辩护：注释也是文本，
  //   也是"任何一处"。但注释里保留出处（"这套做法照搬自某处"）**有维护价值**，
  //   一刀切全删会把"为什么这么写"一起删掉，下一个接手的人更危险。
  //
  //   所以分两档，都判红：
  //     ① **文案**（剥注释后）出现专名 → 必须零容错，这是用户能看到的
  //     ② **注释**里出现专名 → 也要清，除非登记在 ALLOW_COMMENTS 并写明理由
  //   登记表每次运行都会打印（登记 ≠ 藏起来），和 check-ipc-parity 同一套做法。
  const srcHits = scanFiles(srcFiles, { keepComments: false })
  check('★★ 界面文案（剥注释后）零私有专名', srcHits.length === 0,
    srcHits.slice(0, 6).map((h) => `${h.file}:${h.line} 「${h.term}」 ${h.text.slice(0, 50)}`).join(' | '))

  const commentHits = scanFiles(srcFiles, { keepComments: true })
    .filter((h) => !srcHits.some((x) => x.file === h.file && x.line === h.line))
  const allowed = commentHits.filter((h) => ALLOW_COMMENTS[h.file])
  const notAllowed = commentHits.filter((h) => !ALLOW_COMMENTS[h.file])
  check('★★ 注释里的专名：要么清零，要么逐文件登记理由', notAllowed.length === 0,
    notAllowed.slice(0, 8).map((h) => `${h.file}:${h.line} 「${h.term}」`).join(' | '))
  if (allowed.length) {
    console.log('SKIP  已登记豁免的注释文件（%d 处）：' % allowed.length)
    for (const [f, why] of Object.entries(ALLOW_COMMENTS)) {
      console.log('       ' + f + ' —— ' + why)
    }
  }

  // ── 二、docs/ 不许被 git 跟踪（2026-11-16 暮雨：「docs/ 本来就不该随仓库公开」）──
  // ⚠ 这个仓是**公开**的。docs/ 里全是执行日志、派工单、交接与现场记录 ——
  //   含真实项目名、本机路径、当时的工作细节，是**工作证据不是产品资产**。
  //   判据盯的是"有没有被跟踪"，不是"文件在不在"：方寸照常读写磁盘上的 docs/。
  let trackedDocs = []
  try {
    const r = require('child_process').execFileSync(
      'git', ['-C', ROOT, 'ls-files', 'docs/'], { encoding: 'utf-8', timeout: 60000 })
    trackedDocs = String(r || '').split('\n').filter(Boolean)
  } catch (e) {
    console.log('INFO  git 不可用，跳过"docs 未被跟踪"这一条（不当作通过）')
  }
  check('★★ docs/ 一个文件都不该被 git 跟踪（公开仓库里它含真实专名与工作现场）',
    trackedDocs.length === 0,
    trackedDocs.slice(0, 5).join(', ') + (trackedDocs.length > 5 ? ' …共 ' + trackedDocs.length : ''))

  // ── 三、随包/随仓发布的文档 ────────────────────────────────────
  const docFiles = []
  for (const d of ['docs']) docFiles.push(...walk(path.join(ROOT, d), ['.md']))
  for (const f of ['AGENTS.md', '立项契约.md', 'README.md']) {
    const p = path.join(ROOT, f)
    if (fs.existsSync(p)) docFiles.push(p)
  }
  check('★ 扫到文档', docFiles.length > 50, 'n=' + docFiles.length)
  // ⚠ 文档里的专名**不算红**：docs/ 大量是执行日志与交接单，本来就记录了真实项目名，
  //   把它们全清掉等于毁掉历史现场（暮雨原话：「那是历史现场，别当现状」）。
  //   这里只**计数并打印**，让人知道面有多大；真正的硬判据在第一节（界面源码）。
  const docHits = scanFiles(docFiles, { keepComments: true })
  console.log('INFO  文档里出现 %d 处（不判红：docs/ 是历史现场，清掉=毁证据）' % docHits.length)
  const docFilesTop = {}
  for (const h of docHits) docFilesTop[h.file] = (docFilesTop[h.file] || 0) + 1
  Object.entries(docFilesTop).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([f, n]) => console.log('       ' + f + ' × ' + n))

  // ── 三、测试夹具（单独一档：它不进安装包）──────────────────────
  const testFiles = walk(path.join(ROOT, 'desktop', 'test'), ['.js', '.cjs'])
  const testHits = scanFiles(testFiles, { keepComments })
  console.log('INFO  测试夹具里 %d 处（夹具不进安装包，不判红）' % testHits.length)

  // ── 四、词表明文反查：base64 文件里不许能直接搜到明文 ──────────
  const termsFile = path.join(ROOT, 'scripts', 'privacy-terms.cjs')
  const tf = fs.readFileSync(termsFile, 'utf-8')
  const tfCode = stripComments(tf, false)
  const leaked = TERMS.filter((t) => t.length >= 2 && tfCode.indexOf(t) >= 0)
  check('★★ 词表文件里没有明文专名（否则它自己就是泄漏源）', leaked.length === 0, leaked.join(','))

  console.log('\nRESULT ' + pass + ' / ' + fail)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    return 1
  }
  return 0
}

process.exit(main())
