/**
 * 结构地图落地（2026-11-21 从 MCP `smap_apply` 抽出来）
 *
 * 为什么抽：14 张结构地图卡当时只能靠用户手动拖到「完成」，再由 agent 调 `smap_apply` ——
 * 用户点一下不该只完成一半。界面现在要一个按钮 = **完成（签字）+ apply**，所以把
 * “写方针卡”的逻辑从 MCP handler 里抽成 service，MCP 与 IPC 共用同一份。
 *
 * 闸不变：**只认状态 = 完成**。完成是用户的签字，没签字一个字节都不写。
 * 写前备份、写后读回、只替换「## 结构地图」一节 —— 与 MCP 版本逐字同一套。
 */
import { loadTasks, rotateBackup } from '../data'
import { extractSmapProposal } from '../../shared/smapProposal'
import { getPolicy, savePolicy, policyPath } from './policies'

export interface SmapApplyResult {
  ok: boolean
  error?: string
  required?: string
  howTo?: string
  project?: string
  taskId?: string
  verifiedAt?: string
  bytes?: number
  kept?: string[]
  backup?: string
  note?: string
  expectedLen?: number
  actualLen?: number
}

export function applySmapFromTask(taskId: string): SmapApplyResult {
  const id = String(taskId || '').trim()
  if (!id) return { ok: false, error: 'taskId 必填' }
  const t = loadTasks('all').find((x: any) => String(x.id) === id)
  if (!t) return { ok: false, error: `找不到这张卡：${id}` }
  const st = String(t.fm?.status || '').trim()
  if (st !== '完成') {
    return {
      ok: false,
      error: `这张卡的状态是“${st}”，不是“完成” —— 结构地图的写入以你的签字为准。`,
      required: '完成',
      howTo: '先在卡上验收（移到「完成」），再应用结构地图。或者直接打回/归档，那就什么都不改。',
    }
  }
  const ex = extractSmapProposal(String(t.body || ''))
  if (!ex.ok) return { ok: false, error: String(ex.error || '抽不出结构地图') }
  const projRaw: any = t.fm?.project
  const project = (Array.isArray(projRaw) ? String(projRaw[0] || '') : String(projRaw || '')).trim()
  if (!project) return { ok: false, error: '这张卡没有项目 —— 不知道该写进哪份方针卡' }
  const before = getPolicy(project)
  if (!before) {
    return { ok: false, error: `项目 ${project} 还没有方针卡 —— 没有落地目标，先让用户建一张方针卡` }
  }
  // 破坏性操作先快照：备份失败就不写（宁可没改，也不能没备份地改）
  try {
    rotateBackup(policyPath(project))
  } catch (e: any) {
    return { ok: false, error: `写前备份失败，已中止：${e?.message || e}` }
  }
  savePolicy({ ...before, projectId: project, structureMap: String(ex.mapText || '') })
  const after = getPolicy(project)
  const wrote = String(after?.structureMap || '').trim()
  if (wrote !== String(ex.mapText || '').trim()) {
    return {
      ok: false,
      error: '写后读回不一致 —— 没写对（旧备份在 policies/.backup/，可以回滚）',
      expectedLen: String(ex.mapText || '').trim().length,
      actualLen: wrote.length,
    }
  }
  return {
    ok: true,
    project,
    taskId: id,
    verifiedAt: String(ex.verifiedAt || ''),
    bytes: wrote.length,
    kept: ['使命', '当前目标', '应用场景', '方针边界'],
    backup: 'policies/.backup/（写前自动备份）',
    note: '只写了「## 结构地图」这一节，其余四节逐字未动；已读回校验。',
  }
}
