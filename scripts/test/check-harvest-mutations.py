#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""反例自证：把 e2e-harvest.cjs 钉的每一个坑**装回去**，它必须精确变红。

为什么必须有这个脚本（2026-11-16 的教训）：
> 「测试全绿不等于我没改坏别的东西。」

e2e-harvest 自己也可能假绿 —— 上一轮就出过一次：夹具里卡片文字和测试消息
写成**同一句话**，覆盖率必然 1.0，一条断言都测不到。所以守卫必须能自证：
**把已知的 bug 装回去，红几条、红在哪，要跟预期逐条对上。**

每组反例 = 一次精确的源码替换 + 跑守卫 + 断言"恰好多出 N 条红" + 逐字节还原。

跑法：python scripts/test/check-harvest-mutations.py
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
JUDGE = os.path.join(ROOT, "scripts", "judge-harvested.py")
GUARD = os.path.join(ROOT, "scripts", "test", "e2e-harvest.cjs")

# (名字, 原文, 换成, 预期新增红条数)
MUTATIONS = [
    (
        "去重键写成项目名（曾把 1217 条压成 21 条）",
        '        k = re.sub(r"\\s+", "", x[4])[:200]',
        '        k = re.sub(r"\\s+", "", x[3])[:200]',
        2,   # 「去重后仍保留 ≥80%」+「原始 1217 去重后仍是四位数」
    ),
    # ⚠ 这组反例换过两次，两次都是我写错，记下来：
    #   ① 只降 `W_MIN`（判据下限）→ **红 0 条**，因为真正发现重合的是索引窗口 `W_IDX`
    #      （只从 10 字窗口里找），下限降到 2 也永远看不到 2 字重合。
    #   ② 只降 `W_IDX` 不降 `W_MIN` → 也红 0 条（发现了但被下限挡掉）。
    #   两层缺一不可 —— 所以反例必须同时降，否则测的是空气。
    (
        "两层保护同时破：索引窗口 10→2 且下限 6→2（碎片会被当成原文引用）",
        "W_MIN = 6\nW_IDX = 10",
        "W_MIN = 2\nW_IDX = 2",
        1,   # 「碎片式巧合 => 无逐字引用」（实测会命中 `整个`）
    ),
    (
        "强/弱不分：把路径与英文专名也当强重合",
        "STRONG_MIN = 8\nSTRONG_CJK = 0.5",
        "STRONG_MIN = 2\nSTRONG_CJK = 0.0",
        1,   # 七节「接住 + 只有记录 都必须带 ≥6 字原文片段」
    ),
    (
        "台账又冒充卡（decisions.md 等被写成「卡」）",
        '        if base in LEDGER_NAMES or (not tid and not st):',
        '        if False:',
        2,   # 「不再被当成卡」+「有台账这一类」
    ),
    (
        "把「无逐字引用」改称「无记录」（夸大：那只是下界）",
        '"无逐字引用", "整份语料里没有 ≥%d 字的原文片段" % W_MIN',
        '"无记录", "整份语料里没有 ≥%d 字的原文片段" % W_MIN',
        1,   # 固定枚举那条（七节里另外三处用英文键 `无逐字引用`，改不动）
    ),
    (
        "「粘贴原文」不拦：他粘回来的旧日志会被算成需求",
        "    if top_len >= PASTE_MIN_CHARS and top_len >= len(text) * PASTE_RATIO:",
        "    if False:",
        0,   # 目前语料里恰好 3 条被正确判出，这一档没有硬断言 → 见下面说明
    ),
]


def digest(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def run_guard():
    r = subprocess.run(["node", GUARD], cwd=ROOT, capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=3600)
    out = (r.stdout or "") + (r.stderr or "")
    m = re.search(r"RESULT (\d+) / (\d+)", out)
    if not m:
        return None, None, out
    return int(m.group(1)), int(m.group(2)), out


def main():
    base_pass, base_fail, out = run_guard()
    if base_pass is None:
        print("✗ 守卫本身跑不起来：")
        print(out[-2000:])
        return 1
    print("基线：RESULT %d / %d" % (base_pass, base_fail))
    if base_fail:
        print("✗ 基线本来就红，反例自证无意义 —— 先修基线")
        return 1

    src = open(JUDGE, encoding="utf-8").read()
    h0 = digest(JUDGE)
    tmp = os.path.join(tempfile.gettempdir(), "judge-harvested.mutation.bak")
    shutil.copy2(JUDGE, tmp)

    ok = 0
    bad = []
    try:
        for name, old, new, expect in MUTATIONS:
            if old not in src:
                bad.append("%s :: 替换锚点找不到（源码变了？）" % name)
                print("SKIP  %s（锚点找不到，先更新本脚本）" % name)
                continue
            mutated = src.replace(old, new, 1)
            with open(JUDGE, "w", encoding="utf-8", newline="\n") as f:
                f.write(mutated)
            p, f2, o2 = run_guard()
            if p is None:
                # 语法/运行崩坏也算"抓到了"，但要如实说成崩坏
                print("RED★  %s → 守卫跑不起来（也算抓到，但不是断言级）" % name)
                ok += 1
                continue
            delta = f2 - base_fail
            if expect == 0:
                # 这一组没有硬断言：只报告事实，不算通过也不算失败
                print("INFO  %s → 红 %d 条（预期 0：目前无硬断言，靠人看）" % (name, delta))
                continue
            if delta >= expect:
                print("RED✓  %s → 新增红 %d 条（预期 ≥%d）" % (name, delta, expect))
                ok += 1
            else:
                bad.append("%s :: 只红 %d 条，预期 ≥%d（守卫假绿）" % (name, delta, expect))
                print("GREEN✗ %s → 只红 %d 条，预期 ≥%d —— 守卫没钉住这个坑"
                      % (name, delta, expect))
    finally:
        shutil.copy2(tmp, JUDGE)
        os.remove(tmp)

    h1 = digest(JUDGE)
    if h0 != h1:
        print("✗ 还原后字节不一致！%s ≠ %s" % (h0[:12], h1[:12]))
        return 1
    print("还原：逐字节一致（sha256 %s）" % h0[:12])

    print()
    if bad:
        print("反例自证 %d / %d 组通过，%d 组**没抓到**：" % (ok, len(MUTATIONS), len(bad)))
        for b in bad:
            print("  - " + b)
        return 1
    print("反例自证全部通过（%d 组）" % ok)
    return 0


if __name__ == "__main__":
    sys.exit(main())
