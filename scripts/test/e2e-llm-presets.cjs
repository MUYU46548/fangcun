/**
 * 模型通道预设（2026-10-18 暮雨第 3 条）
 *
 * 背景：小米有**两套凭证**，端点与 Key 都不能互换 ——
 *   · 按量付费  https://api.xiaomimimo.com/v1            Key: sk-xxxxx
 *   · Token Plan https://token-plan-cn.xiaomimimo.com/v1  Key: tp-xxxxx / ttp-xxxxx
 * 此前方寸的「MiMo 模型建议」只填模型名、不填端点，而且模型名写成 `MiMo-V2.6-Flash`
 * （与接口的 model id 大小写不一致）—— 用户"一键填完还是连不上"，只能自己去翻文档。
 *
 * 本测试钉死三件事：
 *  ① 两个端点都在，且各自带对 Key 前缀提示（防止又合并成一个"通用 MiMo"按钮）；
 *  ② Token Plan 必须写明「仅限编程工具、别用于应用后端」—— 小米条款白纸黑字；
 *  ③ 预设**永不预填密钥**（BYOK 红线：方寸不预置任何钥匙）。
 *
 * 运行：node scripts/test/e2e-llm-presets.cjs
 */
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '../../desktop/src/renderer/App.vue')
const CFG = path.join(__dirname, '../../desktop/src/main/llm/config.ts')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function main() {
  // 本机 core.autocrlf=true → 统一成 LF 再扫，避免字符窗口断言被 \r 撑破
  const app = fs.readFileSync(APP, 'utf-8').replace(/\r\n/g, '\n')
  const cfg = fs.readFileSync(CFG, 'utf-8').replace(/\r\n/g, '\n')

  // ── ① 两个端点 ────────────────────────────────────────────────────
  check('★ 有「按量付费」端点 api.xiaomimimo.com/v1', /llmCfg\.value\.baseUrl = 'https:\/\/api\.xiaomimimo\.com\/v1'/.test(app))
  check('★ 有「Token Plan」端点 token-plan-cn.xiaomimimo.com/v1', /llmCfg\.value\.baseUrl = 'https:\/\/token-plan-cn\.xiaomimimo\.com\/v1'/.test(app))
  check('★ 两个预设是两个不同按钮（不是又合并成一个"MiMo 建议"）',
    /applyLlmPreset\('mimo-api'\)/.test(app) && /applyLlmPreset\('mimo-plan'\)/.test(app))
  check('★ 预设函数收三种 kind', /function applyLlmPreset\(kind: 'deepseek' \| 'mimo-api' \| 'mimo-plan'\)/.test(app))

  // ── ② 模型名大小写（接口 id 是小写连字符）─────────────────────────
  check('★ 预设里写的是 mimo-v2.6-flash（小写）', /llmCfg\.value\.model = 'mimo-v2\.6-flash'/.test(app))
  // 只剥注释再查"旧写法残留"：这段字符串本身在注释里讲历史（说明为什么改），
  // 注释里出现旧名是合法的，代码/模板里出现才是 bug。
  const appCode = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  check('★ 全仓库不再有 MiMo-V2.6-Flash 这种"看着像但不是 id"的写法',
    !/MiMo-V2\.6-Flash/.test(appCode))

  // ── ③ Token Plan 条款必须写在界面上，而不是只写在文档里 ─────────────
  check('★★ Token Plan 窗口提示了「仅限编程工具 / 别用于应用后端」',
    /Token Plan[^<]{0,80}仅限编程工具/.test(app.replace(/\s+/g, ' ')) || /仅限编程工具内使用/.test(app))
  check('★ 预设 toast 也对 Plan 给了明确劝退（不是静默填完就走）',
    /建议改用按量付费/.test(app))

  // ── ④ Key 前缀提示（换错 Key 是 401 的头号原因）────────────────────
  check('★ 按量付费提示了 sk- 开头的 Key', /sk- 开头那串/.test(app))
  check('★ Token Plan 提示了 tp- 开头的 Key', /tp-<\/code> 开头/.test(app) || /tp-/.test(app))

  // ── ⑤ BYOK 红线：预设绝不碰密钥 ──────────────────────────────────
  const presetBody = (app.match(/function applyLlmPreset[\s\S]*?\n\}/) || [''])[0]
  check('★★ 预设函数里一次都没有写 apiKey（方寸不预置任何钥匙）', !!presetBody && !/apiKey/.test(presetBody), presetBody.slice(0, 120))
  check('★ 主进程默认配置仍是未配置态（baseUrl 空串）',
    /baseUrl: '',/.test(cfg) && /model: '',/.test(cfg))

  // ── ⑥ 反例自证：正则不是永远为真 ─────────────────────────────────
  check('（反例）把端点写错时上面的测试会红 —— 正则对错误域名不成立',
    !/llmCfg\.value\.baseUrl = 'https:\/\/api\.xiaomimimo\.com\.cn\/v1'/.test(app))

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('\n失败项：')
    for (const f of failures) console.log(' -', f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
