/**
 * Fangcun Desktop — 技能「直接导入」（2026-09-26 卡 005）
 *
 * 用户给的参照是 WorkBuddy 的导入面板，原话：
 *   「拖拽文件或点击上传 / 文件要求：文件夹或者 .zip 需要包含 SKILL.md 文件；
 *     .md 文件需包含 YAML 格式的技能名称和描述」
 *
 * 三条边界（定这条实现的原因）：
 *  1. 只认 Hermes 技能目录 `~/.hermes/skills/<name>/` —— 与自发布技能同一处，导入完就能用，
 *     不另造一个"方寸自己的技能库"（那会变成第二个真相源）。
 *  2. **绝不写进 `skills/manifest.json`**。那是方寸自发布技能的账本，混进外部技能会让
 *     「有更新 / 已装最新」的判断全乱。外部导入靠目录里的标记文件 `.fangcun-imported.json`
 *     记账，这个标记同时也是「移除」的安全闸门（没有标记的目录一律不删）。
 *  3. **校验先做，失败零写入**：zip 解压复用备份模块的手写解压器（自带 CRC 校验 + 防目录穿越），
 *     解压进临时目录 → 校验通过才往技能目录里搬，且用 rename 落位（同盘原子）。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { dialog } from 'electron'
import * as appLog from './appLog'
import { extractZipTo } from '../backup/packer'
import { getHermesSkillsDirPath, getPublishedSkillIds } from './skillInstaller'

/** 外部导入标记（文件名以点开头，不会被当成技能内容读） */
export const IMPORT_MARKER = '.fangcun-imported.json'

/** 体积与条目上限：防 zip 炸弹把磁盘写满（技能包本来就只有几十 KB） */
const MAX_BYTES = 20 * 1024 * 1024
const MAX_FILES = 500

export interface ImportedSkillItem {
  name: string
  description: string
  version: string
  dir: string
  files: number
  bytes: number
  importedAt: string
  source: string
}

export interface ImportResult {
  ok: boolean
  /** ok=false 时的机器可读原因 —— 渲染层据此决定弹什么框（重名要问覆盖，其它直接报错） */
  code?: 'exists' | 'reserved' | 'invalid' | 'too-large' | 'too-many' | 'not-found' | 'error'
  name?: string
  description?: string
  target?: string
  files?: number
  bytes?: number
  error?: string
}

/** 技能名（= Hermes 技能目录名）：只允许小写字母/数字/连字符/下划线，且不以连字符开头 */
function normalizeSkillName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
}

/** 解析 SKILL.md 的 YAML 头部 —— 用户的判据就是「.md 需包含 YAML 格式的技能名称和描述」 */
function parseSkillMeta(text: string): { name: string; description: string; version: string } | null {
  const m = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return null
  let data: unknown
  try {
    data = yaml.load(m[1])
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const name = normalizeSkillName(d.name)
  const description = String(d.description ?? d.desc ?? '').trim()
  if (!name || !description) return null
  return { name, description: description.slice(0, 300), version: String(d.version ?? '') }
}

/**
 * 定位技能根：根目录有 SKILL.md 就用根；否则找**一层**子目录（zip 常带一层外壳目录）。
 * 多个候选一律拒绝 —— 猜错了就是装错东西。
 */
function locateSkillRoot(dir: string): { root: string } | { error: string } {
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return { root: dir }
  let subs: string[] = []
  try {
    subs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.isSymbolicLink() && e.name !== '__MACOSX' && !e.name.startsWith('.'))
      .map(e => e.name)
  } catch (e) {
    return { error: `读不到目录：${(e as Error).message}` }
  }
  const hits = subs.filter(n => fs.existsSync(path.join(dir, n, 'SKILL.md')))
  if (hits.length === 1) return { root: path.join(dir, hits[0]) }
  if (hits.length > 1) return { error: `包里有 ${hits.length} 个 SKILL.md（${hits.join('、')}），不知道该装哪个` }
  return { error: '包里没有 SKILL.md' }
}

/** 统计文件数与字节数；符号链接不跟（防止指到目录外） */
function countTree(dir: string, acc = { files: 0, bytes: 0 }): { files: number; bytes: number } {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) countTree(p, acc)
    else if (e.isFile()) {
      acc.files++
      try {
        acc.bytes += fs.statSync(p).size
      } catch {
        /* 读不到大小就不计 */
      }
    }
  }
  return acc
}

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    /* 清理失败不能影响主流程 */
  }
}

export function readImportMarker(skillDir: string): { importedAt: string; source: string } | null {
  const p = path.join(skillDir, IMPORT_MARKER)
  try {
    if (!fs.existsSync(p)) return null
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return { importedAt: String(j?.importedAt ?? ''), source: String(j?.source ?? '') }
  } catch {
    return null
  }
}

/** 已导入（外部）技能列表 —— 只认带标记的目录，自发布技能不会混进来 */
export function listImportedSkills(): ImportedSkillItem[] {
  const hermesDir = getHermesSkillsDirPath()
  const out: ImportedSkillItem[] = []
  let dirs: fs.Dirent[] = []
  try {
    dirs = fs.readdirSync(hermesDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(hermesDir, d.name)
    const marker = readImportMarker(dir)
    if (!marker) continue
    let description = ''
    let version = ''
    try {
      const meta = parseSkillMeta(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'))
      description = meta?.description ?? ''
      version = meta?.version ?? ''
    } catch {
      /* SKILL.md 读不到也照样列出来（用户得能看见并移除它） */
    }
    const c = countTree(dir)
    out.push({
      name: d.name,
      description,
      version,
      dir,
      files: c.files,
      bytes: c.bytes,
      importedAt: marker.importedAt,
      source: marker.source,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 导入一个技能包。srcPath 可以是：目录 / .zip / 单个 .md。
 * overwrite=true 时才允许覆盖已存在的同名技能目录。
 */
export function importSkillFromPath(srcPath: string, opts: { overwrite?: boolean } = {}): ImportResult {
  const raw = String(srcPath || '').trim().replace(/^["']|["']$/g, '')
  if (!raw) return { ok: false, code: 'not-found', error: '路径为空' }

  let st: fs.Stats
  try {
    st = fs.statSync(raw)
  } catch {
    return { ok: false, code: 'not-found', error: `找不到：${raw}` }
  }

  const hermesDir = getHermesSkillsDirPath()
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'fangcun-skill-import-'))

  try {
    let skillSrc = ''

    if (st.isDirectory()) {
      skillSrc = raw
    } else if (/\.zip$/i.test(raw)) {
      if (st.size > MAX_BYTES) {
        return { ok: false, code: 'too-large', error: `zip 有 ${(st.size / 1048576).toFixed(1)} MB，超过 ${MAX_BYTES / 1048576} MB 上限` }
      }
      const buf = fs.readFileSync(raw)
      try {
        // 备份模块的手写解压器：自带 CRC 校验 + 拒绝绝对路径/`..`（zip slip）；
        // skipNames 传空数组是因为它默认跳过 manifest.json（那是备份包的约定，技能包不该跳）
        extractZipTo(buf, staging, { skipNames: [] })
      } catch (e) {
        return { ok: false, code: 'invalid', error: `zip 解压失败：${(e as Error).message}` }
      }
      skillSrc = staging
    } else if (/\.md$/i.test(raw)) {
      fs.copyFileSync(raw, path.join(staging, 'SKILL.md'))
      skillSrc = staging
    } else {
      return { ok: false, code: 'invalid', error: '只认文件夹、.zip 或 .md 三种输入' }
    }

    const located = locateSkillRoot(skillSrc)
    if ('error' in located) return { ok: false, code: 'invalid', error: located.error }

    const skillMdPath = path.join(located.root, 'SKILL.md')
    let meta: ReturnType<typeof parseSkillMeta>
    try {
      meta = parseSkillMeta(fs.readFileSync(skillMdPath, 'utf-8'))
    } catch (e) {
      return { ok: false, code: 'invalid', error: `读不到 SKILL.md：${(e as Error).message}` }
    }
    if (!meta) {
      return {
        ok: false,
        code: 'invalid',
        error: 'SKILL.md 的 YAML 头部必须同时有 name 和 description（这是识别技能的最低要求）',
      }
    }

    const counts = countTree(located.root)
    if (counts.files > MAX_FILES) {
      return { ok: false, code: 'too-many', error: `文件数 ${counts.files} 超过上限 ${MAX_FILES}` }
    }
    if (counts.bytes > MAX_BYTES) {
      return { ok: false, code: 'too-large', error: `解压后 ${(counts.bytes / 1048576).toFixed(1)} MB，超过 ${MAX_BYTES / 1048576} MB 上限` }
    }

    // 自发布技能不许被外部导入覆盖：那是方寸自己的交付物，得走「⚡ 装到 Hermes」
    if (getPublishedSkillIds().has(meta.name)) {
      return { ok: false, code: 'reserved', name: meta.name, error: `「${meta.name}」是方寸自发布技能，请用「⚡ 装到 Hermes」更新它` }
    }

    const target = path.join(hermesDir, meta.name)
    const exists = fs.existsSync(target)
    if (exists && !opts.overwrite) {
      return {
        ok: false,
        code: 'exists',
        name: meta.name,
        description: meta.description,
        target,
        files: counts.files,
        bytes: counts.bytes,
        error: `「${meta.name}」已经存在`,
      }
    }

    fs.mkdirSync(hermesDir, { recursive: true })

    // 先搬进同盘的临时目录（.fangcun-incoming-*），成功后用 rename 落位 —— 半途失败不会留下半个技能
    const incoming = path.join(hermesDir, `.fangcun-incoming-${meta.name}-${Date.now().toString(36)}`)
    copyTree(located.root, incoming)
    fs.writeFileSync(
      path.join(incoming, IMPORT_MARKER),
      JSON.stringify({ importedAt: new Date().toISOString(), source: raw, name: meta.name, files: counts.files, bytes: counts.bytes }, null, 2),
      'utf-8'
    )

    let backupOld = ''
    try {
      if (exists) {
        backupOld = path.join(hermesDir, `.fangcun-old-${meta.name}-${Date.now().toString(36)}`)
        fs.renameSync(target, backupOld)
      }
      fs.renameSync(incoming, target)
    } catch (e) {
      // 落位失败：把旧目录还原回去，别让用户丢东西
      if (backupOld && !fs.existsSync(target)) {
        try {
          fs.renameSync(backupOld, target)
        } catch {
          /* 还原也失败：下面会把错误报出去 */
        }
      }
      rmrf(incoming)
      return { ok: false, code: 'error', error: `落位失败：${(e as Error).message}` }
    }
    if (backupOld) rmrf(backupOld)

    appLog.info('skills', `导入技能 ${meta.name}（${counts.files} 个文件，源：${raw}）`)
    return { ok: true, name: meta.name, description: meta.description, target, files: counts.files, bytes: counts.bytes }
  } catch (e) {
    return { ok: false, code: 'error', error: (e as Error)?.message || String(e) }
  } finally {
    rmrf(staging)
  }
}

/** 移除外部导入的技能：只认带标记的目录，自发布技能一律拒绝 */
export function removeImportedSkill(name: string): { ok: boolean; error?: string; dir?: string } {
  const clean = normalizeSkillName(name)
  if (!clean || clean !== String(name || '').trim().toLowerCase()) {
    return { ok: false, error: '技能名不合法' }
  }
  if (getPublishedSkillIds().has(clean)) {
    return { ok: false, error: `「${clean}」是方寸自发布技能，不能用移除（请到技能目录手动处理）` }
  }
  const dir = path.join(getHermesSkillsDirPath(), clean)
  if (!fs.existsSync(dir)) return { ok: false, error: `找不到 ${dir}` }
  if (!readImportMarker(dir)) {
    return { ok: false, error: `「${clean}」不是方寸导入的技能（没有导入标记），拒绝删除` }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    appLog.info('skills', `移除外部导入技能 ${clean}`)
    return { ok: true, dir }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) }
  }
}

/**
 * 选一个技能包（zip / .md）。
 * ⚠ Windows 上 `openFile` + `openDirectory` **不能同时**用（会只出目录选择器），
 * 所以入口做成两个：选文件、选文件夹。拖拽两者都支持。
 */
export async function pickSkillFile(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
  try {
    const r = await dialog.showOpenDialog({
      title: '选择技能包（.zip 或 .md）',
      properties: ['openFile'],
      filters: [
        { name: '技能包', extensions: ['zip', 'md'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true }
    return { ok: true, path: r.filePaths[0] }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) }
  }
}

/** 选一个技能文件夹（里面要有 SKILL.md） */
export async function pickSkillFolder(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
  try {
    const r = await dialog.showOpenDialog({
      title: '选择技能文件夹（里面要有 SKILL.md）',
      properties: ['openDirectory'],
    })
    if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true }
    return { ok: true, path: r.filePaths[0] }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) }
  }
}
