#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""开工简报 · 反例自证：把已知的坑装回去，守卫必须精确变红。

为什么必须有这个（本仓已踩过的教训）：
「测试全绿不等于没改坏东西」—— 守卫自己也会假绿。2026-11-16 就抓到过两次
（`e2e-harvest` 的"碎片不许算引用"写作"不许判成接住"、`check-ui-copy` 漏扫数据文件）。

每组 = 一次精确替换 + 跑守卫 + 断言"恰好多出 N 条红" + **逐字节还原**。

跑法：python scripts/test/check-brief-mutations.py
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
BRIEF = os.path.join(ROOT, "scripts", "brief.py")
GUARD = os.path.join(ROOT, "scripts", "test", "check-brief.py")

# (名字, 原文, 换成, 预期新增红条数)
MUTATIONS = [
    (
        "块式 `项目:` 不再被认（「谁在等你」会恒为 0，且看起来完全正常）",
        '    blk = fm_list(fm, "项目") + fm_list(fm, "project")',
        '    blk = []',
        1,
    ),
    (
        "预算放大 10 倍（塞得多就赢了 —— 正是卡上禁止的那条）",
        "BUDGET_BYTES = 8 * 1024",
        "BUDGET_BYTES = 80 * 1024",
        1,
    ),
    (
        # ⚠ 这条反例换过一版：第一版把那一行换成 `pass` —— 但 `else:` 分支只剩空语句时
        #   Python 会静默跳过，**输出一字不变**，于是"守卫没抓到"其实是"根本没改坏东西"。
        #   现在改成真会改变输出的写法：静默省略整行（agent 会以为这项目没活）。
        "「算不出」的格改成静默省略（agent 会以为这格没活）",
        '        L.append("- **算不出**：`docs/执行日志/` 里没有属于 `%s` 的日志" % p)',
        '        L.append("")',
        1,
    ),
]


def digest(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def run_guard():
    r = subprocess.run([sys.executable, "-X", "utf8", GUARD], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=1800)
    out = (r.stdout or "") + (r.stderr or "")
    m = re.search(r"RESULT (\d+) / (\d+)", out)
    return (int(m.group(1)), int(m.group(2)), out) if m else (None, None, out)


def main():
    bp, bf, out = run_guard()
    if bp is None:
        print("✗ 守卫本身跑不起来：")
        print(out[-1500:])
        return 1
    print("基线：RESULT %d / %d" % (bp, bf))
    if bf:
        print("✗ 基线本来就红，反例自证无意义")
        return 1

    src = open(BRIEF, encoding="utf-8").read()
    h0 = digest(BRIEF)
    tmp = os.path.join(tempfile.gettempdir(), "brief.mutation.bak")
    shutil.copy2(BRIEF, tmp)

    ok, bad = 0, []
    try:
        for name, old, new, expect in MUTATIONS:
            if old not in src:
                bad.append("%s :: 锚点找不到（源码变了？）" % name)
                print("SKIP  %s（锚点找不到，先更新本脚本）" % name)
                continue
            with open(BRIEF, "w", encoding="utf-8", newline="\n") as f:
                f.write(src.replace(old, new, 1))
            p2, f2, o2 = run_guard()
            if p2 is None:
                print("RED★  %s → 守卫跑不起来（也算抓到，但不是断言级）" % name)
                ok += 1
                continue
            delta = f2 - bf
            if delta >= expect:
                print("RED✓  %s → 新增红 %d 条（预期 ≥%d）" % (name, delta, expect))
                ok += 1
            else:
                bad.append("%s :: 只红 %d 条，预期 ≥%d（守卫假绿）" % (name, delta, expect))
                print("GREEN✗ %s → 只红 %d 条，预期 ≥%d —— 守卫没钉住这个坑"
                      % (name, delta, expect))
    finally:
        shutil.copy2(tmp, BRIEF)
        os.remove(tmp)

    h1 = digest(BRIEF)
    if h0 != h1:
        print("✗ 还原后字节不一致！")
        return 1
    print("还原：逐字节一致（sha256 %s）" % h0[:12])
    print()
    if bad:
        print("反例自证 %d / %d 组通过，%d 组没抓到：" % (ok, len(MUTATIONS), len(bad)))
        for b in bad:
            print("  - " + b)
        return 1
    print("反例自证全部通过（%d 组）" % ok)
    return 0


if __name__ == "__main__":
    sys.exit(main())
