/**
 * Fangcun Desktop — Skill Installer Service
 *
 * 负责：
 * 1. 首次启动自动检测并安装 skills
 * 2. 提供 getSkillsStatus IPC 通道（供渲染层查询）
 * 3. 提供 installSkills IPC 通道（供设置页手动触发）
 *
 * 数据来源：应用 resources/skills/（随安装包分发的真源）
 * 安装目标：~/.hermes/skills/（Hermes 侧，可焚毁区）
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app, shell } from 'electron'
import * as appLog from './appLog'

const SKILL_DIRS = ['fangcun-hermes-bridge', 'skill-management-policy']

interface SkillInstallResult {
  installed: string[]
  skipped: string[]
  errors: { skill: string; error: string }[]
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

function getInstalledManifestPath(): string {
  return path.join(getHermesSkillsDir(), '.fangcun-installed.json')
}

function readInstalledManifest(): Record<string, { hash: string; installedAt: string }> {
  const p = getInstalledManifestPath()
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function writeInstalledManifest(manifest: Record<string, { hash: string; installedAt: string }>): void {
  const p = getInstalledManifestPath()
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
 * 检查 skills 是否需要安装
 */
export function checkSkillsStatus(): {
  needsInstall: boolean
  skills: { name: string; installed: boolean; outdated: boolean; hash: string }[]
} {
  const resourcesDir = getResourcesSkillsDir()
  const hermesDir = getHermesSkillsDir()
  const manifest = readInstalledManifest()
  const skills: { name: string; installed: boolean; outdated: boolean; hash: string }[] = []

  for (const skillDir of SKILL_DIRS) {
    const srcSkillMd = path.join(resourcesDir, skillDir, 'SKILL.md')
    if (!fs.existsSync(srcSkillMd)) continue

    const currentHash = md5File(srcSkillMd)
    const destSkillMd = path.join(hermesDir, skillDir, 'SKILL.md')
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
    needsInstall: skills.some(s => !s.installed || s.outdated),
    skills,
  }
}

/**
 * 安装 skills 到 Hermes 侧
 * 幂等：已安装且 hash 一致则跳过
 */
export function installSkills(): SkillInstallResult {
  const result: SkillInstallResult = { installed: [], skipped: [], errors: [] }
  const resourcesDir = getResourcesSkillsDir()
  const hermesDir = getHermesSkillsDir()

  appLog.info('skills', `开始安装 skills，源: ${resourcesDir}`)

  for (const skillDir of SKILL_DIRS) {
    try {
      const srcSkillMd = path.join(resourcesDir, skillDir, 'SKILL.md')
      if (!fs.existsSync(srcSkillMd)) {
        result.skipped.push(skillDir)
        continue
      }

      const currentHash = md5File(srcSkillMd)
      const destSkillMd = path.join(hermesDir, skillDir, 'SKILL.md')
      const manifest = readInstalledManifest()
      const saved = manifest[skillDir]

      // 已存在、且 manifest 记录与**目标端实际内容**都与真源一致 → 跳过
      if (fs.existsSync(destSkillMd) && saved && saved.hash === currentHash &&
          fileMd5Safe(destSkillMd) === currentHash) {
        result.skipped.push(skillDir)
        continue
      }

      // 复制整个目录
      const srcDir = path.join(resourcesDir, skillDir)
      const destDir = path.join(hermesDir, skillDir)
      copySkillDir(srcDir, destDir)
      manifest[skillDir] = {
        hash: currentHash,
        installedAt: new Date().toISOString(),
      }
      writeInstalledManifest(manifest)
      result.installed.push(skillDir)
      appLog.info('skills', `安装 ${skillDir} (hash: ${currentHash.slice(0,8)})`)
    } catch (e: any) {
      result.errors.push({ skill: skillDir, error: e.message })
      appLog.error('skills', `安装 ${skillDir} 失败`, e.message)
    }
  }

  return result
}

/**
 * 首次启动自动检测
 */
export function autoCheckSkills(): void {
  try {
    const status = checkSkillsStatus()
    if (status.needsInstall) {
      appLog.info('skills', '检测到需要安装/更新 skills，开始自动安装...')
      const result = installSkills()
      appLog.info('skills', `自动安装完成：已装 ${result.installed.length}，跳过 ${result.skipped.length}，失败 ${result.errors.length}`)
    } else {
      appLog.info('skills', 'skills 已是最新，无需安装')
    }
  } catch (e: any) {
    appLog.warn('skills', `自动检测 skills 失败: ${e.message}`)
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
    ok: true, version: '', lastUpdated: '', skillsDir, hermesDir, unlisted: [], skills: [],
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
    const saved = readInstalledManifest()[id]
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

  if (!out.skills.length && out.ok === false && !out.error) out.error = 'manifest 里没有登记任何技能'
  return out
}

/** 打开技能目录（真源 / Hermes 侧）—— 路径由主进程自己算，不接受渲染层传路径 */
export async function openSkillsDir(which: string): Promise<{ ok: boolean; dir?: string; error?: string }> {
  const dir = which === 'hermes' ? getHermesSkillsDir() : getResourcesSkillsDir()
  try {
    if (!fs.existsSync(dir)) {
      // Hermes 侧可能还没装过任何技能 → 先建出来，用户点「打开」不该看到失败
      if (which === 'hermes') fs.mkdirSync(dir, { recursive: true })
      else return { ok: false, error: `目录不存在：${dir}`, dir }
    }
    const err = await shell.openPath(dir)
    if (err) return { ok: false, error: err, dir }
    return { ok: true, dir }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), dir }
  }
}
