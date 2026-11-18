/**
 * 界面文案守卫（2026-10-06）
 *
 * 为什么要有它：这类缺陷**反复出现**，而且每次都是人脸肉发现的 ——
 *   · `App.vue` 在途一屏的空屏提示里写了 `**主进程还是旧代码**`
 *   · 设置页“看板归档”的说明里写了 `**不删文件**`
 *   · `mcpConnect.ts` 的 howTo 里写了 `**原样追加**` / `**不猜、不代写**`
 *   · `chat.ts` 的鉴权失败提示里写了 `` `Bearer ` `` / `` `***` ``
 * Vue 模板与 `{{ }}` 都**不解析 Markdown** —— 用户看到的是字面的星号和反引号。
 *
 * 判据（只认“最终会以纯文本渲染给用户看”的位置，避免误伤有意为之的 Markdown）：
 *   A. `App.vue` 的 `<template>` 段（剥掉 HTML 注释）里不得出现 `**`；
 *   B. **界面文案行**的字符串字面量里不得出现 `**`：
 *      howTo: / showToast( / message: ' / label: ' / hint: ' / placeholder="
 *      —— 这些位置是“技能页说明 / toast / 错误条 / 下拉项 / 提示语”，一律纯文本渲染。
 *   C. 同一批位置里的**单/双引号**字符串不得含反引号（Markdown 行内代码）。
 *
 * 明确**不查**（有意放 Markdown，是给 AI 读的，不是给界面渲染的）：
 *   · `logs.ts injectLog()` —— 拼给 agent 看的日志注入块；
 *   · `mcpConnect.ts buildSelfInstallPrompt()` —— 贴给目标 agent 的自装指令；
 *   · `tripBoard.ts` 契约模板 / `shared/arsenal.ts` 派工单 —— 复制出去落盘的 Markdown。
 *   它们都走 `parts.push(...)` / 数组字面量，不命中上面的行级特征，天然不在检查范围。
 *
 * 掩码白名单：内容形如 `***`（纯星号）的字符串是密钥掩码，不是 Markdown ——
 * 用“除最后一位全是 ASCII 可打印且首位非空白”近似判断，避免误报。
 *
 * 运行：node scripts/test/check-ui-copy.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const SRC = path.join(REPO, 'desktop', 'src')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

/** 剥掉 HTML 注释：按**原长度**换成空格，行号不漂 */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
}

/** 只扫源文件，跳过 node_modules / 编译产物 */
function walk(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * 黑话豁免（2026-11-17）。
 *
 * 登记规则与 `check-ui-freeze` 的 ALLOW 一致：**登记了必须逐条打印出来**，
 * SKIP 不是绿 —— 它只是"这条我有意放行，理由在下面"。
 *
 * 什么时候该登记：这个词在这个**具体位置**里是准确的人话，换掉反而更含混。
 *   · 例：架构图驳回理由的 placeholder「有一条线对不上」——
 *     指的是"图上画的连线与真实 import 不符"，读者一眼明白；
 *     换成"有一条连线不一致"也还是那个意思，而"对不上"在这里更直白。
 * 什么时候**不该**登记：只是因为改起来麻烦 → 那就去改。
 */
const JARGON_ALLOW = [
  {
    // ⚠ `rel(f)` 是相对 **REPO** 的（`desktop/src/renderer/…`），不是相对 `SRC`。
    //   第一版写成了 `renderer/...` → 豁免没命中 → 断言照样红。
    //   这就是"豁免表必须被验证真的生效"的理由：写错了它只会静静地不工作。
    file: 'desktop/src/renderer/components/ArchDiagram.vue',
    snippet: '有一条线对不上',
    why: '2026-11-17 · 架构图驳回理由的 placeholder：指的是"画的连线与真实 import 不符"，'
      + '在这个语境里"对不上"就是最直白的说法，换成术语反而更绕',
  },
  {
    file: 'desktop/src/renderer/components/settings/AgentSettings.vue',
    snippet: '账户口径',
    why: '2026-11-17 · 设置页余额说明里的「账户口径」是**该页已有的一个分区名**'
      + '（月报表 token 口径 vs 账户真钱口径），两边同名才认得出是同一件事；'
      + '单独把这一处改成"账户余额"会让两处对不上',
  },
]
const jAllowed = []

/**
 * 界面文案行：只查这几类位置。
 * ⚠ `placeholder=` 只在 .vue 属性里出现，命中 `placeholder="` 即可。
 */
const UI_LINE_RE = /(howTo\s*:|showToast\s*\(|\bmessage\s*:\s*['"`]|\blabel\s*:\s*['"`]|\bhint\s*:\s*['"`]|placeholder\s*=\s*")/
/** 含转义的字符串字面量（三种引号） */
const STR_RE = /(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g
/** 密钥掩码：内容全是星号（`***` / `****`） */
const PURE_MASK_RE = /^\*+$/

function rel(p) { return path.relative(REPO, p).replace(/\\/g, '/') }

/**
 * B/C 两类：逐行找界面文案行里的字符串
 *
 * ⚠ 2026-11-16 补一个**真空档**（暮雨「使用手册本身也难用得要死」那轮）：
 *   手册文案从 `views/HelpView.vue` 搬进了 `renderer/utils/userGuide.ts`（抄司天的单一事实源），
 *   而**数据文件不是 UI_LINE_RE 那种行**（它是 `v: '……'` 对象字面量）→ 整份新文案
 *   **一个字都不在守卫视野里**。实测后果：`**所有拍板权都在你这**` 原样印在界面上，
 *   守卫却 22/0 全绿 —— 这是"守卫存在"与"守卫有效"的差别。
 *
 * 判据：**数据型文案文件**里的字符串字面量一律当界面文案查（它最终就是印在屏幕上的）。
 */
const DATA_COPY_FILES = [
  path.join(SRC, 'renderer', 'utils', 'userGuide.ts'),
]

function scanDataCopyStrings(file) {
  const bold = []
  const tick = []
  const personal = []
  const lines = fs.readFileSync(file, 'utf-8').split('\n')
  lines.forEach((line, i) => {
    const t = line.trim()
    // 跳过纯注释行：注释里的 `**`/反引号是解释，用户看不到
    if (t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) return
    STR_RE.lastIndex = 0
    let m
    while ((m = STR_RE.exec(line))) {
      const quote = m[1]
      const body = m[2]
      if (PURE_MASK_RE.test(body)) continue
      if (body.includes('${')) continue
      if (body.includes('**')) bold.push(`${rel(file)}:${i + 1}  “${body.slice(0, 80)}”`)
      if (quote !== '`' && body.includes('`')) tick.push(`${rel(file)}:${i + 1}  “${body.slice(0, 80)}”`)
      if (body.includes('暮雨')) personal.push(`${rel(file)}:${i + 1}  “${body.slice(0, 80)}”`)
    }
  })
  return { bold, tick, personal }
}

function scanUiStrings(file) {
  const bold = []   // 含 ** 的
  const tick = []   // 单/双引号串里含反引号的
  const personal = [] // 含开发者个人名（方寸是公开发布的产品，界面只该说“用户”）
  const lines = fs.readFileSync(file, 'utf-8').split('\n')
  lines.forEach((line, i) => {
    if (!UI_LINE_RE.test(line)) return
    let m
    STR_RE.lastIndex = 0
    while ((m = STR_RE.exec(line))) {
      const quote = m[1]
      const body = m[2]
      if (PURE_MASK_RE.test(body)) continue          // `***` 掩码不是 Markdown
      // ⚠ 含 `${` 的一律放行：那说明这个"字符串"其实是一段**JS 表达式/模板字符串**
      //   （如 `:placeholder="x ? `已存：${h}` : '粘贴密钥'"`），里面的反引号是**模板字面量定界符**，
      //   不是 Markdown 行内代码，用户根本看不到它。
      //   2026-10-12 加：外部整包带到 App.vue:3084 就是这么一处，被这条守卫误判成"文案里漏进反引号"。
      //   ——修的是**守卫的误报**，不是让代码绕着守卫写（后者会把守卫变成为难人的规矩）。
      if (body.includes('${')) continue
      if (body.includes('**')) bold.push(`${rel(file)}:${i + 1}  “${body.slice(0, 80)}”`)
      if (quote !== '`' && body.includes('`')) tick.push(`${rel(file)}:${i + 1}  “${body.slice(0, 80)}”`)
      // 2026-10-30（暮雨第 2 条）：“方寸从来都是公开发布的”—— 界面文案不许出现开发者个人名。
      // 只在**界面文案行**里查；源码注释里保留出处没问题。
      if (body.includes('暮雨')) personal.push(`${rel(file)}:${i + 1}  “${body.slice(0, 80)}”`)
    }
  })
  return { bold, tick, personal }
}

function main() {
  console.log('== 界面文案守卫（Markdown 标记不得漏进界面）==')

  const files = walk(SRC)
  check('扫到源文件', files.length > 0, 'n=' + files.length + ' @ ' + rel(SRC))

  // ── A. App.vue 模板段 ────────────────────────────────────────────────
  const appVue = path.join(SRC, 'renderer', 'App.vue')
  let tplHits = []
  let tplLen = 0
  let tpl = ''
  if (fs.existsSync(appVue)) {
    const raw = fs.readFileSync(appVue, 'utf-8')
    const s = raw.indexOf('<template>')
    // ⚠ 必须取**最后一个**行首 `</template>`：模板内部还有 `<template v-if>` 的成对标签，
    //   用 indexOf 会切在第一个内部闭合标签上 —— 那样切片只剩一小段，**后面的模板根本不被检查**
    //   （首版就是这么写的，反例注入 `**` 竟然还是绿）。
    const e = raw.lastIndexOf('\n</template>')
    if (s >= 0 && e > s) {
      const lineOffset = raw.slice(0, s).split('\n').length - 1
      tpl = stripHtmlComments(raw.slice(s, e))
      tplLen = tpl.length
      tpl.split('\n').forEach((line, i) => {
        if (/\*\*/.test(line)) tplHits.push(`App.vue:${lineOffset + i + 1}  “${line.trim().slice(0, 100)}”`)
      })
    }
  }
  // 守卫自身有效性：切片若是空的/被截断的，下面那条断言会"永远绿" = 假绿
  check('模板区切片有效（长度合理，不是被内部闭合标签截断的空壳）',
    tplLen > 20000, 'len=' + tplLen)
  check('★ App.vue 模板区没有 Markdown 粗体标记（Vue 不解析 Markdown —— 用户会看到字面星号）',
    tplHits.length === 0, tplHits.join(' | '))
  check('★★ App.vue 模板区不许出现开发者个人名“暮雨”（公开发布的产品只说“用户”）',
    tplLen > 0 && !tpl.includes('暮雨'),
    (tpl.includes('暮雨') ? '模板里仍有“暮雨”' : ''))

  // ── B/C. 界面文案行里的字符串 ────────────────────────────────────────
  const boldHits = []
  const tickHits = []
  const personalHits = []
  for (const f of files) {
    const r = scanUiStrings(f)
    boldHits.push(...r.bold)
    tickHits.push(...r.tick)
    personalHits.push(...r.personal)
  }
  // ── D. 数据型文案文件（手册等）：整份字面量都算界面文案 ──────────────
  //    不扫这类 = 把文案挪进数据文件就能绕过守卫（2026-11-16 实测发生过）。
  let dataFiles = 0
  for (const f of DATA_COPY_FILES) {
    if (!fs.existsSync(f)) continue
    dataFiles++
    const r = scanDataCopyStrings(f)
    boldHits.push(...r.bold)
    tickHits.push(...r.tick)
    personalHits.push(...r.personal)
  }
  check('★ 数据型文案文件扫到了（搬家不许绕过守卫）', dataFiles === DATA_COPY_FILES.length,
    'hit=' + dataFiles + '/' + DATA_COPY_FILES.length)
  check('★ 界面文案（howTo / toast / 提示语）里没有 Markdown 粗体标记 `**`',
    boldHits.length === 0, boldHits.slice(0, 6).join(' | '))
  check('★ 界面文案的单引号字符串里没有反引号（Markdown 行内代码）',
    tickHits.length === 0, tickHits.slice(0, 6).join(' | '))
  check('★★ 界面文案里不许出现开发者个人名“暮雨”（改用“用户”）',
    personalHits.length === 0, personalHits.slice(0, 6).join(' | '))

  // ── E. 黑话词表（2026-11-17 · 卡 p0-1 第 5 条）──────────────────────
  //
  // 暮雨原话：「什么叫"对不上"？给我说中文！哪怕叫"状态提醒"都行，
  //            "对不上"在世界上几十亿人类中没有一个人能看懂。」
  //
  // 这条他提了**两次**（第一次修了界面那处，但**没有任何东西在守**，
  // 所以下一个 agent 顺手又能写回去）。这里补的就是"守"。
  //
  // 词表只收**真的会让人读不懂**的：不是所有技术词都收
  //   （`判据` `阻塞` 这些在方寸的语境里读者已经认了，硬禁会把守卫变成刁难人的规矩）。
  //
  // ⚠ 排除两类误伤：
  //   ① 注释（`//` / `<!--`）—— 注释里讨论"这个黑话不好"是解释，不是文案；
  //   ② 明确带上下文的（比如架构图里"有一条线对不上"，指图画错了，那是人话）——
  //      用 `UI_JARGON_ALLOW` 逐条登记，登记了必须打印出来（登记 ≠ 藏起来）。
  // ⚠ 词表**只收暮雨原文点名过的**，或者等价于"读者完全猜不出是什么"的。
  //
  //   第一版我还收了「口径」—— 结果一跑就红 6 条，全是余额说明与分层报告里
  //   「账户口径 / 分层口径来自…」。那些位置里「口径」指的是"按什么算法统计"，
  //   读者在**那一屏的上下文里**看得懂，硬改成"统计方式"反而更长更绕。
  //   → 词表收窄。**守卫不该变成刁难人的规矩**（本仓同一条教训吃过几次）。
  const JARGON = [
    { re: /对不上/, why: '「对不上」—— 暮雨原文：「在几十亿人类中没有一个人能看懂」；说清哪个数和什么不符，或干脆叫「状态提醒」' },
    { re: /不一致/, why: '「不一致」—— 说明白哪两样、差在哪' },
    { re: /异步/, why: '「异步」—— 用户视角是"要等一下"，写"正在处理/稍等"即可' },
    { re: /幂等/, why: '「幂等」—— 写"重复点也不会重复建"这种效果话' },
    { re: /落盘/, why: '「落盘」—— 写"保存到文件 / 存下来"' },
    { re: /静默/, why: '「静默」—— 写"没有任何提示"' },
  ]
  const jHits = []
  for (const f of files) {
    let raw = ''
    try { raw = fs.readFileSync(f, 'utf-8') } catch { continue }
    const isVue = f.endsWith('.vue')
    // 只取"会给用户看"的那两段：Vue 的 <template>；非 Vue 走 UI_LINE_RE（同 B/C）
    const regions = []
    if (isVue) {
      const s = raw.indexOf('<template>')
      const e = raw.lastIndexOf('\n</template>')
      if (s >= 0 && e > s) regions.push({ text: stripHtmlComments(raw.slice(s, e)), off: raw.slice(0, s).split('\n').length - 1 })
    }
    raw.split('\n').forEach((line, i) => {
      if (UI_LINE_RE.test(line)) regions.push({ text: line, off: i, oneLine: true })
    })
    for (const rg of regions) {
      const text = rg.oneLine ? String(rg.text) : rg.text
      text.split('\n').forEach((line, i) => {
        const t = line.trim()
        if (!t) return
        // 注释不算文案
        if (/^\/\//.test(t) || /^\*/.test(t) || /^\/\*/.test(t)) return
        for (const j of JARGON) {
          if (!j.re.test(t)) continue
          const at = `${rel(f)}:${rg.oneLine ? rg.off + 1 : rg.off + i + 1}`
          const allow = JARGON_ALLOW.find((a) => (a.file === rel(f) && t.includes(a.snippet || '\u0000')) || a.at === at)
          if (allow) {
            jAllowed.push(`${at}  “${t.slice(0, 70)}”  —— ${allow.why || ''}`)
            continue
          }
          jHits.push(`${at}  “${t.slice(0, 80)}”  —— ${j.why}`)
        }
      })
    }
  }
  for (const a of jAllowed) console.log('SKIP  ' + a)
  check('★★ 界面文案里没有"没一个人能看懂"的黑话（对不上 / 不一致 / 幂等 / 落盘 …）',
    jHits.length === 0, jHits.slice(0, 6).join(' | '))

  // 反例自证：词表本身得是活的（否则"零命中"可能只是正则写坏了）
  check('黑话词表自证：「对不上」在词表里抓得住',
    JARGON.some((j) => j.re.test('这两个数对不上')) && JARGON.some((j) => j.re.test('状态对不上')))
  check('黑话词表自证：正常文案不误伤',
    !JARGON.some((j) => j.re.test('这张卡还没写完')) && !JARGON.some((j) => j.re.test('点这里保存')))


  // ── 反例自证：剥注释逻辑本身是有效的（注释里的 ** 不该被算进来）──────
  const probe = stripHtmlComments('<!-- **这是注释** -->\n<b>**这是文案**</b>')
  check('剥注释逻辑有效（注释里的 ** 不算，正文里的算）',
    probe.split('\n')[0].includes('**') === false && probe.split('\n')[1].includes('**') === true)

  // ── D. 免责声明两个载体不许分叉（2026-11-15）────────────────────────
  // 为什么要有这一条：`disclaimer.ts` 的文件头写着「两者是同一件事的两种呈现，
  //   **改了要一起改**」—— 而这句话此前**没有任何东西在守**。11-15 加第 5 条
  //   「不作为决策担保」时如果有一次只改了 docs、忘了应用内那份，用户首启看到的
  //   就是旧条款，而版本号还是新的 —— 那正是"界面说假话"里最难被发现的一种：
  //   界面确实有免责声明，只是它不包含你刚承诺的那条。
  // 判据只钉**版本号一致 + 决策担保那几句两边都在**，不比对全文
  //   （应用内是摘要、docs 是十章正式文本，逐字对齐本来就不该强求）。
  {
    const dmTs = path.join(SRC, 'renderer', 'disclaimer.ts')
    const docMd = path.join(REPO, 'docs', '免责声明与用户协议.md')
    const tsSrc = fs.existsSync(dmTs) ? fs.readFileSync(dmTs, 'utf-8') : ''
    const mdSrc = fs.existsSync(docMd) ? fs.readFileSync(docMd, 'utf-8') : ''
    check('免责声明两个载体都在（disclaimer.ts + docs/免责声明与用户协议.md）',
      !!tsSrc && !!mdSrc, `ts=${!!tsSrc} md=${!!mdSrc}`)
    const tsVer = (tsSrc.match(/DISCLAIMER_VERSION\s*=\s*'([^']+)'/) || [])[1] || ''
    const mdVer = (mdSrc.match(/版本\s*\*\*v([\d.]+)/) || [])[1] || ''
    check('★★ 声明版本号两处一致（只改一处 = 用户看到旧条款却显示新版本）',
      !!tsVer && tsVer === mdVer, `ts=${tsVer || '?'} docs=${mdVer || '?'}`)
    // 决策担保那条：暮雨 2026-11-15 点名要的三句，两处都必须在
    const NEED = ['不作为决策担保依据', '不为', '决策负责', '100% 准确']
    for (const n of NEED) {
      check(`★★ 决策担保条款两处都在：含「${n}」`,
        tsSrc.includes(n) && mdSrc.includes(n),
        `ts=${tsSrc.includes(n)} docs=${mdSrc.includes(n)}`)
    }
    // 版本历史表要记这一笔（改条款不记账 = 后人不知道哪一版加的）。
    // ⚠ 不写死版本号：写死就得每次改声明时来改测试，那是最容易"顺手改成永远绿"的一处。
    //   判据是**当前版本号必须在版本历史表里有对应的一行**。
    const histRow = new RegExp('\\|\\s*v' + tsVer.replace(/\./g, '\\.') + '\\s*\\|')
    check(`★ docs 版本历史表里有 v${tsVer || '?'} 这一笔（当前版本必须能追到变更记录）`,
      !!tsVer && histRow.test(mdSrc), 'ver=' + (tsVer || '?'))
  }

  // ── E. 对外文本不许被自己的契约推翻（REV-011，2026-11-15）──────────────
  // 为什么单列：这不是"措辞好坏"，是**两份对外文本互相打脸**。
  // 现场：`免责声明` 第二章写「不是项目全周期管理平台」，而 `立项契约` REV-008（更晚、写了理由的
  // 裁决）把定位改成了「项目全周期管理」。对外文本里留一句被自己契约推翻的话，
  // 是可以被引用来说事的矛盾 —— 而它**骗过了所有人**，因为两份文件谁都不会去读另一份。
  //
  // 判据只钉两条硬事实（契约里有 REV-008 这句 + 声明里不许还写着旧口径），不评修辞。
  {
    const charter = path.join(REPO, '立项契约.md')
    const chSrc = fs.existsSync(charter) ? fs.readFileSync(charter, 'utf-8') : ''
    const dmSrc2 = (() => {
      const p2 = path.join(SRC, 'renderer', 'disclaimer.ts')
      return fs.existsSync(p2) ? fs.readFileSync(p2, 'utf-8') : ''
    })()
    const mdSrc2 = (() => {
      const p2 = path.join(REPO, 'docs', '免责声明与用户协议.md')
      return fs.existsSync(p2) ? fs.readFileSync(p2, 'utf-8') : ''
    })()
    // 前置：契约里确实有那条裁决（没有它就说明契约被改了，这条守卫要跟着改）
    check('★ 契约里有 REV-008（全周期改为受理）—— 这条守卫的前提',
      /REV-008/.test(chSrc) && /全周期/.test(chSrc))
    // 反例自证口径：旧句子必须**确实不存在**了
    check('★★ 声明里不再写「不是项目全周期管理平台」（旧口径已被 REV-008 推翻）',
      !/不是项目全周期管理平台/.test(mdSrc2) && !/不是项目全周期管理平台/.test(dmSrc2),
      'docs=' + /不是项目全周期管理平台/.test(mdSrc2) + ' ts=' + /不是项目全周期管理平台/.test(dmSrc2))
    check('★★ 声明第二章已改口为「是项目全周期管理」（两处载体都要有）',
      /是\*\*项目全周期管理/.test(mdSrc2) && /基础功能/.test(dmSrc2),
      'docs=' + /是\*\*项目全周期管理/.test(mdSrc2))
    // 未成年人：一句话档，**不许**滑向实名/年龄验证（那与"不收集任何个人信息"矛盾）。
    // ⚠ 判据不能是"全文不许出现'年龄验证'这四个字" —— 条款本身**必须**说清"我不做年龄验证"，
    //   否则读者以为没规定。真正的判据是：**规定性语句**里不许出现"要求/须/应做年龄验证"，
    //   且必须有一句显式的否定（"不做/不设"）。第一版写成全文禁词，被自己的说明句打红。
    check('★★ 有未成年人条款（未满 14 周岁须监护人同意）',
      /14\s*周岁/.test(mdSrc2) && /监护人/.test(mdSrc2))
    const nudityPositive = /(?:须|需|应当?|要求)\s*(?:上传证件|实名认证|完成年龄验证)/.test(mdSrc2)
    const nudityNegative = /(?:不做|不设|不要求)\s*(?:年龄验证|实名|监护人同意流程)/.test(mdSrc2)
    check('★★ 未成年人条款**明说不做**实名/年龄验证（与"不收集个人信息"一致）',
      nudityNegative && !nudityPositive,
      '明说不做=' + nudityNegative + ' 规定要做=' + nudityPositive)

    // 管辖地**不写**（2026-11-15 暮雨：「不写都行，真出事只会增加被网暴的风险，能不多写就不多写」）。
    // 为什么必须守：写管辖地是法律文本的**模板惯例**，下一个 agent 会"顺手补全"它 ——
    // 而补全的代价是把一个真实地点挂进一份会被成千上万人读的公开文本里，
    // 换来的法律确定性接近于零（协商不成时法院本来就按《民事诉讼法》定管辖）。
    //
    // ⚠ 判据第一版写错过（**装了旧条款它照样绿**）：我要求「人民法院」后面**紧跟**「管辖」，
    //   而真实句子是「有管辖权的人民法院」—— 词序一颠倒就不中。现在按**约定结构**抓：
    //   `提交…人民法院` / `由…人民法院管辖`。反例自证必须真装回旧条款并看到它变红，否则等于没守。
    const jurPatterns = [
      /提交[^。\n]{0,40}?人民法院/,          // 提交X人民法院（最常见写法）
      /由[^。\n]{0,24}?人民法院管辖/,        // 由X人民法院管辖
      /管辖地\s*[:：]\s*[^\n]{0,12}(市|区|县)/, // 填了具体城市
    ]
    const jurHit = jurPatterns.filter((re) => re.test(mdSrc2))
    check('★★ 声明不约定争议管辖法院（写了只有隐私成本，没有法律收益）',
      jurHit.length === 0,
      '命中=' + jurHit.length + ' 条；' + (mdSrc2.split('\n').find((l) => /人民法院/.test(l)) || '').slice(0, 80))
    check('★★ 契约里也记着"不约定"（防下一个人按模板补回去）',
      /管辖地[：:]\s*不约定/.test(chSrc))
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`RESULT ${pass} / ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
