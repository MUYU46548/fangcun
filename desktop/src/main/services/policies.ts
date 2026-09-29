/**
 * Fangcun Desktop — 方针区（项目方针卡）
 *
 * 每个活跃项目一张方针卡：使命 / 当前目标 / 应用场景 / 方针边界。
 * 存储形态：DATA_DIR/policies/<项目id>.md（长文本用 MD，不进 registry）。
 * 读取通道：设置页「项目方针」入口 + 「复制本卡」按钮（粘给 agent）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'

export interface Policy {
  projectId: string
  mission: string
  goal: string
  scenario: string
  boundary: string
  /** 结构地图节**正文**（029：模块清单 + 每模块一句话职责 + 主数据流，首行是「最后核实」日期）。
   *  读取时一定给字符串；**写入时可选** —— 老调用方（如一键补骨架）不传这个字段，
   *  那时 savePolicy 会沿用文件里已有的内容，而不是当成清空。 */
  structureMap?: string
  updatedAt: string
}

/**
 * 结构地图骨架**正文**（不含节标题）。节标题由 savePolicy 显式写出。
 *
 * 为什么只给骨架不代写内容（029 原话）：内容是描述性的（模块清单 + 主数据流），
 * 由 agent 起草、TA 过目 —— 骨架负责让「这张卡还没结构地图」在卡面上一眼可见，
 * 与章程缺口同一机制。
 */
const SKELETON_STRUCTURE_MAP_BODY = [
  '> 最后核实：（待填 —— 填完写日期；烂地图比没地图危险，因为读者不知道它烂）',
  '',
  '- 模块清单：待填（每模块一句话职责）',
  '- 主数据流：待填（数据从哪来 → 经过谁 → 落到哪 → 谁读它）',
].join('\n')

function getPolicyDir(): string {
  const dir = path.join(getDataDir(), 'policies')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function policyPath(projectId: string): string {
  // 项目 id 只允许字母数字连字符，防路径穿越
  if (!/^[\w-]+$/.test(projectId)) throw new Error(`非法项目 id: ${projectId}`)
  return path.join(getPolicyDir(), `${projectId}.md`)
}

export function getPolicy(projectId: string): Policy | null {
  const p = policyPath(projectId)
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const grab = (key: string): string => {
      const m = raw.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
      return m ? m[1].trim() : ''
    }
    // 2026-09-27（029）修：原实现 `([\s\S]*?)(?=\n## |$)` 带 m 标志时，`$` 会匹配**每个换行前**，
    // 于是多行小节只返回第一行 —— 编辑框回读被截断、再保存就把余下内容写没了（静默丢失）。
    // 改成「定位节标题 → 截到下一个 `## ` 或文件末尾」，与 Python 侧 read_policy 的 section() 同口径。
    const section = (key: string): string => {
      const m = new RegExp(`^##\\s*${key}\\s*$`, 'm').exec(raw)
      if (!m) return ''
      const rest = raw.slice(m.index + m[0].length)
      const next = rest.search(/^##\s/m)
      return (next >= 0 ? rest.slice(0, next) : rest).trim()
    }
    return {
      projectId,
      mission: section('使命'),
      goal: section('当前目标'),
      scenario: section('应用场景'),
      boundary: section('方针边界'),
      structureMap: section('结构地图'),
      updatedAt: grab('更新') || '',
    }
  } catch {
    return null
  }
}

/**
 * 保留 savePolicy 四字段之外的未知节（如手写的「项目事实」「结构地图」）。
 * 2026-09-25 六字段派工单：read_policy(core.py) 与 _build_prompt 会读「项目事实」节
 * 随任务书下发；savePolicy 若整体重建文件会静默吃掉这些节——先摘出、写回时原样放回。
 */
function preserveSections(projectId: string, nextFour: string[]): string {
  const p = policyPath(projectId)
  if (!fs.existsSync(p)) return ''
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const known = ['使命', '当前目标', '应用场景', '方针边界', '结构地图']
    const kept: string[] = []
    const re = /^## (.+?)\s*$/gm
    let m: RegExpExecArray | null
    const heads: { name: string; idx: number }[] = []
    while ((m = re.exec(raw)) !== null) heads.push({ name: m[1].trim(), idx: m.index })
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i]
      if (known.includes(h.name)) continue
      const start = h.idx
      const end = i + 1 < heads.length ? heads[i + 1].idx : raw.length
      const body = raw.slice(start, end).trim()
      if (body) kept.push(body)
    }
    return kept.length ? '\n' + kept.join('\n\n') + '\n' : ''
  } catch {
    return ''
  }
}

export function savePolicy(p: Policy): { ok: boolean; path: string } {
  const preserved = preserveSections(p.projectId, [])
  // 029：结构地图现在由这里**显式写**（界面要能看、能改）。
  //   ⚠ 调用方没传 structureMap 时（老调用方 / 一键补骨架），必须**沿用文件里已有的那节** ——
  //     否则"没传"会被当成"清空"，把已有的地图静默抹成骨架（这是最危险的一类回归）。
  //   传入的字段名已从 preserved 里排除（见 preserveSections 的 known），不会写重复。
  const existingMap = (getPolicy(p.projectId)?.structureMap || '').trim()
  const passedMap = (p.structureMap === undefined || p.structureMap === null) ? '' : String(p.structureMap).trim()
  const mapBody = passedMap || existingMap || SKELETON_STRUCTURE_MAP_BODY
  const tail = preserved.trim()
  const content = [
    `# 项目方针：${p.projectId}`,
    ``,
    `> 更新: ${new Date().toISOString()}`,
    `> 用途: 派活时随任务书下发，或直接粘给 agent 作为项目背景。`,
    ``,
    `## 使命`,
    p.mission || `（未填写）`,
    ``,
    `## 当前目标`,
    p.goal || `（未填写）`,
    ``,
    `## 应用场景`,
    p.scenario || `（未填写）`,
    ``,
    `## 方针边界`,
    p.boundary || `（未填写）`,
    ``,
    `## 结构地图`,
    mapBody,
    ``,
    tail,
    ``,
  ].join('\n')
  const target = policyPath(p.projectId)
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, target)
  return { ok: true, path: target }
}

/** 生成可粘贴给 agent 的方针文本 */
export function policyToText(p: Policy): string {
  const parts = [
    `## 项目方针（${p.projectId}）`,
    `### 使命`,
    p.mission,
    `### 当前目标`,
    p.goal,
    `### 应用场景`,
    p.scenario,
    `### 方针边界`,
    p.boundary,
  ].filter(x => x !== undefined)
  // 029：结构地图是给 agent 的最大价值项（模块职责 + 主数据流），有则一并粘出去。
  if (p.structureMap) parts.push(`### 结构地图（动手前先读）`, p.structureMap)
  return parts.join('\n')
}
