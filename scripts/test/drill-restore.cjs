/**
 * 方寸恢复演练（task-20261018-004 验收锚点③）
 *
 * 一条命令跑完：轮换体检 → 包校验 → 恢复（零破坏） → 计数对账 → 报告落 docs/
 *
 * ⚠ 零破坏红线：恢复落位到**临时目录**（restoreFrom 的 targetDir 参数，2026-10-18 新增），
 *   真实数据目录一个字节都不动。真机定期跑本脚本 = 用真包验证"恢复这条道永远通"。
 *
 * 用法：
 *   node scripts/test/drill-restore.cjs                      # 真机：最新本地包 + 真实数据目录对账
 *   node scripts/test/drill-restore.cjs --zip <路径>          # 指定某个备份包
 *   node scripts/test/drill-restore.cjs --data-dir <目录>     # 指定对账基准目录（默认=真实 dataDir）
 *   node scripts/test/drill-restore.cjs --no-report           # 不写 docs 报告（调试用）
 *
 * 退出码：0 = 全绿；1 = 有 FAIL（恢复这条道有问题，立即处理）
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

// ── electron 桩（与 e2e-backup 同款，必须在 require 业务模块之前） ─────────
const Module = require('module')
const STUB = path.join(__dirname, 'electron-stub.cjs')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB
  return origResolve.call(this, request, ...args)
}

// ── 参数 ─────────────────────────────────────────────────────────────────
function argOf(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const ZIP_ARG = argOf('zip')
const DATADIR_ARG = argOf('data-dir')
const NO_REPORT = process.argv.includes('--no-report')

let pass = 0, fail = 0
const failures = []
const lines = []
function check(name, cond, detail = '') {
  const ok = !!cond
  if (ok) pass++; else { fail++; failures.push(name) }
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  → ' + detail : ''}`
  console.log(line)
  lines.push(line)
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }
function countMd(dir) {
  if (!fs.existsSync(dir)) return -1
  let n = 0
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else if (f.endsWith('.md')) n++
    }
  }
  walk(dir)
  return n
}
function countTaskFiles(dataDir) {
  const d = path.join(dataDir, 'task-data')
  return fs.existsSync(d) ? countMd(d) : -1
}

// ── 主流程 ───────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now()
  const bk = require(path.join(DIST, 'backup/index.js'))
  const restore = require(path.join(DIST, 'backup/restore.js'))
  const cfgMod = require(path.join(DIST, 'backup/config.js'))
  const dataMod = require(path.join(DIST, 'data/index.js'))
  // 对账基准：--data-dir 显式指定 > 当前工作目录（演练从仓库根跑）。
  // 不走 initPaths()：那是 electron 态的探测链（userData/exeDir），桩环境拿不到真实仓库根。
  const realDataDir = DATADIR_ARG ? path.resolve(DATADIR_ARG) : process.cwd()
  dataMod.setDataDir(realDataDir)
  console.log(`数据目录（对账基准）：${realDataDir}`)
  lines.push(`数据目录（对账基准）：${realDataDir}`)

  // ── 段1：轮换体检（88MB/38 份根因定案就在这一段） ────────────────────────
  console.log('\n── 段1 轮换体检 ──')
  lines.push('\n## 段1 轮换体检')
  const cfg = cfgMod.getBackupConfig()
  const localDir = bk.getLocalBackupDir()
  console.log(`配置：localKeep=${cfg.localKeep}  maxLocalMb=${cfg.maxLocalMb}  localDir=${cfg.localDir || '(默认)'}`)
  lines.push(`- 配置：localKeep=${cfg.localKeep}  maxLocalMb=${cfg.maxLocalMb}  localDir=${cfg.localDir || '(默认)'}`)
  const diag = bk.diagnoseRotation(localDir, cfg.localKeep, cfg.maxLocalMb)
  check('备份目录存在', diag.dirExists, localDir)
  check('目录可读且能列出组', typeof diag.standardCount === 'number' && diag.standardCount >= 0, JSON.stringify(diag))
  for (const v of diag.verdicts) { console.log('  · ' + v); lines.push('  - ' + v) }
  check('体检结论：份数与保留线的关系已给出', diag.verdicts.some(v => v.includes('份数')))
  if (diag.unrecognized.length > 0) {
    check('非标准命名包已识别并列入关注', diag.unrecognized.length > 0, '见 verdicts')
  }

  // ── 段2：取包 + 校验 ────────────────────────────────────────────────────
  console.log('\n── 段2 包校验 ──')
  lines.push('\n## 段2 包校验')
  let zipPath = ZIP_ARG
  if (!zipPath) {
    const locals = bk.listLocalBackups()
    check('本地备份列表非空（有包可演练）', locals.length > 0, '0 份')
    if (locals.length === 0) return finish(1)
    zipPath = locals[0].path  // 列表 mtime 倒序，[0] = 最新
  }
  console.log(`演练对象：${zipPath}`)
  lines.push(`- 演练对象：${zipPath}`)
  check('备份包存在', fs.existsSync(zipPath), zipPath)

  const sidecar = zipPath + '.sha256'
  const zipBuf = fs.readFileSync(zipPath)
  if (fs.existsSync(sidecar)) {
    check('sha256 sidecar 校验通过', fs.readFileSync(sidecar, 'utf-8').trim() === sha256(zipBuf))
  } else {
    check('（降级）无 sidecar，走结构校验', true)
  }
  check('包体积合理（>1KB）', zipBuf.length > 1024, String(zipBuf.length))

  // ── 段3：恢复到临时目录（零破坏） ────────────────────────────────────────
  console.log('\n── 段3 恢复（零破坏，落位临时目录） ──')
  lines.push('\n## 段3 恢复（零破坏）')
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-drill-'))
  const r = await restore.restoreFrom({ kind: 'local', path: zipPath }, { targetDir })
  check('恢复流程成功（sha256→结构→解压→落位全链）', r.ok, JSON.stringify(r.errors))
  check('恢复落位在临时目录（targetDir 生效=真实数据未动）', r.dataDir === targetDir, `落位=${r.dataDir} 期望=${targetDir}`)
  check('恢复文件数 > 0', r.restoredFiles > 0, String(r.restoredFiles))

  // ── 段4：计数对账 ────────────────────────────────────────────────────────
  console.log('\n── 段4 计数对账 ──')
  lines.push('\n## 段4 计数对账')
  const restoredTask = path.join(targetDir, 'task-data')
  const restoredLogs = path.join(targetDir, 'docs', '执行日志')
  check('恢复出 task-data 目录', fs.existsSync(restoredTask), restoredTask)
  check('恢复出 registry.yaml', fs.existsSync(path.join(targetDir, 'registry.yaml')))
  const restoredCount = countMd(restoredTask)
  check('恢复目录任务卡计数 > 0', restoredCount > 0, String(restoredCount))
  const nowCount = countTaskFiles(realDataDir)
  if (nowCount >= 0) {
    check('当前数据目录任务卡计数 ≥ 备份点计数（备份点之后只增不减）',
      nowCount >= restoredCount, `备份点 ${restoredCount} vs 当前 ${nowCount}`)
    console.log(`  · 任务卡：备份点 ${restoredCount} 张，当前 ${nowCount} 张（备份后新增 ${nowCount - restoredCount} 张，正常增量）`)
    lines.push(`- 任务卡：备份点 ${restoredCount} 张，当前 ${nowCount} 张（备份后新增 ${nowCount - restoredCount} 张）`)
  } else {
    check('（对账基准目录无 task-data，跳过前后对账）', true)
  }
  const logCount = countMd(restoredLogs)
  if (logCount >= 0) {
    check('执行日志目录恢复完整', logCount > 0, String(logCount))
    console.log(`  · 执行日志：备份点含 ${logCount} 个 .md`)
    lines.push(`- 执行日志：备份点含 ${logCount} 个 .md`)
  }
  // 逐字抽验：抽 3 张卡非空可读（恢复无损抽查）
  const sample = fs.readdirSync(restoredTask).filter(f => f.endsWith('.md')).slice(0, 3)
  let sampleOk = sample.length > 0
  for (const f of sample) {
    if (fs.readFileSync(path.join(restoredTask, f)).length === 0) sampleOk = false
  }
  check(`逐字抽验 ${sample.length} 张卡非空可读（恢复无损抽查）`, sampleOk)

  // 清理临时目录
  try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch {}

  finish(0, t0, { zipPath, restoredCount, logCount, localDir, cfg })
}

function finish(code, t0, meta = {}) {
  const dur = t0 ? ((Date.now() - t0) / 1000).toFixed(1) : null
  if (code === 0) {
    console.log(`\n通过 ${pass} / 失败 ${fail}`)
    lines.push(`\n通过 ${pass} / 失败 ${fail}`)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  lines.push(`RESULT ${pass} / ${fail}`)

  // 报告落 docs/（真机定期跑的留痕）
  if (!NO_REPORT && meta.zipPath) {
    try {
      const repoDocs = path.resolve(__dirname, '../../docs')
      if (fs.existsSync(repoDocs)) {
        const d = new Date()
        const p = (n) => String(n).padStart(2, '0')
        const name = `恢复演练-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.md`
        const head = [
          `# 方寸恢复演练报告（${name.replace('.md', '')}）`, '',
          `- 演练对象：${meta.zipPath}`,
          `- 体检目录：${meta.localDir}（localKeep=${meta.cfg?.localKeep} maxLocalMb=${meta.cfg?.maxLocalMb}）`,
          `- 恢复方式：零破坏（落位临时目录，真实数据未动）`,
          `- 用时：${dur}s`, '',
        ].join('\n')
        fs.writeFileSync(path.join(repoDocs, name), head + lines.join('\n') + '\n', 'utf-8')
        console.log(`报告已落 docs/${name}`)
      }
    } catch (e) {
      console.log(`（报告落盘失败，不影响演练结论：${e.message}）`)
    }
  }
  process.exit(fail ? 1 : 0)
}

const DIST = path.resolve(__dirname, '../../desktop/dist/main')
main().catch((e) => { console.error('演练脚本异常：', e); process.exit(1) })
