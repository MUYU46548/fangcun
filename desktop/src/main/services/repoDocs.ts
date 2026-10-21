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

export interface ProjectDocsResult {
  ok: boolean
  /** 读的是哪个仓库（界面不展示，排障/断言用） */
  repo: string
  readme: DocFile | null
  roadmap: DocFile | null
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
 * 2026-10-21 暮雨反馈「README 只截一行，通常没什么有用信息」—— 第一段常常是一句标语
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
 * 最近动过 `docs/` 的提交（施工日志的文档级实况）。
 * 为什么限定 `docs/`：用户要的是"文档级实况"，不是第二次列 git 活动 ——
 * 后者监控台已经有（`ms-git` 那行来自在途一屏）。这里只看"文档最近被谁改过"。
 */
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
 */
export async function readProjectDocs(repo: string, opts: { force?: boolean } = {}): Promise<ProjectDocsResult> {
  const empty = (note: string): ProjectDocsResult => ({
    ok: false, repo: repo || '', readme: null, roadmap: null, docsCommits: [],
    readAt: new Date().toISOString(), cached: false, note,
  })

  if (!repo) return empty('项目没登记工作目录 —— 读不到路线文档')
  let isDir = false
  try { isDir = fs.statSync(repo).isDirectory() } catch { /* 不存在 */ }
  if (!isDir) return empty(`工作目录不存在：${repo}`)

  const day = today()
  const hit = dayCache.get(repo)
  if (!opts.force && hit && hit.day === day) return { ...hit.data, cached: true }

  const isGit = fs.existsSync(path.join(repo, '.git'))
  if (!isGit) {
    // 不是 git 仓库也能读文档（很多项目文件夹没初始化仓库）——只是没有"最近 docs 变更"那一列
    const readme = findDoc(repo, README_NAMES)
    const roadmap = findDoc(repo, ROADMAP_NAMES)
    const data: ProjectDocsResult = {
      ok: !!(readme || roadmap), repo, readme, roadmap, docsCommits: [],
      readAt: new Date().toISOString(), cached: false,
      note: (readme || roadmap)
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
    ok: !!(readme || roadmap),
    repo,
    readme,
    roadmap,
    docsCommits,
    readAt: new Date().toISOString(),
    cached: false,
    note: !readme && !roadmap
      ? '仓库里没有 README / ROADMAP —— 路线只能看手写的那一栏'
      : (readme && !roadmap
        ? '没找到 ROADMAP —— 下面的 README 是项目对外说明，不一定有"接下来做什么"'
        : ''),
  }
  dayCache.set(repo, { day, data })
  return data
}
