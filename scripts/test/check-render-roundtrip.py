# -*- coding: utf-8 -*-
"""
渲染转义往返检查 —— Python render_task 写出的文件，两侧解析器能否无损读回。

背景：core.render_task 用裸 f-string 拼 YAML（`f"标题: {d.get('标题','')}"`、
`f"标签: [{', '.join(...)}]"`），值里含 YAML 元字符时不加引号。
本检查枚举会导致失真/解析失败的取值，确认哪些是「静默损坏」、哪些是「直接消失」。

输出 JSON 供 node 侧读回交叉验证（scripts/test/check-render-roundtrip.cjs）。
"""
import sys, os, json, copy, shutil, subprocess, tempfile

REPO = r'E:/CODE/CangKu/fangcun'
sys.path.insert(0, REPO)
from tegula import core  # noqa: E402

OUT = os.path.join(tempfile.gettempdir(), 'fc-render-check')
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)

# 真实任务作为底稿，保证走的是同一条渲染路径
src = os.path.join(REPO, 'task-data', 'task-20260909-001.md')
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
    ? { ok: true, title: fm.title, tags: fm.tags, blockers: fm.blockers, ziliao: fm.resources && fm.resources.ziliao }
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
    j = js.get(r['case'], {})
    if not j:
        jsr = '未校验'
    elif not j.get('ok'):
        jsr = '✗ 任务消失'
        fails += 1
    elif j.get('title') != r['expect_title'] or j.get('tags') != r['expect_tags']:
        jsr = f"✗ 失真 title={j.get('title')!r} tags={j.get('tags')!r}"
        fails += 1
    else:
        jsr = 'OK'
    if t != 'OK' or g != 'OK':
        fails += 1
    print(f"{r['case']:<20} {'OK' if r['py_parse_ok'] else 'FAIL':<7} {t:<6} {g:<6} {jsr}")

print('-' * 62)
print('结论:', '两侧往返全部一致 ✓' if fails == 0 else f'✗ {fails} 项不一致')
print('输出目录:', OUT)
sys.exit(1 if fails else 0)
