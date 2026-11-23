#!/usr/bin/env node
/**
 * 开机自启窗口口径（2026-11-22）
 *
 * 事故：HKCU Run 里写的是 `"方寸.exe" --autostart`，用户一解锁却看到一个最大化的看板
 * 盖住整个桌面。根因：`mainWindow.maximize()` 会把尚未显示的窗口**显示出来**
 * （Electron 文档原文：show but not focus），把 `show: false` 抹掉了。
 *
 * 判据（本机可跑，不起 Electron）：
 *   ① `--autostart` → 隐藏启动，且**启动阶段不许有任何显示动作**；
 *   ② 正常启动 → 仍立刻最大化（既有行为不变）；
 *   ③ 启动项写出的参数与这里判断的参数**是同一个常量**（防两边各写一份字面量漂移）；
 *   ④ 源码里 `mainWindow.maximize()` 只剩两处：`bootPlan.maximizeNow` 分支
 *      与“首次 show”回调；出现第三处裸调用就红。
 *
 * 运行：node scripts/test/e2e-window-boot.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'windowBoot.js')
const INDEX = path.join(REPO, 'desktop', 'src', 'index.ts')
const AUTOSTART = path.join(REPO, 'desktop', 'src', 'main', 'services', 'autoStart.ts')

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
const { planWindowBoot, AUTOSTART_ARG } = require(ART)

console.log('== 开机自启 · 窗口口径 ==')

// ── ① 正常启动：仍最大化（不改既有手感）──────────────────────────────
const exe = 'E:\\Software\\fangcun-desktop\\方寸.exe'
const normal = planWindowBoot([exe], {})
check('正常启动：不隐藏', normal.hidden === false, JSON.stringify(normal))
check('正常启动：立刻最大化（既有行为）', normal.maximizeNow === true, JSON.stringify(normal))
check('正常启动：不需要“首次 show 再最大化”', normal.maximizeOnFirstShow === false, JSON.stringify(normal))

// ── ② 自启：只进托盘 ──────────────────────────────────────────────────
const argv = [exe, '--autostart']
const auto = planWindowBoot(argv, {})
check('★ 自启：窗口隐藏', auto.hidden === true, JSON.stringify(auto))
check('★ 自启：启动阶段**不**最大化（maximize 会把隐藏窗口显示出来）', auto.maximizeNow === false, JSON.stringify(auto))
check('自启：登记“首次 show 再最大化”', auto.maximizeOnFirstShow === true, JSON.stringify(auto))
check('自启：不改传入的 argv 数组', argv.length === 2 && argv[1] === '--autostart', JSON.stringify(argv))

// 参数可以在任意位置（启动项/快捷方式两种写法都认）
check('自启参数不在末位也认', planWindowBoot([exe, '--autostart', '--x'], {}).hidden === true)

// ── ③ e2e 隐藏窗口跑：同样不许显示 ───────────────────────────────────
const e2e = planWindowBoot([exe], { FC_E2E_RENDERER: '1' })
check('FC_E2E_RENDERER=1：隐藏', e2e.hidden === true, JSON.stringify(e2e))
check('FC_E2E_RENDERER=1：不立刻最大化', e2e.maximizeNow === false, JSON.stringify(e2e))

// ── ④ 参数真源：启动项写的和这里认的是同一个常量 ────────────────────
check("AUTOSTART_ARG 就是 '--autostart'", AUTOSTART_ARG === '--autostart', String(AUTOSTART_ARG))
check('AUTOSTART_ARG 能被 planWindowBoot 识别', planWindowBoot([exe, AUTOSTART_ARG], {}).hidden === true)

const autoSrc = fs.readFileSync(AUTOSTART, 'utf8')
check("autoStart.ts 从 shared/windowBoot 取常量（不再自己写一份字面量）",
  /import\s*\{\s*AUTOSTART_ARG\s*\}\s*from\s*'\.\.\/\.\.\/shared\/windowBoot'/.test(autoSrc))
check("autoStart.ts 里不再有字面量 '--autostart'（否则两边会各自漂移）",
  !/'--autostart'/.test(autoSrc))
check('setLoginItemSettings 真把参数写进启动项',
  /setLoginItemSettings\(\s*\{[^}]*args:\s*\[AUTOSTART_ARG\]/s.test(autoSrc))

// ── ⑤ 源码守卫：maximize 不许再出现裸调用 ────────────────────────────
const indexSrc = fs.readFileSync(INDEX, 'utf8')
check('index.ts 用 planWindowBoot 决定启动显示策略', /planWindowBoot\(process\.argv,\s*process\.env\)/.test(indexSrc))
check('index.ts 的 hidden 来自 bootPlan（不再是就地拼 argv）',
  /const\s+hidden\s*=\s*bootPlan\.hidden/.test(indexSrc))

const lines = indexSrc.split(/\r?\n/)
const bare = lines.filter((l) => /^\s{2}mainWindow\.maximize\(\)\s*$/.test(l))
check('index.ts 没有两格缩进的裸 mainWindow.maximize()（那就是自启弹窗的写法）',
  bare.length === 0, bare.join(' | '))

const hits = [...indexSrc.matchAll(/mainWindow\.maximize\(\)/g)]
check('mainWindow.maximize() 只出现在两处（正常启动 / 首次 show）', hits.length === 2, String(hits.length))
for (const [i, h] of hits.entries()) {
  const before = indexSrc.slice(Math.max(0, h.index - 400), h.index)
  const why = i === 0 ? before.includes('bootPlan.maximizeNow') : /once\('show'/.test(before)
  check(`第 ${i + 1} 处 maximize() 在受控分支里`, why)
}

console.log(`\nRESULT ${pass} / ${pass + fail}`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
