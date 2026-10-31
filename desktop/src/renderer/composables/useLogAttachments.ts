/**
 * 日志附件（2026-10-31 · 渲染层拆分第二批「日志动作收口」第一刀）
 *
 * 语义刻意收窄：只做「这条日志引用了哪些文件」，不做素材库/标签/相册。
 * 文件本体在数据目录 `docs/执行日志/_attachments/<logId>/`，列表里是相对路径。
 *
 * 搬出来的是**附件状态 + 全部附件动作**：
 *   · 新建态的待挂清单（路径 / 粘贴字节）、拖入高亮、读图缓存；
 *   · 选文件 / 粘贴 / 拖入 / 挂载 / 解除 / 打开 / 悬停提示；
 *   · 保存后一次性 flush（失败逐条回填，调用方据此不关弹窗）。
 *
 * 留在 App 的：日志编辑表单本身（saveLogEdit 调这里拿 flush 结果）。
 *
 * ⚠ 三处视图（列表卡 / 只读预览 / 编辑弹窗）由调用方把 ref 传进来，**不复制状态**。
 */
import { computed, reactive, ref, type Ref } from 'vue'
import { isExecutableAttachment } from '../../shared/attachments'

interface Deps {
  logs: Ref<any[]>
  logPreview: Ref<any>
  logEdit_: Ref<any>
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i

export function useLogAttachments(deps: Deps) {
  const { logs, logPreview, logEdit_, toast } = deps

  /** rel → dataURL 缓存。空串 = 取过但取不到（超 8MB / 已不在数据目录），UI 回落成「用系统打开」 */
  const attachCache_ = reactive<Record<string, string>>({})
  const attachPending_ = reactive<Record<string, boolean>>({})

  function isImageRel(rel: string): boolean { return IMG_EXT.test(String(rel || '')) }
  function attachName(rel: string): string {
    const s = String(rel || '')
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    return i >= 0 ? s.slice(i + 1) : s
  }
  /** 取预览用 data URL（渲染期调用，幂等：每条 rel 只发一次 IPC） */
  function attachSrc(rel: string): string {
    const key = String(rel || '')
    if (!key) return ''
    if (attachCache_[key] !== undefined) return attachCache_[key]
    if (attachPending_[key]) return ''
    attachPending_[key] = true
    const api = (window as any).tegula
    Promise.resolve(api?.logsAttachmentData?.(key))
      .then((r: any) => {
        attachPending_[key] = false
        attachCache_[key] = r?.ok && r.data?.dataUrl ? r.data.dataUrl : ''
      })
      .catch(() => { attachPending_[key] = false; attachCache_[key] = '' })
    return ''
  }

  /** 附件落到哪几处视图：列表里的卡、只读预览、编辑对话框（谁开着就更谁） */
  function applyAttachments(logId: string, entry: any): void {
    const list = Array.isArray(entry?.attachments) ? entry.attachments : []
    const row = logs.value.find(l => l.id === logId)
    if (row) row.attachments = list
    if (logPreview.value && logPreview.value.id === logId) logPreview.value.attachments = list
    if (logEdit_.value && logEdit_.value.id === logId) logEdit_.value.attachments = list
  }

  // ── 新建态的「待挂附件」──────────────────────────────────────────
  // 没有 id 就没地方放附件；先暂存（路径 / data URL 只留内存），保存成功再一次性落盘。
  const logPendingPaths = ref<string[]>([])
  const logPendingData = ref<Array<{ name: string; dataUrl: string }>>([])
  const logPendingCount = computed(() => logPendingPaths.value.length + logPendingData.value.length)

  function pendingBaseName(p: string): string {
    const s = String(p || '').replace(/\\/g, '/')
    return s.slice(s.lastIndexOf('/') + 1) || s
  }

  function resetPendingAttach(): void {
    logPendingPaths.value = []
    logPendingData.value = []
  }

  /** 附件按钮的统一入口：有 id 就直接挂；没 id 就只选不挂 */
  async function attachPickOrAdd(): Promise<void> {
    const id = logEdit_.value?.id || ''
    if (id) { await attachAdd(id); return }
    try {
      const r: any = await (window as any).tegula.logsPickFiles()
      if (r?.error === 'canceled') return
      if (!r?.ok) { toast('选文件失败：' + (r?.error || '未知原因'), 'error'); return }
      const add = (r.paths || []).filter((p: string) => p && !logPendingPaths.value.includes(p))
      if (!add.length) return
      logPendingPaths.value = [...logPendingPaths.value, ...add]
      toast(`已选 ${add.length} 个 —— 保存这条日志时一起挂上`, 'info')
    } catch (e: any) {
      toast('选文件失败：' + (e?.message || e), 'error')
    }
  }

  function readAsDataUrl(f: File): Promise<{ name: string; dataUrl: string } | null> {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve({ name: f.name || ('粘贴图片-' + Date.now()), dataUrl: fixDataUrlMime(String(reader.result || ''), f.name || '') })
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(f)
    })
  }

  /**
   * 有些来源（拖入 / 部分系统剪贴板）给的 mime 是 octet-stream，主进程按 mime 白名单会拒。
   * 这里**只按扩展名把已知信息补齐**；主进程仍按白名单校验，不是"信客户端"。
   */
  const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    html: 'text/html', json: 'application/json', zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  function fixDataUrlMime(dataUrl: string, fileName: string): string {
    if (!/^data:application\/octet-stream/i.test(dataUrl)) return dataUrl
    const ext = (String(fileName).split('.').pop() || '').toLowerCase()
    const mime = MIME_BY_EXT[ext]
    return mime ? dataUrl.replace(/^data:application\/octet-stream/i, 'data:' + mime) : dataUrl
  }

  /** 把一批 File 变成附件：新建态进内存待挂，已有 id 就直接落盘。粘贴/拖拽共用。 */
  function acceptAttachBlobs(files: File[], word: string): void {
    if (!files.length) return
    const id = logEdit_.value?.id || ''
    void Promise.all(files.map(readAsDataUrl)).then(async (items) => {
      const ok = items.filter(Boolean) as Array<{ name: string; dataUrl: string }>
      if (!ok.length) { toast(`这${word === '拖入' ? '些' : '张'}文件读不出来（可能太大）`, 'error'); return }
      if (!id) {
        logPendingData.value = [...logPendingData.value, ...ok]
        toast(`已${word} ${ok.length} 个 —— 保存这条日志时一起挂上`, 'info')
        return
      }
      try {
        const r: any = await (window as any).tegula.logsAttachData(id, ok)
        if (!r?.ok) { toast(`${word}附件失败：` + (r?.error || '未知原因'), 'error'); return }
        applyAttachments(id, r.data)
        const skip = Array.isArray(r.skipped) ? r.skipped : []
        toast(skip.length
          ? `已挂 ${r.added ?? 0} 个；${skip.length} 个没挂上：${skip.join('；')}`
          : `已挂 ${r.added ?? ok.length} 个附件`,
          skip.length ? 'info' : 'success')
      } catch (e: any) {
        toast(`${word}附件失败：` + (e?.message || e), 'error')
      }
    })
  }

  // ── 拖文件进弹窗 ─────────────────────────────────────────────────
  // dragenter 计数避免从子元素之间划过时 dragleave 把高亮抖掉（经典坑）。
  const logAttachDragOver = ref(false)
  let logAttachDragDepth = 0
  function onLogAttachDragEnter(): void {
    logAttachDragDepth++
    logAttachDragOver.value = true
  }
  function onLogAttachDragLeave(): void {
    logAttachDragDepth = Math.max(0, logAttachDragDepth - 1)
    if (!logAttachDragDepth) logAttachDragOver.value = false
  }
  function onLogAttachDrop(ev: DragEvent): void {
    logAttachDragDepth = 0
    logAttachDragOver.value = false
    const files = Array.from(ev.dataTransfer?.files || [])
    if (!files.length) return
    acceptAttachBlobs(files, '拖入')
  }

  /** 粘贴图片 → 附件。只拦"剪贴板里真有图片"，粘文字照常走浏览器默认行为。 */
  function onLogPaste(ev: ClipboardEvent): void {
    const dt = ev.clipboardData
    if (!dt) return
    const files = Array.from(dt.files || []).filter((f) => /^image\//.test(f.type))
    if (!files.length) return
    ev.preventDefault()         // 别让图片被粘成一大串 base64 文本塞进正文
    acceptAttachBlobs(files, '粘贴')
  }

  /**
   * 保存后把待挂的一次性挂上。返回**是否全部挂成功**。
   * 两条纪律：① 逐条报结果；② 没挂上的回填待挂清单，调用方据此**不关弹窗**。
   */
  async function flushPendingAttach(logId: string): Promise<boolean> {
    // ⚠ 不要直接展开 ref 数组：元素是 Vue 响应式代理，过 contextBridge 必抛
    //   `An object could not be cloned.`（2026-10-29 真因）。就地造新的裸对象。
    const paths = logPendingPaths.value.map((p) => String(p))
    const data = logPendingData.value.map((x) => ({ name: String(x?.name || ''), dataUrl: String(x?.dataUrl || '') }))
    resetPendingAttach()
    if (!paths.length && !data.length) return true

    const errText: string[] = []
    const skippedText: string[] = []
    const keepPaths: string[] = []
    const keepData: Array<{ name: string; dataUrl: string }> = []
    let okCount = 0

    if (paths.length) {
      try {
        const r: any = await (window as any).tegula.logsAttachFiles(logId, paths)
        if (r?.ok) {
          okCount += (Array.isArray(r.data?.attachments) ? paths.length : paths.length)
          applyAttachments(logId, r.data)
        } else keepPaths.push(...paths)
      } catch (e: any) {
        errText.push(`添加文件通道异常：${e?.message || e}`)
        console.warn('[logEdit] 附件（按路径）没挂上：', e)
        keepPaths.push(...paths)
      }
    }
    if (data.length) {
      try {
        const r: any = await (window as any).tegula.logsAttachData(logId, data)
        const skipped = Array.isArray(r?.skipped) ? r.skipped.map((x: unknown) => String(x)) : []
        if (!r?.ok) keepData.push(...data)
        else {
          okCount += (r.added ?? data.length)
          applyAttachments(logId, r.data)
          for (const d of data) {
            if (skipped.some((s: string) => s.startsWith(d.name))) keepData.push(d)
          }
        }
        skippedText.push(...skipped)
      } catch (e: any) {
        errText.push(`粘贴/拖入通道异常：${e?.message || e}`)
        console.warn('[logEdit] 附件（按内存字节）没挂上：', e)
        keepData.push(...data)
      }
    }

    // 失败的回填待挂清单 —— 弹窗不关，用户再点一次保存就能重试
    logPendingPaths.value = keepPaths
    logPendingData.value = keepData

    if (keepPaths.length || keepData.length) {
      const reason = skippedText.length || errText.length
        ? [...skippedText, ...errText].join('；')
        : keepPaths.map(pendingBaseName).join('；')
      toast(`日志已保存，但 ${keepPaths.length + keepData.length} 个附件没挂上：${reason || '未知原因'} —— 还留在弹窗里，再点一次保存可重试`, 'error')
      return false
    }
    toast(`日志已保存，附件挂上 ${okCount} 个`, 'success')
    return true
  }

  async function attachAdd(logId: string): Promise<void> {
    if (!logId) { toast('先保存日志再挂附件', 'info'); return }
    try {
      const r: any = await (window as any).tegula.logsAttachFiles(logId)
      if (r?.error === 'canceled') return
      if (!r?.ok) { toast('添加附件失败：' + (r?.error || '未知原因'), 'error'); return }
      applyAttachments(logId, r.data)
      const n = r.data?.attachments?.length || 0
      toast(`附件已关联（这条日志共 ${n} 个）`, 'success')
    } catch (e: any) {
      toast('添加附件失败：' + (e?.message || e), 'error')
    }
  }

  /** 解除关联 —— 文件**不删** */
  async function attachRemove(logId: string, rel: string): Promise<void> {
    try {
      const r: any = await (window as any).tegula.logsDetachAttachment(logId, rel)
      if (!r?.ok) { toast('移除失败：' + (r?.error || '未知原因'), 'error'); return }
      applyAttachments(logId, r.data)
      toast('已解除关联（文件仍保留在数据目录）', 'info')
    } catch (e: any) {
      toast('移除失败：' + (e?.message || e), 'error')
    }
  }

  /** 用系统程序打开；可执行/安装包**绝不直接运行** —— 先问，再只在文件夹里定位。 */
  async function attachOpen(rel: string): Promise<void> {
    try {
      const r: any = await (window as any).tegula.logsOpenAttachment(rel)
      if (r?.ok) return
      if (r?.needsReveal) {
        const yes = confirm(`${r.error || '这是可执行文件，方寸不会直接运行它'}\n\n${r.hint || ''}\n\n要在文件夹里显示它吗？（确认来源后再自己双击）`)
        if (!yes) return
        const s: any = await (window as any).tegula.logsRevealAttachment(rel)
        if (s?.ok) toast('已在文件夹中定位 —— 确认来源后再双击运行', 'info')
        else toast('定位失败：' + (s?.error || '未知原因'), 'error')
        return
      }
      toast('打开失败：' + (r?.error || '未知原因'), 'error')
    } catch (e: any) {
      toast('打开失败：' + (e?.message || e), 'error')
    }
  }

  /** 附件行的悬停提示：可执行文件说清"只定位、不直接跑" */
  function attachOpenHint(rel: string): string {
    return isExecutableAttachment(rel)
      ? '这是安装包 / 可执行文件：不会直接运行，点一下只在文件夹中定位'
      : '点一下用系统程序打开'
  }

  return {
    logPendingPaths, logPendingData, logPendingCount, logAttachDragOver,
    isImageRel, attachName, attachSrc, attachPickOrAdd, pendingBaseName, resetPendingAttach,
    onLogAttachDragEnter, onLogAttachDragLeave, onLogAttachDrop, onLogPaste,
    flushPendingAttach, attachAdd, attachRemove, attachOpen, attachOpenHint,
  }
}
