/**
 * 项目梯度榜（Tier List）—— 2026-10-25 暮雨
 *
 * 原话两轮：「就一个手动排序小玩具」「放进项目页签里面就好」「和我丢的参考图里的**梯度榜**完全不同」。
 * 所以形状是：**几档 + 每档若干项目**，拖进拖出即改档，不是一条一维名次列表。
 *
 * 边界（写死，防膨胀）：
 *   ① **只被项目页的「梯度榜」摆法读写** —— 不参与看板分组、不影响一屏行序、不动 registry。
 *   ② 没有权重分、没有公式、不自动分档；每次都是人拖出来的。
 *   ③ 文件缺失 / 坏掉 → 回默认档位（四档全空），界面照常能用，但**如实返回 error**。
 *
 * 为什么放 `task-data/`：要随备份包与 Git 通道走 —— 换台机器不该重排一遍。
 * 为什么独立文件而不进 registry：registry 增删是**文本块级**操作（禁整体 load+dump），
 * 为几档排序动两个手写解析器，风险远大于收益。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, atomicWrite } from '../data'
import * as appLog from './appLog'

export interface Tier {
  id: string
  label: string
  /** 这一档里的项目 id，按档内顺序 */
  items: string[]
}

/**
 * 默认档位。语义刻意留给"做不做"而不是"好不好"——
 * 暮雨的原始场景是「绒花墨坊没钱做、打算暂缓」，所以最后一档叫「搁置」。
 */
export const DEFAULT_TIERS: Tier[] = [
  { id: 'core', label: '核心', items: [] },
  { id: 'next', label: '次优先', items: [] },
  { id: 'queue', label: '排队', items: [] },
  { id: 'hold', label: '搁置', items: [] },
]

function tiersPath(): string {
  return path.join(getDataDir(), 'task-data', 'project-tiers.json')
}

/**
 * 清洗。**同一个项目只能在一档里** —— 手改文件把它写进两档时，先出现的那个赢，
 * 否则界面上会出现两个同名胶囊、拖哪个都"不对"。
 */
function normalizeTiers(input: unknown): Tier[] {
  const list = Array.isArray(input) ? input : []
  const seenItem = new Set<string>()
  const seenTier = new Set<string>()
  const out: Tier[] = []
  for (const raw of list) {
    const t = raw as any
    const id = String(t?.id ?? '').trim()
    if (!id || seenTier.has(id)) continue
    seenTier.add(id)
    const label = String(t?.label ?? '').trim() || id
    const items: string[] = []
    for (const x of (Array.isArray(t?.items) ? t.items : [])) {
      const pid = String(x ?? '').trim()
      if (!pid || seenItem.has(pid)) continue
      seenItem.add(pid)
      items.push(pid)
    }
    out.push({ id, label, items })
  }
  return out
}

/** 读档位。永远不抛：读不到就给默认档位 + 一句人话原因。 */
export function readTiers(): { ok: boolean; tiers: Tier[]; path: string; error?: string } {
  const p = tiersPath()
  if (!fs.existsSync(p)) return { ok: true, tiers: normalizeTiers(DEFAULT_TIERS), path: p }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const tiers = normalizeTiers(raw?.tiers)
    // 文件在但 tiers 空/坏成空数组 → 当作"用户把档全删了"还是"文件坏了"？
    // 判据：结构合法（tiers 是数组）就尊重，哪怕是空 —— 用户真的可以删光重来。
    if (!Array.isArray(raw?.tiers)) {
      return { ok: false, tiers: normalizeTiers(DEFAULT_TIERS), path: p, error: '梯度榜文件结构不认识（缺 tiers 数组）—— 暂时用默认四档' }
    }
    return { ok: true, tiers, path: p }
  } catch (e: any) {
    appLog.warn('projectTiers', `梯度榜文件读不了：${p}`, e?.message || e)
    return { ok: false, tiers: normalizeTiers(DEFAULT_TIERS), path: p, error: `梯度榜文件读不了（${e?.message || e}）—— 暂时用默认四档` }
  }
}

/**
 * 写档位。原子写（半截文件不会覆盖好文件）。
 *
 * ⚠ 不校验项目 id 是否存在：那是 registry 的事；渲染层的列表本来就来自 registry。
 *   真留了不存在的 id，界面会把它显示成「(已不在登记表)」并允许拖走，不静默吞掉。
 */
export function writeTiers(tiers: unknown): { ok: boolean; tiers: Tier[]; error?: string } {
  const clean = normalizeTiers(tiers)
  try {
    fs.mkdirSync(path.dirname(tiersPath()), { recursive: true })
    atomicWrite(tiersPath(), JSON.stringify({ tiers: clean, updatedAt: new Date().toISOString() }, null, 2))
    return { ok: true, tiers: clean }
  } catch (e: any) {
    appLog.error('projectTiers', '梯度榜写盘失败', e?.stack || e)
    return { ok: false, tiers: clean, error: `写盘失败：${e?.message || e}` }
  }
}
