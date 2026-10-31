/**
 * 日志导入（2026-10-31 · 渲染层拆分第二批「日志动作收口」第六刀）
 *
 * 搬出来的是「从外部文本导入日志」这一组：
 *   · 选文件 / 拖文件两条入口；
 *   · 只收 .txt / .md / .markdown / .log；
 *   · 按「文件名 + 正文内容指纹」判重，重复集中问一次；
 *   · 每个文件生成一条日志，标题取文件名。
 *
 * 仍在 App 的：日志编辑/互转。依赖由调用方传入，不复制状态。
 */
import type { Ref } from 'vue'
import { classifyLogImport, classifySummary, type ImportItem } from '../logdedupe'

const LOG_IMPORT_RE = /\.(txt|md|markdown|log)$/i

interface Deps {
  curProj: Ref<string>
  projects: Ref<any[]>
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  reload: () => Promise<void>
  resetDrag: () => void
}

export function useLogImport(deps: Deps) {
  const { curProj, projects, showToast, reload, resetDrag } = deps

  async function importTextFilesAsLogs(files: File[]): Promise<number> {
    const usable = files.filter(f => LOG_IMPORT_RE.test(f.name))
    if (!usable.length) {
      if (files.length) showToast('仅支持 .txt / .md / .log 文件', 'error')
      return 0
    }
    // 取**全量**日志参与判重（当前列表可能正被状态/搜索条件过滤，
    // 用过滤后的列表判重会漏过"已归档的同名/同内容"，那就等于没有判重）
    let existing: any[] = []
    try {
      existing = await window.tegula.logsList()
    } catch { /* 取不到就退化为"不判重"，不阻断导入 */ }

    const items: ImportItem[] = []
    for (const f of usable) {
      try {
        items.push({ title: f.name.replace(/\.[^.]+$/, ''), text: await f.text() })
      } catch { /* 单个文件读失败不阻断其余 */ }
    }
    if (!items.length) {
      showToast('文件读取失败，没有可导入的内容', 'error')
      return 0
    }

    const cls = classifyLogImport(items, existing)
    const skipped = cls.dupTitle.length + cls.dupContent.length + cls.dupInBatch.length
    if (!cls.fresh.length) {
      showToast(`全部被拦截，未新增 —— ${classifySummary(cls)}`, 'info')
      return 0
    }
    if (skipped) {
      const lines: string[] = []
      const sample = (arr: string[]) => arr.slice(0, 3).join('、') + (arr.length > 3 ? ' …' : '')
      if (cls.dupTitle.length) lines.push(`同名：${sample(cls.dupTitle)}`)
      if (cls.dupContent.length) lines.push(`内容相同（只是改了名）：${sample(cls.dupContent)}`)
      if (cls.dupInBatch.length) lines.push(`同一批里重复：${sample(cls.dupInBatch)}`)
      if (!confirm(`检测到 ${skipped} 个重复文件（按「文件名 + 正文内容指纹」判定）：\n${lines.join('\n')}\n\n重复的跳过，继续导入其余 ${cls.fresh.length} 个？`)) {
        showToast('已取消导入', 'info')
        return 0
      }
    }

    const project = curProj.value !== '__all__' ? curProj.value : (projects.value[0]?.id || '')
    let ok = 0
    for (const it of cls.fresh) {
      try {
        const r = await window.tegula.logsCreate(it.title, project, it.text)
        if (r?.ok) ok++
      } catch { /* 单个文件失败不阻断其余 */ }
    }
    showToast(`已导入 ${ok} 条日志${skipped ? `，跳过 ${skipped} 个重复` : ''}`, ok ? 'success' : 'error')
    void reload()
    return ok
  }

  function importLogFile() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.txt,.md,.markdown,.log'
    input.multiple = true
    input.onchange = async (e: any) => {
      await importTextFilesAsLogs(Array.from(e.target.files || []))
    }
    input.click()
  }

  async function onLogDrop(e: DragEvent) {
    e.preventDefault()
    resetDrag()
    await importTextFilesAsLogs(Array.from(e.dataTransfer?.files || []))
  }

  return { importTextFilesAsLogs, importLogFile, onLogDrop }
}
