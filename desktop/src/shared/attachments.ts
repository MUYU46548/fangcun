/**
 * 附件「能不能直接点开」的唯一判据（2026-10-30 暮雨报障）
 *
 * 现场：日志里挂了一个安装包（蓝色链接），顺手点了一下 —— **方寸自己白屏成空壳**，
 * 只能退出重进。根因不是附件坏了，是旧实现把**任何附件**都交给 `shell.openPath`：
 * `.exe` 会被当成"用系统程序打开"直接**运行安装程序**；如果那个包装的正好是方寸
 * （或它会覆盖/重启正在跑的程序），运行中的窗口就会资源被换掉 → 白屏。
 *
 * 所以这里把"可执行 / 安装包"单独认出来：**方寸不直接运行它们**，
 * 只允许「在文件夹中显示」，由用户确认来源后自己双击。判据是**扩展名**（不看内容、
 * 不联网、不调 AV），因为这一步只需要挡住"点一下就跑"的默认动作。
 *
 * ⚠ 这是安全默认值，不是沙箱：用户仍可在资源管理器里运行任何东西。
 */

/** 双击即执行 / 安装的扩展名（小写，带点） */
export const EXEC_ATTACHMENT_EXTS: readonly string[] = [
  '.exe', '.msi', '.msix', '.msixbundle', '.appx', '.appxbundle',
  '.bat', '.cmd', '.com', '.scr', '.pif',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta',
  '.lnk', '.reg', '.cpl', '.jar', '.dll', '.sys', '.drv', '.ocx',
]

/** 文件名 / 相对路径 → 是否是"点一下就执行"的东西 */
export function isExecutableAttachment(name: string): boolean {
  const s = String(name || '').trim().toLowerCase()
  if (!s) return false
  const base = s.split(/[\\/]/).pop() || s
  const dot = base.lastIndexOf('.')
  if (dot < 0) return false
  return EXEC_ATTACHMENT_EXTS.includes(base.slice(dot))
}

export interface AttachmentOpenPolicy {
  /** true = 可以交给系统默认程序打开；false = 只能定位，不直接运行 */
  run: boolean
  ext: string
  /** 给人看的一句话（为什么不让点开） */
  reason?: string
  /** 下一步该怎么做 */
  hint?: string
}

export function attachmentOpenPolicy(name: string): AttachmentOpenPolicy {
  const s = String(name || '').trim()
  const base = s.split(/[\\/]/).pop() || s
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : ''
  if (isExecutableAttachment(s)) {
    return {
      run: false,
      ext,
      reason: `「${base}」是可执行 / 安装文件（${ext}），方寸不会直接运行它`,
      hint: '直接运行会启动安装程序；如果它覆盖/重启正在运行的方寸，界面会白屏。请先在文件夹中定位，确认来源后再双击。',
    }
  }
  return { run: true, ext }
}
