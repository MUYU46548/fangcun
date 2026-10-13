# -*- coding: utf-8 -*-
"""
渲染转义往返检查 —— Python render_task 写出的文件，两侧解析器能否无损读回。

背景：core.render_task 用裸 f-string 拼 YAML（`f"标题: {d.get('标题','')}"`、
`f"标签: [{', '.join(...)}]"`），值里含 YAML 元字符时不加引号。
本检查枚举会导致失真/解析失败的取值，确认哪些是「静默损坏」、哪些是「直接消失」。

输出 JSON 供 node 侧读回交叉验证（scripts/test/check-render-roundtrip.cjs）。
"""
import sys, os, json, copy, shutil, subprocess, tempfile

# REPO 可传参（本机默认保持原路径）；底稿任务卡不在 git 里，
# 缺失时用 api_new 现场造一张（保证任何干净 clone 都能跑双栈往返）。
REPO = sys.argv[1] if len(sys.argv) > 1 else r'E:/CODE/CangKu/fangcun'
sys.path.insert(0, REPO)
from tegula import core  # noqa: E402

OUT = os.path.join(tempfile.gettempdir(), 'fc-render-check')
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)

# 真实任务作为底稿，保证走的是同一条渲染路径
src = os.path.join(REPO, 'task-data', 'task-20260909-001.md')
if not os.path.exists(src):
    _tmp = tempfile.mkdtemp(prefix='fc-rr-base-')
    _saved_td, _saved_nd = core.TASK_DIR, core._NOTES_DIR
    core.TASK_DIR = _tmp
    try:
        _ok, _tid = core.api_new({
            "标题": "渲染往返底稿（自动生成）",
            "项目": ["fangcun-base"],
            "状态": "待办",
            "优先级": "中",
            "标签": ["看板", "优化"],
            "方案": ["- [ ] 勾选框步骤"],
            "附言": "底稿",
        })
        src = os.path.join(_tmp, _tid + '.md')
    finally:
        core.TASK_DIR, core._NOTES_DIR = _saved_td, _saved_nd
base = core.parse_task(src)
assert base is not None, '底稿解析失败'

CASES = {
    'normal':       {'标题': '普通标题', '标签': ['看板', '优化']},
    'title_hash':   {'标题': '修 bug #紧急'},
    'title_colon':  {'标题': '看板: 重构视图'},
    'title_bracket': {'标题': '[WIP] 重构'},
    'title_quote':  {'标题': "他说'这样写'就行"},
    'tag_hash':     {'标题': 'ok 标题', '标签': ['#bug']},
    'tag_comma':    {'标题': 'ok 标题', '标签': ['a,b']},
    'tag_colon':    {'标题': 'ok 标题', '标签': ['前端: 视图']},
    'proj_comma':   {'项目': ['a,b']},
    'blocker_hash': {'阻塞': ['#task-1']},
    'ziliao_colon': {'资源': {'资料': 'E:/a: b.md', '工具': []}},
    # 架构图（2026-10-13 · 方案 A）：值是 LayerDiagramSpec 的 JSON。含 `{ } " :` 等元字符，
    # 必须靠标量引号保住；两侧读回都得是**同一个字符串**。
    'arch_json':    {'标题': 'ok 标题', '架构': '{"lanes":[{"name":"核心层","cards":[{"label":"用户"},{"label":"订单"}]}],"between":["HTTP / WSS"],"width":900}'},
    # ⚠ 反例：手工写成 YAML 嵌套映射（解析成 dict）也必须安全 —— render_task 要把它 json.dumps
    #   回**标量**，绝不许原样吐出嵌套映射（全仓只许 1 处的红线）。
    'arch_nested':  {'标题': 'ok 标题', '架构': {'lanes': [{'name': '网关层', 'cards': [{'label': 'API Gateway'}]}], 'width': 680}},
}

report = []
for name, patch in CASES.items():
    d = copy.deepcopy(base)
    for k, v in patch.items():
        d[k] = v
    fp = os.path.join(OUT, f'{name}.md')
    try:
        content = core.render_task(d)
    except Exception as e:
        report.append({'case': name, 'render': f'EXCEPTION: {e}'})
        continue
    with open(fp, 'w', encoding='utf-8') as f:
        f.write(content)

    # Python 侧读回
    try:
        back = core.parse_task(fp)
        py_ok = back is not None
    except Exception as e:
        back, py_ok = None, False

    expect_title = patch.get('标题', base.get('标题'))
    expect_tags = patch.get('标签', base.get('标签'))

    got_title = (back or {}).get('标题')
    got_tags = (back or {}).get('标签')

    # 架构图：期望值是**标量字符串**（dict/list 输入先 json.dumps 回标量）
    expect_arch = patch.get('架构', base.get('架构'))
    if isinstance(expect_arch, (dict, list)):
        expect_arch = json.dumps(expect_arch, ensure_ascii=False)
    expect_arch = None if expect_arch in (None, '') else str(expect_arch)
    got_arch = (back or {}).get('架构')
    arch_ok = (expect_arch is None and not got_arch) or (got_arch == expect_arch)

    report.append({
        'case': name,
        'file': fp,
        'render_ok': True,
        'py_parse_ok': py_ok,
        'expect_title': expect_title,
        'got_title': got_title,
        'title_ok': got_title == expect_title,
        'expect_tags': expect_tags,
        'got_tags': got_tags,
        'tags_ok': got_tags == expect_tags,
        'expect_arch': expect_arch,
        'got_arch': got_arch,
        'arch_ok': arch_ok,
        # 只摘录受影响的 frontmatter 行，便于人工核对
        'fm_lines': [l for l in content.split('\n')[1:22] if l.strip()],
    })

with open(os.path.join(OUT, 'report.json'), 'w', encoding='utf-8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)

# ── 桌面版（严格 js-yaml）交叉验证 ────────────────────────────────────
# 单侧绿不算数：真实链路是「Python CLI 写 → 桌面版读」，必须两侧都验。
NODE_SRC = r'''
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module')
const REPO = process.argv[2], OUT = process.argv[3]
const STUB = path.join(REPO, 'scripts/test/electron-stub.cjs')
const orig = Module._resolveFilename
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron') return STUB
  return orig.call(this, r, ...a)
}
process.env.FC_TEST_USERDATA = path.join(os.tmpdir(), 'fc-rr-' + Date.now())
const data = require(path.join(REPO, 'desktop/dist/main/data/index.js'))
const res = {}
for (const f of fs.readdirSync(OUT).filter(x => x.endsWith('.md'))) {
  const t = data.parseTask(path.join(OUT, f))
  const fm = t ? t.fm : {}
  res[f.replace(/\.md$/, '')] = t
    ? { ok: true, title: fm.title, tags: fm.tags, blockers: fm.blockers, ziliao: fm.resources && fm.resources.ziliao, arch: fm.architecture }
    : { ok: false }
}
process.stdout.write(JSON.stringify(res))
'''

NODE_CHECK = os.path.join(OUT, '_check.cjs')
with open(NODE_CHECK, 'w', encoding='utf-8') as f:
    f.write(NODE_SRC)

js = {}
try:
    proc = subprocess.run(['node', NODE_CHECK, REPO, OUT], capture_output=True, text=True, timeout=180)
    if proc.returncode == 0 and proc.stdout.strip():
        js = json.loads(proc.stdout)
    else:
        print('!! 桌面版交叉验证失败:', (proc.stderr or '')[:400])
except Exception as e:
    print('!! 桌面版交叉验证异常:', e)

print('case                 py解析  标题  标签   桌面版读回')
print('-' * 62)
fails = 0
for r in report:
    if 'render' in r:
        print(f"{r['case']:<20} RENDER FAIL: {r['render']}")
        fails += 1
        continue
    t = 'OK' if r['title_ok'] else ('丢失' if r['got_title'] is None else '失真')
    g = 'OK' if r['tags_ok'] else ('丢失' if r['got_tags'] is None else '失真')
    a = 'OK' if r['arch_ok'] else ('丢失' if r['got_arch'] is None else '失真')
    j = js.get(r['case'], {})
    if not j:
        jsr = '未校验'
    elif not j.get('ok'):
        jsr = '✗ 任务消失'
        fails += 1
    elif j.get('title') != r['expect_title'] or j.get('tags') != r['expect_tags']:
        jsr = f"✗ 失真 title={j.get('title')!r} tags={j.get('tags')!r}"
        fails += 1
    elif r['expect_arch'] is not None and j.get('arch') != r['expect_arch']:
        # 架构图：桌面版读回也必须是**同一个字符串**（嵌套映射会在这里现形）
        jsr = f"✗ 架构失真 arch={j.get('arch')!r}"
        fails += 1
    else:
        jsr = 'OK'
    if t != 'OK' or g != 'OK' or a != 'OK':
        fails += 1
    print(f"{r['case']:<20} {'OK' if r['py_parse_ok'] else 'FAIL':<7} {t:<6} {g:<6} 架构{a:<4} {jsr}")

print('-' * 62)
print('结论:', '两侧往返全部一致 ✓' if fails == 0 else f'✗ {fails} 项不一致')
print('输出目录:', OUT)
sys.exit(1 if fails else 0)
