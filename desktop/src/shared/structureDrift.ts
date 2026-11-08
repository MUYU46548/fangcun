/**
 * 结构地图“结构大改就过期”的判定（2026-11-08 暮雨拍板，同日按他的追问修正）
 *
 * 原话：“阈值不用收窄，只加‘结构大改就标记过期’。”
 * 追问：“源文件增删 ≥ 25 会不会导致每天过期，甚至一天内过期几十次？”
 * —— 会。实测方寸自己：10-25 起有 7 天单日新增/删除 ≥ 25 个文件（10-31 单日新增 61 个）。
 *   那种判据的后果是“地图永远红”，等于没有判据。所以**文件数只做说明，不再当触发器**。
 *
 * 判据（都能被用例精确打红）：
 *   ① **目录级增删**：自最后核实日起，新增或删掉了一个模块目录 → 过期。
 *      （只在一个已有目录里加/删文件，哪怕 200 个，也只是实现变动 → 不过期，但理由里会说清楚）
 *   ② 噪声路径不计：node_modules / dist / build / pkg / release* / 备份 / 文档目录 /
 *      .github / fixtures / 锁文件与日志 —— 它们天天变，拿来判定会让地图永远过期。
 *
 * 这一层只管**判断**（纯函数，零依赖，用例直接喂数据）；
 * 取 git 数据在 `main/services/structureDrift.ts`（3 次 git + 缓存）。
 */

export interface DriftPathSets {
  /** 自核实日起新增的文件（相对仓库根，正斜杠；改名不算新增） */
  added: string[]
  /** 自核实日起删除的文件 */
  deleted: string[]
  /** 新增文件里，父目录在核实日**还不存在**的那些 */
  newDirs?: string[]
  /** 核实日存在、现在已没有文件的目录 */
  removedDirs?: string[]
  /** 改名（--find-renames 认出来的）：只用于说明，不参与过期判定 */
  renamed?: string[]
}

export interface DriftVerdict {
  stale: boolean
  /** 给人看的一句话（写进 project_charter 的 structureMapStaleReason） */
  reason: string
  /** 参与判定的增删文件数（噪声已剔除）—— 只用于说明 */
  files: number
  newDirs: string[]
  removedDirs: string[]
}

/** 这些路径与“模块结构”无关：改了也不该让地图过期 */
const NOISE = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)out\//,
  /(^|\/)pkg\//,
  /(^|\/)release[^/]*\//,
  /(^|\/)\.pkg-tmp\//,
  /(^|\/)\.trash\//,
  /(^|\/)backups?\//,
  /(^|\/)__pycache__\//,
  /(^|\/)\.git\//,
  /(^|\/)docs?\//,        // 文档不算模块结构（含 docs/执行日志）
  /(^|\/)references\//,
  /(^|\/)notes\//,
  /(^|\/)ideas\//,
  /(^|\/)\.github\//,      // CI 配置天天动，不是模块结构
  /(^|\/)fixtures?\//,      // 测试夹具不是模块
  /(^|\/)\.obsidian\//,
  /(^|\/)coverage\//,
]
const NOISE_FILE = [
  /\.(lock|log|tmp|bak)$/i,
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /\.DS_Store$/i,
  /Thumbs\.db$/i,
]

export function isStructuralPath(p: string): boolean {
  const s = String(p || '').replace(/\\/g, '/').trim()
  if (!s) return false
  if (NOISE.some((re) => re.test(s))) return false
  if (NOISE_FILE.some((re) => re.test(s))) return false
  return true
}

/**
 * 这份文件算不算“源码”。**只有源码目录的增删才算结构变动** ——
 * 数据/素材目录（refs/、sample/、materials/）天天加，拿它们判定同样会让地图天天红。
 */
const SOURCE_EXT = /[.](ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift)$/i
export function isSourcePath(p: string): boolean {
  // git ls-tree / diff 给的就是正斜杠路径；这里不再做反斜杠替换（避免正则转义踩坑）
  return SOURCE_EXT.test(String(p || ''))
}

/** 一个文件的父目录（`src/main/data/x.ts` → `src/main/data`） */
export function parentDir(p: string): string {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
  const i = s.lastIndexOf('/')
  return i < 0 ? '' : s.slice(0, i)
}

const MAX_LIST = 3
const list = (xs: string[]) => (xs.length > MAX_LIST ? `${xs.slice(0, MAX_LIST).join('、')} 等 ${xs.length} 个` : xs.join('、'))

/**
 * 判定。**只有目录增删算结构变动**；文件数只写进理由。
 *
 * 为什么不拿文件数当判据：活跃仓库每天新增 20-60 个文件是常态（方寸实测），
 * 那样地图会天天红；而地图描述的是“有哪些模块、谁连谁”，不是“有几个文件”。
 */
export function judgeStructureDrift(input: DriftPathSets): DriftVerdict {
  const added = (input.added || []).filter(isStructuralPath)
  const deleted = (input.deleted || []).filter(isStructuralPath)
  const newDirs = Array.from(new Set((input.newDirs || []).map((d) => String(d).replace(/\\/g, '/')))).filter(Boolean)
  const removedDirs = Array.from(new Set((input.removedDirs || []).map((d) => String(d).replace(/\\/g, '/')))).filter(Boolean)
  const files = added.length + deleted.length

  const stale = newDirs.length > 0 || removedDirs.length > 0
  const dirPart: string[] = []
  if (newDirs.length) dirPart.push(`新增目录 ${list(newDirs)}`)
  if (removedDirs.length) dirPart.push(`删除目录 ${list(removedDirs)}`)
  const filePart = files ? `增 ${added.length} / 删 ${deleted.length} 个文件` : ''

  const reason = stale
    ? `自最后核实日起模块结构有变动：${dirPart.join('；')}${filePart ? `（其间${filePart}）` : ''}`
    : (files
      ? `自最后核实日起只有实现层改动（${filePart}），模块目录没变 —— 地图仍然成立`
      : '自最后核实日起没有任何结构性改动')

  return { stale, reason, files, newDirs, removedDirs }
}
