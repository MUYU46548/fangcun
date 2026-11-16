/**
 * 层厚度检查器 · 守卫（2026-11-16）
 *
 * 为什么需要它：`scripts/layer-profile.py` 输出的表**错了也照样出**，
 * 而且错的时候看起来完全正常。2026-11-16 首跑就连栽三次：
 *   ① 司天根下有个 `.test-edge-profile-3d`（浏览器 profile），287 万行扩展代码
 *      把分母撑到 300 万 → 「编辑器占 92%」被算成 **0.4%**，所有百分比连同结论一起是假的；
 *   ② 分母拿的是**全仓代码行**，于是说完"编辑器 8.9%"后剩下的 91% 其实是测试 ——
 *      那不是"薄"，是**分错了母**；
 *   ③ spec 里 `src/renderer/src/utils/terrain` 少了 `*`，生成器整层扫到 **0 个文件**，
 *      而报告上"0 行"和"这层真的没代码"长得一模一样。
 *
 * 所以这套断言钉的是**口径**，不是"能不能跑"：
 *   - 隐藏目录不许进分母（浏览器 profile / 缓存）
 *   - 被规则排除的顶层目录要点名（不许静默改变分母）
 *   - 分母不许把测试算进"产品层占比"
 *   - 扫到 0 文件必须写成"没扫到"，不许写成"厚度为 0"
 *   - 仓库不存在给 missing，**不给 0**
 *   - 只读：跑一遍 task-data 逐字节不变
 *
 * 每条都带反例自证：把错装回去，必须精确变红。
 *
 * 运行：node scripts/test/e2e-layer-profile.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'layer-profile.py')

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}

function runPy(args, opts = {}) {
  return execFileSync('python', [SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) },
    timeout: 300000,
  })
}

function runPyJson(args, opts = {}) {
  return JSON.parse(runPy([...args, '--json'], opts))
}

/** --json 恒返回数组（一个或多个项目）；单项目取 [0] */
function runOne(pid, opts = {}) {
  return runPyJson([pid], opts)[0]
}

/** task-data 全量指纹（用于证明脚本只读） */
function fingerprint() {
  const out = new Map()
  const walk = (dir) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      const st = fs.statSync(p)
      out.set(path.relative(ROOT, p), st.size + ':' + st.mtimeMs)
    }
  }
  walk(path.join(ROOT, 'task-data'))
  return out
}

/** 造一个假仓库：已知行数，用来验口径而不是验真项目 */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'))
  for (const [rel, lines] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'x\n'.repeat(lines), 'utf-8')
  }
  return dir
}

function main() {
  console.log('=== 一、真项目（司天）：数字必须能被复算 ===')
  const fpBefore = fingerprint()
  const si = runPyJson(['sitian', '--spec', 'task-data/layer-specs/sitian.json'])[0]
  const fpAfter = fingerprint()
  check('司天的报告是真对象（不是 missing）', !si.missing, JSON.stringify(si.missing))
  check('司天扫到了代码', si.total_lines > 0, `total_lines=${si.total_lines}`)

  // ① 隐藏目录不许进分母。这是首跑最严重的错：287 万行浏览器 profile。
  const rowsText = (si.rows || []).map(r => r.layer).join('|')
  check('★ 隐藏目录不进分母（首跑被浏览器 profile 撑到 300 万行）',
    !/test-edge-profile|lab-edge-profile/.test(rowsText), rowsText.slice(0, 200))
  const skippedDirs = (si.skipped || []).map(s => s.dir)
  check('★ 被规则挡在外面的目录**点名列出**（不许静默改分母）',
    skippedDirs.length > 0 && skippedDirs.every(d => typeof d === 'string'),
    JSON.stringify(skippedDirs))

  // ② 分母口径。占比不许拿全仓当母。
  check('全仓行数远小于"浏览器 profile 进来时"的 300 万',
    si.total_lines < 1000000, `total_lines=${si.total_lines}`)
  const prodLines = (si.rows || []).filter(r => r.role === '产品').reduce((a, r) => a + r.lines, 0)
  check('产品代码行数 > 0 且 < 全仓行数（测试/工具确实被分出去了）',
    prodLines > 0 && prodLines < si.total_lines, `产品=${prodLines} 全仓=${si.total_lines}`)

  // ③ 生成器那层必须真扫到文件。首跑 spec 少了 `*`，扫到 0 个文件却写成"0 行"。
  const gen = (si.named || []).find(n => n.name.includes('生成器'))
  check('★ 生成器层扫到了文件（首跑 spec 少了 `*` → 0 个文件，像"这层没代码"）',
    gen && gen.files > 0, JSON.stringify(gen))
  check('生成器层行数与 2026-11-15 手算的 2,711 一致（证明口径可复算）',
    gen && gen.lines === 2711, `实测 ${gen && gen.lines}`)

  // ④ 与声称的数字逐条对账，且「零差异」不许说成「实测少 0」
  const text = runPy(['sitian', '--spec', 'task-data/layer-specs/sitian.json'])
  check('★ 零差异写「一致」，不写「实测少 0」', !/实测少 0/.test(text),
    (text.match(/实测少 0[^\n]*/) || [''])[0])
  check('有「与声称的数字逐条对账」这一节', text.includes('与声称的数字逐条对账'))
  check('★ 大账只在 spec 点名的几块内部比（不许拿全仓当母说编辑器很薄）',
    /只算这几块（合计 [\d,]+ 行）内部/.test(text))

  // ⑤ 一句话结论必须回答"哪块厚哪块薄"，而不是罗列模块
  check('★ 一句话结论点出编辑器/生成器的占比（首版只说"最厚的是历史剧本 0.4%"，等于没说）',
    /编辑器/.test(si.verdict) && /生成器/.test(si.verdict), si.verdict)
  check('结论里没有假百分比（0.4% 那种：分母被污染）',
    !/占全部代码 0\.4%/.test(text))

  // ⑥ 扩展名像代码、其实是二进制（`.ts` 也是 MPEG 视频分片）
  const vedio = runOne('vedio-maker')
  check('★ `.ts` 视频分片被识别成非文本，不计入代码行',
    (vedio.nonText || []).length > 0,
    `nonText=${(vedio.nonText || []).length} total=${vedio.total_lines}`)
  check('★ 视频制作的产品代码不再是 17 万行（那是视频碎片的行数）',
    vedio.total_lines < 100000, `total=${vedio.total_lines}`)

  console.log('\n=== 二、只读 ===')
  check('★ 跑一遍 task-data 逐字节 + mtime 全不变',
    fpBefore.size === fpAfter.size &&
    [...fpBefore].every(([k, v]) => fpAfter.get(k) === v),
    `before=${fpBefore.size} after=${fpAfter.size}`)

  console.log('\n=== 三、缺什么就说缺什么（不许填 0） ===')
  const bogus = runOne('__没有这个项目__')
  check('不认识的项目给 missing', !!bogus.missing, JSON.stringify(bogus))

  // repo 路径不存在 → 必须 missing，**不许给 0 行**（0 会被读成"这项目真没代码"）
  const noRepoReg = path.join(os.tmpdir(), `reg-norepo-${Date.now()}.yaml`)
  fs.writeFileSync(noRepoReg, [
    'projects:',
    '  - id: ghost',
    '    name: 幽灵项目',
    '    repo: E:/绝对不存在的路径/zzz-ghost',
  ].join('\n'), 'utf-8')
  const ghost = runPyJson(['ghost'], { env: { FC_REGISTRY: noRepoReg } })[0]
  fs.rmSync(noRepoReg, { force: true })
  check('★ repo 路径不存在时给 missing，**不给 0 行**',
    !!ghost.missing && ghost.total_lines === undefined,
    JSON.stringify(ghost).slice(0, 200))
  check('★ missing 写明"扫不到 ≠ 厚度为 0"',
    /不是厚度为 0/.test(ghost.missing || ''), ghost.missing)

  console.log('\n=== 五、分母口径：占比不许超 100% ===')
  // ⚠ 2026-11-16 被真 spec 当场揭出的 bug：明鉴是纯 Python CLI 项目，代码全在 `scripts/`，
  // 按目录名判定的"产品代码"只剩 gui/ + desktop/ = 1,346 行，而 spec 圈出 13,256 行
  // → **占比算出 444.6%**。444% 不可能是真的，所以它必须不可能出现。
  {
    // spec 的真源在 task-data/layer-specs/，用 --spec 直接指过去（不用 auto-spec，
    // 因为本守卫的 runPy 跑在仓库根，而 FC_REGISTRY 可能被别的用例改过）
    const p3spec = path.join(ROOT, 'task-data', 'layer-specs', 'project-3.json')
    if (fs.existsSync(p3spec)) {
      const p3 = runPyJson(['project-3', '--spec', 'task-data/layer-specs/project-3.json'])[0]
      // ⚠ 判「读到了」不看 `ok` 字段 —— `--json` 里根本没有 `ok`（只有 missing / total_lines）。
      // 2026-11-16 实测踩到：写成 `if (p3 && p3.ok)` 时恒为假，整段断言**一条都没跑**，
      // 结果却显示 26/0 全绿 —— 这是「断言自己空转」的典型形状。
      const gotData = !!p3 && !p3.missing && typeof p3.total_lines === 'number' && p3.total_lines > 0
      check('★ 明鉴 spec 真被读到（否则下面几条是空转）', gotData,
        JSON.stringify({ missing: p3 && p3.missing, total: p3 && p3.total_lines }).slice(0, 120))
      if (gotData) {
        const groups = p3.groups || []
        const total = p3.total_lines
        const prod = (p3.rows || []).filter((r) => r.role === '产品').reduce((a, r) => a + r.lines, 0)
        const base = Math.max(total, prod)
        check('★ 明鉴 spec 里真有 groups（4 组，含 L 线 / G 线两套读法）',
          groups.length >= 2, `groups=${groups.length}`)
        const over = groups.filter((g) => g.lines > base)
        check('★★ 没有一个「大块」的行数超过分母（超了就是分母选错了，会算出 444%）',
          over.length === 0,
          over.map((g) => `${g.name}=${g.lines} > ${base}`).join(','))
        const pcts = (p3.verdict.match(/([\d.]+)%/g) || []).map((s) => parseFloat(s))
        check('★★ 结论里每个百分比都 <= 100%（444.6% 那种数不许出现）',
          pcts.length > 0 && pcts.every((v) => v <= 100),
          `pcts=${pcts.join(',')}`)

        const t3 = runPy(['project-3', '--spec', 'task-data/layer-specs/project-3.json'])
        check('★★ 换了分母要**大声说**（写清为什么换、换成什么）',
          /分母换过了/.test(t3) && /改用全仓/.test(t3),
          (t3.match(/分母换过了[^\n]*/) || [''])[0].slice(0, 100))
      }
    } else {
      console.log('SKIP  本机没有明鉴 spec（task-data/layer-specs/project-3.json），这条不跑')
    }
  }

  console.log('\n=== 六、口径自证：拿假仓库，把错装回去必须精确变红 ===')
  // ③ 的反例：spec 少了 `*` → 生成器 0 文件。用假仓库复现这个错。
  const fx = fixture({
    'src/gen/a.js': 10,
    'src/gen/b.js': 5,
    'src/ui/c.js': 100,
    '.browser-profile/Default/ext/x.js': 50000,
    'node_modules/dep/y.js': 40000,
  })
  // .ts 视频分片：扩展名是 .ts，内容是二进制（含 NUL）
  fs.writeFileSync(path.join(fx, 'src/ui/seg_01.ts'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x0a]), 'binary')
  // GBK 编码的合法脚本（真实案例：ROSA `96 事务管理/索引预览.bat`，带 `chcp 936`）
  // 只认 UTF-8 会把它当二进制丢掉 —— 那是拿"看不见"当成"没有"。
  // GBK 字节手工写（避免依赖 Node 的 iconv）：`@echo off\r\nREM 索引预览\r\n`
  fs.writeFileSync(path.join(fx, 'src/ui/legacy.bat'),
    Buffer.concat([
      Buffer.from('@echo off\r\nchcp 936 >nul\r\nREM ', 'ascii'),
      Buffer.from([0xcb, 0xf7, 0xd2, 0xfd, 0xd4, 0xa4, 0xc0, 0xc0]), // 「索引预览」GBK
      Buffer.from('\r\n', 'ascii'),
    ]), 'binary')
  const specGood = path.join(fx, 'spec-good.json')
  fs.writeFileSync(specGood, JSON.stringify({
    layers: { 生成器: { paths: ['src/gen/'] }, 界面: { paths: ['src/ui/'] } },
    groups: { 生成器: ['生成器'], 界面: ['界面'] },
  }), 'utf-8')
  const specBad = path.join(fx, 'spec-bad.json')
  fs.writeFileSync(specBad, JSON.stringify({
    layers: { 生成器: { paths: ['src/gen'] }, 界面: { paths: ['src/ui/'] } },
  }), 'utf-8')

  // profile_one 需要 registry 里有这个 id —— 用 fif 前缀绕过，直接测底层函数更实在。
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
import importlib.util
spec = importlib.util.spec_from_file_location('lp', ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
repo = ${JSON.stringify(fx)}
recs, unreadable, nonText, skipped = m.scan_files(repo)
rows = m.group_layers(recs, 3)
req = '全部代码 0 行'  # 占位，防 f-string 转义踩坑
for name in ('spec-good.json', 'spec-bad.json'):
    sp = json.load(open(${JSON.stringify(fx)} + '/' + name, encoding='utf-8'))
    named = m.apply_spec(recs, sp)
    print(name, json.dumps({n['name']: n['files'] for n in named}, ensure_ascii=False, sort_keys=True))
print('total', sum(r['lines'] for r in rows))
print('skipped', json.dumps([s['dir'] for s in skipped], ensure_ascii=False, sort_keys=True))
print('nontext', json.dumps([n['file'] for n in nonText], ensure_ascii=False, sort_keys=True))
print('ui_files', json.dumps(sorted(r for r, _ in recs if r.startswith('src/ui/')), ensure_ascii=False))

# ── 反例自证：把 _match 换成"只认整文件相等"（首版就是这么错的），
#    spec 的 dir 写法必须当场命中 0 个文件。这一条证明上面两条不是空转。
orig = m._match
m._match = lambda rel, pats: any(rel == p for p in pats)
bad = m.apply_spec(recs, json.load(open(${JSON.stringify(fx)} + '/spec-bad.json', encoding='utf-8')))
print('mutated', json.dumps({n['name']: n['files'] for n in bad}, ensure_ascii=False, sort_keys=True))
m._match = orig
`
  const out = execFileSync('python', ['-c', py], {
    cwd: ROOT, encoding: 'utf-8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const lines = out.split(/\r?\n/)
  const lineOf = (prefix) => (lines.find(l => l.startsWith(prefix)) || '')
  check('★ 目录写法 `src/gen/` 命中 2 个文件',
    /"生成器": 2/.test(lineOf('spec-good')), lineOf('spec-good'))
  check('★ 少写结尾斜杠的 `src/gen` 同样命中 2 个（不是 0）',
    /"生成器": 2/.test(lineOf('spec-bad')), lineOf('spec-bad'))
  check('★ 反例自证：换成"只认整文件相等"后，生成器当场 0 个文件',
    /"生成器": 0/.test(lineOf('mutated')), lineOf('mutated'))
  check('★ 反例：假仓库里的 .browser-profile 50,000 行**没进** total（10+5+100+GBK脚本3行=118）',
    /total 118/.test(out), (out.match(/total \d+/) || [''])[0])
  check('★ 反例：`.ts` 视频分片（二进制）被识别成非文本，不计入',
    /nontext \[.*seg_01\.ts/.test(out), (out.match(/nontext \[[^\]]*\]/) || [''])[0])
  check('★ 反例：GBK 编码的 .bat 是**文本**，必须计入（只认 UTF-8 会把它当二进制丢掉）',
    /src\/ui\/legacy\.bat/.test(lineOf('ui_files')) &&
    !/legacy\.bat/.test(lineOf('nontext')),
    `ui_files=${lineOf('ui_files')} nontext=${lineOf('nontext')}`)
  check('★ 反例：node_modules 被排除并点名',
    /skipped \[.*browser-profile/.test(out) && /node_modules/.test(out),
    (out.match(/skipped \[[^\]]*\]/) || [''])[0])

  fs.rmSync(fx, { recursive: true, force: true })

  console.log(`\nRESULT ${pass} / ${fail}`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main()
