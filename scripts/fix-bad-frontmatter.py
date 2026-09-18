# -*- coding: utf-8 -*-
"""
修复历史遗留的非法 frontmatter —— 让任务在严格 YAML 解析器（桌面版）下也能被读到。

背景
----
`tegula/core.py` 的 render_task 原先用裸 f-string 拼值，含 `: `、以 `[`/`#`/`>` 开头、
或本身带换行的值会写出**非法 YAML**。桌面版 parseTask 用严格 js-yaml，
解析失败即 return null 并被 loadTasks 静默跳过 ——
表现为「Python CLI 里明明有的任务，桌面版看板里就是没有」。

写入侧的转义已在 core.py 的 `yaml_scalar()` 修好（2026-09-18），
但**已经写坏的存量文件需要单独修**，否则那些任务继续隐身。

本脚本做最小必要修复
--------------------
只重写 frontmatter 的键值行，**frontmatter 之外的内容逐字节保留**。
- 值形如 `[...]` → 按 flow 列表重渲染（每项按需加引号）
- 值形如 `{...}` → 视为 JSON，原样保留
- 字段后跟全为缩进的续行 → 块结构（如 `资源:`），原样保留
- 其余单行/多行值 → 用 yaml_scalar 转义
- 无需修改的文件不动（幂等，重复运行无副作用）

默认 dry-run
------------
不带 --apply 只打印将要修改什么，不落盘。
加 --apply 才写入，且逐文件先备份到同目录 .backup/ 下。

用法
----
    python scripts/fix-bad-frontmatter.py                    # 预演（仓库 task-data）
    python scripts/fix-bad-frontmatter.py --root <目录>      # 指定数据目录
    python scripts/fix-bad-frontmatter.py --apply            # 真正修复
"""
import sys, os, re, json, shutil, argparse, subprocess, tempfile
from datetime import datetime

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
from tegula.core import yaml_scalar, split_flow_list, unquote_scalar  # noqa: E402

FM_OPEN_RE = re.compile(r'^(---|===)\s*$', re.M)
KV_RE = re.compile(r'^([^\s:][^:]*):\s?(.*)$')
# 这些字段的值是结构化块（映射/子项），不参与标量转义
BLOCK_KEYS = {'资源'}


def render_value(key, value_lines):
    """返回 (渲染结果, 是否有实质改动)。

    关键：**只在真会解析失败时才改**。判定直接用 yaml_scalar 的自身输出做比较 ——
    已经合法的值原样返回，避免脚本把几十个正常文件全部重写一遍
    （那会让 diff 失去意义，也无谓改动用户数据）。
    """
    first = value_lines[0]
    rest = value_lines[1:]

    # 块结构：后续行全部以空白开头 → 原样保留（如 资源: /   资料: ...）
    if rest and all((not l.strip()) or l[:1].isspace() for l in rest):
        return '\n'.join(value_lines), False
    if key in BLOCK_KEYS:
        return '\n'.join(value_lines), False

    if rest:
        # 多行值（续行未缩进）—— 这正是 task-20260914-002 的坏法，必然需要转义
        merged = '\n'.join([first.rstrip()] + [l.rstrip() for l in rest])
        return yaml_scalar(merged), True

    raw = first
    s = raw.strip()
    if s == '':
        return raw, False
    # 已经是引号包裹的合法标量 → 原样保留。
    # 必须放在最前面：本脚本处理的是**已渲染好的 YAML 片段**，引号是语法不是内容。
    # 曾经的 bug：把 `创建: '2026-09-05T05:20:28.000Z'`（桌面版 yaml.dump 为防 timestamp
    # 类型漂移而加的单引号）当成"待转义的值"又包一层，写成 `"'2026-...'"` ——
    # 值里凭空多出一层单引号。判定层次混淆的教训。
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return raw, False
    if s.startswith('[') and s.endswith(']'):
        items = split_flow_list(s[1:-1].strip())
        out = '[' + ', '.join(yaml_scalar(x, in_flow=True) for x in items) + ']' if items else '[]'
        return (out, True) if out != s else (raw, False)
    if s.startswith('{') and s.endswith('}'):
        return raw, False  # JSON 对象（plan 字段），两侧都按对象解析
    esc = yaml_scalar(s)
    return (esc, True) if esc != s else (raw, False)


def fix_text(text):
    """返回 (新文本, 改动说明列表)。无需修改时新文本为 None。

    全程按 LF 处理，写回时还原原主行尾 —— 避免 CRLF 文件被搅成混合行尾。
    """
    nl = '\r\n' if '\r\n' in text else '\n'
    lf = text.replace('\r\n', '\n')

    m = re.match(r'^(---|===)[ \t]*\n', lf)
    if not m:
        return None, ['非任务文件（无 frontmatter 起始行）']
    open_line = m.group(1)
    start = m.end()
    end_m = re.search(r'^(---|===)[ \t]*$', lf[start:], re.M)
    if not end_m:
        return None, ['frontmatter 未闭合']
    end = start + end_m.start()
    fm_raw = lf[start:end]
    body = lf[end:]

    # 归类：字段起始行 + 续行；字段出现前的散行单独留着
    fields = []          # [key, [value_lines]]
    orphans = []
    for ln in fm_raw.split('\n'):
        km = KV_RE.match(ln)
        if km and not ln[:1].isspace():
            fields.append([km.group(1), [km.group(2)]])
        elif fields:
            fields[-1][1].append(ln)
        elif ln.strip():
            orphans.append(ln)

    if not fields:
        return None, ['frontmatter 无可识别字段']

    # 先判定：没有任何字段需要改动 → 直接不动文件（绝大多数情况走这里）
    plan = []
    changes = []
    for key, vlines in fields:
        rendered, changed = render_value(key, vlines)
        if changed:
            changes.append(f'{key}: {" ".join(vlines).strip()[:40]!r} → {rendered.strip()[:70]!r}')
        plan.append((key, vlines, rendered, changed))

    if not changes:
        return None, []

    out_lines = list(orphans)
    for key, vlines, rendered, changed in plan:
        if changed:
            out_lines.append(f'{key}: {rendered}' if rendered != '' else f'{key}:')
        else:
            head = f'{key}: {vlines[0]}' if vlines[0] != '' else f'{key}:'
            out_lines.append(head)
            out_lines.extend(vlines[1:])

    new_lf = open_line + '\n' + '\n'.join(out_lines) + '\n' + body.lstrip('\n')
    new_text = new_lf.replace('\n', nl)
    if new_text == text:
        return None, []
    return new_text, changes


def iter_task_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('.backup', '.trash')]
        for fn in sorted(filenames):
            if fn.endswith('.md') and not fn.startswith('_'):
                yield os.path.join(dirpath, fn)


def verify_with_desktop_parser(files, timeout=180):
    """用桌面版 parseTask（严格 js-yaml）复验修复结果。

    返回 (失败文件列表, 是否真的执行了复验)。
    找不到 node 或未编译 dist 时返回 (None, False) —— 此时绝不能声称"已验证"。
    """
    if not files:
        return [], True
    node = shutil.which('node')
    dist = os.path.join(REPO, 'desktop', 'dist', 'main', 'data', 'index.js')
    stub = os.path.join(REPO, 'scripts', 'test', 'electron-stub.cjs')
    if not node or not os.path.exists(dist) or not os.path.exists(stub):
        return None, False

    src = (
        "const path=require('path'),os=require('os'),fs=require('fs'),Module=require('module')\n"
        "const orig=Module._resolveFilename\n"
        f"Module._resolveFilename=function(r,...a){{if(r==='electron')return {json.dumps(stub)};return orig.call(this,r,...a)}}\n"
        "process.env.FC_TEST_USERDATA=path.join(os.tmpdir(),'fc-fixverify-'+Date.now())\n"
        f"const data=require({json.dumps(dist)})\n"
        "const files=JSON.parse(fs.readFileSync(process.argv[2],'utf-8'))\n"
        "process.stdout.write(JSON.stringify(files.filter(f=>!data.parseTask(f))))\n"
    )
    with tempfile.TemporaryDirectory() as td:
        jsf = os.path.join(td, 'verify.cjs')
        lsf = os.path.join(td, 'files.json')
        with open(jsf, 'w', encoding='utf-8') as f:
            f.write(src)
        with open(lsf, 'w', encoding='utf-8') as f:
            json.dump(files, f, ensure_ascii=False)
        try:
            p = subprocess.run([node, jsf, lsf], capture_output=True, text=True, timeout=timeout)
        except Exception:
            return None, False
    if p.returncode != 0 or not p.stdout.strip():
        return None, False
    return json.loads(p.stdout), True


def restore_latest_backup(path):
    """从同目录 .backup/ 下最近一次 .prefix.bak 还原。"""
    d = os.path.join(os.path.dirname(path), '.backup')
    base = os.path.basename(path)
    if not os.path.isdir(d):
        return False
    cands = sorted(f for f in os.listdir(d)
                   if f.startswith(base + '.') and f.endswith('.prefix.bak'))
    if not cands:
        return False
    shutil.copy2(os.path.join(d, cands[-1]), path)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', action='append', default=None,
                    help='数据目录（task-data 的父目录或 task-data 本身），可重复')
    ap.add_argument('--apply', action='store_true', help='真正写入（默认只预演）')
    args = ap.parse_args()

    roots = args.root or [os.path.join(REPO, 'task-data')]
    stamp = datetime.now().strftime('%Y%m%d%H%M%S')

    total = fixed = skipped = 0
    changed_files = []
    for root in roots:
        td = os.path.join(root, 'task-data') if os.path.isdir(os.path.join(root, 'task-data')) else root
        if not os.path.isdir(td):
            print(f'!! 目录不存在，跳过: {td}')
            continue
        print(f'\n== {td} ==')
        for p in iter_task_files(td):
            total += 1
            try:
                with open(p, encoding='utf-8', newline='') as f:
                    text = f.read()
            except Exception as e:
                print(f'  !! 读取失败 {os.path.basename(p)}: {e}')
                continue
            new_text, changes = fix_text(text)
            if new_text is None:
                if changes:
                    skipped += 1
                continue
            fixed += 1
            print(f'  [修] {os.path.basename(p)}')
            for c in changes:
                print(f'       {c}')
            if args.apply:
                bak = os.path.join(os.path.dirname(p), '.backup',
                                   f'{os.path.basename(p)}.{stamp}.prefix.bak')
                os.makedirs(os.path.dirname(bak), exist_ok=True)
                shutil.copy2(p, bak)
                tmp = p + '.tmp'
                with open(tmp, 'w', encoding='utf-8', newline='') as f:
                    f.write(new_text)
                with open(tmp, encoding='utf-8', newline='') as f:
                    if f.read() != new_text:
                        os.remove(tmp)
                        raise RuntimeError(f'读回校验失败: {p}')
                os.replace(tmp, p)
                changed_files.append(p)

    print(f'\n扫描 {total} 个文件：{"已修复" if args.apply else "待修复"} {fixed} 个'
          f'，跳过 {skipped} 个（非任务文件或无法归属）')
    if not args.apply and fixed:
        print('这是预演。加 --apply 才会写入（写入前逐文件备份到 .backup/）')

    # 复验：修复结果必须能被桌面版的严格 js-yaml 吃下，否则回滚 —— 不做"假成功"
    if args.apply and changed_files:
        bad, ran = verify_with_desktop_parser(changed_files)
        if not ran:
            print('!! 未能复验（找不到 node 或 desktop/dist 未编译）—— 结果未经严格解析器确认')
        elif bad:
            print(f'!! 复验失败 {len(bad)} 个，从备份回滚：')
            for f in bad:
                print(f'   {"已回滚" if restore_latest_backup(f) else "回滚失败！"} {os.path.basename(f)}')
            sys.exit(1)
        else:
            print(f'复验通过：{len(changed_files)} 个文件均可被桌面版严格解析 ✓')


if __name__ == '__main__':
    main()
