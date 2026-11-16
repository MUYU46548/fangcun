/**
 * 分层 spec 派工包 · 守卫（2026-11-16 · REV-013 ⑤）
 *
 * 暮雨 2026-11-16：
 *   「spec 走 agent 派工，这现在已经是唯一手段了。」
 *   与原话「方寸直调模型又贵又没用」+ REV-009「不得把单次调用包装成智能」一起看，
 *   这条链路（方寸出上下文包 → 外部 agent 干 → 产出落卡等人签字）就是**唯一**路径。
 *
 * 所以这套断言钉的不是"能不能生成"，而是**这份包交给一个没上下文的 agent，它能不能干活**：
 *
 *   ① **事实必须已经算好**：行数/文件数在包里，agent 不用自己去扫
 *      （否则每个 agent 都要重踩那五个假数坑：浏览器 profile / 打包产物 /
 *        内嵌运行时 / `.ts` 视频分片 / GBK 脚本）
 *   ② **自我描述必须在**：项目自己的 AGENTS.md 原文（"它说自己是什么"）
 *   ③ **产出格式必须给死**：不能只说"写个 spec"，要给出可以照抄的 JSON 形状
 *   ④ **推不出来要允许**：硬约束里必须有"推不出来就说推不出来，不要硬凑"
 *      —— 硬凑的 spec 比没有更糟，方寸会拿它算假结论
 *   ⑤ **边界必须写死**：项目仓库只读、不许打包、不许 git
 *   ⑥ **零模型调用**：这个脚本自己不许调任何 LLM（REV-013 ⑤）
 *
 * 跑法：node scripts/test/e2e-layer-dispatch.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'layer-spec-dispatch.py')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function run(args) {
  return execFileSync('python', [SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    timeout: 300000,
  })
}

function main() {
  // ══ 一、给真项目出一份，逐节检查 ══
  console.log('=== 一、派工包内容（交给没上下文的 agent 能不能干活） ===')
  const text = run(['sitian'])

  check('★ 有「任务目标」且点名了那句核心问题',
    text.includes('## 1 任务目标') && text.includes('号称是 A'), '')
  check('★ 有「工作目录 / 范围」，且写明项目仓库**只读**',
    text.includes('## 2 工作目录') && /只读项目仓库/.test(text), '')
  check('★ 唯一允许写入的落点是方寸数据目录（不是项目仓库）',
    text.includes('task-data/layer-specs/'), '')
  check('★ 明确禁止改代码 / 改文档 / git',
    /不许改代码/.test(text) && /git 操作/.test(text), '')

  // ① 事实必须已经算好 —— 这是"方寸出上下文包"的全部意义
  check('★★ 已算好的事实在包里（产品行数）', /产品\s*[\d,]+\s*行/.test(text),
    (text.match(/产品\s*[\d,]+\s*行/) || [''])[0])
  check('★★ 目录层表在包里（层 / 角色 / 文件数 / 行数 四列）',
    text.includes('| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |'), '')
  check('★ 口径声明在包里（二进制不算 / GBK 是文本）—— 让 agent 不用重踩',
    /二进制不算/.test(text) && /GBK/.test(text), '')
  check('★ 被排除的目录逐条列出来（方寸改过分母，得让 agent 知道）',
    /被规则挡在分母外面的/.test(text) && /node_modules|\.git/.test(text), '')

  // ② 项目自我描述
  check('★★ 骨架原文在包里（AGENTS.md 的正文，不只是路径）',
    text.includes('## 4 项目自己怎么说自己') && text.includes('```markdown'), '')
  check('★ 骨架被截断时明说截断（不假装给了全文）',
    /只带前 \d+ 字|全文/.test(text), '')

  // ③ 产出格式给死
  check('★★ 给了可以照抄的 JSON 形状（layers / groups / claims）',
    text.includes('## 7 产出格式') && /"layers"/.test(text) && /"groups"/.test(text), '')
  check('★ 字段说明里写清「至少 2 层才算分层」',
    /至少 2 层/.test(text), '')

  // ④ 允许"推不出来" —— 这条最容易被忽略，而硬凑的 spec 比没有更糟
  check('★★ 硬约束里有「推不出来就说推不出来，不要硬凑」',
    /推不出来就说推不出来/.test(text) && /硬凑/.test(text), '')
  check('★★ 说明了为什么硬凑更糟（方寸会拿它算假结论）',
    /假结论/.test(text), '')
  check('★ 硬约束里有「不许编路径」+ 要求自验存在性',
    /不许编路径/.test(text) && /真的匹配到文件/.test(text), '')
  check('★ 要求结论区分「实测」与「判断」（路径存在是实测）',
    /实测/.test(text) && /推测|判断/.test(text), '')

  // ⑤ 交付要求
  check('★ 交付一节要求回报四件事（分层 / 依据 / 实测 / 有没有 groups）',
    text.includes('## 9 交付') && /依据是哪个文档/.test(text), '')
  check('★ 明确「不要打包、不要提交 git、不要改任何项目文件」',
    /不要打包/.test(text), '')

  // ══ 二、有 spec 的项目必须带出现有 spec（让人改而不是重写） ══
  console.log('\n=== 二、改而不重写 ===')
  const hasSpec = fs.existsSync(path.join(ROOT, 'task-data', 'layer-specs', 'sitian.json'))
  if (hasSpec) {
    check('★★ 已有 spec 的项目，包里带上现有 spec 并写明「在这份上改」',
      text.includes('请在这份上改') && text.includes('"groups"'), '')
  } else {
    console.log('SKIP  本机没有司天 spec，这一节不跑')
  }

  // 没有 spec 的项目要说"还没有"，而且**标题也要跟着变** —— 否则 agent 会去找一份不存在的东西
  const noSpecId = ['dsh-fangcun', 'sitian', 'quartz', 'fangcun-base']
    .find((id) => !fs.existsSync(path.join(ROOT, 'task-data', 'layer-specs', id + '.json')))
  if (noSpecId) {
    const pack = run([noSpecId])
    check('★ 没有 spec 的项目：标题明说「还没有 spec」',
      /这个项目还没有 spec/.test(pack), '')
    check('★ 同一份包里**不许**出现「请在这份上改」（标题与正文自相矛盾的形状）',
      !/请在这份上改/.test(pack), '')
  } else {
    console.log('SKIP  本机这 4 个项目都有 spec，检查不了"没有 spec"那条')
  }

  // ══ 三、缺什么就说缺什么 ══
  console.log('\n=== 三、边界：不该派的不派 ===')
  {
    let out = ''
    let code = 0
    try {
      out = execFileSync('python', [SCRIPT, '__没有这个项目__'], {
        cwd: ROOT, encoding: 'utf-8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
    } catch (e) {
      code = e.status
      out = String(e.stdout || '')
    }
    check('★ 不认识的项目 → 非零退出 + 明说原因（不产一份空包）',
      code !== 0 && /没有项目/.test(out), `code=${code} out=${out.slice(0, 80)}`)
  }

  // ══ 四、REV-013 ⑤：这条路必须零模型调用 ══
  console.log('\n=== 四、零模型调用（REV-013 ⑤ 唯一现行智能路径） ===')
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'layer-spec-dispatch.py'), 'utf-8')
      .split('\n').filter((l) => {
        const t = l.trim()
        return !t.startsWith('#') && !t.startsWith('"""') && !t.startsWith('*')
      }).join('\n')
    // 派工包是"方寸出上下文包"那一环，它自己不许调模型
    for (const bad of ['openai', 'chat/completions', 'api.openai', 'requests.post', 'urllib.request',
      'anthropic', 'llm.chat', 'chatWithFallback']) {
      check(`派工包脚本里没有 ${bad}（方寸只出上下文包，不调模型）`,
        !src.toLowerCase().includes(bad.toLowerCase()))
    }
    check('★ 派工包是**纯文本拼接**（没有网络依赖）',
      !/import requests|import httpx|from urllib/.test(src))
  }

  // ══ 五、全项目批量：都出得来，且都不写项目仓库 ══
  console.log('\n=== 五、批量（--all 不许炸） ===')
  {
    const outdir = path.join(ROOT, 'docs', '_dispatch_probe')
    try {
      run(['--all', '--outdir', outdir])
      const n = fs.readdirSync(outdir).filter((f) => f.endsWith('.md')).length
      check('★ --all 能给多个项目各出一份', n >= 5, `出了 ${n} 份`)
      // 抽查一份：不许出现"让你自己去数行数"这种把活推回给 agent 的句子
      const one = fs.readFileSync(path.join(outdir, 'sitian.md'), 'utf-8')
      check('★★ 包里不许让 agent "自己数行数"（事实方寸已经算好）',
        !/你自己数|自行扫描统计行数/.test(one), '')
    } finally {
      try { fs.rmSync(outdir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main()
