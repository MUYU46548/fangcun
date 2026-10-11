#!/usr/bin/env node
/**
 * restic 脚本生成断言（2026-10-11，卡 `task-20261002-003` 备份多通道 · restic 支线）
 *
 * 真跑**编译产物** `dist/main/backup/resticScript.js`（纯逻辑，不要 electron、不起子进程 → 本机可跑）。
 *
 * 这条支线的判据不是"脚本能跑"（那要装了 restic 才知道），而是**三条红线有没有被守住**：
 *   ① 密码绝不写进脚本 —— 只教用户设环境变量；
 *   ② 密钥文件必须 exclude —— 否则"多一条备份通道"就变成"多一个密钥泄漏面"；
 *   ③ 不给可直接执行的定时任务 —— 只给脚本正文 + 怎么挂，装不装由用户定。
 *
 * 运行：node scripts/test/e2e-restic-script.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'main', 'backup', 'resticScript.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

if (!fs.existsSync(ART)) {
  console.log('FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ' + ART)
  console.log('RESULT 0 / 1')
  process.exit(1)
}
const { buildResticScript, resticExcludeArgs } = require(ART)

console.log('== restic 脚本生成 ==')

const SECRETS = ['llm-config.json', 'git-credentials.json', 'prefs.json']

// ── ① 空 / 坏输入不抛 ─────────────────────────────────────────────────
check('buildResticScript: 空对象不抛，且仍给得出脚本', (() => {
  try { return buildResticScript({}).length > 100 } catch { return false }
})())
check('buildResticScript: undefined 不抛（调用方漏传时不许炸）', (() => {
  try { return buildResticScript(undefined).length > 100 } catch { return false }
})())
check('★ 数据目录为空时给占位符，不产出半截路径（`restic backup ""` 会备份当前目录！）', (() => {
  const s = buildResticScript({ dataDir: '' })
  return s.indexOf('<你的方寸数据目录>') >= 0 && s.indexOf('restic backup ""') < 0
})())

// ── ② 红线一：密码绝不写进脚本 ────────────────────────────────────────
const win = buildResticScript({ dataDir: 'E:\\CODE\\CangKu\\fangcun', exclude: SECRETS, os: 'win' })
const nix = buildResticScript({ dataDir: '/srv/fangcun', exclude: SECRETS, os: 'posix' })
check('★ 红线①：脚本里**没有**任何 `RESTIC_PASSWORD=<值>` 的赋值，只教用户去设环境变量',
  win.indexOf('setx RESTIC_PASSWORD   "<你自己定的仓库密码>"') >= 0
  && !/RESTIC_PASSWORD\s*=\s*"[^<]/.test(win), 'win')
check('★ 红线①（posix）：同样只给 export 占位，不给真值',
  nix.indexOf('export RESTIC_PASSWORD="<你自己定的仓库密码>"') >= 0
  && !/RESTIC_PASSWORD="[^<]/.test(nix), 'posix')
check('★ 脚本会把「没设密码就退出」写成守卫（否则定时任务静默失败，没人知道备份没跑）',
  win.indexOf('if (-not $env:RESTIC_PASSWORD)') >= 0 && nix.indexOf('[ -n "${RESTIC_PASSWORD:-}" ]') >= 0)

// ── ③ 红线二：密钥文件必须 exclude ────────────────────────────────────
check('★ 红线②：传进来的每个密钥文件名都出现在 --exclude 里',
  SECRETS.every((s) => win.indexOf(`--exclude "${s}"`) >= 0), SECRETS.join(','))
check('★ 红线②（posix 版同样）',
  SECRETS.every((s) => nix.indexOf(`--exclude "${s}"`) >= 0))
// ⚠ 判据要盯**命令行参数**的形式（`--exclude "`），不能只查 `--exclude` 这个子串 ——
//   脚本的说明注释里本来就会写「--exclude 是红线」，只查子串会永远假红（首轮就踩了）。
check('  没传 exclude 时不编造 exclude 参数（宁可少写，也不假装排除了什么）',
  buildResticScript({ dataDir: '/x' }).indexOf('--exclude "') < 0)
check('  resticExcludeArgs：空 / null / undefined → 空数组（不抛）',
  resticExcludeArgs(null).length === 0 && resticExcludeArgs(undefined).length === 0
  && resticExcludeArgs([]).length === 0)
check('  resticExcludeArgs：正常输入每条带引号（路径有空格也不会被拆）',
  resticExcludeArgs(['a b.json']).join('') === '--exclude "a b.json"')

// ── ④ 数据目录 / 平台差异 ─────────────────────────────────────────────
check('★ 数据目录进脚本，且反斜杠被归一成正斜杠（restic 在 Windows 上更认这个）',
  win.indexOf('"E:/CODE/CangKu/fangcun"') >= 0 && win.indexOf('E:\\CODE') < 0)
check('★ win 版给 PowerShell 语法 + 任务计划程序；posix 版给 bash + crontab（不串味）',
  win.indexOf('$ErrorActionPreference') >= 0 && win.indexOf('任务计划程序') >= 0
  && nix.indexOf('#!/usr/bin/env bash') >= 0 && win.indexOf('#!/usr/bin/env bash') < 0
  && nix.indexOf('crontab') >= 0 && win.indexOf('crontab') < 0)
check('  目录不存在 / 没设密码 → 脚本自己会报错退出（不是跑到一半静默失败）',
  win.indexOf('Test-Path $src') >= 0 && nix.indexOf('[ -d "$src" ]') >= 0)

// ── ⑤ 保留策略 + prune ────────────────────────────────────────────────
check('★ 带保留策略（日 7 / 周 4 / 月 6）', win.indexOf('--keep-daily 7') >= 0
  && win.indexOf('--keep-weekly 4') >= 0 && win.indexOf('--keep-monthly 6') >= 0)
check('★ 带 --prune（只 forget 不回收空间 = 磁盘照样撑爆，这是常见误用）',
  win.indexOf('--prune') >= 0)

// ── ⑥ 红线三：不给可直接执行的定时任务 ────────────────────────────────
check('★ 红线③：说明里给的是「怎么挂」而不是替用户注册任务（装不装由用户定）',
  win.indexOf('#   任务计划程序') >= 0 && win.indexOf('schtasks') < 0
  && win.indexOf('Register-ScheduledTask') < 0)

// ── ⑦ 纯函数 ─────────────────────────────────────────────────────────
const before = JSON.stringify(SECRETS)
buildResticScript({ dataDir: '/x', exclude: SECRETS })
check('★ 纯函数：算完不改传入的数组（可被反复调用）', JSON.stringify(SECRETS) === before)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
console.log(`RESULT ${pass} / ${fail}`)
process.exit(fail ? 1 : 0)
