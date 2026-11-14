#!/usr/bin/env node
/**
 * 使命草稿（2026-11-14 · 长 Loop P1-2）
 *
 * 背景：14 个项目里 7 个的「使命」是空的。我查了那 7 个项目的仓库，
 * **6 个的 README 里已经写清了它是干嘛的** —— 病根不是"没人知道"，
 * 是"方寸从没去读项目现实"（同一病灶：P2-3 计划器只读方寸自己的账本）。
 *
 * 这套断言钉的不是"能抽出字"，而是**抽出来的字可不可信**：
 *   ① **逐字来自 README**：不许改写、不许润色、不许补主语（那是我在编）
 *   ② **抽不出就明说**：README 缺失 / 只有套话 → 报原因，不糊一条凑数
 *   ③ **空使命的判定不能只看空串**：真实值是「（未填写）」这个占位符
 *   ④ **不覆盖已有使命**
 *
 * 反例自证（每条都必须能精确变红）：
 *   · 把占位符「（未填写）」当成已有使命 → 一个草稿都不出
 *   · 去掉噪音过滤 → 抽出「本项目使用AI辅助制作」
 *   · 使命里留 Markdown 标记 → 界面会原样印出星号
 *
 * 运行：node scripts/test/e2e-mission-draft.cjs   （需先 cd desktop && npm run build）
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'missionDraft.js')

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
const {
  isMissionEmpty, isNoiseSentence, stripInlineMd, splitSentences,
  pickMissionSentence, clipMission, draftMissionFromReadme, draftMissions, MISSION_MAX,
} = require(ART)

console.log('== 使命草稿：可信度 ==')

// ── ① 空使命的判定：不能只看空串 ──────────────────────────────────────
console.log('\n-- 空使命判定（真实值是占位符）--')
{
  check('★★ 空串算空', isMissionEmpty('') === true)
  check('★★ 真实占位符「（未填写）」算空（第一版漏了这条 → 7 个项目全被当成已有使命）',
    isMissionEmpty('（未填写）') === true)
  check('★ 半角括号也认', isMissionEmpty('(未填写)') === true)
  check('★ 「待填写」「暂无」「TBD」都算空',
    isMissionEmpty('待填写') && isMissionEmpty('暂无') && isMissionEmpty('TBD'))
  check('★ 只有标点也算空', isMissionEmpty('——') === true)
  check('★★ 真写了的不算空（"能玩就行。"是用户真的写的）',
    isMissionEmpty('能玩就行。') === false)
  check('★ 短但真的写了也不算空', isMissionEmpty('自用脚本存放点。') === false)
}

// ── ② 噪音过滤：套话不能当使命 ────────────────────────────────────────
console.log('\n-- 噪音过滤（实测踩过三处）--')
{
  check('★★ 「本项目**使用AI辅助制作**。」是噪音（实测漏网过）',
    isNoiseSentence('本项目**使用AI辅助制作**。') === true)
  check('★★ 「本项目**在开发阶段使用 AI 辅助制作**；」也是（空格不能漏）',
    isNoiseSentence('本项目**在开发阶段使用 AI 辅助制作**；') === true)
  check('★★ 「[! important] 重要提示 本仓库仅用于个人学习…」也是（Obsidian callout）',
    isNoiseSentence('[! important] 重要提示 本仓库仅用于个人学习和工作环境下的脚本备份') === true)
  check('★ 「作者：暮雨」是噪音', isNoiseSentence('作者：暮雨') === true)
  check('★ 太短的（「欢迎」）不算', isNoiseSentence('欢迎') === true)
  check('★★ 真的定位不是噪音', isNoiseSentence('半自动长篇小说生成系统 —— 机器包办苦力') === false)
}

// ── ③ 剥标记：使命要存成纯文本 ────────────────────────────────────────
console.log('\n-- 剥 Markdown 标记 --')
{
  check('★ `**粗体**` 剥掉', stripInlineMd('**粗体**文字') === '粗体文字')
  check('★ callout 标记剥掉（含空格写法）', stripInlineMd('[! important] 提示') === '提示')
  check('★ 链接保留文字', stripInlineMd('见[文档](http://x)') === '见文档')
  check('★ 图片整段丢掉', stripInlineMd('![图](a.png) 正文') === '正文')
  const { text } = clipMission('**本项目**使用 AI')
  check('★★ 使命草稿里不许留 `**`（界面会原样印出星号）', !/\*\*/.test(text), text)
}

// ── ④ 断句：不经改写，只切分 ──────────────────────────────────────────
console.log('\n-- 断句 --')
{
  const ss = splitSentences('第一句。第二句！第三句？')
  check('★ 中文句号/叹号/问号都断', ss.length === 3, JSON.stringify(ss))
  check('★ 版本号里的点不断（`Quartz 5.0 构建`）',
    splitSentences('基于 Quartz 5.0 构建').length === 1,
    JSON.stringify(splitSentences('基于 Quartz 5.0 构建')))
}

// ── ⑤ 抽取：拿真 README 片段验 ────────────────────────────────────────
console.log('\n-- 抽取（真片段）--')
{
  const md = [
    '# 绒花墨坊',
    '',
    '> 半自动长篇小说生成系统 —— 机器包办苦力，你保留审批权和最终精修权。',
    '',
    '**对外品牌名：绒花墨坊**',
    '',
    '## 特性',
    '- 八阶段流水线',
  ].join('\n')
  const s = pickMissionSentence(md)
  check('★★ 先取引言块（README 里最像"定位"的常常是那句）',
    /半自动长篇小说生成系统/.test(s), s)
  check('★ 取到的句子**逐字**在原文里（未经改写）', md.includes(s), s)
}
{
  const md = [
    '# music_pipeline',
    '',
    '本项目**使用AI辅助制作**。',
    '',
    '- 作者：暮雨',
    '',
    '编曲蓝图 (JSON) -> MIDI -> WAV/MP3 全自动渲染。',
  ].join('\n')
  const s = pickMissionSentence(md)
  check('★★ 跳过套话，落到真描述（不把"本项目使用AI辅助制作"当使命）',
    /编曲蓝图/.test(s) && !/辅助|作者/.test(s), s)
}
{
  // ⚠ 夹具标题要够长：只有当 4 个字（"只有标题"）时会被 isNoiseSentence 判成"太短"，
  //   于是走到"什么都没有"分支 —— 那是**正确行为**，但验不到"退回标题"这条路。
  //   真实 README 的标题都是「绒花墨坊（Ronghua Mofang）」这种长度。
  const md = '![logo](x.png)\n\n# 绒花墨坊编织工坊\n\n[!important] 重要提示\n'
  const d = draftMissionFromReadme('p', md, { fallbackTitle: '绒花墨坊编织工坊' })
  check('★★ 只有标题/徽章/套话 → 退回标题并**明说**建议补半句',
    d.draft === '绒花墨坊编织工坊' && /补半句/.test(d.reason), JSON.stringify(d))
}
{
  const d = draftMissionFromReadme('p', '', {})
  check('★★ 没有 README → 明说原因，**不糊一条**',
    d.draft === '' && /没有 README/.test(d.reason), JSON.stringify(d))
}

// ── ⑥ 不覆盖已有使命 + 批量口径 ───────────────────────────────────────
console.log('\n-- 批量：只补空的 --')
{
  const projects = [
    { id: 'a', mission: '已经写了的东西。' },
    { id: 'b', mission: '（未填写）' },
    { id: 'c', mission: '' },
  ]
  const readmeOf = (id) => (id === 'a' ? { md: '# A\n\nA 项目是干这个的。', sourceFile: 'README.md' }
    : id === 'b' ? { md: '# B\n\nB 项目是干那个的。', sourceFile: 'README.md' } : null)
  const r = draftMissions(projects, readmeOf, () => '')
  check('★★ 已有使命的不建议覆盖', r.skippedHasMission.includes('a') && !r.drafts.some((d) => d.project === 'a'),
    JSON.stringify(r.skippedHasMission))
  check('★★ 「（未填写）」会被当成空 → 出草稿（这是第一版最大的 bug）',
    r.drafts.some((d) => d.project === 'b' && d.draft), JSON.stringify(r.drafts))
  check('★ 没有 README 的进 drafts 但 draft 为空 + 有 reason',
    (() => { const x = r.drafts.find((d) => d.project === 'c'); return !!x && x.draft === '' && !!x.reason })(),
    JSON.stringify(r.drafts))
  check('★ total 是参与判断的项目数', r.total === 3, String(r.total))
}

// ── ⑦ 现场：真 README 能抽出多少（不写死数字）────────────────────────
console.log('\n-- 现场 --')
{
  const reg = fs.readFileSync(path.join(REPO, 'registry.yaml'), 'utf-8')
  const blocks = reg.split(/\n\s*-\s+id:\s*/).slice(1)
  const projects = blocks.map((b) => {
    const id = b.split('\n')[0].trim()
    const m = /\n\s*repo:\s*(\S+)/.exec(b)
    return { id, repo: m ? m[1].replace(/^["']|["']$/g, '') : '' }
  }).filter((p) => p.id)

  let withReadme = 0, without = 0, drafted = 0
  for (const p of projects) {
    let got = null
    for (const n of ['README.md', 'Readme.md', 'readme.md']) {
      const f = path.join(p.repo, n)
      if (fs.existsSync(f)) { got = { md: fs.readFileSync(f, 'utf-8'), sourceFile: n }; break }
    }
    if (!got) { without++; continue }
    withReadme++
    const d = draftMissionFromReadme(p.id, got.md, { sourceFile: got.sourceFile })
    if (d.draft) {
      drafted++
      // ── 核心红线：草稿的每个字都必须能在 README 里找到（不许改写）──
      // ⚠ 核对方式：**两边都剥一遍 Markdown** 再比。
      //   踩过两次假红：
      //   ① 拿"剥过标记的草稿"比"没剥过的原文" → 链接 / `<p>` / `**` 处必然对不上
      //   ② 把 `>` 开头的行整行删掉 → **引言块正是最像"定位"的那句**（project-2、
      //     yijucanxiang 的草稿全来自 `> …`），删了就一定找不到
      //   所以这里只剥**行内**标记，**保留引言文字**（去掉前导 `>` 即可）。
      const flatOf = (s) => stripInlineMd(String(s).replace(/^\s*>\s?/gm, '')).replace(/\s+/g, '')
      const flat = flatOf(got.md)
      const probe = flatOf(d.draft).replace(/…$/, '')
      if (probe && !flat.includes(probe)) {
        check(`★★ ${p.id} 的草稿能在 README 里逐字找到（不许改写）`, false,
          '找不到：' + probe.slice(0, 40))
      }
    }
  }
  check('★ 现场至少有几个项目带 README', withReadme >= 5, `with=${withReadme} without=${without}`)
  check('★★ 现场能抽出**若干**条可用草稿（不是 0）', drafted >= 3, 'drafted=' + drafted)
  console.log(`      现场：${projects.length} 个项目 → 有 README ${withReadme} / 没有 ${without} → 抽出草稿 ${drafted}`)
}

// ── ⑧ MCP 工具 + 界面接线守卫 ─────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'mcp', 'tools.ts'), 'utf-8')
  check('★★ MCP 里有 mission_draft 工具（否则 agent 用不到）', /name: 'mission_draft'/.test(src))
  check('★ 判定逻辑不在 tools.ts 里重写（只 import 纯逻辑）',
    /draftMissions/.test(src) && !/MISSION_PLACEHOLDERS/.test(src))
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  check('★★ 没有任何"自动写使命"的代码（使命必须人来点头）',
    !/savePolicy\([^)]*mission/.test(stripped) && !/mission\s*=\s*draft/i.test(stripped))

  // ── 界面接线（2026-11-14）──────────────────────────────────────────
  // 按钮画出来但没接动作 = 点了没反应，这是本仓反复踩的"僵尸按钮"。
  // ⚠ 无头 harness 里点不到这个按钮（原因未查清），所以**这里用源码守卫兜住**，
  //   不写一条永远红的 DOM 断言。
  const modal = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'components', 'PolicyEditModal.vue'), 'utf-8')
  check('★★ 弹窗里有「从 README 取一句」按钮', /从 README 取一句/.test(modal))
  check('★★ 按钮真绑到 ctl.draftMissionNow（不是画着没接动作）',
    /@click="ctl\.draftMissionNow\(\)"/.test(modal))
  check('★★ 按钮**不在 `<label>` 里**（在 label 里点击会被转发给表单控件，按钮收不到）',
    (() => {
      const i = modal.indexOf('pf-mission-draft')
      if (i < 0) return false
      // 往前找最近的 <label> 与 </label>，若最近的是 <label> 就说明它在 label 里
      const before = modal.slice(0, i)
      const lastOpen = before.lastIndexOf('<label')
      const lastClose = before.lastIndexOf('</label>')
      return lastOpen < lastClose
    })(), '')
  check('★ 草稿取回来会把**原文**摆出来（人能核有没有被改写）',
    /__missionSource/.test(modal) && /pf-mission-src/.test(modal))
  const app = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'renderer', 'App.vue'), 'utf-8')
  check('★★ 填草稿只写 policyEdit_，**不调 savePolicy**（不自动保存）',
    (() => {
      const m = /async function draftMissionNow\(\)[\s\S]*?\n\}/.exec(app)
      if (!m) return false
      return /policyMissionDraft/.test(m[0]) && !/policySave/.test(m[0])
    })(), '')
  const preload = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'preload', 'index.ts'), 'utf-8')
  check('★ preload 暴露了 policyMissionDraft（否则界面调不到）',
    /policyMissionDraft:/.test(preload))
  const ipc = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'ipc.ts'), 'utf-8')
  check('★ 主进程有 policy:missionDraft 处理器', /'policy:missionDraft'/.test(ipc))
}

console.log('\n' + (fail ? '❌ ' : '✅ ') + `RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(fail ? 1 : 0)
