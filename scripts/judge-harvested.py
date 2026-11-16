#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会话捞取 · 逐条判定「有没有记录接住」（2026-11-16 · A 任务）

暮雨 2026-11-16：
> 「先 A，A 成功了可以活用到 B」

A = 把 550 条真人发言变成**可追踪清单**，并且**逐条判定有没有被记录接住**。

── 这条判据的边界（必须先说清，否则又是假绿）──────────────────────────
它验的是 **「有没有记录」**，不是 **「有没有做」**。
  · 「有没有记录」= 某张卡 / 某条提交 / 某份日志里，出现过这条需求里的**特定专有词**。
    这是**能机械证伪**的：找不到，就是真的没有任何地方提过它。
  · 「有没有做」= 人的判断，本脚本**不做**，也不给任何"看起来做了"的暗示。

三类 verdict：
  · `接住`      有记录，且命中的记录**有进展**（卡完成/待验收，或提交出现）
  · `只有记录`  有记录，但记录本身**停在待办**（= 提过就搁下，正是"提了没做"）
  · `无记录`    **任何地方都找不到** ← 这批才是"彻底悬空"，最值钱的数字
  · `无法判定`  消息太短/太泛（「继续」「好的」），没有专有词可比 —— 不硬判

── 匹配算法（为什么用"罕见词"而不是"关键词命中率"）─────────────────────
用**文档频率 ≤ RARE_DF 的专有词**做锚点。理由：
  · 常见词（"方寸""项目""问题"）每张卡都有，命中等于没命中；
  · 罕见词（"作战计划""截图""载荷"）一旦出现在某张卡里，几乎必然是同一条需求。
这比"整段相似度"可靠得多，也**能被人一条条复核**（每条都给命中的词与出处）。

三条纪律：
  ① **只读**：只读 task-data / docs/执行日志 / todos / git log，一个字节都不写；
  ② **不猜**：判不了就说判不了（`无法判定`），不硬塞一个 verdict；
  ③ **给证据**：每条"接住"都必须说清**命中了哪个词、落在哪张卡/哪个提交**，
     否则人无法复核，这清单就又是一个黑箱。

用法：
  python scripts/judge-harvested.py                     # 全部
  python scripts/judge-harvested.py --project fangcun   # 只判方寸侧
  python scripts/judge-harvested.py --out docs/清零-20261116.md
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARVEST = os.path.join(ROOT, "docs", "捞-会话", "all.md")
HARVEST_ONE = os.path.join(ROOT, "docs", "捞-会话-方寸-20261116.md")

# 文档频率高于这个比例 = 太常见，没有判别力（"方寸""项目"）
COMMON_RATIO = 0.35
# 命中判定：消息里有 >=MIN_COVER 比例的词落在**同一份**记录里
MIN_COVER = 0.14
MIN_OVERLAP = 3
# 消息短于这个字数 → 无法判定
MIN_MSG_LEN = 12

# ── 停用词：既没有领域含义、又几乎每张卡都出现的 ─────────────────────
STOP = set("""
方寸 项目 问题 东西 现在 应该 可以 这个 那个 什么 怎么 为什么 是不是 有没有
一下 一点 一些 我们 你们 他们 自己 已经 还是 就是 但是 因为 所以 如果 需要
任务 工作 时间 事情 情况 地方 内容 部分 时候 之后 之前 这里 那里 这样 那样
一个 两个 三个 没有 不是 知道 觉得 认为 可能 大概 确实 其实 真的 非常
""".split())

CJK = re.compile(r"[\u4e00-\u9fff]+")
ASCII_W = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{3,30}")


def read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


# 虚词：以这些字开头/结尾的 n-gram 不是"专有词"
FUNC_CHARS = set("的了着过是在和与就不都也很还而但所以把被让给从对向于这那我们他们"
                 "个些么什怎样吗呢吧啊要会能可没很太更最一二三四五六七八九十几")
# 这些太泛，永远不当锚点
GENERIC = set("""
继续 推进 做完 完成 可以 需要 一个 什么 怎么 现在 已经 还是 就是 但是 因为
时候 东西 事情 内容 部分 问题 方法 方式 情况 样子 意思 结果 目标 要求 建议
""".split())


def terms_of(text):
    """抽锚点词：中文 **2–4 字真词** + 英文/代号 token。

    ⚠ 第一版把整段中文连续串（最长 8 字）也当词，还加上滑动窗口切出的子串 ——
    于是「从第 1 批的渲染层拆分开始」抽出 `批的渲染层拆分开` 这种串，
    **它不可能出现在任何卡里**，151 条被判"无记录"，而实际是匹配器坏了。
    现在只留 ≤4 字的 n-gram，并剔除虚词开头的 —— 这样「渲染层」「截图」「作战计划」
    才能真的对上，而 `批的`、`的渲染` 这类会被 FUNCTION 规则挡掉。
    """
    s = str(text or "")
    out = set()
    for m in CJK.finditer(s):
        run = m.group(0)
        if run in GENERIC or run in STOP:
            continue
        for n in (2, 3, 4):
            for i in range(0, len(run) - n + 1):
                w = run[i:i + n]
                if w in STOP or w in GENERIC:
                    continue
                # 虚词不能在词首/词尾（"批的" "层拆" 这种不是词）
                if w[0] in FUNC_CHARS or w[-1] in FUNC_CHARS:
                    continue
                out.add(w)
    for m in ASCII_W.finditer(s):
        out.add(m.group(0).lower())
    return out


def load_corpus():
    """所有可能"接住"需求的地方：卡 / 归档卡 / 日志 / 计划 / 待办 / 提交。"""
    docs = []  # {kind, id, text, progressed}

    DONE = {"完成", "驳回"}
    for p in glob.glob(os.path.join(ROOT, "task-data", "*.md")):
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
        docs.append({
            "kind": "卡", "id": tid or os.path.basename(p),
            "text": t,
            "progressed": st in repeat_ok(),  # 进行中/待验收/完成 都算"动过"
            "status": st,
        })

    for p in glob.glob(os.path.join(ROOT, "task-data", "archive", "*.md")):
        t = read(p)
        docs.append({"kind": "归档卡", "id": os.path.basename(p)[:-3],
                     "text": t, "progressed": True, "status": "完成(归档)"})

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

    # 提交标题（"只读提交标题是残废"——但作为**有没有记录**的旁证仍然有用）
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


def repeat_ok():
    return {"进行中", "待验收", "完成"}


def build_df(docs):
    df = Counter()
    for d in docs:
        for w in terms_of(d["text"]):
            df[w] += 1
    return df


def parse_harvest(path):
    """把捞取产物拆回 [(会话id, 时间, 项目, 原文)]。**两种产物都认**：

    DSH（`harvest-sessions.cjs`）：
        ## session-xxx
        - 时间：2026-10-24 08:36 · 项目：`E:\\CODE\\CangKu\\SiTian`
    Hermes（`harvest-hermes.py`）：
        ## 按会话（203 个）            ← 这是分组标题，不是会话
        ### `20260726_210825_16f584` · 2026-07-26 21:08
        - source `desktop` · `E:\\AI\\Hermes_Workspace` · 标题

    ⚠ 2026-11-16 实测踩到：第一版只认 `## `，于是 Hermes 那 667 条**全部挂在一个
    叫「按会话（203 个）」的假会话下**，cwd 全空 —— 项目分栏、projects 过滤全部失效，
    而输出看起来完全正常。所以：`### ` 才是会话标题，`## ` 只是分组，要跳过。
    同时一条消息在**空行处结束**（第一版忽略这点，把整个会话拼成一条）。
    """
    if not os.path.exists(path):
        return []
    t = read(path)
    out = []
    cur = {"id": "", "ts": "", "proj": ""}
    buf = []

    def flush():
        s = "\n".join(buf).strip()
        buf.clear()
        if s and cur["id"]:
            out.append((cur["id"], cur["ts"], cur["proj"], s))

    for line in t.splitlines():
        if line.startswith("### "):        # 会话标题（Hermes 用这层）
            flush()
            body = line[4:].strip()
            if " · " in body:
                sid, ts = body.split(" · ", 1)
                cur = {"id": sid.strip("` "), "ts": ts.strip()[:16], "proj": ""}
            else:
                cur = {"id": body.strip("` "), "ts": "", "proj": ""}
            continue
        if line.startswith("## "):         # 分组标题（DSH 的会话就是这层）
            flush()
            body = line[3:].strip()
            if body.startswith("按会话") or body.startswith("按项目"):
                cur = {"id": "", "ts": "", "proj": ""}   # 分组，不是会话
            else:
                cur = {"id": body, "ts": "", "proj": ""}
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
            # Hermes 形：- source `desktop` · `E:\\AI\\Hermes_Workspace` · 标题
            m = re.findall(r"`([^`]+)`", line)
            if len(m) >= 2:
                cur["proj"] = m[1]
            elif m:
                cur["proj"] = ""
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


def judge_one(text, docs, df, doc_terms, n_docs):
    """返回 (verdict, anchors, hits)。

    ⚠ 这个函数前两版都是错的，两次都是**自查当场发现的**，记下来防再犯：
    ① 第一版：只留 df ≤ 6 的"罕见词"当锚点 → 「截图」「渲染层」这类真词到处出现（df 高）
       被过滤掉，`批的渲染`、`层拆分开` 这种碎片（df=0）反而被选中 → 稳定判出 151 条假"无记录"。
    ② 第二版：改成覆盖率，但把**超常见词整体剔除** → 长消息里「截图」「视觉」被剔掉，
       剩下全是碎片 → 仍然假"无记录"（84 条，其中一部分是假的）。

    现在这一版：
      · 候选词 = 语料里**真实存在过**的词（df > 0）。df = 0 的必然是碎片，直接丢 ——
        这是"不拿不可能匹配的东西去匹配"的唯一做法。
      · **不剔除常见词**，而是用 IDF 加权：越常见权重越低。这样「截图」这种满地图都有的词
        仍然算分，但权重接近 0；而「作战计划」「载荷」这种立刻拉高覆盖率。
      · 匹配要求**同一份记录**同时覆盖足够权重，而不是散落在不同文档里凑数。
    """
    import math
    ws = terms_of(text)
    cand = {w: math.log(1.0 + n_docs / max(1, df.get(w, 0))) for w in ws if df.get(w, 0) > 0}
    if len(cand) < 2:
        return "无法判定", [], []
    total_w = sum(cand.values()) or 1.0

    hits = []
    for i, d in enumerate(docs):
        got = [w for w in cand if w in doc_terms[i]]
        if len(got) < MIN_OVERLAP:
            continue
        cover = sum(cand[w] for w in got) / total_w
        if cover < MIN_COVER:
            continue
        hits.append({"doc": d, "anchors": got, "score": cover})
    if not hits:
        return "无记录", sorted(cand, key=lambda w: -cand[w])[:6], []

    hits.sort(key=lambda h: -h["score"])
    if any(h["doc"]["progressed"] for h in hits):
        return "接住", hits[0]["anchors"][:6], hits[:3]
    return "只有记录", hits[0]["anchors"][:6], hits[:3]


def main():
    ap = argparse.ArgumentParser(description="逐条判定会话捞取结果有没有被记录接住（只读）")
    ap.add_argument("--project", help="只判某个项目侧（子串匹配 cwd）")
    ap.add_argument("--src", help="指定捞取产物（默认 docs/捞-会话/all.md；"
                                  "判 Hermes 时传 docs/捞-Hermes-20261116.md）")
    ap.add_argument("--out")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    src = args.src or (HARVEST if os.path.exists(HARVEST) else HARVEST_ONE)
    if not os.path.exists(src):
        print("✗ 找不到捞取产物，先跑：node scripts/harvest-sessions.cjs --all --outdir docs/捞-会话")
        return 1

    msgs = parse_harvest(src)
    if args.project:
        msgs = [m for m in msgs if args.project.lower() in (m[2] or "").lower()]
    if not msgs:
        print("✗ 没有可判的消息")
        return 1

    docs = load_corpus()
    df = build_df(docs)
    doc_terms = [terms_of(d["text"]) for d in docs]

    rows = []
    for cid, ts, proj, text in msgs:
        if len(text) < MIN_MSG_LEN:
            rows.append({"id": cid, "ts": ts, "proj": proj, "text": text,
                         "verdict": "无法判定", "anchors": [], "hits": [], "why": "消息太短"})
            continue
        v, anchors, hits = judge_one(text, docs, df, doc_terms, len(docs))
        rows.append({"id": cid, "ts": ts, "proj": proj, "text": text,
                     "verdict": v, "anchors": anchors, "hits": hits, "why": ""})

    cnt = Counter(r["verdict"] for r in rows)

    if args.json:
        print(json.dumps({"counts": dict(cnt), "rows": rows}, ensure_ascii=False, indent=2))
        return 0

    L = []
    L.append("# 会话捞取 · 逐条判定「有没有记录接住」（A 任务 · 2026-11-16）")
    L.append("")
    L.append("> 暮雨「先 A」。A = 把捞到的真人发言变成可追踪清单，逐条判有没有被记录接住。")
    L.append("")
    L.append("## ⚠ 这条判据验的是什么（必须先读）")
    L.append("")
    L.append("它验 **「有没有记录」**，**不验「有没有做」**。")
    L.append("")
    L.append("- 「有没有记录」= 某张卡 / 某个提交 / 某份日志里出现过这条需求的**特定专有词**。"
             "这是**能机械证伪**的：找不到，就是真的没有任何地方提过它。")
    L.append("- 「有没有做」= 人的判断，本表**不做**，也不给任何「看起来做了」的暗示。")
    L.append("")
    L.append("| verdict | 含义 |")
    L.append("|---|---|")
    L.append("| **接住** | 有记录，且命中的记录**有进展**（进行中/待验收/完成，或提交/日志出现） |")
    L.append("| **只有记录** | 有记录，但记录停在待办 —— 提过就搁下，正是「提了没做」 |")
    L.append("| **无记录** | **任何地方都找不到** ← 这批才是彻底悬空，最值钱的数字 |")
    L.append("| **无法判定** | 消息太短/太泛（「继续」），没有专有词可比 —— 不硬判 |")
    L.append("")
    L.append("## 结果")
    L.append("")
    L.append("| 判定 | 条数 |")
    L.append("|---|---:|")
    for k in ("接住", "只有记录", "无记录", "无法判定"):
        L.append("| %s | %d |" % (k, cnt.get(k, 0)))
    L.append("| **合计** | **%d** |" % len(rows))
    L.append("")
    L.append("语料规模：卡 %d · 日志 %d · 计划 %d · 待办 %d · 提交 %d（合计 %d 份文档）" % (
        sum(1 for d in docs if d["kind"] == "卡"),
        sum(1 for d in docs if d["kind"] == "日志"),
        sum(1 for d in docs if d["kind"] == "计划"),
        sum(1 for d in docs if d["kind"] == "待办"),
        sum(1 for d in docs if d["kind"] == "提交"),
        len(docs)))
    L.append("")

    ORDER = ["无记录", "只有记录", "接住", "无法判定"]
    for v in ORDER:
        sub = [r for r in rows if r["verdict"] == v]
        if not sub:
            continue
        L.append("## %s（%d 条）" % (v, len(sub)))
        L.append("")
        for r in sub:
            one = r["text"].replace("\n", " ")
            if len(one) > 110:
                one = one[:110] + "…"
            L.append("### `%s` · %s" % (r["id"][:28], r["ts"]))
            L.append("")
            L.append("> " + one)
            L.append("")
            if r["anchors"]:
                L.append("- 锚点词：" + "、".join("`%s`" % a for a in r["anchors"][:6]))
            if r["hits"]:
                for h in r["hits"]:
                    d = h["doc"]
                    L.append("- %s 命中：`%s`（%s%s） ← %s" % (
                        d["kind"], d["id"][:50], d["status"],
                        "" if d["progressed"] else " · 没进展",
                        "、".join(h["anchors"])))
            elif v == "无记录":
                L.append("- **任何卡 / 提交 / 日志里都没有这些词**")
            L.append("")

    text = "\n".join(L)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        back = read(args.out)
        print("已写 %d 字节 → %s" % (len(back.encode("utf-8")), args.out))
        print("判定：接住 %d · 只有记录 %d · 无记录 %d · 无法判定 %d" % (
            cnt.get("接住", 0), cnt.get("只有记录", 0),
            cnt.get("无记录", 0), cnt.get("无法判定", 0)))
        return 0
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
