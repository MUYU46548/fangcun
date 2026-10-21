/**
 * 方寸自仓启动同步（2026-10-21 · W1-1C）。
 *
 * 要解决的事（施工单原话）：「远端推一笔 → 重启方寸 → registry 自动更新，无弹窗；
 * 本地领先时重启 → 显示"待同步"，数据无损」。
 *
 * 三条边界，越界即错：
 *  ① **只碰方寸自仓**：数据根（`getDataDir()`）里有 `.git` 才算自仓；别的项目仓库依旧只读
 *     （`ipc.ts` 里 `git:taskCommits` 那条铁律不动 —— 不 fetch 不写别人仓库）。
 *  ② **只 `--ff-only`**：绝不 merge、绝不 force、绝不 stash。本地有未推送提交或与远端分叉时，
 *     git 自己会拒，我们**照实记"待同步"**，不改任何文件。
 *  ③ **不弹窗、不加手动按钮**（用户零动作原则）：启动后台跑一次；失败静默落应用日志 +
 *     状态行显示「待同步」。用户不需要知道 git 的存在，只在"没跟上"时看到一句实话。
 *
 * ⚠ 用异步 `spawn` 而不是 `spawnSync`：本机 `spawnSync/execFileSync` 一律 EBUSY（见项目记忆），
 *   而且同步等待会卡住首屏。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getDataDir } from '../data'
import * as appLog from './appLog'

export type SyncState = 'idle' | 'running' | 'ok' | 'behind' | 'skipped' | 'failed'

export interface SelfSyncStatus {
  state: SyncState
  /** 最后一次尝试的时间（ISO）；从未跑过为空串 */
  at: string
  /** 给人看的一句话（不含命令原文、不含凭据） */
  message: string
  /** 数据根（界面上不展示，排障用） */
  repo: string
}

let status: SelfSyncStatus = { state: 'idle', at: '', message: '', repo: '' }

export function getSelfSyncStatus(): SelfSyncStatus {
  return { ...status }
}

interface GitRun {
  code: number
  out: string
  err: string
  timedOut: boolean
}

/** 跑一条 git 命令。**异步** + 硬超时（网络挂住时不能把后台任务永远吊着）。 */
function runGit(repo: string, args: string[], timeoutMs = 20000): Promise<GitRun> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', ['-C', repo, ...args], {
        // 关键：禁掉交互式凭据提示。否则没凭据时 git 会等终端输入 → 静默挂成僵尸进程。
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', LC_ALL: 'C' },
        windowsHide: true,
      })
    } catch (e) {
      resolve({ code: -1, out: '', err: (e as Error).message, timedOut: false })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* ignore */ }
    }, timeoutMs)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: out + err + (e as Error).message, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code == null ? -1 : code, out, err, timedOut })
    })
  })
}

/** 把 git 的英文拒绝理由翻成一句人话（分类而不是原样抛，用户不该读 stderr）。 */
function classifyFailure(r: GitRun): string {
  if (r.timedOut) return '拉取超时（网络或远端没响应），已放弃，本地数据未动'
  const s = `${r.out}\n${r.err}`
  if (/Not possible to fast-forward|would be overwritten|diverg/i.test(s)) {
    return '本地有未推送的提交或与远端分叉 —— 已按规矩不合并、不强拉，数据未动'
  }
  if (/no tracking information|no upstream|not currently on a branch|HEAD detached/i.test(s)) {
    return '这个仓库没有上游分支（或处于游离 HEAD）—— 没东西可拉'
  }
  if (/terminal prompts disabled|Authentication failed|could not read Username|Permission denied/i.test(s)) {
    return '需要凭据（终端提示被禁用，不会偷偷挂起等输入）'
  }
  if (/Could not resolve host|unable to access|Connection (refused|reset)|timed out/i.test(s)) {
    return '连不上远端（网络或地址不可达），下次启动再试'
  }
  // 兜底：只取 git 的最后一行、截断——不把整段 stderr 摆到界面上
  const last = s.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '未知原因'
  return last.slice(0, 120)
}

/**
 * 启动时跑一次（也允许别处手动触发，但目前只有启动一处 —— 用户零动作原则）。
 * 永远 resolve，不抛：启动同步失败不该影响开窗。
 */
export async function syncSelfRepoOnBoot(): Promise<SelfSyncStatus> {
  const repo = getDataDir()
  const set = (patch: Partial<SelfSyncStatus>): SelfSyncStatus => {
    status = { ...status, at: new Date().toISOString(), repo, ...patch }
    return getSelfSyncStatus()
  }

  if (!fs.existsSync(path.join(repo, '.git'))) {
    // 装出来的应用（exeDir 数据根）本来就没有 .git —— 这是正常态，不是错误
    return set({ state: 'skipped', message: '数据根不是 git 仓库（安装版常态），跳过自动同步' })
  }

  set({ state: 'running', message: '' })
  const r = await runGit(repo, ['pull', '--ff-only'])
  if (r.code === 0) {
    const text = (r.out || '').trim()
    const upToDate = /Already up to date|已经是最新/i.test(text)
    const msg = upToDate ? '已是最新' : '已拉到远端最新'
    appLog.info('selfsync', `启动同步成功：${msg}`, text.slice(-400))
    return set({ state: 'ok', message: msg })
  }

  const why = classifyFailure(r)
  // 失败分两种：**可解释的常态**（本地领先/分叉/无上游/没网）记 WARN；命令本身跑不起来记 ERROR
  if (r.code === -1) appLog.error('selfsync', '启动同步失败（git 没跑起来）', `${why} | ${r.err.slice(-300)}`)
  else appLog.warn('selfsync', `启动同步未完成：${why}`, (r.out + r.err).slice(-400))
  return set({ state: r.code === -1 ? 'failed' : 'behind', message: why })
}
