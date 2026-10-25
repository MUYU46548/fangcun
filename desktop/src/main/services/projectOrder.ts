/**
 * 项目优先级排序（2026-10-25 暮雨）
 *
 * 原话：「单独搞个可选启用的项目优先级视图就可以了，并没有改其他任何现成功能的理由，
 * 就一个手动排序小玩具。」
 *
 * 三条边界（写死，防膨胀）：
 *   ① **只被「优先级」这个可选视图读写** —— 不参与看板分组、不影响一屏、不改 registry。
 *      想让排序去影响别处，先来改这段注释并说清为什么。
 *   ② 只是一条**有序 id 列表**：没有权重分、没有公式、不自动排序。
 *   ③ 文件缺失 / 坏掉 → 回空列表（界面按 registry 顺序显示），不阻塞任何功能，
 *      但**如实返回 error**，让界面能说一句"排序文件读不了"，而不是装作没这回事。
 *
 * 为什么放 `task-data/` 而不是 `prefs.json`：它要随备份包与 Git 通道走 ——
 * 换个机器/重装后不该重新排一遍。为什么放独立文件而不进 registry：
 * registry 的增删是**文本块级**操作（禁整体 load+dump），为一条排序加顶层键
 * 要同时改 Python 与 TS 两个手写解析器，风险远大于收益。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir, atomicWrite } from '../data'
import * as appLog from './appLog'

export interface ProjectOrderFile {
  order: string[]
  updatedAt: string
}

function orderPath(): string {
  return path.join(getDataDir(), 'task-data', 'project-order.json')
}

/** 读排序。永远不抛：读不到就给空列表 + 一句人话原因。 */
export function readOrder(): { ok: boolean; order: string[]; path: string; error?: string } {
  const p = orderPath()
  if (!fs.existsSync(p)) return { ok: true, order: [], path: p }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const list: unknown[] = Array.isArray(raw?.order) ? raw.order : []
    // 只认字符串、去空、去重（手改文件写出重复 id 时不该出现两行同名项目）
    // ⚠ 用 `filter((s) => !!s)` 而不是 `filter(Boolean)`：后者在 TS 下会把结果推成 unknown[]
    const order: string[] = Array.from(new Set(
      list.map((x) => String(x ?? '').trim()).filter((s) => s.length > 0)
    ))
    return { ok: true, order, path: p }
  } catch (e: any) {
    appLog.warn('projectOrder', `排序文件读不了：${p}`, e?.message || e)
    return { ok: false, order: [], path: p, error: `排序文件读不了（${e?.message || e}）—— 暂时按登记顺序显示` }
  }
}

/**
 * 写排序。原子写（半截文件不会覆盖好文件）。
 *
 * ⚠ 这里**不校验 id 是否存在**：判断"这个项目还在不在"要用 registry，
 *   而那是数据层的事；渲染层手里的列表本来就来自 registry，过滤由它做。
 *   真要出现了不存在的 id，读回来时界面会忽略它并照常显示其余（不崩）。
 */
export function writeOrder(ids: string[]): { ok: boolean; order: string[]; error?: string } {
  const order = Array.from(new Set((Array.isArray(ids) ? ids : [])
    .map((x) => String(x ?? '').trim()).filter(Boolean)))
  const payload: ProjectOrderFile = { order, updatedAt: new Date().toISOString() }
  try {
    // 数据根换了位置时 task-data 可能还不存在 —— 先建目录，别让第一次排序就失败
    fs.mkdirSync(path.dirname(orderPath()), { recursive: true })
    atomicWrite(orderPath(), JSON.stringify(payload, null, 2))
    return { ok: true, order }
  } catch (e: any) {
    appLog.error('projectOrder', '排序写盘失败', e?.stack || e)
    return { ok: false, order, error: `写盘失败：${e?.message || e}` }
  }
}
