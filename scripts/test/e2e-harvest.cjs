/**
 * 会话捞取 + 判定 · 守卫（2026-11-16 · 第二版）
 *
 * 为什么需要它：这一整条链路（捞取 → 解析 → 判定）**错了也照样出报告**，
 * 而且错的时候看起来完全正常。2026-11-16 一天之内踩了 9 个，每个都让数字变成假数：
 *
 *   ① zstd 多帧拼接：5 MB 文件 3407 帧，Node API 只解第一帧 → 以为"会话是空的"
 *   ② `user/message` 里 82% 不是人说的 → 不筛的话"用户发言"一大半是系统注入
 *   ③ 子 agent 派工提示也是 `source:user` → 把「你是某某评审员…」当成用户需求
 *   ④ 解析器忽略"消息间空行" → 整个会话拼成一条 → 锚点被稀释，判定必然失真
 *   ⑤ 锚点词生成出不可能匹配的碎片（`批的渲染层拆分开`）→ 151 条假"无记录"
 *   ⑥ Hermes 用 `###` 作会话、`##` 作分组，解析器只认 `##` → 667 条全挂假会话下
 *   ⑦ **判据本身是错的**：罕见词覆盖率在真样本上把「请给我详细的验证测试清单」
 *      判成「接住」，命中的是 `试清单` `试清` `清单` —— 这种"证据"人复核不了。
 *      现在整条判据换成**逐字重合**（换判据，不是调阈值）。
 *   ⑧ 去重键写成"项目名"→ 1217 条被压成 21 条，且**完全不报错**。
 *   ⑨ 「虽然不能解决整个问题…」被我当成泛词巧合 bug 去收紧门槛 —— 但那张卡的
 *      「由来」一节**逐字引用了这句话**，它是真命中。**修错方向了。**
 *
 * 所以这套断言钉的是**口径**，不是"能不能跑"：
 *   · 两个产物格式都要解析出正确的会话 id / 时间 / 项目
 *   · 判定必须认原文片段、必须给得出证据、必须拒绝碎片式巧合
 *   · 数字不许"写得进去"就完事：总量守恒、去重不许吞条
 *   · 台账文件（decisions.md 等）不许冒充"卡"
 *   · 只读：跑一遍不许改任何数据
 *
 * 跑法：node scripts/test/e2e-harvest.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const JUDGE = path.join(ROOT, 'scripts', 'judge-harvested.py')
const HARVEST_CJS = path.join(ROOT, 'scripts', 'harvest-sessions.cjs')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function py(args, opts = {}) {
  return execFileSync('python', args, {
    cwd: ROOT, encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    timeout: 1800000,
    // ⚠ 必须放大缓冲：`--json` 会把命中的原文片段都塞进输出，默认 1MB 缓冲直接爆掉，
    // 报出来的却是 `spawnSync ... ENOBUFS` —— 看起来像"守卫自己坏了"，实际是输出太大。
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  })
}

/** 只在进程内调 Python 模块，避免反复起解释器 */
function pyEval(code) {
  return py(['-X', 'utf8', '-c', code])
}

function main() {
  // ══ 一、DSH 逐帧解压：只解第一帧会得到"空会话" ══
  console.log('=== 一、zstd 多帧（只解第一帧会误判为空） ===')
  {
    const h = require(HARVEST_CJS)
    check('导出了 decompressAll（逐帧解）', typeof h.decompressAll === 'function')
    const base = path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'sessions')
    let f = ''
    const walk = (d) => {
      let es = []
      try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of es) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (!f && e.name.endsWith('.zstd')) {
          try { if (fs.statSync(p).size > 500000) f = p } catch {}
        }
      }
    }
    walk(base)
    if (f) {
      const d = h.decompressAll(fs.readFileSync(f))
      check('★ 真会话文件解出来的字节数远大于 1 KB（第一帧只有 200 字符左右）',
        d.bytes > 1024 * 100, `bytes=${d.bytes} frames=${d.frames}`)
      check('★ 帧数 > 1（多帧拼接是真的）', d.frames > 1, `frames=${d.frames}`)
      check('★ 解压没有失败帧', d.failed === 0, `failed=${d.failed}`)
    } else {
      console.log('SKIP  本机没有 ≥500KB 的会话文件')
    }
  }

  // ══ 二、注入型 / 子 agent / 附件上下文必须被筛掉 ══
  console.log('\n=== 二、三道筛子 ===')
  {
    const out = pyEval(`
import sys, importlib.util
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
sp = importlib.util.spec_from_file_location('hh', ${JSON.stringify(path.join(ROOT, 'scripts', 'harvest-hermes.py'))})
m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
print('INJ1', m.is_injected('[IMPORTANT: Background process proc_x matched watch pattern "y"]'))
print('INJ2', m.is_injected('你好，帮我看一下这个'))
print('ATT', repr(m.strip_attached('问题正文\\n--- Attached Context ---\\n📄 @file:a.py\\n\\\`\\\`\\\`python\\nx=1\\n\\\`\\\`\\\`')))
`)
    check('★ Hermes 后台进程通知被判为注入', /INJ1 True/.test(out), out.split('\n')[0])
    check('★ 正常人话不判注入', /INJ2 False/.test(out), out.split('\n')[1])
    check('★★ 附件上下文被裁掉（否则捞出来大半是代码）',
      /附件上下文已裁掉/.test(out) && !/x=1/.test(out), (out.match(/ATT .*/) || [''])[0].slice(0, 120))
  }

  // ══ 三、两个产物格式都要解析对（最容易静默错的地方） ══
  console.log('\n=== 三、解析两种产物格式 ===')
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-hv-'))
    const dshFixture = path.join(tmp, 'dsh.md')
    fs.writeFileSync(dshFixture, [
      '# 会话记录里捞到的「用户说过的话」',
      '',
      '## session-aaa',
      '',
      '- 时间：2026-10-24 08:36 · 项目：`E:\\\\CODE\\\\CangKu\\\\SiTian`',
      '- 用户发言：**2** 条',
      '',
      '> 第一条真话',
      '',
      '> 第二条真话',
      '',
      '## session-bbb',
      '',
      '- 时间：2026-10-25 09:00 · 项目：`E:\\\\CODE\\\\CangKu\\\\fangcun`',
      '',
      '> 第三条真话',
    ].join('\n'), 'utf-8')

    const hermesFixture = path.join(tmp, 'hermes.md')
    fs.writeFileSync(hermesFixture, [
      '# Hermes 会话里捞到的「用户说过的话」',
      '',
      '## 按会话（2 个）',
      '',
      '### `20260708_074922_df3af1` · 2026-07-08 07:49',
      '',
      '- source `cli` · `C:\\\\Windows\\\\system32` · 中文界面设置',
      '- 用户发言：**1** 条',
      '',
      '> 如何修改桌面端语言？',
      '',
      '### `20260726_210825_16f584` · 2026-07-26 21:08',
      '',
      '- source `desktop` · `E:\\\\AI\\\\Hermes_Workspace` · v5 分支',
      '',
      '> 我采纳双分支策略',
    ].join('\n'), 'utf-8')

    const out = pyEval(`
import sys, importlib.util, json
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
sp = importlib.util.spec_from_file_location('j', ${JSON.stringify(JUDGE)})
m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
for name, p in (('dsh', ${JSON.stringify(dshFixture)}), ('hermes', ${JSON.stringify(hermesFixture)})):
    rows = m.parse_harvest(p)
    print(name, len(rows), json.dumps([[r[0], r[1], r[2], r[3][:8]] for r in rows], ensure_ascii=False))
`)
    check('★ DSH 产物：`## ` 作会话标题，解析出 3 条（不是 2 条拼成 1 条）',
      /dsh 3 /.test(out), (out.match(/dsh [^\n]*/) || [''])[0])
    check('★ DSH 产物：项目解析出来了（不是空）',
      /dsh 3 .*SiTian/.test(out), (out.match(/dsh [^\n]*/) || [''])[0])
    check('★★ Hermes 产物：`### ` 才是会话，`## 按会话` 是分组（不许变成假会话 id）',
      /hermes 2 /.test(out) && !/hermes [^\n]*按会话/.test(out),
      (out.match(/hermes [^\n]*/) || [''])[0])
    check('★ Hermes 产物：cwd 从 `- source` 行里取到（不是空）',
      /hermes 2 .*Hermes_Workspace/.test(out), (out.match(/hermes [^\n]*/) || [''])[0])

    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // ══ 四、台账文件不许冒充「卡」 ══
  console.log('\n=== 四、台账 vs 卡 ===')
  {
    const out = pyEval(`
import sys, importlib.util, os
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
sp = importlib.util.spec_from_file_location('j', ${JSON.stringify(JUDGE)})
m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
os.chdir(${JSON.stringify(ROOT)})
docs = m.load_corpus()
kinds = {}
for d in docs:
    kinds.setdefault(d['kind'], []).append(d['id'])
for k, v in kinds.items():
    print(k, len(v))
print('BAD', [i for i in kinds.get('卡', []) if i in ('decisions','rice-pool','question-bank')])
`)
    check('★★ decisions / rice-pool / question-bank 不再被当成「卡」',
      /BAD \[\]/.test(out), (out.match(/BAD .*/) || [''])[0])
    check('★ 有「台账」这一类', /台账 \d+/.test(out), out.replace(/\n/g, ' | ').slice(0, 160))
  }

  // ══ 五、判据本体：认原文、给证据、拒碎片 ══
  console.log('\n=== 五、判据本体（逐字重合） ===')
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-hv2-'))
    // ⚠ 夹具设计的关键（2026-11-16 踩过两次）：
    //   ① 消息与记录**不能是同一句话** —— 那覆盖率必然 1.0，测不出任何东西（假绿）。
    //   ② 也不能把「长得像需求」当成「接住」—— 本套要钉的正是**碎片不算**。
    const out = pyEval(`
import sys, importlib.util
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
sp = importlib.util.spec_from_file_location('j', ${JSON.stringify(JUDGE)})
m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)

docs = [
  {'kind':'卡','id':'组合视图','text':'暮雨：「虽然不能解决整个问题，但有一定作用，可以做」。此后一直卡在死循环。',
   'progressed':True,'status':'进行中'},
  {'kind':'卡','id':'拖拽','text':'添加拖拽换角，但需要带锁定开关防止意外拖动；拖动时给出视觉反馈。',
   'progressed':True,'status':'进行中'},
  {'kind':'日志','id':'log_x','text':'用户原话：请给我详细的验证测试清单，告诉我如何操作。时间宝贵',
   'progressed':True,'status':''},
]
idx = m.build_index([d['text'] for d in docs] + [
  '虽然不能解决整个问题，但有一定作用，可以做',
  '添加拖拽换角，但需要带锁定开关防止意外拖动',
  '请给我详细的验证测试清单，告诉我如何操作',
  '等等，那为什么不直接做一整个 agent？连 electron 可能都不用',
], docs)

cases = [
  ('泛表态但被原样引用', '虽然不能解决整个问题，但有一定作用，可以做'),
  ('真需求·原话被引用', '添加拖拽换角，但需要带锁定开关防止意外拖动。'),
  ('真需求·原话被引用2', '请给我详细的验证测试清单，告诉我如何操作。时间宝贵'),
  ('碎片式巧合（不该接住）', '等等，那为什么不直接做一整个 agent？连 electron 可能都不用'),
]
for name, msg in cases:
    v, why, sh = m.judge_one(msg, idx, docs)
    ev = ' | '.join('%s:%s' % (h['cls'], h['run'][:24].replace(chr(10),' ')) for h in sh[:2])
    print('CASE', name, '=>', v, '::', ev)
`)
    const base = (msg) => (msg.match(/CASE [^=]*=> (\S+)/) || [])[1] || ''

    check('★★ 原话被记录**逐字引用**时判「接住」（哪怕是泛表态 —— 它是真命中）',
      /CASE 泛表态但被原样引用 => (接住|只有记录)/.test(out),
      (out.match(/CASE 泛表态[^\n]*/) || [''])[0])
    check('★★ 真需求：拖拽换角原话被引用 → 接住',
      /CASE 真需求·原话被引用 => 接住/.test(out), (out.match(/CASE 真需求·原话被引用 [^\n]*/) || [''])[0])
    check('★★ 真需求：验证测试清单原话被引用 → 接住',
      /CASE 真需求·原话被引用2 => 接住/.test(out), (out.match(/CASE 真需求·原话被引用2[^\n]*/) || [''])[0])
    check('★★ 碎片式巧合**不许**有任何原文片段命中（不是"不许接住"，是"不许算有引用"）',
      /CASE 碎片式巧合（不该接住） => 无逐字引用/.test(out),
      (out.match(/CASE 碎片式巧合[^\n]*/) || [''])[0])
    // ★ 七个 verdict 是**固定枚举**。不许悄悄改名（例如把「无逐字引用」改回「无记录」）
    // —— 那是夸大：逐字判据看不见 ≠ 没有记录。这条反例自证抓过，必须有硬断言。
    const allowed = ['接住', '只有记录', '疑似', '粘贴原文', '无逐字引用', '无法判定']
    const verdicts = [...out.matchAll(/CASE [^=]*=> (\S+)/g)].map((m) => m[1])
    check('★★ 判出来的 verdict 必须在固定六类里（改名 = 换个说法骗人）',
      verdicts.length > 0 && verdicts.every((v) => allowed.includes(v)),
      verdicts.join(','))

    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // ══ 六、数字必须守恒（去重不许吞条、总数必须对得上） ══
  console.log('\n=== 六、数字守恒 ===')
  {
    const code = `
import sys, importlib.util, json, os
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
sp = importlib.util.spec_from_file_location('j', ${JSON.stringify(JUDGE)})
m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
a = m.parse_harvest(${JSON.stringify(path.join(ROOT, 'docs', '捞-会话', 'all.md'))})
b = m.parse_harvest(${JSON.stringify(path.join(ROOT, 'docs', '捞-Hermes-20261116.md'))})
merged = [('x',) + tuple(x) for x in (a + b)]
uniq = m.dedupe(merged)
print('PARSE', len(a), len(b), len(merged), len(uniq))
`
    const out = pyEval(code)
    const m = out.match(/PARSE (\d+) (\d+) (\d+) (\d+)/)
    check('★ 两个产物都能解析出真实条数（>0）', m && Number(m[1]) > 0 && Number(m[2]) > 0,
      (out.match(/PARSE .*/) || [''])[0])
    check('★★ 合并总数 = 两边之和（不许静默丢）',
      m && Number(m[3]) === Number(m[1]) + Number(m[2]), (out.match(/PARSE .*/) || [''])[0])
    check('★★ 去重后仍保留 ≥80%（去重键写错会压成个位数）',
      m && Number(m[4]) >= Number(m[3]) * 0.8, (out.match(/PARSE .*/) || [''])[0])
  }

  // ══ 七、全量跑一遍：每条判定都必须能被计数 ══
  console.log('\n=== 七、全量判定 ===')
  {
    const raw = py([JUDGE, '--json', '--brief'])
    // PowerShell 可能把它读成别的编码，这里只在 Node 侧解析
    const d = JSON.parse(raw)
    const sum = Object.values(d.counts).reduce((a, b) => a + b, 0)
    check('★★ 各档之和 == 总条数（不许有判定落不进任何一档）',
      sum === d.total, `sum=${sum} total=${d.total}`)
    check('★★ 原始 1217 条去重后仍是四位数（去重键写错 → 21 条，曾实测）',
      d.rawTotal >= 1000 && d.total >= 800, `raw=${d.rawTotal} uniq=${d.total}`)
    check('★ 「无逐字引用」是最大的一档（否则判据太松）',
      (d.counts['无逐字引用'] || 0) > (d.counts['接住'] || 0),
      JSON.stringify(d.counts))
    check('★★ 「接住」一定远小于总数 —— 上一版报 76.5%，是被碎片骗的',
      (d.counts['接住'] || 0) < d.total * 0.3, JSON.stringify(d.counts))
    const withRun = d.rows.filter((r) => r.verdict === '接住' || r.verdict === '只有记录')
      .every((r) => r.hits.length > 0 && r.hits.every((h) => h.run && h.run.length >= 6))
    check('★★ 每一条「接住 / 只有记录」都必须带得出 ≥6 字的原文片段（证据不许缺）', withRun)

    const dup = d.rows.filter((r) => r.verdict === '无法判定' && r.why && !/太短/.test(r.why))
    check('★ 无法判定必须给原因（且只该是"太短"这一种）', dup.length === 0,
      dup.slice(0, 3).map((r) => r.why).join(' / '))
  }

  // ══ 八、只读 ══
  console.log('\n=== 八、只读 ===')
  {
    const fp = (dir) => {
      const out = []
      const walk = (d) => {
        let es = []
        try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of es) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) { walk(p); continue }
          try {
            const st = fs.statSync(p)
            out.push(path.relative(dir, p) + ':' + st.size + ':' + st.mtimeMs)
          } catch {}
        }
      }
      walk(dir)
      return out.sort().join('\n')
    }
    const td = path.join(ROOT, 'task-data')
    const before = fp(td)
    py([JUDGE, '--json', '--brief'])
    check('★ 跑一遍判定，task-data 逐字节 + mtime 全不变', fp(td) === before)
  }

  // ══ 九、源码守卫 ══
  console.log('\n=== 九、源码守卫 ===')
  {
    const src = fs.readFileSync(JUDGE, 'utf-8')
      .split('\n').filter((l) => {
        const t = l.trim()
        return !t.startsWith('#') && !t.startsWith('"""') && !t.startsWith('*')
      }).join('\n')
    for (const bad of ["open\\([^)]*'w'", 'write_text', 'os\\.remove', 'shutil\\.move', 'unlink']) {
      check(`判定器里没有 ${bad}（只读铁律）`, !new RegExp(bad).test(src))
    }
    check('★ 去重按原文（`x[4]`）而不是项目名（`x[3]`）—— 写错曾把 1217 压成 21',
      /re\.sub\(r"\\s\+", "", x\[4\]\)/.test(src))
    check('★ 不再用 n-gram 覆盖率判据（`MIN_COVER` 必须彻底消失）',
      !/MIN_COVER/.test(src))
    const hs = fs.readFileSync(path.join(ROOT, 'scripts', 'harvest-hermes.py'), 'utf-8')
    check('★ Hermes 用 `mode=ro` 打开 SQLite（只读，不是普通连接）',
      /mode=ro/.test(hs))
  }

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main()
