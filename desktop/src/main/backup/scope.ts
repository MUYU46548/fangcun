/**
 * 备份「范围」的**唯一真源**（2026-10-11）。
 *
 * 为什么单开一个文件：备份现在有**两条通道**要用同一套范围与同一套瘦身判据 ——
 *   ① zip 通道（`backup/index.ts`：本地包 / WebDAV / 导出到网盘）
 *   ② Git 通道（`backup/gitBackup.ts`：把真实文件镜像进仓库，让 git 历史可用）
 * 如果两处各写一份 includes、各写一套排除，迟早漂移成"zip 里有、git 里没有"，
 * 用户会以为某一侧坏了。所以范围与瘦身都收在这里，收集算法本身仍只有一份
 * （`packer.planSnapshot` —— 本文件不另写一套）。
 */
import { getBackupConfig, LOG_ATTACHMENTS_REL } from './config'
import { getDataDir } from '../data'
import { SnapshotSources } from './packer'

/**
 * 备份数据根（桌面版 = userData，即仓库根：内含 task-data/ registry.yaml policies/ docs/）。
 * ⚠ 走 `getDataDir()`，不要在别处再算一遍 —— 数据根有三条来源（userData 配置 / cwd 上溯 / exeDir）。
 */
export function backupRootDir(): string {
  return getDataDir()
}

/**
 * 备份范围（**唯一真源**）。
 *
 * ⚠ 2026-10-11 用户第 2 条补漏：`policies/`（**项目方针卡**）此前**根本不在备份范围里**。
 *   方寸的真源是三份：`task-data/`（任务）+ `registry.yaml`（项目登记）+ `policies/`（方针卡）。
 *   丢了方针卡 = 每次派活都失去项目背景，且无从找回 —— 这是静默的数据丢失面。
 */
export const BACKUP_INCLUDES = ['task-data', 'registry.yaml', 'policies', 'docs']

/** 把配置里的瘦身旋钮翻译成 packer 的入参（zip 通道与 Git 通道共用） */
export function scopeSources(): SnapshotSources {
  const cfg = getBackupConfig()
  const excludePrefixes: string[] = []
  if (cfg.slim?.excludeLogAttachments) excludePrefixes.push(LOG_ATTACHMENTS_REL)
  return {
    rootDir: backupRootDir(),
    includes: BACKUP_INCLUDES.slice(),
    appVersion: '0.2.1',
    maxFileMB: cfg.slim?.maxFileMB || 0,
    excludePrefixes,
  }
}

export { LOG_ATTACHMENTS_REL }

/**
 * 仓库里那份 `.gitignore` 的内容 —— 纵深防御：即便有人手抖把密钥类文件拷进工作副本，
 * git 也不会追踪它们（正常情况下它们根本不会被拷进来，`isExcluded` 先挡一道）。
 */
export const REPO_GITIGNORE = [
  '# 方寸同步仓库 —— 这个文件由方寸生成，用来兜底挡住密钥类文件',
  '# （正常同步时它们根本不会被拷进来；这里只是第二道闸，防手抖）',
  'llm-config.json',
  'backup-config.json',
  'git-backup.json',
  'git-credentials.json',
  'credentials.json',
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '.env',
  '.env.local',
  'accessKey',
  'secretKey',
  'id_rsa',
  'id_ed25519',
  '',
].join('\n')
