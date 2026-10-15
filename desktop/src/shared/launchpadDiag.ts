/**
 * 启动台登记 × 端口 的自洽诊断（纯函数，2026-10-15）
 *
 * 真事（别再踩）：`apps.json` 里「绒花墨坊」把 **vite dev server 的 8090** 登记在**打包好的
 * Electron exe** 上（目录里是 `chrome_100_percent.pak` / `icudtl.dat`）。服务页对「空闲 + 来源=启动台」
 * 的行给「▶ 启动」，用户点完仍是「空闲」——于是又一次得出"启动台坏了"。
 *
 * 根因是**两个概念被混成一个**：
 *   - `port`  = 「这个应用对外提供哪个端口」（登记信息）
 *   - `cmd`   = 「点一下会执行什么」（启动信息）
 * 二者**可以完全无关** —— GUI 程序本来就不监听任何端口。
 *
 * 本函数只做**有据可依的静态分类**，绝不声称"它一定起不来"（那只能靠**启动后复查监听**判定）。
 * 因此 `suspect` 的语义是「这条登记值得看一眼」，不是「这条是错的」。
 */

export type PortDiagLevel = 'none' | 'ok' | 'suspect'

export interface PortDiag {
  level: PortDiagLevel
  /** 稳定机器码，供断言 / 日志 / 埋点用 —— 判据一律认它，别认文案 */
  code: string
  /** 给用户看的一句话（说人话，不猜、不吓人） */
  message: string
}

export interface PortDiagInput {
  name?: string
  port?: number | null
  cmd?: string
  path?: string
}

/** 会自己起服务的启动形态（脚本类 —— 内容里常常就是 `python xxx.py --port N` 之类） */
const SERVER_CMD_EXT = ['.bat', '.cmd', '.ps1', '.py', '.sh', '.js', '.mjs', '.cjs']

/** 从任意路径里取文件名（渲染层没有 node:path，自己切） */
export function baseNameOf(p: string): string {
  const s = String(p || '').trim().replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

/** 取小写扩展名（含点）；没有扩展名返回 '' */
export function extOf(p: string): string {
  const b = baseNameOf(p).toLowerCase()
  const i = b.lastIndexOf('.')
  // 形如 `.gitignore` 的名字不算扩展名
  return i > 0 ? b.slice(i) : ''
}

/**
 * 给「启动命令」一个说人话的短标签（服务页要显示它，让人一眼看出接的是什么）
 */
export function describeLaunchCommand(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return '（没填启动命令）'
  if (/^https?:\/\//i.test(s)) return '网址（外部服务）'
  const ext = extOf(s)
  if (!ext) return s.endsWith('/') || s.endsWith('\\') ? '目录' : '无扩展名（按 ShellExecute 打开）'
  if (ext === '.lnk') return '快捷方式'
  if (SERVER_CMD_EXT.includes(ext)) return `脚本 ${ext}`
  if (ext === '.exe') return '桌面程序 .exe'
  return ext
}

/**
 * 核心判据。
 *
 * 返回 `none` = 这条登记不含端口（不该出现在服务页的"启动"语境里）；
 * `ok`   = 启动形态**有可能**监听该端口；
 * `suspect` = 启动形态与"监听端口"这件事对不上，值得看一眼（**不是**断言它坏了）。
 */
export function diagnosePortRegistration(app: PortDiagInput | null | undefined): PortDiag {
  if (!app) return { level: 'none', code: 'no-app', message: '' }

  const port = Number(app.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { level: 'none', code: 'no-port', message: '这条登记没有端口，不会进服务页' }
  }

  const raw = String(app.cmd || app.path || '').trim()
  if (!raw) {
    return {
      level: 'suspect',
      code: 'no-cmd',
      message: `登记了 :${port} 但没填启动命令 —— 服务页那个「▶ 启动」没有东西可拉。去启动台补上命令，或去掉这个端口。`,
    }
  }

  if (/^https?:\/\//i.test(raw)) {
    return { level: 'ok', code: 'url', message: `:${port} 指向一个网址（外部服务），方寸只负责打开它。` }
  }

  const ext = extOf(raw)
  const file = baseNameOf(raw)

  // 目录 / 快捷方式 / 脚本：这类启动形态**有可能**把服务拉起来
  if (!ext || ext === '.lnk' || SERVER_CMD_EXT.includes(ext)) {
    return { level: 'ok', code: 'script-or-dir', message: `:${port} 由「${file}」（${describeLaunchCommand(raw)}）拉起，有可能真会监听。` }
  }

  if (ext === '.exe') {
    return {
      level: 'suspect',
      code: 'exe-cmd',
      message:
        `登记的启动命令是桌面程序「${file}」—— 桌面程序通常**不会**监听 :${port}。` +
        `点「▶ 启动」只是把这个程序打开，端口不会因此起来。` +
        `要么把启动命令换成真正起服务的脚本，要么把 :${port} 这个登记去掉（它可能只是开发时的 dev server 端口）。`,
    }
  }

  return {
    level: 'suspect',
    code: 'unknown-ext',
    message: `:${port} 的启动命令是「${file}」（${describeLaunchCommand(raw)}）—— 看不出它会监听端口，点「▶ 启动」后若仍是「空闲」就是这条接错了。`,
  }
}

/**
 * 启动完之后，跟用户说一句"观测到了什么"（2026-10-15 新模型）。
 *
 * ⚠ 措辞是**中性**的 —— 「没观测到端口」**不是失败**：大多数桌面程序本来就不监听任何端口。
 * 旧模型（把 port 当配置项）在这里会说"这条登记接错了"，那是**错误的预设**：
 * 它默认"启动一个应用就应该有一个端口起来"。用户原话：「端口永远是记不住的，不要指望根据端口去配置」。
 */
export function explainStartObserved(appName: string, newPorts: number[]): string {
  const n = String(appName || '这个应用').trim() || '这个应用'
  const fresh = (newPorts || []).filter(p => Number.isInteger(p) && p > 0).sort((a, b) => a - b)
  if (fresh.length) {
    return `已启动「${n}」，观测到它新开了 :${fresh.join(' :')}（已记到它名下，下次不用再找）`
  }
  return (
    `已启动「${n}」；这次没观测到它新开端口。` +
    `桌面程序大多不监听端口，这属正常 —— 不代表启动失败。（真要用浏览器访问某个服务，` +
    `去看下面「未登记但在监听」那段，那里列的是方寸自己扫出来的端口，不用你记。）`
  )
}
