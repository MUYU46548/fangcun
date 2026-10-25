/**
 * 卡 004「同步可见：阶段 + 耗时」—— 纯逻辑与接线守卫（2026-10-25）。
 *
 * 暮雨原话：「Git 同步转圈依然很抽象，能不能搞个进度条或者额外的转圈动画？
 *           全世界那么多软件没见过这样整个按钮拿去旋转的，太傻了。」
 *
 * 这个文件只干两件事：
 *  ① 断言 `shared/syncPhase.ts` 的纯函数（喂**假秒数**，不用真等 15 秒去验"网络慢"那一档）
 *  ② 断言接线：主进程真的在每一步报阶段、渲染层真的用了那个阶段，而**不是按时间猜**
 *
 * ⚠ 反例怎么打（每条都做过）：把 `syncCapsuleText` 里的 `SLOW_AFTER_MS` 判据删掉 → ③ 组红；
 *   把 `gitBackup.ts` 里某一条 `onPhase?.()` 删掉 → ① 组按顺序断言红。
 */
const path = require('path')
const fs = require('fs')

const REPO = path.resolve(__dirname, '../..')
const {
  syncCapsuleText, syncDoneText, syncPhaseLabel, isSyncPhase,
  SYNC_PHASES, SLOW_AFTER_MS,
} = require(path.join(REPO, 'desktop/dist/shared/syncPhase.js'))

let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fails.push(name + (extra ? '  → ' + extra : '')); console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

// ── ① 阶段名：只出人话，不出英文枚举 ────────────────────────────────────
console.log('\n── ① 阶段名 ──')
check('合法阶段全部认得（六步）',
  SYNC_PHASES.length === 6 && SYNC_PHASES.every(p => isSyncPhase(p) && /[\u4e00-\u9fa5]/.test(syncPhaseLabel(p))),
  JSON.stringify(SYNC_PHASES.map(p => syncPhaseLabel(p))))
check('阶段名里没有英文/下划线（界面上不出现 `push` / `prepare`）',
  SYNC_PHASES.every(p => !/[a-zA-Z_]/.test(syncPhaseLabel(p))))
check('认不出的阶段 → 退回「同步」，不透传原字符串',
  syncPhaseLabel('whatever') === '同步' && syncPhaseLabel(undefined) === '同步'
  && syncPhaseLabel(null) === '同步' && syncPhaseLabel(42) === '同步')
check('`push` 的中文是「推送」，`prepare` 是「准备仓库」',
  syncPhaseLabel('push') === '推送' && syncPhaseLabel('prepare') === '准备仓库')

// ── ② 进行中：秒数真实、不编百分比 ──────────────────────────────────────
console.log('\n── ② 胶囊文字（进行中）──')
check('0 秒 → 「推送 0s」', syncCapsuleText('push', 0) === '推送 0s', syncCapsuleText('push', 0))
check('999ms 仍算 0s（向下取整，不夸大）', syncCapsuleText('push', 999) === '推送 0s', syncCapsuleText('push', 999))
check('3.4 秒 → 「推送 3s」', syncCapsuleText('push', 3400) === '推送 3s', syncCapsuleText('push', 3400))
check('14.9 秒还不加「网络慢」', syncCapsuleText('push', 14_900) === '推送 14s', syncCapsuleText('push', 14_900))
check('15 秒起补「网络慢」（阈值就是 SLOW_AFTER_MS）',
  syncCapsuleText('push', SLOW_AFTER_MS) === '推送 · 网络慢 15s', syncCapsuleText('push', SLOW_AFTER_MS))
check('61 秒 → 「推送 · 网络慢 61s」', syncCapsuleText('push', 61_200) === '推送 · 网络慢 61s', syncCapsuleText('push', 61_200))
check('★ 任何时刻都不出现百分号（编进度 = 假成功）',
  [0, 500, 3000, 15_000, 99_999].every(ms => syncCapsuleText('push', ms).indexOf('%') < 0))
check('★ 秒数不带小数（「3.4s」永远不出现）',
  [3400, 4999, 15_100].every(ms => !/\.\d/.test(syncCapsuleText('push', ms))))
check('认不出阶段时说的是「同步中 3s」，不硬编一个阶段',
  syncCapsuleText('', 3000) === '同步中 3s', syncCapsuleText('', 3000))
check('负数/NaN 不炸（当 0 秒处理）',
  syncCapsuleText('push', -5) === '推送 0s' && syncCapsuleText('push', NaN) === '推送 0s',
  syncCapsuleText('push', -5) + ' | ' + syncCapsuleText('push', NaN))

// ── ③ 结束态 ───────────────────────────────────────────────────────────
console.log('\n── ③ 结束态 ──')
check('成功 → 「已同步」', syncDoneText(true) === '已同步')
check('失败 → 「未同步」（不是「失败」二字 —— 说的是状态不是判决）', syncDoneText(false) === '未同步')

// ── ④ 主进程：真在每一步报阶段，且顺序与执行顺序一致 ──────────────────
console.log('\n── ④ 主进程接线 ──')
const gitBackup = fs.readFileSync(path.join(REPO, 'desktop/src/main/backup/gitBackup.ts'), 'utf8').replace(/\r\n/g, '\n')
const ipcSrc = fs.readFileSync(path.join(REPO, 'desktop/src/main/backup-ipc.ts'), 'utf8').replace(/\r\n/g, '\n')
const preloadSrc = fs.readFileSync(path.join(REPO, 'desktop/src/preload/index.ts'), 'utf8').replace(/\r\n/g, '\n')
const appSrc = fs.readFileSync(path.join(REPO, 'desktop/src/renderer/App.vue'), 'utf8').replace(/\r\n/g, '\n')

// 每一处 onPhase 调用的位置，按源码顺序
const phaseCalls = []
{
  const re = /onPhase\?\.\('([a-z]+)'\)/g
  let m
  while ((m = re.exec(gitBackup)) !== null) phaseCalls.push({ phase: m[1], at: m.index })
}
check('★ 六个阶段每个都真的报了（不是只报一个糊弄）',
  phaseCalls.length >= 6 && SYNC_PHASES.every(p => phaseCalls.some(c => c.phase === p)),
  JSON.stringify(phaseCalls.map(c => c.phase)))

// 顺序：prepare 在 scan 前、scan 在 mirror 前、commit 在 push 前
const at = (p) => { const c = phaseCalls.find(x => x.phase === p); return c ? c.at : -1 }
check('★ 阶段回调顺序 = 真实执行顺序（prepare → scan → mirror → commit → push）',
  at('prepare') > 0 && at('prepare') < at('scan') && at('scan') < at('mirror')
  && at('mirror') < at('commit') && at('commit') < at('push'),
  `prepare=${at('prepare')} scan=${at('scan')} mirror=${at('mirror')} commit=${at('commit')} push=${at('push')}`)

// 阶段必须落在真实动作旁边，不能挤一堆在函数开头（那就是"猜阶段"了）
check('★ `push` 阶段贴着 push 命令（不是提前报）', (() => {
  const i = at('push')
  if (i < 0) return false
  const after = gitBackup.slice(i, i + 200)
  return /runGit\(\['push'/.test(after)
})(), 'push 之后 200 字内没有 runGit([\'push\' …)')

check('`gitSyncData` 的 onPhase 是可选参数（旧调用点不用改）',
  /export async function gitSyncData\(\s*[\s\S]{0,400}?onPhase\?: \(phase: SyncPhase\) => void/.test(gitBackup))

// ── ⑤ IPC / preload 有一条真的阶段流 ───────────────────────────────────
console.log('\n── ⑤ 通道 ──')
check('★ backup:gitPush 把阶段send 回渲染层', /sender\?\.send\('sync:progress'/.test(ipcSrc))
check('  送阶段失败（窗口已关）不算失败（有 try/catch 兜住）',
  /try \{ event\?\.sender\?\.send\('sync:progress'[\s\S]{0,120}?catch/.test(ipcSrc))
check('★ preload 暴露 onSyncProgress 且**返回退订函数**',
  /onSyncProgress: \(cb[\s\S]{0,120}?=> \{[\s\S]{0,400}?return \(\) => ipcRenderer\.removeListener\('sync:progress'/.test(preloadSrc))

// ── ⑥ 渲染层：用主进程报的阶段，不按时间猜 ─────────────────────────────
console.log('\n── ⑥ 渲染层 ──')
check('★ 阶段来自订阅回调（`onSyncProgress(` 真被调用）', /\.onSyncProgress\(\(p/.test(appSrc))
check('★ 计时器只算**秒数**，不参与决定阶段（阶段只能由回调写）', (() => {
  // 计时器回调里若出现 syncPhase 赋值，说明阶段是按时间猜的
  const i = appSrc.indexOf('syncSecTimer = window.setInterval(')
  if (i < 0) return false
  const body = appSrc.slice(i, i + 200)
  return body.indexOf('syncPhase') < 0 && body.indexOf('syncElapsedMs') >= 0
})())
check('★ 收尾会退订（stopSyncTimers 里调用退订函数）',
  /function stopSyncTimers\(\)[\s\S]{0,300}?syncOffProgress\(\)/.test(appSrc))
check('★ 结束态 3 秒后回图标（不然按钮永远停在「已同步」）',
  /syncRevertTimer = window\.setTimeout\([\s\S]{0,300}?syncFinal\.value = null/.test(appSrc)
  && /3\d{3}|3000/.test(appSrc.slice(appSrc.indexOf('syncRevertTimer = window.setTimeout'), appSrc.indexOf('syncRevertTimer = window.setTimeout') + 400)))
check('★ 按钮模板里渲染的是 `syncCapsule`（不是写死的一句「同步中」）',
  /\{\{ syncCapsule \}\}/.test(appSrc))
check('★ 转的仍然只是**字符**（动画不挂在 button 本体上）',
  /\.ico\.syncing \.ico-glyph \{ animation: nav-spin/.test(appSrc)
  && !/\.ico\.syncing \{[^}]*animation/.test(appSrc))

// ── ⑦ 真跑一次（本地 bare 仓，不碰用户数据）────────────────────────────
// 源码里"有那六行"不等于**运行时真会调**。所以这里起一个临时数据根 + 临时 bare 仓，
// 让 git 真跑一遍，看阶段回调是不是真按 prepare → scan → mirror → commit → push 到达。
// ⚠ 用 FC_TEST_USERDATA + setDataDir 指到临时目录 —— **绝不碰仓库根那套真数据**。
async function realGitRun() {
  console.log('\n── ⑦ 真跑一次 git 同步（临时 bare 仓）──')
  const { execFileSync } = require('child_process')
  let gitOk = true
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitOk = false }
  if (!gitOk) {
    console.log('SKIP  没装 git —— 跳过真跑（不是失败；把 skip 原因打出来，免得被当成"测过了"）')
    return
  }
  const os = require('os')
  const Module = require('module')
  const STUB = path.join(REPO, 'scripts/test/electron-stub.cjs')
  const orig = Module._resolveFilename
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sync-'))
  try {
    // 最小数据根（**必须先于 setDataDir**：它要校验 registry.yaml / task-data）
    fs.mkdirSync(path.join(base, 'task-data'), { recursive: true })
    fs.writeFileSync(path.join(base, 'task-data', 'task-demo.md'),
      '---\nid: task-demo\n标题: 演示\n状态: 待办\n---\n正文\n', 'utf-8')
    fs.writeFileSync(path.join(base, 'registry.yaml'), 'projects: []\n', 'utf-8')
    process.env.FC_TEST_USERDATA = base
    Module._resolveFilename = function (r, ...a) { return r === 'electron' ? STUB : orig.call(this, r, ...a) }
    // eslint-disable-next-line
    const data = require(path.join(REPO, 'desktop/dist/main/data/index.js'))
    data.setDataDir(base)
    const bare = path.join(base, 'remote.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
    fs.writeFileSync(path.join(base, 'git-backup.json'),
      JSON.stringify({ remote: bare, branch: 'main', authorName: 't', authorEmail: 't@local' }), 'utf-8')
    // eslint-disable-next-line
    const gb = require(path.join(REPO, 'desktop/dist/main/backup/gitBackup.js'))
    const seen = []
    const r = await gb.gitSyncData((ph) => seen.push(ph))
    check('★★ 真跑一次同步是成功的（不是 fixture 自述）', r.ok === true, String(r.message).slice(0, 60))
    check('★★ 阶段回调**真的按执行顺序到达**：prepare → scan → mirror → commit → push',
      seen.join('>') === 'prepare>scan>mirror>commit>push', seen.join('>') || '(一个都没来)')
    check('★ 真跑里也带了文件数（不是空推）', (r.files || 0) > 0, 'files=' + r.files)
  } catch (e) {
    check('真跑同步没抛异常', false, (e && e.message) || String(e))
  } finally {
    Module._resolveFilename = orig
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }
}

;(async () => {
  await realGitRun()
  console.log('\n──────────────────────────────')
  if (fails.length) {
    console.log(`通过 ${pass} / 失败 ${fails.length}`)
    fails.forEach(f => console.log('  · ' + f))
    process.exit(1)
  }
  console.log(`RESULT ${pass} / 0  —— 卡 004 纯逻辑、接线与真跑全绿`)
})()
