import { parseRegistry } from '../data'

export interface Service {
  project: string
  projectId: string
  name: string
  port: number | null
  url: string
  startCmd: string
  stopCmd: string
  repo: string
  running: boolean
}

export function scanServices(): Service[] {
  const projects = parseRegistry()
  const services: Service[] = []

  for (const p of projects) {
    const pid = p.id
    const pname = p.name || pid
    for (const svc of (p.services || [])) {
      let port: number | null = null
      let url = ''
      let startCmd = ''
      let stopCmd = ''
      let name = '未命名服务'

      if (typeof svc === 'object' && svc !== null) {
        port = (svc as any).port ? parseInt((svc as any).port) : null
        url = (svc as any).url || ''
        startCmd = (svc as any).start_cmd || ''
        stopCmd = (svc as any).stop_cmd || ''
        name = (svc as any).name || name
      }

      if (!url && port) url = `http://127.0.0.1:${port}`

      services.push({
        project: pname,
        projectId: pid,
        name,
        port,
        url,
        startCmd,
        stopCmd,
        repo: p.repo || '',
        running: false,
      })
    }
  }

  return services
}

// ── 笔记（Note）── 已于 2026-10-06 整块删除 ─────────────────────────────────
//
// 暮雨批：「笔记功能可以删（别改坏能跑的功能）」。
//
// 删掉的：`Note` 接口 + `getNotesDir` / `getNotesIndexPath` / `loadNotesIndex` /
// `saveNotesIndex` / `createNote` / `getNote` / `updateNote` / `deleteNote` /
// `listNotes` / `getNotesForTask` / `importNoteFromFile` / `attachNote` / `detachNote`；
// 配套还删了 `ipc.ts` 的 10 条通道、`preload` 的 10 条暴露、
// `data/tasks.ts` 的 `exportNotes` / `importNotes`。
//
// 判据：**渲染层零调用** —— 界面里从来没出现过笔记入口（`check-ipc-parity` 第 ⑤ 类扫出来的）。
//
// ⚠ `notes/` 数据目录与里面的历史文件**一个没动**：想继续用，直接改
// `notes/*.md` 与 `notes/index.json` 即可（它们本来就是纯文本）。
