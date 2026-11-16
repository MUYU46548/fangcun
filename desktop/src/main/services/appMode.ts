/**
 * 运行态识别：客户端态 / 开发态（2026-11-11 · 卡 task-20261017-002）
 *
 * 暮雨原话（2026-10-17）：“隔壁另一款自有产品十三次试跑都爆炸在 AI 根本分不清客户端和开发态上，
 * 后续方寸如果引入 Agent 模式，务必做好确认。不要让 AI 乱改源码。”
 *
 * 这里做的是那张卡的**第一条**（态必须先声明、且可观测），因为后两条都依赖它：
 *   · 客户端态 = 装在成品目录（`app.isPackaged` / 跑的是 `方寸.exe` / 应用路径在 app.asar 里），
 *     数据在 userData；
 *   · 开发态 = `npm run dev` 起在源码仓库里，数据在仓库。
 * 判据全部是**可读信号**，逐条摊给人看 —— 不让 AI 猜，也不让用户自己猜。
 *
 * ⚠ 关于“改源码要二次确认”（卡上第 2、3 条）：方寸现在的 MCP 层**没有任何代码写入口**
 *   （工具表里一个写文件的地方都没有，写数据全部走 data 层并受 MCP 写入档位约束）。
 *   所以“客户端态禁止改源码”是靠**结构上没有入口**保证的，不是靠弹窗。
 *   这条约束的真身是 `scripts/test/e2e-app-mode.cjs` 里的源码守卫（tools.ts 不得出现写文件调用）。
 */
import * as path from 'path'
import { app } from 'electron'
import { getDataDir } from '../data'

export type AppModeName = 'client' | 'dev'

export interface AppModeSignal {
  key: string
  value: string
  /** 这个信号说明了什么（给人看，不是给机器看） */
  note: string
}

export interface AppModeInfo {
  mode: AppModeName
  packaged: boolean
  exePath: string
  appPath: string
  dataDir: string
  /** 一句话：我现在是什么态、能不能改源码 */
  summary: string
  signals: AppModeSignal[]
}

/**
 * MCP 层允许“写源码”的工具清单。
 *
 * **恒为空**，而且是刻意留的：如果哪天有人往 MCP 里加一个写源码的工具，必须在这里登记，
 * 登记时会被迫回答“客户端态怎么办”。守卫 `e2e-app-mode` 会断言这个数组为空且 tools.ts 里
 * 没有任何文件写调用。
 */
export const MCP_CODE_WRITE_TOOLS: string[] = []

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

export function detectAppMode(): AppModeInfo {
  const packaged = safe(() => !!app.isPackaged, false)
  const appPath = safe(() => String(app.getAppPath() || ''), '')
  const exePath = safe(() => String(app.getPath('exe') || ''), '')
  const dataDir = safe(() => String(getDataDir() || ''), '')
  const inAsar = /\.asar(\\|\/|$)/i.test(appPath)
  const exeName = path.basename(exePath).toLowerCase()
  // 成品名是 `方寸.exe`；开发态跑的是 `electron.exe`（node_modules 里那个）
  const looksInstalled = exeName === '方寸.exe' || exeName === 'fangcun.exe'

  const mode: AppModeName = (packaged || inAsar || looksInstalled) ? 'client' : 'dev'

  const signals: AppModeSignal[] = [
    {
      key: 'app.isPackaged',
      value: String(packaged),
      note: packaged ? '是打包版' : '不是打包版（npm run dev / electron .）',
    },
    {
      key: '应用路径',
      value: appPath || '（取不到）',
      note: inAsar ? '在 app.asar 里 = 成品' : '在源码目录里 = 开发态',
    },
    {
      key: '可执行文件',
      value: exePath || '（取不到）',
      note: looksInstalled ? '方寸.exe = 成品' : 'electron.exe = 开发态',
    },
    {
      key: '数据目录',
      value: dataDir || '（取不到）',
      note: mode === 'client' ? '成品态的数据在 userData（不在安装目录里）' : '开发态的数据在仓库里',
    },
  ]

  const summary = mode === 'client'
    ? '客户端态：这是装好的成品。AI 只能读数据 / 写数据（受 MCP 写入档位约束），**不能改源码** —— 想改源码要由人切到开发态，切态不是 AI 的动作。'
    : '开发态：这是源码仓库。AI 改源码前必须先说明改哪个文件 / 改什么 / 为什么，人点头再动手；数据也在仓库里，改动会进 git。'

  return { mode, packaged, exePath, appPath, dataDir, summary, signals }
}

/** 给 MCP 的 initialize 用：一句话状态行（agent 一进门就知道自己在哪） */
export function appModeLine(info?: AppModeInfo): string {
  const m = info || detectAppMode()
  return `当前运行态：${m.mode === 'client' ? '客户端态（成品）' : '开发态（源码）'}；数据目录：${m.dataDir || '未知'}。`
}
