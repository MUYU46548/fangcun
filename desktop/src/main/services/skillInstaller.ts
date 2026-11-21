/**
 * Fangcun Desktop — Skill Installer Service
 *
 * 负责：
 * 1. 首次启动自动检测并安装 skills
 * 2. 提供 getSkillsStatus IPC 通道（供渲染层查询）
 * 3. 提供 installSkills IPC 通道（供设置页手动触发）
 *
 * 数据来源：应用 resources/skills/（随安装包分发的真源）
 * 安装目标：**可直装目标**——Hermes（%LOCALAPPDATA%\hermes\skills）与
 *           DSH（~/.dsh/skills，2026-10-03 卡 task-20261003-011 纳入）。
 *           两家落点都是**实测过**的：方寸技能卡已被这两个 agent 各装进去一份。
 *           其余 agent（WorkBuddy 等）目录不可知 → 只给文件 + 自装指令，不写。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app, shell } from 'electron'
import * as appLog from './appLog'
import { dshHome } from './probe'
import { FALLBACK_SKILL_DIRS, readSkillIdsFromDir, judgeSkillSyncStale } from '../../shared/skillSync'

/**
 * 技能清单与「同步是否作数」的判据都在 `shared/skillSync.ts`（纯函数，可单独跑）。
 * 这里只做一件事：把"随包分发的源目录"喂给它。
 */
function skillDirIds(): string[] {
  return readSkillIdsFromDir(getResourcesSkillsDir())
}

/**
 * manifest 里的「技能 → 目标 agent」对照（2026-11-21）。
 *
 * 为什么需要：`skill-management-policy` 教的是 Hermes 侧的分区/写权限纪律，
 * 往 DSH 里装只会变成噪音。manifest 的 `target` 字段本来就有（此前只用于界面展示），
 * 现在真正参与分发：`Hermes` 只装 Hermes，`All` 装所有可直装目标。
 * 读不到 manifest 时退回“全部技能、目标 All”（宁可多装，不静默漏装）。
 */
function skillEntries(): { id: string; target: string }[] {
  const dir = getResourcesSkillsDir()
  try {
    const mp = path.join(dir, 'manifest.json')
    if (fs.existsSync(mp)) {
      const m = JSON.parse(fs.readFileSync(mp, 'utf-8'))
      const rows = (Array.isArray(m?.skills) ? m.skills : [])
        .map((e: any) => ({ id: String(e?.id || '').trim(), target: String(e?.target || 'All').trim() }))
        .filter((e: any) => !!e.id)
      if (rows.length) return rows
    }
  } catch { /* manifest 坏了 → 目录扫描兜底 */ }
  return skillDirIds().map((id) => ({ id, target: 'All' }))
}

/** 某个目标该分到哪些技能（`All` 通吃；大小写不敏感）。 */
function skillIdsForTarget(targetId: string): string[] {
  const want = String(targetId || '').toLowerCase()
  return skillEntries()
    .filter((e) => {
      const t = e.target.toLowerCase()
      return t === 'all' || t === 'any' || t === want
    })
    .map((e) => e.id)
}

/**
 * 同步/跳过之后**重新读盘**的逐技能复核（2026-11-21）。
 *
 * 用户原话：“运提示已是最新。但我怎么确定是真同步了还是方寸假绿骗人？”
 * 所以不能再拿“刚才安装函数没报错”当结论 —— 必须把源与目标两份文件各算一次 md5，
 * 把**两份指纹**一起交给界面。`match` 只认“两边都有且相等”。
 */
export interface SkillCheckRow {
  id: string
  /** 真源 SKILL.md 的 md5（读不到为空串） */
  srcHash: string
  /** 目标端当前 SKILL.md 的 md5（没装为空串） */
  destHash: string
  match: boolean
  /** 目标端文件的最后修改时间（ISO；没装为空串） */
  destAt: string
}

function verifyTarget(targetId: string): { checks: SkillCheckRow[]; verified: boolean } {
  const target = findTarget(targetId)
  const checks: SkillCheckRow[] = []
  if (!target) return { checks, verified: false }
  const resourcesDir = getResourcesSkillsDir()
  const destRoot = target.dir()
  for (const id of skillIdsForTarget(targetId)) {
    const src = path.join(resourcesDir, id, 'SKILL.md')
    const dest = path.join(destRoot, id, 'SKILL.md')
    const srcHash = fileMd5Safe(src)
    const destHash = fileMd5Safe(dest)
    let destAt = ''
    try { if (fs.existsSync(dest)) destAt = fs.statSync(dest).mtime.toISOString() } catch { /* 读不到就留空 */ }
    checks.push({ id, srcHash, destHash, match: !!srcHash && srcHash === destHash, destAt })
  }
  return { checks, verified: checks.length > 0 && checks.every((c) => c.match) }
}


interface SkillInstallResult {
  installed: string[]
  skipped: string[]
  errors: { skill: string; error: string }[]
}

/**
 * 可直装目标清单（**单一真相源**：checkSkillsStatus / installSkillsTo / listSkillsForUi 全用它）。
 *
 * `present()` = 目标是否在场：
 *   · Hermes：恒 true（原位行为 —— 目录不存在就建出来，这是方寸自己依赖的宿主）；
 *   · DSH：只有 `~/.dsh` 存在才在场 —— 别给一个没装 DSH 的机器凭空造 `~/.dsh/skills`
 *     （那正是"往猜出来的目录里写东西"，本模块的红线）。
 */
interface InstallTargetDef {
  id: string
  name: string
  dir: () => string
  present: () => boolean
}

export const INSTALL_TARGETS: InstallTargetDef[] = [
  { id: 'hermes', name: 'Hermes', dir: () => getHermesSkillsDir(), present: () => true },
  { id: 'dsh', name: 'DSH', dir: () => getDshSkillsDir(), present: () => fs.existsSync(dshHome()) },
]

function findTarget(id: string): InstallTargetDef | undefined {
  return INSTALL_TARGETS.find(t => t.id === id)
}

function getResourcesSkillsDir(): string {
  // 打包后：resources/skills/
  // 开发态：E:/CODE/CangKu/fangcun/skills/
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(__dirname, '../../../../skills')
  return base
}

/** 供 skillImport 复用：方寸技能的「主落点」（DSH 在场优先，否则 Hermes）。 */
export function getPrimarySkillsDirPath(): string {
  return getPrimaryInstallTarget().dir()
}

/** 主落点的名字（界面文案用，避免把 Hermes 写死）。 */
export function getPrimarySkillsTargetName(): string {
  return getPrimaryInstallTarget().name
}

/**
 * 外部导入的落点：**DSH 在场就落 DSH，否则才落 Hermes**（2026-11-21）。
 *
 * 背景：暮雨反馈“方寸本来就不是只给 Hermes 做的……用户不一定有 Hermes，或者根本不知道那是什么”。
 * 导入技能若仍写死 `~/.hermes/skills`，没有 Hermes 的机器会被凭空造出一个 hermes 目录。
 */
export function getPrimaryInstallTarget(): InstallTargetDef {
  const dsh = findTarget('dsh')
  if (dsh && dsh.present()) return dsh
  return findTarget('hermes') || INSTALL_TARGETS[0]
}

/** 供 skillImport 复用：Hermes 技能目录（不另造第二个真相源） */
export function getHermesSkillsDirPath(): string {
  return getHermesSkillsDir()
}

/** 供 skillImport 复用：DSH 技能目录（外部导入的另一个候选落点）。 */
export function getDshSkillsDirPath(): string {
  return getDshSkillsDir()
}

/**
 * 方寸**真源** skills 目录（manifest.json 所在处）。
 *
 * 2026-09-28 导出理由：`skills:reveal` 的路径白名单此前只放行 Hermes 侧，
 * 于是技能页“📂 显示 SKILL.md”在"方寸自发布技能"那张卡上**必然失败**
 * （日志实测 4 条 `路径不在技能目录内`）。那个按钮的用户故事恰恰是
 * “装到 WorkBuddy 这类只能手动导入的 agent”—— 要拖的正是真源这一份。
 */
export function getResourcesSkillsDirPath(): string {
  return getResourcesSkillsDir()
}

/**
 * 方寸“自发布”技能 id 集合 = manifest 登记的 + resources/skills 下带 SKILL.md 的目录。
 * 用途：外部导入**不许覆盖**这些技能（它们是方寸自己的交付物，该走“⚡ 装到 Hermes”）。
 */
export function getPublishedSkillIds(): Set<string> {
  const ids = new Set<string>(FALLBACK_SKILL_DIRS)
  const dir = getResourcesSkillsDir()
  try {
    const mp = path.join(dir, 'manifest.json')
    if (fs.existsSync(mp)) {
      const m = JSON.parse(fs.readFileSync(mp, 'utf-8'))
      for (const e of Array.isArray(m?.skills) ? m.skills : []) {
        const id = String(e?.id ?? '').trim()
        if (id) ids.add(id)
      }
    }
  } catch {
    /* manifest 读不出来就只靠目录扫描 */
  }
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) ids.add(d.name)
    }
  } catch {
    /* 目录不存在就忽略 */
  }
  return ids
}

function getHermesSkillsDir(): string {
  // Windows: C:\Users\muyu\AppData\Local\hermes\skills\
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
  return path.join(localAppData, 'hermes', 'skills')
}

/** DSH 侧技能目录（2026-10-03 实测落点；`~/.dsh` 由 probe.dshHome 解析，测试可重定向） */
function getDshSkillsDir(): string {
  return path.join(dshHome(), 'skills')
}

function fileMd5Safe(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? md5File(filePath) : ''
  } catch {
    return ''
  }
}

function md5File(filePath: string): string {
  const hash = crypto.createHash('md5')
  const content = fs.readFileSync(filePath)
  hash.update(content)
  return hash.digest('hex')
}

/** 每个安装目标各记一本账（放各自技能目录里）—— 混在一起就分不清是谁装的 */
function getInstalledManifestPath(dir: string): string {
  return path.join(dir, '.fangcun-installed.json')
}

function readInstalledManifest(dir: string): Record<string, { hash: string; installedAt: string }> {
  const p = getInstalledManifestPath(dir)
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function writeInstalledManifest(dir: string, manifest: Record<string, { hash: string; installedAt: string }>): void {
  const p = getInstalledManifestPath(dir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8')
}

function copySkillDir(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true })
  const srcSkillMd = path.join(srcDir, 'SKILL.md')
  const destSkillMd = path.join(destDir, 'SKILL.md')
  fs.copyFileSync(srcSkillMd, destSkillMd)
}

/**
 * 检查 skills 是否需要安装（按目标）
 */
export function checkSkillsStatus(targetId = 'hermes'): {
  targetId: string
  targetName: string
  needsInstall: boolean
  skills: { name: string; installed: boolean; outdated: boolean; hash: string }[]
} {
  const target = findTarget(targetId)
  const skills: { name: string; installed: boolean; outdated: boolean; hash: string }[] = []
  if (!target) return { targetId, targetName: '', needsInstall: false, skills }

  const resourcesDir = getResourcesSkillsDir()
  const destRoot = target.dir()

  for (const skillDir of skillIdsForTarget(target.id)) {
    const srcSkillMd = path.join(resourcesDir, skillDir, 'SKILL.md')
    if (!fs.existsSync(srcSkillMd)) continue

    const currentHash = md5File(srcSkillMd)
    const destSkillMd = path.join(destRoot, skillDir, 'SKILL.md')
    const installed = fs.existsSync(destSkillMd)
    // ⚠ 只看 manifest 里记的 hash 是不够的（2026-09-26 修）：那份记录只说明"上次装成功过"，
    //   说明不了"现在磁盘上这份还对"。装好的副本被改坏/半途写坏时，旧逻辑会永远跳过。
    //   所以“过时”= 没装，或**磁盘上那份**与真源不一致。
    const outdated = !installed || fileMd5Safe(destSkillMd) !== currentHash

    skills.push({
      name: skillDir,
      installed,
      outdated,
      hash: currentHash,
    })
  }

  return {
    targetId: target.id,
    targetName: target.name,
    needsInstall: skills.some(s => !s.installed || s.outdated),
    skills,
  }
}

/**
 * 安装 skills（默认 Hermes，兼容既有 `skills:install` 通道）
 * 幂等：已安装且 hash 一致则跳过
 */
export function installSkills(): SkillInstallResult {
  return installSkillsTo('hermes')
}

/**
 * 安装 skills 到指定目标（卡 task-20261003-011 / 010）
 * 幂等：已安装且 hash 一致则跳过
 */
export function installSkillsTo(targetId: string): SkillInstallResult {
  const result: SkillInstallResult = { installed: [], skipped: [], errors: [] }
  const target = findTarget(targetId)
  if (!target) {
    result.errors.push({ skill: '(目标)', error: `未知安装目标：${targetId}` })
    return result
  }
  const resourcesDir = getResourcesSkillsDir()
  const destRoot = target.dir()

  appLog.info('skills', `开始安装 skills → ${target.name}，源: ${resourcesDir}`)

  for (const skillDir of skillIdsForTarget(target.id)) {
    try {
      const srcSkillMd = path.join(resourcesDir, skillDir, 'SKILL.md')
      if (!fs.existsSync(srcSkillMd)) {
        result.skipped.push(skillDir)
        continue
      }

      const currentHash = md5File(srcSkillMd)
      const destSkillMd = path.join(destRoot, skillDir, 'SKILL.md')
      const manifest = readInstalledManifest(destRoot)
      const saved = manifest[skillDir]

      // 已存在、且 manifest 记录与**目标端实际内容**都与真源一致 → 跳过
      if (fs.existsSync(destSkillMd) && saved && saved.hash === currentHash &&
          fileMd5Safe(destSkillMd) === currentHash) {
        result.skipped.push(skillDir)
        continue
      }

      // 复制整个目录
      const srcDir = path.join(resourcesDir, skillDir)
      const destDir = path.join(destRoot, skillDir)
      copySkillDir(srcDir, destDir)
      manifest[skillDir] = {
        hash: currentHash,
        installedAt: new Date().toISOString(),
      }
      writeInstalledManifest(destRoot, manifest)
      result.installed.push(skillDir)
      appLog.info('skills', `安装 ${skillDir} → ${target.name} (hash: ${currentHash.slice(0,8)})`)
    } catch (e: any) {
      result.errors.push({ skill: skillDir, error: e.message })
      appLog.error('skills', `安装 ${skillDir} → ${target.name} 失败`, e.message)
    }
  }

  return result
}

/** 一次自动同步里，单个目标的结果 */
export interface SkillSyncTarget {
  id: string
  name: string
  /** 本机有没有这个 agent */
  present: boolean
  /** 同步前是否需要装/更新 */
  needsInstall: boolean
  installed: string[]
  skipped: string[]
  errors: { skill: string; error: string }[]
  /** 整个目标级别的异常（目录不可写之类） */
  error?: string
  /**
   * 动作之后**重新读盘**的逐技能指纹（2026-11-21）。
   * 这是“不是假绿”的凭据：界面把源/目标两份 md5 都摆出来，用户能自己对。
   */
  checks: SkillCheckRow[]
  /** checks 全部一致才 true（一个技能都没有时 false —— 没得验不能算绿） */
  verified: boolean
}

/** 一次自动同步的完整留痕（落盘，界面可读） */
export interface SkillSyncStatus {
  /** 这次同步是什么时候跑的（ISO） */
  at: string
  /** 跑这次同步的是哪个方寸版本 */
  appVersion: string
  /** 这次同步「看的技能清单」—— 直接证明读的是 manifest，不是写死的两个 */
  skills: string[]
  /** 谁触发的：boot / show / second-instance / manual */
  trigger: string
  ok: boolean
  targets: SkillSyncTarget[]
}

let lastSync: SkillSyncStatus | null = null
let lastSyncLoaded = false

function syncStatusFile(): string {
  // 与 LLM 配置同处 userData：它是"应用状态"，不是项目数据（方寸的数据根会在多个仓库间切）
  return path.join(app.getPath('userData'), 'skills-sync.json')
}

function readSyncStatus(): SkillSyncStatus | null {
  if (lastSyncLoaded) return lastSync
  lastSyncLoaded = true
  try {
    const p = syncStatusFile()
    if (fs.existsSync(p)) lastSync = JSON.parse(fs.readFileSync(p, 'utf-8')) as SkillSyncStatus
  } catch {
    lastSync = null
  }
  return lastSync
}

function writeSyncStatus(s: SkillSyncStatus): void {
  lastSync = s
  lastSyncLoaded = true
  try {
    const p = syncStatusFile()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf-8')
  } catch (e: any) {
    // 落盘失败不该让同步本身失败 —— 内存里那份还在，界面照样能看
    appLog.warn('skills', '同步状态落盘失败（同步本身已完成）', e?.message || String(e))
  }
}

/**
 * 自动检测 + 安装（多目标）
 *
 * ⚠ 只对**在场**的目标动手：DSH 没装就不该凭空造 `~/.dsh/skills`（=往猜出来的目录写东西）。
 *   Hermes 的 present() 恒 true —— 它是方寸自己的宿主，维持原有行为。
 *
 * 2026-11-05 改了三件事（暮雨问"更新后技能到底会不会自动更新"）：
 *   ① **返回并落盘这次的结果**：原来只往应用日志写一行，界面上完全看不见 ——
 *     "没同步"和"同步了但失败了"对用户长得一模一样；
 *   ② 技能清单来自 `skillDirIds()`（读 manifest），不再写死两个；
 *   ③ 可以带 `trigger`，于是"是不是正版刚升级完那一次跑的"能在记录里看出来。
 */
export function autoCheckSkills(trigger = 'boot'): SkillSyncStatus {
  const ids = skillDirIds()
  const targets: SkillSyncTarget[] = []
  for (const t of INSTALL_TARGETS) {
    const row: SkillSyncTarget = {
      id: t.id, name: t.name, present: false, needsInstall: false,
      installed: [], skipped: [], errors: [], checks: [], verified: false,
    }
    try {
      if (!t.present()) {
        appLog.info('skills', `${t.name} 不在场（本机没装），跳过技能自动安装`)
        targets.push(row)
        continue
      }
      row.present = true
      const status = checkSkillsStatus(t.id)
      row.needsInstall = status.needsInstall
      if (status.needsInstall) {
        appLog.info('skills', `${t.name}：检测到需要安装/更新 skills，开始自动安装...`)
        const result = installSkillsTo(t.id)
        row.installed = result.installed
        row.skipped = result.skipped
        row.errors = result.errors
        appLog.info('skills', `${t.name}：自动安装完成——已装 ${result.installed.length}，跳过 ${result.skipped.length}，失败 ${result.errors.length}`)
      } else {
        row.skipped = skillIdsForTarget(t.id)
        appLog.info('skills', `${t.name}：skills 已是最新，无需安装`)
      }
      // ★ 复核：不看刚才那句“装完了”，重新把源与目标两份文件读出来算指纹。
      //   这才是对用户那句“怎么确定不是假绿”的回答。
      const after = verifyTarget(t.id)
      row.checks = after.checks
      row.verified = after.verified
      if (!after.verified) {
        appLog.warn('skills', `${t.name}：同步后复核**仍未一致**（${after.checks.filter((c) => !c.match).map((c) => c.id).join('、') || '没有可复核的技能'}）`)
      }
    } catch (e: any) {
      row.error = e?.message || String(e)
      appLog.warn('skills', `${t.name} 自动检测 skills 失败: ${row.error}`)
    }
    targets.push(row)
  }
  const s: SkillSyncStatus = {
    at: new Date().toISOString(),
    appVersion: app.getVersion(),
    skills: ids,
    trigger,
    // ok = 没有异常 **且** 在场目标的复核都一致（不在场的没得验，不算失败）
    ok: targets.every((x) => !x.error && x.errors.length === 0 && (!x.present || x.verified)),
    targets,
  }
  writeSyncStatus(s)
  return s
}

/**
 * 界面用：上次同步状态 + **这份记录还算不算数**。
 *
 * `stale` 是这条通道存在的真正理由：方寸常驻托盘、关窗≠退出，升级安装包后旧进程
 * 还在跑，新实例被单实例锁顶掉直接退出 —— 于是"升级了但技能还是旧的"，
 * 而界面上原来没有任何地方能看出这件事。判据两条：
 *   · `appVersion` 与当前版本不一致（升级过了，但同步停在旧版本）；
 *   · 或者压根没记录过（从没跑成过）。
 */
export function getSkillSyncStatus(): {
  ok: true
  status: SkillSyncStatus | null
  currentVersion: string
  /** 这份记录还作数吗（false = 该重新同步一次） */
  stale: boolean
  /** 为什么 stale（给人看的一句话；作数时为空串） */
  staleReason: string
  /** 这次会同步哪些技能（读的是 manifest，不是写死） */
  skills: string[]
  /**
   * 现在这一刻的磁盘实况（2026-11-21）。
   *
   * 为什么不能只回“上次同步记录”：那份记录只说明“当时装完没报错”，
   * 说明不了“现在磁盘上还对”。用户点开页面时，副本可能已被别的 agent 改掉/删掉。
   * 所以每次读取都把在场目标重新算一遍 md5，并把不一致的 id 点名。
   */
  live: {
    id: string
    name: string
    dir: string
    present: boolean
    checks: SkillCheckRow[]
    verified: boolean
    mismatched: string[]
  }[]
  /** 磁盘实况是否已经与记录不符（true = 界面不许再显示绿） */
  liveStale: boolean
  /** 为什么 liveStale（给人看的一句话；一致时为空串） */
  liveReason: string
} {
  const s = readSyncStatus()
  const currentVersion = app.getVersion()
  // 判据在 shared/skillSync.ts（纯函数）：e2e-skill-sync 直接喂它两组数据验正反。
  const { stale, reason: staleReason } = judgeSkillSyncStale(s, currentVersion)
  const live = INSTALL_TARGETS.map((t) => {
    const present = (() => { try { return t.present() } catch { return false } })()
    const after = present ? verifyTarget(t.id) : { checks: [] as SkillCheckRow[], verified: false }
    return {
      id: t.id,
      name: t.name,
      dir: (() => { try { return t.dir() } catch { return '' } })(),
      present,
      checks: after.checks,
      verified: after.verified,
      mismatched: after.checks.filter((c) => !c.match).map((c) => c.id),
    }
  })
  const presentLive = live.filter((x) => x.present)
  const liveStale = presentLive.length > 0 && presentLive.some((x) => !x.verified)
  const bad = presentLive.filter((x) => !x.verified)
  const liveReason = liveStale
    ? bad.map((x) => `${x.name}：${x.mismatched.length ? x.mismatched.join('、') + ' 与真源不一致' : '没有可复核的技能'}`).join('；')
    : ''
  return { ok: true, status: s, currentVersion, stale, staleReason, skills: skillDirIds(), live, liveStale, liveReason }
}


// ── 技能安装专区（2026-09-26 卡 038）────────────────────────────────────────
//
// 用户观察：“方寸技能毫无存在感”。真因：主进程早就有 checkSkillsStatus/installSkills
// 和 `skills:check`/`skills:install` 两条通道，**渲染层从来没有入口** —— 功能在，界面不在。
//
// 用户给的边界（原话）：技能本质只是模块化提示词，不是硬性限制 → **不做插件市场**，
// 就是一块“看得见 + 能复制”的安装说明面板。所以这里只读真源、生成可复制的提示词，
// 让 agent 自己去装（它才知道自己的技能目录在哪），顺带提供一键装到 Hermes。
//
// 真源：`skills/manifest.json`（与 skills/ 同源，随包分发到 resources/skills/）。
// 一致性：manifest 里登记的每个文件都必须在磁盘上存在；磁盘上有 SKILL.md 但没登记的
// 目录单独报出来（unlisted）—— “登记了却不存在”和“存在却没登记”都要看得见。

export interface SkillUiItem {
  id: string
  target: string
  version: string
  /** manifest 里的相对路径（原样保留，不翻译） */
  file: string
  /** 解析后的绝对路径 —— 复制提示词必须给绝对路径，杜绝手抄 */
  absPath: string
  exists: boolean
  bytes: number
  /** Hermes 技能目录里有没有同名目录 */
  installed: boolean
  outdated: boolean
  hash: string
  /** SKILL.md 全文（供“复制全文”用；超过 200KB 时截断并标注） */
  body: string
  /**
   * SKILL.md frontmatter 里的 `description`（2026-11-20 加）。
   *
   * 为什么要它：卡片上只有 id（`fangcun-bridge`）时，用户（与 agent）都得先点开才知道这个技能是干什么的，
   * 一页两张卡却读不出「该装哪个」。**只取真源里写的那句**，没有就空串交给界面说“没写”，不替它编。
   */
  desc: string
  /** 可复制给任何 agent 的安装提示词（agent 自己判断装哪儿） */
  prompt: string
}

export interface SkillsUiPayload {
  ok: boolean
  error?: string
  version: string
  lastUpdated: string
  skillsDir: string
  /** ⚠ 历史字段（Hermes 侧目录）。界面已改用 `importDir`；保留只为旧渲染层不炸。 */
  hermesDir: string
  /** 外部导入的落点（DSH 在场优先）与它属于哪个 agent —— 不再写死 Hermes */
  importDir: string
  importTargetName: string
  /** 磁盘上有 SKILL.md、但 manifest 没登记的目录 */
  unlisted: string[]
  skills: SkillUiItem[]
  /**
   * 每个**可直装目标**的逐技能安装状态（卡 010/011）——
   * 界面据此显示“装到：Hermes ✓ · DSH ⬆”，不再是"只认 Hermes"。
   * `present=false` 的目标（DSH 未安装）照样列出来，只是标"不在场、不写"。
   */
  targets: {
    id: string
    name: string
    dir: string
    present: boolean
    skills: { id: string; installed: boolean; outdated: boolean }[]
  }[]
}

function buildInstallPrompt(it: { id: string; target: string; absPath: string }): string {
  return [
    `请把方寸（tegula）的“${it.id}”这个技能装到你自己身上：`,
    `- 技能 ID：${it.id}（manifest 里标注的目标 agent：${it.target}）`,
    `- 技能文件（绝对路径）：${it.absPath}`,
    '',
    '做法：先读这个文件，再按你自己的技能机制把它装好',
    '（例如 DSH 是 ~/.dsh/skills/<技能ID>/SKILL.md，Hermes 是 ~/.hermes/skills/<技能ID>/SKILL.md），',
    '装完告诉我落在哪个路径、要不要重载会话。内容不要改写、不要总结。',
    '',
    '说明：技能本质只是模块化提示词，不是插件。',
  ].join('\n')
}

/**
 * 从 SKILL.md 的 frontmatter 里取 `description`（2026-11-20）。
 *
 * 只认**文件开头**的 `---` 块（正文里出现同名字样不算），取不到就返回空串 ——
 * 界面据此显示“SKILL.md 里没写 description”，而不是拿 id 硬编一句话（编出来的是假描述）。
 */
function skillDescription(body: string): string {
  if (!body) return ''
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return ''
  const line = fm[1].match(/^description:\s*(.+)$/m)
  if (!line) return ''
  return String(line[1] || '').trim().replace(/^['"]|['"]$/g, '')
}

/** 面板数据源：manifest + 磁盘实况 + Hermes 侧安装状态 */
export function listSkillsForUi(): SkillsUiPayload {
  const skillsDir = getResourcesSkillsDir()
  const hermesDir = getHermesSkillsDir()
  const primaryTarget = getPrimaryInstallTarget()
  const primaryDir = primaryTarget.dir()
  const manifestPath = path.join(skillsDir, 'manifest.json')
  const out: SkillsUiPayload = {
    ok: true, version: '', lastUpdated: '', skillsDir, hermesDir,
    importDir: primaryDir, importTargetName: primaryTarget.name,
    unlisted: [], skills: [], targets: [],
  }

  let manifest: any = null
  try {
    if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch (e: any) {
    out.ok = false
    out.error = `manifest.json 读不出来：${e?.message || e}`
  }
  if (!manifest) {
    out.ok = false
    out.error = out.error || `找不到 skills/manifest.json（${manifestPath}）`
  }

  const entries: any[] = Array.isArray(manifest?.skills) ? manifest!.skills : []
  out.version = String(manifest?.version || '')
  out.lastUpdated = String(manifest?.lastUpdated || '')

  const registered = new Set<string>()
  for (const e of entries) {
    const id = String(e?.id || '')
    if (!id) continue
    registered.add(id)
    // manifest 里的 file 形如 skills/<id>/SKILL.md（相对仓库根）；这里只取 <id>/SKILL.md
    const rel = String(e?.file || `${id}/SKILL.md`).replace(/^skills[\\/]/, '')
    const absPath = path.join(skillsDir, rel)
    let exists = false, bytes = 0, hash = '', body = ''
    try {
      if (fs.existsSync(absPath)) {
        exists = true
        bytes = fs.statSync(absPath).size
        hash = md5File(absPath)
        body = fs.readFileSync(absPath, 'utf-8')
        if (body.length > 200_000) body = body.slice(0, 200_000) + '\n\n…（超过 200KB，已截断）'
      }
    } catch { /* 读不到就当不存在，界面会显示 */ }
    const dest = path.join(primaryDir, id, 'SKILL.md')
    const installed = fs.existsSync(dest)
    const saved = readInstalledManifest(hermesDir)[id]
    out.skills.push({
      id,
      target: String(e?.target || 'All'),
      version: String(e?.version || ''),
      file: String(e?.file || ''),
      absPath,
      exists,
      bytes,
      installed,
      outdated: exists && (!installed || fileMd5Safe(dest) !== hash),
      hash,
      body,
      desc: skillDescription(body),
      prompt: buildInstallPrompt({ id, target: String(e?.target || 'All'), absPath }),
    })
  }

  // “存在却没登记”也要看得见
  try {
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      if (registered.has(d.name)) continue
      if (fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md'))) out.unlisted.push(d.name)
    }
  } catch { /* 目录不存在 → 前面已经报 ok:false */ }

  // 每个可直装目标的逐技能安装状态（卡 010/011）—— 界面“装到：Hermes ✓ · DSH ⬆”用它。
  // ⚠ 每个目标的已装判据都必须**看磁盘实际内容**，不能只看各自那本 manifest（同 checkSkillsStatus 的道理）。
  out.targets = INSTALL_TARGETS.map(t => {
    const dir = t.dir()
    // 只列这个目标**该装**的技能：Hermes 专属技能不该在 DSH 那行显示“未装/过时”
    const mine = new Set(skillIdsForTarget(t.id))
    const sk = out.skills.filter(s => mine.has(s.id)).map(s => {
      const dest = path.join(dir, s.id, 'SKILL.md')
      const inst = fs.existsSync(dest)
      return { id: s.id, installed: inst, outdated: s.exists && (!inst || fileMd5Safe(dest) !== s.hash) }
    })
    return { id: t.id, name: t.name, dir, present: t.present(), skills: sk }
  })

  if (!out.skills.length && out.ok === false && !out.error) out.error = 'manifest 里没有登记任何技能'
  return out
}

/**
 * “在资源管理器里亮出 SKILL.md”的**路径裁决**（纯函数，e2e 直接断言）。
 *
 * 白名单 = 两个根，两个根**都由主进程自己算**：`Hermes 侧已装副本` 与 `方寸真源`。
 * 渲染层传任意路径都进不来。
 *
 * 2026-09-28 修（真因在应用日志里，当天 4 条 `路径不在技能目录内`）：
 * 此前只放行 Hermes 侧，于是技能页“📂 显示 SKILL.md”在**方寸自发布技能**那张卡上
 * **必然失败** —— 而那个按钮的用户故事恰恰是“装到 WorkBuddy 这类只能手动导入的 agent”，
 * 要拖进对方导入面板的**就是真源这一份**，不是 Hermes 侧的副本。
 *
 * ⚠ 前缀判定必须带 `path.sep`：`startsWith(root)` 会让 `<root>-evil` 混进来。
 */
export function resolveRevealTarget(dirOrFile: string): {
  ok: boolean
  message: string
  skillMd?: string
  label?: string
} {
  const raw = String(dirOrFile || '').trim()
  if (!raw) return { ok: false, message: '没有可显示的技能路径（技能清单为空？）' }
  const p = path.resolve(raw)
  const primary = getPrimaryInstallTarget()
  const roots = [
    { root: path.resolve(primary.dir()), label: `${primary.name} 侧副本` },
    { root: path.resolve(getHermesSkillsDir()), label: 'Hermes 侧副本' },
    { root: path.resolve(getDshSkillsDir()), label: 'DSH 侧副本' },
    { root: path.resolve(getResourcesSkillsDir()), label: '方寸真源' },
  ]
  const hit = roots.find(r => p === r.root || p.startsWith(r.root + path.sep))
  if (!hit) {
    return { ok: false, message: `路径不在技能目录内（只允许已装副本或方寸真源 skills 目录）：${p}` }
  }
  let isDir = false
  try { isDir = fs.statSync(p).isDirectory() } catch { isDir = false }
  const skillMd = isDir ? path.join(p, 'SKILL.md') : p
  if (!fs.existsSync(skillMd)) return { ok: false, message: `找不到 SKILL.md：${skillMd}` }
  return {
    ok: true,
    message: `已在资源管理器里亮出${hit.label}的 SKILL.md —— 拖进对方的导入面板即可`,
    skillMd,
    label: hit.label,
  }
}

/** 打开技能目录（真源 / Hermes 侧 / DSH 侧）—— 路径由主进程自己算，不接受渲染层传路径 */
export async function openSkillsDir(which: string): Promise<{ ok: boolean; dir?: string; error?: string }> {
  const t = findTarget(which)
  const dir = t ? t.dir() : getResourcesSkillsDir()
  try {
    if (!fs.existsSync(dir)) {
      // Hermes（present 恒 true）→ 先建出来，用户点“打开”不该看到失败；
      // DSH 未安装（present=false）→ 报错不建（不给没装 DSH 的机器凭空造 ~/.dsh/skills）。
      if (t && t.present()) fs.mkdirSync(dir, { recursive: true })
      else return { ok: false, error: `目录不存在：${dir}`, dir }
    }
    const err = await shell.openPath(dir)
    if (err) return { ok: false, error: err, dir }
    return { ok: true, dir }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), dir }
  }
}
