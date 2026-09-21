/**
 * Fangcun Desktop — 方针区（项目方针卡）
 *
 * 每个活跃项目一张方针卡：使命 / 当前目标 / 应用场景 / 方针边界。
 * 存储形态：DATA_DIR/policies/<项目id>.md（长文本用 MD，不进 registry）。
 * 读取通道：设置页「项目方针」入口 + 「复制本卡」按钮（粘给 agent）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '../data'

export interface Policy {
  projectId: string
  mission: string
  goal: string
  scenario: string
  boundary: string
  updatedAt: string
}

function getPolicyDir(): string {
  const dir = path.join(getDataDir(), 'policies')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function policyPath(projectId: string): string {
  // 项目 id 只允许字母数字连字符，防路径穿越
  if (!/^[\w-]+$/.test(projectId)) throw new Error(`非法项目 id: ${projectId}`)
  return path.join(getPolicyDir(), `${projectId}.md`)
}

export function getPolicy(projectId: string): Policy | null {
  const p = policyPath(projectId)
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const grab = (key: string): string => {
      const m = raw.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
      return m ? m[1].trim() : ''
    }
    const section = (key: string): string => {
      const m = raw.match(new RegExp(`## ${key}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'm'))
      return m ? m[1].trim() : ''
    }
    return {
      projectId,
      mission: section('使命'),
      goal: section('当前目标'),
      scenario: section('应用场景'),
      boundary: section('方针边界'),
      updatedAt: grab('更新') || '',
    }
  } catch {
    return null
  }
}

export function savePolicy(p: Policy): { ok: boolean; path: string } {
  const content = [
    `# 项目方针：${p.projectId}`,
    ``,
    `> 更新: ${new Date().toISOString()}`,
    `> 用途: 派活时随任务书下发，或直接粘给 agent 作为项目背景。`,
    ``,
    `## 使命`,
    p.mission || '（未填写）',
    ``,
    `## 当前目标`,
    p.goal || '（未填写）',
    ``,
    `## 应用场景`,
    p.scenario || '（未填写）',
    ``,
    `## 方针边界`,
    p.boundary || '（未填写）',
    ``,
  ].join('\n')
  const target = policyPath(p.projectId)
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, target)
  return { ok: true, path: target }
}

/** 生成可粘贴给 agent 的方针文本 */
export function policyToText(p: Policy): string {
  return [
    `## 项目方针（${p.projectId}）`,
    `### 使命`,
    p.mission,
    `### 当前目标`,
    p.goal,
    `### 应用场景`,
    p.scenario,
    `### 方针边界`,
    p.boundary,
  ].filter(x => x !== undefined).join('\n')
}
