/**
 * 层厚度扫描器 · 主进程（2026-11-16）
 *
 * 由来：暮雨 2026-11-15 深夜 ——「骨架补齐以后，规划会自己长出来」。
 * 他 2026-11-16 又定了一条：**横比表和单项目报告都要**，
 * 「因为用户根本没空去数目录半小时」。
 *
 * 所以这一支的定位是：**替人数目录**。它不猜架构、不给建议，
 * 只把「层 → 文件数 → 行数 → 占比」算准，然后回答一句话：
 *
 *     号称是 A，但 88% 的行数在 B。
 *
 * ── 硬边界 ────────────────────────────────────────────────────────────
 * ① **只读**：只用 readdirSync / statSync / openSync+read（本文件里出现
 *    write/mkdir/rename/unlink 就是红，`e2e-layer-scan` 有源码守卫）。
 * ② **缺就说缺**：仓库不在 / 没登记 repo → `missing` + 数字为 undefined。
 *    **绝不给 0** —— 0 会被读成"这项目真的没代码"。
 * ③ **分母必须点名**：每条排除规则、每个非文本文件都要列出来。
 *    2026-11-16 首跑踩了五个坑，每个都让数变成假数而报告看起来完全正常：
 *      ① 浏览器 profile（隔壁同类产品 `.test-edge-profile-3d` = **287 万行**）撑爆分母
 *      ② 拿全仓当分母 → 剩下 90% 是测试，不是"这层薄"
 *      ③ 打包产物 / 内嵌 Python 运行时被当产品（方寸 36 万行、另一款产品 31.9 万行）
 *      ④ `.ts` 既是 TypeScript 也是 **MPEG 视频分片**
 *      ⑤ 只认 UTF-8 会把 **GBK 脚本**当二进制丢掉（某项目 31 行 → 0 行）
 * ④ **不许猜口径**：`分层` 由项目自己在 `task-data/layer-specs/<id>.json` 里声明，
 *    没有就只给目录占比 —— 我替项目猜"你是几层"等于又造一份"我说它是什么"。
 */
import fs from 'fs'
import path from 'path'
import { getDataDir } from '../data'
import {
  applyGroups, applySpec, claimRows, groupLayers, verdictOf,
  type LayerNamed, type LayerProfile, type LayerRow, type LayerSpec,
  type BadFile, type SkippedDir,
} from '../../shared/layerProfile'

/**
 * 一律不进的目录。**每条都写理由** —— 删掉任何一条都会让某个项目的第一名变成 node_modules。
 * 2026-11-16 全项目首跑后补的四类，每一类都曾在真项目上把"产品代码"算成一个假数。
 */
export const SKIP_DIRS: Record<string, string> = {
  node_modules: '依赖',
  '.git': '版本库',
  dist: '构建产物',
  build: '构建产物',
  out: '构建产物',
  release: '打包产物',
  'win-unpacked': '打包产物（electron-builder 未压缩目录）',
  'desktop-build': '打包产物',
  pkg: '发版取件目录',
  coverage: '覆盖率产物',
  __pycache__: '字节码缓存',
  '.venv': '虚拟环境',
  venv: '虚拟环境',
  env: '虚拟环境',
  'site-packages': '第三方库（vendored）',
  runtime: '内嵌运行时（python / node 发行版整份拷进来）',
  Temp: '临时目录',
  temp: '临时目录',
  tmp: '临时目录',
  backups: '备份',
  _attachments: '执行日志附件（用户数据，不是代码）',
  '.pkg-tmp': '打包暂存',
  '.trash': '回收站',
}

const SKIP_PREFIX = ['release-', 'release_', 'dist-']

/** 目录里出现这些文件 = 这是一份内嵌解释器，不是项目自己的代码。 */
const VENDOR_MARKERS = ['pyvenv.cfg', 'python.exe', 'python3.dll', 'node.exe', 'electron.exe']

export const CODE_EXTS = new Set([
  '.py', '.pyw', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte',
  '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.c', '.h', '.cpp', '.hpp',
  '.sh', '.ps1', '.bat', '.html', '.css', '.scss', '.sql',
])

/** 单个文件超过这个大小就不数（防几 MB 的生成物拖死扫描） */
const MAX_FILE_BYTES = 8 * 1024 * 1024

export interface ScanResult {
  recs: [string, number][]
  unreadable: BadFile[]
  nonText: BadFile[]
  skipped: SkippedDir[]
}

/**
 * 判"这是不是文本"，然后数行。
 *
 * ⚠ **不用扩展名判**：`.ts` 既是 TypeScript 也是 MPEG 视频分片
 * （视频制作里 `frames/seg_04.ts` 一片 7,634 行，不挡就是全仓最厚"产品代码"）。
 * ⚠ **也不只认 UTF-8**：某项目 的 `96 事务管理/索引预览.bat` 是 **GBK** 的合法脚本
 * （头一行 `chcp 936`），只认 UTF-8 会把它丢掉 —— 那是拿"看不见"当成"没有"。
 *
 * 所以判据只有两条**与编码无关**的：NUL 字节、以及控制字符比例。
 * 已知代价：UTF-16 文本会被当二进制（实际项目里没有这种源码，属于可接受）。
 */
export function countTextLines(abs: string): number {
  const st = fs.statSync(abs)
  if (st.size > MAX_FILE_BYTES) {
    const e: any = new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(1)} MB），不数`)
    e.code = 'TOO_BIG'
    throw e
  }
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(st.size)
    const read = fs.readSync(fd, buf, 0, st.size, 0)
    return countLinesInBuffer(buf.subarray(0, read))
  } finally {
    fs.closeSync(fd)
  }
}

/** 纯函数版（可被断言直接调）。二进制抛 `ValueError` 语义的 Error。 */
export function countLinesInBuffer(raw: Buffer): number {
  if (!raw.length) return 0
  const head = raw.subarray(0, Math.min(raw.length, 8192))
  if (head.includes(0)) {
    const e: any = new Error('二进制（含 NUL 字节）')
    e.code = 'NON_TEXT'
    throw e
  }
  let ctrl = 0
  for (const b of head) {
    if (b < 0x09 || (b >= 0x0e && b <= 0x1f)) ctrl += 1
  }
  if (head.length && ctrl / head.length > 0.05) {
    const e: any = new Error('二进制（控制字符比例过高）')
    e.code = 'NON_TEXT'
    throw e
  }
  let n = 0
  for (const b of raw) if (b === 0x0a) n += 1
  // 末尾没有换行时最后一行也算一行（与 splitlines 口径一致）
  return raw[raw.length - 1] === 0x0a ? n : n + 1
}

function isSkipName(name: string): boolean {
  return name in SKIP_DIRS || SKIP_PREFIX.some((p) => name.startsWith(p)) || name.startsWith('.')
}

function whySkip(name: string): string {
  if (name in SKIP_DIRS) return SKIP_DIRS[name]
  if (SKIP_PREFIX.some((p) => name.startsWith(p))) return '打包/构建产物（前缀规则）'
  return '隐藏目录（VCS / 浏览器 profile / 缓存）'
}

function hasVendorMarker(dir: string): boolean {
  return VENDOR_MARKERS.some((m) => {
    try { return fs.existsSync(path.join(dir, m)) } catch { return false }
  })
}

/**
 * 扫一个仓库。`extraExcludes` 来自项目 spec（例：quartz 的 `public/` 是生成的站点，
 * 但别的项目里 `public/` 就是源码 —— 只能按项目声明，不能进全局黑名单）。
 */
export function scanRepo(repo: string, extraExcludes: string[] = []): ScanResult {
  const recs: [string, number][] = []
  const unreadable: BadFile[] = []
  const nonText: BadFile[] = []
  const skipped: SkippedDir[] = []
  const extra = extraExcludes.map((p) => String(p || '').replace(/\/+$/, '')).filter(Boolean)

  const walk = (dir: string, relBase: string): void => {
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch {
      unreadable.push({ file: relBase || '.', why: '目录读不动（权限或被占用）' })
      return
    }
    for (const e of ents) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (isSkipName(e.name)) {
          // 顶层已经在外面记过了，这里只补嵌套的 —— 嵌套才是大头
          // （另一款产品 26.7 万行在 console/runtime/python，顶层看不出任何异常）
          if (relBase && skipped.length < 80) {
            skipped.push({ dir: rel, why: whySkip(e.name), nested: true })
          }
          continue
        }
        if (hasVendorMarker(abs)) {
          if (skipped.length < 80) {
            skipped.push({
              dir: rel,
              why: '目录里带解释器可执行文件 = 内嵌运行时，不是项目代码',
              nested: !!relBase,
            })
          }
          continue
        }
        walk(abs, rel)
        continue
      }
      if (!e.isFile()) continue
      if (!CODE_EXTS.has(path.extname(e.name).toLowerCase())) continue
      if (extra.some((x) => rel === x || rel.startsWith(x + '/'))) continue
      try {
        recs.push([rel, countTextLines(abs)])
      } catch (err: any) {
        const rec = { file: rel, why: String(err?.message || err) }
        if (err?.code === 'NON_TEXT') nonText.push(rec)
        else unreadable.push(rec)
      }
    }
  }

  // 顶层先记一遍"被挡在门外"的目录（用户要能看见分母被谁改过）
  let tops: fs.Dirent[] = []
  try { tops = fs.readdirSync(repo, { withFileTypes: true }) } catch {
    return { recs, unreadable: [{ file: '.', why: '仓库目录读不动' }], nonText, skipped }
  }
  for (const e of tops) {
    if (!e.isDirectory()) continue
    const abs = path.join(repo, e.name)
    if (isSkipName(e.name)) {
      if (skipped.length < 80) skipped.push({ dir: e.name, why: whySkip(e.name) })
    } else if (hasVendorMarker(abs)) {
      if (skipped.length < 80) {
        skipped.push({ dir: e.name, why: '目录里带解释器可执行文件 = 内嵌运行时，不是项目代码' })
      }
    } else if (extra.includes(e.name)) {
      skipped.push({ dir: e.name, why: '项目 spec 里声明排除（通用规则猜不到：在该项目里它是生成物）' })
    }
  }
  walk(repo, '')

  return { recs, unreadable, nonText, skipped }
}

/** 某项目的「声称的分层」文件。放 task-data：随备份包走，换台机器不用重填。 */
export function specPathFor(projectId: string): string {
  return path.join(getDataDir(), 'task-data', 'layer-specs', `${projectId}.json`)
}

/** 读 spec。坏 JSON 返回 error 而不抛 —— 界面要能显示"这份 spec 坏了"。 */
export function readSpec(projectId: string): { spec: LayerSpec | null; error: string } {
  const p = specPathFor(projectId)
  if (!fs.existsSync(p)) return { spec: null, error: '' }
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const spec = JSON.parse(raw) as LayerSpec
    if (!spec || typeof spec !== 'object' || !spec.layers) {
      return { spec: null, error: 'spec 存在但没有 layers 段（要求是 { "layers": { 层名: { paths: [...] } } }）' }
    }
    return { spec, error: '' }
  } catch (e: any) {
    return { spec: null, error: `spec 不是合法 JSON：${String(e?.message || e)}` }
  }
}

export interface ProjectLike {
  id: string
  name?: string
  repo?: string
}

/** 当天缓存：扫 15 个仓库不便宜，同一天内不重复付这笔钱（`force` 绕过）。 */
const dayCache = new Map<string, { day: string; data: LayerProfile }>()
export function _clearLayerCache(): void { dayCache.clear() }

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 扫一个项目，产出完整报告。**永远不抛** —— 读不到用 `missing` 表达。
 *
 * @param project registry 里的项目（本模块不读 registry，单一职责）
 */
export async function profileProject(
  project: ProjectLike, opts: { depth?: number; force?: boolean } = {},
): Promise<LayerProfile> {
  const depth = Math.max(1, Math.min(6, Number(opts.depth) || 3))
  const id = String(project?.id || '')
  const name = String(project?.name || id)
  const repo = String(project?.repo || '').replace(/\\/g, '/')

  const blank = (missing: string, note = ''): LayerProfile => ({
    ok: false, id, name, repo,
    totalLines: undefined as unknown as number,
    totalFiles: undefined as unknown as number,
    rows: [], named: [], groups: [], verdict: '', unreadable: [], nonText: [], skipped: [],
    specSource: '', claims: {}, claimsNote: '', claimRows: [],
    missing, note,
  })

  if (!id) return blank('没指定项目')
  if (!repo) return blank('registry 里没登记 repo —— 扫不到任何文件（不是厚度为 0）')
  let isDir = false
  try { isDir = fs.statSync(repo).isDirectory() } catch { /* 不存在 */ }
  if (!isDir) return blank(`仓库路径不存在：${repo} —— 扫不到任何文件（不是厚度为 0）`)

  const day = today()
  const hit = dayCache.get(repo)
  if (!opts.force && hit && hit.day === day) return hit.data

  const { spec, error: specError } = readSpec(id)
  const scanned = scanRepo(repo, (spec?.exclude || []).slice())
  const rows: LayerRow[] = groupLayers(scanned.recs, depth)
  const totalLines = rows.reduce((s, r) => s + r.lines, 0)
  const totalFiles = rows.reduce((s, r) => s + r.files, 0)
  const named: LayerNamed[] = applySpec(scanned.recs, spec)
  const groups = applyGroups(named, spec)
  const claims = (spec?.claims || {}) as Record<string, number>

  const data: LayerProfile = {
    ok: true, id, name, repo,
    totalLines, totalFiles, rows, named, groups,
    verdict: verdictOf(rows, named, groups, totalLines),
    unreadable: scanned.unreadable,
    nonText: scanned.nonText,
    skipped: scanned.skipped,
    specSource: spec?.source || '',
    claims,
    claimsNote: spec?.claimsNote || '',
    claimRows: claimRows(claims, named),
    missing: '',
    note: specError
      ? specError
      : (spec ? '' : '这个项目还没写「声称的分层」（task-data/layer-specs/<id>.json）—— 所以只能看目录占比，回答不了「号称是 A 但 88% 在 B」'),
  }
  dayCache.set(repo, { day, data })
  return data
}

/** 横比：扫一批项目。串行 —— 并行读盘在 Windows 上没快多少，还会让进度条乱跳。 */
export async function profileAll(
  projects: ProjectLike[], opts: { depth?: number; force?: boolean } = {},
): Promise<LayerProfile[]> {
  const out: LayerProfile[] = []
  for (const p of projects) out.push(await profileProject(p, opts))
  return out
}
