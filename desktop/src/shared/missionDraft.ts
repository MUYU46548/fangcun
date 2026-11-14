/**
 * 从仓库 README 起草「使命」（2026-11-14 · 长 Loop P1-2）
 *
 * ## 为什么要有这个文件
 *
 * 暮雨的原话是 P1-2 的判据：14 个项目里有 7 个的「使命」是空的。
 * 我查了那 7 个项目的仓库，**6 个的 README 里已经写清了它是干嘛的** ——
 * 也就是说，"使命空"不是"没人知道"，而是**方寸从没去读项目现实**。
 * （同一个病：P2-3「计划器只读方寸自己的账本，不读项目 README」早已成立。）
 *
 * ## 但绝不自动填
 *
 * 使命是**用户对项目的定义**，不是仓库的。README 说"半自动长篇小说生成系统"，
 * 用户可能想强调的完全是另一件事（比如"我只要它能跑完八阶段就行"）。
 * 所以这里的产出**只是草稿**：一条能一键采纳、也可随手改的建议。
 *
 * 三条纪律（都有断言钉着）：
 *  ① **必须能追到原文**：草稿的每个字都要能从 README 里逐字找回（`sourceText`），
 *     不许改写、不许润色、不许补主语 —— 一旦"顺手写通顺一点"，就变成我在编。
 *  ② **抽不出就明说**：README 缺失 / 只有标题 / 抽出来是"本项目使用AI辅助"这种
 *     没有信息量的句子 → `ok:false` + 一句话原因，**不糊一条凑数**。
 *  ③ **不覆盖已有使命**：已经写了的不再建议（那是他的东西，我只补空的）。
 */

/**
 * 「使命到底填了没有」——**不能只看是不是空串**。
 *
 * 2026-11-14 真跑踩到的：`policies/*.md` 里没填的项目，值不是空串而是
 * **`（未填写）`** 这个占位符（`policies.ts` 写骨架时填的）。
 * 第一版判断写成 `if (mission.trim())` → 把 7 个"未填写"全当成已有使命跳过，
 * 于是一个草稿都不出。
 *
 * 这与本仓的老病同源：「骨架提示不算内容」（`extractVerified`、`isUnjudged` 都栽过）。
 * 所以这里列出所有**占位符形态**，并额外把"只有标点/括号/占位词"的也算空。
 */
const MISSION_PLACEHOLDERS = [
  '未填写', '待填写', '待填', '未填', '空', '无', '暂无', '待定', 'TBD', 'TODO',
  '一句话：这项目是干嘛的', '这项目是干嘛的',
]

/** 使命是不是"没填"（空 / 占位符 / 只有标点） */
export function isMissionEmpty(raw: unknown): boolean {
  const t = stripInlineMd(String(raw ?? ''))
  if (!t) return true
  // 去掉括号/顿号/空白后只剩占位词
  const bare = t.replace(/[（）()\[\]【】\s、，,。.：:；;—\-_/]/g, '')
  if (!bare) return true
  for (const p of MISSION_PLACEHOLDERS) {
    if (bare === p.replace(/[（）()\[\]【】\s、，,。.：:；;—\-_/]/g, '')) return true
  }
  // 「（未填写）」这类：整句就是一个括号包着的占位词
  if (/^[（(【\[]?\s*(未|待)填(写)?\s*[）)】\]]?$/.test(t)) return true
  return false
}

/** 一条使命建议 */
export interface MissionDraft {
  /** 项目 id */
  project: string
  /** 建议的使命（**逐字来自 README**，未改写） */
  draft: string
  /** 这句话的来源（README 里的原文片段，供核对） */
  sourceText: string
  /** 来源文件（相对仓库路径，如 `README.md`） */
  sourceFile: string
  /** 置信度提示：`title`（只有标题可用）/ `excerpt`（正文摘要） */
  from: 'title' | 'excerpt'
  /** 抽不出来时的原因；能抽出来则为空串 */
  reason: string
}

/** 使命草稿最长多少字（超过就截断并标记 —— 使命是一句话，不是简介） */
export const MISSION_MAX = 120

/**
 * 「这句话有没有信息量」的判据。
 *
 * 实测踩到的（2026-11-14 真跑，两次）：
 *   · `songtao-zhenyun`：「本项目**使用AI辅助制作**。」被当成使命
 *   · `sitian`：「本项目**在开发阶段使用 AI 辅助制作**；」
 *   · `python-workspace`：「[! important] 重要提示 本仓库仅用于…」—— Obsidian callout 标记混进正文
 *
 * 所以判定前**必须先剥 Markdown 标记**（`**`、callout 的 `[!x]`），
 * 否则同一个意思换个写法就漏网 —— 这正是"正则只对第一条样本有效"的典型。
 */
const NOISE_PATTERNS = [
  /^本项目.{0,20}(使用|采用|由).{0,14}(辅助|制作|开发|生成)/,
  /^本(仓库|项目).{0,16}(仅|只)(用于|供).{0,20}(个人|学习|备份)/,
  /^作者[:：]/,
  /^爱发电/,
  /^感谢/,
  /^重要提示/,
  /^本项目(使用|采用).{0,10}许可/,
  /^使用\s*AI\s*辅助/,
  /^\[!\[/,
  /^!\[/,
]

/** 剥掉 Markdown 行内标记，只留下"读者会读到的字" */
export function stripInlineMd(s: string): string {
  return String(s || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // 图片
    // 链接保留文字。⚠ 剥完之后要**吃掉中文两侧冒出来的空格**：
    //   `本仓库是 [ROSA 系统](url) 的源代码` 第一版剥成「本仓库是 ROSA 系统 的源代码」
    //   —— 中文里不该有那两处空格（实测 quartz 那条草稿就是这么带出来的）。
    //   只收紧「中文/标点 与 中文/标点 之间」的空格，英文单词之间不动。
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\s*!\s*[a-zA-Z]+\s*\][-+]?/g, ' ')  // Obsidian callout（含 `[! x]` 空格写法）
    .replace(/[*_`~]{1,3}/g, '')                // 强调/删除线/行内代码
    .replace(/<[^>]+>/g, ' ')                   // 内联 HTML
    .replace(/([\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef])\s+(?=[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 这句话是不是"没有信息量的套话" */
export function isNoiseSentence(s: string): boolean {
  const t = stripInlineMd(s)
  if (!t) return true
  // 太短（"欢迎"、"简介"）不算
  if (t.replace(/[\s\p{P}]/gu, '').length < 8) return true
  for (const re of NOISE_PATTERNS) if (re.test(t)) return true
  return false
}

/**
 * 从 Markdown 正文抽一句"能当使命"的话。
 *
 * 顺序：先看有没有一句引言（`> …`）—— README 里最像"定位"的常常就是那句；
 * 再按段落找第一个**有信息量**的句子。
 * 抽不到返回空串（调用方据此报 `reason`，不许糊）。
 */
export function pickMissionSentence(md: string): string {
  const text = String(md || '')
  // 去掉代码块 / 图片 / HTML 注释（它们不是"项目是什么"的陈述）
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/^\s*#{1,6}\s+.*$/gm, ' ')   // 标题整行去掉（标题另有兜底）
    .replace(/^\s*[-*|].*$/gm, ' ')       // 列表与表格不算"一句话定位"
    .replace(/\|/g, ' ')

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  // ① 引言块优先
  for (const p of paragraphs) {
    const q = p.replace(/^>\s?/gm, '').trim()
    if (!q) continue
    for (const s of splitSentences(q)) {
      if (!isNoiseSentence(s)) return s
    }
  }
  // ② 普通段落
  for (const p of paragraphs) {
    for (const s of splitSentences(p)) {
      if (!isNoiseSentence(s)) return s
    }
  }
  return ''
}

/** 按中文句号/问号/叹号/换行断句（英文句号后面必须跟空格或结尾，避免切坏 `Quartz 5.0`） */
export function splitSentences(s: string): string[] {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (!t) return []
  return t
    .split(/(?<=[。！？；])|(?<=\.)\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 把"一句话"收成适合放进使命格的长度。
 * 只**截断**，不改写 —— 截断处补 `…` 并让调用方知道（`truncated`）。
 */
export function clipMission(s: string, max = MISSION_MAX): { text: string; truncated: boolean } {
  // ⚠ 使命是要写进方针卡给人读的**纯文本**，所以落盘前必须剥 Markdown 标记
  //   （`**粗体**`、callout 的 `[!important]`）—— 否则界面会原样印出星号。
  //   这条与 check-ui-copy 同源：本仓栽过"Markdown 标记漏进界面文案"。
  const t = stripInlineMd(s)
  if (t.length <= max) return { text: t, truncated: false }
  return { text: t.slice(0, max - 1).replace(/[，,、；;：:\s]+$/, '') + '…', truncated: true }
}

/** 从 README 全文 + 已有标题，产出一条使命建议 */
export function draftMissionFromReadme(
  project: string,
  md: string,
  opts: { sourceFile?: string; fallbackTitle?: string } = {},
): MissionDraft {
  const sourceFile = opts.sourceFile || 'README.md'
  const base: MissionDraft = {
    project, draft: '', sourceText: '', sourceFile, from: 'excerpt', reason: '',
  }
  const raw = String(md || '')
  if (!raw.trim()) {
    return { ...base, reason: '仓库里没有 README（或它是空的）—— 无从起草，得你给一句话' }
  }

  const sentence = pickMissionSentence(raw)
  if (!sentence) {
    // 正文抽不出 → 退而用一级标题（很多 README 只有标题 + 徽章）
    const title = String(opts.fallbackTitle || '').trim()
    if (title && !isNoiseSentence(title)) {
      const { text, truncated } = clipMission(title)
      return {
        ...base, draft: text, sourceText: title, from: 'title',
        // 退回标题时必须**明说**这是次优来源（标题往往只说名字，不说它是干嘛的），
        // 否则人以为草稿是"从正文抽的"，点采纳就得到一句信息量很低的话。
        reason: truncated
          ? '只有标题可用且已截断 —— 建议你补半句"它是干嘛的"'
          : '正文里没有能当使命的句子，这句只是**标题** —— 建议补半句"它是干嘛的"',
      }
    }
    return { ...base, reason: 'README 里没有能当使命的句子（只有标题/徽章/套话）—— 得你给一句话' }
  }

  const { text, truncated } = clipMission(sentence)
  return {
    ...base,
    draft: text,
    sourceText: sentence,
    from: 'excerpt',
    reason: truncated ? `原文较长，已截到 ${MISSION_MAX} 字（截断处补…，未改写）` : '',
  }
}

/**
 * 批量生成建议，并**只对使命为空的项目出草稿**（已有使命的不建议覆盖）。
 *
 * @param projects [{id, mission}]
 * @param readmeOf (id) => {md, sourceFile} | null
 */
export function draftMissions(
  projects: Array<{ id: string; mission?: string; title?: string }>,
  readmeOf: (id: string, repo?: string) => { md: string; sourceFile: string } | null,
  repoOf?: (id: string) => string,
): { drafts: MissionDraft[]; skippedHasMission: string[]; total: number } {
  const drafts: MissionDraft[] = []
  const skippedHasMission: string[] = []
  const list = Array.isArray(projects) ? projects : []
  for (const p of list) {
    // ⚠ 用 isMissionEmpty 而不是 `!p.mission.trim()` —— 空使命的真实值是「（未填写）」
    if (!isMissionEmpty(p.mission)) { skippedHasMission.push(p.id); continue }
    const got = readmeOf(p.id, repoOf ? repoOf(p.id) : undefined)
    if (!got) {
      drafts.push({
        project: p.id, draft: '', sourceText: '', sourceFile: '', from: 'excerpt',
        reason: '仓库里没有 README —— 无从起草，得你给一句话',
      })
      continue
    }
    drafts.push(draftMissionFromReadme(p.id, got.md, {
      sourceFile: got.sourceFile, fallbackTitle: p.title,
    }))
  }
  return { drafts, skippedHasMission, total: list.length }
}
