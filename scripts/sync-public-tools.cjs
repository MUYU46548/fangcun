/**
 * 把随应用分发的独立工具同步进 public/，使其被 electron-builder 打进安装包。
 *
 * 单一事实来源是仓库 scripts/ 下的脚本；public/ 里的副本是构建产物。
 * 运行：node scripts/sync-public-tools.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PAIRS = [
  ['scripts/fangcun-restore.py', 'desktop/public/fangcun-restore.py'],
]

let changed = 0
for (const [src, dst] of PAIRS) {
  const s = path.join(ROOT, src)
  const d = path.join(ROOT, dst)
  if (!fs.existsSync(s)) {
    console.error(`[sync-public-tools] 源文件缺失：${src}`)
    process.exit(1)
  }
  const sBuf = fs.readFileSync(s)
  const same = fs.existsSync(d) && Buffer.compare(fs.readFileSync(d), sBuf) === 0
  if (same) continue
  fs.mkdirSync(path.dirname(d), { recursive: true })
  fs.writeFileSync(d, sBuf)
  changed++
  console.log(`[sync-public-tools] ${src} → ${dst}`)
}

console.log(changed ? `[sync-public-tools] 同步 ${changed} 个文件` : '[sync-public-tools] 已是最新')
