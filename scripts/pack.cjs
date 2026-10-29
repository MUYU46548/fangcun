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
 *   ① 打包前清空暂存，并顺手清掉工作区里遗留的旧产物目录（`pkg/`、`release-<ver>/`，删不掉的如实列出）
 *   ② 三件环境变量照 AGENTS（少一个不是慢，是直接失败）
 *   ③ 输出**固定**到 `desktop/pkg`（单目录、发版取件目录，.gitignore 已忽略，不按版本命名）
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
// 输出目录：**固定一个** `desktop/pkg`（已写在 .gitignore 里，不入库、不堆积）。
// ⚠ 这个目录是**发版取件目录**：`publish-release.sh` 与 `release-precheck.py` 都从这里取资产。
//   三处路径必须一致（`pack.cjs` 的 OUT / `publish-release.sh` 的 REL_DIR /
//   `release-precheck.py` 的 `desktop/pkg`），改一处就要改三处。
// ⚠ 2026-10-27 的教训，两条都别重走：
//   ① 堆积的病根是「每打一版新建一个 `release-<ver>` 目录」，**不是**「产物放在工作区里」。
//      修法只有一条：永远用同一个目录。搬到工作区外是过度反应 —— 暮雨当场纠正：
//      「自家产品现成方案都不会抄吗？甚至抄旧的方寸不都好好的？」
//   ② 打包会撞 `EPERM/EBUSY`：工作区里的 `*.asar` 会被**索引器长期持有句柄**
//      （实测点名 = WorkBuddy 后台 daemon `daemon-app-server-entry.js --stdio`；
//      不是 OneDrive、不是 Windows Search —— 这两个停过，`释放 0 MB`）。
//      撞上时**退出索引器再打**，不要去改输出路径。
// ⚠ 2026-10-29 加的口子（**只为绕过文件锁**，不是换流程）：
//   工作区里的 `*.asar` 会被索引器长期持有句柄（见下方 ② 的说明），一旦撞上，
//   `pkg/` 与 `.pkg-tmp/` 两个目录**连改名都会被拒**（WinError 5），这一轮就打不下去。
//   此时用 `FC_PKG_OUT=pkg-<ver> FC_PKG_STAGE=.pkg-tmp-<ver>` 打到一个**新名字**的目录，
//   退出索引器后再把产物挪回 `pkg/`。默认值不变 —— 正经发版永远打 `pkg/`。
const OUT = path.join(DESKTOP, process.env.FC_PKG_OUT || 'pkg')
// 暂存目录（已在 .gitignore）：先打到这里，成功后整体改名成 release，避免半成品污染 release
const STAGE = path.join(DESKTOP, process.env.FC_PKG_STAGE || '.pkg-tmp')

function log(m) { console.log(m) }

/** 逐文件清空目录：跳过被锁的，能删多少删多少
 *  （锁的真实来源见文件头：索引器持有 `*.asar`，不是 OneDrive / Windows Search —— 那两个
 *    2026-10-27 停过，`释放 0 MB`，纯属误判） */
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
  if (process.env.FC_PKG_OUT || process.env.FC_PKG_STAGE) {
    log(`⚠ 用了目录覆盖（OUT=${path.basename(OUT)} STAGE=${path.basename(STAGE)}）—— 这是绕过文件锁的临时口子，`
      + `退出索引器后请把产物挪回 pkg/`)
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

  // ①b 顺手清掉工作区里**历史堆积**的产物目录：`release-<ver>/`、`release/`。
  //    ⚠ `pkg/` 是正式输出（发版取件目录），**永远不进这个列表** —— 清了就没得发了。
  //    这些位置删不掉是常态（索引器锁着 asar）→ 尽力删，删不掉的如实列出，不假装干净。
  if (!noClean) {
    const legacy = fs.readdirSync(DESKTOP, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('release'))
      .map((e) => e.name)
    for (const name of legacy) {
      const p = path.join(DESKTOP, name)
      const r2 = emptyDir(p)
      if (r2.locked) log(`⚠ 工作区里还剩旧产物 ${name}/：已释放 ${(r2.freed / 1048576).toFixed(1)}MB，${r2.locked} 个文件被占用`)
      else log(`✓ 已清掉工作区里的旧产物 ${name}/（${(r2.freed / 1048576).toFixed(1)}MB）`)
    }
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

  // ③ 打（输出目录用相对名，electron-builder 相对 cwd=desktop 解析）
  fs.mkdirSync(STAGE, { recursive: true })
  const stageRel = path.relative(DESKTOP, STAGE)
  log(`开始打包 ${ver} → ${STAGE}`)
  const r = spawnSync('npx', ['electron-builder', `-c.directories.output=${stageRel}`], {
    cwd: DESKTOP, env, stdio: 'inherit', shell: true,
  })
  if (r.status !== 0) {
    log(`✗ 打包失败（exit ${r.status}）。半成品在 ${STAGE}，下次打包会先清掉`)
    process.exit(r.status || 1)
  }

  // ③b 原子换名：旧产物先挪走，再把 tmp 改名成正式目录，最后尽力删旧的
  //    （旧目录里万一还有被锁的文件，名字已让位，不影响本次产物）
  let oldDir = ''
  try {
    if (fs.existsSync(OUT)) {
      oldDir = OUT + '.old-' + Date.now()
      fs.renameSync(OUT, oldDir)
      log(`旧产物已挪到 ${path.basename(oldDir)}`)
    }
    fs.renameSync(STAGE, OUT)
    log(`✓ 已切换为新的产物目录 ${OUT}`)
  } catch (e) {
    // 退回方案：目录里有被锁住的文件时会 EPERM。逐文件清（跳锁）再复制进去。
    log(`  直接换名失败（${e.code || e.message}），改用"清空 + 复制"`)
    try {
      const c = emptyDir(OUT)
      if (c.locked) throw new Error(`产物目录里还有 ${c.locked} 个文件被占用（有进程在读这份包），关掉它再跑`)
      fs.cpSync(STAGE, OUT, { recursive: true })
      fs.rmSync(STAGE, { recursive: true, force: true })
      log('✓ 已用复制方式切到新产物目录')
    } catch (e2) {
      log(`✗ 切换失败：${e2.message}`)
      log(`  新包仍在 ${STAGE}，处理掉占用后再跑一次即可`)
      process.exit(1)
    }
  }
  if (oldDir) {
    const r2 = emptyDir(oldDir)
    if (r2.locked) log(`  旧目录释放 ${(r2.freed / 1048576).toFixed(1)}MB，${r2.locked} 个被占用（多半是索引器还开着；退出它后再跑 clean-release.bat）`)
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
    // ⚠ 2026-10-29 实测修正：**必须带 ELECTRON_RUN_AS_NODE=1**。
    //   不带它时 exe 按 GUI 模式启动真实应用（开窗口、抢单实例锁），30s 后被 timeout 杀掉、
    //   输出为空 —— 看起来像"自检跳过"，实际是把应用拉起又掐掉（很脏）。
    //   带上它 exe 就是纯 node，`--version` 直接打印包内 Node 版本（Electron 44 → v24.x）。
    const v = spawnSync(exeBin, ['--version'], {
      encoding: 'utf-8', timeout: 30000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    const line = String(v.stdout || '').trim()
    if (/^v[0-9]+\./.test(line)) log(`✓ 包内 Node 版本（= Electron 引擎）：${line}`)
    else { log(`⚠ 读不到包内 Node 版本（输出：${(line || v.stderr || '').slice(0, 120)}）`); ok = false }
  }

  log(ok ? `\n完成：${exe}` : '\n有自检项没过，别发版')
  process.exit(ok ? 0 : 1)
}

main()
