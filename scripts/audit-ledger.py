#!/usr/bin/env python3
"""账本机械体检（0.7.0 · P10 · 2026-11-11）

暮雨原话两次说过同一件事：「一堆事都没做」里有一部分是**账本被老任务污染了** ——
真正该现在做的约 14 张，剩下的是该清理的。可是“哪张过时”不该靠人逐张回忆。

本脚本**只读**、只出清单、**一律不改卡状态**（处置权在用户，D-075 授权的作废也走界面/回收站）。

判据（确定性规则，不做语义猜测）：
  ① **过期验收**：标题/正文出现「装 X 后复核 / 验收 / 观察」且 X 是已发布的旧版本；
  ② **过去版本**：正文里出现 `0.6.N` 且 N 小于当前版本（只作提示，不单独判死）；
  ③ **已完成里程碑**：标题写着“出 0.6.0 规划 / 0.3.x / 密度刀”这类已被后续版本覆盖的活；
  ④ **引用了已撤销的决策**：卡上 `拍板: D-xxx` / `相关旧拍板` 指向 已撤销 / 已合并 的决策。

用法：
  python scripts/audit-ledger.py            # 打印清单 + 写 docs/账本体检-<日期>.md
  python scripts/audit-ledger.py --check    # 只核对报告是否成立（给收卡机检用）
"""
import datetime
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__)) + os.sep + '..'
ROOT = os.path.abspath(ROOT)
TASK_DIR = os.path.join(ROOT, 'task-data')
REPORT = os.path.join(ROOT, 'docs', '账本体检-20261111.md')
VERSION_FILE = os.path.join(ROOT, 'desktop', 'package.json')


def current_version():
    try:
        import json
        with open(VERSION_FILE, encoding='utf-8') as f:
            return str(json.load(f).get('version') or '')
    except Exception:
        return ''


def parse_card(path):
    """只取判断要用的几样：标题/状态/更新/正文。解析不出就跳过（不猜）。"""
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except Exception:
        return None
    m = re.match(r'^---\s*\n(.*?)\n(?:---|===)\s*\n?(.*)$', text, re.S)
    if not m:
        return None
    fm_raw, body = m.group(1), m.group(2)
    fm = {}
    for line in fm_raw.splitlines():
        kv = re.match(r'^([^:]+):\s*(.*)$', line)
        if kv:
            fm[kv.group(1).strip()] = kv.group(2).strip()
    return {
        'id': fm.get('id') or os.path.splitext(os.path.basename(path))[0],
        'title': fm.get('标题', ''),
        'status': fm.get('状态', ''),
        'updated': fm.get('更新', ''),
        'body': body,
        'path': os.path.basename(path),
    }


def load_decisions():
    """决策卡状态（只读）：id → 状态。文件不存在返回空表。"""
    p = os.path.join(TASK_DIR, 'decisions.md')
    out = {}
    if not os.path.exists(p):
        return out
    try:
        with open(p, encoding='utf-8') as f:
            text = f.read()
    except Exception:
        return out
    cur = ''
    for line in text.splitlines():
        h = re.match(r'^##\s+(D-\d+)', line)
        if h:
            cur = h.group(1)
            continue
        st = re.match(r'^-\s*状态\s*[:：]\s*(\S+)', line)
        if cur and st:
            out[cur] = st.group(1)
            cur = ''
    return out


def ver_tuple(v):
    m = re.match(r'^(\d+)\.(\d+)\.(\d+)', v or '')
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def scan():
    ver = current_version()
    cur = ver_tuple(ver)
    decisions = load_decisions()
    rows = []
    for name in sorted(os.listdir(TASK_DIR)):
        if not name.endswith('.md') or name.startswith('.') or name.startswith('_'):
            continue
        card = parse_card(os.path.join(TASK_DIR, name))
        if not card or card['status'] in ('完成', '驳回'):
            continue      # 终态不进体检清单（那是归档/复盘的事）
        text = card['title'] + '\n' + card['body']

        # ① 过期验收：装 X 后复核/验收/观察
        for m in re.finditer(r'装\s*(\d+\.\d+\.\d+)\s*(?:之后|后)?[^\n]{0,20}?(复核|验收|观察|检查)', text):
            v = m.group(1)
            if ver_tuple(v) < cur:
                rows.append({
                    'id': card['id'], 'title': card['title'], 'status': card['status'],
                    'kind': '过期验收', 'evidence': m.group(0),
                    'advice': f'建议作废或改写：{v} 早已发布（当前 {ver}），这条验收已经没有对象',
                    'risk': '低（纯账本条目，不涉及代码）',
                })
                break

        # ② 已完成里程碑（标题里写着已被覆盖的活）
        #    2026-11-11 首跑只匹配 `0.[0-5].N`，漏掉了「出 0.6.0 规划」—— 0.6.x 同样已经发完，
        #    所以改成“标题里有具体版本号 + 规划/交付/清单/发布/说明”即算，版本号只作证据摆出来。
        for m in re.finditer(r'0\.\d+\.\d+[^\n]{0,6}?(规划|交付|清单|发布|说明)', card['title'] + '\n' + card['body'][:200]):
            if ver_tuple(m.group(0)[:5]) <= cur:
                rows.append({
                    'id': card['id'], 'title': card['title'], 'status': card['status'],
                    'kind': '已完成里程碑', 'evidence': m.group(0),
                    'advice': f'建议改写为“下一版（{ver}）规划”或作废：{m.group(0)} 已被后续版本覆盖',
                    'risk': '低（改写即可，信息不丢）',
                })
                break

        # ③ 引用了已撤销 / 已合并的决策
        ids = set(re.findall(r'D-\d+', card['body'] + '\n' + card['title']))
        dead = [d for d in ids if decisions.get(d) in ('已撤销', '已合并')]
        if dead:
            rows.append({
                'id': card['id'], 'title': card['title'], 'status': card['status'],
                'kind': '引用已撤销决策', 'evidence': '、'.join(sorted(dead)),
                'advice': '建议改写：依据已撤销，按现行决策重写（或作废）',
                'risk': '中（拿撤销过的决策当依据会做错方向）',
            })

        # ④ 过去版本（只提示）
        vers = sorted(set(re.findall(r'0\.6\.(\d+)', text)), key=int)
        if vers and ver and cur[1] == 6:
            old = [v for v in vers if (0, 6, int(v)) < cur]
            if old and not any(r['id'] == card['id'] for r in rows):
                rows.append({
                    'id': card['id'], 'title': card['title'], 'status': card['status'],
                    'kind': '提到旧版本', 'evidence': '0.6.' + old[0],
                    'advice': '只提示：确认这条还成立（成立就写清“当前版本下仍要做”）',
                    'risk': '低',
                })
    return ver, rows


def render(ver, rows):
    today = datetime.date.today().isoformat()
    by_kind = {}
    for r in rows:
        by_kind.setdefault(r['kind'], []).append(r)
    lines = [
        f'# 账本体检（机械规则 · {today}）',
        '',
        '> 由 `scripts/audit-ledger.py` 生成，**只读**：本文件不修改任何任务卡。',
        f'> 当前版本：`{ver}`；扫描对象：`task-data/*.md` 里**非终态**卡（完成/驳回不进清单）。',
        '> 判据是**确定性规则**（不猜语义）：过期验收 / 已完成里程碑 / 引用已撤销决策 / 提到旧版本。',
        '',
        f'## 汇总：{len(rows)} 条候选（按类型）',
        '',
        '| 类型 | 条数 |',
        '|---|---|',
    ]
    for k in ('过期验收', '已完成里程碑', '引用已撤销决策', '提到旧版本'):
        lines.append(f'| {k} | {len(by_kind.get(k, []))} |')
    lines.append('')
    for k in ('过期验收', '已完成里程碑', '引用已撤销决策', '提到旧版本'):
        items = by_kind.get(k, [])
        if not items:
            continue
        lines += [f'## {k}（{len(items)} 条）', '',
                  '| 卡 | 标题 | 状态 | 命中证据 | 建议 | 风险 |', '|---|---|---|---|---|---|']
        for r in items:
            safe_title = r['title'].replace('|', '／')
            lines.append(f"| `{r['id']}` | {safe_title} | {r['status']} | `{r['evidence']}` | {r['advice']} | {r['risk']} |")
        lines.append('')
    lines += [
        '## 处置说明（不代劳）',
        '',
        '- 作废 / 改写**都由你决定**：D-075 授权的是“按清单直接作废到回收站（可恢复）”，但清单必须先由你看过。',
        '- 任何作废都会进 `task-data/.trash`，可一键恢复；`.activity.log` 留痕。',
        '- 本脚本**不调用任何写接口**，也不改卡状态 —— 它只把“该被看一眼的”摆出来。',
    ]
    return '\n'.join(lines) + '\n'


def check():
    """收卡机检：报告存在、结构对、提到的卡都真实存在。"""
    ok = True
    if not os.path.exists(REPORT):
        print(f'✗ 报告不存在：{REPORT}')
        return False
    with open(REPORT, encoding='utf-8') as f:
        text = f.read()
    for need in ('## 汇总', '## 处置说明', '| 类型 | 条数 |'):
        if need not in text:
            print(f'✗ 报告缺结构：{need}')
            ok = False
    # 只认**每行第一个反引号单元格**（卡 id 列）；证据列里也有反引号（版本号/决策号），
    # 2026-11-11 首跑就栽在这：把它当卡 id 去核对，报“0.6.0、0.6.0 规划 不存在”。
    ids = set(re.findall(r'^\|\s*`([^`]+)`\s*\|', text, re.M))
    existing = {os.path.splitext(n)[0] for n in os.listdir(TASK_DIR) if n.endswith('.md')}
    missing = sorted(i for i in ids if i not in existing)
    if missing:
        print(f'✗ 报告里提到不存在的卡：{"、".join(missing[:5])}')
        ok = False
    if not ids:
        print('✗ 报告里一条卡都没有（空体检 = 没体检）')
        ok = False
    if ok:
        print(f'✓ 体检报告成立：{len(ids)} 张卡，结构完整，卡 id 全部存在')
    return ok


def main():
    if '--check' in sys.argv:
        sys.exit(0 if check() else 1)
    ver, rows = scan()
    report = render(ver, rows)
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, 'w', encoding='utf-8') as f:
        f.write(report)
    print(f'当前版本 {ver}；候选 {len(rows)} 条；报告：{REPORT}')
    for r in rows:
        print(f"  [{r['kind']}] {r['id']} —— {r['title'][:36]} :: {r['evidence']}")
    print('提示：本脚本不改任何卡；处置（作废/改写）由你决定。')


if __name__ == '__main__':
    main()
