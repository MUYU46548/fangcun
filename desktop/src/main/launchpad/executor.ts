/**
 * Fangcun Desktop — 启动台执行器
 *
 * 2026-09-22 重写（用户第 7 条「启动台可以添加应用了，但是启动失败」）。
 *
 * 旧实现只有一个 `spawn(appConfig.cmd)`，实测对示例配置直接返回
 * `{"ok":false,"message":"启动失败: spawn EINVAL"}` —— 因为 `.bat/.cmd`
 * 不能由 CreateProcess 直接执行（Node 在 Windows 上必须经 cmd.exe），
 * 而 `apps.json.sample` 的四个示例里有三个是 `.bat`。
 * 另外 spawn 的异步 'error' 事件无人监听：真失败会被吞掉（或在 Electron
 * 主进程里变成未捕获异常），而函数已经乐观地返回了 ok:true + PID undefined。
 *
 * 现在的口径：
 *   - 目录 / .lnk / 无扩展名  → shell.openPath（ShellExecute，快捷方式与文件夹都能开）
 *   - .bat / .cmd             → cmd.exe /d /s /c "<cmdline>"
 *   - .ps1                   → powershell -NoProfile -ExecutionPolicy Bypass -File
 *   - 其它（.exe 等）         → 直接 spawn
 *   - http(s) URL            → shell.openExternal
 *   一律**等到 spawn 事件或 error 事件**才返回，ok 与 message 反映真实结果；
 *   'error' 监听器常驻，不再有未处理的子进程错误。
 */

import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { shell } from 'electron'
import { LaunchApp } from './config'
import * as appLog from '../services/appLog'

export interface LaunchResult {
  ok: boolean
  pid?: number
  message: string
}

/** Windows 上必须借壳启动的扩展名 */
const SHELL_EXT: Record<string, 'cmd' | 'powershell'> = {
  '.bat': 'cmd',
  '.cmd': 'cmd',
  '.ps1': 'powershell',
}

/** 给 cmd.exe 拼一行命令行：带空格的路径加引号 */
function quoteIfNeeded(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s
}

/**
 * 等 spawn 真正落地再返回。
 * Node 的 spawn 是异步的：路径不可执行时抛的不是异常而是 'error' 事件，
 * 不监听就等于"报成功"。这里两种结局都收口。
 */
function spawnAndWait(
  file: string,
  args: string[],
  opts: { cwd?: string; verbatim?: boolean; label: string },
): Promise<LaunchResult> {
  return new Promise<LaunchResult>((resolve) => {
    let settled = false
    const done = (r: LaunchResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        ...(opts.verbatim ? { windowsVerbatimArguments: true } : {}),
      } as any)
    } catch (e) {
      const msg = (e as Error).message
      appLog.error('launchpad', `spawn 抛出：${opts.label}`, msg)
      done({ ok: false, message: `启动失败: ${msg}` })
      return
    }

    // 常驻监听：子进程后续任何错误都不会变成未处理事件
    child.on('error', (err: Error) => {
      appLog.error('launchpad', `启动失败：${opts.label}`, err.message)
      done({ ok: false, message: `启动失败: ${err.message}` })
    })

    child.on('spawn', () => {
      try { child.unref() } catch { /* ignore */ }
      done({ ok: true, pid: child.pid, message: `已启动：${opts.label}（PID ${child.pid}）` })
    })

    // 兜底：极少数环境不派发 spawn 事件，避免 UI 永远转圈
    setTimeout(() => {
      if (settled) return
      try { child.unref() } catch { /* ignore */ }
      done({ ok: true, pid: child.pid, message: `已启动：${opts.label}` })
    }, 1500)
  })
}

/** shell.openPath 返回的是「错误字符串」，空串才算成功 —— 旧实现直接忽略它 */
async function openViaShell(target: string, label: string): Promise<LaunchResult> {
  try {
    const err = await shell.openPath(target)
    if (err) {
      appLog.error('launchpad', `打开失败：${label}`, err)
      return { ok: false, message: `打开失败: ${err}` }
    }
    return { ok: true, message: `已打开：${label}` }
  } catch (e) {
    const msg = (e as Error).message
    appLog.error('launchpad', `打开异常：${label}`, msg)
    return { ok: false, message: `打开失败: ${msg}` }
  }
}

export async function launchApp(appConfig: LaunchApp): Promise<LaunchResult> {
  const raw = String(appConfig?.cmd || appConfig?.path || '').trim()
  const name = appConfig?.name || raw || '(未命名应用)'
  // 每次启动都留痕：失败时用户界面只看到一句话，真因必须在日志里能查到（第 8 条）
  appLog.info('launchpad', `请求启动：${name}`, { cmd: raw, args: appConfig?.args, hasArgs: Array.isArray(appConfig?.args) })
  const result = await launchAppInner(appConfig, raw, name)
  if (result.ok) appLog.info('launchpad', `启动成功：${name}`, result.message)
  else appLog.warn('launchpad', `启动返回失败：${name}`, result.message)
  return result
}

async function launchAppInner(appConfig: LaunchApp, raw: string, name: string): Promise<LaunchResult> {
  if (!raw) return { ok: false, message: '未配置启动路径' }

  // URL 直开
  if (/^https?:\/\//i.test(raw)) return openUrl(raw)

  if (!fs.existsSync(raw)) {
    appLog.warn('launchpad', `路径不存在：${raw}`)
    return { ok: false, message: `路径不存在: ${raw}` }
  }

  let isDir = false
  try {
    isDir = fs.statSync(raw).isDirectory()
  } catch { /* 取不到就按文件处理 */ }
  if (isDir) return openViaShell(raw, `${name}（目录）`)

  const ext = path.extname(raw).toLowerCase()
  const args = Array.isArray(appConfig.args) ? appConfig.args.map(String) : []
  const cwd = path.dirname(raw)

  // 快捷方式 / 无扩展名：交给 ShellExecute
  if (ext === '.lnk' || ext === '') {
    return openViaShell(raw, name)
  }

  const shellKind = SHELL_EXT[ext]
  if (shellKind === 'cmd') {
    const cmdline = [`"${raw}"`, ...args.map(quoteIfNeeded)].join(' ')
    const comspec = process.env.ComSpec || 'cmd.exe'
    return spawnAndWait(comspec, ['/d', '/s', '/c', `"${cmdline}"`],
      { cwd, verbatim: true, label: `${name}（cmd）` })
  }
  if (shellKind === 'powershell') {
    return spawnAndWait('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', raw, ...args],
      { cwd, label: `${name}（powershell）` })
  }

  return spawnAndWait(raw, args, { cwd, label: name })
}

export async function openFolder(folderPath: string): Promise<LaunchResult> {
  if (!folderPath) return { ok: false, message: '路径为空' }
  if (!fs.existsSync(folderPath)) return { ok: false, message: `路径不存在: ${folderPath}` }
  return openViaShell(folderPath, folderPath)
}

export async function openUrl(url: string): Promise<LaunchResult> {
  if (!url) return { ok: false, message: 'URL 为空' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: `不是合法 URL: ${url}` }
  try {
    await shell.openExternal(url)
    return { ok: true, message: `已打开：${url}` }
  } catch (e) {
    const msg = (e as Error).message
    appLog.error('launchpad', `打开 URL 失败：${url}`, msg)
    return { ok: false, message: `打开失败: ${msg}` }
  }
}
