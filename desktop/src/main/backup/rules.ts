/**
 * 备份排除规则 — 零依赖，可在纯 Node 下测试
 *
 * 这里是密钥外泄的最后一道闸：任何被判定为 excluded 的文件都不会进入备份包。
 */

/** 绝不入备份的文件名（小写比较）。密钥类文件是绝对红线。 */
export const SECRET_BASENAMES = [
  'llm-config.json',
  'backup-config.json',
  'credentials.json',
  'apps.json',
  '.env',
  '.env.local',
  'accesskey',
  'secretkey',
  'id_rsa',
  'id_ed25519',
]

/** 绝不入备份的后缀 */
export const SECRET_SUFFIXES = ['.key', '.pem', '.p12', '.pfx', '.jks', '.keystore', '.sha256']

/** 绝不遍历的目录名 */
export const EXCLUDE_DIRS = [
  '.trash', '.backup', '.tmp', 'backups', 'temp', 'tmp',
  'cache', 'gpucache', 'cacheddata', 'code cache', 'dawncache',
  'node_modules', '.git', 'crashpad', 'blob_storage', 'local storage',
  'session storage', 'shared dictionary', 'network', 'partitioned',
]

/** 临时/备份产物后缀 */
export const EXCLUDE_SUFFIXES = ['.tmp', '.bak', '.swp', '.log.old']

/** 判断某相对路径是否必须排除在备份之外 */
export function isExcluded(relativePath: string): boolean {
  const p = String(relativePath).replace(/\\/g, '/').toLowerCase()
  const parts = p.split('/').filter(Boolean)
  if (parts.length === 0) return false

  // 目录段命中即排除（中间任何一层）
  for (const seg of parts) {
    if (EXCLUDE_DIRS.includes(seg)) return true
  }

  const base = parts[parts.length - 1]
  if (SECRET_BASENAMES.includes(base)) return true
  if (SECRET_SUFFIXES.some(s => base.endsWith(s))) return true
  if (EXCLUDE_SUFFIXES.some(s => base.endsWith(s))) return true

  return false
}

/** 判断是否属于「密钥类」排除（用于在 manifest 里单独记账，与普通临时文件区分） */
export function isSecretLike(relativePath: string): boolean {
  const base = String(relativePath).replace(/\\/g, '/').toLowerCase().split('/').pop() || ''
  return SECRET_BASENAMES.includes(base) || SECRET_SUFFIXES.some(s => base.endsWith(s))
}
