#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""方寸记忆 · 整理体检（2026-11-24）

## 为什么要它（暮雨原话）

> 「我刚开始还会定期整理，后来发现整理消耗的几千万 token 更贵，干脆完全不整理摆烂了」

**那几千万 token 花在错的地方。** 整理需要回答的三个问题，机器全都能算，
而且都是纯字符串运算，**一次模型都不用调**：

    ① 哪些条重复了？（Jaccard 相似度）
    ② 哪些条从没被搜到过？（读 usage.jsonl，30 天窗口）
    ③ 哪些条占着预算但排不进 core？（预算账）

之前没有这条命令，所以"整理"只能靠 agent 把全库读一遍再逐条判断 ——
那正是几千万 token 的来源。**体检的意义是把"你读全库"换成"你看报告"。**

## 判据（可复跑）

    python scripts/memory-audit.py            # 人读报告
    python scripts/memory-audit.py --json     # 机器可读
    python scripts/memory-audit.py --check    # 只有闸：有问题才非零退出

**只读**：不写任何 claim、不重建索引、不改 core.md。

## 三条口径（本仓反复栽过的）

· 「没有记录」≠「从没被用过」。`usage.jsonl` 还没生成时，② 必须说"计量没开始"，
  而不是"$N 条从没被搜到过"。这是本仓的四态混淆，第四次了。
· 「重复」不自动合并。只报，由人决定 —— 自动合并会静默改掉用户的措辞。
· 认不出的时间给 `None` 不是 `0`。
"""
import argparse
import json
import os
import re
import sys
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM = os.path.join(ROOT, 'memory')
CLAIMS = os.path.join(MEM, 'claims')
USAGE = os.path.join(MEM, 'usage.jsonl')
CORE = os.path.join(MEM, 'core.md')

# 与 memoryRank.ts 的 MEMORY_BUDGETS.dedupe 对齐
DEDUPE = 0.8
# 「从没被搜到过」的观察窗口
STALE_DAYS = 30


def parse_frontmatter(text):
    """手写极简 frontmatter 解析（零依赖红线；与 scripts/memory.py 同口径）。"""
    m = list(re.finditer(r'^---\s*$', text, re.M))
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


def section(body, name):
    m = re.search(r'^##\s*%s\s*$' % re.escape(name), body or '', re.M)
    if not m:
        return ''
    rest = body[m.end():]
    nxt = re.search(r'^##\s+', rest, re.M)
    return (rest[:nxt.start()] if nxt else rest).strip()


def norm_tokens(s):
    """归一化 token 集合；与 memoryRank.ts 的 claimTokens 同口径（ASCII 词 + 中文二字组）。"""
    norm = re.sub(r'[^\u4e00-\u9fffa-z0-9]+', '', str(s or '').lower())
    out = set()
    for w in re.findall(r'[a-z0-9_]+', norm):
        if len(w) > 1 or w.isdigit():
            out.add(w)
    for run in re.findall(r'[\u4e00-\u9fff]+', norm):
        for i in range(len(run) - 1):
            out.add(run[i:i + 2])
        if len(run) <= 4:
            out.add(run)
    return out


def jaccard(a, b):
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def load_claims():
    rows = []
    if not os.path.isdir(CLAIMS):
        return rows
    for fn in sorted(os.listdir(CLAIMS)):
        if not fn.endswith('.md'):
            continue
        p = os.path.join(CLAIMS, fn)
        try:
            with open(p, 'r', encoding='utf-8-sig') as f:
                text = f.read()
        except OSError as e:
            rows.append({'file': fn, 'error': str(e)})
            continue
        fm, body = parse_frontmatter(text)
        claim = ' '.join(section(body, '记忆').split())
        rows.append({
            'file': fn,
            'id': str(fm.get('id', '')),
            'code': str(fm.get('编号', '')),
            'type': str(fm.get('类型', '')),
            'status': str(fm.get('状态', '')),
            'project': str(fm.get('项目', '')),
            'importance': fm.get('重要度', '3'),
            'pinned': str(fm.get('钉住', 'false')).lower() == 'true',
            'time': str(fm.get('时间', '')),
            'claim': claim,
            'chars': len(claim),
            '_tok': norm_tokens(claim),
        })
    return rows


def find_duplicates(rows):
    """全库两两比较。45 条 = 990 次，几百条也只在毫秒级；**纯 CPU，零 token**。"""
    out = []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            s = jaccard(rows[i]['_tok'], rows[j]['_tok'])
            if s >= DEDUPE:
                out.append({
                    'a': rows[i]['id'] or rows[i]['file'],
                    'b': rows[j]['id'] or rows[j]['file'],
                    'similarity': round(s, 3),
                    'claimA': rows[i]['claim'],
                    'claimB': rows[j]['claim'],
                })
    out.sort(key=lambda x: -x['similarity'])
    return out


def load_usage():
    """读 usage.jsonl。**不存在时返回 (ok=False, 空)** —— 不许把"没计量"说成"没被用"。"""
    if not os.path.exists(USAGE):
        return False, []
    rows = []
    try:
        with open(USAGE, 'r', encoding='utf-8-sig') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        return False, []
    return True, rows


def parse_iso(s):
    """认不出返回 None，**不当 0**。"""
    v = str(s or '').strip()
    if not v:
        return None
    for fmt in ('%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d'):
        try:
            d = datetime.datetime.strptime(v[:len(datetime.datetime.now().strftime(fmt))], fmt)
            return d
        except ValueError:
            continue
    try:
        return datetime.datetime.fromisoformat(v.replace('Z', '+00:00'))
    except ValueError:
        return None


def stale_ids(rows, usage_ok, usage, now=None):
    """近 N 天从没被任何出口带出去过的 id；以及"只靠自动注入、从没被主动搜过"的 id。

    ⚠ 为什么要分两列（2026-11-24）：第一版只算"没出现在结果里"，于是把
    「core 每轮都注入的条目」也报成"从没被用到过" —— 那是假红。
    四个出口的性质不同：
      · core / briefing —— **自动喂给** agent 的（它不需要搜）；
      · search / read   —— agent **主动去要**的。
    所以：
      · `never_any`  = 四个出口都没有 → 这条大概率是真没用上，是最该看的；
      · `never_active` = 只被自动喂过、从没被主动搜到 → 是"占着 core 位置但没人问"的信号。
    两个数都报，不合并成一个（合并就必然有一头是错的）。
    """
    if not usage_ok:
        return None, None  # 计量没开始 —— 不是"没被用过"
    now = now or datetime.datetime.now().astimezone()
    cut = now - datetime.timedelta(days=STALE_DAYS)
    any_seen, active_seen = set(), set()
    for u in usage:
        t = parse_iso(u.get('at') or u.get('time') or '')
        if t is None:
            continue
        try:
            if t.tzinfo is None:
                t = t.astimezone()
        except Exception:
            continue
        if t < cut:
            continue
        tool = str(u.get('tool') or '')
        ids = u.get('ids')
        if not isinstance(ids, list):
            ids = [u.get('id')] if u.get('id') else []
        for i in ids:
            if not i:
                continue
            any_seen.add(str(i))
            if tool in ('search', 'read'):
                active_seen.add(str(i))
    never_any = [r['id'] for r in rows if r['id'] and r['id'] not in any_seen]
    never_active = [r['id'] for r in rows if r['id'] and r['id'] not in active_seen]
    return never_any, never_active


def core_room(rows):
    """core 预算账：钉住几条、多少字、装不装得下。"""
    pinned = [r for r in rows if r['pinned'] and r['status'] == '有效']
    used = 0
    for r in pinned:
        used += r['chars'] + 8  # claim + "→ mem-xxxx" 开销
    budget = 0
    if os.path.exists(CORE):
        try:
            with open(CORE, 'r', encoding='utf-8-sig') as f:
                fm, _ = parse_frontmatter(f.read())
            budget = int(str(fm.get('预算', '0')).strip() or 0)
        except (OSError, ValueError):
            budget = 0
    return {
        'pinned': len(pinned),
        'pinnedChars': used,
        'budget': budget,
        'fits': budget <= 0 or used <= max(0, budget - 80),
        'needBudget': 0 if used <= 0 else used + 80,
    }


def build():
    rows = load_claims()
    errors = [r for r in rows if r.get('error')]
    live = [r for r in rows if not r.get('error')]
    usage_ok, usage = load_usage()
    dups = find_duplicates(live)
    never_any, never_active = stale_ids(live, usage_ok, usage)
    room = core_room(live)
    by_type = {}
    for r in live:
        by_type[r['type'] or '(空)'] = by_type.get(r['type'] or '(空)', 0) + 1
    return {
        'total': len(live),
        'chars': sum(r['chars'] for r in live),
        'avgChars': round(sum(r['chars'] for r in live) / len(live), 1) if live else 0,
        'byType': by_type,
        'errors': [{'file': r['file'], 'error': r['error']} for r in errors],
        'duplicates': dups,
        'usageStarted': usage_ok,
        'staleDays': STALE_DAYS,
        'neverAny': never_any,
        'neverActive': never_active,
        'core': room,
    }


def human(rep):
    L = []
    L.append('== 记忆整理体检（零模型调用）==')
    L.append('')
    L.append('库：%d 条 / 正文 %d 字 / 平均 %.1f 字' % (rep['total'], rep['chars'], rep['avgChars']))
    if rep['byType']:
        L.append('  按类型：' + ' · '.join('%s %d' % (k, v) for k, v in sorted(rep['byType'].items(), key=lambda x: -x[1])))
    if rep['errors']:
        L.append('')
        L.append('⚠ 读不出来的文件 %d 个（不当空，要人看）：' % len(rep['errors']))
        for e in rep['errors']:
            L.append('  · %s：%s' % (e['file'], e['error']))

    L.append('')
    L.append('── ① 疑似重复（Jaccard ≥ %.1f，共 %d 组）──' % (DEDUPE, len(rep['duplicates'])))
    if not rep['duplicates']:
        L.append('  没有。')
    for d in rep['duplicates'][:20]:
        L.append('  %.0f%%  %s / %s' % (d['similarity'] * 100, d['a'], d['b']))
        L.append('        A: %s' % d['claimA'][:60])
        L.append('        B: %s' % d['claimB'][:60])
    if len(rep['duplicates']) > 20:
        L.append('  …另有 %d 组，用 --json 看全' % (len(rep['duplicates']) - 20))

    L.append('')
    L.append('── ② %d 天内有没有被用到过 ──' % rep['staleDays'])
    if not rep['usageStarted']:
        L.append('  **计量还没开始**（memory/usage.jsonl 不存在）—— 这不是「没被用过」，')
        L.append('  是「还没有记录」。要这条有意义，先接上 usage 计量。')
    elif rep['neverAny'] is None:
        L.append('  读不到 usage.jsonl。')
    else:
        na, nact = rep['neverAny'], rep['neverActive']
        L.append('  四个出口（core / briefing / search / read）都没带出去过：%d 条' % len(na))
        if na:
            L.append('    ' + '、'.join(na[:12]) + ('　…另有 %d 条' % (len(na) - 12) if len(na) > 12 else ''))
            L.append('    ⚠ 这些是最该看的：占着库，但一次都没被用到。')
        L.append('  只被自动喂过、从没被主动搜到：%d 条' % len(nact))
        if nact and len(nact) <= 12:
            L.append('    ' + '、'.join(nact))
        elif nact:
            L.append('    ' + '、'.join(nact[:12]) + '　…另有 %d 条' % (len(nact) - 12))
        L.append('  （两列的区别：core/briefing 是自动喂的，search/read 是主动搜的。）')

    c = rep['core']
    L.append('')
    L.append('── ③ core 预算账 ──')
    if c['budget'] <= 0:
        L.append('  core.md 没写预算（或还没生成）。')
    else:
        mark = '✅ 装得下' if c['fits'] else '❌ 装不下，会丢条目'
        L.append('  钉住 %d 条 / 约 %d 字；预算 %d 字 → %s' % (c['pinned'], c['pinnedChars'], c['budget'], mark))
        if not c['fits']:
            L.append('  要全装，预算至少调到 %d（设置页可调，上限 4000）' % c['needBudget'])

    L.append('')
    L.append('（以上全部是字符串运算，一次模型都没调。整理 = 看这份报告，不是读全库。）')
    return '\n'.join(L)


def problems(rep):
    """--check 的判据：什么算「要处理」。"""
    out = []
    if rep['errors']:
        out.append('%d 个 claim 文件读不出来' % len(rep['errors']))
    if rep['duplicates']:
        out.append('%d 组疑似重复' % len(rep['duplicates']))
    if not rep['core']['fits'] and rep['core']['budget'] > 0:
        out.append('core 预算装不下钉住条目（%d 字 / 预算 %d）' % (rep['core']['pinnedChars'], rep['core']['budget']))
    return out


def _safe_stdout():
    """Windows 控制台默认 GBK，打印 ✅/✗ 会抛 UnicodeEncodeError —— 那会让"体检"变成假红。

    ⚠ 2026-11-24 当场抓到：`python scripts/memory-audit.py --check` 在 GBK 终端下
    UnicodeEncodeError 退出码 1，看起来像"有欠账"，实际是打印崩了。
    **退出码的含义必须唯一**：1 = 真有问题，2 = 环境/文件问题，0 = 通过。
    所以这里先把 stdout 换成 utf-8/replace，崩不了。
    """
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass


def main():
    _safe_stdout()
    ap = argparse.ArgumentParser(description='方寸记忆整理体检（只读，零模型调用）')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--check', action='store_true', help='有问题才非零退出')
    a = ap.parse_args()

    if not os.path.isdir(MEM):
        print('找不到 memory/ 目录：%s' % MEM)
        return 2
    rep = build()

    if a.json:
        print(json.dumps(rep, ensure_ascii=False, indent=2))
    else:
        print(human(rep))

    bad = problems(rep)
    if a.check:
        print('')
        if bad:
            print('✗ 有 %d 类要处理：' % len(bad))
            for b in bad:
                print('  · ' + b)
            return 1
        print('✓ 体检通过（重复 / 空证据 / 预算都对得上）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
