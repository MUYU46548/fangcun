#!/usr/bin/env python3
"""规划能力闭环 · 证据采集（2026-11-11 · 一周目标的验收物）

暮雨：「至少一周内让我看到方寸具有**项目规划能力的根基**」。
"根基"不是一句形容词，是一条能跑通的链：

    问卷 → 决策 → 草案 → 阶段卡 → 派工单（继承验收线）→ 执行 → 回写 → 结论集

本脚本**只读**，把每一环的**当下真实数字**打出来（不是"应该做了"）。
`--check` 用于机检：任何一环为空就非零退出（空的一环 = 链断了，不是"数据还没到"）。

用法：
  python scripts/loop-evidence.py              # 打印五段证据
  python scripts/loop-evidence.py --check      # 机检（每环非空才过）
"""
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
TASK = os.path.join(ROOT, 'task-data')
QD = os.path.join(TASK, 'questionnaires')
PLANS = os.path.join(TASK, 'plans')
DRAFTS = os.path.join(PLANS, '_drafts')
PROJECT = 'fangcun-base'


def read(p):
    try:
        with open(p, encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        return ''


def answers_files():
    if not os.path.isdir(QD):
        return []
    return sorted(f for f in os.listdir(QD) if f.endswith('.answers.json'))


def load_answers(fn):
    try:
        return json.loads(read(os.path.join(QD, fn)) or '{}')
    except Exception:
        return {}


def deck_mds():
    if not os.path.isdir(QD):
        return []
    return sorted(f for f in os.listdir(QD)
                  if f.endswith('.md') and not f.startswith('.'))


def sec(title):
    print('')
    print('=' * 68)
    print(title)
    print('=' * 68)


def main():
    check_only = '--check' in sys.argv
    summary = {}

    # ── ① 问卷：有多少卷、多少批准、题库进度 ──────────────────────────
    decks = deck_mds()
    files = answers_files()
    approved = 0
    voided = 0
    pending = []
    for fn in files:
        a = load_answers(fn)
        if a.get('voidedAt'):
            voided += 1
        elif a.get('approvedAt'):
            approved += 1
        else:
            pending.append(fn.replace('.answers.json', ''))
    bank = read(os.path.join(TASK, 'question-bank.md'))
    bank_total = len(re.findall(r'^- 问题[:：]', bank, re.M))
    bank_answered = len(re.findall(r'^- 状态[:：]\s*已答', bank, re.M))
    bank_open = len(re.findall(r'^- 状态[:：]\s*待答', bank, re.M))
    summary['问卷'] = dict(卷=len(decks), 已批准=approved, 已作废=voided,
                        待答卷=len(pending), 题库题=bank_total,
                        题库已答=bank_answered, 题库待答=bank_open)

    # ── ② 决策：问卷答出来的决策卡 ──────────────────────────────────
    dec = read(os.path.join(TASK, 'decisions.md'))
    blocks = re.split(r'\n(?=##\s)', dec)
    from_deck = [b for b in blocks if '出处' in b and '问卷' in b]
    valid = [b for b in from_deck if re.search(r'^- 状态[:：]\s*有效', b, re.M)]
    revoked = [b for b in from_deck if re.search(r'^- 状态[:：]\s*已撤销', b, re.M)]
    summary['决策'] = dict(来自问卷=len(from_deck), 有效=len(valid), 已撤销=len(revoked))

    # ── ③ 草案 → 阶段卡 ─────────────────────────────────────────────
    draft_files = sorted(f for f in os.listdir(DRAFTS)) if os.path.isdir(DRAFTS) else []
    draft_files = [f for f in draft_files if f.endswith('.md')]
    latest = draft_files[-1] if draft_files else ''
    draft_txt = read(os.path.join(DRAFTS, latest)) if latest else ''
    draft_stages = re.findall(r'^###\s+(P\d+)', draft_txt, re.M)
    plan_txt = read(os.path.join(PLANS, PROJECT + '.md'))
    plan_stages = re.findall(r'^###\s+(P\d+)\s*[·:：]?\s*(.*)$', plan_txt, re.M)
    clarify = re.findall(r'^-\s*澄清[:：]\s*(.+)$', plan_txt, re.M)
    done = len(re.findall(r'^-\s*状态[:：]\s*完成', plan_txt, re.M))
    frozen = len(re.findall(r'^-\s*状态[:：]\s*已冻结', plan_txt, re.M))
    summary['草案与阶段卡'] = dict(草案份数=len(draft_files), 最新草案格数=len(draft_stages),
                          计划格数=len(plan_stages), 带澄清卷的格=len(clarify),
                          完成=done, 已冻结=frozen)

    # ── ④ 派工单：已落档验收线（问卷 → 派工单的继承口）──────────────
    rulings = []
    for fn in files:
        a = load_answers(fn)
        if not a.get('approvedAt') or a.get('voidedAt'):
            continue
        deck = fn.replace('.answers.json', '')
        md = read(os.path.join(QD, deck + '.md'))
        # 卷面里的验收线（`【验收线】…` / `- 验收线: …`）
        for m in re.finditer(r'(?:【验收线】|^-\s*验收线[:：])\s*(.+)$', md, re.M):
            rulings.append((deck, m.group(1).strip()[:60]))
    summary['派工单验收线'] = dict(条数=len(rulings), 样例=[r[1] for r in rulings[:2]])

    # ── ⑤ 回写：卡上的交付记录 + 结论集 ────────────────────────────
    deliveries = []
    for fn in files:
        a = load_answers(fn)
        deck = fn.replace('.answers.json', '')
        for qid, rows in (a.get('deliveries') or {}).items():
            for r in rows or []:
                deliveries.append(dict(deck=deck, qid=qid, card=r.get('cardId', ''),
                                       status=r.get('status', ''), at=r.get('at', '')))
    conv = {}
    try:
        conv = json.loads(read(os.path.join(TASK, 'decisions.convergence.json')) or '{}')
    except Exception:
        conv = {}
    delivered = [d for d in deliveries if d['status'] == 'delivered']
    rejected = [d for d in deliveries if d['status'] == 'rejected']
    summary['回写与结论集'] = dict(交付记录=len(deliveries), 已通过=len(delivered),
                           被驳回过=len(rejected),
                           结论集条数=(conv.get('snapshots') or {}).get(PROJECT, {}).get('total')
                           if isinstance(conv, dict) and 'snapshots' in conv else conv.get('total'),
                           连续不变=conv.get('streak') if 'streak' in conv else
                           (conv.get('snapshots') or {}).get(PROJECT, {}).get('streak'))

    if not check_only:
        sec('① 问卷 → 决策')
        print(json.dumps(summary['问卷'], ensure_ascii=False, indent=2))
        print(json.dumps(summary['决策'], ensure_ascii=False, indent=2))
        print('  样例决策（来自问卷）：')
        if valid:
            one = valid[0]
            t = re.search(r'^-\s*内容[:：]\s*(.+)$', one, re.M)
            print('   ·', (t.group(1).strip() if t else one.splitlines()[0][:50]))
        sec('② 草案 → 阶段卡')
        print(json.dumps(summary['草案与阶段卡'], ensure_ascii=False, indent=2))
        print('  最新草案：', latest or '（无）')
        if clarify:
            print('  带澄清卷的阶段卡样例：', clarify[0])
        sec('③ 派工单能继承的验收线')
        print(json.dumps(summary['派工单验收线'], ensure_ascii=False, indent=2))
        sec('④ 执行 → 回写 → 结论集')
        print(json.dumps(summary['回写与结论集'], ensure_ascii=False, indent=2))
        for d in deliveries[:3]:
            print('   ·', f"{d['deck']} # {d['qid']} → {d['card']}（{d['status']} @ {d['at'][:10]}）")
        print('')

    # ── 机检：每一环都要非空 ──────────────────────────────────────
    #
    # ⚠ 2026-11-12 暮雨：「方寸的规划能力不做好，其他项目会一直出问题」。
    #   查下来发现：上面这些**全部只问「链路上有没有东西」**，没有一条问「用在了几个项目上」——
    #   于是一条**只服务于 fangcun-base 自己**的闭环也能拿满分 9/0。
    #   实测：14 个项目里只有 1 个有作战计划卡（其余 13 个一张都没有）。
    #   所以补第 10 条：**被规划过的项目数**。这才是「规划能力」是否真在用的判据。
    really_planned = []
    if os.path.isdir(PLANS):
        for p in sorted(os.listdir(PLANS)):
            if not p.endswith('.md') or p.startswith('_'):
                continue
            try:
                txt = open(os.path.join(PLANS, p), encoding='utf-8').read()
            except Exception:
                continue
            if txt.count('\n### ') >= 1:          # 真有阶段卡才算被规划过（空文件不算）
                really_planned.append(p[:-3])

    gates = [
        ('问卷：至少一卷已批准', approved > 0),
        ('题库：有已答题', bank_answered > 0),
        ('决策：有来自问卷的决策卡', len(from_deck) > 0),
        ('草案：至少一份草案', len(draft_files) > 0),
        ('阶段卡：计划里有格', len(plan_stages) > 0),
        ('阶段卡：至少有格带澄清卷（进队列锁靠它）', len(clarify) > 0),
        ('派工单：能拿出验收线', len(rulings) > 0),
        ('回写：有交付记录（不是“做完了但账上没有”）', len(deliveries) > 0),
        ('结论集：有快照', bool(summary['回写与结论集'].get('结论集条数'))),
        # ── 第 10 条（2026-11-12 新增）：不是“链路通”，而是“**真的用起来了**” ──
        #   判据写 ≥2 而不是“全部项目”：一个项目做完再下一个，批量起草 13 份没人看等于零。
        #   所以“≥2” = 「除方寸自己之外，至少还有一个项目被真正规划过」。
        ('覆盖率：被规划过的项目 ≥ 2（不能只规划方寸自己）', len(really_planned) >= 2),
    ]
    bad = [n for n, ok in gates if not ok]
    print('== 闭环机检 ==')
    for n, ok in gates:
        print(('PASS  ' if ok else 'FAIL  ') + n)
    print('\n  被规划过的项目（plans/*.md 里真有阶段卡的）：%d 个 → %s'
          % (len(really_planned), ', '.join(really_planned) if really_planned else '（一个都没有）'))
    print('  覆盖率判据要求 ≥2（方寸自己 + 至少一个真实项目）。缺的是「第一次真的用起来」，不是代码。')
    print(f'RESULT {len(gates) - len(bad)} / {len(bad)}')
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
