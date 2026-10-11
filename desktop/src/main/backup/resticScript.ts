/**
 * restic 增量备份脚本生成（纯逻辑）—— 2026-10-11，卡 `task-20261002-003`「备份多通道」之 restic 支线
 *
 * 用户口径（2026-10-11 22:38 拍板）：**restic 走方案 A** ——
 *   方寸只**生成命令脚本 + 说明**，cron / 计划任务由用户自己挂。
 *   零维护、零鉴权、**不碰用户密钥**（方案 B 要在方寸里管仓库密码，不做）。
 *
 * 为什么把它做成纯函数、放主进程而不是塞在渲染层：
 *   `tsc` 编出 `dist/main/backup/resticScript.js` 后能被 node 直接断言
 *   （见 `scripts/test/e2e-restic-script.cjs`）—— 埋在组件里就只能靠真点界面才验得到。
 *
 * ⚠ 三条红线（写进脚本注释，也是测试的判据）：
 *   ① **密码绝不写进脚本** —— 只教用户设 `RESTIC_PASSWORD` 环境变量；
 *   ② **密钥文件必须 exclude** —— 数据根里混着 llm-config.json 这类含 API Key 的文件，
 *      备份包（`backup/rules.ts` 的 SECRET_BASENAMES）排除它们，restic 这条线也必须排除，
 *      否则"多一条备份通道"就变成"多一个密钥泄漏面"；
 *   ③ **不给可直接执行的定时任务** —— 只给脚本正文 + 怎么挂，装不装由用户定。
 */

export type ResticOs = 'win' | 'posix'

export interface ResticScriptInput {
  /** 要备份的**数据根**（不是单个 task-data —— todos / notifications / policies / registry.yaml 都在同级） */
  dataDir: string
  /** 必须是 `backup/rules.ts` 的 `SECRET_BASENAMES` —— 调用方传进来，这里不自己编一份 */
  exclude?: string[]
  os?: ResticOs
  /** 仓库地址提示（只写进注释，不写进命令 —— 命令用环境变量） */
  repoHint?: string
}

/** 把 Windows 路径里的反斜杠转成 restic 认的形式（restic 在 Windows 上两种都吃，但正斜杠更稳） */
function normPath(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function buildResticScript(input?: ResticScriptInput | null): string {
  // 容错：调用方漏传（undefined/null）不该炸 —— 一条备份通道的生成器挂掉，
  // 用户只会看到「点了没反应」。（首轮测试就抓到了这个：`buildResticScript(undefined)` 抛。）
  const cfg: ResticScriptInput = input || { dataDir: '' }
  const dir = normPath(cfg.dataDir) || '<你的方寸数据目录>'
  const os: ResticOs = cfg.os || 'win'
  const repo = (cfg.repoHint || '').trim() || (os === 'win' ? 'E:/Backups/fangcun-restic' : '/mnt/backup/fangcun-restic')
  const excludes = (cfg.exclude || []).filter(Boolean)

  const L: string[] = []
  L.push('# ═════ 方寸 · restic 增量备份脚本（由方寸生成，可直接改）═════')
  L.push('#')
  L.push('# 为什么用 restic：它是「仓库型」增量备份 —— 只传变化的部分、自带去重、可校验、可挂载。')
  L.push('# 它跟「导出备份 zip 到网盘」不是一回事，别混：')
  L.push('#     zip    = 整包快照，一份就是全部，适合丢进同步盘 / 手动传')
  L.push('#     restic = 增量仓库，第一份之后每次只传增量，适合每天自动跑')
  L.push('#')
  L.push('# ── 一次性准备（三步，只做一次）────────────────────────')
  if (os === 'win') {
    L.push('#   1) 装 restic：winget install restic')
    L.push('#   2) 设两个环境变量（**别把密码写进本脚本**）：')
    L.push(`#        setx RESTIC_REPOSITORY "${repo}"`)
    L.push('#        setx RESTIC_PASSWORD   "<你自己定的仓库密码>"')
    L.push('#      ⚠ setx 设完要**重开一个终端**才生效；密码只存在你自己的环境里，方寸不经手。')
    L.push('#   3) 初始化仓库（只跑这一次）：')
    L.push('#        restic init')
  } else {
    L.push('#   1) 装 restic：apt install restic   （或系统包管理器）')
    L.push('#   2) 设两个环境变量（**别把密码写进本脚本**）：')
    L.push(`#        export RESTIC_REPOSITORY="${repo}"`)
    L.push('#        export RESTIC_PASSWORD="<你自己定的仓库密码>"')
    L.push('#      ⚠ 建议写进 ~/.profile 或专门的 env 文件，权限 600；方寸不经手密码。')
    L.push('#   3) 初始化仓库（只跑这一次）：')
    L.push('#        restic init')
  }
  L.push('#')
  L.push('# ── 挂定时 ───────────────────────────────────────────')
  if (os === 'win') {
    L.push('#   任务计划程序 → 创建基本任务 → 每天 → 操作选「启动程序」')
    L.push('#   程序：powershell.exe')
    L.push('#   参数：-NoProfile -ExecutionPolicy Bypass -File "<这个脚本的完整路径>"')
  } else {
    L.push('#   crontab -e，加一行（每天 03:30）：')
    L.push('#   30 3 * * * /usr/bin/env bash "<这个脚本的完整路径>" >> ~/fangcun-restic.log 2>&1')
  }
  L.push('')
  L.push('# ═════ 以下才是真正会跑的部分 ═════')
  if (os === 'win') {
    L.push('$ErrorActionPreference = "Stop"')
    L.push(`$src = "${dir}"`)
    L.push('if (-not (Test-Path $src)) { Write-Error "数据目录不存在：$src"; exit 1 }')
    L.push('if (-not $env:RESTIC_PASSWORD) { Write-Error "没有 RESTIC_PASSWORD —— 先按上面第 2 步设好环境变量"; exit 1 }')
    L.push('')
    L.push('# 备份（--exclude 是红线：这些文件里有密钥，绝不能进备份仓库）')
  } else {
    L.push('#!/usr/bin/env bash')
    L.push('set -euo pipefail')
    L.push(`src="${dir}"`)
    L.push('[ -d "$src" ] || { echo "数据目录不存在：$src" >&2; exit 1; }')
    L.push('[ -n "${RESTIC_PASSWORD:-}" ] || { echo "没有 RESTIC_PASSWORD —— 先按上面第 2 步设好" >&2; exit 1; }')
    L.push('')
    L.push('# 备份（--exclude 是红线：这些文件里有密钥，绝不能进备份仓库）')
  }

  const exArgs = excludes.map((e) => `--exclude "${e}"`).join(' ')
  const cont = os === 'win' ? '`' : '\\'
  if (excludes.length) {
    L.push(`restic backup "${dir}" --tag fangcun ${cont}`)
    L.push(`  ${exArgs.replace(/ --exclude /g, ' ' + cont + '\n  --exclude ')}`)
  } else {
    L.push(`restic backup "${dir}" --tag fangcun`)
  }
  L.push('')
  L.push('# 保留策略：日 7 / 周 4 / 月 6，然后真正回收空间（不加 --prune 只是标记，不省磁盘）')
  L.push('restic forget --tag fangcun --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune')
  L.push('')
  L.push('# 完整性抽检（可选，慢；建议每周跑一次而不是每天）')
  L.push('# restic check --read-data-subset=5%')
  return L.join('\n')
}

/** 生成脚本时用的密钥文件名单（与 `backup/rules.ts` 的 `SECRET_BASENAMES` 是**同一份**，由调用方传入）。 */
export function resticExcludeArgs(exclude: string[] | null | undefined): string[] {
  return (Array.isArray(exclude) ? exclude : []).filter(Boolean).map((e) => `--exclude "${e}"`)
}
