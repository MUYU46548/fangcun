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

import { spawn, execFile } from 'child_process'
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

/**
 * 交给资源管理器（explorer.exe）代启动 —— 2026-10-17 修「点启动只出空壳窗口」。
 *
 * 真因（实测对照，不是猜的）：本机把 `E:\Software\SiTian\SiTian.exe`
 *   ① 用 explorer 打开 → 窗口正常出现（标题 `SiTian — 世界观动态构建系统`）；
 *   ② 从**本进程树**里 CreateProcess/ShellExecute 直接拉起 → 子 Electron 应用的 GPU 进程
 *      连崩 `exit_code=-1073741819`，最后 `FATAL:gpu_data_manager_impl_private.cc(448)]
 *      GPU process isn't usable. Goodbye.`，主窗口只剩一个空壳。
 * 差别不在命令行参数，而在**父进程**：直接从方寸（Electron）派生，子进程留在方寸的
 * job / 进程树里；explorer.exe 是桌面常驻进程，由它再 CreateProcess，子进程才落到
 * 用户桌面会话的常规位置 —— 这正是"双击好使、启动台不好使"的那点差别。
 *
 * 所以无参数的可执行目标一律让 explorer 当中间人；带参数的目标仍然直接 spawn
 * （explorer 传不了参数，而参数是用户在界面上真填过的东西，不能静默丢）。
 */
function launchViaExplorer(target: string, label: string): Promise<LaunchResult> {
  return new Promise<LaunchResult>((resolve) => {
    let settled = false
    const done = (r: LaunchResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      // explorer.exe 对未知/非法路径不报错，只在**路径真不存在**时静默什么都不做。
      // 路径存在性已在 launchAppInner 里查过，这里只负责把它交出去。
      child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: true } as any)
    } catch (e) {
      const msg = (e as Error).message
      appLog.error('launchpad', `交给资源管理器失败：${label}`, msg)
      done({ ok: false, message: `启动失败: ${msg}` })
      return
    }
    child.on('error', (err: Error) => {
      appLog.error('launchpad', `交给资源管理器失败：${label}`, err.message)
      done({ ok: false, message: `启动失败: ${err.message}` })
    })
    child.on('spawn', () => {
      try { child.unref() } catch { /* ignore */ }
      done({ ok: true, message: `已交给系统启动：${label}` })
    })
    setTimeout(() => {
      if (settled) return
      try { child.unref() } catch { /* ignore */ }
      done({ ok: true, message: `已交给系统启动：${label}` })
    }, 1500)
  })
}

/**
 * 列出某个映像名当前所有 PID（用 tasklist，异步 —— 本机 spawnSync 一律 EBUSY）。
 *
 * 存在的理由：交给 explorer 之后**拿不到子进程 PID**（explorer 不回报），
 * 于是"启动成功"只能靠猜。这里用启动前后两次快照做差集，把"猜"换成"看见"。
 * ⚠ tasklist 查不到（名称含特殊字符 / 权限所限 / 系统语言换了输出列）时返回空集，
 *   调用方必须把「空集」当成「没查到」而不是「没在跑」—— 否则会把正常启动报成失败。
 */
export function listImagePids(image: string): Promise<Set<number>> {
  return new Promise<Set<number>>((resolve) => {
    if (!image) return resolve(new Set())
    try {
      execFile(
        'tasklist',
        ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 4000 } as any,
        (err, stdout) => {
          const set = new Set<number>()
          if (err) return resolve(set)
          const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.trim())
          // ⚠ 2026-10-17 实测踩到的坑：Node 拿到的是**系统代码页（GBK）字节**，按 UTF-8 解出来是
          //   `"�޻�ī��.exe"` —— 于是"按名字比对"对中文映像名（绒花墨坊.exe）**永远不相等**，
          //   表现为"每次启动都说没能复查到进程"（一句看着诚实、其实是坏了的提示）。
          //   因此这里**只信 /FI 的过滤结果**，不做名字比对；只用行数做一道「过滤器是否失效」的保险。
          //   （tasklist 过滤不到时输出的是"信息: 没有运行的任务…"这类非 CSV 行，正则自然不命中。）
          for (const line of lines) {
            const m = /^"([^"]*)","(\d+)"/.exec(line.trim())
            if (m) set.add(parseInt(m[2], 10))
          }
          // 保险：/FI 若因语言/版本失效会返回整张表（几十上百行），此时结果不可信，按"没查到"处理
          if (lines.length > 30) return resolve(new Set())
          resolve(set)
        },
      )
    } catch {
      resolve(new Set())
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 交给 explorer 启动，再**复查进程**（不是假设成功）。
 * 三种结局都要能落地成一句用户看得懂的话：
 *   · 出现新 PID        → 真起来了
 *   · 没有新 PID 但有进程 → 之前就在跑（单实例应用常见），也算达意
 *   · 一个都没查到       → 命令确实下发了，但没证据 —— 不许说"已启动"，要说"没能复查到"
 */
async function launchAndVerify(target: string, label: string, image: string): Promise<LaunchResult> {
  const before = image ? await listImagePids(image) : new Set<number>()
  const r = await launchViaExplorer(target, label)
  if (!r.ok || !image) return r
  await sleep(1500)
  const after = await listImagePids(image)
  const fresh = [...after].filter((p) => !before.has(p))
  if (fresh.length) return { ok: true, pid: fresh[0], message: `已启动：${label}（PID ${fresh[0]}）` }
  if (after.size) return { ok: true, pid: [...after][0], message: `已在运行：${label}（PID ${[...after][0]}）` }
  appLog.warn('launchpad', `启动后没能复查到进程：${label}`, `image=${image} before=${before.size} after=${after.size}`)
  return {
    ok: true,
    message: `已交给系统启动：${label}（1.5 秒内没复查到进程 —— 若窗口没出现，请看应用自己的日志）`,
  }
}

/** shell.openPath 返回的是「错误字符串」，空串才算成功 —— 旧实现直接忽略它 */async function openViaShell(target: string, label: string): Promise<LaunchResult> {
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

  // .exe：无参数 → **交给 explorer**（2026-10-17：直接从本方进程树派生会让子 Electron 应用
  //   GPU 进程连崩、只剩空壳窗口；见 launchViaExplorer 注释里的实测对照）。
  //   填了参数 → spawn（explorer 传不了参数，参数不能静默失效）。
  if (ext === '.exe') {
    if (args.length > 0) {
      return spawnAndWait(raw, args, { cwd, label: `${name}（exe + 参数）` })
    }
    return launchAndVerify(raw, name, path.basename(raw))
  }

  const shellKind = SHELL_EXT[ext]
  // 脚本（.bat/.cmd/.ps1）维持经 cmd/powershell 执行：这条链一直是通的（e2e 用 marker 验证过），
  // 而且它需要 cmd 窗口做反馈。⚠ 已知限制：脚本里再拉起的 GUI 应用仍在方寸的 job 里，
  // 若将来碰到同款 GPU 崩，再考虑让 explorer 代跑脚本（代价是失去参数与窗口反馈）。
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
