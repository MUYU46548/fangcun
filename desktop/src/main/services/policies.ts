/**
 * Fangcun Desktop — 方针区（项目方针卡）
 *
 * 每个活跃项目一张方针卡：使命 / 当前目标 / 应用场景 / 方针边界。
 * 存储形态：DATA_DIR/policies/<项目id>.md（长文本用 MD，不进 registry）。
 * 读取通道：设置页“项目方针”入口 + “复制本卡”按钮（粘给 agent）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, atomicWrite } from '../data'

export interface Policy {
  projectId: string
  mission: string
  goal: string
  scenario: string
  boundary: string
  /** 结构地图节**正文**（029：模块清单 + 每模块一句话职责 + 主数据流，首行是“最后核实”日期）。
   *  读取时一定给字符串；**写入时可选** —— 老调用方（如一键补骨架）不传这个字段，
   *  那时 savePolicy 会沿用文件里已有的内容，而不是当成清空。 */
  structureMap?: string
  /**
   * 核心判词（2026-11-12 暮雨：记忆圣所那两间房纯属垃圾，
   * 「连整个游戏的玩法本身可能都有问题，撑不起那么大的内容量」）。
   *
   * 为什么必须落在方针卡上：方寸到 11-12 为止，**没有任何一个字段记录过
   * "暮雨认为这个项目现在是什么水平"**。于是「离期望多远」无从计算，
   * 「核心立不立得住」也无从判断 —— 内容量闸只能把一切都当成"没判过"。
   *
   * 形状刻意极简：一个档位 + 一句话 + 日期。人要写的东西越少，越可能真去写。
   * 空 = 未判（内容量闸按"未判"处理，只许做最小原型）。
   */
  coreVerdict?: string
  updatedAt: string
}

/**
 * 结构地图骨架**正文**（不含节标题）。节标题由 savePolicy 显式写出。
 *
 * 为什么只给骨架不代写内容（029 原话）：内容是描述性的（模块清单 + 主数据流），
 * 由 agent 起草、TA 过目 —— 骨架负责让“这张卡还没结构地图”在卡面上一眼可见，
 * 与章程缺口同一机制。
 */
const SKELETON_STRUCTURE_MAP_BODY = [
  '> 最后核实：（待填 —— 填完写日期；烂地图比没地图危险，因为读者不知道它烂）',
  '',
  '- 模块清单：待填（每模块一句话职责）',
  '- 主数据流：待填（数据从哪来 → 经过谁 → 落到哪 → 谁读它）',
].join('\n')

/**
 * 核心判词的骨架提示。空着就写这句 ——
 * **"还没被判过"必须一眼可见**，否则内容量闸会把"没判"当成"没问题"。
 */
const CORE_VERDICT_SKELETON = [
  '> 未判 —— 核心玩法还没被人确认过"立得住"。',
  '> 四选一写在这里：**立得住 / 能玩 / 垃圾 / 未判**，后面跟一句话理由与日期。',
  '> 例：`能玩 —— 装配台那 5 分钟确实是游戏，2026-11-12`',
  '> 未判时，方寸只允许做**最小原型**（0.5 小时 / 1 幕 / 1 间房），不许铺内容量。',
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
    // 改成“定位节标题 → 截到下一个 `## ` 或文件末尾”，与 Python 侧 read_policy 的 section() 同口径。
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
      coreVerdict: section('核心判词'),
      updatedAt: grab('更新') || '',
    }
  } catch {
    return null
  }
}

/**
 * 保留 savePolicy 四字段之外的未知节（如手写的“项目事实”“结构地图”）。
 * 2026-09-25 六字段派工单：read_policy(core.py) 与 _build_prompt 会读“项目事实”节
 * 随任务书下发；savePolicy 若整体重建文件会静默吃掉这些节——先摘出、写回时原样放回。
 */
function preserveSections(projectId: string, nextFour: string[]): string {
  const p = policyPath(projectId)
  if (!fs.existsSync(p)) return ''
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const known = ['使命', '当前目标', '应用场景', '方针边界', '结构地图', '核心判词']
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
    // 核心判词：与 structureMap 同一套防静默清空纪律，但**多一条**：
    //   `undefined`（没传这个字段）= 沿用文件里已有的；
    //   `''`（显式传空）= **人就是要清掉它** → 写回骨架。
    // ⚠ 这两者不区分会造成"判词撤不掉"：一旦写了个「垃圾」，就再也改不回"未判"，
    //   那条方向被永久锁死。实测踩到过（清空后仍读出旧判词）。
    `## 核心判词`,
    (() => {
      if (p.coreVerdict === undefined || p.coreVerdict === null) {
        const existing = (getPolicy(p.projectId)?.coreVerdict || '').trim()
        return existing || CORE_VERDICT_SKELETON
      }
      const passed = String(p.coreVerdict).trim()
      return passed || CORE_VERDICT_SKELETON
    })(),
    ``,
    tail,
    ``,
  ].join('\n')
  const target = policyPath(p.projectId)
  atomicWrite(target, content)
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
