#!/usr/bin/env python3
"""方寸 · 记忆检索 v2（零依赖，只读）

2026-11-20 v2：一条记忆 = **claim（## 记忆，1–2 句）+ 证据（## 证据，原文逐字）**。
检索/列表只给 claim；证据只在 memory_read（TS 侧）按需取。本脚本只读，不写记忆。

用法：
  python scripts/memory.py                      # 列全部（按时间倒序）
  python scripts/memory.py --type 事故
  python scripts/memory.py --project dsh-fangcun
  python scripts/memory.py --scope 跨项目
  python scripts/memory.py --q "kill"
  python scripts/memory.py --pending            # 只看待审批
  python scripts/memory.py --all                # 含已撤销与待审批
  python scripts/memory.py --json
  python scripts/memory.py --rebuild            # 重建 memory/index.jsonl
  python scripts/memory.py --check              # 校验索引 + v2 格式（非零退出=不一致）
  python scripts/memory.py --ledgers --q "黑窗口"   # 同时搜四份台账（指针，不抄正文）
  python scripts/memory.py --ledgers --kind log    # 只看执行日志
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM_DIR = os.path.join(ROOT, 'memory')
INDEX = os.path.join(MEM_DIR, 'index.jsonl')
# 台账索引（2026-11-23）：由 scripts/memory_ledgers.py 生成，只存指针 + 摘要。
# ⚠ 与 index.jsonl 分开两个文件：一个是"人写的一两句 claim"，一个是"机器抽的台账指针"，
#   混在一起会让"记忆条数"这个数字同时代表两种东西（本仓吃过的亏）。
LEDGER_INDEX = os.path.join(MEM_DIR, 'index-ledgers.jsonl')

FM_RE = re.compile(r'^---\s*$', re.M)
CORE_BUDGET = 800
CLAIM_HARD = 200


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


def section(body, name):
    """取 `## <name>` 那一节（到下一个 `##` 为止）。"""
    m = re.search(r'^##\s*%s\s*$' % re.escape(name), body or '', re.M)
    if not m:
        return ''
    rest = body[m.end():]
    nxt = re.search(r'^##\s+', rest, re.M)
    return (rest[:nxt.start()] if nxt else rest).strip()


def last_section(body, name):
    """取 `## <name>` 到正文结尾；证据节里可能自带 `## 定级`，不能截。"""
    m = re.search(r'^##\s*%s\s*$' % re.escape(name), body or '', re.M)
    if not m:
        return ''
    return body[m.end():].strip()


def as_float(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def as_int(v, default):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def as_bool(v, default=False):
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ('true', '1', '是', 'yes'):
        return True
    if s in ('false', '0', '否', 'no'):
        return False
    return default


def infer_importance(impact):
    s = str(impact or '').strip()
    if s.startswith('严重'):
        return 5
    if s.startswith('高'):
        return 4
    if s.startswith('中'):
        return 3
    if s.startswith('低'):
        return 2
    return 3


def default_half_life(t):
    if t in ('纪律', '决定'):
        return 0
    if t == '偏好':
        return 180
    return 365


def title_summary(body):
    """v1 兼容：标题 + 第一段（别把 Markdown 标题/引用当摘要）。"""
    lines = [s.strip() for s in str(body or '').splitlines() if s.strip()]
    title, i = '', 0
    for i, s in enumerate(lines):
        if s.startswith('#'):
            title = s.lstrip('#').strip()
            i += 1
            break
    noise = re.compile(r'^(#{1,6}\s|>|\||```|[-*_]{3,}$)')
    clean = re.compile(r'^([-*+]\s+|\d+[.)]\s+)')
    for s in lines[i:]:
        if noise.match(s):
            continue
        c = clean.sub('', s).strip()
        if not c:
            continue
        return title, c[:120]
    return title, ''


def skip_dir(name):
    # `YYYY-MM` 是 v1 原始素材库（完整报告），claims/ 是提炼后的 v2 条目。
    # 两者同编号不同层级，都扫会 id 撞车 + 计数翻倍。v1 素材的职责是被引用当证据。
    if re.match(r'^\d{4}-\d{2}$', name):
        return True
    return name.startswith('.') or name in ('node_modules', 'evidence')


def scan_files():
    """从磁盘扫真实文件（索引是派生数据，不是真相源）。"""
    rows = []
    if not os.path.isdir(MEM_DIR):
        return rows
    for dirpath, dirnames, filenames in os.walk(MEM_DIR):
        dirnames[:] = [d for d in dirnames if not skip_dir(d)]
        for fn in filenames:
            if not fn.endswith('.md') or fn in ('README.md', 'core.md', 'core.manual.md'):
                continue
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, ROOT).replace('\\', '/')
            try:
                with open(p, 'r', encoding='utf-8-sig') as f:
                    text = f.read()
            except OSError as e:
                rows.append({'path': rel, 'id': '', 'error': str(e), 'claim': '',
                             'legacy': True, 'format': 1, 'evidence': ''})
                continue
            fm, body = parse_frontmatter(text)
            if str(fm.get('格式', '')).strip() == '证据':
                continue
            claim_sec = section(body, '记忆')
            legacy = str(fm.get('格式', '')).strip() != '2' and not claim_sec
            title, summary = title_summary(body)
            claim = ' '.join((claim_sec or title or summary).split())
            evidence = last_section(body, '证据') or (body.strip() if legacy else '')
            t = str(fm.get('类型', '')).strip()
            imp = as_int(fm.get('重要度'), infer_importance(fm.get('影响')))
            fmt = as_int(fm.get('格式'), 1 if legacy else 2)
            rows.append({
                'id': str(fm.get('id', '')),
                'type': t,
                'claim': claim,
                'title': claim or title,
                'summary': claim or summary,
                'confidence': as_float(fm.get('可信度'), 0.8 if legacy else 0.7),
                'importance': max(1, min(5, imp)),
                'source': str(fm.get('来源', '')),
                'time': str(fm.get('时间', '')),
                'project': str(fm.get('项目', '')),
                'status': str(fm.get('状态', '有效')),
                'impact': str(fm.get('影响', '')),
                'scope': str(fm.get('适用范围', '')),
                'evidence': evidence,
                'evidence_path': str(fm.get('证据', '')),
                'evidence_anchor': str(fm.get('证据锚点', '')),
                'review': str(fm.get('复核', '')),
                'half_life': as_int(fm.get('半衰期'), default_half_life(t)),
                'pinned': as_bool(fm.get('钉住'), False),
                'weight': as_float(fm.get('召回权重'), 1.0),
                'supersedes': str(fm.get('取代', '')),
                'superseded_by': str(fm.get('被取代', '')),
                'code': str(fm.get('编号', '')),
                'tags': fm.get('tags', []) if isinstance(fm.get('tags', []), list) else [],
                'path': rel,
                'format': fmt,
                'legacy': legacy,
                '_raw': text,
            })
    rows.sort(key=lambda r: r.get('time') or '', reverse=True)
    return rows


def build_index(rows):
    """jsonl：一行一条，只存**指针与摘要**，不存原文（防两份真相）。"""
    out = []
    for r in rows:
        out.append({
            'id': r.get('id', ''),
            '类型': r.get('type', ''),
            '记忆': r.get('claim', ''),
            '可信度': r.get('confidence', 0.7),
            '重要度': r.get('importance', 3),
            '项目': r.get('project', ''),
            '适用范围': r.get('scope', ''),
            '时间': r.get('time', ''),
            '状态': r.get('status', '有效'),
            '影响': r.get('impact', ''),
            '来源': r.get('source', ''),
            '证据': r.get('evidence_path', ''),
            '证据锚点': r.get('evidence_anchor', ''),
            '半衰期': r.get('half_life', 365),
            '钉住': r.get('pinned', False),
            '召回权重': r.get('weight', 1.0),
            '标题': r.get('title', ''),
            '摘要': r.get('claim', ''),
            '源文件': r.get('path', ''),
            'tags': r.get('tags', []),
            '格式': r.get('format', 1),
            'legacy': r.get('legacy', True),
        })
    return out


def search_hay(r):
    """检索用的文本：**只拼内容字段，不拼整篇原文**。

    ⚠ 2026-11-24 修。原先这里拼的是 `_raw`（整篇文件，含 frontmatter），
    于是**键名也被当内容搜**：`--q 格式` / `--q 状态` / `--q 来源` / `--q 证据` / `--q 类型`
    各命中 34/34 —— 全部是假命中，等于"搜什么都能搜到全部"。

    现在与 TS 侧 `memoryRank.ts` 的 `haystack()` 对齐：claim + 编号 + tags + id + 证据正文。
    证据正文仍参与（那是真的内容），但**键名不再参与**。
    """
    tags = r.get('tags') or []
    if not isinstance(tags, list):
        tags = [str(tags)]
    return ' '.join([
        str(r.get('claim', '')),
        str(r.get('code', '')),
        str(r.get('id', '')),
        ' '.join(str(t) for t in tags),
        str(r.get('evidence', '')),
    ]).lower()


def match(r, a):
    status = str(r.get('status', '') or '')
    if a.pending:
        if status != '待审批':
            return False
    elif not a.all:
        if status in ('已撤销', '待审批'):
            return False
    if a.type and a.type not in str(r.get('type', '')):
        return False
    if a.scope:
        if a.scope not in str(r.get('scope', '')) and a.scope != str(r.get('project', '')):
            return False
    if a.project and a.project != str(r.get('project', '')):
        return False
    if a.q:
        if a.q.lower() not in search_hay(r):
            return False
    return True


def check(rows):
    issues = []
    if not os.path.exists(INDEX):
        issues.append('索引不存在，先跑 --rebuild')
    idx = []
    if os.path.exists(INDEX):
        try:
            with open(INDEX, 'r', encoding='utf-8-sig') as f:
                for lineno, line in enumerate(f, 1):
                    if not line.strip():
                        continue
                    try:
                        idx.append(json.loads(line))
                    except json.JSONDecodeError as e:
                        issues.append('索引第 %d 行不是合法 JSON：%s' % (lineno, e))
        except OSError as e:
            issues.append('索引读不到：%s' % e)
    if len(idx) != len(rows):
        issues.append('条数不一致：索引 %d vs 源文件 %d' % (len(idx), len(rows)))
    by_src = {e.get('源文件'): e for e in idx}
    for r in rows:
        p = r.get('path')
        if p not in by_src:
            issues.append('索引里缺：%s' % p)
        elif not by_src[p].get('id'):
            issues.append('索引条目没有 id：%s' % p)
        claim = str(r.get('claim', ''))
        if not claim.strip():
            issues.append('%s: claim 为空' % p)
        elif len(claim) > CLAIM_HARD:
            issues.append('%s: claim %d 字，超过硬上限 %d' % (p, len(claim), CLAIM_HARD))
        if not str(r.get('evidence', '')).strip():
            issues.append('%s: 证据为空' % p)
        if not (0 <= float(r.get('confidence', 0)) <= 1):
            issues.append('%s: 可信度不在 0–1' % p)
        if not (1 <= int(r.get('importance', 0)) <= 5):
            issues.append('%s: 重要度不在 1–5' % p)
        if r.get('legacy'):
            issues.append('%s: 还是 v1 格式（缺 格式:2 / ## 记忆）' % p)
        ep = str(r.get('evidence_path', '') or '')
        if ep:
            if not ep.startswith('memory/') or '..' in ep:
                issues.append('%s: 证据路径不合法 %s' % (p, ep))
            elif not os.path.exists(os.path.join(ROOT, ep)):
                issues.append('%s: 证据文件不存在 %s' % (p, ep))
    for src in by_src:
        if not os.path.exists(os.path.join(ROOT, src or '')):
            issues.append('索引指向的文件不存在：%s' % src)
    if not rows and not idx:
        issues.append('记忆库是空的 —— 若你确实还没录，请忽略；否则是扫描坏了')
    core = os.path.join(MEM_DIR, 'core.md')
    if os.path.exists(core):
        try:
            with open(core, 'r', encoding='utf-8-sig') as f:
                _fm, body = parse_frontmatter(f.read())
            if len(body.strip()) > CORE_BUDGET:
                issues.append('core.md %d 字，超过预算 %d' % (len(body.strip()), CORE_BUDGET))
        except OSError as e:
            issues.append('core.md 读不到：%s' % e)
    return issues


def load_ledgers(a):
    """读台账索引，按 --q / --kind / --project 过滤。

    ⚠ 台账索引文件不存在时**明说"还没抽"**，不要静默返回空 ——
    那会让人以为"台账里没有这件事"，而实际是"还没接线"（本仓老病）。
    """
    if not os.path.exists(LEDGER_INDEX):
        print('（台账索引还没生成：先跑 `python scripts/memory_ledgers.py --rebuild`）\n')
        return []
    q = (a.q or '').lower()
    kind = (a.kind or '').strip()
    proj = (a.project or '').strip()
    out = []
    try:
        with open(LEDGER_INDEX, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if kind and r.get('src_kind') != kind:
                    continue
                if proj and str(r.get('项目', '')) != proj:
                    continue
                if q:
                    hay = ' '.join(str(r.get(k, '')) for k in ('标题', '摘要', 'id', '出处', '项目')).lower()
                    if q not in hay:
                        continue
                out.append(r)
    except OSError:
        return []
    return out


def main():
    ap = argparse.ArgumentParser(description='方寸记忆检索 v2（只读）')
    ap.add_argument('--type', help='事故 / 教训 / 纪律 / 决定 / 偏好')
    ap.add_argument('--scope', help='适用范围，如「跨项目」')
    ap.add_argument('--project', help='项目 id')
    ap.add_argument('--q', help='全文关键词（含 claim / 原文）')
    ap.add_argument('--pending', action='store_true', help='只看待审批（agent 提案）')
    ap.add_argument('--all', action='store_true', help='含已撤销与待审批')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--rebuild', action='store_true', help='重建 memory/index.jsonl')
    ap.add_argument('--check', action='store_true', help='校验索引 + v2 格式（非零退出=不一致）')
    ap.add_argument('--ledgers', action='store_true',
                    help='同时搜四份台账（决策/日志/任务卡/方针）—— 返回指针，不抄正文')
    ap.add_argument('--kind', help='配合 --ledgers：decision / log / card / charter')
    a = ap.parse_args()

    rows = scan_files()

    if a.rebuild:
        os.makedirs(MEM_DIR, exist_ok=True)
        idx = build_index(rows)
        with open(INDEX, 'w', encoding='utf-8', newline='\n') as f:
            for e in idx:
                f.write(json.dumps(e, ensure_ascii=False) + '\n')
        print('已重建索引：%s（%d 条）' % (INDEX, len(idx)))
        return 0

    if a.check:
        issues = check(rows)
        for s in issues:
            print('FAIL ' + s)
        print('RESULT 一致' if not issues else 'RESULT %d 处不一致' % len(issues))
        return 1 if issues else 0

    picked = [r for r in rows if match(r, a)]

    # ── 台账检索（2026-11-23）────────────────────────────────────────
    # 为什么要有：四份台账共 921 条，原先**一条都没进记忆**（实测覆盖率 0.0%）。
    # `--ledgers` 让同一次检索能命中"人写的 claim"与"台账里的原始记录"两类，
    # 台账那类**只返回指针**（src_path + 标题 + 摘要），原文永远留在源文件里。
    ledger_rows = []
    if a.ledgers:
        ledger_rows = load_ledgers(a)

    if a.json:
        out = [{k: v for k, v in r.items() if k not in ('evidence', '_raw')} for r in picked]
        if a.ledgers:
            out = out + ledger_rows
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if a.ledgers and ledger_rows:
        print('=== 台账命中 %d 条（指针）===' % len(ledger_rows))
        for r in ledger_rows:
            print('[%s] %s' % (r.get('src_kind'), r.get('id')))
            if r.get('标题'):
                print('  标题: ' + str(r['标题']))
            if r.get('摘要'):
                print('  摘要: ' + str(r['摘要']))
            meta = []
            for k in ('项目', '状态', '时间'):
                if r.get(k):
                    meta.append('%s:%s' % (k, str(r[k])[:16].replace('T', ' ')))
            if meta:
                print('  ' + ' · '.join(meta))
            print('  原文: %s%s' % (r.get('src_path', ''),
                                    ('#' + str(r['src_anchor'])) if r.get('src_anchor') else ''))
            print()
        if not picked:
            return 0
        print('=== 记忆 claim 命中 %d 条 ===' % len(picked))

    if not picked:
        if not rows:
            print('记忆库还没有任何条目（memory/ 下没有 *.md，README 除外）。')
            print('这不是"筛出来没有" —— 是还没录过。')
        else:
            print('筛出来 0 条（库中共 %d 条）。放宽条件：--all / 去掉 --type。' % len(rows))
        return 0

    print('共 %d 条\n' % len(picked))
    for r in picked:
        print('[%s] %s' % (r.get('type') or '?', r.get('id') or r['path']))
        meta = []
        if r.get('time'):
            meta.append(str(r['time'])[:16].replace('T', ' '))
        if r.get('scope'):
            meta.append('范围:' + str(r['scope']))
        if r.get('project'):
            meta.append(str(r['project']))
        if r.get('confidence') is not None:
            meta.append('可信 %.0f%%' % (float(r['confidence']) * 100))
        if r.get('importance'):
            meta.append('重要 %s/5' % r['importance'])
        if r.get('pinned'):
            meta.append('钉住')
        if r.get('legacy'):
            meta.append('v1')
        if r.get('status') and r['status'] != '有效':
            meta.append('【' + str(r['status']) + '】')
        if meta:
            print('    ' + ' · '.join(meta))
        print('    ' + (r.get('claim') or ''))
        print('    ' + r.get('path', ''))
        print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
