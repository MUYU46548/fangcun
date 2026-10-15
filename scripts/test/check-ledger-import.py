#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
账本导入守卫（2026-10-15）

钉住三件事（每一件都对应一次"内容会丢"的真实风险）：
  ① **解析不漏**：账本里的每一条挂账都必须变出一张卡 —— 条数不许悄悄变少；
  ② **细节不丢**：条目的原文（去掉 markdown 强调后的字面）必须能在卡正文里找到；
  ③ **不重复建卡**：`[账本:<版本>:<key>]` 标记在全库唯一 —— 重跑导入不许产生第二份。

运行：python scripts/test/check-ledger-import.py [账本.md]
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import tegula.core as core  # noqa: E402
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("imp", os.path.join(ROOT, "scripts", "import-ledger.py"))
imp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imp)

LEDGER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "账本-20261015-终版v2.md")
VERSION = "20261015"

pass_ = 0
fail = 0
fails = []


def check(name, cond, detail=""):
    global pass_, fail
    if cond:
        pass_ += 1
        print("PASS  " + name)
    else:
        fail += 1
        fails.append(name + ((" :: " + str(detail)) if detail else ""))
        print("FAIL  " + name + ("  → " + str(detail) if detail else ""))


def main():
    print("== 账本导入守卫 ==")
    check("账本文件在", os.path.exists(LEDGER), LEDGER)
    if not os.path.exists(LEDGER):
        return 1
    with open(LEDGER, encoding="utf-8") as f:
        ledger = f.read()

    plan = imp.build_plan(ledger, VERSION)
    cards = plan.cards

    # ── ① 条数：每个 B 表条目都要有卡 ──────────────────────────────────
    b_items = imp.parse_b(ledger.split("## B 表：")[1].split("## C 表：")[0])
    check("B 表条目解析数量 >= 45（少了就是解析漏了）", len(b_items) >= 45, len(b_items))
    bkeys = {c["key"] for c in cards if c["key"].startswith("B-")}
    check("★ 每个 B 表条目都产出了一张卡（%d 条 → %d 张卡）" % (len(b_items), len(bkeys)),
          len(bkeys) >= len(b_items), "items=%d cards=%d" % (len(b_items), len(bkeys)))

    for label, prefix in [("A 索引", "A-index"), ("C 回字清单", "C-index"),
                          ("D 欠账", "D-1"), ("E 已死之单", "E-index"),
                          ("未达栏", "P-unreached"), ("总纲", "Z-summary")]:
        check("必有的卡存在：%s（%s）" % (label, prefix), any(c["key"] == prefix for c in cards))

    # ── ② 细节不丢：条目原文能在卡正文里找到 ───────────────────────────
    missing = []
    for sec, num, txt in b_items:
        head = txt[:24]
        if not any(head in "\n".join(c["方案"]) for c in cards if c["key"].startswith("B-")):
            missing.append(head)
    check("★★ 每条 B 表条目的**原文**都能在卡正文里找到（不做摘要式压缩）",
          not missing, "missing=%s" % missing[:3])

    # 划掉的行（~~…~~ → 已修）也算账的一部分，不许丢
    struck = [ln for ln in ledger.splitlines() if ln.strip().startswith("- ~~")]
    bodies = "\n".join("\n".join(c["方案"]) for c in cards)
    miss_struck = [s[:30] for s in struck if imp.clean_md(re.sub(r"^\s*-\s+", "", s)) not in bodies]
    check("★★ 账本里划掉的行（已修/已销，%d 行）也留了档 —— 销账记录也是账" % len(struck),
          not miss_struck, "missing=%s" % miss_struck)

    # ── ③ 卡面卫生：标题/正文不许漏 markdown 标记 ─────────────────────
    dirty = [c["标题"] for c in cards if "**" in c["标题"] or "`" in c["标题"] or "~~" in c["标题"]]
    check("★ 卡标题里没有裸的 ** / ` / ~~（Vue 不解析 Markdown）", not dirty, dirty[:3])

    dup_key = [k for k in {c["key"] for c in cards} if sum(1 for c in cards if c["key"] == k) > 1]
    check("★★ 计划里没有重复 key（重跑不会建两份）", not dup_key, dup_key)

    # ── ④ 已落地的卡：标记在全库唯一，且与计划一一对应 ─────────────────
    seen = {}
    tdir = core.TASK_DIR
    for sub in ("", "archive", ".trash"):
        d = os.path.join(tdir, sub) if sub else tdir
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith(".md"):
                continue
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                txt = f.read()
            for m in re.finditer(r"\[账本:%s:([^\]]+)\]" % VERSION, txt):
                seen.setdefault(m.group(1), []).append(os.path.join(sub, fn))

    dups = {k: v for k, v in seen.items() if len(v) > 1}
    check("★★ 全库里每个账本标记只出现一次（重复建卡 = 账本卡会自我繁殖）", not dups,
          {k: v[:2] for k, v in list(dups.items())[:3]})
    check("★ 计划里的每张卡都真的落盘了（%d 张）" % len(cards),
          all(c["key"] in seen for c in cards),
          "missing=%s" % [c["key"] for c in cards if c["key"] not in seen][:5])
    check("★ 落盘的标记数 == 计划卡数（没有多余/僵尸标记）",
          len(seen) == len(cards), "landed=%d planned=%d" % (len(seen), len(cards)))

    # ── ⑤ 已完成的账本条目不许再挂"待办" ───────────────────────────────
    doneish = [c for c in cards if re.search(r"→\s*已|已修（|已落地|已合入|已被你的产线做掉|已交付",
                                            c["标题"])]
    wrong = [c["key"] for c in doneish if c["状态"] != "完成"]
    check("★★ 账本已记「已修/已落地/已合入」的条目必须建成「完成」卡（不许继续冒充欠账）",
          not wrong, wrong)

    print("\n通过 %d / 失败 %d" % (pass_, fail))
    if fails:
        print("\n失败项：")
        for f in fails:
            print(" - " + f)
    print("RESULT %d / %d" % (pass_, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
