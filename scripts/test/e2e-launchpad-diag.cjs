/**
 * 启动台登记 × 端口 自洽诊断 端到端（2026-10-15）
 *
 * 真跑编译产物 `desktop/dist/shared/launchpadDiag.js` —— 纯函数，不依赖 electron / DOM。
 *
 * 为什么单列这一层（旧案回顾）：
 *   `apps.json` 里「绒花墨坊」把 **vite dev server 的 8090** 登记在**打包好的 Electron exe** 上。
 *   服务页对「空闲 + 来源=启动台」的行给「▶ 启动」，用户点完仍是「空闲」→ 又一次得出"启动台坏了"。
 *   根因是**两个概念被混成一个**：`port`（对外提供哪个端口）≠ `cmd`（点一下会跑什么）。
 *
 * 本测试钉住：
 *   ① 判据认**机器码**（code），不认文案 —— 文案会改，码是契约；
 *   ② `.exe` + port → `suspect/exe-cmd`（**不是**断言它坏了，是"值得看一眼"）；
 *   ③ `.bat/.cmd/.ps1/目录/网址` + port → `ok`（不许误报 —— 误报比漏报更伤，见下反例）；
 *   ④ 没 port / port 非法 → `none`（不许把"没登记端口"也说成 suspect）；
 *   ⑤ 手填登记（没有启动命令）走 `none/manual`，不许对它喊"接错了"；
 *   ⑥ 「拉起成功但端口没起来」的那句话必须**同时**给出"发生了什么"和"下一步做什么"。
 *
 * 运行：node scripts/test/e2e-launchpad-diag.cjs
 */
const path = require('path')

const DIST = path.resolve(__dirname, '../../desktop/dist/shared/launchpadDiag.js')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function main() {
  console.log('== 启动台 × 端口 诊断纯函数 e2e ==')
  const mod = require(DIST)
  const { diagnosePortRegistration, describeLaunchCommand, explainStartObserved, baseNameOf, extOf } = mod

  check('导出四个面向（diagnose / describe / explain / 路径小工具）',
    typeof diagnosePortRegistration === 'function' && typeof describeLaunchCommand === 'function'
    && typeof explainStartObserved === 'function' && typeof baseNameOf === 'function' && typeof extOf === 'function')

  // ── ① 旧案本体：exe + port ─────────────────────────────────────────────
  const ronghua = {
    name: '绒花墨坊',
    port: 8090,
    cmd: 'E:\\Software\\RongHuaMoFang\\ronghuamofang-console\\绒花墨坊.exe',
    path: 'E:\\Software\\RongHuaMoFang\\ronghuamofang-console\\绒花墨坊.exe',
  }
  const d1 = diagnosePortRegistration(ronghua)
  check('★★ 旧案复现：exe + :8090 → suspect', d1.level === 'suspect', JSON.stringify(d1))
  check('★★ 判据认机器码 exe-cmd（不认文案）', d1.code === 'exe-cmd', d1.code)
  check('★ 文案里点出「桌面程序通常不会监听这个端口」这件事实',
    d1.message.includes('桌面程序') && d1.message.includes('8090'), d1.message)
  check('★ 文案给出两条可行动作（改命令 / 去掉端口登记）',
    d1.message.includes('启动命令') && d1.message.includes('去掉'), d1.message)
  check('★ 静态诊断不许下"它一定起不来"的断言（不能出现"失败"/"坏了"这类结论词）',
    !/失败|坏了|无法启动/.test(d1.message), d1.message)

  // ── ② 不许误报：脚本 / 目录 / 快捷方式 / 网址 ─────────────────────────
  const okCases = [
    ['批处理启动服务', { name: 'A', port: 3000, cmd: 'E:/x/start.bat' }, 'script-or-dir'],
    ['cmd 启动服务', { name: 'B', port: 3001, cmd: 'E:/x/run.cmd' }, 'script-or-dir'],
    ['powershell 启动服务', { name: 'C', port: 3002, cmd: 'E:/x/serve.ps1' }, 'script-or-dir'],
    ['python 脚本', { name: 'D', port: 3003, cmd: 'E:/x/nf_api.py' }, 'script-or-dir'],
    ['目录（shell 打开）', { name: 'E', port: 3004, cmd: 'E:/some/dir' }, 'script-or-dir'],
    ['快捷方式', { name: 'F', port: 3005, cmd: 'E:/x/app.lnk' }, 'script-or-dir'],
    ['网址（外部服务）', { name: 'G', port: 3006, cmd: 'http://127.0.0.1:3006/' }, 'url'],
  ]
  for (const [label, input, code] of okCases) {
    const d = diagnosePortRegistration(input)
    check(`★ 不误报：${label} → ok/${code}`, d.level === 'ok' && d.code === code, `${d.level}/${d.code}`)
  }

  // 反例（②）：把所有脚本类**都**当成 suspect 会怎样 —— 模拟"过度报警"，断言它必须不通过。
  // 这条本身就是"反例自证"：如果实现退回"只看 port 有值就当 suspect"，②组会当场变红。
  {
    const overAlarm = okCases.map(([, input]) => diagnosePortRegistration(input)).filter(d => d.level === 'suspect').length
    check('★ 反例自证：脚本类一个都不许被判 suspect（否则就是过度报警）', overAlarm === 0, `${overAlarm} 个被误报`)
  }

  // ── ③ 无端口 / 端口非法 → none ────────────────────────────────────────
  check('★ 没填 port → none/no-port', diagnosePortRegistration({ name: 'X', cmd: 'a.exe' }).code === 'no-port')
  check('★ port 非法（0）→ none', diagnosePortRegistration({ name: 'X', port: 0, cmd: 'a.exe' }).level === 'none')
  check('★ port 非法（99999）→ none', diagnosePortRegistration({ name: 'X', port: 99999, cmd: 'a.exe' }).level === 'none')
  check('★ null 输入 → none/no-app（不抛）', diagnosePortRegistration(null).code === 'no-app')

  // ── ④ 空启动命令 → suspect / no-cmd（登记了端口却没东西可拉） ─────────
  const d2 = diagnosePortRegistration({ name: 'Y', port: 4321, cmd: '', path: '' })
  check('★ 有 port 但没启动命令 → suspect/no-cmd', d2.level === 'suspect' && d2.code === 'no-cmd', JSON.stringify(d2))

  // ── ⑤ 未知扩展名 → suspect/unknown-ext ───────────────────────────────
  const d3 = diagnosePortRegistration({ name: 'Z', port: 5000, cmd: 'E:/x/thing.weird' })
  check('★ 认不出的启动形态 → suspect/unknown-ext', d3.level === 'suspect' && d3.code === 'unknown-ext', JSON.stringify(d3))

  // ── ⑥ path 兜底：cmd 空但 path 有值，要按 path 判 ────────────────────
  const d4 = diagnosePortRegistration({ name: 'P', port: 5001, cmd: '', path: 'E:/x/app.exe' })
  check('★ cmd 空时用 path 兜底（仍判 exe-cmd）', d4.code === 'exe-cmd', d4.code)

  // ── ⑦ describeLaunchCommand 说人话 ───────────────────────────────────
  check('★ 描述：.exe → 桌面程序 .exe', describeLaunchCommand('E:/a/b.exe') === '桌面程序 .exe')
  check('★ 描述：.bat → 脚本 .bat', describeLaunchCommand('E:/a/b.BAT') === '脚本 .bat')
  check('★ 描述：网址', describeLaunchCommand('https://x.y/z').includes('网址'))
  check('★ 描述：空 → 明说没填（不是空串）', describeLaunchCommand('').includes('没填启动命令'))
  check('★ 描述：无扩展名不是空串', describeLaunchCommand('E:/a/thing').length > 0)

  // ── ⑧ 路径小工具 ─────────────────────────────────────────────────────
  check('★ baseNameOf 认反斜杠', baseNameOf('E:\\a\\b\\c.exe') === 'c.exe')
  check('★ baseNameOf 认正斜杠', baseNameOf('E:/a/b/c.exe') === 'c.exe')
  check('★ extOf 小写化', extOf('E:/A/B.EXE') === '.exe')
  check('★★ extOf 不把 .gitignore 这种写成扩展名（点号开头不算）', extOf('E:/a/.gitignore') === '', extOf('E:/a/.gitignore'))

  // ── ⑨ 启动完之后跟用户说的话（2026-10-15 新模型：**措辞必须中性**）────────
  //   旧模型在这里说的是"这条登记接错了"——那是**错误的预设**（默认"启动一个应用就该有个端口起来"）。
  //   用户原话「端口永远是记不住的，不要指望根据端口去配置」，所以"没观测到端口"是正常结果。
  const msg0 = explainStartObserved('绒花墨坊', [])
  check('★ 没观测到端口时带应用名', msg0.includes('绒花墨坊'), msg0)
  check('★★ 没观测到端口**不许**说成失败 / 接错（旧模型的错误预设）——且要主动否认一次',
    !/接错|坏了|应当|应该/.test(msg0) && msg0.includes('不代表启动失败'), msg0)
  check('★ 那句话解释了"这属正常"（桌面程序大多不监听端口）', msg0.includes('不监听端口'), msg0)
  check('★ 那句话把用户指向"方寸自己扫出来的那段"（不用他记端口）',
    msg0.includes('未登记但在监听'), msg0)
  const msg1 = explainStartObserved('接口服务', [8765, 3000])
  check('★ 观测到端口时把端口列出来（升序、去重前先排序）',
    msg1.includes(':3000') && msg1.includes(':8765') && msg1.indexOf(':3000') < msg1.indexOf(':8765'), msg1)
  check('★ 观测到端口时也不再提"登记"这类要求', !/去登记|请填/.test(msg1), msg1)
  check('★ 这两句都会直接弹给用户看，不许夹 Markdown 标记（Vue 不解析，会原样显示 ** ）',
    !/\*\*|`/.test(msg0 + msg1), msg0 + ' || ' + msg1)
  check('★ 应用名为空时不崩、退回占位', explainStartObserved('', []).includes('这个应用'))

  // ── ⑩ 纯函数自查：不改传入对象 ───────────────────────────────────────
  {
    const input = { name: 'M', port: 7000, cmd: 'E:/x/m.exe' }
    const snapshot = JSON.stringify(input)
    diagnosePortRegistration(input)
    describeLaunchCommand(input.cmd)
    check('★ 纯函数不改传入对象', JSON.stringify(input) === snapshot)
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) { console.log('\n失败项：'); for (const f of failures) console.log(' -', f) }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
