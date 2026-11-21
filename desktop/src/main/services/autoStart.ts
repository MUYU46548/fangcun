/**
 * 开机自启（2026-11-21 · 暮雨：「加一下可选的开机自启功能，明确提示……杀毒软件拦截」）
 *
 * 边界：
 *   · **默认关**，只有用户在此处勾选才写启动项；
 *   · 只写当前用户的启动项（Windows 下是 HKCU 的 Run 键，不要求管理员）；
 *   · 开发态（`app.isPackaged === false`）**不写注册表**，如实说明“装好后才有”；
 *   · 调用系统 API 失败时把原因原样返回，不假装成功。
 *
 * 为什么用 `app.setLoginItemSettings` 而不是自己写注册表：
 *   Electron 已经处理了路径/引号/平台差异；自己拼注册表更容易写坏别人的启动项。
 *   Windows 下它写的是 HKCU\Software\Microsoft\Windows\CurrentVersion\Run；
 *   部分杀软会拦截/提示“程序试图添加开机启动”，需要用户在杀软里允许 —— UI 必须提前说。
 */
import { app } from 'electron'

export interface AutoStartStatus {
  ok: boolean
  enabled: boolean
  supported: boolean
  /** 给界面直接显示的一句话（读不到/开发态/失败原因） */
  reason?: string
}

function isSupported(): boolean {
  return !!app.isPackaged
}

/** 自启时带这个参数：只进托盘，不弹主窗口（index.ts 用它决定 show） */
export const AUTOSTART_ARG = '--autostart'

export function getAutoStartStatus(): AutoStartStatus {
  if (!isSupported()) {
    return { ok: true, enabled: false, supported: false, reason: '开发态不写开机启动项；装成正式版后才可用' }
  }
  try {
    const s: any = app.getLoginItemSettings({ path: process.execPath, args: [AUTOSTART_ARG] })
    return { ok: true, enabled: !!s?.openAtLogin, supported: true }
  } catch (e: any) {
    return { ok: false, enabled: false, supported: true, reason: '读不到开机启动状态：' + (e?.message || e) }
  }
}

export function setAutoStart(enabled: boolean): AutoStartStatus {
  if (!isSupported()) {
    return { ok: false, enabled: false, supported: false, reason: '开发态不写开机启动项；装成正式版后才可用' }
  }
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: [AUTOSTART_ARG] })
    // 写完立刻读回：系统 API 可能在杀软/策略下静默不生效，不能只信调用没抛。
    const back = app.getLoginItemSettings({ path: process.execPath, args: [AUTOSTART_ARG] })
    const now = !!back?.openAtLogin
    return {
      ok: now === !!enabled,
      enabled: now,
      supported: true,
      reason: now === !!enabled ? undefined : '系统没有接受这次修改（可能被杀毒软件/组策略拦截）',
    }
  } catch (e: any) {
    return { ok: false, enabled: false, supported: true, reason: '设置失败：' + (e?.message || e) }
  }
}
