/**
 * 竞品档案 · 主进程（2026-11-17）
 *
 * ## 由来
 *
 * 竞品能力 2026-10-17 就拍了方向、11-07 做完了**数据层 + CLI**
 * （`tegula competitor add/list/report`），但**桌面端一个界面都没有** ——
 * 实测 `desktop/src` 下 0 个文件提到 competitor。
 *
 * 后果：没人知道有这功能 → 永远没人登记 → 永远没数据。
 * 卡上当初的理由是「页签是展示层，没数据前做了是空壳」，
 * 但那句话反过来把前提锁死了。这是本仓「链路做了一半、入口没做」的典型样本。
 *
 * ## 三条边界（与 Python 侧同一套口径，不另立）
 *
 * ① **只读为主**：本模块读 registry 的 `competitors` 段 + 读采集回填目录。
 *    写只做一件 —— 往回填目录写「采集任务单」给 agent，**不写项目仓库**。
 * ② **方寸不联网、不自建爬虫**（REV-007 拍板 C 方案）：采集由 agent 执行，
 *    方寸只出单子、只存结果。
 * ③ **没数据就说没数据**：不许输出一张空表冒充"已经采过了"。
 *    `pending` 与 `none` 分开 —— 「登记了但没采」和「压根没登记」是两回事。
 */
import * as fs from 'fs'
import * as path from 'path'
import { parseRegistry, getDataDir } from '../data'

export interface Competitor {
  name: string
  url: string
  focus: string
}

export interface CompetitorRow {
  projectId: string
  projectName: string
  competitors: Competitor[]
  /** 回填目录里已有的采集结果文件（文件名，按新到旧） */
  reports: string[]
  /** 采集任务单是否已生成 */
  taskFile: boolean
}

export interface CompetitorOverview {
  ok: boolean
  error?: string
  rows?: CompetitorRow[]
  /** 哪些项目登记了竞品、哪些还没有（一句话统计） */
  summary?: { total: number; withCompetitors: number; withReports: number }
  /** 回填目录绝对路径（界面上要能直接看到、能打开） */
  dir?: string
}

/** 采集数据与任务单落点：数据根下的 `task-data/competitors/<pid>/` */
export function competitorsDir(projectId = ''): string {
  const base = path.join(getDataDir(), 'task-data', 'competitors')
  return projectId ? path.join(base, String(projectId)) : base
}

/**
 * 从 registry 读竞品段。
 *
 * ⚠ 不能用 `parseRegistry` 的结果直接取 `p.competitors` 吗？——可以，但有个坑：
 *   Python 侧 2026-11-07 实测过「`parse_registry` 会把 `- name: 竞品` 当成另一个项目」。
 *   TS 侧走的是 `yaml.load` 拿整体对象，`competitors` 是**项目对象的属性**，不会串成项目。
 *   这里仍然按"只认对象上的 competitors 数组、并逐条过滤形状"来写，不信任任意结构。
 */
function readCompetitors(): { ok: boolean; error?: string; map: Map<string, Competitor[]>; names: Map<string, string> } {
  const map = new Map<string, Competitor[]>()
  const names = new Map<string, string>()
  let list: any[]
  try {
    list = parseRegistry(true)
  } catch (e: any) {
    return { ok: false, error: 'registry 读不出来：' + (e?.message || e), map, names }
  }
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const id = String(p.id || '').trim()
    if (!id) continue
    names.set(id, String(p.name || id))
    const raw = p.competitors
    if (!Array.isArray(raw)) continue
    const rows: Competitor[] = []
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue
      const name = String(c.name || '').trim()
      if (!name) continue          // 没名字的不算一条（宁可少列，不列空壳）
      rows.push({
        name,
        url: String(c.url || '').trim(),
        focus: String(c.focus || '').trim(),
      })
    }
    if (rows.length) map.set(id, rows)
  }
  return { ok: true, map, names }
}

/** 列出某个项目目录下已有的采集结果（.md 文件，新到旧） */
function listReports(projectId: string): string[] {
  const dir = competitorsDir(projectId)
  let items: fs.Dirent[]
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { f: string; t: number }[] = []
  for (const it of items) {
    if (!it.isFile()) continue
    if (!/\.md$/i.test(it.name)) continue
    if (it.name.startsWith('采集任务单')) continue   // 任务单不是采集结果
    try {
      const st = fs.statSync(path.join(dir, it.name))
      out.push({ f: it.name, t: st.mtimeMs })
    } catch { /* 单个文件读不到就跳过，不拖垮整页 */ }
  }
  return out.sort((a, b) => b.t - a.t).map((x) => x.f)
}

function hasTaskFile(projectId: string): boolean {
  const dir = competitorsDir(projectId)
  try {
    return fs.readdirSync(dir).some((f) => f.startsWith('采集任务单') && f.endsWith('.md'))
  } catch {
    return false
  }
}

/**
 * 竞品总览：所有登记过竞品的项目 + 各自的采集状态。
 *
 * 返回里的 `rows` **只含登记过竞品的项目** —— 15 个项目里没登记的不占版面
 * （这一页是"你有竞品要看"，不是"项目清单"）。
 */
export function competitorOverview(): CompetitorOverview {
  const r = readCompetitors()
  if (!r.ok) return { ok: false, error: r.error }
  const rows: CompetitorRow[] = []
  for (const [pid, competitors] of r.map) {
    rows.push({
      projectId: pid,
      projectName: r.names.get(pid) || pid,
      competitors,
      reports: listReports(pid),
      taskFile: hasTaskFile(pid),
    })
  }
  rows.sort((a, b) => b.reports.length - a.reports.length
    || a.projectName.localeCompare(b.projectName, 'zh'))
  return {
    ok: true,
    rows,
    summary: {
      total: r.names.size,
      withCompetitors: rows.length,
      withReports: rows.filter((x) => x.reports.length > 0).length,
    },
    dir: competitorsDir(),
  }
}

/** 读一份采集结果原文（界面点开看） */
export function readReport(projectId: string, fileName: string): { ok: boolean; text?: string; error?: string } {
  const safe = path.basename(String(fileName || ''))
  if (!safe || !/\.md$/i.test(safe)) return { ok: false, error: '只能读 .md 采集结果' }
  const pid = String(projectId || '').trim()
  if (!pid || /[\\/]/.test(pid)) return { ok: false, error: '项目 id 非法' }
  const p = path.join(competitorsDir(pid), safe)
  try {
    return { ok: true, text: fs.readFileSync(p, 'utf-8') }
  } catch (e: any) {
    return { ok: false, error: '读不到：' + (e?.message || e) }
  }
}

/**
 * 生成采集任务单（**唯一会写盘的动作**）。
 *
 * 写给谁：agent。所以是 Markdown、且**不含任何密钥**（与 Python 侧同一条红线）。
 * 写到哪：数据根下 `task-data/competitors/<pid>/采集任务单-YYYY-MM-DD.md`，
 *        **不写项目仓库**（契约 ③ 方寸对项目 repo 只读）。
 */
export function writeTaskFile(projectId: string): { ok: boolean; path?: string; error?: string } {
  const pid = String(projectId || '').trim()
  if (!pid || /[\\/]/.test(pid)) return { ok: false, error: '项目 id 非法' }
  const r = readCompetitors()
  if (!r.ok) return { ok: false, error: r.error }
  const list = r.map.get(pid)
  if (!list || !list.length) return { ok: false, error: `「${pid}」没有登记任何竞品，没有可采的` }

  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const dir = competitorsDir(pid)
  const file = path.join(dir, `采集任务单-${day}.md`)

  const lines: string[] = [
    `# 竞品采集任务单 · ${pid}（${day}）`,
    '',
    '> 这份单子是给 **agent** 执行的：方寸不联网、不自建爬虫（REV-007 拍板 C 方案）。',
    `> 采集完把结果写成 md 回填到 \`task-data/competitors/${pid}/\` 下，界面「项目 → 竞品」里就能看到。`,
    '> **本单不含任何密钥** —— 需要凭据的页面一律跳过，不要往这里写 token。',
    '',
    '## 要采的',
    '',
    '| 竞品 | 地址 | 关注什么 |',
    '|---|---|---|',
  ]
  for (const c of list) {
    lines.push(`| ${c.name} | ${c.url} | ${c.focus || '（没写）'} |`)
  }
  lines.push(
    '',
    '## 每个竞品要回填什么',
    '',
    '1. **它现在做了什么**（功能面，尽量具体）',
    '2. **和方寸重合 / 不重合的地方**（重合的部分谁做得更好，为什么）',
    '3. **值得抄的一条**（只一条，写清抄哪个交互、不是抄哪个功能）',
    '4. **结论**：威胁 / 参考 / 无关',
    '',
    '## 回填格式',
    '',
    '文件名随意（`.md` 结尾即可），建议 `YYYY-MM-DD-竞品名.md`，开头一行写清采集日期与来源地址。',
  )

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, lines.join('\n'), 'utf-8')
    // 写后读回自证：不靠"写成功"的返回值，靠文件真的在
    if (!fs.existsSync(file)) return { ok: false, error: '写后读不到文件（写盘可能失败）' }
    return { ok: true, path: file }
  } catch (e: any) {
    return { ok: false, error: '写任务单失败：' + (e?.message || e) }
  }
}
