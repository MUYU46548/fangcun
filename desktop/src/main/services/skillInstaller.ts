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
import { app } from 'electron'
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

function getHermesSkillsDir(): string {
  // Windows: C:\Users\muyu\AppData\Local\hermes\skills\
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
  return path.join(localAppData, 'hermes', 'skills')
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
    const saved = manifest[skillDir]
    const outdated = !saved || saved.hash !== currentHash

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

      // 已存在且 hash 一致 → 跳过
      if (fs.existsSync(destSkillMd) && saved && saved.hash === currentHash) {
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
