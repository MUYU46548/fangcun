#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""长期方案守卫 · 反例自证（2026-11-16）

D-143 的验收线原文：「若长期方案写不出『明确不做什么』这一栏 = 不算计划；
长期方案里出现无法指回依据的条目 = 违约。」

守卫 14/0 全绿可能是空转（三问节名写错就永远匹配不到、依据正则过宽就永远通过）。
所以把每种"不算计划"装回去，它必须精确变红。

跑法：python scripts/test/check-long-plan-mutations.py
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LONG = os.path.join(ROOT, "task-data", "plans", "_long", "fangcun-base.md")
GUARD = os.path.join(ROOT, "scripts", "test", "e2e-long-plan.cjs")

# (名字, 原文, 换成, 预期新增红条数)
MUTATIONS = [
    (
        "三问缺一节（删掉「明确不做什么」）—— D-143：这就不算计划",
        "## 三、明确不做什么",
        "## 三、其他",
        3,   # 缺节 + 空壳 + 不做清单没有条目/依据
    ),
    (
        "「不做」清单里塞一条无依据的",
        "| **不写别人的仓库** |",
        "| **不加班** | 我猜的。 |\n| **不写别人的仓库** |",
        1,
    ),
    (
        "长期不指回中期（把阶段卡引用全删）",
        "指向阶段卡：**P13（产出口径变真，已落地 `cee9658`）**",
        "指向阶段卡：（无）",
        1,
    ),
    (
        "指向一张**不存在的**阶段卡（P99）",
        "指向阶段卡：**P13（产出口径变真，已落地 `cee9658`）**",
        "指向阶段卡：**P99（瞎编的）**",
        1,
    ),
]


def digest(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def run():
    r = subprocess.run(["node", GUARD], cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=600)
    out = (r.stdout or "") + (r.stderr or "")
    m = re.search(r"RESULT (\d+) / (\d+)", out)
    return (int(m.group(1)), int(m.group(2)), out) if m else (None, None, out)


def main():
    bp, bf, out = run()
    if bp is None:
        print("✗ 守卫跑不起来：")
        print(out[-1500:])
        return 1
    print("基线：RESULT %d / %d" % (bp, bf))
    if bf:
        print("✗ 基线本来就红，反例自证无意义")
        return 1

    src = open(LONG, encoding="utf-8").read()
    h0 = digest(LONG)
    tmp = os.path.join(tempfile.gettempdir(), "long-plan.mutation.bak")
    shutil.copy2(LONG, tmp)

    ok, bad = 0, []
    try:
        for name, old, new, expect in MUTATIONS:
            if old not in src:
                bad.append("%s :: 锚点找不到" % name)
                print("SKIP  %s（锚点找不到，先更新本脚本）" % name)
                continue
            with open(LONG, "w", encoding="utf-8", newline="\n") as f:
                f.write(src.replace(old, new, 1))
            p2, f2, o2 = run()
            if p2 is None:
                print("RED★  %s → 守卫跑不起来（也算抓到）" % name)
                ok += 1
                continue
            delta = f2 - bf
            if delta >= expect:
                print("RED✓  %s → 新增红 %d 条（预期 ≥%d）" % (name, delta, expect))
                ok += 1
            else:
                bad.append("%s :: 只红 %d 条，预期 ≥%d（守卫假绿）" % (name, delta, expect))
                print("GREEN✗ %s → 只红 %d 条，预期 ≥%d —— 守卫没钉住" % (name, delta, expect))
    finally:
        shutil.copy2(tmp, LONG)
        os.remove(tmp)

    if digest(LONG) != h0:
        print("✗ 还原后字节不一致")
        return 1
    print("还原：逐字节一致")
    print()
    if bad:
        print("反例自证 %d / %d 通过，%d 组没抓到：" % (ok, len(MUTATIONS), len(bad)))
        for b in bad:
            print("  - " + b)
        return 1
    print("反例自证全部通过（%d 组）" % ok)
    return 0


if __name__ == "__main__":
    sys.exit(main())
