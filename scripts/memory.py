#!/usr/bin/env python3
"""方寸 · 记忆检索（零依赖，只读）

暮雨 2026-11-17 定：
  · 索引形态 = **jsonl**（零依赖、可 grep、可追加）
  · 自动抽取 = **不做**（"我倾向于都不抽，没空搞"）
  · 主体 = **长期教训与纪律**（项目记忆的一部分，其中有可跨项目应用的）

所以这套东西很小：手工录入 markdown，一个 jsonl 索引，一个只读检索。
不抽日志、不抽决策、不向量化 —— 没让你做的都没做。

用法：
  python scripts/memory.py                      # 列全部（按时间倒序）
  python scripts/memory.py --type 事故
  python scripts/memory.py --project dsh-fangcun
  python scripts/memory.py --scope 跨项目        # 只看能跨项目用的
  python scripts/memory.py --q "kill"
  python scripts/memory.py --all                # 含已撤销
  python scripts/memory.py --check              # 校验索引与文件是否一致（非零退出=不一致）
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM_DIR = os.path.join(ROOT, 'memory')
INDEX = os.path.join(MEM_DIR, 'index.jsonl')

FM_RE = re.compile(r'^---\s*$', re.M)


def parse_frontmatter(text):
    """手写极简 frontmatter 解析（零依赖；项目红线不引 yaml）。

    ⚠ 解析不了的**原样留着**，绝不静默变空串 ——
       本仓栽过：英文键读中文 frontmatter，整列变空、退出码 0、没人发现。
    """
    m = list(FM_RE.finditer(text))
    if len(m) < 2:
        return {}, text
    fm = text[m[0].end():m[1].start()]
    body = text[m[1].end():]
    data = {}
    for line in fm.splitlines():
        line = line.rstrip()
        if not line or line.startswith('#') or ':' not in line:
            continue
        k, v = line.split(':', 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        if v.startswith('[') and v.endswith(']'):
            v = [x.strip().strip("'\"") for x in v[1:-1].split(',') if x.strip()]
        data[k] = v
    return data, body


def scan_files():
    """从磁盘扫真实文件（索引是派生数据，不是真相源）。"""
    rows = []
    if not os.path.isdir(MEM_DIR):
        return rows
    for dirpath, _dn, filenames in os.walk(MEM_DIR):
        for fn in filenames:
            if not fn.endswith('.md') or fn == 'README.md':
                continue
            p = os.path.join(dirpath, fn)
            try:
                with open(p, 'r', encoding='utf-8') as f:
                    text = f.read()
            except OSError as e:
                rows.append({'path': os.path.relpath(p, ROOT).replace('\\', '/'),
                             'id': '', 'error': str(e)})
                continue
            fm, body = parse_frontmatter(text)
            rows.append({
                'id': fm.get('id', ''),
                'type': fm.get('类型', ''),
                'source': fm.get('来源', ''),
                'time': fm.get('时间', ''),
                'project': fm.get('项目', ''),
                'status': fm.get('状态', '有效'),
                'impact': fm.get('影响', ''),
                'scope': fm.get('适用范围', ''),
                'tags': fm.get('tags', []),
                'path': os.path.relpath(p, ROOT).replace('\\', '/'),
                'body': body,
                '_raw': text,
            })
    rows.sort(key=lambda r: r.get('time') or '', reverse=True)
    return rows


def build_index(rows):
    """jsonl：一行一条，只存**指针与摘要**，不存原文（防两份真相）。"""
    out = []
    for r in rows:
        body = (r.get('body') or '').strip()
        # 标题 = 第一个 # 行；摘要 = 接下来第一段非空文字的前 120 字
        title, summary = '', ''
        for line in body.splitlines():
            s = line.strip()
            if not s:
                continue
            if s.startswith('#') and not title:
                title = s.lstrip('#').strip()
                continue
            if title:
                summary = s[:120]
                break
        out.append({
            'id': r.get('id', ''),
            '类型': r.get('type', ''),
            '适用范围': r.get('scope', ''),
            '项目': r.get('project', ''),
            '时间': r.get('time', ''),
            '状态': r.get('status', ''),
            '影响': r.get('impact', ''),
            '标题': title,
            '摘要': summary,
            '源文件': r.get('path', ''),
            '来源': r.get('source', ''),
        })
    return out


def match(r, a):
    if not a.all and r.get('status') == '已撤销':
        return False
    if a.type and a.type not in str(r.get('type', '')):
        return False
    if a.scope:
        # ⚠ 「跨项目」既可以写在 适用范围，也可以直接写在 项目 里（我第一版就写成 `项目: 跨项目`）。
        #   两个字段都认 —— 否则检索悄悄查不到，用户以为没这条。这是本仓记过多次的同一类病。
        if a.scope not in str(r.get('scope', '')) and a.scope != str(r.get('project', '')):
            return False
    if a.project and a.project != str(r.get('project', '')):
        return False
    if a.q:
        hay = (str(r.get('_raw', '')) + ' ' + str(r.get('id', ''))).lower()
        if a.q.lower() not in hay:
            return False
    return True


def main():
    ap = argparse.ArgumentParser(description='方寸记忆检索（只读）')
    ap.add_argument('--type', help='事故 / 教训 / 纪律 / 决定 / 偏好')
    ap.add_argument('--scope', help='适用范围，如「跨项目」')
    ap.add_argument('--project', help='项目 id')
    ap.add_argument('--q', help='全文关键词（含原文）')
    ap.add_argument('--all', action='store_true', help='含已撤销')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--rebuild', action='store_true', help='重建 memory/index.jsonl')
    ap.add_argument('--check', action='store_true', help='校验索引与源文件一致')
    a = ap.parse_args()

    rows = scan_files()

    if a.rebuild:
        os.makedirs(MEM_DIR, exist_ok=True)
        idx = build_index(rows)
        with open(INDEX, 'w', encoding='utf-8', newline='\n') as f:
            for e in idx:
                f.write(json.dumps(e, ensure_ascii=False) + '\n')
        print(f'已重建索引：{INDEX}（{len(idx)} 条）')
        return 0

    if a.check:
        # 索引是派生数据；对不上就红。**0 条也红** —— 那是读法坏了，不是没有数据。
        if not os.path.exists(INDEX):
            print('FAIL 索引不存在，先跑 --rebuild')
            return 1
        idx = []
        bad = 0
        # ⚠ 用 utf-8-sig 读：Windows 上 Set-Content / Out-File 常带 BOM，
        #   带 BOM 的 jsonl 用 utf-8 读会当场 JSONDecodeError（我实测栽过）。
        #   BOM 不是"坏数据"，是编码前缀 —— 静默容忍它，但**坏行必须点名**。
        with open(INDEX, 'r', encoding='utf-8-sig') as f:
            for lineno, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    idx.append(json.loads(line))
                except json.JSONDecodeError as e:
                    print(f'FAIL 索引第 {lineno} 行不是合法 JSON：{e}')
                    bad += 1
        if len(idx) != len(rows):
            print(f'FAIL 条数不一致：索引 {len(idx)} vs 源文件 {len(rows)}')
            bad += 1
        idx_by_src = {e.get('源文件'): e for e in idx}
        for r in rows:
            if r.get('path') not in idx_by_src:
                print(f'FAIL 索引里缺：{r.get("path")}')
                bad += 1
            elif not idx_by_src[r['path']].get('id'):
                print(f'FAIL 索引条目没有 id：{r.get("path")}')
                bad += 1
        for src in idx_by_src:
            if not os.path.exists(os.path.join(ROOT, src or '')):
                print(f'FAIL 索引指向的文件不存在：{src}')
                bad += 1
        if not rows and not idx:
            print('FAIL 记忆库是空的 —— 若你确实还没录，请忽略；否则是扫描坏了')
            bad += 1
        print('RESULT 一致' if not bad else f'RESULT {bad} 处不一致')
        return 1 if bad else 0

    picked = [r for r in rows if match(r, a)]

    if a.json:
        print(json.dumps([{k: v for k, v in r.items() if k not in ('body', '_raw')}
                          for r in picked], ensure_ascii=False, indent=2))
        return 0

    if not picked:
        if not rows:
            print('记忆库还没有任何条目（memory/ 下没有 *.md，README 除外）。')
            print('这不是"筛出来没有" —— 是还没录过。')
        else:
            print(f'筛出来 0 条（库中共 {len(rows)} 条）。放宽条件：--all / 去掉 --type。')
        return 0

    print(f'共 {len(picked)} 条\n')
    for r in picked:
        print(f"[{r.get('type') or '?'}] {r.get('id') or r['path']}")
        meta = []
        if r.get('time'):
            meta.append(str(r['time'])[:16].replace('T', ' '))
        if r.get('scope'):
            meta.append('范围:' + str(r['scope']))
        if r.get('project'):
            meta.append(str(r['project']))
        if r.get('impact'):
            meta.append('影响 ' + str(r['impact']))
        if r.get('status') and r['status'] != '有效':
            meta.append('【' + str(r['status']) + '】')
        if meta:
            print('    ' + ' · '.join(meta))
        print('    ' + r.get('path', ''))
        print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
