#!/usr/bin/env node
/**
 * 一条命令打包（2026-10-27）—— 顺手治"release 目录堆积"这个病
 *
 * 起因：暮雨问“一堆类似 release-036 的文件夹…怎么清理？如何从根源杜绝？”
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
// 搬运纯逻辑（挑 + 核对）已抽出并单独上测试 —— 见 scripts/lib/packCarry.cjs
const { pickCarried, verifyCarried, carryAudit, pickRetention } = require('./lib/packCarry.cjs')
const path = require('path')
const { spawnSync } = require('child_process')

const DESKTOP = path.resolve(__dirname, '..', 'desktop')
// 输出目录：**固定一个** `desktop/pkg`（已写在 .gitignore 里，不入库、不堆积）。
// ⚠ 这个目录是**发版取件目录**：`publish-release.sh` 与 `release-precheck.py` 都从这里取资产。
//   三处路径必须一致（`pack.cjs` 的 OUT / `publish-release.sh` 的 REL_DIR /
//   `release-precheck.py` 的 `desktop/pkg`），改一处就要改三处。
// ⚠ 2026-10-27 的教训，两条都别重走：
//   ① 堆积的病根是“每打一版新建一个 `release-<ver>` 目录”，**不是**“产物放在工作区里”。
//      修法只有一条：永远用同一个目录。搬到工作区外是过度反应 —— 暮雨当场纠正：
//      “自家产品现成方案都不会抄吗？甚至抄旧的方寸不都好好的？”
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
// ⚠ 撞锁时会**自动降级到 %TEMP%**（见 main 里的 probeWritable），默认值不变
let STAGE = path.join(DESKTOP, process.env.FC_PKG_STAGE || '.pkg-tmp')

function log(m) { console.log(m) }

/** 暂存目录能不能写？—— 直接在它里面建/删一个探针文件
 *  （比“看目录在不在”可靠：目录在、但被别的进程攥着 asar 时，连新建都会 EPERM/EBUSY）
 *  返回 '' = 可写；否则返回错误码/消息。 */
function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, '.fc-write-probe')
    fs.writeFileSync(p, 'x')
    fs.unlinkSync(p)
    return ''
  } catch (e) {
    return `${e.code || ''} ${e.message}`.trim()
  }
}

/**
 * 逐文件把 src 拷到 dst，**被占的单个文件跳过并记账**（不假装干净）。
 *
 * 为什么需要它：`pkg/win-unpacked/resources/app.asar` 是 0.6.3 的旧解包，被索引器长期持有句柄，
 * 整个目录换名/清空都会失败。但 `Fangcun-Setup.<ver>.exe` 本身没人占 —— 它必须能换掉，
 * 否则"打了一版却拿不到安装包"。所以能换的全换，换不掉的如实列出来。
 */
function copySkippingLocked(src, dst) {
  const skipped = []
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true })
    for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, ent.name)
      const dp = path.join(d, ent.name)
      if (ent.isDirectory()) { walk(sp, dp); continue }
      try { fs.copyFileSync(sp, dp) } catch (e) { skipped.push(`${path.relative(dst, dp)}（${e.code || 'ERR'}）`) }
    }
  }
  walk(src, dst)
  return skipped
}

/** 降级暂存目录到 %TEMP%（只为绕过文件锁，不是换流程） */
function tempStage(ver) {
  const os = require('os')
  const p = path.join(os.tmpdir(), `fc-pkg-stage-${ver}-${Date.now()}`)
  fs.mkdirSync(p, { recursive: true })
  return p
}

/** 逐文件清空目录：跳过被锁的，能删多少删多少
 *  （锁的真实来源见文件头：索引器持有 `*.asar`，不是 OneDrive / Windows Search —— 那两个
 *    2026-10-27 停过，`释放 0 MB`，纯属误判） */
function emptyDir(dir, keep) {
  if (!fs.existsSync(dir)) return { freed: 0, locked: 0 }
  let freed = 0, locked = 0
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) { walk(p); try { fs.rmdirSync(p) } catch { /* 非空/被占 */ } }
      else {
        // keep 谓词只作用于**顶层**文件名（旧版安装包）；不传就是老行为：能删就删
        if (keep && d === dir && keep(ent.name)) continue
        try { const sz = fs.statSync(p).size; fs.unlinkSync(p); freed += sz }
        catch { locked++ }
      }
    }
  }
  walk(dir)
  try { fs.rmdirSync(dir) } catch { /* 还有被锁文件，留着 */ }
  // 2026-11-11 补：**删不掉时要能回答“还剩几项”**。此前调用方只看 locked，
  // 而 rmdir 失败根本不进 locked —— 于是日志写着“已清空”，目录还在（假成功）。
  let left = 0
  try { left = fs.readdirSync(dir).length } catch { left = 0 }
  return { freed, locked, left }
}

/**
 * `pkg` 是**发版取件目录**。历史安装包**按保留策略自动清**（2026-11-11 暮雨：
 * 「禁止永不清理。我自己也会经常删旧版安装包」）。
 *
 * 口径：只留**最近 `FC_PKG_KEEP` 个安装包**（默认 3），连同它们的 `.blockmap`；更早的 exe 与块图、
 * 以及没有对应 exe 的孤儿块图，在打包收尾时清掉并**逐条报出来**（不静默）。
 * 清空产物目录时那条 keep 谓词仍然保留：清的是「暂存目录重建」路径，不该顺手删安装包 ——
 * 删除只发生在**收尾的保留策略**那一步，一个地方管一件事。
 */
const KEEP_OLD_INSTALLERS = (name) => /^Fangcun-Setup\.\d+\.\d+\.\d+\.exe(\.blockmap)?$/.test(name)
/** 保留几个历史安装包（0 = 打完只留本次；负数按 0 算） */
const KEEP_INSTALLERS = (() => {
  const n = Number(process.env.FC_PKG_KEEP)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 3
})()

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
    log(`  一条命令改全四处：node scripts/version.cjs set ${ver}`)
    process.exit(1)
  }

  // ⓪ 版本体检：真源之外还有三处派生（lock 文件 / skills manifest / MCP 桥自报版本）。
  //    之前靠“人记得改”，结果 MCP 桥自报 0.3.9、lock 停在 0.3.10 —— 打包前先拦。
  {
    const vp = spawnSync(process.execPath, [path.join(__dirname, 'version.cjs'), 'check'], {
      cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
    })
    if (vp.status !== 0) {
      log('✗ 版本号有落点没跟上。修：node scripts/version.cjs set ' + ver + '，再打')
      process.exit(1)
    }
  }

  // ① 清掉上一轮的暂存目录
  //    ⚠ 2026-11-07 实测补：**"被占 1 个文件"就足够让这一轮必挂** ——
  //    electron-builder 自己在 `win-unpacked.tmp\resources\default_app.asar` 上会 unlink，
  //    撞到索引器持有的句柄直接 `EBUSY`。所以"目录可写"不等于"能开工"，
  //    这里把 locked 计数带下去，作为要不要降级的判据之一。
  let staleLocked = 0
  if (!noClean) {
    const r = emptyDir(STAGE)
    staleLocked = r.locked
    if (r.freed || r.locked) log(`清暂存目录：释放 ${(r.freed / 1048576).toFixed(1)}MB` + (r.locked ? `，${r.locked} 个被占` : ''))
  }

  // ①a 暂存目录能不能真写？不能就自动降级到 %TEMP%（2026-11-07 补，治“本机必撞 EBUSY”）
  //    病根：工作区里的 `*.asar` 被索引器长期持有句柄 —— `pkg/` 与 `.pkg-tmp/` 连改名都被拒（WinError 5）。
  //    以前的做法是人工用 FC_PKG_OUT/FC_PKG_STAGE 换个新名字再挪回来；现在改成自动试一次。
  let degraded = false
  {
    const err = probeWritable(STAGE)
    // 两种都得降级：① 根本写不进去；② 写能写、但里面还有上一轮删不掉的 asar
    // （builder 会在同目录自己 unlink，撞上就是 EBUSY —— 2026-11-07 真撞到了）
    if (err || staleLocked > 0) {
      const t = tempStage(ver)
      log(err
        ? `⚠ 暂存目录不可写（${err}）`
        : `⚠ 暂存目录里有 ${staleLocked} 个上一轮的残留文件删不掉（builder 会在同目录 unlink，必撞 EBUSY）`)
      log(`  多半是索引器还攥着旧 asar；本轮自动降到 ${t}`)
      STAGE = t
      degraded = true
    }
  }

  // `--dry`：只跑到这里（体检 + 清暂存 + 试写探针），不真打。
  // 存在的理由：降级分支平时**没有锁就永远跑不到**，光靠"读代码觉得对"不算验证过。
  if (process.argv.includes('--dry')) {
    log(`--dry：到此为止（未打包）。STAGE=${STAGE}${degraded ? ' [已降级]' : ''}`)
    process.exit(0)
  }

  // ①b 顺手清掉工作区里**历史堆积**的产物目录：`release-<ver>/`、`release/`、`pkg.old*`。
  //    ⚠ `pkg/` 是正式输出（发版取件目录），**永远不进这个列表** —— 清了就没得发了。
  //    这些位置删不掉是常态（索引器锁着 asar）→ 尽力删，删不掉的如实列出，不假装干净。
  //    ⚠ 2026-11-11 实况（暮雨截图）：`pkg.old-*` 一次打包留一个，攒了 **9 个 / 4.4GB**，
  //    而且日志写着“旧目录已清空”—— 因为 emptyDir 当时把历史安装包当“要保留的”放过了，
  //    rmdir 失败又被吞掉。现在：旧目录不再传 keep，删不掉就点名。
  if (!noClean) {
    const legacy = fs.readdirSync(DESKTOP, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (e.name.startsWith('release') || /^pkg\.old/.test(e.name)))
      .map((e) => e.name)
    for (const name of legacy) {
      const p = path.join(DESKTOP, name)
      const r2 = emptyDir(p)
      if (r2.left > 0) {
        log(`⚠ 工作区里还剩旧产物 ${name}/：已释放 ${(r2.freed / 1048576).toFixed(1)}MB，还剩 ${r2.left} 项被占用（退出索引器后再删）`)
      } else log(`✓ 已清掉工作区里的旧产物 ${name}/（${(r2.freed / 1048576).toFixed(1)}MB）`)
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
  //    `verifyDir` = 自检该看哪个目录：正常就是 OUT；若 pkg 有文件换不掉而产物还在 TEMP，就查 TEMP
  //    （否则自检会去读 pkg 里那份**旧的** app.asar，报"版本对不上"，把人引向错误的结论）
  let verifyDir = OUT
  //    （旧目录里万一还有被锁的文件，名字已让位，不影响本次产物）
  let oldDir = ''
  /** 换目录前先记下旧的版本化安装包 —— 换完原样搬回来，再按保留策略清多余的那几个 */
  const carried = []
  /** 搬运核对结果：只要有一份没搬到位，旧目录就**不许删**（宁可多占一份，也不能静默丢） */
  let carryOk = true
  /** 打包前 OUT 的顶层文件名 —— 用于**集合级**核对（下面 carryAudit） */
  let beforeNames = []
  try {
    if (fs.existsSync(OUT)) {
      beforeNames = fs.readdirSync(OUT)
      carried.push(...pickCarried(beforeNames, ver))
      // 固定名 `pkg.old`：一次只留一个副本。上一轮若因锁没删掉，先尽力清；
      // 还清不掉才退回带时间戳的名字（这一轮不能因为残留而打不下去）。
      oldDir = OUT + '.old'
      if (fs.existsSync(oldDir)) {
        const pre = emptyDir(oldDir)
        if (pre.left > 0) {
          oldDir = OUT + '.old-' + Date.now()
          log(`  上一次的 ${path.basename(OUT)}.old 还有 ${pre.left} 项被占用 —— 这轮改用 ${path.basename(oldDir)}（退出索引器后清掉旧的）`)
        }
      }
      fs.renameSync(OUT, oldDir)
      log(`旧产物已挪到 ${path.basename(oldDir)}`)
    }
    fs.renameSync(STAGE, OUT)
    for (const f of carried) {
      try { fs.copyFileSync(path.join(oldDir, f), path.join(OUT, f)) } catch { /* 单个失败在下面统一核对时点名 */ }
    }
    // ⚠ 2026-11-11 血账：0.6.19 那次日志写着「已保留 16 个」，下一次打包只剩 6 个 ——
    //   复制失败被 catch 吞了，而旧目录又被整份删掉，0.6.11–0.6.16 六个安装包永久丢失。
    //   现在：搬完必须**逐个核对**（同名同字节数）；核对不过就保留旧目录并大声报出来。
    const v = verifyCarried(fs, path, oldDir, OUT, carried)
    if (carried.length) {
      // ⚠ 2026-11-11 补一笔记账口径：`carried` 里既装安装包也装 `.blockmap`（KEEP_OLD_INSTALLERS 两个都收），
      //   所以第一版日志写「已保留 12 个旧版**安装包**」而实际只有 6 个 exe —— 数得对、名词错。
      //   这类"数字对得上但话术含糊"正是 0.6.19 那次血账里没人复核的原因，故分开数、分开说。
      const exes = carried.filter((f) => f.endsWith('.exe')).length
      const maps = carried.length - exes
      if (v.ok) log(`已保留 ${carried.length} 个旧版产物（安装包 ${exes} · blockmap ${maps}，已逐个核对：${carried.length}/${carried.length}）`)
      else {
        log(`⚠ 旧版产物只搬过去 ${carried.length - v.missing.length}/${carried.length}：`
          + v.missing.slice(0, 3).map((m) => `${m.name}（${m.why}）`).join('、')
          + `${v.missing.length > 3 ? ' 等' : ''} —— **旧目录已保留，不删**`)
      }
    }
    // ⚠⚠ 2026-11-11 **第二次血账**：0.6.17–0.6.22 六个安装包没了（pkg 里只剩一个 0.6.22 的 blockmap）。
    //   根因这次不是"复制失败被吞"——`verifyCarried` 只核对「我打算搬的那几个」，
    //   要是**挑的时候就少挑了几份**，逐份核对会全绿。所以补一道**集合级**闸。
    //   ⚠ 同日暮雨定调：「禁止永不清理」—— 老包本来就该清，但**只能由保留策略有意地清**，
    //   不能“搬家时顺手丢了”。所以核对口径是：before 里的每个文件，要么还在，要么在 prune 名单里。
    const pruned = []
    try {
      const ret = pickRetention(fs.readdirSync(OUT), KEEP_INSTALLERS)
      for (const name of ret.prune) {
        try { fs.rmSync(path.join(OUT, name), { force: true }); pruned.push(name) } catch { /* 锁住的留着，下面如实报 */ }
      }
      if (pruned.length) {
        log(`  保留策略：留最近 ${KEEP_INSTALLERS} 个安装包（FC_PKG_KEEP 可调）→ 清掉 ${pruned.length} 个更早的产物：`
          + pruned.slice(0, 4).join('、') + `${pruned.length > 4 ? ' 等' : ''}`)
      } else {
        log(`  保留策略：留最近 ${KEEP_INSTALLERS} 个安装包（FC_PKG_KEEP 可调）→ 没有需要清理的更早产物`)
      }
    } catch (e) {
      log(`  ⚠ 保留策略没跑成（${e && e.message}）—— 旧包原样留着，不影响本次产物`)
    }
    const audit = carryAudit(beforeNames, fs.readdirSync(OUT), pruned)
    carryOk = (!oldDir || v.ok) && audit.ok
    if (!audit.ok) {
      log(`⚠⚠ 旧产物**集合级**核对不过：打包前有 ${audit.before} 份安装包/块图，打完不明原因少了 ${audit.lost.length} 份 —— `
        + audit.lost.slice(0, 4).join('、') + `${audit.lost.length > 4 ? ' 等' : ''}`)
      log('    （保留策略有意清掉的不算“丢”；这几份是**没有任何理由就消失的**）')
      log('    **旧目录已保留，不删**；请先查明原因（被锁 / 被杀软吃掉 / 挑漏），再重打。')
    }
    log(`✓ 已切换为新的产物目录 ${OUT}`)
  } catch (e) {
    // 退回方案：目录里有被锁住的文件时会 EPERM。逐文件清（跳锁）再复制进去。
    log(`  直接换名失败（${e.code || e.message}），改用"清空 + 复制"` + (degraded ? '（跨盘/降级模式属预期）' : ''))
    try {
      const c = emptyDir(OUT, KEEP_OLD_INSTALLERS)
      if (c.locked) log(`  产物目录里 ${c.locked} 个文件清不掉（有进程在读旧包）—— 逐文件换新，锁住的跳过`)
      const skipped = copySkippingLocked(STAGE, OUT)
      if (!skipped.length) {
        fs.rmSync(STAGE, { recursive: true, force: true })
        log('✓ 已用复制方式切到新产物目录')
      } else {
        // 不静默：锁住的逐个点名，并指明"完整产物在哪"，而不是让人以为 pkg 已经是新的
        log(`⚠ pkg 里 ${skipped.length} 个文件被占没换掉：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}`)
        log(`  安装包与其余文件已是新的；**完整产物在 ${STAGE}**（退出索引器后可整目录替换，不用重打）`)
        verifyDir = STAGE
      }
    } catch (e2) {
      log(`✗ 切换失败：${e2.message}`)
      log(`  **完整产物在 ${STAGE}**（这一轮不用重打，处理掉占用后把它拷进 ${OUT}）`)
      process.exit(1)
    }
  }
  if (oldDir && !carryOk) {
    // 只有“搬运核对全过”才允许删旧目录 —— 否则上面那份旧目录就是原版安装包唯一的副本
    log(`  旧目录保留：${path.basename(oldDir)}（搬运核对没过，里面还有原版安装包）`)
  } else if (oldDir) {
    // ⚠ **不传 keep**：历史安装包已经 `copyFileSync` 回新 pkg 并核对过，旧目录里那份是副本。
    //   传 keep 会让目录永远非空、rmdir 静默失败 —— 然后日志说“已清空”（2026-11-11 的假成功）。
    const r2 = emptyDir(oldDir)
    if (r2.left > 0) {
      log(`⚠ 旧目录没删干净：${path.basename(oldDir)}（已释放 ${(r2.freed / 1048576).toFixed(1)}MB，还剩 ${r2.left} 项被占）`
        + ' —— 退出索引器后再删，或跑 clean-release.bat')
    } else {
      log(`  旧目录已删除（释放 ${(r2.freed / 1048576).toFixed(1)}MB）`)
    }
  }

  // ④ 自检：退出码 0 ≠ 包里有新代码
  const asar = path.join(verifyDir, 'win-unpacked', 'resources', 'app.asar')
  const exe = path.join(verifyDir, `Fangcun-Setup.${ver}.exe`)
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
  const exeBin = path.join(verifyDir, 'win-unpacked', '方寸.exe')
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

  // ⑤ 台账镜像 —— 2026-11-11 晚**已撤**（暮雨：「禁止永不清理。我自己也会经常删旧版安装包」）。
  //    留一份“只增不减”的仓库外副本，等于把“不许清理”换个地方实现；而老包本来就该清。
  //    现在只保留一件事：`pkg` 里按 KEEP_INSTALLERS 自动清，想留几版用 FC_PKG_KEEP 调。

  if (verifyDir !== OUT) log(`\n注意：自检查的是 ${verifyDir}（pkg 里有文件被占没换掉，见上）`)
  log(ok ? `\n完成：${exe}` : '\n有自检项没过，别发版')
  process.exit(ok ? 0 : 1)
}

main()
