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
// ⚠ 输出目录叫 `pkg`（不是 `release`）：`release*` 是历史遗留名，里面全是删不掉的老 asar，
//   连目录改名都会 EPERM。换一个干净名字 = 一次性的隔离，之后 `release*` 交给
//   `清理打包残留.bat` 慢慢清，不再影响打包。
const OUT = path.join(DESKTOP, 'pkg')
// ⚠ 不能直接往 `release/` 里打：electron-builder 会先建 `win-unpacked.tmp`，
//   而旧 `release/win-unpacked.tmp/resources/default_app.asar` 常被系统进程占着 →
//   `EBUSY: resource busy or locked, unlink ...`（AGENTS.md 里 10-22 就记过这一条）。
//   所以每次都打到**新**的 `release.tmp`，成功后再原子改名 —— 既绕开 EBUSY，也不会堆目录。
const STAGE = path.join(DESKTOP, '.pkg-tmp')

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

  // ① 清掉上一轮的暂存目录（lock 住的就跳过，下面 ELBUSY 也不会发生，因为每次都换新目录名）
  if (!noClean) {
    const r = emptyDir(STAGE)
    if (r.freed || r.locked) log(`清暂存目录：释放 ${(r.freed / 1048576).toFixed(1)}MB` + (r.locked ? `，${r.locked} 个被占` : ''))
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
  log(`开始打包 ${ver} → ${path.basename(STAGE)}（完成后改名为 pkg）`)
  const r = spawnSync('npx', ['electron-builder', '-c.directories.output=.pkg-tmp'], {
    cwd: DESKTOP, env, stdio: 'inherit', shell: true,
  })
  if (r.status !== 0) {
    log(`✗ 打包失败（exit ${r.status}）。半成品在 ${path.basename(STAGE)}，下次打包会先清掉`)
    process.exit(r.status || 1)
  }

  // ③b 原子换名：旧 release 先挪走，再把 tmp 改名成 release，最后尽力删旧的
  //    （旧目录里被锁的 asar 删不掉没关系 —— 名字已让位，不影响本次产物）
  let oldDir = ''
  try {
    if (fs.existsSync(OUT)) {
      oldDir = OUT + '.old-' + Date.now()
      fs.renameSync(OUT, oldDir)
      log(`旧 pkg 已挪到 ${path.basename(oldDir)}`)
    }
    fs.renameSync(STAGE, OUT)
    log('✓ 已切换为新的 pkg')
  } catch (e) {
    // 退回方案：pkg 里有被系统进程锁住的文件时会 EPERM。逐文件清（跳锁）再复制进去。
    log(`  直接换名失败（${e.code || e.message}），改用"清空 + 复制"`)
    try {
      const c = emptyDir(OUT)
      if (c.locked) throw new Error(`pkg 里还有 ${c.locked} 个文件被占用，需要重启后重试`)
      fs.cpSync(STAGE, OUT, { recursive: true })
      fs.rmSync(STAGE, { recursive: true, force: true })
      log('✓ 已用复制方式切到新 pkg')
    } catch (e2) {
      log(`✗ 切换失败：${e2.message}`)
      log(`  新包仍在 ${path.basename(STAGE)}，重启后再跑一次即可`)
      process.exit(1)
    }
  }
  if (oldDir) {
    const r2 = emptyDir(oldDir)
    if (r2.locked) log(`  旧目录释放 ${(r2.freed / 1048576).toFixed(1)}MB，${r2.locked} 个被系统进程占用（重启后用「清理打包残留.bat」再清）`)
    else { try { fs.rmdirSync(oldDir) } catch { /* ignore */ } ; log(`  旧目录已清空（释放 ${(r2.freed / 1048576).toFixed(1)}MB）`) }
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
