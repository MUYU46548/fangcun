/**
 * 「实况回流 · 路线文档」端到端（2026-10-21 · W1-批次 2）
 *
 * 钉的是四条边界，不是"代码里有 readFileSync 这个词"：
 *  ① **读到真东西**：README / ROADMAP + 最近动过 docs/ 的提交（真临时仓库里造出来再读回）；
 *  ② **不造空壳**：没有 ROADMAP 就是 null（界面据此显示"没有"），绝不糊一份空的冒充；
 *  ③ **只读**：跑完 `git status --porcelain` 必须仍为空、README 的 mtime 不许变；
 *  ④ **一天一批**：第二次调用命中缓存（cached=true 且 readAt 不变），force 才重读。
 *
 * 跑法：node scripts/test/e2e-repo-docs.cjs（本机没 git → 显式 SKIP，不伪装通过）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'desktop', 'dist', 'main')

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

function git(args, cwd) {
  return new Promise((resolve) => {
    const c = spawn('git', args, { cwd, windowsHide: true })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => { out += d.toString() })
    c.stderr.on('data', (d) => { err += d.toString() })
    c.on('close', (code) => resolve({ code, out, err }))
    c.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
  })
}
const ID = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@local', '-c', 'commit.gpgsign=false']

function writeFile(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s, 'utf-8')
}

/** 剥注释再扫源码（注释里会提到"不许 fetch"这种事，不剥就假红） */
function stripComments(src) {
  return String(src)
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

async function main() {
  const modPath = path.join(DIST, 'services', 'repoDocs.js')
  if (!fs.existsSync(modPath)) {
    console.error('FAIL  找不到 dist/main/services/repoDocs.js —— 请先 cd desktop && npm run build')
    process.exit(1)
  }
  const v = await git(['--version'], os.tmpdir())
  if (v.code !== 0) {
    console.log('SKIP  本机没有可用的 git —— 路线文档取数无法真跑（不伪装通过）')
    process.exit(0)
  }

  const roots = []
  const mk = (name) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-docs-' + name + '-'))
    roots.push(d)
    return d
  }

  try {
    const { readProjectDocs, extractTitleAndExcerpt, _clearDocsCache } = require(modPath)

    // ── ① 纯函数：标题 + 摘要抽取（README 常见形态：标题、徽章、分隔线、目录）──────
    {
      const md = [
        '# 方寸 (Tegula)',
        '',
        '[![build](https://img.shields.io/badge/build-passing-green.svg)](https://example.com)',
        '<img src="logo.png" width="80" />',
        '',
        '---',
        '',
        '零依赖本地多 agent 任务看板，把全部项目收口到一屏。',
        '',
        '第二段才常常是有信息量的那句（2026-10-21 用户反馈"只截一行没用"后收两段）。',
        '',
        '第三段不该进摘要（默认只给两段，再多就去点开看）。',
      ].join('\n')
      const got = extractTitleAndExcerpt(md)
      check('★ 抽标题：取一级标题（去掉粗体/代码标记）', got.title === '方寸 (Tegula)', got.title)
      check('★★ 抽摘要：跳过徽章/图片/分隔线，从第一段正文开始（不是把徽章当摘要）',
        got.excerpt.indexOf('零依赖本地') === 0, got.excerpt)
      // 2026-10-21 暮雨反馈「README 只截一行，通常没什么有用信息」→ 摘要改成**前两段**
      check('★★ 摘要收**两段**（第一段常常只是标语，第二段才有信息）',
        got.excerpt.indexOf('第二段才常常') > 0, got.excerpt)
      check('  但只收两段：第三段不进摘要（要看就点开，不默认铺满监控台）',
        got.excerpt.indexOf('第三段不该进摘要') < 0, got.excerpt)
      check('★ 另外给一份更长的展开正文 more（≥ 摘要长度，点开才显示）',
        got.more.length > got.excerpt.length && got.more.indexOf('第三段不该进摘要') > 0,
        'more=' + got.more.length + ' excerpt=' + got.excerpt.length)
      const noTitle = extractTitleAndExcerpt('就是一段话，没有标题。')
      check('  没有标题 → title 为空（由调用方退回文件名，不编一个）', noTitle.title === '', JSON.stringify(noTitle))
    }

    // ── ② 真仓库：README + docs/ROADMAP + 一条 docs 提交 ──────────────────────
    const repo = mk('full')
    await git(['init', '--initial-branch=main'], repo)
    writeFile(path.join(repo, 'README.md'), '# 演示项目\n\n这是一句话摘要。\n')
    writeFile(path.join(repo, 'docs', 'ROADMAP.md'), '# 路线图\n\n下一步：把分组做成可折叠。\n')
    writeFile(path.join(repo, 'src', 'a.js'), 'x\n')
    await git([...ID, 'add', '-A'], repo)
    await git([...ID, 'commit', '-m', 'init'], repo)
    writeFile(path.join(repo, 'docs', 'W1施工单.md'), '# W1\n')
    await git([...ID, 'add', '-A'], repo)
    await git([...ID, 'commit', '-m', 'docs: 补 W1 施工单'], repo)
    // 一次非 docs 的提交，用来证明"只数 docs/"
    writeFile(path.join(repo, 'src', 'b.js'), 'y\n')
    await git([...ID, 'add', '-A'], repo)
    await git([...ID, 'commit', '-m', 'feat: 无关提交'], repo)

    const noCache = path.join(roots[0], '..', 'placeholder')
    void noCache
    _clearDocsCache()
    const readmeMtimeBefore = fs.statSync(path.join(repo, 'README.md')).mtimeMs
    const d1 = await readProjectDocs(repo)
    check('★★ 读到 README（含一句话摘要，不是整篇）',
      !!d1.readme && d1.readme.rel === 'README.md' && d1.readme.excerpt.indexOf('一句话摘要') >= 0,
      JSON.stringify(d1.readme))
    check('★★ 读到 docs/ROADMAP.md（根目录没有时去 docs/ 找）',
      !!d1.roadmap && d1.roadmap.rel === 'docs/ROADMAP.md', JSON.stringify(d1.roadmap))
    // 期望值从夹具真身算：init 那次也动过 docs/ROADMAP.md，所以这里是 2 条而不是 1 条 ——
    // 写死成 1 就是定时炸弹（改夹具就假红）。真正要钉的是"不含非 docs 提交"和"中文路径没被转义"。
    check('★★ 只数 docs/ 下的提交（feat: 无关提交 不进这一列）',
      d1.docsCommits.length === 2
      && d1.docsCommits[0].subject === 'docs: 补 W1 施工单'
      && !d1.docsCommits.some((c2) => c2.subject === 'feat: 无关提交'),
      JSON.stringify(d1.docsCommits.map((c2) => c2.subject)))
    check('★★ 中文路径原样可读（core.quotepath=false —— 否则界面/日志里是一串八进制）',
      d1.docsCommits[0].files.some((f) => f === 'docs/W1施工单.md'), JSON.stringify(d1.docsCommits[0].files))
    check('  readAt 是 ISO 时间、cached 首次为 false', /^\d{4}-\d{2}-\d{2}T/.test(d1.readAt) && d1.cached === false,
      d1.readAt + ' cached=' + d1.cached)

    // ── ③ 只读：跑完仓库必须干净，文档 mtime 不许变 ─────────────────────────
    const st = await git(['status', '--porcelain'], repo)
    check('★★ 只读铁律：跑完 `git status` 仍为空（不写、不 checkout、不 add）', st.out.trim() === '', JSON.stringify(st.out))
    check('★ 文档 mtime 没被碰过', fs.statSync(path.join(repo, 'README.md')).mtimeMs === readmeMtimeBefore)

    // ── ④ 一天一批：第二次命中缓存，force 才重读 ────────────────────────────
    const d2 = await readProjectDocs(repo)
    check('★★ 第二次调用命中当天缓存（cached=true 且 readAt 不变）',
      d2.cached === true && d2.readAt === d1.readAt, JSON.stringify({ cached: d2.cached, a: d1.readAt, b: d2.readAt }))
    const d3 = await readProjectDocs(repo, { force: true })
    check('  force=true 绕过缓存重读（readAt 变新、cached=false）',
      d3.cached === false && d3.readAt >= d2.readAt, JSON.stringify({ cached: d3.cached }))

    // ── ⑤ 缺一份就 null，绝不造空壳 ────────────────────────────────────────
    const onlyReadme = mk('onlyreadme')
    await git(['init', '--initial-branch=main'], onlyReadme)
    writeFile(path.join(onlyReadme, 'README.md'), '# 只有 README\n\n没有路线图。\n')
    await git([...ID, 'add', '-A'], onlyReadme)
    await git([...ID, 'commit', '-m', 'init'], onlyReadme)
    const d4 = await readProjectDocs(onlyReadme)
    check('★★ 没有 ROADMAP → roadmap 为 null（界面显示"没有"，不糊空壳）',
      d4.roadmap === null && !!d4.readme, JSON.stringify({ readme: !!d4.readme, roadmap: d4.roadmap }))
    check('★ 只有 README 时 note 点名「没找到 ROADMAP」（别让人把对外说明当路线）',
      /没找到 ROADMAP/.test(d4.note), d4.note)
    check('  没有 docs/ 提交 → docsCommits 为空数组（不是 null，调用方不用兜）',
      Array.isArray(d4.docsCommits) && d4.docsCommits.length === 0, JSON.stringify(d4.docsCommits))

    // ── ⑥ 三种"读不到"各有各的话，不能都糊成"没有进展" ──────────────────────
    const plain = mk('plain')
    writeFile(path.join(plain, 'README.md'), '# 非 git 目录\n\n也能读文档。\n')
    const d5 = await readProjectDocs(plain)
    check('★ 非 git 目录但有 README → ok=true + 明说"不是 git 仓库，没有提交历史"',
      d5.ok === true && /不是 git 仓库/.test(d5.note), JSON.stringify({ ok: d5.ok, note: d5.note }))

    const empty = mk('empty')
    const d6 = await readProjectDocs(empty)
    check('  空目录 → ok=false + 说清"没有 README / ROADMAP"',
      d6.ok === false && /没有 README \/ ROADMAP/.test(d6.note), d6.note)

    const d7 = await readProjectDocs('')
    check('  没登记工作目录 → 明说读不到（不是返回空数据冒充没有进展）',
      d7.ok === false && /没登记工作目录/.test(d7.note), d7.note)

    const d8 = await readProjectDocs(path.join(empty, 'not-exist-dir'))
    check('  目录不存在 → 原因里带路径（用户能自己去核对）',
      d8.ok === false && /不存在/.test(d8.note) && d8.note.indexOf('not-exist-dir') >= 0, d8.note)

    // ── ⑦ 源码守卫：只读 + 不做分钟级轮询 ───────────────────────────────────
    {
      const raw = stripComments(fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'services', 'repoDocs.ts'), 'utf-8'))
      check('★ 不许出现写仓库/拉网络的动作（fetch / checkout / pull / add / commit / writeFile）',
        !/\b(fetch|checkout|add|commit|reset|writeFileSync)\s*\(/.test(raw.replace(/rec\(/g, 'rec_(')),
        (raw.match(/\b(fetch|checkout|add|commit|reset|writeFileSync)\s*\(/g) || []).join(','))
      check('★ 只有 git log（读历史），没有别的 git 子命令',
        (raw.match(/runGit\(/g) || []).length === 1 && /'log'/.test(raw))
      check('★ 缓存按「仓库 + 当天」而不是时间 TTL（一天一批，不做分钟级轮询）',
        /dayCache/.test(raw) && /today\(\)/.test(raw) && !/setInterval/.test(raw))
      // 界面侧：读不到时必须有出口（不能只留一块空白）
      const app = stripComments(fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue'), 'utf-8'))
      check('★ 界面读不到时给原因（ms-doc-none 兜底），不是一片空白',
        /ms-doc-none/.test(app) && /msDocs\.note/.test(app))
    }

    console.log('')
    console.log('通过 ' + pass + ' / 失败 ' + fail)
    process.exit(fail === 0 ? 0 : 1)
  } finally {
    for (const d of roots) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 占用中算了 */ } }
  }
}

main().catch((e) => {
  console.error('FAIL  测试自身异常：', (e && e.stack) || e)
  process.exit(1)
})
