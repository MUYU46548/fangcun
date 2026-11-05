/**
 * 正文里的链接 → 磁盘上真存在的那条绝对路径（2026-11-05 暮雨第 10 条）。
 *
 * 为什么需要它：日志 / 任务正文里的“蓝色链接”绝大多数是**相对路径**
 * （`desktop/src/main/data/tasks.ts`、`src/cli.py`），因为写它的人拿仓库根当基准。
 * 旧实现直接 `fs.existsSync(相对路径)` —— 那是相对**进程 cwd**，打包后完全对不上，
 * 于是“文件明明在、点了就是打不开”。真正更糟的是没有任何拦截：点一下等于让整个窗口
 * 导航到那个地址，方寸当场白屏成一张纸。
 *
 * 基准只有调用方给的那几个（主进程传：数据根 + 各项目 repo 根），按顺序试第一个命中的。
 * **不猜别的目录**：多猜一个基准就多一条“打开到不该打开的文件”的路。
 *
 * 纯函数（只有 fs.existsSync 这一个副作用），所以能脱离 Electron 单独跑 —— 见
 * `scripts/test/e2e-linkpath.cjs`（含反例：`../` 越界必须拒、不存在的必须给 null）。
 */
import * as fs from 'fs'
import * as path from 'path'

/** `p` 是否真的落在 `root` 里面（等于 root 自己不算 —— 那是目录，不是链接目标） */
export function insideRoot(p: string, root: string): boolean {
  try {
    const rel = path.relative(path.resolve(root), path.resolve(p))
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  } catch {
    return false
  }
}

/**
 * 把链接里写的路径变成一个真能打开的绝对路径；找不到给 `null`（**不抛、不猜、不返回原串**）。
 *
 * 认这几种写法：
 *   · 绝对路径（Windows `E:/x`、`E:\x`；POSIX `/x`）
 *   · `file:///E:/x` 形式的 URL
 *   · 编辑器式后缀：`foo.ts:120`、`foo.md#L3`、`foo.md?x=1` —— 路径本身不带这些
 *   · 相对路径：逐个基准拼，命中即返回；`../` 跑出基准的**直接跳过**
 */
export function resolveLinkPath(raw: string, roots: string[]): string | null {
  let s = String(raw || '').trim().replace(/^["']|["']$/g, '')
  if (!s) return null
  if (/^file:/i.test(s)) {
    try {
      const u = new URL(s)
      s = decodeURIComponent(u.pathname)
      // Windows 下 `file:///E:/x` 的 pathname 是 `/E:/x`，且分隔符全是正斜杠 ——
      // 归一成磁盘写法，返回值和 `path.join` 的结果才能直接比（否则调用方要比两次）
      if (process.platform === 'win32') s = s.replace(/^\//, '').replace(/\//g, '\\')
    } catch {
      return null
    }
  }
  // 锚点与行号是编辑器写法，不属于路径本身
  s = s.replace(/[?#].*$/, '').replace(/:\d+$/, '').trim()
  if (!s) return null

  if (path.isAbsolute(s)) {
    try {
      return fs.existsSync(s) ? s : null
    } catch {
      return null
    }
  }
  for (const root of roots || []) {
    const r = String(root || '').trim()
    if (!r) continue
    const abs = path.resolve(r, s)
    if (!insideRoot(abs, r)) continue
    try {
      if (fs.existsSync(abs)) return abs
    } catch {
      /* 单个基准读不了不该连带整条失败 —— 试下一个 */
    }
  }
  return null
}
