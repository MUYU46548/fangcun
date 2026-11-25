#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
记忆使用率指标（2026-11-25 · P16.6）

回答一个问题：**记下来的东西，到底有没有被用？**
- 分母：`memory/claims/*.md` 里**有效**的条目（待审批/已撤销不算，它们不该被检索到）；
- 分子：`memory/usage.jsonl` 里被 **search / read / briefing** 召回到过的条目（core 注入不算召回，D3=B）；
- 同时给「近 30 天」和「曾经」两个口径。

⚠ 计量没开始（usage.jsonl 不存在 / 没有可认的事件）时**明说"没开始"**，
不报 0% —— 那会被读成"一条都没用过"，而事实是"还没记账"。

用法：
  python scripts/memory-usage-rate.py            # 人读
  python scripts/memory-usage-rate.py --json     # 机器读
  python scripts/memory-usage-rate.py --root <dir>   # 指定数据根（测试用）
"""
import argparse
import io
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RECALL = {'search', 'read', 'briefing'}
FM_RE = re.compile(r'^---\s*$', re.M)


def parse_fm(text):
    m = list(FM_RE.finditer(text))
    if len(m) < 2:
        return {}
    fm = text[m[0].end():m[1].start()]
    out = {}
    for line in fm.splitlines():
        line = line.rstrip()
        if not line or line.startswith('#') or ':' not in line:
            continue
        k, v = line.split(':', 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        out[k] = v
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--root', default=REPO)
    a = ap.parse_args()

    root = os.path.abspath(a.root)
    claims_dir = os.path.join(root, 'memory', 'claims')
    usage_path = os.path.join(root, 'memory', 'usage.jsonl')

    effective = {}
    if os.path.isdir(claims_dir):
        for name in sorted(os.listdir(claims_dir)):
            if not name.endswith('.md'):
                continue
            p = os.path.join(claims_dir, name)
            with io.open(p, 'r', encoding='utf-8-sig') as f:
                fm = parse_fm(f.read())
            if str(fm.get('状态', '有效')).strip() == '有效':
                effective[fm.get('id') or name[:-3]] = name

    counts = {}
    last_at = {}
    events = 0
    started = False
    if os.path.exists(usage_path):
        with io.open(usage_path, 'r', encoding='utf-8-sig') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(ev, dict) or ev.get('tool') not in RECALL:
                    continue
                ids = ev.get('ids')
                if not isinstance(ids, list):
                    continue
                started = True
                events += 1
                at = str(ev.get('at') or '')
                for mid in ids:
                    mid = str(mid)
                    counts[mid] = counts.get(mid, 0) + 1
                    if at and (mid not in last_at or at > last_at[mid]):
                        last_at[mid] = at

    now = __import__('datetime').datetime.now(__import__('datetime').timezone.utc)
    recent = set()
    if started:
        for mid, at in last_at.items():
            try:
                t = __import__('datetime').datetime.fromisoformat(at.replace('Z', '+00:00'))
                if (now - t).total_seconds() <= 30 * 86400:
                    recent.add(mid)
            except Exception:
                pass

    total = len(effective)
    ever = [mid for mid in effective if mid in counts]
    rec30 = [mid for mid in ever if mid in recent]
    out = {
        'started': started,
        'total_effective': total,
        'recall_events': events,
        'recalled_ever': len(ever),
        'recalled_30d': len(rec30),
        'rate_ever': round(len(ever) / total, 3) if total else None,
        'rate_30d': round(len(rec30) / total, 3) if total else None,
        'never': [mid for mid in effective if mid not in counts],
    }

    if a.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    print('== 记忆使用率 ==')
    if not started:
        print('计量还没开始：memory/usage.jsonl 不存在，或里面没有 search/read/briefing 事件。')
        print('这不是 0% —— 是还没有人用这些出口，或还没记账。')
        return 0
    print(f'有效条目：{total} 条；召回事件：{events} 次')
    print(f'曾经被召回：{len(ever)} 条（{out["rate_ever"] * 100:.1f}%）')
    print(f'近 30 天被召回：{len(rec30)} 条（{out["rate_30d"] * 100:.1f}%）')
    if out['never']:
        print(f'从未被召回：{len(out["never"])} 条 —— {", ".join(out["never"][:12])}'
              + (' …' if len(out['never']) > 12 else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
