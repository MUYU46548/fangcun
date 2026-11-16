/**
 * 实况回流取数器（2026-10-21 · W1-批次 2）。
 *
 * 要解决的问题（施工单原话）：监控台只读 git 活动，`状态/路线图/说明` 三字段停在手写时点，
 * 于是"界面显示的是旧值、不是真值"。这里把**仓库里本来就有的路线文档**读回来，
 * 与手写字段**并列显示**（标来源），让用户自己看真假 —— 不由代码裁。
 *
 * 四条硬边界：
 *  ① **只读**：只跑 `git log`、只 `readFileSync`。不 fetch、不 checkout、不写任何仓库
 *     （与 `ipc.ts` 里 `git:taskCommits` 那条铁律同一条）。
 *  ② **不覆盖手写值**：registry 里的 `状态/路线图/说明` 一个字都不改；本模块只产出"自动"那一列。
 *  ③ **一天一批**：按 (repo, 当天) 缓存。不做分钟级轮询，也不每次点进项目页都重跑 git
 *     （大仓库一次 `git log -- docs/` 就要几百毫秒，用户感觉是"页面卡一下"）。
 *  ④ **读不到就说原因**：没登记工作目录 / 目录不在 / 不是 git 仓库 / 一个文档都没有 ——
 *     四种情况各有各的话，绝不返回空数据冒充"这个项目没有进展"。
 *
 * 文档口径（2026-10-21 暮雨定）：**README 与 ROADMAP 都算路线文档**，但 README 偏"给用户看的
 * 展示公告"，所以界面上 README 只取一句话摘要，ROADMAP 才是"接下来做什么"的正主。
 */
import fs from 'fs'
import path from 'path'
import { runGit } from './gitExec'

/** 一份路线文档的读回结果（读不到时整个对象为 null，不造空壳） */
export interface DocFile {
  /** 仓库相对路径（如 `README.md` / `docs/ROADMAP.md`） */
  rel: string
  /** 一级标题（`# xxx`）；没有标题时退回文件名 */
  title: string
  /** 摘要：前 2 段正文，≤300 字（2026-10-21 暮雨反馈"只截一行没什么有用信息"后加长） */
  excerpt: string
  /** 展开用正文：前 1200 字（去 markdown 装饰），默认不显示，点行展开才看 */
  more: string
  bytes: number
  /** 文件 mtime（ISO）—— 用来判断"这份文档多久没更新了" */
  mtime: string
}

export interface DocsCommit {
  hash: string
  date: string
  subject: string
  files: string[]
}

/**
 * 骨架文件（2026-11-16 新增 · 骨架继承试点）。
 *
 * 由来：暮雨 2026-11-15 深夜。方寸当时只认 `README.md` / `ROADMAP.md`，
 * 而隔壁同类产品的骨架根本不在那两份里：
 *
 * | 文件 | 字数 | 旧清单读得到吗 |
 * |---|---:|---|
 * | `README.md` | 22,461 | ✅ **唯一读得到的** |
 * | `AGENTS.md` | **87,773** | ❌ 项目的宪法 |
 * | `docs/guides/…/06-隔壁同类产品-中长期施工计划-v1.2.md` | 21,071 | ❌ 写着"此后以本文为唯一现行总纲" |
 * | `docs/plan/PLAN_20261109_3MONTH.md` | 35,528 | ❌ |
 * | `ROADMAP.md` | — | **不存在** |
 *
 * 他的两条判断必须记住：
 *  ① 「README 本来就是不读都无所谓的东西（正规也不该放过多技术细节，只做面向用户的说明书）」
 *     —— 所以骨架文件**不是** README 的补充，README 才是边角料；
 *  ② 「只读提交标题更是残废」—— 所以这里读的是**正文**，不是 diff 标题。
 *
 * ⚠ 不是"读得越多越好"：这份清单每项都要说清**它为什么算骨架**，
 *    而且**读不到要明说读不到**（不糊一个"没有骨架"的结论）。
 */
export interface SkeletonFile {
  /** 相对仓库的路径；Hermes skill 这类仓库外的用 `~skill:xxx` 前缀标出来 */
  rel: string
  /** 归类：宪法 / 规划 / 模块说明 / 技能 */
  kind: '宪法' | '规划' | '模块说明' | '技能'
  /** 一级标题 */
  title: string
  /** 摘要（够判断"这份值不值得展开"） */
  excerpt: string
  /** 展开正文 */
  more: string
  bytes: number
  mtime: string
  /** 这一份是从哪找到的（人能核对：是根目录、还是 docs/plan 下的某一份） */
  foundAs: string
}

export interface SkeletonResult {
  /** 找到的骨架文件，按 kind 优先级 + 体积降序 */
  files: SkeletonFile[]
  /** 找过但没找到的候选（**说明这不是"没有骨架"，是"这些位置都没有"**） */
  missing: { pattern: string; why: string }[]
  /** 一句话结论 */
  note: string
}

export interface ProjectDocsResult {
  ok: boolean
  /** 读的是哪个仓库（界面不展示，排障/断言用） */
  repo: string
  readme: DocFile | null
  roadmap: DocFile | null
  /** 骨架文件（AGENTS.md / docs/plan / 模块 README / Hermes skill）—— 2026-11-16 新增 */
  skeleton: SkeletonResult
  /** 最近几条动过 `docs/` 的提交（施工日志的"文档级实况"） */
  docsCommits: DocsCommit[]
  /** 本次结果是什么时候读的（ISO）；命中当天缓存时是**首次**读的时间 */
  readAt: string
  /** 是不是命中当天缓存（界面上注明，免得用户以为刚刷新过） */
  cached: boolean
  /** 读不到时的一句话原因；能读到则为空串 */
  note: string
}

/** 文件名候选（大小写都认 —— Windows 上常见 `Readme.md` 这种写法） */
const README_NAMES = ['README.md', 'Readme.md', 'readme.md', 'README.MD']
const ROADMAP_NAMES = ['ROADMAP.md', 'Roadmap.md', 'roadmap.md', 'ROADMAP.MD']
/** 除了仓库根，再看这两个常见目录（不深扫：深扫会把 node_modules 里的 README 也捞上来） */
const DOC_DIRS = ['', 'docs']

// ── 骨架文件清单（2026-11-16）───────────────────────────────────────────
/** ① 宪法：项目的硬规矩，**最高优先**。缺了它，其它文档都只是说明。 */
const CONSTITUTION_NAMES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules']

/** ② 规划：现行总纲 / 长期方案。隔壁同类产品那两份（21,071 + 35,528 字）就在这里。 */
const PLAN_DIRS = ['docs/plan', 'docs/plans', 'docs/guides', 'docs/设计', 'plan', 'plans']
/** docs/guides 下常按日期分子目录 —— 只再进一层（深扫会把所有历史散件都捞上来） */
const PLAN_DEPTH = 2
/** 单份骨架正文最多读多少字节（87KB 的 AGENTS.md 要能读完，但别把几 MB 的塞进来） */
const SKELETON_MAX_BYTES = 512 * 1024
/** 单份骨架保留多少字正文（展开时给人看；不是全文，全文请去开文件） */
const SKELETON_MORE_CHARS = 2000

/** 当天缓存：key = 仓库绝对路径，value = { day, data } */
const dayCache = new Map<string, { day: string; data: ProjectDocsResult }>()

/** 测试用：清缓存（同一天里验证"第二次命中缓存"需要它） */
export function _clearDocsCache(): void {
  dayCache.clear()
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 从 Markdown 正文里抽一级标题 + 一句话摘要。
 *
 * 只取**第一段**正文：README 往往是"标题 + 徽章 + 长目录"，整篇塞进监控台等于把用户淹了。
 * 跳过：标题行、空行之前、HTML 注释、徽章行（`[![...` / `<img`）、分隔线、纯链接行。
 */
/**
 * 从 Markdown 正文抽：一级标题 + 摘要（前 2 段/≤300 字）+ 展开正文（≤1200 字）。
 *
 * 2026-10-21 暮雨反馈“README 只截一行，通常没什么有用信息”—— 第一段常常是一句标语
 * （"本项目使用 AI 辅助制作"），信息量确实为零。所以：
 *  ① 摘要收**前两段**（跳过徽章/图片/分隔线/纯链接行），最多 300 字；
 *  ② 另外给一份去掉 markdown 装饰的连续正文（≤1200 字），点行展开时才显示 —— 
 *     默认不塞满监控台，但"想看就能看"，不用去开文件。
 * 口径仍是"只读、不改文档"。
 */
export function extractTitleAndExcerpt(md: string): { title: string; excerpt: string; more: string } {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  let title = ''
  for (const raw of lines) {
    const m = raw.match(/^\s*#\s+(.+?)\s*$/)
    if (m) { title = m[1].replace(/[*_`]/g, '').trim(); break }
  }
  const clean = (raw: string): string => {
    let t = raw.trim()
    t = t.replace(/^[-*+]\s+/, '').replace(/^>\s*/, '').replace(/[`*_]/g, '')
    t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    return t.trim()
  }
  const skip = (raw: string): boolean => {
    const t = raw.trim()
    if (!t) return true
    if (t.startsWith('#')) return true
    if (t.startsWith('<!--')) return true
    if (/^(-{3,}|\*{3,}|={3,})$/.test(t)) return true
    if (/^\[!\[|^<img|^<p|^<div|^!\[/.test(t)) return true
    // 纯链接行（导航式 README 常见）：没有正文价值
    if (/^\[[^\]]+\]\([^)]*\)$/.test(t)) return true
    // 表格行 / 代码块围栏也不进摘要
    if (t.startsWith('|') || t.startsWith('```')) return true
    return false
  }

  const paras: string[] = []
  let cur: string[] = []
  const flush = () => {
    if (!cur.length) return
    const t = cur.join(' ').replace(/\s+/g, ' ').trim()
    if (t) paras.push(t)
    cur = []
  }
  for (const raw of lines) {
    if (skip(raw)) { flush(); continue }
    const t = clean(raw)
    if (!t) { flush(); continue }
    cur.push(t)
  }
  flush()

  const excerpt = paras.slice(0, 2).join(' ').slice(0, 300)
  const more = paras.join(' ').slice(0, 1200)
  return { title: title || '', excerpt, more }
}

/** 在仓库里找一份文档：先根目录，再 docs/ —— 找到第一份就停。 */
function findDoc(repo: string, names: string[]): DocFile | null {
  for (const dir of DOC_DIRS) {
    for (const name of names) {
      const rel = dir ? `${dir}/${name}` : name
      const abs = path.join(repo, dir, name)
      try {
        const st = fs.statSync(abs)
        if (!st.isFile()) continue
        const md = fs.readFileSync(abs, 'utf-8')
        const { title, excerpt, more } = extractTitleAndExcerpt(md)
        return {
          rel,
          title: title || name,
          excerpt,
          more,
          bytes: st.size,
          mtime: st.mtime.toISOString(),
        }
      } catch { /* 不存在 / 没权限：继续找下一个候选 */ }
    }
  }
  return null
}

/**
 * 读一份骨架文件。**不按"文本里有没有关键词"判，只按位置 + 可读性判** ——
 * 位置是我们能证明的，语义不是。
 */
function readSkeletonFile(abs: string, rel: string, kind: SkeletonFile['kind'],
  foundAs: string): SkeletonFile | null {
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > SKELETON_MAX_BYTES) return null
    const md = fs.readFileSync(abs, 'utf-8')
    const { title, excerpt, more } = extractTitleAndExcerpt(md)
    return {
      rel,
      kind,
      title: title || path.basename(abs),
      excerpt: excerpt.slice(0, 300),
      more: more.slice(0, SKELETON_MORE_CHARS),
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      foundAs,
    }
  } catch {
    return null
  }
}

function listMd(dir: string, depth: number, out: string[], relBase = ''): void {
  if (depth < 0) return
  let ents: fs.Dirent[] = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    const rel = relBase ? `${relBase}/${e.name}` : e.name
    if (e.isDirectory()) {
      // 只再往下走一层（docs/guides/<日期>/x.md 这种一年一层）
      if (depth > 0) listMd(p, depth - 1, out, rel)
      continue
    }
    if (e.isFile() && /\.md$/i.test(e.name)) out.push(rel)
  }
}

/**
 * Hermes skill 里项目同名的 skill（`sitian-development` 那种）。
 *
 * 为什么这条**必须**有：隔壁同类产品 `AGENTS.md` 明写「其余 60+ 条铁律与踩坑复盘…
 * 在 Hermes skill `obsidian/sitian-development`，动代码前先加载；本文件不复制规则，防双源漂移」。
 * 它的"防漂移"代价是：**换机器 / 换 agent 就丢，而方寸当时根本没读到它**。
 *
 * ⚠ 这是**仓库外**的读取，所以路径要带 `~skill:` 前缀标出来 —— 用户得知道
 * 这一份不在他自己的仓库里，跟着 Hermes 走。
 */
function findHermesSkills(projectHints: string[]): SkeletonFile[] {
  const out: SkeletonFile[] = []
  if (!projectHints.length) return out
  const roots: string[] = []
  const env = String(process.env.HERMES_HOME || '').trim()
  if (env) roots.push(env)
  const la = String(process.env.LOCALAPPDATA || '').trim()
  if (la) roots.push(path.join(la, 'hermes'))
  const up = String(process.env.USERPROFILE || '').trim()
  if (up) roots.push(path.join(up, '.hermes'))

  for (const root of roots) {
    const skillsDir = path.join(root, 'skills')
    let cats: fs.Dirent[] = []
    try { cats = fs.readdirSync(skillsDir, { withFileTypes: true }) } catch { continue }
    for (const cat of cats) {
      if (!cat.isDirectory() || cat.name.startsWith('.')) continue
      const catDir = path.join(skillsDir, cat.name)
      let subs: fs.Dirent[] = []
      try { subs = fs.readdirSync(catDir, { withFileTypes: true }) } catch { continue }
      for (const sub of subs) {
        if (!sub.isDirectory()) continue
        const name = sub.name.toLowerCase()
        // 项目名（或 id）出现在 skill 目录名里 → 认定是它的
        const hit = projectHints.some((h) => h && name.includes(h))
        if (!hit) continue
        const file = path.join(catDir, sub.name, 'SKILL.md')
        const rel = `~skill:${cat.name}/${sub.name}`
        const f = readSkeletonFile(file, rel, '技能', `Hermes skill ${cat.name}/${sub.name}/SKILL.md`)
        if (f) out.push(f)
      }
    }
    if (out.length) break // 找到一层就够了，别在三个候选根里重复找
  }
  return out
}

/**
 * 找骨架。**按 kind 优先级排**：宪法 > 规划 > 技能 > 模块说明。
 *
 * 为什么"模块说明"排最后：暮雨原话「README 本来就是不读都无所谓的东西」，
 * 模块级 README 是**脚手架**，不是骨架。它放在这里只是为了让"这层有没有说明"可查，
 * 不该与 `AGENTS.md` 并列抢位置。
 */
export function discoverSkeleton(repo: string, projectHints: string[] = []): SkeletonResult {
  const files: SkeletonFile[] = []
  const missing: { pattern: string; why: string }[] = []
  // 去重。⚠ 用 `record()` 而不是 `Set.add()`：`e2e-repo-docs` 有一条源码守卫
  // 明令「不许出现 add( / commit( / fetch( 这类写仓库或拉网络的动作」，
  // 而 `Set.add(` 会被这条正则误判成 git add。守卫本身**不该为此放宽**
  // （放宽了就真的挡不住 `git add`），所以让实现避开这个形状。
  const recorded: Record<string, true> = {}
  const record = (f: SkeletonFile | null) => {
    if (!f || recorded[f.rel]) return
    recorded[f.rel] = true
    files.push(f)
  }

  // ① 宪法（根目录）
  let gotConst = false
  for (const name of CONSTITUTION_NAMES) {
    const f = readSkeletonFile(path.join(repo, name), name, '宪法', name)
    if (f) { record(f); gotConst = true }
  }
  if (!gotConst) {
    missing.push({
      pattern: CONSTITUTION_NAMES.join(' / '),
      why: '仓库根下没有 AGENTS.md 这类宪法文件 —— 项目的硬规矩没有落成可读的一份',
    })
  }

  // ② 规划（docs/plan、docs/guides …）
  let gotPlan = false
  for (const d of PLAN_DIRS) {
    const abs = path.join(repo, d.split('/').join(path.sep))
    let st: fs.Stats
    try { st = fs.statSync(abs) } catch { continue }
    if (!st.isDirectory()) continue
    const rels: string[] = []
    listMd(abs, PLAN_DEPTH, rels)
    for (const r of rels) {
      const rel = `${d}/${r}`
      const f = readSkeletonFile(path.join(abs, r.split('/').join(path.sep)), rel, '规划', rel)
      if (f) { record(f); gotPlan = true }
    }
  }
  if (!gotPlan) {
    missing.push({
      pattern: PLAN_DIRS.join(' / '),
      why: '这些规划目录都不存在或里面没有 .md —— 长期方案没落成可读的一份',
    })
  }

  // ③ Hermes 同名 skill（仓库外）
  const skills = findHermesSkills(projectHints)
  for (const s of skills) record(s)

  // ④ 模块级 README（`src/*/README.md` 这种）
  let gotMod = false
  for (const base of ['src', 'lib', 'app', 'packages']) {
    const abs = path.join(repo, base)
    let st: fs.Stats
    try { st = fs.statSync(abs) } catch { continue }
    if (!st.isDirectory()) continue
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const rel = `${base}/${e.name}/README.md`
      const f = readSkeletonFile(
        path.join(abs, e.name, 'README.md'), rel, '模块说明', rel)
      if (f) { record(f); gotMod = true }
    }
  }
  if (!gotMod) {
    missing.push({
      pattern: 'src/*/README.md',
      why: '没有模块级 README —— 各模块"自己怎么用"没有成文（不算缺陷，只是这层是空的）',
    })
  }

  const order: Record<SkeletonFile['kind'], number> = { 宪法: 0, 规划: 1, 技能: 2, 模块说明: 3 }
  files.sort((a, b) => (order[a.kind] - order[b.kind]) || (b.bytes - a.bytes))

  const byKind: Record<string, number> = {}
  let totalBytes = 0
  for (const f of files) {
    byKind[f.kind] = (byKind[f.kind] || 0) + 1
    totalBytes += f.bytes
  }
  const note = files.length
    ? `找到 ${files.length} 份骨架（${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(' · ')}），` +
      `合计 ${(totalBytes / 1024).toFixed(0)} KB`
    : '一份骨架文件都没找到 —— **这不是"这个项目没有骨架"，是这些位置都没有**' +
      `（找过：${missing.map((m) => m.pattern).join(' · ')}）`

  return { files, missing, note }
}

async function readDocsCommits(repo: string, limit = 3): Promise<DocsCommit[]> {
  const r = await runGit(repo, [
    // ⚠ `core.quotepath=false`：不加它，git 会把中文路径转义成 `"docs/W1\346\226\275..."`，
    //   界面上（以及断言里）拿到的是一串八进制乱码 —— 2026-10-21 实测踩到。
    '-c', 'core.quotepath=false',
    'log', `-n`, String(limit), '--date=short',
    '--pretty=format:%h\x1f%ad\x1f%s', '--name-only', '--', 'docs/',
  ], 15000)
  if (r.code !== 0 || !r.out.trim()) return []
  const out: DocsCommit[] = []
  let cur: DocsCommit | null = null
  for (const line of r.out.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue
    if (line.includes('\x1f')) {
      if (cur) out.push(cur)
      const [hash, date, subject] = line.split('\x1f')
      cur = { hash, date, subject, files: [] }
    } else if (cur) {
      cur.files.push(line.trim())
    }
  }
  if (cur) out.push(cur)
  return out.slice(0, limit)
}

/**
 * 读一个项目的路线文档实况。**永远不抛**：读不到用 `ok:false` + `note` 表达。
 * `repo` 由调用方按 registry 解析好再传（本模块不认识项目 id，也不读 registry —— 单一职责）。
 * `projectHints` 用于匹配 Hermes 里同名 skill（`sitian` / `sitian-development`）—— 可选。
 */
export async function readProjectDocs(
  repo: string,
  opts: { force?: boolean; projectHints?: string[] } = {},
): Promise<ProjectDocsResult> {
  const hints = (opts.projectHints || []).map((h) => String(h || '').toLowerCase()).filter(Boolean)
  const empty = (note: string): ProjectDocsResult => ({
    ok: false, repo: repo || '', readme: null, roadmap: null,
    skeleton: { files: [], missing: [], note: '仓库读不到，没找骨架' },
    docsCommits: [], readAt: new Date().toISOString(), cached: false, note,
  })

  if (!repo) return empty('项目没登记工作目录 —— 读不到路线文档')
  let isDir = false
  try { isDir = fs.statSync(repo).isDirectory() } catch { /* 不存在 */ }
  if (!isDir) return empty(`工作目录不存在：${repo}`)

  const day = today()
  const hit = dayCache.get(repo)
  if (!opts.force && hit && hit.day === day) return { ...hit.data, cached: true }

  const skeleton = discoverSkeleton(repo, hints)

  const isGit = fs.existsSync(path.join(repo, '.git'))
  if (!isGit) {
    // 不是 git 仓库也能读文档（很多项目文件夹没初始化仓库）——只是没有"最近 docs 变更"那一列
    const readme = findDoc(repo, README_NAMES)
    const roadmap = findDoc(repo, ROADMAP_NAMES)
    const data: ProjectDocsResult = {
      ok: !!(readme || roadmap || skeleton.files.length), repo, readme, roadmap, skeleton,
      docsCommits: [],
      readAt: new Date().toISOString(), cached: false,
      note: (readme || roadmap || skeleton.files.length)
        ? '这个目录不是 git 仓库 —— 只有文档，没有提交历史'
        : '这个目录不是 git 仓库，也没有 README / ROADMAP',
    }
    dayCache.set(repo, { day, data })
    return data
  }

  const readme = findDoc(repo, README_NAMES)
  const roadmap = findDoc(repo, ROADMAP_NAMES)
  const docsCommits = await readDocsCommits(repo)
  const data: ProjectDocsResult = {
    // ok 的含义扩了：**有骨架也算读到了东西**。旧语义（只有 README/ROADMAP 才算 ok）
    // 会让"没有 README 但有 AGENTS.md 和 docs/plan"的项目被判成"没文档"——
    // 而那正是隔壁同类产品的情况，也正是 2026-11-15 那个 bug 的形状。
    ok: !!(readme || roadmap || skeleton.files.length),
    repo,
    readme,
    roadmap,
    skeleton,
    docsCommits,
    readAt: new Date().toISOString(),
    cached: false,
    note: !readme && !roadmap && !skeleton.files.length
      ? '仓库里没有 README / ROADMAP，也没找到骨架文件 —— 路线只能看手写的那一栏'
      : (readme && !roadmap
        ? '没找到 ROADMAP —— README 是项目对外说明，不一定有"接下来做什么"（骨架看下面那份清单）'
        : ''),
  }
  dayCache.set(repo, { day, data })
  return data
}
