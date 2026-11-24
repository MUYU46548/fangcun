#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""记忆检索口径 · 守卫（2026-11-24）

## 它防的是什么（真实现场）

`scripts/memory.py --q` 的检索文本原先拼的是 **`_raw`（整篇文件，含 frontmatter）**，
于是**键名被当成内容**：

    --q 格式   → 34/34     （每条都有 `格式: 2` 这一行）
    --q 状态   → 34/34
    --q 来源   → 34/34
    --q 证据   → 34/34
    --q 类型   → 34/34

搜什么都能搜到全部 —— 这比"搜不到"更坏：搜不到时人还知道换个词，
搜到 34 条时人会以为"记忆里全是这东西"。

## 判据（三条，每条都有反例）

 ① **键名不再参与检索**：把 frontmatter 的键名当查询词，命中数必须 **< 库总条数**
    （键名不是内容；只要还等于总条数，就说明 `_raw` 又被拼回去了）。
 ② **真内容仍然搜得到**：拿已知存在于某条 claim/证据里的词，必须命中 **> 0**。
    （只做 ① 不做 ②，把 haystack 清空也能"通过"——那是最典型的假绿。）
 ③ **与 TS 侧同口径**：同一条查询，Python 与 TS `searchMemory` 的命中数必须一致。
    两侧各写一套检索、口径不同，是"记忆有没有用"这件事反复说不清的真因。

反例自证（`--self-check`）：把 `_raw` 拼回 haystack → ① 必须精确变红；
把 haystack 清空 → ② 必须精确变红。**两条都能变红，这个守卫才算数。**

运行：
    python scripts/test/check-memory-search.py              # 跑判据
    python scripts/test/check-memory-search.py --self-check # 反例自证
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MEM_PY = os.path.join(ROOT, 'scripts', 'memory.py')
DIST_MEM = os.path.join(ROOT, 'desktop', 'dist', 'main', 'services', 'memory.js')

# 这些词**只出现在 frontmatter 键名里**，任何 claim / 证据正文都不该靠它们命中。
# 它们是"结构"不是"内容" —— 拿它们搜到东西就是口径错。
KEYNAME_PROBES = ['格式', '类型', '来源']
# 这些词是**真内容**，库里有条目写着它们；必须搜得到。
CONTENT_PROBES = ['kill', 'frontmatter', 'worktree']
# 这些词在 key 里也有、正文里也有（如"跨项目"），只做两侧对账，不做绝对断言。
PARITY_PROBES = ['项目', '状态', '证据', '备份', '日志']

MAX_HITS = 40  # 命中数取回上限（够判断"是不是全库"）


def run_memory_q(q):
    """跑一次 `memory.py --q <q> --json`，返回条目列表。"""
    out = subprocess.run(
        [sys.executable, MEM_PY, '--q', q, '--json'],
        cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace',
    )
    if out.returncode != 0:
        raise RuntimeError('memory.py 退出码 %s：%s' % (out.returncode, (out.stderr or '')[:300]))
    txt = (out.stdout or '').strip()
    return json.loads(txt) if txt else []


def run_memory_all():
    out = subprocess.run(
        [sys.executable, MEM_PY, '--json'],
        cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace',
    )
    txt = (out.stdout or '').strip()
    return json.loads(txt) if txt else []


def ts_hits(q):
    """TS 侧 `searchMemory({q})` 的命中数。编译产物不在就返回 None（不假装通过）。"""
    if not os.path.exists(DIST_MEM):
        return None
    script = (
        'const path=require("path");'
        'const data=require(%s);'
        'if(data.setDataDir)data.setDataDir(%s);'
        'const m=require(%s);'
        'const r=m.searchMemory({q:%s,limit:50,includePending:true,includeRevoked:true});'
        'process.stdout.write(String(r.rows.length));'
        % (
            json.dumps(os.path.join(ROOT, 'desktop', 'dist', 'main', 'data', 'index.js')),
            json.dumps(ROOT),
            json.dumps(DIST_MEM),
            json.dumps(q),
        )
    )
    tmp = os.path.join(ROOT, 'scripts', 'test', '.tmp-memsearch.cjs')
    try:
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
            f.write(script)
        out = subprocess.run(['node', tmp], cwd=ROOT, capture_output=True, text=True,
                             encoding='utf-8', errors='replace')
        if out.returncode != 0:
            return None
        return int((out.stdout or '0').strip() or 0)
    except Exception:
        return None
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def check(haystack_mode='normal'):
    """返回 (pass, fail, failures)。haystack_mode: normal / raw（反例①）/ empty（反例②）。"""
    if haystack_mode != 'normal':
        patch_memory_py(haystack_mode)

    p = f = 0
    bad = []

    def ok(name, cond, detail=''):
        nonlocal p, f
        if cond:
            p += 1
            print('PASS  ' + name)
        else:
            f += 1
            bad.append(name + (' :: ' + detail if detail else ''))
            print('FAIL  ' + name + ('  -> ' + detail if detail else ''))

    try:
        total = len(run_memory_all())
        ok('★ 库非空（0 条时下面的断言全是空转）', total > 0, 'total=%d' % total)

        print('\n-- ① 键名不再参与检索 --')
        for q in KEYNAME_PROBES:
            n = len(run_memory_q(q))
            ok('键名 “%s” 命中 %d < 总条数 %d' % (q, n, total), n < total,
               '命中全部 = frontmatter 键名又被当内容搜了')

        print('\n-- ② 真内容仍然搜得到 --')
        for q in CONTENT_PROBES:
            n = len(run_memory_q(q))
            ok('真内容 “%s” 命中 %d > 0' % (q, n), n > 0, '把内容也搜没了')

        print('\n-- ③ 与 TS 侧同口径 --')
        if not os.path.exists(DIST_MEM):
            ok('编译产物存在（否则这一节是空转）', False, DIST_MEM + ' 不存在，先 npm run build')
        else:
            for q in PARITY_PROBES + KEYNAME_PROBES + CONTENT_PROBES:
                py = len(run_memory_q(q))
                ts = ts_hits(q)
                if ts is None:
                    ok('TS 侧可调用（%s）' % q, False, 'node 跑不起来或编译产物加载失败')
                    continue
                # Python 的 --json 已排除 _raw/evidence 字段，TS 的 limit 上限 50；
                # 两侧都按 status 全含（--all 等价 includeRevoked/includePending）。
                ok('“%s” Python %d == TS %d' % (q, py, ts), py == ts,
                   '两侧口径分叉：改了一边忘了另一边')
    finally:
        if haystack_mode != 'normal':
            patch_memory_py('restore')

    return p, f, bad


BACKUP = MEM_PY + '.guard-backup'


def patch_memory_py(mode):
    """把 memory.py 的 haystack 临时改成反例形态（或还原）。"""
    if mode == 'restore':
        if os.path.exists(BACKUP):
            os.replace(BACKUP, MEM_PY)
        return
    if not os.path.exists(BACKUP):
        with open(MEM_PY, 'r', encoding='utf-8-sig') as f:
            src = f.read()
        with open(BACKUP, 'w', encoding='utf-8', newline='\n') as f:
            f.write(src)
    else:
        with open(BACKUP, 'r', encoding='utf-8-sig') as f:
            src = f.read()
    if mode == 'raw':
        # 反例①：把整篇原文拼回去（这就是事故前的写法）
        new = src.replace(
            "        str(r.get('evidence', '')),\n    ]).lower()",
            "        str(r.get('evidence', '')),\n        str(r.get('_raw', '')),\n    ]).lower()",
        )
    elif mode == 'empty':
        # 反例②：haystack 清空（"搜不到"的极端，但 ① 会假绿）
        new = src.replace(
            "    return ' '.join([\n        str(r.get('claim', '')),",
            "    return ''\n    return ' '.join([\n        str(r.get('claim', '')),",
        )
    else:
        raise ValueError(mode)
    if new == src:
        raise RuntimeError('反例注入失败：memory.py 的 search_hay 结构与预期不符（守卫要跟着改）')
    with open(MEM_PY, 'w', encoding='utf-8', newline='\n') as f:
        f.write(new)


def main():
    self_check = '--self-check' in sys.argv
    print('== 记忆检索口径 · 守卫 ==\n')

    if not os.path.exists(MEM_PY):
        print('FAIL  找不到 scripts/memory.py')
        print('\nRESULT 0 / 1')
        return 1

    p, f, bad = check('normal')

    if self_check:
        print('\n== 反例自证（两条都必须精确变红）==\n')
        for mode, want, label in (
            ('raw', 1, '把 _raw 拼回 haystack → ① 键名断言必须红'),
            ('empty', 2, '把 haystack 清空 → ② 真内容断言必须红'),
        ):
            print('-- %s --' % label)
            _p, _f, _bad = check(mode)
            # 只统计"该红的那类"：反例下必然有红，且红里必须出现我们指定的条目
            hit = [b for b in _bad if want == 1 and 'frontmatter 键名又被当内容搜了' in b]
            hit2 = [b for b in _bad if want == 2 and '把内容也搜没了' in b]
            got = hit or hit2
            if got:
                p += 1
                print('PASS  反例精确变红（%d 条）' % len(got))
            else:
                f += 1
                bad.append(label)
                print('FAIL  反例没有变红 —— 这个守卫抓不到它自己该抓的错')

    print('\nRESULT %d / %d' % (p, f))
    if bad:
        print('失败项：')
        for b in bad:
            print('  · ' + b)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
