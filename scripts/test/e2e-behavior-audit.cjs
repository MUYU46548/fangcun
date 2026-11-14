#!/usr/bin/env node
/**
 * 行为审计（2026-11-14 · 卡「拷问 AI」把 AI 本该自己做却没做变成开工前的硬判据）
 *
 * 这套断言钉的不是"能跑"，而是**它到底审的是什么**：
 *   ① 只审计「说的 vs 做的」是否一致 —— 不审计质量（质量裁决会死循环）
 *   ② **不许假装能验文件读取**：file:* 发生在 client 侧，MCP 看不见，
 *      把它判成"没读"是冤枉、判成"读了"是假账。只有 task:* 有客观记录。
 *   ③ 反过来，"声称读了但两边都对不上"必须被抓出来 —— 这是最硬、也最值钱的一条
 *   ④ 声明/自报要落在**原文**（旁路 jsonl），不许写进任务卡
 *
 * 反例自证（每条都必须能精确变红）：
 *   · 把 claimed-not-read 判成 ok → 红
 *   · 把没声明的也当合格 → 红
 *   · 让 file:* 参与"未读"判定 → 红
 *
 * 运行：node scripts/test/e2e-behavior-audit.cjs   （需先 cd desktop && npm run build）
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const REPO = path.resolve(__dirname, '../..')
const ART = path.join(REPO, 'desktop', 'dist', 'shared', 'behaviorAudit.js')
const STORE = path.join(REPO, 'desktop', 'dist', 'main', 'services', 'behaviorAuditStore.js')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else {
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`)
    console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

for (const [p, label] of [[ART, 'behaviorAudit.js'], [STORE, 'behaviorAuditStore.js']]) {
  if (!fs.existsSync(p)) {
    console.log(`FAIL  编译产物存在（先跑 cd desktop && npm run build）  → ${label}`)
    console.log('RESULT 0 / 1')
    process.exit(1)
  }
}
const {
  auditRound, auditKey, observedFromReadStats, auditReportText,
} = require(ART)

const ref = (kind, id) => ({ kind, id })

console.log('== 行为审计：只审"说的和做的是否一致" ==')

// ── ① 没声明 → 不判定，也不逐条报不合格 ────────────────────────────────
{
  const r = auditRound(null, { did: [ref('task', 't1')] }, [ref('task', 't1')])
  check('★ 没有开工声明时不判定（不把"没走审计"演成几十条不合格）',
    r.declared === false && r.rows.length === 0, JSON.stringify(r.counts))
  check('★ 且话术说清"补一份声明再来核"（给了下一步，不是干瞪眼）',
    /补一份声明/.test(r.summary), r.summary)
}
{
  const r = auditRound({ ts: 'x', plan: [] }, { did: [ref('task', 't1')] }, [])
  check('★ 声明是空数组 = 也没声明（空声明不算通过）',
    r.declared === false, JSON.stringify(r))
}

// ── ② 声明了也做了 → 没有问题 ─────────────────────────────────────────
{
  const r = auditRound(
    { ts: 'x', plan: [ref('task', 't1'), ref('file', 'docs/a.md')] },
    { did: [ref('task', 't1'), ref('file', 'docs/a.md')] },
    [ref('task', 't1')],
  )
  check('★★ 声明了、也做了 → 无问题（且 summary 为空串，不写"全部合格"这种废话）',
    r.declared === true && r.rows.length === 0 && r.summary === '', r.summary)
}

// ── ③ 最硬的一条：声称读了，但两边都对不上 ────────────────────────────
{
  const r = auditRound(
    { ts: 'x', plan: [ref('task', 't1')] },
    { did: [ref('task', 't1'), ref('task', '幽灵卡')] },
    [ref('task', 't1')],
  )
  const bad = r.rows.filter((x) => x.verdict === 'claimed-not-read')
  check('★★ 声称读了、但不在声明里也没被观测到 → claimed-not-read（嘴上说读了）',
    bad.length === 1 && bad[0].ref.id === '幽灵卡', JSON.stringify(r.rows))
  check('★★ 反例自证：若这条被判成 ok，就抓不住"假读"（本仓最需要的那种）',
    r.rows.length > 0 && r.counts['claimed-not-read'] === 1, JSON.stringify(r.counts))
}

// ── ④ 声明了却没做，也没解释 ──────────────────────────────────────────
{
  const r = auditRound(
    { ts: 'x', plan: [ref('task', 't1'), ref('task', 't2')] },
    { did: [ref('task', 't1')] },
    [ref('task', 't1')],
  )
  const bad = r.rows.filter((x) => x.verdict === 'declared-not-done')
  check('★★ 声明了没做也没解释 → declared-not-done（空头支票）',
    bad.length === 1 && bad[0].ref.id === 't2', JSON.stringify(r.rows))
}
{
  // 但在自报里认领了，就不算"没做" —— 自报是"我做了但没走 MCP"的合法出口
  const r = auditRound(
    { ts: 'x', plan: [ref('file', 'docs/a.md')] },
    { did: [ref('file', 'docs/a.md')] },
    [],
  )
  check('★ 文件类：声明了、自报做了 → 不算没做（MCP 看不见文件读取，不能赖它）',
    r.rows.length === 0, JSON.stringify(r.rows))
}

// ── ⑤ 越界：动了声明范围外的东西 ──────────────────────────────────────
{
  const r = auditRound(
    { ts: 'x', plan: [ref('task', 't1')] },
    { did: [ref('task', 't1')] },
    [ref('task', 't1'), ref('task', 't9')],
  )
  const bad = r.rows.filter((x) => x.verdict === 'undeclared')
  check('★★ 动了声明范围外的东西 → undeclared（开工前没说要做这个）',
    bad.length === 1 && bad[0].ref.id === 't9', JSON.stringify(r.rows))
}

// ── ⑥ 口径红线：file:* 不许参与"未读"判定 ────────────────────────────
{
  const stats = new Map([['t1', { reads: 3 }]])
  const obs = observedFromReadStats(stats, ['t1', 'docs/a.md'])
  check('★★ 客观观测只认 task：files 不会被算成"观测到读过"（MCP 看不见 client 侧读取）',
    obs.length === 1 && obs[0].kind === 'task' && obs[0].id === 't1',
    JSON.stringify(obs))
}
{
  // 只声明文件、MCP 侧零观测 → 也不能判成"没读"（自报认领了就算）
  const r = auditRound(
    { ts: 'x', plan: [ref('file', 'settings.md')] },
    { did: [ref('file', 'settings.md')] },
    [],
  )
  check('★★ 反例自证：若让 file:* 参与"未读"判定，这条会变成未读 —— 那是冤枉',
    r.rows.length === 0, JSON.stringify(r.rows))
}

// ── ⑦ 键归一：./a/b 与 a/b、反斜杠、大小写 kind ────────────────────────
{
  check('★ 键归一：`./docs/a.md` 与 `docs/a.md` 视为同一项',
    auditKey(ref('file', './docs/a.md')) === auditKey(ref('file', 'docs/a.md')))
  check('★ 键归一：反斜杠与正斜杠等价（Windows 上两种都有人写）',
    auditKey(ref('file', 'docs\\a.md')) === auditKey(ref('file', 'docs/a.md')))
  check('★ 键归一：kind 大小写不敏感',
    auditKey(ref('TASK', 't1')) === auditKey(ref('task', 't1')))
}
{
  const r = auditRound(
    { ts: 'x', plan: [ref('file', 'docs/a.md')] },
    { did: [ref('file', './docs/a.md')] },
    [],
  )
  check('★★ 归一真的生效：声明 `docs/a.md`、自报 `./docs/a.md` → 不报没做',
    r.rows.length === 0, JSON.stringify(r.rows))
}

// ── ⑧ 三类问题能同时报出来（不是只报第一类就停） ──────────────────────
{
  const r = auditRound(
    { ts: 'x', plan: [ref('task', 'a'), ref('task', 'b')] },
    { did: [ref('task', 'a'), ref('task', 'c')] },
    [ref('task', 'a'), ref('task', 'z')],
  )
  check('★★ 三类同时存在时都要报（不能只报第一类就 return）',
    r.counts['claimed-not-read'] === 1 && r.counts['declared-not-done'] === 1 && r.counts.undeclared === 1,
    JSON.stringify(r.counts))
  check('★ summary 一句话把三类都点出来（人能直接看懂差在哪）',
    /声称读了但无痕迹/.test(r.summary) && /声明了没做/.test(r.summary) && /越界动手/.test(r.summary),
    r.summary)
}

// ── ⑨ 纯函数纪律：不改传入数组 ────────────────────────────────────────
{
  const plan = [ref('task', 'a'), ref('task', 'b')]
  const did = [ref('task', 'a')]
  const before = JSON.stringify([plan, did])
  auditRound({ ts: 'x', plan }, { did }, [ref('task', 'a')])
  check('★ 不改传入数组（逐字节断言）', JSON.stringify([plan, did]) === before)
}

// ── ⑩ 持久层：声明/自报落旁路 jsonl，不写任务卡 ────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-audit-'))
  // ⚠ setDataDir 会校验目标目录必须像数据根（有 registry.yaml 或 task-data）——
  //   空临时目录会被直接拒（它防的是"指错目录把数据写飞"）。所以先造出最小数据根。
  fs.mkdirSync(path.join(tmp, 'task-data'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'registry.yaml'), 'projects: []\n', 'utf-8')
  const dataMod = require(path.join(REPO, 'desktop', 'dist', 'main', 'data', 'index.js'))
  dataMod.setDataDir(tmp)
  const store = require(STORE)
  const w1 = store.declareWork('s1', [{ kind: 'task', id: 'task-a' }, { id: 'docs/x.md', kind: 'file' }], 'fangcun-base')
  check('★ declareWork 写成功（ok + 条数）', w1.ok === true && w1.count === 2, JSON.stringify(w1))
  const w2 = store.claimWork('s1', [{ kind: 'task', id: 'task-a' }])
  check('★ claimWork 写成功', w2.ok === true && w2.count === 1, JSON.stringify(w2))

  const loaded = store.loadSession('s1')
  check('★★ 落盘后读得回来（跨进程/跨会话可续 —— 这是它必须落盘的理由）',
    !!loaded.decl && loaded.decl.plan.length === 2 && !!loaded.claim && loaded.claim.did.length === 1,
    JSON.stringify({ plan: loaded.decl && loaded.decl.plan.length, did: loaded.claim && loaded.claim.did.length }))
  check('★ 声明里带了 project', loaded.decl.project === 'fangcun-base')

  const p = store.auditFilePath()
  check('★ 落在旁路 jsonl（task-data/.behavior-audit.jsonl），不是任务卡',
    p.replace(/\\/g, '/').endsWith('task-data/.behavior-audit.jsonl'), p)
  const rawTxt = fs.readFileSync(p, 'utf-8')
  check('★ 文件里一行一条 JSON（追加日志，不是覆盖写）',
    rawTxt.trim().split('\n').length === 2, 'lines=' + rawTxt.trim().split('\n').length)

  // 同一 session 后写覆盖前写（"我改了计划"要算数）
  store.declareWork('s1', [{ kind: 'task', id: 'task-b' }], 'p2')
  const loaded2 = store.loadSession('s1')
  check('★★ 同 session 补声明 → 取**最后一条**（后来改的计划要算数）',
    loaded2.decl.plan.length === 1 && loaded2.decl.plan[0].id === 'task-b',
    JSON.stringify(loaded2.decl.plan))

  // 空声明要拒
  const bad = store.declareWork('s1', [])
  check('★ 空声明被拒（"什么都不写"不算声明）', bad.ok === false && !!bad.error, JSON.stringify(bad))

  // 坏行不许让整份作废
  fs.appendFileSync(p, 'this is not json\n', 'utf-8')
  const loaded3 = store.loadSession('s1')
  check('★★ 坏行跳过但不作废整份（坏数据不该让人丢掉全部审计记录）',
    !!loaded3.decl && loaded3.decl.plan.length === 1 && loaded3.badLines === 1,
    JSON.stringify({ decl: !!loaded3.decl, bad: loaded3.badLines }))

  // 任务卡一个字节都不许动
  const taskDir = path.join(tmp, 'task-data')
  const beforeFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir).filter((f) => f.endsWith('.md')) : []
  check('★ 审计不产生任务卡（task-data 里没有多出 .md）', beforeFiles.length === 0,
    beforeFiles.join(','))

  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

// ── ⑪ 报告文本：能直接贴给 agent / 给人看 ─────────────────────────────
{
  const rep = auditRound(
    { ts: 'x', plan: [ref('task', 'a')] },
    { did: [ref('task', 'b')] },
    [],
  )
  const txt = auditReportText(rep)
  check('★ 报告文本逐条列出（verdict + kind:id + 原因）',
    /claimed-not-read/.test(txt) && /task:b/.test(txt) && /declared-not-done/.test(txt), txt.slice(0, 120))
}

// ── ⑫ MCP 工具接线守卫 ────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(REPO, 'desktop', 'src', 'main', 'mcp', 'tools.ts'), 'utf-8')
  check('★★ MCP 里有 audit_declare / audit_check 两个工具（否则这套东西 agent 用不到）',
    /name: 'audit_declare'/.test(src) && /name: 'audit_check'/.test(src))
  check('★ declare 与 check 用的是同一份纯逻辑（不在 tools.ts 里重写判定）',
    /auditRound\(/.test(src) && /observedFromReadStats\(/.test(src))
  const srcStripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  check('★ 判定逻辑没被复制进 tools.ts（只 import，不重写）',
    !/claimed-not-read/.test(srcStripped), 'hit=' + /claimed-not-read/.test(srcStripped))
}

// ── ⑬ **真跑**：走真 MCP 工具、真 recordRead、真落盘 —— 抓"幽灵卡" ─────────
// 上面都是纯函数断言；这一节是「至少一条真跑的行为审计」（卡的判据原话）。
// 场景：agent 声明读 A 卡 + 一个文件；交付时声称读了 A、读了文件、还读了**一张从没读过的卡**。
// 期望：只抓那个幽灵卡；真读过的 A 与文件都不许被冤枉。
console.log('\n-- 真跑：MCP 工具端到端 --')
{
  const { execFileSync } = require('child_process')
  const js = `
const path=require('path'), fs=require('fs'), os=require('os');
// node -e <script> <args> 时 argv 是 [node, <args...>]，没有脚本路径（第一版按 argv[2] 取 → undefined，整段静默失败）
const REPO=process.argv[1];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fc-live-'));
fs.mkdirSync(path.join(tmp,'task-data'),{recursive:true});
fs.writeFileSync(path.join(tmp,'registry.yaml'),'projects: []\\n');
const data=require(path.join(REPO,'desktop/dist/main/data/index.js'));
data.setDataDir(tmp);
fs.writeFileSync(path.join(tmp,'task-data','task-live-1.md'),
 '---\\nid: task-live-1\\n标题: 真被读过的那张\\n状态: 待办\\n---\\n正文\\n');
// 造一条**真的**读记录（等价于 agent 真的 get_task 过它）
const usage=require(path.join(REPO,'desktop/dist/main/mcp/usage.js'));
usage.recordRead('get_task',['task-live-1']);
const tools=require(path.join(REPO,'desktop/dist/main/mcp/tools.js'));
(async()=>{
  const call=async(name,args)=>{
    const r=await tools.handleMCPToolCall(name,args,{client:'live-test'});
    const txt=r&&r.content&&r.content[0]&&r.content[0].text;
    try{return JSON.parse(txt)}catch(e){return {__raw:txt}}
  };
  const d=await call('audit_declare',{session_id:'live-1',project:'fangcun-base',
    plan:[{kind:'task',id:'task-live-1'},{kind:'file',id:'docs/x.md'}]});
  const c=await call('audit_check',{session_id:'live-1',did:[
    {kind:'task',id:'task-live-1'},{kind:'file',id:'docs/x.md'},{kind:'task',id:'task-ghost'}
  ]});
  const auditFile=path.join(tmp,'task-data','.behavior-audit.jsonl');
  const out={declare:d,check:c,
    auditFileExists:fs.existsSync(auditFile),
    auditLines:fs.existsSync(auditFile)?fs.readFileSync(auditFile,'utf-8').trim().split('\\n').length:0,
    noTaskCards:fs.readdirSync(path.join(tmp,'task-data')).filter(f=>f.endsWith('.md')).length};
  fs.rmSync(tmp,{recursive:true,force:true});
  console.log('###'+JSON.stringify(out));
})();
`
  let out = ''
  try {
    const raw = execFileSync(process.execPath, ['-e', js, REPO], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const idx = raw.indexOf('###')
    out = idx >= 0 ? raw.slice(idx + 3).trim() : ''
  } catch (e) {
    out = ''
    console.log('     （子进程失败：' + String(e && e.message).slice(0, 120) + '）')
  }
  let r = null
  try { r = JSON.parse(out) } catch { /* 忽略 */ }

  check('★★ 真跑：audit_declare 走 MCP 成功（声明落盘）', !!r && r.declare.ok === true && r.declare.declared === 2,
    r ? JSON.stringify(r.declare) : 'no output')
  check('★★★ 真跑抓到"幽灵卡"：声称读了但从没读过 → claimed-not-read',
    !!r && r.check.counts['claimed-not-read'] === 1
    && (r.check.rows || []).some((x) => x.id === 'task-ghost'),
    r ? JSON.stringify(r.check.counts) : '')
  check('★★ 真跑**不冤枉**真读过的那张（task-live-1 有 recordRead 记录）',
    !!r && !(r.check.rows || []).some((x) => x.id === 'task-live-1'),
    r ? JSON.stringify(r.check.rows) : '')
  check('★★ 文件类不被判定（MCP 看不见 client 侧读文件，自报即认可）',
    !!r && !(r.check.rows || []).some((x) => x.id === 'docs/x.md' && x.verdict === 'declared-not-done'),
    r ? JSON.stringify(r.check.rows) : '')
  check('★ 真跑：审计记录落在 .behavior-audit.jsonl（两行：声明 + 自报）',
    !!r && r.auditFileExists === true && r.auditLines === 2,
    r ? 'lines=' + r.auditLines : '')
  check('★ 真跑：不产生任务卡（task-data 里只有我造的那一张）',
    !!r && r.noTaskCards === 1, r ? 'md=' + r.noTaskCards : '')
}

console.log('\n' + (fail ? '❌ ' : '✅ ') + `RESULT ${pass} / ${fail}`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(fail ? 1 : 0)
