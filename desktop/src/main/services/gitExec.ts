/**
 * 只读 git 执行器（2026-10-21）。
 *
 * 为什么单独一个文件：`selfSync`（启动拉取）与 `repoDocs`（实况回流取数）都要跑 git，
 * 而两边对"怎么跑"的要求完全一致（异步、禁交互凭据提示、硬超时、不落 stderr 原文给用户）。
 * 抄两遍的代价是"改一处漏一处"，合并的代价是守卫脚本要跨文件匹配 —— 所以合成一个 30 行的
 * 单一出口，把 spawn / 超时 / 环境变量钉死在这里，谁用谁 import。
 *
 * 三条纪律（本项目踩过的坑，别改）：
 *  ① **必须异步 spawn**：本机 `spawnSync/execFileSync` 一律 EBUSY，而且同步等待会卡住首屏；
 *  ② `GIT_TERMINAL_PROMPT=0`：没有凭据时 git 会等终端输入，静默挂成僵尸进程；
 *  ③ 硬超时：远端/大仓库卡住时不能把后台任务永远吊着。
 */
import { spawn } from 'child_process'

export interface GitRun {
  code: number
  out: string
  err: string
  timedOut: boolean
}

/** 跑一条 git 命令。永远 resolve（失败用 code/-1 + stderr 表达），不抛。 */
export function runGit(repo: string, args: string[], timeoutMs = 20000): Promise<GitRun> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', ['-C', repo, ...args], {
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
