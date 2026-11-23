# -*- coding: utf-8 -*-
"""对账 (a) 的**两次证伪记录**（2026-11-23）—— 这一组最终结论是"这样对账不成立"。

## 第一次判据：决策 ↔ 方针卡 逐字重合 → 证伪

方针卡只写四节概括（使命 / 当前目标 / 应用场景 / 方针边界 + 结构地图），
它是"给 agent 的项目背景"，**从来不是记录决策的地方**。
实测 `D-016`（备注写"已出厂，7 笔提交…"）在方针卡里最多匹配到 7 个字符 `" agent "`。
跑出来 landed=0 / orphan=135。**不是脚本坏，是映射不成立。**

## 第二次判据：决策 ↔ 它点名的卡/提交 → 也基本证伪

换了个更硬的判据：决策正文里若写了 `task-YYYYMMDD-NNN` 或提交短号，就核对它是否真实存在。
结果（现行 145 条）：

    landed    2     点名的东西真存在
    orphan    1     点名了但找不到（D-012 的 8bebfd2，备注自己写着"已失效，需重锚"）
    no_ref  142     **正文里没有任何可核对的编号**

142/145 说明什么：**决策台账记录的是"定案了什么"，不是"对应哪张卡"。**
抽 4 条 no_ref 看备注，全是"暂缓 / 排前 / 教训是…"这类判断，
本来就不会带卡号。**这是数据的真实形态，不是缺陷。**

## 所以这一组的诚实结论

**"决策 ↔ X" 这条对账在当前数据结构下做不出来**，无论 X 是方针还是卡。
硬做只会产出漂亮但没意义的百分比（第一版 landed=0 那种）。

真正该做的不是对账，而是**补结构**：让决策卡多一个必填字段
`落地: task-xxx | commit:xxx | 不做(理由)` —— 有了它，这条对账一秒就能算。
这是**数据结构改动**，不属于本轮"接上记忆"的范围，已记进卡 `db20e386` 的未做项。

## 本脚本现在的用途（保留，不退场）

它仍然能回答一个有用的窄问题：**"有没有决策点了名但东西不存在"**。
现在答案是 1 条（D-012，且它自己就标了"锚已失效"）。作为**回归守卫**有价值：
以后谁写了决策又引用了不存在的卡/提交，这里会红。

用法：
    python scripts/reconcile-decisions.py            # 人读报告
    python scripts/reconcile-decisions.py --json     # 机器可读
    python scripts/reconcile-decisions.py --check    # 只给计数（供守卫断言）
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DECISIONS = os.path.join(ROOT, 'task-data', 'decisions.md')
POLICY_DIR = os.path.join(ROOT, 'policies')
TASK_DIR = os.path.join(ROOT, 'task-data')

# 决策正文里会出现的可核对实体
RE_CARD = re.compile(r'task-\d{8}-\d{3}')
# ⚠ 提交号只认 **7–12 位**、且**不是纯数字**。
#   第一版写成 `[0-9a-f]{7,40}` → `20261011`（日期 2026-10-11）被当成提交号，
#   27 条 orphan 里有一半是这种假阳性。真提交号几乎总带字母；
#   纯数字串在本仓的语义是日期或卡号，不是提交。
RE_COMMIT = re.compile(r'\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b')

CANON = re.compile(r'^##\s+(D-\d+)\s+(.*)$')


def read(p):
    try:
        with open(p, 'r', encoding='utf-8-sig') as f:
            return f.read()
    except OSError:
        return ''


def unquote(v):
    s = str(v or '').strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1]
    return s


def parse_decisions(text):
    """`## D-xxx 标题` + `- 字段: 值` 缩进列表。"""
    rows = []
    cur = None
    for line in text.replace('\r\n', '\n').split('\n'):
        h = CANON.match(line)
        if h:
            if cur:
                rows.append(cur)
            cur = {'id': h.group(1), 'title': h.group(2).strip(),
                   'date': '', 'status': '', 'project': '', 'source': '', 'note': '',
                   'scope': '', 'landed': ''}
            continue
        if cur is None:
            continue
        kv = re.match(r'^-\s*(日期|状态|项目|出处|备注|生效范围|落地)\s*[:：]\s*(.*)$', line)
        if kv:
            k, v = kv.group(1), unquote(kv.group(2))
            if k == '日期':
                cur['date'] = v
            elif k == '状态':
                cur['status'] = {'作数': '有效', '已作废': '已撤销', '已并入': '已合并'}.get(v, v)
            elif k == '项目':
                cur['project'] = v
            elif k == '出处':
                cur['source'] = v
            elif k == '备注':
                cur['note'] = v
            elif k == '生效范围':
                cur['scope'] = v
            elif k == '落地':
                cur['landed'] = v
    if cur:
        rows.append(cur)
    return rows


def load_policies():
    """{项目id: 全文}（项目 id = 文件名去 .md）"""
    out = {}
    for p in glob.glob(os.path.join(POLICY_DIR, '*.md')):
        pid = os.path.basename(p)[:-3]
        out[pid] = read(p)
    return out


def load_project_aliases():
    """`registry.yaml` 的 `name:` → `id:` 映射。

    ⚠ 为什么必须有（2026-11-23 第一次跑就栽了）：
      决策台账里 `- 项目: 司天` 写的是**中文名**，而方针卡文件名是**英文 id**（`sitian.md`）。
      不映射的话，`policies.get('司天')` 恒为 None → 全部判成 `no_policy`，
      而少部分恰好英文 id 的才命中 → 第一版跑出 `landed=0`，看起来像"一件都没落地"。
      那正是本仓记过三次的老病：**键对不上 → 整列变空，脚本还照样退出 0**。
    """
    text = read(os.path.join(ROOT, 'registry.yaml'))
    alias = {}
    cur_id = ''
    for line in text.split('\n'):
        m = re.match(r'^\s*-\s*id:\s*(\S+)', line)
        if m:
            cur_id = unquote(m.group(1))
            alias[cur_id] = cur_id
            continue
        m = re.match(r'^\s+name:\s*(.+)$', line)
        if m and cur_id:
            alias[unquote(m.group(1))] = cur_id
    return alias


def resolve_project(raw, alias):
    """项目名/别名 → 方针卡 id。认不出原样返回（交给 judge 判 no_policy）。"""
    p = unquote(raw)
    if not p:
        return ''
    return alias.get(p, p)


def build_card_index():
    """{卡 id: 路径}，含 archive/ 与 .trash/（卡会搬家，这一点台账索引里也验证过）。"""
    idx = {}
    for p in glob.glob(os.path.join(TASK_DIR, '**', '*.md'), recursive=True):
        base = os.path.basename(p)[:-3]
        idx.setdefault(base, p)
    return idx


def git_commits():
    """仓库里所有提交的短号（7 位）集合。取不到就返回空 —— 不假装有。"""
    try:
        out = subprocess.run(
            ['git', '-C', ROOT, 'log', '--format=%h', '--all'],
            capture_output=True, text=True, timeout=30,
            encoding='utf-8', errors='replace',
        )
        if out.returncode != 0:
            return set()
        return {ln.strip() for ln in out.stdout.split('\n') if ln.strip()}
    except (OSError, subprocess.SubprocessError):
        return set()


def judge(dec, cards, commits):
    """一条决策 → landed / orphan / no_ref / declared

    两个判据并存（2026-11-23 起）：
      ① **结构化判据**：决策卡有 `落地:` 字段（`task-xxx` / `commit:xxx` / `不做(理由)`）。
         有它就按它判 —— 这是唯一能"一秒算完"的口径。
      ② **文本判据（老口径，保留）**：正文里写了卡号/提交号就核对它存不存在。

    ⚠ 为什么留两套：`落地` 字段是 2026-11-23 才加的，存量 145 条一条都没有。
       只按 ① 判的话，存量全部落进"没声明"，那份报告毫无信息量。
       两套并列才能既说清存量现状，又让新写的决策可核。

    ⚠ `落地: 不做(理由)` 是**合法结局**，不是 orphan。
       "定过但不做"与"说做了却找不到"是两件事，混在一起会把诚实记录判成撒谎。
    """
    declared = dec.get('landed') or ''
    if declared:
        kind, payload = split_declared(declared)
        if kind == 'skip':
            return {'verdict': 'declared_skip', 'cards': [], 'cards_found': [],
                    'commits': [], 'commits_found': [], 'declared': declared,
                    'why': '声明为「不做」：%s' % (payload or '未写理由')}
        if kind == 'card':
            ids = RE_CARD.findall(payload)
            found = [c for c in ids if c in cards]
            if ids and len(found) == len(ids):
                return {'verdict': 'landed', 'cards': ids, 'cards_found': found,
                        'commits': [], 'commits_found': [], 'declared': declared,
                        'why': '落地字段点名的卡都存在'}
            return {'verdict': 'orphan', 'cards': ids, 'cards_found': found,
                    'commits': [], 'commits_found': [], 'declared': declared,
                    'why': '落地字段点名的卡找不到'}
        if kind == 'commit':
            return judge_commits(payload, commits, declared)
        # 认不出格式 → 如实说"声明了但没法核"，不许算 landed
        return {'verdict': 'orphan', 'cards': [], 'cards_found': [],
                'commits': [], 'commits_found': [], 'declared': declared,
                'why': '落地字段写法认不出（只认 task-xxx / commit:xxx / 不做(理由)）'}

    blob = ' '.join([dec.get('title', ''), dec.get('note', ''), dec.get('source', '')])
    card_ids = sorted(set(RE_CARD.findall(blob)))
    # 提交号：排除掉卡 id 里那串数字（task-20261015-001 → 不会误判成 hex）
    raw_hex = set(RE_COMMIT.findall(RE_CARD.sub(' ', blob)))
    commit_ids = sorted(h for h in raw_hex if len(h) >= 7)

    if not card_ids and not commit_ids:
        return {'verdict': 'no_ref', 'cards': [], 'cards_found': [],
                'commits': [], 'commits_found': [], 'declared': '',
                'why': '正文里没有可核对的编号，也没有 `落地:` 字段'}

    cards_found = [c for c in card_ids if c in cards]
    commits_found = [c for c in commit_ids if any(c.startswith(h) or h.startswith(c) for h in commits)]

    if cards_found or commits_found:
        return {'verdict': 'landed', 'cards': card_ids, 'cards_found': cards_found,
                'commits': commit_ids, 'commits_found': commits_found, 'declared': '',
                'why': '点名的东西真实存在'}
    return {'verdict': 'orphan', 'cards': card_ids, 'cards_found': [],
            'commits': commit_ids, 'commits_found': [], 'declared': '',
            'why': '点名了 %d 个实体，一个都找不到' % (len(card_ids) + len(commit_ids))}


def split_declared(raw):
    """`落地:` 的写法 → (kind, payload)。kind ∈ card / commit / skip / unknown"""
    s = str(raw or '').strip()
    if not s:
        return ('unknown', '')
    low = s.lower()
    if low.startswith('commit:'):
        return ('commit', s[len('commit:'):].strip())
    if low.startswith('task-'):
        return ('card', s)
    if s.startswith('不做'):
        # `不做(理由)` / `不做：理由` / 光一个 `不做`
        m = re.match(r'^不做\s*[（(](.*)[）)]\s*$', s) or re.match(r'^不做\s*[:：]\s*(.*)$', s)
        return ('skip', m.group(1).strip() if m else '')
    return ('unknown', s)


def judge_commits(payload, commits, declared):
    ids = RE_COMMIT.findall(payload)
    found = [c for c in ids if any(c.startswith(h) or h.startswith(c) for h in commits)]
    if ids and len(found) == len(ids):
        return {'verdict': 'landed', 'cards': [], 'cards_found': [],
                'commits': ids, 'commits_found': found, 'declared': declared,
                'why': '落地字段点名的提交都存在'}
    return {'verdict': 'orphan', 'cards': [], 'cards_found': [],
            'commits': ids, 'commits_found': found, 'declared': declared,
            'why': '落地字段点名的提交找不到（或那个值不是提交号）'}


def unquote_decision_field(dec, key):
    """从一条决策里取原始字段值（parse_decisions 没存的键，回原文再抠一次）。"""
    return str(dec.get(key) or '').strip()


def self_test():
    """判据自证：`落地:` 七种写法的判定（2026-11-23 新增，跑 `--self-test`）。

    为什么脚本自带自证：这套判定是本仓最容易"看起来在工作"的地方 ——
    存量 145 条决策**一条都没有** `落地` 字段，主流程走到那个分支是 0 次。
    没有自证的话，`declared` 那段代码可以整段写错而报告照样好看。
    """
    cards = {'task-20261123-001'}
    commits = {'abc1234'}
    cases = [
        ('task-20261123-001', 'landed', '点名的卡真存在'),
        ('task-20261123-999', 'orphan', '点名的卡不存在 → 必须红'),
        ('commit:abc1234', 'landed', '点名的提交真存在'),
        ('commit:deadbee', 'orphan', '点名的提交不存在 → 必须红'),
        ('不做(已并入 D-165)', 'declared_skip', '「不做+理由」是合法结局，不是 orphan'),
        ('不做', 'declared_skip', '光写「不做」也算声明（理由可以空）'),
        ('随便写的', 'orphan', '写法认不出 → 不许当 landed'),
        ('', 'no_ref', '空 = 没声明，落回文本判据'),
    ]
    bad = 0
    for val, want, why in cases:
        d = {'id': 'D-SELFTEST', 'title': '自证用', 'note': '', 'source': '', 'landed': val}
        got = judge(d, cards, commits)['verdict']
        ok = got == want
        print(('  ok  ' if ok else '  FAIL') + f' {val!r} → {got}（期望 {want}）　{why}')
        if not ok:
            bad += 1
    # 反例：把 `不做` 判成 orphan，就是"诚实记录被判成撒谎"
    d = {'id': 'D-SELFTEST', 'title': 't', 'note': '', 'source': '', 'landed': '不做(原因)'}
    r = judge(d, cards, commits)
    if r['verdict'] != 'declared_skip':
        bad += 1
        print('  FAIL 「不做」被误判成', r['verdict'])
    return bad


def main():
    ap = argparse.ArgumentParser(description='对账 (a)：决策 ↔ 它引用的卡/提交（只读，不调模型）')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--check', action='store_true', help='只打印计数（供守卫断言）')
    ap.add_argument('--self-test', action='store_true', help='只跑判据自证（不读真数据）')
    a = ap.parse_args()

    if a.self_test:
        bad = self_test()
        print(f'\n自证：{8 + 1 - bad} / 9 通过')
        return 1 if bad else 0

    rows = parse_decisions(read(DECISIONS))
    cards = build_card_index()
    commits = git_commits()

    # 「现行」= 有效；已撤销/已合并不参与（它们不是现行规矩）
    live = [r for r in rows if (r['status'] or '有效') == '有效']
    results = []
    for d in live:
        r = judge(d, cards, commits)
        results.append({**d, **r})

    tally = {'landed': 0, 'orphan': 0, 'no_ref': 0}
    for r in results:
        tally[r['verdict']] += 1

    if a.check:
        print(json.dumps({
            'decisions_total': len(rows),
            'decisions_live': len(live),
            'cards_indexed': len(cards),
            'commits_known': len(commits),
            'landed': tally['landed'],
            'orphan': tally['orphan'],
            'no_ref': tally['no_ref'],
        }, ensure_ascii=False))
        # 读成 0 一律当坏（本仓栽过三次）
        return 1 if (len(live) == 0 or len(cards) == 0) else 0

    if a.json:
        print(json.dumps({'tally': tally, 'rows': results}, ensure_ascii=False, indent=2))
        return 0

    print('决策 %d 条（现行 %d；已撤销/已合并 %d 不参与）'
          % (len(rows), len(live), len(rows) - len(live)))
    print('可核对：卡 %d 张 / 提交 %d 个\n' % (len(cards), len(commits)))
    print('  landed（点名的东西真存在）  %3d' % tally['landed'])
    print('  orphan（点名了但找不到）    %3d  ← 这一列最有价值' % tally['orphan'])
    print('  no_ref（没点名，人来看）    %3d' % tally['no_ref'])
    print()
    if tally['orphan']:
        print('=== orphan 明细：「决策说做了，但找不到做它的东西」===')
        for r in results:
            if r['verdict'] != 'orphan':
                continue
            missing = r['cards'] + r['commits']
            print('  %s  %s  %s' % (r['id'], r['date'] or '(无日期)', r['title'][:52]))
            print('        点名: %s' % ', '.join(missing[:5]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
