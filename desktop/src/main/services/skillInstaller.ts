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

const SKILL_DIRS = ['fangcun-bridge', 'skill-management-policy']

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

/** 供 skillImport 复用：Hermes 技能目录（不另造第二个真相源） */
export function getHermesSkillsDirPath(): string {
  return getHermesSkillsDir()
}

/**
 * 方寸**真源** skills 目录（manifest.json 所在处）。
 *
 * 2026-09-28 导出理由：`skills:reveal` 的路径白名单此前只放行 Hermes 侧，
 * 于是技能页「📂 显示 SKILL.md」在"方寸自发布技能"那张卡上**必然失败**
 * （日志实测 4 条 `路径不在技能目录内`）。那个按钮的用户故事恰恰是
 * 「装到 WorkBuddy 这类只能手动导入的 agent」—— 要拖的正是真源这一份。
 */
export function getResourcesSkillsDirPath(): string {
  return getResourcesSkillsDir()
}

/**
 * 方寸「自发布」技能 id 集合 = manifest 登记的 + resources/skills 下带 SKILL.md 的目录。
 * 用途：外部导入**不许覆盖**这些技能（它们是方寸自己的交付物，该走「⚡ 装到 Hermes」）。
 */
export function getPublishedSkillIds(): Set<string> {
  const ids = new Set<string>(SKILL_DIRS)
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

  for (const skillDir of SKILL_DIRS) {
    const srcSkillMd = path.join(resourcesDir, skillDir, 'SKILL.md')
    if (!fs.existsSync(srcSkillMd)) continue

    const currentHash = md5File(srcSkillMd)
    const destSkillMd = path.join(destRoot, skillDir, 'SKILL.md')
    const installed = fs.existsSync(destSkillMd)
    // ⚠ 只看 manifest 里记的 hash 是不够的（2026-09-26 修）：那份记录只说明"上次装成功过"，
    //   说明不了"现在磁盘上这份还对"。装好的副本被改坏/半途写坏时，旧逻辑会永远跳过。
    //   所以「过时」= 没装，或**磁盘上那份**与真源不一致。
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

  for (const skillDir of SKILL_DIRS) {
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

/**
 * 首次启动自动检测（多目标）
 *
 * ⚠ 只对**在场**的目标动手：DSH 没装就不该凭空造 `~/.dsh/skills`（=往猜出来的目录写东西）。
 *   Hermes 的 present() 恒 true —— 它是方寸自己的宿主，维持原有行为。
 */
export function autoCheckSkills(): void {
  for (const t of INSTALL_TARGETS) {
    try {
      if (!t.present()) {
        appLog.info('skills', `${t.name} 不在场（本机没装），跳过技能自动安装`)
        continue
      }
      const status = checkSkillsStatus(t.id)
      if (status.needsInstall) {
        appLog.info('skills', `${t.name}：检测到需要安装/更新 skills，开始自动安装...`)
        const result = installSkillsTo(t.id)
        appLog.info('skills', `${t.name}：自动安装完成——已装 ${result.installed.length}，跳过 ${result.skipped.length}，失败 ${result.errors.length}`)
      } else {
        appLog.info('skills', `${t.name}：skills 已是最新，无需安装`)
      }
    } catch (e: any) {
      appLog.warn('skills', `${t.name} 自动检测 skills 失败: ${e.message}`)
    }
  }
}


// ── 技能安装专区（2026-09-26 卡 038）────────────────────────────────────────
//
// 用户观察：「方寸技能毫无存在感」。真因：主进程早就有 checkSkillsStatus/installSkills
// 和 `skills:check`/`skills:install` 两条通道，**渲染层从来没有入口** —— 功能在，界面不在。
//
// 用户给的边界（原话）：技能本质只是模块化提示词，不是硬性限制 → **不做插件市场**，
// 就是一块「看得见 + 能复制」的安装说明面板。所以这里只读真源、生成可复制的提示词，
// 让 agent 自己去装（它才知道自己的技能目录在哪），顺带提供一键装到 Hermes。
//
// 真源：`skills/manifest.json`（与 skills/ 同源，随包分发到 resources/skills/）。
// 一致性：manifest 里登记的每个文件都必须在磁盘上存在；磁盘上有 SKILL.md 但没登记的
// 目录单独报出来（unlisted）—— 「登记了却不存在」和「存在却没登记」都要看得见。

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
  /** SKILL.md 全文（供「复制全文」用；超过 200KB 时截断并标注） */
  body: string
  /** 可复制给任何 agent 的安装提示词（agent 自己判断装哪儿） */
  prompt: string
}

export interface SkillsUiPayload {
  ok: boolean
  error?: string
  version: string
  lastUpdated: string
  skillsDir: string
  hermesDir: string
  /** 磁盘上有 SKILL.md、但 manifest 没登记的目录 */
  unlisted: string[]
  skills: SkillUiItem[]
  /**
   * 每个**可直装目标**的逐技能安装状态（卡 010/011）——
   * 界面据此显示「装到：Hermes ✓ · DSH ⬆」，不再是"只认 Hermes"。
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
    `请把方寸（tegula）的「${it.id}」这个技能装到你自己身上：`,
    `- 技能 ID：${it.id}（manifest 里标注的目标 agent：${it.target}）`,
    `- 技能文件（绝对路径）：${it.absPath}`,
    '',
    '做法：先读这个文件，再按你自己的技能机制把它装好',
    '（例如 Hermes 是 ~/.hermes/skills/<技能ID>/SKILL.md），',
    '装完告诉我落在哪个路径、要不要重载会话。内容不要改写、不要总结。',
    '',
    '说明：技能本质只是模块化提示词，不是插件。',
  ].join('\n')
}

/** 面板数据源：manifest + 磁盘实况 + Hermes 侧安装状态 */
export function listSkillsForUi(): SkillsUiPayload {
  const skillsDir = getResourcesSkillsDir()
  const hermesDir = getHermesSkillsDir()
  const manifestPath = path.join(skillsDir, 'manifest.json')
  const out: SkillsUiPayload = {
    ok: true, version: '', lastUpdated: '', skillsDir, hermesDir, unlisted: [], skills: [], targets: [],
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
    const dest = path.join(hermesDir, id, 'SKILL.md')
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
      prompt: buildInstallPrompt({ id, target: String(e?.target || 'All'), absPath }),
    })
  }

  // 「存在却没登记」也要看得见
  try {
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      if (registered.has(d.name)) continue
      if (fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md'))) out.unlisted.push(d.name)
    }
  } catch { /* 目录不存在 → 前面已经报 ok:false */ }

  // 每个可直装目标的逐技能安装状态（卡 010/011）—— 界面「装到：Hermes ✓ · DSH ⬆」用它。
  // ⚠ 每个目标的已装判据都必须**看磁盘实际内容**，不能只看各自那本 manifest（同 checkSkillsStatus 的道理）。
  out.targets = INSTALL_TARGETS.map(t => {
    const dir = t.dir()
    const sk = out.skills.map(s => {
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
 * 「在资源管理器里亮出 SKILL.md」的**路径裁决**（纯函数，e2e 直接断言）。
 *
 * 白名单 = 两个根，两个根**都由主进程自己算**：`Hermes 侧已装副本` 与 `方寸真源`。
 * 渲染层传任意路径都进不来。
 *
 * 2026-09-28 修（真因在应用日志里，当天 4 条 `路径不在技能目录内`）：
 * 此前只放行 Hermes 侧，于是技能页「📂 显示 SKILL.md」在**方寸自发布技能**那张卡上
 * **必然失败** —— 而那个按钮的用户故事恰恰是「装到 WorkBuddy 这类只能手动导入的 agent」，
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
  const roots = [
    { root: path.resolve(getHermesSkillsDir()), label: 'Hermes 侧副本' },
    { root: path.resolve(getDshSkillsDir()), label: 'DSH 侧副本' },
    { root: path.resolve(getResourcesSkillsDir()), label: '方寸真源' },
  ]
  const hit = roots.find(r => p === r.root || p.startsWith(r.root + path.sep))
  if (!hit) {
    return { ok: false, message: `路径不在技能目录内（只允许 Hermes 技能目录或方寸真源 skills 目录）：${p}` }
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
      // Hermes（present 恒 true）→ 先建出来，用户点「打开」不该看到失败；
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
