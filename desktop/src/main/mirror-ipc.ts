/**
 * 计划与实际的对照镜 · 数据出口（卡 task-20261027-004 阶段一）
 *
 * 只读，零加工：把一张卡的 `## 方案` 与 `## 结果记录` 原样取出来给界面。
 * 判断全在 `shared/planMirror.ts`（纯函数，可被 Node 直接跑），这里只管读卡与错误口径。
 *
 * 为什么单开文件而不是塞进 plan-ipc：
 * 那条通道服务的是**计划卡**（task-data/plans/*.md，阶段与判据）；
 * 这里是**普通任务卡**的正文对照。两者的数据源和失败口径都不同，混在一起以后没法收。
 */
import { guardedHandle } from './guarded-ipc'
import { readTask } from './data/tasks'
import { extractMirror, type MirrorPair } from '../shared/planMirror'

export interface MirrorResult extends MirrorPair {
  id: string
  title: string
  status: string
  project: string
}

/** 取一张卡的对照。卡不存在 → ok:false（那是"找不到"，不是"没有内容"）。 */
export function getTaskMirror(taskId: string): { ok: boolean; data?: MirrorResult; error?: string } {
  const t = readTask(taskId)
  if (!t) return { ok: false, error: '找不到这张卡：' + taskId }
  const pair = extractMirror(t.body || '')
  return {
    ok: true,
    data: {
      id: t.id || taskId,
      // ⚠ 英文键：loadTasks/readTask 把 YAML 中文键名映射成 fm.title / fm.status / fm.project
      title: String(t.fm?.title || ''),
      status: String(t.fm?.status || ''),
      project: (() => {
        const p: any = t.fm?.project
        return String(Array.isArray(p) ? p[0] || '' : p || '')
      })(),
      ...pair,
    },
  }
}

export function registerMirrorIpcHandlers(): void {
  // 只读通道。名字用 `mirror:` 前缀，和 `plans:` / `logs:` 分开 —— 它不服务计划卡。
  guardedHandle('mirror:get', (_e, taskId: string) => getTaskMirror(String(taskId || '')))
}
