# -*- coding: utf-8 -*-
"""台账 → 记忆索引 的**按需检索面**（2026-11-23）。

## 先说清它不是什么（2026-11-23 用户纠正，推翻了第一版立论）

用户原话：
> 「四份台账为什么要进入记忆？你想让 AI 每次什么都没干就带着 20 万字上下文入场？
>   记忆本来就该分层，不是什么东西都值得全量塞进去。」

这条纠正成立。**第一版把"台账没进索引"当成缺陷、写成"覆盖率 0.0%"，方向就是错的。**
按数字看更清楚：

    index-ledgers.jsonl      413,613 字节 ≈ 13.8 万字   ← 本文件的产出
    memory/core.md                    884 字           ← 每次会话真正自动注入的
    briefing 预算                     800 字
    search   预算                   1,500 字

把 13.8 万字塞进自动上下文 = 还没干活就先烧掉 14 万字的窗口。**那不是记忆，是灾难。**

所以本模块的产出**只用于按需检索**，与自动注入严格分开：

    memory/core.md              884 字   每次会话自动带（钉住的纪律）
    memory/index.jsonl           34 条   手写 claim，briefing/search 用
    memory/index-ledgers.jsonl  921 条  **只在有人显式查时才读**

判据：`memoryBriefing()` / `core` 里**一个台账字段都不许出现** ——
守卫 `scripts/test/e2e-memory-ledgers.cjs` 钉住这条（反例：把台账塞进 briefing → 必须红）。

## 那它有什么用

用户/agent 问"我们以前决定过 X 吗""这事是不是写过" —— 那时才需要跨 921 条台账找。
没有它，agent 只能 grep 源码或靠记忆瞎猜（本仓反复栽在"没记忆"上）；
有了它，一次查询返回**指针**（src_path + 标题 + 摘要），点开才读原文。

## 两条硬规矩（来自卡 4072d8c3，不重复论证）

① **只存指针，不存原文**。原文永远在源文件里。
   抄一份正文进索引 = 两份真相，早晚不一致 —— 本仓反复栽在这一点上。
② **零 token**。纯正则解析已有 frontmatter，不调任何模型。

## 与 v2 的关系

v2 的 `memory/claims/*.md`（一两句 claim + 逐字证据）是**人/agent 手动写的**，
本模块产出的是**从台账自动抽的指针**，两者**分开存**（`index.jsonl` vs `index-ledgers.jsonl`）：

    src_kind = manual    → 来自 memory/claims/*（v2 手写，现状不变）
    src_kind = decision  → task-data/decisions.md 的 ## D-xxx
    src_kind = log       → docs/执行日志/*.md
    src_kind = card      → task-data/*.md
    src_kind = charter   → policies/*.md

⚠ **分开存是刻意的**：合在一起会让"记忆有 N 条"这个数字同时代表两种东西，
   更会给未来的人一个"顺手一起注入"的机会 —— 那正是本次纠正要防的。

用法：
    python scripts/memory_ledgers.py --rebuild     # 重扫台账，写 memory/index-ledgers.jsonl
    python scripts/memory_ledgers.py --check       # 校验（指针可解析 / 无原文全文 / 条数>0）
    python scripts/memory_ledgers.py --stats       # 只看各类条数
"""
import argparse
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASK_DIR = os.path.join(ROOT, 'task-data')
LOG_DIR = os.path.join(ROOT, 'docs', '执行日志')
POLICY_DIR = os.path.join(ROOT, 'policies')
OUT = os.path.join(ROOT, 'memory', 'index-ledgers.jsonl')

# 摘要硬上限：索引是"能一眼扫过"的东西，不是正文仓库
SUMMARY_MAX = 120


def read_text(path):
    """读 UTF-8（容忍 BOM）。读不了返回 None —— 由调用方决定"跳过"还是"报错"。"""
    try:
        with open(path, 'r', encoding='utf-8-sig') as f:
            return f.read()
    except OSError:
        return None


def split_frontmatter(text):
    """切 frontmatter。没有就返回 ({}, 全文)。

    ⚠ 块式值（2026-11-23 实测踩到）：
        ```
        项目:
          sitian
        ```
    这是 `yaml.dump(..., default_flow_style=False)` 对**单元素列表**的写法（本仓 Python 侧就这么写）。
    第一版只认 `key: value` 同一行 → 62 张卡的 `项目` 全部读成空串，而文件里明明有。
    这就是 AGENTS.md 记过三次的老病（"键存在但读成空"）的第四种形态。
    这里把"值在下一行（可多行缩进）"也吃进来，合并成一行。
    """
    m = re.match(r'^---\r?\n(.*?)\r?\n---\r?\n?', text, re.S)
    if not m:
        return {}, text
    raw = m.group(1)
    fm = {}
    lines = raw.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i].rstrip('\r')
        mm = re.match(r'^([^\s:：#][^:：]*)\s*[:：]\s*(.*)$', line)
        if not mm:
            i += 1
            continue
        key, val = mm.group(1).strip(), mm.group(2).strip()
        # 值在下一行：本行空 + 后续是缩进行（块式列表/标量）
        if not val and i + 1 < len(lines) and re.match(r'^\s+\S', lines[i + 1]):
            parts = []
            j = i + 1
            while j < len(lines) and re.match(r'^\s+\S', lines[j]):
                t = lines[j].strip()
                if t.startswith('- '):
                    t = t[2:].strip()
                parts.append(t)
                j += 1
            # 单元素块式 → 直接取那个值；多元素 → 用 | 连（检索时仍可命中）
            val = parts[0] if len(parts) == 1 else '|'.join(parts)
            fm[key] = val
            i = j
            continue
        fm[key] = val
        i += 1
    return fm, text[m.end():]


def unquote(v):
    """剥 YAML 引号。

    ⚠ 2026-11-23 实测踩到：日志与任务卡的 frontmatter 值是 `'2026-09-25T04:43:12.039Z'`
    （带单引号），不剥的话 698/921 条时间全带引号，排序、比较、显示全不对。
    只剥**成对**的引号，不要用 strip("'") —— 那会吃掉值本身合法的引号。
    """
    s = str(v or '').strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1]
    return s


def fm_get(fm, *keys):
    """中文键与英文键双认（本仓栽过至少三次：只认英文 → 整列静默变空）。"""
    for k in keys:
        if k in fm and str(fm[k]).strip():
            return unquote(fm[k])
    return ''


def clip(s, n=SUMMARY_MAX):
    s = ' '.join(str(s or '').split())
    return s if len(s) <= n else s[:n] + '…'


def rel(path):
    return os.path.relpath(path, ROOT).replace('\\', '/').replace('E:/CODE/CangKu/fangcun/', '')


# ── 各台账的抽取 ───────────────────────────────────────────────────────

def scan_decisions():
    """决策卡：`## D-xxx 标题` + 下面的 `- 状态/项目/出处/日期` 缩进列表。"""
    path = os.path.join(TASK_DIR, 'decisions.md')
    text = read_text(path)
    if text is None:
        return []
    rows = []
    cur = None
    for line in text.replace('\r\n', '\n').split('\n'):
        h = re.match(r'^##\s+(D-\d+)\s+(.*)$', line)
        if h:
            if cur:
                rows.append(cur)
            cur = {'src_kind': 'decision', 'id': h.group(1), '标题': clip(h.group(2)),
                   '摘要': '', '状态': '', '项目': '', '出处': '', '时间': '',
                   'src_path': rel(path), 'src_anchor': h.group(1)}
            continue
        if cur is None:
            continue
        kv = re.match(r'^-\s*(日期|状态|项目|出处|备注|更新)\s*[:：]\s*(.*)$', line)
        if kv:
            k, v = kv.group(1), unquote(kv.group(2))
            if k == '日期':
                cur['时间'] = v
            elif k == '状态':
                # 老词归一（与 data/decisions.ts 同口径）
                cur['状态'] = {'作数': '有效', '已作废': '已撤销', '已并入': '已合并'}.get(v, v)
            elif k == '项目':
                cur['项目'] = v
            elif k == '出处':
                cur['出处'] = clip(v, 80)
            elif k == '备注':
                # ⚠ 2026-11-23：决策卡原先**没有摘要**（155 条空缺）——
                # 因为摘要只从 `## D-xxx 标题` 取，而决策的"内容"其实就是那条标题，
                # 真正有信息量的是 `- 备注:`。有备注就优先用它。
                cur['摘要'] = clip(v)
    if cur:
        rows.append(cur)
    return rows


def scan_logs():
    """执行日志：frontmatter 的 标题/项目/状态 + 正文首段做摘要。"""
    rows = []
    for path in sorted(glob.glob(os.path.join(LOG_DIR, '*.md'))):
        text = read_text(path)
        if text is None:
            continue
        fm, body = split_frontmatter(text)
        title = fm_get(fm, '标题', 'title') or os.path.basename(path)[:-3]
        # 摘要：正文第一段非空、非标题行
        summary = ''
        for ln in body.split('\n'):
            t = ln.strip()
            if not t or t.startswith('#') or t.startswith('>'):
                continue
            summary = t
            break
        rows.append({
            'src_kind': 'log',
            'id': fm_get(fm, 'id') or os.path.basename(path)[:-3],
            '标题': clip(title),
            '摘要': clip(summary),
            '项目': fm_get(fm, '项目', 'project'),
            '状态': fm_get(fm, '状态', 'status'),
            '时间': fm_get(fm, '创建', '时间', 'created'),
            'src_path': rel(path),
            'src_anchor': '',
        })
    return rows


def scan_cards():
    """任务卡：frontmatter 标题/状态/项目/优先级 + 最近一条 result_log 做摘要。

    ⚠ 只扫顶层 `task-data/*.md`，不进 archive / .trash / plans / questionnaires
    （那些有各自的消费方，混进来会让"未完成 185 张"这类数字失真）。
    """
    rows = []
    for path in sorted(glob.glob(os.path.join(TASK_DIR, '*.md'))):
        name = os.path.basename(path)
        if name.startswith('_') or name in ('decisions.md', 'question-bank.md', 'rice-pool.md'):
            continue
        text = read_text(path)
        if text is None:
            continue
        fm, body = split_frontmatter(text)
        # 没有 状态 字段的就不是任务卡（决策台账/题库等数据文件）
        status = fm_get(fm, '状态', 'status')
        if not status:
            continue
        rows.append({
            'src_kind': 'card',
            'id': fm_get(fm, 'id') or name[:-3],
            '标题': clip(fm_get(fm, '标题', 'title')),
            '摘要': clip(strip_md(body.split('\n\n')[0] if body.strip() else '')),
            '项目': fm_get(fm, '项目', 'project'),
            '状态': status,
            '优先级': fm_get(fm, '优先级', 'priority'),
            '时间': fm_get(fm, '更新', '创建', 'updated', 'created'),
            'src_path': rel(path),
            'src_anchor': '',
        })
    return rows


def scan_charters():
    """方针卡：只看四节标题与每节首句（不抄整节）。"""
    rows = []
    for path in sorted(glob.glob(os.path.join(POLICY_DIR, '*.md'))):
        text = read_text(path)
        if text is None:
            continue
        pid = os.path.basename(path)[:-3]
        lines = text.replace('\r\n', '\n').split('\n')
        h1 = next((l[2:].strip() for l in lines if l.startswith('# ')), pid)
        heads = [l.strip('# ').strip() for l in lines if re.match(r'^##\s', l)]
        rows.append({
            'src_kind': 'charter',
            'id': pid,
            '标题': clip(h1),
            '摘要': clip(' / '.join(heads)) if heads else '',
            '项目': pid,
            '状态': '有效',
            '时间': '',
            'src_path': rel(path),
            'src_anchor': '',
        })
    return rows


def strip_md(s):
    s = re.sub(r'`{1,3}', '', s or '')
    s = re.sub(r'^\s*[-*+]\s+', '', s, flags=re.M)
    s = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', s)
    s = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', s)
    return s


# ── 输出 / 校验 ────────────────────────────────────────────────────────

def collect():
    rows = scan_decisions() + scan_logs() + scan_cards() + scan_charters()
    # 摘要兜底：没有「备注」也没有首段的，用标题顶上 ——
    # 摘要为空会让检索结果看起来"这条记忆什么也没说"，比不复用更糟。
    for r in rows:
        if not str(r.get('摘要', '')).strip():
            r['摘要'] = r.get('标题', '')
    return rows


def write_index(rows):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    return len(rows)


def resolve_src(rel_path):
    """把索引里的 src_path 解析成**现在真实存在的路径**。

    ⚠ 为什么需要（2026-11-23 实测）：任务卡会**归档**（`task-data/` → `task-data/archive/`），
    归档后索引里那条指针就失效了 —— 实测 921 条里 46 条这样。
    那不是坏索引，是"卡动过了"这个正常事实。

    处理：原路径不存在时，按**文件名**在 archive/ 与 .trash/ 里找。
    找不到才算真失效（那种才该报红）。

    为什么不在 rebuild 时把路径改成 archive/：
      卡可能被反复归档/还原；把"当前位置"固化进索引，每次移动都要重建。
      按文件名回退解析是**幂等**的，不需重建。
    """
    if not rel_path:
        return None
    direct = os.path.join(ROOT, rel_path)
    if os.path.exists(direct):
        return direct
    base = os.path.basename(rel_path)
    if not base:
        return None
    for sub in ('task-data/archive', 'task-data/.trash'):
        cand = os.path.join(ROOT, sub, base)
        if os.path.exists(cand):
            return cand
    return None


def check(rows):
    """校验。判据必须能抓"读成 0"——本仓栽过三次，读错格式会静默报 0。"""
    issues = []
    if not rows:
        issues.append('抽出 0 条 —— 这几乎一定是解析坏了，不是台账空了')

    by_kind = {}
    for r in rows:
        by_kind[r['src_kind']] = by_kind.get(r['src_kind'], 0) + 1
    # 每一类都必须 >0（某类为 0 = 那一路解析失效）
    for kind in ('decision', 'log', 'card', 'charter'):
        if not by_kind.get(kind):
            issues.append('台账「%s」抽出 0 条 —— 那一路解析坏了' % kind)

    # 指针必须可解析（允许归档后的回退解析；真找不到才算坏）
    missing = [r['src_path'] for r in rows if resolve_src(r['src_path']) is None]
    if missing:
        issues.append('%d 条指针指向不存在的文件（归档回退也没找到），例：%s' % (len(missing), missing[0]))

    # 不许存原文全文：摘要长度硬上限
    too_long = [r['id'] for r in rows
                if len(str(r.get('摘要', ''))) > SUMMARY_MAX + 1 or len(str(r.get('标题', ''))) > SUMMARY_MAX + 1]
    if too_long:
        issues.append('%d 条摘要超过 %d 字（索引不许存正文），例：%s' % (len(too_long), SUMMARY_MAX, too_long[0]))

    # 字段不许带 YAML 引号（2026-11-23：698/921 条时间曾是 '2026-…'）
    quoted = [r['id'] for r in rows
              if any(str(r.get(k, '')).startswith(("'", '"')) for k in ('时间', '项目', '状态'))]
    if quoted:
        issues.append('%d 条的字段还带着 YAML 引号（没剥），例：%s' % (len(quoted), quoted[0]))

    # 摘要不许空（空摘要 = 检索结果毫无信息量）
    empty = [r['id'] for r in rows if not str(r.get('摘要', '')).strip()]
    if empty:
        issues.append('%d 条摘要为空，例：%s' % (len(empty), empty[0]))
    return issues


def stats():
    rows = collect()
    by_kind = {}
    for r in rows:
        by_kind[r['src_kind']] = by_kind.get(r['src_kind'], 0) + 1
    print('=== 台账 → 记忆索引 ===')
    for k in ('decision', 'log', 'card', 'charter'):
        print('  %-10s %5d' % (k, by_kind.get(k, 0)))
    print('  %-10s %5d' % ('合计', len(rows)))
    if os.path.exists(OUT):
        n = sum(1 for ln in open(OUT, encoding='utf-8') if ln.strip())
        print('  已落盘 index-ledgers.jsonl: %d 行' % n)
    else:
        print('  未落盘（跑 --rebuild）')


def main():
    ap = argparse.ArgumentParser(description='台账 → 记忆索引（零 token，只存指针）')
    ap.add_argument('--rebuild', action='store_true', help='重扫台账并写 memory/index-ledgers.jsonl')
    ap.add_argument('--check', action='store_true', help='校验（非零退出=不一致）')
    ap.add_argument('--stats', action='store_true', help='只看各类条数')
    a = ap.parse_args()

    if a.stats:
        stats()
        return 0

    if a.check:
        issues = check(collect())
        for s in issues:
            print('FAIL ' + s)
        print('RESULT 一致' if not issues else 'RESULT %d 处不一致' % len(issues))
        return 1 if issues else 0

    if a.rebuild:
        rows = collect()
        issues = check(rows)
        if issues:
            for s in issues:
                print('FAIL ' + s)
            print('拒绝写入 —— 先修上面的问题（写坏索引比没有索引更糟）')
            return 1
        n = write_index(rows)
        print('已写 %s（%d 条，只存指针与摘要）' % (rel(OUT), n))
        return 0

    ap.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
