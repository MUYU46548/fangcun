#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会话捞取 · 逐条判定「有没有记录逐字接住」（2026-11-16 · A 任务 · 第二版）

暮雨 2026-11-16：
> 「先 A，A 成功了可以活用到 B」

A = 把捞到的真人发言变成**可追踪清单**，逐条判有没有被记录接住。

── 这一版换了判据，理由必须先说清（否则又是自己在骗自己）─────────────
第一版用「罕见词覆盖率」：把消息切成 2–4 字 n-gram，算有多少落在同一份记录里。
2026-11-16 实测它**两头顶穿**，同一批样本上：

  「请给我详细的验证测试清单」  → 接住（命中 `试清单` `试清` `清单`）
  「给 AI 用，因为启动方寸的时候客户端必然是开着的」→ 接住（命中 `客户` `户端`）
  「等等，那为什么不直接做一整个 agent？」→ 接住（命中 `直接做` `半成品`）

这些词**满语料都是**，覆盖率天然接近 1 → 全语料 **76.5%** 判「有记录」。
而它给出的"证据"（`户端`、`试清`）**人一条都复核不了** —— 那正是一份黑箱清单。

第二版判据：**逐字重合**。把消息与每份记录都做最长公共连续子串（≥6 字才算），
只认**原文出现过的那一段**。好处是硬的：
  · 命中 = 记录里**真的引用了他的原话** → 人可以一眼核对（本脚本把原文片段打印出来）；
  · 不命中 = **不能**推出"没有记录"（卡可能用别的话写了同一件事）→ 所以这一档叫
    **`无逐字引用`**，不叫「无记录」。它只是**下界**，措辞不许夸大。

── 为什么不干脆上"语义相似" ─────────────────────────────────────────
因为那会把「记得多」当成竞争力（REV-015 已否），而且**又不能机检、又不能复核**。
逐字子串是这一批数据里唯一天然可证伪的锚。

── 六类 verdict ────────────────────────────────────────────────────
  · `接住`        有逐字引用，且被引用的记录**有进展**（进行中/待验收/完成/归档/提交）
  · `只有记录`    有逐字引用，但记录停在待办 —— 提过就搁下，正是「提了没做」
  · `疑似`       只有**弱重合**（<8 字，或非中文为主，或路径碎片）—— 人看一眼再定
  · `粘贴原文`    这条消息**本身就是旧记录的拷贝**（重合 ≥50% 且 ≥100 字）。
                 典型：他把自己上轮的交接日志整段粘回来让我接着做。
                 **这不是需求**，不许算成"被接住"，否则语料自我污染。
  · `无逐字引用`  **一个 ≥6 字的原文片段都找不到**。注意：这是下界，不是"没做过"。
  · `无法判定`    消息太短（「继续」「0+1」），没有可比的内容。

三条纪律：
  ① **只读**：只读 task-data / docs/执行日志 / todos / git log，一个字节都不写；
  ② **不猜**：判不了就说判不了，不硬塞一个 verdict；
  ③ **给证据**：每条命中都打印**命中的原文片段**与落点，人一眼能复核。

用法：
  python scripts/judge-harvested.py                     # 全部（DSH + Hermes 合并去重）
  python scripts/judge-harvested.py --src docs/捞-Hermes-20261116.md
  python scripts/judge-harvested.py --out docs/清零-全部-20261116.md
  python scripts/judge-harvested.py --json --brief      # 机器判据（不吐命中正文）
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
from collections import Counter

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARVEST_DSH = os.path.join(ROOT, "docs", "捞-会话", "all.md")
HARVEST_HERMES = os.path.join(ROOT, "docs", "捞-Hermes-20261116.md")

# 逐字重合的索引窗口。6 = 判据下限；索引用 10 更快（命中后双向扩展还原全长）。
W_MIN = 6
W_IDX = 10
# 「强」重合：至少这么多字，且中文占比达标 —— 否则只是路径/英文专名/格式碎片
STRONG_MIN = 8
STRONG_CJK = 0.5
# 「粘贴原文」：最长重合 ≥ 消息长度的这个比例，且绝对值 ≥ PASTE_MIN_CHARS
PASTE_RATIO = 0.5
PASTE_MIN_CHARS = 100
# 消息短于这个字数 → 无法判定
MIN_MSG_LEN = 12

CJK = re.compile(r"[\u4e00-\u9fff]")
# 路径/URL/主机名一类：即使很长也不代表"需求被接住"
PATHISH = re.compile(r"[A-Za-z]:\\|https?://|\\\\|\busers\b|AppData|Roaming|node_modules|\.py\b|\.ts\b")


def read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


# ══════════════════════════════════════════════════════════════════════
# 语料：所有可能"接住"需求的地方
# ══════════════════════════════════════════════════════════════════════

def repeat_ok():
    return {"进行中", "待验收", "完成"}


def load_corpus():
    """卡 / 归档卡 / 日志 / 计划 / 待办 / 提交。

    ⚠ 2026-11-16 修的 bug：第一版把 `task-data/*.md` **一律**当"卡"，于是
    `decisions.md`（决策台账）、`rice-pool.md`（需求池）、`question-bank.md`（题库）
    在输出里长成「卡 `decisions.md`（— · 没进展）」—— **看起来像一张从没动过的卡，
    实际是数据文件**，进而在人复核时造成误判。现在台账单独归类。
    """
    docs = []  # {kind, id, text, progressed, status}
    LEDGER_NAMES = {"decisions", "rice-pool", "question-bank", "project-status",
                    "registry", "project-tiers", "activity"}

    for p in glob.glob(os.path.join(ROOT, "task-data", "*.md")):
        base = os.path.splitext(os.path.basename(p))[0]
        t = read(p)
        m = re.match(r"---\n(.*?)\n---", t, re.S)
        h = m.group(1) if m else ""
        tid = ""
        mm = re.search(r"^id:\s*(.*)$", h, re.M)
        if mm:
            tid = mm.group(1).strip()
        st = ""
        mm = re.search(r"^状态:\s*(.*)$", h, re.M)
        if mm:
            st = mm.group(1).strip()
        if base in LEDGER_NAMES or (not tid and not st):
            docs.append({"kind": "台账", "id": base, "text": t,
                         "progressed": False, "status": ""})
            continue
        docs.append({"kind": "卡", "id": tid or base, "text": t,
                     "progressed": st in repeat_ok(), "status": st})

    for p in glob.glob(os.path.join(ROOT, "task-data", "archive", "*.md")):
        docs.append({"kind": "归档卡", "id": os.path.basename(p)[:-3],
                     "text": read(p), "progressed": True, "status": "完成(归档)"})

    for p in glob.glob(os.path.join(ROOT, "docs", "执行日志", "*.md")):
        try:
            if os.path.getsize(p) > 2 * 1024 * 1024:
                continue
        except OSError:
            continue
        docs.append({"kind": "日志", "id": os.path.basename(p)[:-3],
                     "text": read(p), "progressed": True, "status": ""})

    for p in glob.glob(os.path.join(ROOT, "task-data", "plans", "*.md")) + \
            glob.glob(os.path.join(ROOT, "task-data", "plans", "_drafts", "*.md")):
        docs.append({"kind": "计划", "id": os.path.basename(p)[:-3],
                     "text": read(p), "progressed": False, "status": ""})

    tp = os.path.join(ROOT, "todos", "index.json")
    if os.path.exists(tp):
        try:
            arr = json.loads(read(tp))
        except Exception:
            arr = []
        for x in (arr if isinstance(arr, list) else []):
            docs.append({"kind": "待办", "id": str(x.get("id") or "")[:20],
                         "text": str(x.get("title") or ""),
                         "progressed": bool(x.get("done")),
                         "status": "完成" if x.get("done") else "未完成"})

    # 提交标题（只当**旁证**：能证明"提过"，不能证明"做过"）
    try:
        r = subprocess.run(["git", "-C", ROOT, "log", "--pretty=%s", "-n", "3000"],
                           capture_output=True, text=True, timeout=120,
                           encoding="utf-8", errors="replace")
        for ln in (r.stdout or "").splitlines():
            if ln.strip():
                docs.append({"kind": "提交", "id": ln.strip()[:80],
                             "text": ln.strip(), "progressed": True, "status": ""})
    except Exception:
        pass

    return docs


def build_index(candidates, docs):
    """W_IDX 字窗口倒排：gram → {doc_idx}。只为提速，不改判据。"""
    cand = set()
    for t in candidates:
        for i in range(0, max(0, len(t) - W_IDX + 1)):
            g = t[i:i + W_IDX]
            if "\n" not in g:
                cand.add(g)
    idx = {}
    for di, d in enumerate(docs):
        t = d["text"]
        for i in range(0, max(0, len(t) - W_IDX + 1)):
            g = t[i:i + W_IDX]
            if g in cand:
                idx.setdefault(g, set()).add(di)
    return idx


def shared_runs(text, idx, docs):
    """返回 [(len, 片段, doc)]，每份记录只留最长的那一段，按长度降序。"""
    best = {}   # doc_idx -> run
    n = len(text)
    for i in range(0, max(0, n - W_IDX + 1)):
        g = text[i:i + W_IDX]
        for di in idx.get(g, ()):
            dt = docs[di]["text"]
            j = dt.find(g)
            if j < 0:
                continue
            lo, hi = j, j + W_IDX
            mi = i
            # 向右长
            while hi < len(dt) and mi + (hi - j) < n and dt[hi] == text[mi + (hi - j)]:
                hi += 1
            # 向左长
            while lo > 0 and mi - (j - lo) - 1 >= 0 and dt[lo - 1] == text[mi - (j - lo) - 1]:
                lo -= 1
            run = dt[lo:hi]
            if di not in best or len(run) > len(best[di]):
                best[di] = run
    out = [(len(r), r, docs[di]) for di, r in best.items() if len(r) >= W_MIN]
    out.sort(key=lambda x: -x[0])
    return out


def classify_run(run):
    """强 / 弱。弱的不许单独定案，只进「疑似」。"""
    n = len(run)
    if n < W_MIN:
        return "无效"
    cjk = len(CJK.findall(run))
    if n < STRONG_MIN:
        return "弱"
    if cjk < n * STRONG_CJK:
        return "弱"
    if PATHISH.search(run) and cjk < n * 0.7:
        return "弱"
    return "强"


def judge_one(text, idx, docs):
    """返回 (verdict, why, shared)。

    shared = [{'len','run','kind','id','status','progressed','cls'}]
    """
    if len(text) < MIN_MSG_LEN:
        return "无法判定", "消息太短（%d 字）" % len(text), []

    runs = shared_runs(text, idx, docs)
    if not runs:
        return "无逐字引用", "整份语料里没有 ≥%d 字的原文片段" % W_MIN, []

    shared = [{"len": l, "run": r, "kind": d["kind"], "id": d["id"],
               "status": d["status"], "progressed": d["progressed"],
               "cls": classify_run(r)} for (l, r, d) in runs[:3]]

    top_len = runs[0][0]
    # 自我污染：这条消息本身就是旧记录的拷贝（他把交接日志粘回来）
    if top_len >= PASTE_MIN_CHARS and top_len >= len(text) * PASTE_RATIO:
        d = runs[0][2]
        return "粘贴原文", "与 %s `%s` 重合 %d/%d 字（这条是旧记录的拷贝，不是需求）" % (
            d["kind"], d["id"], top_len, len(text)), shared

    strong = [(l, r, d) for (l, r, d) in runs if classify_run(r) == "强"]
    if strong:
        if any(d["progressed"] for (_, _, d) in strong):
            return "接住", "", shared
        return "只有记录", "", shared
    return "疑似", "只有弱重合（<8 字 / 非中文为主 / 路径碎片），要人看一眼", shared


# ══════════════════════════════════════════════════════════════════════
# 捞取产物解析（两种格式）
# ══════════════════════════════════════════════════════════════════════

def parse_harvest(path):
    """拆回 [(会话id, 时间, 项目, 原文)]。**两种产物都认**：

    DSH（`harvest-sessions.cjs`）：
        ## session-xxx
        - 时间：2026-10-24 08:36 · 项目：`E:\\CODE\\CangKu\\SiTian`
    Hermes（`harvest-hermes.py`）：
        ## 按会话（203 个）            ← 分组标题，不是会话
        ### `20260726_210825_16f584` · 2026-07-26 21:08
        - source `desktop` · `E:\\AI\\Hermes_Workspace` · 标题

    ⚠ 2026-11-16 实测踩到：第一版只认 `## `，于是 Hermes 那 667 条**全部挂在一个
    叫「按会话（203 个）」的假会话下**，cwd 全空 —— 项目分栏与 projects 过滤全部失效，
    而输出看起来完全正常。所以：`### ` 才是会话标题，`## ` 只是分组，要跳过。
    同时一条消息在**空行处结束**（第一版忽略这点，把整个会话拼成一条）。
    """
    if not os.path.exists(path):
        return []
    out = []
    cur = {"id": "", "ts": "", "proj": ""}
    buf = []

    def flush():
        s = "\n".join(buf).strip()
        buf.clear()
        if s and cur["id"]:
            out.append((cur["id"], cur["ts"], cur["proj"], s))

    for line in read(path).splitlines():
        if line.startswith("### "):
            flush()
            body = line[4:].strip()
            if " · " in body:
                sid, ts = body.split(" · ", 1)
                cur = {"id": sid.strip("` "), "ts": ts.strip()[:16], "proj": ""}
            else:
                cur = {"id": body.strip("` "), "ts": "", "proj": ""}
            continue
        if line.startswith("## "):
            flush()
            body = line[3:].strip()
            if body.startswith("按会话") or body.startswith("按项目"):
                cur = {"id": "", "ts": "", "proj": ""}      # 分组，不是会话
            else:
                cur = {"id": body, "ts": "", "proj": ""}    # DSH 的会话就是这层
            continue
        if line.startswith("- 时间："):
            body = line.split("时间：", 1)[1]
            if " · 项目：" in body:
                ts, proj = body.split(" · 项目：", 1)
                cur["ts"] = ts.strip()[:16]
                m = re.search(r"`([^`]+)`", proj)
                cur["proj"] = m.group(1) if m else proj.strip()
            else:
                cur["ts"] = body.strip()[:16]
            continue
        if line.startswith("- source "):
            m = re.findall(r"`([^`]+)`", line)
            cur["proj"] = m[1] if len(m) >= 2 else ""
            continue
        if line.startswith("> "):
            buf.append(line[2:])
        elif line.strip() == ">":
            buf.append("")
        elif line.startswith(">"):
            buf.append(line[1:])
        elif not line.strip():
            flush()
    flush()
    return [x for x in out if x[3] and not x[3].startswith("**")]


def dedupe(msgs):
    """两个来源合并去重：同一句话（忽略空白，前 200 字）只留一份。

    ⚠ 为什么要去重：DSH 的 550 条与 Hermes 的 667 条里，他会在两个客户端说
    **同一件事**（甚至同一句话）。不去重会把"同一条需求"数成两条，
    总数因此虚高 —— 而"合计 1217 条"这个数本身就是上一版报告的论据。

    ⚠ 2026-11-16 自查抓到的 bug：第一版写成 `x[3]`，那是**项目名**不是原文
    （元组是 `(来源, 会话id, 时间, 项目, 原文)`）→ 同一个项目的 1217 条被压成 21 条，
    而输出看起来只是"条数变少了"，完全不报错。现在按**原文**去重，并断言不许压掉太多。
    """
    seen, out = set(), []
    for x in msgs:
        k = re.sub(r"\s+", "", x[4])[:200]
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
    if msgs and len(out) < len(msgs) * 0.5:
        raise SystemExit("✗ 去重把 %d 条压成了 %d 条 —— 去重键写错了（应该按原文，不是项目）"
                         % (len(msgs), len(out)))
    return out


def main():
    ap = argparse.ArgumentParser(description="逐条判定会话捞取结果有没有被记录逐字接住（只读）")
    ap.add_argument("--project", help="只判某个项目侧（子串匹配 cwd）")
    ap.add_argument("--src", help="只判一个捞取产物（默认两者合并去重）")
    ap.add_argument("--out")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--brief", action="store_true",
                    help="配合 --json：不吐命中文档正文（机器判据用，避免输出几百 MB）")
    ap.add_argument("--no-dedupe", action="store_true", help="不去重（对账用）")
    args = ap.parse_args()

    srcs = []
    if args.src:
        srcs = [(args.src, "custom")]
    else:
        if os.path.exists(HARVEST_DSH):
            srcs.append((HARVEST_DSH, "dsh"))
        if os.path.exists(HARVEST_HERMES):
            srcs.append((HARVEST_HERMES, "hermes"))
    if not srcs:
        print("✗ 找不到捞取产物，先跑：node scripts/harvest-sessions.cjs --all --outdir docs/捞-会话")
        print("  以及：python scripts/harvest-hermes.py")
        return 1

    msgs = []
    for p, tag in srcs:
        part = parse_harvest(p)
        if not part:
            print("✗ %s 解析出 0 条（格式变了？）" % p)
            return 1
        msgs.extend([(tag, a, b, c, d) for (a, b, c, d) in part])
    raw_total = len(msgs)
    if not args.no_dedupe:
        msgs = dedupe(msgs)

    if args.project:
        msgs = [m for m in msgs if args.project.lower() in (m[3] or "").lower()]
    if not msgs:
        print("✗ 没有可判的消息")
        return 1

    docs = load_corpus()
    idx = build_index([m[4] for m in msgs], docs)

    rows = []
    for tag, cid, ts, proj, text in msgs:
        v, why, shared = judge_one(text, idx, docs)
        rows.append({"src": tag, "id": cid, "ts": ts, "proj": proj, "text": text,
                     "verdict": v, "why": why, "hits": shared})

    cnt = Counter(r["verdict"] for r in rows)
    VERDICTS = ["接住", "只有记录", "疑似", "粘贴原文", "无逐字引用", "无法判定"]

    if args.json:
        # `--brief`：不吐命中正文。一份日志正文几十万字符，全塞进 JSON 会让输出到几百 MB ——
        # 守卫里 execFileSync 默认 1MB 缓冲直接 ENOBUFS，而报错看起来像"守卫坏了"。
        payload = {"counts": dict(cnt), "rawTotal": raw_total, "total": len(rows), "rows": []}
        for r in rows:
            if args.brief:
                payload["rows"].append({
                    "src": r["src"], "id": r["id"], "ts": r["ts"], "proj": r["proj"],
                    "verdict": r["verdict"], "why": r["why"],
                    "hits": [{"kind": h["kind"], "id": h["id"], "status": h["status"],
                              "progressed": h["progressed"], "len": h["len"], "cls": h["cls"],
                              "run": h["run"][:80]} for h in r["hits"]],
                })
            else:
                payload["rows"].append(r)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    L = []
    L.append("# 会话捞取 · 逐条判定「有没有记录逐字接住」（A 任务 · 2026-11-16）")
    L.append("")
    L.append("## ⚠ 这条判据验的是什么（先读这段，否则会误读整张表）")
    L.append("")
    L.append("判据 = **逐字重合**：他的原话有没有在某份记录里**被原文引用**（≥6 字连续片段）。")
    L.append("")
    L.append("| verdict | 含义 | 能不能当结论用 |")
    L.append("|---|---|---|")
    L.append("| **接住** | 有逐字引用，且被引用的记录**有进展**（进行中/待验收/完成/归档/提交） | 能：这是铁证 |")
    L.append("| **只有记录** | 有逐字引用，但记录停在待办 —— 「提了没做」的形状 | 能 |")
    L.append("| **疑似** | 只有弱重合（<8 字 / 非中文为主 / 路径碎片） | **不能**，要人看一眼 |")
    L.append("| **粘贴原文** | 这条消息**本身**就是旧记录的拷贝（重合 ≥50% 且 ≥100 字） | 不能 —— 这不是需求 |")
    L.append("| **无逐字引用** | 一个 ≥6 字的原文片段都找不到 | **只是下界**：卡可能用别的话写了同一件事 |")
    L.append("| **无法判定** | 消息太短（「继续」「0+1」） | 不能 |")
    L.append("")
    L.append("> **为什么换掉了第一版的「罕见词覆盖率」**：它在同一批样本上把")
    L.append("> 「请给我详细的验证测试清单」判成「接住」，命中的词是 `试清单` `试清` `清单` ——")
    L.append("> 这些词满语料都是，覆盖率天然接近 1，于是全语料 76.5% 判「有记录」。")
    L.append("> 那种「证据」**人一条都复核不了**。现在每条命中都打印原文片段。")
    L.append("")
    L.append("## 结果")
    L.append("")
    L.append("| 判定 | 条数 |")
    L.append("|---|---:|")
    for k in VERDICTS:
        if cnt.get(k):
            L.append("| %s | %d |" % (k, cnt[k]))
    L.append("| **合计** | **%d** |" % len(rows))
    L.append("")
    if raw_total != len(rows):
        L.append("去重：两个来源合计 **%d** 条 → 去重后 **%d** 条（同一个人在两个客户端说过同一句话，"
                 "不该数两遍）。" % (raw_total, len(rows)))
        L.append("")
    L.append("语料规模：卡 %d · 归档卡 %d · 台账 %d · 日志 %d · 计划 %d · 待办 %d · 提交 %d（合计 %d 份）" % (
        sum(1 for d in docs if d["kind"] == "卡"),
        sum(1 for d in docs if d["kind"] == "归档卡"),
        sum(1 for d in docs if d["kind"] == "台账"),
        sum(1 for d in docs if d["kind"] == "日志"),
        sum(1 for d in docs if d["kind"] == "计划"),
        sum(1 for d in docs if d["kind"] == "待办"),
        sum(1 for d in docs if d["kind"] == "提交"),
        len(docs)))
    L.append("")

    ORDER = ["无逐字引用", "疑似", "粘贴原文", "只有记录", "接住", "无法判定"]
    for v in ORDER:
        sub = [r for r in rows if r["verdict"] == v]
        if not sub:
            continue
        L.append("## %s（%d 条）" % (v, len(sub)))
        L.append("")
        for r in sub:
            one = r["text"].replace("\n", " ")
            if len(one) > 200:
                one = one[:200] + "…"
            L.append("### `%s` · %s · %s" % (r["id"][:28], r["ts"] or "时间不详", r["src"]))
            L.append("")
            L.append("> " + one)
            L.append("")
            if r["why"] and v in ("粘贴原文", "疑似"):
                L.append("- %s" % r["why"])
            for h in r["hits"]:
                run = h["run"].replace("\n", " ").strip()
                if len(run) > 80:
                    run = run[:80] + "…"
                L.append("- [%s]%d 字 `%s` ← %s `%s`（%s%s）" % (
                    h["cls"], h["len"], run, h["kind"], h["id"][:50], h["status"] or "—",
                    "" if h["progressed"] else " · **没进展**"))
            if v == "无逐字引用":
                L.append("- **任何卡 / 日志 / 提交里都没有 ≥6 字的原文片段**"
                         "（≠ 没做过，只是逐字判据看不见）")
            L.append("")

    text = "\n".join(L)
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        back = read(args.out)
        print("已写 %d 字节 → %s" % (len(back.encode("utf-8")), args.out))
        print("判定：" + " · ".join("%s %d" % (k, cnt[k]) for k in VERDICTS if cnt.get(k)))
        return 0
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
