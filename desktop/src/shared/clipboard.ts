/**
 * 复制到剪贴板 —— 三层兜底。
 *
 * 为什么不能直接用 navigator.clipboard（2026-09-25「日志复制失败」的真因）：
 *   ① 打包版页面是 file:// 起源，`navigator.clipboard` 可能整个不存在；
 *   ② 即使存在，Chromium 要求 document **处于焦点**，失焦/内嵌/自动化下 writeText() 会 reject；
 *   ③ 失败是**静默**的：剪贴板里仍留着上一次的内容 —— 用户以为复制成功，粘出来是旧东西
 *      （这就是「我复制的是方寸待修复0924内容」的来源）。
 * 主进程的 electron clipboard 模块没有以上限制，所以第一优先走 IPC。
 * 最后的 execCommand('copy') 兜底对「有用户手势但剪贴板 API 不可用」的场景有效。
 */

export interface CopyResult {
  ok: boolean
  via: 'ipc' | 'navigator' | 'execCommand' | 'none'
  error?: string
}

export async function copyText(text: unknown): Promise<CopyResult> {
  const s = String(text ?? '')
  if (!s) return { ok: false, via: 'none', error: '内容为空' }

  // 注意：本文件同时被主进程 tsconfig 编译（lib 无 DOM），所以不许直接引用 document/navigator，
  // 一律从 globalThis 取（渲染层运行时它们在，主进程侧不会走到这些分支）。
  const g: any = globalThis as any

  // ① 主进程 IPC（最可靠：不受起源与焦点限制）
  const bridge: any = g.tegula
  if (bridge && typeof bridge.clipboardWriteText === 'function') {
    try {
      const r = await bridge.clipboardWriteText(s)
      if (r && r.ok) return { ok: true, via: 'ipc' }
    } catch {
      /* 落到下一层 */
    }
  }

  // ② 浏览器异步剪贴板（dev 的 http 起源 + 有焦点时可用）
  try {
    const nav: any = g.navigator
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(s)
      return { ok: true, via: 'navigator' }
    }
  } catch {
    /* 落到下一层 */
  }

  // ③ 老式兜底：临时 textarea + execCommand
  try {
    const doc: any = g.document
    if (!doc) return { ok: false, via: 'none', error: '无 document（非渲染层环境）' }
    const ta = doc.createElement('textarea')
    ta.value = s
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    doc.body.appendChild(ta)
    ta.select()
    const ok = doc.execCommand('copy')
    doc.body.removeChild(ta)
    if (ok) return { ok: true, via: 'execCommand' }
  } catch {
    /* 忽略 */
  }

  return { ok: false, via: 'none', error: '三条复制通道都失败（IPC / navigator / execCommand）' }
}
