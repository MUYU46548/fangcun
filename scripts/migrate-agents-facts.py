#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""AGENTS.md「踩过的坑」→ 记忆 claim（2026-11-24 · 问卷 C2=B）

## 为什么做这件事

问卷第 3 层 C2 你选了 **B：AGENTS.md 只留指针，正文搬进记忆（单一真相源）**。
理由是实测：`AGENTS.md` 全文 78412 字节、已被截断到 65243 —— 它既太大，又装着
**11 条最该被检索到的机器事实**（5473 字），而这些事实在记忆库里**一条都没有**，
搜 `BOM` / `PowerShell` / `编码` 各命中 0 条（A2 的验收线就是失败在这）。

两份可编辑的真相 = 迟早漂移（11-20 规划里点过的病）。所以：**正文搬进记忆，AGENTS.md 留指针。**

## 它怎么做（三条硬约束）

① **只搬，不重写**：`## 证据` 里放 AGENTS.md 的**原文逐字**，一个字不删不改。
   claim 是索引句，原文才是真相本体。
② **幂等**：同一个 `来源id` 已存在就跳过；跑两遍条数不变。
③ **默认干跑**：`--apply` 才写盘；写之前备份到 `memory/.backup/agents-facts-<时间戳>/`。

用法：
    python scripts/migrate-agents-facts.py            # 干跑：打印会写什么，零写入
    python scripts/migrate-agents-facts.py --apply    # 真写
    python scripts/migrate-agents-facts.py --check    # 校验（每条都有证据、claim ≤200）
"""
import argparse
import datetime
import hashlib
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS = os.path.join(ROOT, 'AGENTS.md')
CLAIMS = os.path.join(ROOT, 'memory', 'claims')
BACKUP_ROOT = os.path.join(ROOT, 'memory', '.backup')

SECTION = '## 踩过的坑'

# 每条坑的 claim（一句话，≤120 字理想/200 硬上限）。
# ⚠ 这些 claim 是**从原文提炼的索引句**，不是改写原文；原文进 `## 证据` 逐字保留。
# 键 = `### ` 标题里开头的编号（如 "1." / "6b."），值是 claim。
CLAIMS_BY_NO = {
    '1.': 'Vue 响应式对象不能整个过 contextBridge（必须先 toPlain），否则界面只报一句「保存失败」，真因看不出。',
    '2.': '新增 UI 块不要复用旧块的 class —— 断言按 class 数块数，套旧类会让旧断言凭空变红而界面看起来正常。',
    '3.': '断言「时间演化」的量，必须跨过至少一个 tick 再断言，否则测的是同一个瞬间。',
    '4.': '折叠或隐藏按钮前，先扫一遍「按文字点它」的断言 —— 隐藏后那些断言会找不到元素。',
    '5.': '`tsconfig` 是 `strict: false`：`if (!r.ok)` 不收窄可辨识联合，要写类型谓词 `isXxxOk(r)`。',
    '6.': 'BOM 按文件类型分场景：脚本（.ps1/.bat）要带，数据文件（.md/.json/.yaml）绝不能带 —— 写数据文件只用 fs.writeFileSync 或 UTF8Encoding($false)，永不用 Set-Content。',
    '6b.': '一次性操作别造一堆入口文件：逻辑放 scripts/，入口只留一个，%TEMP% 脚本用完即删。',
    '7.': '截图 harness 的 `--virtual-time-budget` 会把 `Date.now()` 一起快进，时间相关的断言会假绿/假红。',
    '8.': '工作区的 `*.asar` 会被文件索引器锁住 —— 别用「改路径」去绕，退出索引器或换输出目录。',
    '9.': '只修用户提的那个故障，不要顺手改架构 —— 越界改动会把一次修复变成一次事故。',
    '10.': '绝不允许按进程名批量杀浏览器 —— 会连带杀掉用户的窗口，只能按 PID 精确处理。',
}

# 每条的事实粒度 → 重要度（1–5）。5 = 不可逆损失/安全事故。
IMPORTANCE = {
    '1.': 5, '2.': 4, '3.': 3, '4.': 3, '5.': 4,
    '6.': 5, '6b.': 3, '7.': 4, '8.': 4, '9.': 5, '10.': 5,
}
# 钉住：开工就该知道的那几条（与 core.md 预算一起权衡，不要贪多）
PINNED = {'6.', '10.', '9.'}

_TITLE_RE = re.compile(r'^### (.+)$', re.M)
_NO_RE = re.compile(r'^(\d+[a-z]?)\.\s')


def read_agents():
    with open(AGENTS, 'r', encoding='utf-8-sig') as f:
        return f.read()


def split_pitfalls(text):
    """切出「踩过的坑」一节里的每一条；返回 [(编号, 标题, 正文段)]。"""
    i = text.find(SECTION)
    if i < 0:
        raise SystemExit('AGENTS.md 里找不到 `%s` 这一节' % SECTION)
    j = text.find('\n## ', i + len(SECTION))
    seg = text[i:] if j < 0 else text[i:j]

    parts = re.split(r'(?m)^### ', seg)
    out = []
    for p in parts[1:]:
        title = p.split('\n', 1)[0].strip()
        m = _NO_RE.match(title)
        if not m:
            continue
        out.append((m.group(1) + '.', title, p.rstrip()))
    return out


def existing_source_ids():
    """已经搬过的 `来源id`（幂等用）。"""
    got = set()
    if not os.path.isdir(CLAIMS):
        return got
    for fn in os.listdir(CLAIMS):
        if not fn.endswith('.md'):
            continue
        try:
            with open(os.path.join(CLAIMS, fn), 'r', encoding='utf-8-sig') as f:
                t = f.read()
        except OSError:
            continue
        m = re.search(r'(?m)^来源id:\s*(.+)$', t)
        if m:
            got.add(m.group(1).strip())
    return got


def one_line(s):
    return re.sub(r'\s+', ' ', str(s or '')).strip()


def next_seq(taken):
    n = 1
    while n in taken:
        n += 1
    return n


def render(no, title, body, today):
    """生成一条 claim 文件的内容。`## 证据` 是 AGENTS.md 原文**逐字**。"""
    claim = CLAIMS_BY_NO[no]
    imp = IMPORTANCE.get(no, 3)
    pinned = 'true' if no in PINNED else 'false'
    tags = ['工具坑', '环境事实', 'AGENTS.md']
    hash8 = hashlib.sha256(body.encode('utf-8')).hexdigest()[:8]
    return (
        '---\n'
        'id: {id}\n'
        '类型: 事实\n'
        '可信度: 0.95\n'
        '重要度: {imp}\n'
        '项目: 跨项目\n'
        '适用范围: 跨项目\n'
        '状态: 有效\n'
        '来源: AGENTS.md「踩过的坑」第 {no} 条（原文逐字）\n'
        '来源id: agents-pitfall-{no}\n'
        '时间: {today}\n'
        '半衰期: 0\n'
        '钉住: {pinned}\n'
        '召回权重: 1\n'
        '编号: K{no_clean}\n'
        'tags: [{tags}]\n'
        '格式: 2\n'
        '原文hash: {hash8}\n'
        '---\n'
        '\n'
        '## 记忆\n'
        '\n'
        '{claim}\n'
        '\n'
        '## 证据\n'
        '\n'
        '> 以下为 `AGENTS.md` → 「{title}」**原文逐字**（2026-11-24 搬入；AGENTS.md 从此只留指针）。\n'
        '\n'
        '### {title}\n'
        '\n'
        '{body}\n'
    ).format(
        id='__ID__', imp=imp, no=no, today=today, pinned=pinned,
        tags=", ".join("'%s'" % t for t in tags), hash8=hash8, no_clean=no.rstrip('.'),
        claim=claim, title=title, body=body,
    )


def main():
    ap = argparse.ArgumentParser(description='AGENTS.md 踩过的坑 → 记忆 claim')
    ap.add_argument('--apply', action='store_true', help='真写盘（默认干跑）')
    ap.add_argument('--check', action='store_true', help='只校验已搬的条目')
    a = ap.parse_args()

    text = read_agents()
    pits = split_pitfalls(text)
    print('AGENTS.md「踩过的坑」实有 %d 条' % len(pits))

    # ── --check：校验已搬的 ─────────────────────────────────────────
    if a.check:
        # ⚠ 2026-11-24 修：搬完之后 AGENTS.md 那节只剩指针表，
        # `split_pitfalls()` 切出来是 0 条 —— 第一版 `--check` 因此永远报「一致」（假绿）。
        # 现在改成**从 claim 侧**校验：11 条 `来源id` 必须一条不缺，且每条 claim/证据合格。
        bad = 0
        have = existing_source_ids()
        want = ['agents-pitfall-%s' % no for no in CLAIMS_BY_NO]
        for sid in want:
            if sid not in have:
                print('FAIL 还没搬：%s' % sid)
                bad += 1
        if not want:
            print('FAIL 迁移表是空的（CLAIMS_BY_NO 没定义）')
            bad += 1
        print('应有 %d 条，已搬 %d 条' % (len(want), len([x for x in want if x in have])))
        # claim 长度、证据非空
        for fn in sorted(os.listdir(CLAIMS)):
            if not fn.endswith('.md'):
                continue
            p = os.path.join(CLAIMS, fn)
            with open(p, 'r', encoding='utf-8-sig') as f:
                t = f.read()
            if '类型: 事实' not in t:
                continue
            m = re.search(r'(?ms)^## 记忆\s*\n(.*?)^## 证据', t)
            claim = one_line(m.group(1)) if m else ''
            if not claim:
                print('FAIL %s：claim 为空' % fn); bad += 1
            elif len(claim) > 200:
                print('FAIL %s：claim %d 字 > 200' % (fn, len(claim))); bad += 1
            if '## 证据' not in t or len(t.split('## 证据', 1)[1].strip()) < 20:
                print('FAIL %s：证据为空或太短' % fn); bad += 1
        print('RESULT %s' % ('一致' if bad == 0 else '%d 处不一致' % bad))
        return 1 if bad else 0

    # ── 幂等：算还缺哪些 ────────────────────────────────────────────
    have = existing_source_ids()
    todo = [(no, title, body) for no, title, body in pits
            if 'agents-pitfall-%s' % no not in have]
    print('已搬 %d 条，待搬 %d 条' % (len(pits) - len(todo), len(todo)))
    if not todo:
        print('没有要搬的了（幂等）。')
        return 0

    # ── 从 AGENTS.md 里把正文抠掉，替换成指针表 ─────────────────────
    i = text.find(SECTION)
    j = text.find('\n## ', i + len(SECTION))
    old_seg = text[i:] if j < 0 else text[i:j]
    pointer = (
        '%s（会再犯的硬规则）\n\n'
        '> ⚠ **2026-11-24 起正文搬进记忆库**（问卷 C2=B：AGENTS.md 只留指针，单一真相源）。\n'
        '> 原因：这份文件已 78KB、被截断到 65KB，而这 11 条最该被检索的机器事实\n'
        '> 在记忆库里一条都没有（搜 `BOM` / `PowerShell` / `编码` 各命中 0 条）。\n'
        '>\n'
        '> **怎么读**：`memory_search` 搜关键词，或看 `memory_briefing`；\n'
        '> 每条的类型是 `事实`、半衰期 0（不衰减），`## 证据` 里是本节的**原文逐字**。\n'
        '>\n'
        '> **怎么改**：改记忆里的那条 claim（它在记忆页可编辑），**不要再往这里加正文** ——\n'
        '> 两份可编辑的真相 = 迟早漂移。要加新坑，用 `memory_write` 起草、人点通过。\n'
        '\n'
        '| # | 一句话 | 记忆 |\n'
        '|---|---|---|\n'
    )
    for no, title, body in pits:
        sid = 'agents-pitfall-%s' % no
        short = title.split('. ', 1)[-1] if '. ' in title else title
        pointer += '| %s | %s | %s |\n' % (no, short, sid)
    pointer += (
        '\n> 判据（可复跑）：`python scripts/migrate-agents-facts.py --check` → RESULT 一致；\n'
        '> 且 `python scripts/memory.py --q BOM` 必须命中 > 0 条（A2 的验收线）。\n'
    )

    today = datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()
    taken = set()
    lines = []
    for k, (no, title, body) in enumerate(todo, 1):
        n = next_seq(taken)
        taken.add(n)
        sid = 'mem-%s-%02d' % (datetime.datetime.now().strftime('%Y%m%d'), n)
        lines.append((sid, render(no, title, body, today)))

    print('\n--- 将写入 %d 条 claim ---' % len(lines))
    for sid, c in lines:
        print('  %s  <- agents-pitfall-%s' % (sid, re.search(r'来源id: agents-pitfall-(\S+)', c).group(1)))
    print('\n--- AGENTS.md 那一节会被换成 %d 行指针表（%d 字 → %d 字）---'
          % (len(pits) + 12, len(old_seg), len(pointer)))

    if not a.apply:
        print('\n（干跑，零写入。加 --apply 才真写。）')
        return 0

    # ── 真写：先备份，再原子写 ──────────────────────────────────────
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    bdir = os.path.join(BACKUP_ROOT, 'agents-facts-%s' % stamp)
    os.makedirs(bdir, exist_ok=True)
    shutil.copy2(AGENTS, os.path.join(bdir, 'AGENTS.md'))
    print('\n已备份 AGENTS.md -> %s' % bdir)

    os.makedirs(CLAIMS, exist_ok=True)
    for sid, c in lines:
        p = os.path.join(CLAIMS, sid + '.md')
        if os.path.exists(p):
            print('  跳过（已存在）：%s' % sid)
            continue
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write(c.replace('__ID__', sid))
        print('  写入 %s' % sid)

    new_text = text[:i] + pointer + (text[j:] if j >= 0 else '')
    tmp = AGENTS + '.tmp-write'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        f.write(new_text)
    os.replace(tmp, AGENTS)
    print('AGENTS.md 已替换为指针表：%d 字 → %d 字' % (len(text), len(new_text)))
    print('\n下一步：python scripts/memory.py --rebuild && python scripts/memory.py --q BOM')
    return 0


if __name__ == '__main__':
    sys.exit(main())
