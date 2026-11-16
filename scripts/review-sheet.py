#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把需要人工复核的条目抽成一张**一屏能看完**的表（2026-11-16）

起因：暮雨问「说是人工复核，在哪里看？」

诚实的答案：**当时没有好地方** —— 24 条埋在 436 KB 的 `清零-全部-20261116.md` 里，
而那 551 条里绝大多数的判定是"接住"，真需要人看的只有两类：

  · **只有记录**（记下了但停在待办）← 这才是「提了没做」的形状
  · **无记录**（任何地方都找不到）    ← 可能是真丢了，也可能是闲聊

所以这个脚本只做一件事：**把这两类抽出来，一条一屏，带可勾选的复核位**。
不判定、不排序、不编结论 —— 判定是你的事。

用法：
  python scripts/review-sheet.py                 # 生成 docs/待复核-20261116.md
  python scripts/review-sheet.py --out 路径.md
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JUDGE = os.path.join(ROOT, "scripts", "judge-harvested.py")

WANT = ("只有记录", "无记录")


def load():
    """直接复用判定脚本的 --json（口径唯一，不在这里重算）。"""
    r = subprocess.run(
        [sys.executable, JUDGE, "--json"],
        capture_output=True, text=True, cwd=ROOT,
        encoding="utf-8", errors="replace", timeout=1800,
    )
    if r.returncode != 0:
        raise SystemExit("✗ 判定脚本失败：\n" + (r.stderr or "")[:800])
    return json.loads(r.stdout)


def clip(s, n):
    s = str(s or "").replace("\n", " ").strip()
    return s if len(s) <= n else s[:n] + "…"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "待复核-20261116.md"))
    args = ap.parse_args()

    data = load()
    rows = [r for r in data["rows"] if r["verdict"] in WANT]
    counts = data["counts"]

    L = []
    L.append("# 待人工复核（%d 条）· 2026-11-16" % len(rows))
    L.append("")
    L.append("> 从 551 条捞取结果里抽出来的**全部需要人看**的条目。")
    L.append("> 其余 %d 条判定为「接住」（有记录且有进展），%d 条「无法判定」（太短，没内容词）。" % (
        counts.get("接住", 0), counts.get("无法判定", 0)))
    L.append(">")
    L.append("> **怎么复核**：每条下面有三个勾，你在 `[ ]` 里打 `x` 就行，或者直接在旁边写字。")
    L.append("> 我不替你判 —— 这三格分别问你：这件事是不是你要的、现在要不要做、要不要建成卡。")
    L.append("")
    L.append("## ⚠ 这份表的数字会漂（已实测，别拿它当准数）")
    L.append("")
    L.append("语料里有 **`git log` 的提交标题**，而**我每提交一次，语料就变一次**。")
    L.append("实测：`无记录` 从 **12 条**变成 **9 条**，只因我提交了一条 message 里带相关词的消息。")
    L.append("**也就是说：我写一句话就能让某些条目从「没记录」变成「有记录」。**")
    L.append("")
    L.append("所以：")
    L.append("- **真正能用的**是每条的**原话 + 命中出处**，你自己看一眼就知道对不对；")
    L.append("- **不能用的**是那个总数 —— 它不是测量，是「在当前语料快照下算出的一个值」。")
    L.append("")
    L.append("---")
    L.append("")

    for v in WANT:
        sub = [r for r in rows if r["verdict"] == v]
        L.append("## %s（%d 条）" % (v, len(sub)))
        L.append("")
        if v == "只有记录":
            L.append("**记下了，但记录本身停在待办 —— 这就是「提了没做」的形状。**")
        else:
            L.append("**任何卡 / 提交 / 日志里都找不到。可能是真丢了，也可能只是闲聊。**")
        L.append("")
        for i, r in enumerate(sub, 1):
            L.append("### %d / %d · %s · %s" % (i, len(sub), r["ts"] or "时间不详", clip(r["proj"], 40)))
            L.append("")
            L.append("> " + clip(r["text"], 400))
            L.append("")
            if r["hits"]:
                L.append("命中：")
                for h in r["hits"]:
                    d = h["doc"]
                    L.append("- %s `%s`（%s%s）" % (
                        d["kind"], clip(d["id"], 46), d["status"] or "—",
                        "" if d["progressed"] else " · **没进展**"))
            else:
                L.append("命中：**无**")
            if r["anchors"]:
                L.append("")
                L.append("用到的词：" + "、".join("`%s`" % a for a in r["anchors"][:6]))
            L.append("")
            L.append("- [ ] 这是我要的　- [ ] 现在要做　- [ ] 建成卡")
            L.append("")
        L.append("---")
        L.append("")

    text = "\n".join(L)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")
    with open(args.out, encoding="utf-8") as f:
        back = f.read()
    print("已写 %d 字节 → %s" % (len(back.encode("utf-8")), args.out))
    print("待复核 %d 条（只有记录 %d · 无记录 %d）" % (
        len(rows),
        sum(1 for r in rows if r["verdict"] == "只有记录"),
        sum(1 for r in rows if r["verdict"] == "无记录")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
