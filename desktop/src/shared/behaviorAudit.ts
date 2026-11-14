/**
 * 行为审计（2026-11-14 · 卡 拷问-ai把ai-本该自己做却没做变成开-252bf521）
 *
 * 暮雨原话（2026-11-11）：
 *   「刚才本地 AI 又被我连骂四回，没读设定自己瞎搞，找东西都不知道去哪里找，
 *     浪费 token 搜永远不可能找到的地方，记忆技能都不读，我连骂四回全中。
 *     方寸如果能够更好地骂 AI，把一堆 AI 本来就该自己做却不做的地方找出来狠狠拷问，
 *     会不会提升工作质量？」
 *
 * ## 当天就定下的判断（这条必须原样保留，别重新发明）
 * · 骂得中是因为**四个全是事实判据**（读没读某文件 / 搜的路径在不在已知地址库），零个品味判断；
 * · 起作用的是两件事：**判据注入 + 打回**；语气狠度**零贡献**；
 * · 结论：**不是方寸学会骂，是方寸让你不需要骂** —— 把判据前置，骂就消失了；
 * · **安全区 = 行为审计**（读没读 / 搜没搜 / 调没调），**危险区 = 质量裁决**（会死循环）。
 *
 * ## 这个文件能验什么、不能验什么（**最重要的一段**）
 *
 * 方寸的 MCP 服务**看不到** agent 的 `read_file` / `bash` —— 那些发生在 client 那一侧。
 * 所以「你真的读了 settings.md 吗」我们**无法**直接证明。
 * 假装能证明（比如"声明了就当你读了"）＝ 又造一个"看着像闸、其实什么也没拦"的东西，
 * 正是这个仓反复踩的坑。
 *
 * 那能验什么？**agent 与方寸之间那一层的行为**，全部可验：
 *   ① 它**声明**这轮要读哪些东西（卡 / 文件 / 命令）—— 声明本身是事实；
 *   ② 它**真的通过 MCP 读了**哪些 —— `mcp-usage.jsonl` 里有记录（recordRead 早就在写）；
 *   ③ 它**交付时**声称读了的，与 ①② 能不能对上 —— 对不上就是**自己打自己脸**，这是最硬的信号；
 *   ④ 它有没有在**没声明**的情况下动手写（越界），或**声明了却没做**（空头支票）。
 *
 * 一句话：**审计「说了什么」与「做了什么」是否一致**，不审计「心里怎么想」。
 * 这是诚实的那一半，而且它真的能抓出「嘴上说读了、其实没读」。
 *
 * ## 死循环红线
 * 不做任何"质量好不好"的判断。所有判据都是**集合比对**（声明集合 vs 实际集合），
 * 没有模型参与，没有主观分，跑多少次结果一样。
 */

/** 声明/实际里的一项行为。`kind` 用开放字符串，不锁死（以后加 ipc / http 不必改类型） */
export interface AuditRef {
  kind: string
  /** 定位符：卡 id / 文件相对路径 / 命令名 */
  id: string
}

/** 一份「开工声明」 */
export interface AuditDeclaration {
  /** 声明时间（ISO） */
  ts: string
  project?: string
  /** 这轮开工前声明"我要读/要做这些" */
  plan: AuditRef[]
}

/** 交付时的自报：这轮实际读了/做了什么（agent 自己写） */
export interface AuditClaim {
  did: AuditRef[]
}

export type AuditVerdict =
  | 'ok'                 // 声明了、也做了
  | 'claimed-not-read'   // **声称读了，但 MCP 侧没有记录** —— 最硬的信号
  | 'declared-not-done'  // 声明了要做，交付时既没做也没解释
  | 'undeclared'         // 没声明就动手
  | 'no-declaration'     // 根本没声明（这轮没走审计）

export interface AuditRow {
  ref: AuditRef
  verdict: AuditVerdict
  /** 一句话说明（给界面/给 agent 看，必须能指出"差在哪"） */
  why: string
}

export interface AuditReport {
  /** 这轮有没有声明 */
  declared: boolean
  rows: AuditRow[]
  /** 按 verdict 计数（不含 ok） */
  counts: Record<Exclude<AuditVerdict, 'ok'>, number>
  /** 一句话结论；没有问题时为空串（不写"全部合格"这种废话） */
  summary: string
}

/** 把 ref 归一成可比对键（kind 小写 + id 去掉首尾空白与 ./ 前缀） */
export function auditKey(r: AuditRef): string {
  const kind = String(r?.kind || '').trim().toLowerCase()
  let id = String(r?.id || '').trim().replace(/\\/g, '/')
  // 统一 `./a/b` 与 `a/b`：不然后者永远匹配不上前者
  id = id.replace(/^\.\//, '').replace(/\/+/g, '/')
  return kind + ':' + id
}

/** 数组 → 键集合（去重） */
function keySet(refs: AuditRef[]): Set<string> {
  const s = new Set<string>()
  for (const r of Array.isArray(refs) ? refs : []) {
    if (!r || !String(r.id || '').trim()) continue
    s.add(auditKey(r))
  }
  return s
}

/**
 * 核对一轮：声明 vs 实际。
 *
 * @param decl    开工声明（null = 这轮根本没声明）
 * @param claim   交付自报"我做了什么"
 * @param observed MCP 侧**客观记录**到的行为（卡级读记录就在这里）
 *
 * 判定顺序（每条只给一个结论，不叠加）：
 *   ① 声称 `did` 里有、但 observed 与 decl 都没有 → `claimed-not-read`
 *      （这是最值钱的一条：嘴上说读了，两边都对不上）
 *   ② 声明里有、实际既没做也没在 claim 里说明 → `declared-not-done`
 *   ③ 做了（observed 里有）但声明里没有 → `undeclared`
 *   ④ 其余 → ok
 */
export function auditRound(
  decl: AuditDeclaration | null,
  claim: AuditClaim | null,
  observed: AuditRef[] = [],
): AuditReport {
  const counts = { 'claimed-not-read': 0, 'declared-not-done': 0, undeclared: 0, 'no-declaration': 0 }

  if (!decl || !Array.isArray(decl.plan) || !decl.plan.length) {
    // 没声明就不逐条判 —— 只报一个总数，别把"没走审计"演成"几十条不合格"
    return {
      declared: false,
      rows: [],
      counts: { ...counts, 'no-declaration': 1 },
      summary: '这轮没有开工声明 —— 行为审计没有依据，不做判定。补一份声明再来核。',
    }
  }

  const declaredSet = keySet(decl.plan)
  const didSet = keySet(claim?.did || [])
  const seenSet = keySet(observed)

  const rows: AuditRow[] = []

  // ① 声称读了、但没有任何客观痕迹（既不在声明里，也没被观测到）
  for (const r of claim?.did || []) {
    if (!String(r?.id || '').trim()) continue
    const k = auditKey(r)
    if (seenSet.has(k) || declaredSet.has(k)) continue
    rows.push({ ref: r, verdict: 'claimed-not-read', why: '交付时说做了，但 MCP 侧没有记录、开工声明里也没有 —— 两边都对不上' })
  }

  // ② 声明了却没做（claim 里也没认领）
  for (const r of decl.plan) {
    if (!String(r?.id || '').trim()) continue
    const k = auditKey(r)
    if (seenSet.has(k) || didSet.has(k)) continue
    rows.push({ ref: r, verdict: 'declared-not-done', why: '开工前说了要做，交付时既没做、也没在这轮的说明里解释为什么没做' })
  }

  // ③ 做了但没声明（越界）
  for (const r of observed) {
    if (!String(r?.id || '').trim()) continue
    const k = auditKey(r)
    if (declaredSet.has(k)) continue
    rows.push({ ref: r, verdict: 'undeclared', why: '动了声明范围外的东西 —— 开工前没说要做这个' })
  }

  for (const row of rows) {
    if (row.verdict !== 'ok') counts[row.verdict as Exclude<AuditVerdict, 'ok'>]++
  }

  const bad = rows.filter((r) => r.verdict !== 'ok')
  const summary = bad.length
    ? `这轮有 ${bad.length} 处"说的和做的不一致"：`
      + [
        counts['claimed-not-read'] ? `声称读了但无痕迹 ${counts['claimed-not-read']} 处` : '',
        counts['declared-not-done'] ? `声明了没做 ${counts['declared-not-done']} 处` : '',
        counts.undeclared ? `越界动手 ${counts.undeclared} 处` : '',
      ].filter(Boolean).join(' · ')
    : ''

  return { declared: true, rows: rows.sort((a, b) => a.verdict.localeCompare(b.verdict)), counts, summary }
}

/**
 * 从 `mcp-usage.jsonl` 的读卡记录转成审计用的 observed。
 *
 * 只认 `task` 这一种 kind —— 文件/命令的读取 MCP 看不见（见文件头那段），
 * 硬把它们算成"没读"就是冤枉，算成"读了"就是假账。**不认的部分就不认**。
 */
export function observedFromReadStats(stats: Map<string, { reads: number }>, taskIds: string[]): AuditRef[] {
  const out: AuditRef[] = []
  for (const id of Array.isArray(taskIds) ? taskIds : []) {
    const s = stats.get(String(id))
    if (s && s.reads > 0) out.push({ kind: 'task', id: String(id) })
  }
  return out
}

/** 给界面/工具用：把报告压成一行可读文本（不改内容，只排版） */
export function auditReportText(rep: AuditReport): string {
  if (!rep.declared) return rep.summary || '没有开工声明。'
  if (!rep.rows.length) return '行为审计：声明与交付一致，没有发现"说的和做的不一致"。'
  const lines = [rep.summary]
  for (const r of rep.rows) {
    lines.push(`· [${r.verdict}] ${r.ref.kind}:${r.ref.id} —— ${r.why}`)
  }
  return lines.join('\n')
}
