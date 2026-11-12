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

# 2026-11-11（P10 机检踩到）：Windows 默认控制台是 cp936，脚本里那句 '✓' 直接抛
# UnicodeEncodeError —— 判据 `python scripts/audit-ledger.py --check` 在**默认终端里**
# 从来跑不过（在有 PYTHONIOENCODING 的环境里才绿）。判据必须是“换个人在默认终端也能跑”，
# 所以这里主动把 stdout 切到 UTF-8；切不动就退化成 replace，绝不因为打印符号而崩。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

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
        'created_ts': created_ts(fm),
        'body': body,
        'path': os.path.basename(path),
    }


def created_ts(fm):
    """卡的创建时间（Unix 秒）；认不出给 0（**不当作 1970** —— 0 会让“创建后被改过”永不成立，
    这是保守方向：宁可漏报，不误报）。认三种写法：ISO / 秒级数字 / 毫秒数字。"""
    raw = (fm.get('创建') or fm.get('created') or '').strip()
    if not raw:
        return 0
    if re.match(r'^\d+$', raw):
        n = int(raw)
        return n // 1000 if n > 10 ** 12 else n      # 毫秒 → 秒
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?', raw)
    if not m:
        return 0
    try:
        d = datetime.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                              int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0))
        return d.timestamp()
    except Exception:
        return 0


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


def is_stale(card, days):
    """这张卡是不是 `days` 天没动过。**认不出更新时间就返回 False**（不当作极旧）——
    宁可漏提示，也不要把“时间不详”说成“很久没动”（那是 1970 那类假证据的老毛病）。"""
    raw = (card.get('updated') or '').strip()
    if not raw:
        return False
    ts = created_ts({'创建': raw})          # 复用同一套解析（ISO / 秒级 / 毫秒）
    if not ts:
        return False
    return (datetime.datetime.now().timestamp() - ts) > days * 86400


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
        #    ⚠ 2026-11-12 收窄：原来只要正文出现旧 `0.6.N` 就提示 —— 于是**正在进行的卡**
        #    （比如 UI 迁移卡里写“0.6.23 已入库”）也被翻出来，把真信号稀释掉。
        #    现在只对“**30 天没动过**”的卡提示：动过的说明有人在跟，旧版本号只是历史记录。
        vers = sorted(set(re.findall(r'0\.6\.(\d+)', text)), key=int)
        if vers and ver and cur[1] == 6:
            old = [v for v in vers if (0, 6, int(v)) < cur]
            if old and not any(r['id'] == card['id'] for r in rows) and is_stale(card, 30):
                rows.append({
                    'id': card['id'], 'title': card['title'], 'status': card['status'],
                    'kind': '提到旧版本', 'evidence': '0.6.' + old[0],
                    'advice': '只提示：确认这条还成立（成立就写清“当前版本下仍要做”）',
                    'risk': '低',
                })
        # ⑤ **已经有真实产出、卡却还挂在待办**（2026-11-12 补）
        #    为什么必须补这一条：前面四条都在找“过期”，但账本里最伤人的一类是**做完了没回写** ——
        #    它让下一轮盘点把做过的活重新翻出来问一遍（卡上写的判据就是“同一张卡不许连续两次
        #    被翻出来问同一句”）。
        #    判据保守到不会误伤：卡里点名的仓库内文件（docs/…、scripts/…、desktop/…）
        #    **全都真实存在**，且**至少一个**在卡“创建时间之后”被改过 —— 那就是“有人真的动过手”。
        #    ⚠ 只认这四类顶层目录，避免把正文里的普通词当路径。
        refs = set(re.findall(r'(?<![`\w/])((?:docs|scripts|desktop|skills)/[A-Za-z0-9_\-./]+\.(?:md|cjs|py|ts|vue|json|ya?ml|html))', text))
        if refs:
            exist = []
            for r in refs:
                p = os.path.join(ROOT, r.replace('/', os.sep))
                if os.path.exists(p):
                    exist.append((r, os.path.getmtime(p)))
            if exist and len(exist) == len(refs):
                created = card.get('created_ts') or 0
                # ⚠ 判据必须**窄**，否则这条会变成噪音生成器：几乎任何仓库文件都在卡创建之后被改过。
                #   只有“创建后 **14 天内** 就有人动过这些文件”才像是“做这件事时顺手改的”。
                #   （14 天是经验值：一条卡从写下到真正开工通常不超过两周；更久的多半是别的事改的。）
                window = 14 * 86400
                touched = [r for r, mt in exist if created and 0 < mt - created <= window]
                if touched:
                    rows.append({
                        'id': card['id'], 'title': card['title'], 'status': card['status'],
                        'kind': '产出已存在但仍挂待办',
                        'evidence': '、'.join(touched[:3]) + '（卡创建后 14 天内被改过）',
                        'advice': '建议先看一眼：这条说的活可能已经做完了 → 转“待验收”或作废；'
                                  '若确实还没做完，请在卡上写清“还差哪一步”',
                        'risk': '低（这一步只是叫人看一眼，不自动改卡）',
                    })

    return ver, rows


def render(ver, rows):
    today = datetime.date.today().isoformat()
    by_kind = {}
    for r in rows:
        by_kind.setdefault(r['kind'], []).append(r)
    # ⚠ 2026-11-12 修：这两处原来把类型**写死**成四个，于是新加的判据
    #   （“产出已存在但仍挂待办”）算出来了却不进报告 —— 静默消失，比报错更难发现。
    #   现在从 by_kind **动态**取，已知类型排前面，未知的按名字排在后面（不丢）。
    KNOWN = ('过期验收', '已完成里程碑', '引用已撤销决策', '提到旧版本', '产出已存在但仍挂待办')
    kinds = [k for k in KNOWN if k in by_kind] + sorted(k for k in by_kind if k not in KNOWN)
    lines = [
        f'# 账本体检（机械规则 · {today}）',
        '',
        '> 由 `scripts/audit-ledger.py` 生成，**只读**：本文件不修改任何任务卡。',
        f'> 当前版本：`{ver}`；扫描对象：`task-data/*.md` 里**非终态**卡（完成/驳回不进清单）。',
        '> 判据是**确定性规则**（不猜语义）：' + ' / '.join(KNOWN),
        '',
        f'## 汇总：{len(rows)} 条候选 / {len({r["id"] for r in rows})} 张卡（按类型）',
        '',
        '| 类型 | 条数 |',
        '|---|---|',
    ]
    for k in kinds:
        lines.append(f'| {k} | {len(by_kind.get(k, []))} |')
    lines.append('')
    for k in kinds:
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
    """收卡机检：**重新算一遍**，再核对报告与实算是否一致。

    ⚠ 2026-11-12 修：原来这里只读**已存在的报告文件** —— 于是“报告是昨天写的”时它照样绿，
    而 `python audit-ledger.py` 实跑会给出不同的条数（实测 8 vs 7，同一分钟里）。
    判据要的是“报告说得对”，不是“报告文件存在”，所以先算再比。
    """
    ok = True
    ver, fresh = scan()
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
    # 同源核对：报告里的卡集合必须等于**现在重算**出来的集合
    want = {r['id'] for r in fresh}
    if ids != want:
        only_report = sorted(ids - want)
        only_fresh = sorted(want - ids)
        print(f'✗ 报告与实算不一致：报告多 {only_report[:3]} / 少 {only_fresh[:3]}'
              f'（报告 {len(ids)} 张，实算 {len(want)} 张）→ 重跑一次 audit-ledger.py')
        ok = False
    if ok:
        print(f'✓ 体检报告成立：{len(ids)} 张卡，结构完整，卡 id 全部存在，且与实算同源')
    return ok


def main():
    if '--check' in sys.argv:
        sys.exit(0 if check() else 1)
    ver, rows = scan()
    report = render(ver, rows)
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, 'w', encoding='utf-8') as f:
        f.write(report)
    print(f'当前版本 {ver}；候选 {len(rows)} 条 / {len({r["id"] for r in rows})} 张卡；报告：{REPORT}')
    for r in rows:
        print(f"  [{r['kind']}] {r['id']} —— {r['title'][:36]} :: {r['evidence']}")
    print('提示：本脚本不改任何卡；处置（作废/改写）由你决定。')


if __name__ == '__main__':
    main()
