#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把需要人工复核的条目抽成一张**一屏能看完**的表（2026-11-16 · 第二版）

起因：暮雨问「说是人工复核，在哪里看？」

诚实的答案：**当时没有好地方** —— 24 条埋在 436 KB 的 `清零-全部` 里，
而那 551 条里绝大多数的判定是"接住"。真需要人看的只有四类：

  · **只有记录**  记下了但停在待办 ← 「提了没做」的形状
  · **无逐字引用** 逐字判据看不见（≠ 没做过，可能卡用了别的话）
  · **疑似**      只有弱重合（路径/英文专名/格式碎片），机器判不了
  · **粘贴原文**  这条消息本身就是旧记录的拷贝 —— 不该进任何需求清单

所以这个脚本只做一件事：**抽出来，一条一屏，带可勾选的复核位**。
不判定、不排序、不编结论 —— 判定是人的事。

⚠ 与第一版的两处不同（都是被暮雨问出来的）：
  ① 判据换成逐字重合 → 每条命中都能打印**原文片段**，人能一眼核对；
  ② 不再写"每个数字都会漂"这种免责 —— 那是我拿数据当许可证。
     现在**语料快照是固定的**（捞取产物落盘），重算是可复现的。

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

# ⚠ 分两个文件，理由（2026-11-16 暮雨问「说是人工复核，在哪里看」的原意）：
#   把 837 条全塞进一张表 = 又造一个 436 KB 的怪兽，**他看不了就不会看**。
#   真信号只有「只有记录」（提了没做）与「粘贴原文」（该排除的）；
#   「疑似 / 无逐字引用」共 811 条按一条一行放附录 —— 能扫，但不占正文。
MAIN = ("只有记录", "粘贴原文")
APPENDIX = ("疑似", "无逐字引用")


def load():
    """直接复用判定脚本的 --json（口径唯一，不在这里重算）。

    ⚠ 这里**不能**加 `--brief`：brief 会把 `text`（他那句原话）省掉，
    而复核表存在的唯一理由就是给他看原话。brief 是给机器判据用的。
    """
    r = subprocess.run(
        [sys.executable, "-X", "utf8", JUDGE, "--json"],
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
    ap.add_argument("--appendix", default=os.path.join(ROOT, "docs", "待复核-附录-20261116.md"))
    args = ap.parse_args()

    data = load()
    rows = [r for r in data["rows"] if r["verdict"] in MAIN + APPENDIX]
    counts = data["counts"]
    total = data["total"]
    raw_total = data.get("rawTotal", total)

    def head(title, subset_note):
        L = []
        L.append("# %s · 2026-11-16" % title)
        L.append("")
        L.append(subset_note)
        L.append("")
        return L

    # ── 正文：只有「只有记录」与「粘贴原文」——这才是他会看的两类 ──
    L = head(
        "待人工复核（%d 条）" % sum(1 for r in rows if r["verdict"] in MAIN),
        "> 从 **%d** 条真人发言里抽出来的**全部真信号**。其余：%d 条「接住」（原话被有进展的记录"
        "逐字引用）、%d 条「无法判定」（太短）、%d 条「疑似 / 无逐字引用」"
        "（在 [附录](待复核-%s.md) 里，一条一行）。%s" % (
            total, counts.get("接住", 0), counts.get("无法判定", 0),
            sum(1 for r in rows if r["verdict"] in APPENDIX), "附录-20261116",
            "两个客户端合计 %d 条 → 去重后 %d 条。" % (raw_total, total) if raw_total != total else ""))
    L.append("> **怎么复核**：每条下面有三个勾，你在 `[ ]` 里打 `x` 就行，或直接在旁边写字。")
    L.append("> 我不替你判 —— 三格分别问你：这件事是不是你要的、现在要不要做、要不要建成卡。")
    L.append("")
    L.append("## ⚠ 先说清这一版的判据（上一版是错的）")
    L.append("")
    L.append("上一版用「罕见词覆盖率」，它把「请给我详细的验证测试清单」判成「接住」，")
    L.append("命中的词是 `试清单` `试清` `清单` —— **这种证据你一条都复核不了**，")
    L.append("而且全语料 76.5% 都被判成「有记录」。现在换成**逐字重合**：")
    L.append("只认他的原话在某份记录里**被原文引用**（≥6 字连续片段），并把那段原文印出来。")
    L.append("")
    L.append("所以每条「命中」行都是**能盯一眼就知道对不对**的：")
    L.append("`[强]14 字 \\`跨渠道 token 对比视图\\` ← 卡 xxx` = 那张卡里原样写了这句话。")
    L.append("")
    L.append("---")
    L.append("")

    for v in MAIN:
        sub = [r for r in rows if r["verdict"] == v]
        if not sub:
            continue
        L.append("## %s（%d 条）" % (v, len(sub)))
        L.append("")
        L.append({
            "只有记录": "**记下了，但记录本身停在待办 —— 这就是「提了没做」的形状。**",
            "粘贴原文": "**这条消息本身就是旧记录的拷贝**（他把自己上轮的交接日志粘回来接着做）。"
                      "列在这里是为了**排除** —— 它不该进任何需求清单。",
        }[v])
        L.append("")
        for i, r in enumerate(sub, 1):
            L.append("### %d / %d · %s · %s" % (
                i, len(sub), r["ts"] or "时间不详", clip(r["proj"], 40) or "（无项目）"))
            L.append("")
            L.append("> " + clip(r["text"], 400))
            L.append("")
            for h in r["hits"]:
                L.append("- [%s] %d 字 `%s` ← %s `%s`（%s%s）" % (
                    h["cls"], h["len"], clip(h["run"], 60), h["kind"], clip(h["id"], 46),
                    h["status"] or "—", "" if h["progressed"] else " · **没进展**"))
            if not r["hits"]:
                L.append("命中：**无**")
            if r["why"]:
                L.append("")
                L.append("说明：" + r["why"])
            L.append("")
            if v != "粘贴原文":
                L.append("- [ ] 这是我要的　- [ ] 现在要做　- [ ] 建成卡")
            else:
                L.append("- 这一条**不用勾**：它是旧日志的拷贝，列在这里只是让你确认我判对了。")
            L.append("")
        L.append("---")
        L.append("")

    text = "\n".join(L)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")
    with open(args.out, encoding="utf-8") as f:
        main_bytes = len(f.read().encode("utf-8"))

    # ── 附录：疑似 / 无逐字引用。**一条一行**，能扫，但不占正文 ──
    A = head(
        "待复核 · 附录（%d 条，一条一行）" % sum(1 for r in rows if r["verdict"] in APPENDIX),
        "> 这两类**机器判不了**：\n"
        "> · **疑似** = 只有弱重合（<8 字 / 非中文为主 / 路径碎片）\n"
        "> · **无逐字引用** = 整份语料里找不到 ≥6 字原文引用。**不是「没做过」**，\n"
        ">   是「卡可能用了别的话写同一件事」，逐字判据看不见。\n"
        ">\n"
        "> 主清单在 [待复核-20261116.md](待复核-20261116.md)（只有 %d 条真信号）。" % len(MAIN and [r for r in rows if r["verdict"] in MAIN]))
    for v in APPENDIX:
        sub = [r for r in rows if r["verdict"] == v]
        if not sub:
            continue
        A.append("## %s（%d 条）" % (v, len(sub)))
        A.append("")
        for r in sub:
            ev = ""
            if r["hits"]:
                h = r["hits"][0]
                ev = " ← `%s` %s `%s`" % (clip(h["run"], 30), h["kind"], clip(h["id"], 30))
            A.append("- `%s` %s · %s%s" % (
                r["ts"] or "时间不详", clip(r["text"], 120), clip(r["proj"], 30) or "（无项目）", ev))
        A.append("")

    text2 = "\n".join(A)
    with open(args.appendix, "w", encoding="utf-8", newline="\n") as f:
        f.write(text2 + "\n")
    with open(args.appendix, encoding="utf-8") as f:
        app_bytes = len(f.read().encode("utf-8"))

    print("正文 %d 字节 → %s" % (main_bytes, args.out))
    print("附录 %d 字节 → %s" % (app_bytes, args.appendix))
    print("真信号 %d 条（" % sum(1 for r in rows if r["verdict"] in MAIN) + " · ".join(
        "%s %d" % (v, sum(1 for r in rows if r["verdict"] == v)) for v in MAIN
        if any(r["verdict"] == v for r in rows)) + "）；附录 %d 条" % sum(
        1 for r in rows if r["verdict"] in APPENDIX))
    return 0


if __name__ == "__main__":
    sys.exit(main())
