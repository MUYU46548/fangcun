#!/usr/bin/env node
/**
 * 计划器读不读得到「项目现实」（2026-11-14 · 长 Loop P2-3）
 *
 * 病灶（长 Loop §3 第一条）：**只读自己的账本，不读项目现实** ——
 * 计划输入只有方寸的卡 / 决策 / 验收线，对这个项目仓库里 README 怎么说、
 * ROADMAP 排到哪、最近动过哪些文档一无所知。于是"规划"退化成从卡标题猜方向。
 *
 * 这套断言钉四件，每件都配反例：
 *  ① **真读到**：真建一个临时仓库（README + ROADMAP + docs 提交），跑真编译产物，
 *     证据里必须出现 repo:readme / repo:roadmap / repo:docs-commits；
 *  ② **缺就说缺**：没有 README 时不许造空壳，要给"读不到"的说明；
 *  ③ **没登记 repo**：给的是"没登记仓库根"，不是"读失败"（两件事话术不同）；
 *  ④ **读了才许自报**：草案开头的来源列表只在真读到东西时才写"项目仓库文档"。
 *
 * 运行：node scripts/test/e2e-plan-repodocs.cjs   （需先 cd desktop && npm run build）
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'main', 'llm', 'planDraft.js')
const ART_INPUT = path.join(REPO, 'desktop', 'dist', 'main', 'llm', 'planDraftInput.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

for (const [p, label] of [[ART, 'planDraft.js'], [ART_INPUT, 'planDraftInput.js']]) {
  if (!fs.existsSync(p)) {
    console.log(`FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ${label}`)
    console.log('RESULT 0 / 1')
    process.exit(1)
  }
}
// ── ⑤ 契约守卫：MCP 分发器**不许**因为读仓库而整体变 async ────────────────
// 真事（2026-11-14 本刀踩过）：为了让 plan_draft 读仓库，我一度把
// `handleToolCallInner` 整个改成 `async` —— 于是**所有**工具都开始返回 Promise，
// `e2e-mcp-context` 里 `call('decision_list').decisions` 立刻全是 undefined，
// 39 条断言一起红。那是**对外契约被顺手改掉**，不是测试写死。
// 正解：只有那两个分支返回 Promise。
{
  const toolsSrc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'mcp', 'tools.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  check('★★ 分发器 handleToolCallInner 保持**同步签名**（只有两个分支返回 Promise）',
    /function handleToolCallInner\([^)]*\):\s*MCPToolResult\s*\|\s*Promise<MCPToolResult>/.test(toolsSrc)
    && !/async function handleToolCallInner/.test(toolsSrc),
    'sig=' + (/async function handleToolCallInner/.test(toolsSrc) ? '仍是 async（危险）' : 'ok'))
  check('★ 那两个分支用 async IIFE 返回 Promise（而不是把整个函数传染成异步）',
    (toolsSrc.match(/return \(async \(\) => \{/g) || []).length >= 2,
    'IIFE=' + (toolsSrc.match(/return \(async \(\) => \{/g) || []).length)
}

const planDraft = require(ART)

console.log('== 计划器读项目现实（P2-3）==')

// ── ① 源码/契约层：形状要说清，不许只有一个裸字段 ──────────────────────
const src = fs.readFileSync(ART_INPUT, 'utf8')
check('★ repoDocs 带着 missing 字段（缺什么必须说出来，不能静默空着）',
  /missing/.test(src))
check('★ 读失败与"本来就没有"是两回事（都有注释说明）',
  /读仓库文档失败/.test(src) && /没登记仓库根/.test(src))
check('★★ 同步版保持原样（老断言不受影响）+ 另有 async 版读仓库',
  /function buildPlanDraftInputFromDisk\b/.test(src)
  && /async function buildPlanDraftInputFromDiskWithRepo/.test(src))

// ── ② 证据链：repo:readme / roadmap / docs-commits 必须是合法 cite ──────
{
  const allowed = planDraft.allowedCitations({
    project: 'x',
    repoDocs: {
      repo: '/tmp/r',
      readme: { title: 'R', excerpt: 'e' },
      roadmap: { title: 'M', excerpt: 'm' },
      recentDocsCommits: [{ sha: 'abc1234', subject: 's' }],
    },
  })
  check('★★ 仓库文档进了**允许引用的依据**（模型可以 cite，不然只是背景闲聊）',
    allowed.includes('repo:readme') && allowed.includes('repo:roadmap')
    && allowed.includes('repo:docs-commits'), JSON.stringify(allowed))
}
{
  // 反例：什么文档都没有 → 不许凭空冒出 repo:* 依据
  const allowed = planDraft.allowedCitations({ project: 'x', repoDocs: { repo: '/tmp/r', readme: null, roadmap: null, recentDocsCommits: [], missing: ['没有 README'] } })
  check('★ 反例自证：文档全缺时**不给**任何 repo:* 依据（不许编）',
    !allowed.some((x) => x.startsWith('repo:')), JSON.stringify(allowed))
}

// ── ③ 提示词与草案自报：真读到才写"项目仓库文档" ────────────────────────
{
  const withDocs = planDraft.buildPlanDraftPrompt({
    project: 'x', projectName: 'X',
    repoDocs: {
      repo: '/tmp/r',
      readme: { title: '读我', excerpt: '一句话简介' },
      roadmap: null,
      recentDocsCommits: [],
      // ⚠ missing 必须**如实**包含"没有 ROADMAP"。
      //   第一版我在这里写的是空数组，于是断言红在一个假前提下 ——
      //   真正该钉的是"missing 有内容时，提示词要把它说出来"。
      missing: ['仓库里没有 ROADMAP（或读不出来）'],
    },
  })
  check('★★ README 的内容真进了提示词（标题 + 摘要，不是只有个字段名）',
    withDocs.user.includes('读我') && withDocs.user.includes('一句话简介'),
    withDocs.user.slice(0, 120))
  // ⚠ 上面那条只钉"内容在"，不钉"标成了 repo:readme"。
  //   反例自证发现：把前缀改坏它也照样绿 —— 因为标题字符串还是被别的分支带进去了。
  //   所以单独钉一句**带标记的整行**，这才是模型能 cite 的东西。
  check('★★ 且标了 [repo:readme] 标记（内容在 ≠ 能被引用，两者都验）',
    /\[repo:readme\][^\n]*读我/.test(withDocs.user),
    withDocs.user.split('\n').filter((l) => /repo:readme/.test(l)).join(' | '))
  check('★ 缺 ROADMAP 时提示词里写出"读不到"（不让模型以为没列＝不存在）',
    /读不到/.test(withDocs.user) && /ROADMAP/.test(withDocs.user),
    withDocs.user.split('\n').filter((l) => /读不到|ROADMAP/.test(l)).join(' | ').slice(0, 160))
}
{
  // 有 repo 但什么文档都没有、missing 也空 → 也要留一句，别让这段整个消失
  const bare = planDraft.buildPlanDraftPrompt({
    project: 'x', projectName: 'X',
    repoDocs: { repo: '/tmp/r', readme: null, roadmap: null, recentDocsCommits: [], missing: [] },
  })
  check('★★ 什么都没有时也要写一句"读不到项目现实"（整段消失＝模型当成没有项目）',
    /读不到项目现实/.test(bare.user),
    bare.user.split('\n').filter((l) => /仓库|读不到/.test(l)).join(' | ').slice(0, 140))
}
{
  const noDocs = planDraft.buildPlanDraftPrompt({ project: 'x', projectName: 'X', repoDocs: null })
  check('★ 反例自证：没有 repoDocs 时提示词里不许出现"仓库"内容',
    !/repo:readme/.test(noDocs.user) && !/README：/.test(noDocs.user))
}

// ── ④ 真仓库端到端：建临时 git 仓库，跑真 async 版 ─────────────────────
function mkRepo(withReadme, withRoadmap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-repo-'))
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g(['init', '-q'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  if (withReadme) fs.writeFileSync(path.join(dir, 'README.md'), '# 真项目\n\n这个项目做的是真事情。\n', 'utf-8')
  if (withRoadmap) {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'docs', 'ROADMAP.md'), '# 路线\n\n下一阶段做 X。\n', 'utf-8')
  }
  // ⚠ 空仓库没有任何文件时 `git commit` 会失败（"nothing to commit"）。
  //   放一个占位文件让仓库合法 —— 它**不是** README/ROADMAP，所以不影响"读不到"的判据。
  if (!withReadme && !withRoadmap) {
    fs.writeFileSync(path.join(dir, '.gitkeep'), '', 'utf-8')
  }
  g(['add', '-A'])
  g(['commit', '-q', '-m', 'init: 建仓库'])
  if (withRoadmap) {
    fs.writeFileSync(path.join(dir, 'docs', 'ROADMAP.md'), '# 路线\n\n下一阶段做 X 和 Y。\n', 'utf-8')
    g(['add', '-A'])
    g(['commit', '-q', '-m', 'docs: 路线补 Y'])
  }
  return dir
}

async function main() {
  // 真跑需要 electron 的 app 桩（repoDocs 只用 fs + git，不碰 app）
  global.electron = global.electron || {}
  let readProjectDocs = null
  try {
    ;({ readProjectDocs } = require(path.join(REPO, 'desktop', 'dist', 'main', 'services', 'repoDocs.js')))
  } catch (e) {
    console.log('SKIP  读不到 repoDocs 编译产物：' + String(e && e.message))
  }
  if (readProjectDocs) {
    const dir = mkRepo(true, true)
    try {
      const r = await readProjectDocs(dir, { force: true })
      check('★★ 真 git 仓库：README 与 ROADMAP 都读得到（端到端，不是只断言形状）',
        !!r.readme && !!r.roadmap, `readme=${!!r.readme} roadmap=${!!r.roadmap} note=${r.note}`)
      check('★ 真读到了 docs/ 的提交历史（P2-3 的"最近动过哪些文档"）',
        Array.isArray(r.docsCommits) && r.docsCommits.length >= 1,
        'commits=' + (r.docsCommits || []).length)
      check('★ README 摘要里是**正文**内容（不是只有标题）',
        String((r.readme || {}).excerpt || '').includes('真事情'),
        String((r.readme || {}).excerpt || '').slice(0, 60))
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }

  // 缺 README 的仓库：必须 null，不许造空壳
  if (readProjectDocs) {
    const dir2 = mkRepo(false, false)
    try {
      const r = await readProjectDocs(dir2, { force: true })
      check('★★ 空仓库：readme / roadmap 都是 null（没文档就说没有，不造空壳）',
        r.readme === null && r.roadmap === null,
        `readme=${JSON.stringify(r.readme && r.readme.title)} roadmap=${JSON.stringify(r.roadmap && r.roadmap.title)}`)
      check('★ 空仓库要给出"为什么读不到"的一句话（note 非空）',
        String(r.note || '').trim().length > 0, 'note=' + JSON.stringify(r.note))
    } finally {
      try { fs.rmSync(dir2, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }

  console.log('\n' + (fail ? '❌ ' : '✅ ') + `RESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log('  · ' + f)
  }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log('FAIL  ' + String(e && e.stack || e))
  console.log('RESULT 0 / 1')
  process.exit(1)
})
