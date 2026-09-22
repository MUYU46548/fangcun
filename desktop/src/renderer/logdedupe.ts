/**
 * 日志导入的去重指纹（2026-09-22）
 *
 * 用户原话：「同名拦截已经生效，虽然防呆不防傻（改名但实际内容相同），但已经够用。」
 * → 这一版把"防傻"补上：**内容指纹**比对，改名绕不过去。
 *
 * 为什么独立成模块：指纹必须可测。规范化规则（换行/空白/大小写/首行标题）只要有一点偏差，
 * 去重就会时灵时不灵，而这种错误在界面上只表现为"有时候没拦住"，肉眼极难复现。
 * 纯函数、不依赖 Vue/DOM，可被 scripts/test/e2e-logdedupe.cjs 直接编译断言。
 */

export interface ImportItem {
  title: string
  text: string
}

export interface ExistingLogLike {
  title?: string
  content?: string
}

export interface ClassifyResult {
  /** 可以导入的 */
  fresh: ImportItem[]
  /** 标题已存在（跳过） */
  dupTitle: string[]
  /** 标题不同但内容相同（跳过）—— 改名绕不过去的那一类 */
  dupContent: string[]
  /** 同一批文件内部重复的 */
  dupInBatch: string[]
}

/**
 * 规范化：抹掉与"是不是同一份内容"无关的差异。
 *  - 统一换行（CRLF/CR → LF）
 *  - 每行去首尾空白、丢掉纯空行
 *  - 大小写不敏感（同一份文本复制两次很少只差大小写）
 *  - 首行若是 markdown 标题、或**恰好等于文件名标题**，则忽略
 *    （同一个文件被导出/改名再拖回来时，首行标题常被剥掉，不该因此判为新内容）
 *
 * @param title 可选：文件名（日志标题）。给了就把首行等于它的行剥掉。
 */
export function normalizeLogText(s: unknown, title?: string): string {
  const text = String(s ?? '')
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
  if (lines.length) {
    const head = lines[0]
    const bare = head.replace(/^#{1,3}\s+/, '').trim()
    const t = String(title ?? '').trim()
    if (/^#{1,3}\s+/.test(head) || (t && bare.toLowerCase() === t.toLowerCase())) {
      lines.shift()
    }
  }
  return lines.join('\n').toLowerCase()
}

/**
 * FNV-1a 32 位 + 长度后缀。
 * 不用 crypto：这里是"去重提示"，不是安全用途；同步、零依赖、可预期即可。
 * 长度一起进指纹，避免只比 32 位哈希时不同长度文本的偶然碰撞。
 */
export function textFingerprint(s: unknown, title?: string): string {
  const t = normalizeLogText(s, title)
  if (!t) return ''
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    // h *= 16777619（用移位避免超出 32 位精度）
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0') + ':' + t.length
}

/** 一件内容是否"实质上是同一份" */
export function sameContent(a: unknown, b: unknown): boolean {
  const fa = textFingerprint(a)
  if (!fa) return false // 空内容不做内容判重（否则所有空文件互相冲突）
  return fa === textFingerprint(b)
}

/**
 * 把待导入项分成四类。
 * existing 建议传**全量**日志（含已完成/已归档），否则改名 + 换状态就能绕过判重。
 */
export function classifyLogImport(items: ImportItem[], existing: ExistingLogLike[]): ClassifyResult {
  const titles = new Set<string>()
  const prints = new Set<string>()
  for (const l of existing || []) {
    const t = String(l?.title ?? '').trim()
    if (t) titles.add(t)
    const fp = textFingerprint(l?.content, t)
    if (fp) prints.add(fp)
  }

  const res: ClassifyResult = { fresh: [], dupTitle: [], dupContent: [], dupInBatch: [] }
  const seenTitle = new Set<string>()
  const seenPrint = new Set<string>()

  for (const it of items || []) {
    const title = String(it?.title ?? '').trim()
    const fp = textFingerprint(it?.text, title)
    // 批内重复优先报（同一批里拖了两次/两个改名副本）
    if (seenTitle.has(title) || (fp && seenPrint.has(fp))) {
      res.dupInBatch.push(title)
      continue
    }
    if (titles.has(title)) {
      res.dupTitle.push(title)
      seenTitle.add(title)
      if (fp) seenPrint.add(fp)
      continue
    }
    if (fp && prints.has(fp)) {
      res.dupContent.push(title)
      seenTitle.add(title)
      seenPrint.add(fp)
      continue
    }
    res.fresh.push({ title, text: String(it?.text ?? '') })
    seenTitle.add(title)
    if (fp) seenPrint.add(fp)
  }
  return res
}

/** 生成给用户看的一句话摘要 */
export function classifySummary(r: ClassifyResult): string {
  const dup = r.dupTitle.length + r.dupContent.length + r.dupInBatch.length
  if (!dup) return `将导入 ${r.fresh.length} 个文件`
  const bits: string[] = []
  if (r.dupTitle.length) bits.push(`同名 ${r.dupTitle.length}`)
  if (r.dupContent.length) bits.push(`同内容（改名）${r.dupContent.length}`)
  if (r.dupInBatch.length) bits.push(`批内重复 ${r.dupInBatch.length}`)
  return `将导入 ${r.fresh.length} 个；跳过 ${dup} 个（${bits.join('、')}）`
}
