/**
 * 会话捞取 + 判定 · 守卫（2026-11-16）
 *
 * 为什么需要它：这一整条链路（捞取 → 解析 → 判定）**错了也照样出报告**，
 * 而且错的时候看起来完全正常。2026-11-16 一天之内踩了 6 个，每个都让数字变成假数：
 *
 *   ① zstd 多帧拼接：5 MB 文件 3407 帧，Node API 只解第一帧 → 以为"会话是空的"
 *   ② `user/message` 里 82% 不是人说的 → 不筛的话"用户发言"一大半是系统注入
 *   ③ 子 agent 派工提示也是 `source:user` → 把「你是某某评审员…」当成用户需求
 *   ④ 解析器忽略"消息间空行" → 整个会话拼成一条 → 锚点被稀释，判定必然失真
 *   ⑤ 锚点词生成出不可能匹配的碎片（`批的渲染层拆分开`）→ 151 条假"无记录"
 *   ⑥ Hermes 用 `###` 作会话、`##` 作分组，解析器只认 `##` → 667 条全挂假会话下
 *
 * 所以这套断言钉的是**口径**，不是"能不能跑"：
 *   · 两个产物格式都要能解析出正确的会话 id / 时间 / 项目
 *   · 注入型、子 agent、附件上下文必须被筛掉
 *   · 判定必须要求"高信息量词"命中，泛词巧合不许算接住
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
    // ⚠ 必须放大缓冲：`judge-harvested.py --json` 会把**每条命中的完整文档正文**
    // 都塞进输出（一份日志就是几十万字符），默认 1MB 缓冲直接爆掉，
    // 报出来的却是 `spawnSync ... ENOBUFS` —— 看起来像"守卫自己坏了"，
    // 实际是输出太大。2026-11-16 实测踩到。
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  })
}

/** 只在进程内调 Python 模块，避免反复起解释器 */
function pyEval(code) {
  return py(['-c', code])
}

function main() {
  // ══ 一、DSH 逐帧解压：只解第一帧会得到"空会话" ══
  console.log('=== 一、zstd 多帧（只解第一帧会误判为空） ===')
  {
    const h = require(HARVEST_CJS)
    check('导出了 decompressAll（逐帧解）', typeof h.decompressAll === 'function')
    // 拿一个真文件验：真身 ≥ 几千帧，解压后必须远大于第一帧的 200 字符
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
import sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
import importlib.util
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

  // ══ 三、两个产物格式都要解析对（这是最容易静默错的地方） ══
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
import sys, importlib.util
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
sp = importlib.util.spec_from_file_location('j', ${JSON.stringify(JUDGE)})
m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
import os
os.chdir(${JSON.stringify(ROOT)})
docs = m.load_corpus()
kinds = {}
for d in docs:
    kinds.setdefault(d['kind'], []).append(d['id'])
for k, v in kinds.items():
    print(k, len(v))
ledger_bad = [i for i in kinds.get('卡', []) if i in ('decisions','rice-pool','question-bank')]
print('BAD', ledger_bad)
`)
    check('★★ decisions / rice-pool / question-bank 不再被当成「卡」',
      /BAD \[\]/.test(out), (out.match(/BAD .*/) || [''])[0])
    check('★ 有「台账」这一类', /台账 \d+/.test(out), out.replace(/\n/g, ' | ').slice(0, 160))
  }

  // ══ 五、判定必须要求高信息量词（泛词巧合不算接住） ══
  console.log('\n=== 五、判定不许被泛词骗 ===')
  {
    const out = pyEval(`
import sys, importlib.util
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
sp = importlib.util.spec_from_file_location('j', ${JSON.stringify(JUDGE)})
m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)

# ⚠ 夹具设计的关键（2026-11-16 踩过）：**消息与文档不能是同一句话**。
# 第一版把 A 卡写成「这个有一定作用，可以做」，而测试消息也含同样几个字 →
# 覆盖率必然 1.0，测不出任何东西（假绿）。真实场景是"泛泛表态撞上一张不相干的卡"。
docs = [
  {'kind':'卡','id':'组合视图','text':'把 tiers/RICE/token/产出 join 成一张表，核心项目零调用一眼可见',
   'progressed':True,'status':'进行中'},
  {'kind':'卡','id':'派工包','text':'分层 spec 的派工包要能直接粘给 agent，带骨架原文与排除清单',
   'progressed':True,'status':'进行中'},
]
df = m.build_df(docs)
terms = [m.terms_of(d['text']) for d in docs]

# 泛泛表态：一个具体词都没有
v1, a1, h1 = m.judge_one('虽然不能解决整个问题，但有一定作用，可以做', docs, df, terms, len(docs))
# 真需求：专有词多
v2, a2, h2 = m.judge_one('分层 spec 的派工包要能直接粘给 agent，带骨架原文', docs, df, terms, len(docs))
print('V1', v1, '|', ','.join(a1))
print('V2', v2, '|', ','.join(a2))
`)
    check('★★ 泛泛表态**不许**判成「接住」（它撞上的是一张不相干的卡）',
      /V1 (无法判定|无记录)/.test(out), (out.match(/V1 [^\n]*/) || [''])[0])
    check('★ 有专有词（分层 / 派工包 / 骨架原文）时能判成接住',
      /V2 接住/.test(out), (out.match(/V2 [^\n]*/) || [''])[0])
  }

  // ══ 六、只读 ══
  console.log('\n=== 六、只读 ===')
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

  // ══ 七、源码守卫 ══
  console.log('\n=== 七、源码守卫 ===')
  {
    const src = fs.readFileSync(JUDGE, 'utf-8')
      .split('\n').filter((l) => {
        const t = l.trim()
        return !t.startsWith('#') && !t.startsWith('"""') && !t.startsWith('*')
      }).join('\n')
    for (const bad of ["open\\([^)]*'w'", 'write_text', 'os\\.remove', 'shutil\\.move', 'unlink']) {
      check(`判定器里没有 ${bad}（只读铁律）`, !new RegExp(bad).test(src))
    }
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
