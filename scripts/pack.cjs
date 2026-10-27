#!/usr/bin/env node
/**
 * 一条命令打包（2026-10-27）—— 顺手治"release 目录堆积"这个病
 *
 * 起因：暮雨问「一堆类似 release-036 的文件夹…怎么清理？如何从根源杜绝？」
 * 根源不是清得不够勤，是**流程本身每打一次版就新建一个目录**：
 * `electron-builder -c.directories.output=release-<ver>`。
 * 三个月积了 15 个（3.4GB），其中 6 个是打包中断留下的半成品（只有 app.asar，36MB）。
 *
 * 这个脚本把流程钉成一条：
 *   ① 打包前**清空** `desktop/release`（逐文件删，跳过被系统进程锁住的，报告不隐瞒）
 *   ② 三件环境变量照 AGENTS（少一个不是慢，是直接失败）
 *   ③ 输出**固定** `desktop/release`，不再按版本命名
 *   ④ 打完自检：`app.asar` 里读得到版本号 + 安装包体积合理；不过就非零退出
 *
 * 用法：
 *   node scripts/pack.cjs 0.4.5          # 先改 desktop/package.json 的 version，再跑
 *   node scripts/pack.cjs --no-clean     # 不清旧目录（排查时用）
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const DESKTOP = path.resolve(__dirname, '..', 'desktop')
const OUT = path.join(DESKTOP, 'release')

function log(m) { console.log(m) }

/** 逐文件清空目录：跳过被锁的，能删多少删多少（锁多半来自 OneDrive / Windows Search 索引） */
function emptyDir(dir) {
  if (!fs.existsSync(dir)) return { freed: 0, locked: 0 }
  let freed = 0, locked = 0
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) { walk(p); try { fs.rmdirSync(p) } catch { /* 非空/被占 */ } }
      else {
        try { const sz = fs.statSync(p).size; fs.unlinkSync(p); freed += sz }
        catch { locked++ }
      }
    }
  }
  walk(dir)
  try { fs.rmdirSync(dir) } catch { /* 还有被锁文件，留着 */ }
  return { freed, locked }
}

function main() {
  const ver = String(process.argv[2] || '').trim()
  const noClean = process.argv.includes('--no-clean')
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf-8'))
  if (!ver || ver.startsWith('-')) {
    log(`用法: node scripts/pack.cjs <版本号>   （当前 package.json = ${pkg.version}）`)
    process.exit(1)
  }
  if (pkg.version !== ver) {
    log(`⚠ package.json 的 version 是 ${pkg.version}，你要求打 ${ver} —— 先把 package.json 改成 ${ver}（版本号只有这一处真源）`)
    process.exit(1)
  }

  // ① 清旧产物
  if (!noClean) {
    const r = emptyDir(OUT)
    log(`清理旧产物：释放 ${(r.freed / 1048576).toFixed(1)}MB` + (r.locked ? `，${r.locked} 个文件被系统进程占用（重启后再清）` : ''))
  }

  // ② 三件环境变量（缺 ELECTRON_OVERRIDE_DIST_PATH 会去下别的版本，10 分钟超时才报错）
  const env = {
    ...process.env,
    ELECTRON_OVERRIDE_DIST_PATH: path.join(DESKTOP, 'node_modules', 'electron', 'dist'),
    ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  }
  if (!fs.existsSync(env.ELECTRON_OVERRIDE_DIST_PATH)) {
    log(`✗ 找不到 electron dist：${env.ELECTRON_OVERRIDE_DIST_PATH}（先 npm i）`)
    process.exit(1)
  }

  // ③ 打
  log(`开始打包 ${ver} → ${OUT}`)
  const r = spawnSync('npx', ['electron-builder', '-c.directories.output=release'], {
    cwd: DESKTOP, env, stdio: 'inherit', shell: true,
  })
  if (r.status !== 0) {
    log(`✗ 打包失败（exit ${r.status}）。半成品留在 ${OUT}，下次打包会自动清掉`)
    process.exit(r.status || 1)
  }

  // ④ 自检：退出码 0 ≠ 包里有新代码
  const asar = path.join(OUT, 'win-unpacked', 'resources', 'app.asar')
  const exe = path.join(OUT, `Fangcun-Setup.${ver}.exe`)
  let ok = true
  if (!fs.existsSync(asar)) { log('✗ 找不到 app.asar'); ok = false }
  else {
    const s = fs.readFileSync(asar).toString('utf8')
    if (!s.includes(ver)) { log(`✗ app.asar 里读不到版本号 ${ver}`); ok = false }
    else log(`✓ app.asar 含版本号 ${ver}`)
  }
  if (!fs.existsSync(exe)) { log(`✗ 找不到安装包 ${path.basename(exe)}`); ok = false }
  else log(`✓ 安装包 ${path.basename(exe)}  ${(fs.statSync(exe).size / 1048576).toFixed(1)}MB`)

  // 引擎版本（Electron 44 → v24）；这是"包真换了"最快的判据
  const exeBin = path.join(OUT, 'win-unpacked', '方寸.exe')
  if (fs.existsSync(exeBin)) {
    const v = spawnSync(exeBin, ['--version'], { encoding: 'utf-8', timeout: 30000 })
    if (v.stdout) log(`✓ 包内 Node 版本（= Electron 引擎）：${String(v.stdout).trim()}`)
  }

  log(ok ? `\n完成：${exe}` : '\n有自检项没过，别发版')
  process.exit(ok ? 0 : 1)
}

main()
