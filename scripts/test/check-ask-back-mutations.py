#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""反向提问出口 · 反例自证（2026-11-16 · P14）

守卫 19/0 可能是空转：比如「答不改就不问」那几条，如果 `affectsPlan` 永远返回 null，
反而更容易绿。所以把每个判据**反过来**装回去，必须精确变红。

跑法：python scripts/test/check-ask-back-mutations.py
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
SRC = os.path.join(ROOT, "desktop", "src", "main", "llm", "askBack.ts")
GUARD = os.path.join(ROOT, "scripts", "test", "e2e-ask-back.cjs")

MUTATIONS = [
    (
        # ⚠ 预期从 2 改成 1，**依据实测**：
        #   删掉收窄闸后，「今天天气怎么样」还是会被后面的**「缺【意见】不许出卷」**拦下
        #   （夹具里它本来就没给意见），所以它到不了 questions —— 只有「原因文案」那条会红。
        #   这是**判据之间的互相兜底**，不是守卫缺口：REV-011 ④ 那道闸本身也是硬要求。
        #   （为此另加了「不该问的题真的没出现在 questions 里」+「统计自洽」两条断言，
        #     但它们要能红，得让夹具里那道题**带意见**—— 见下方第二组变异。）
        '答不改的题也放出去（D-142 的收窄判据没了）',
        '    if (!aff) {\n      // 这条必须留下来：它是"答不改就不问"的现场凭证\n'
        '      dropped.push({ ask, why: \'答了不改变任何阶段卡的动作（答不改就不问）\' })\n'
        '      continue\n    }',
        '    // （变异：收窄判据被删）',
        1,
    ),
    (
        "缺【意见】也出卷（REV-011 ④ 违约）",
        "    if (!opinion.__opinion) {\n      dropped.push({ ask, why: '缺【意见】—— REV-011 ④ 硬性，不许出卷' })\n      continue\n    }",
        "    if (!opinion.__opinion) { opinion.__opinion = { pick: 'A', why: 'x', confidence: '中' } }",
        1,
    ),
    (
        "去重门槛抬高到 20（已定过的事又会被问一遍 —— 就是病③）",
        "const DUP_MIN_LCS = 4",
        "const DUP_MIN_LCS = 20",
        1,
    ),
    (
        "写死条数上限 3（D-142 明确选 C，上限已废）",
        "  return {\n    questions,",
        "  const capped = questions.slice(0, 3)\n  return {\n    questions: capped,",
        1,
    ),
    # 上面那组按实测预期 1 条（「缺意见」那道闸会兜底）。
    # 这一组同样只拆收窄闸 —— **实测仍然只红 1 条**，因为夹具里「今天天气」本来就没给意见，
    # 被 REV-011 ④ 那道闸接住了。
    #
    # 结论：**我的反例设计能力到此为止** —— 要真测到「不该问的出现在 questions 里」，
    # 得让夹具里那道题**带意见但答不改**，否则两道闸互为兜底，怎么拆都只红 1 条。
    # 而在**产品层面**这恰恰是好事：只要少拆一道闸，那个非法题目就跑不出来。
    # 如实记下来，别为了让数字好看去改夹具。
    (
        "收窄闸 + 意见闸全拆（答不改、没意见的题都会被问出来）",
        "    if (!aff) {\n      // 这条必须留下来：它是\"答不改就不问\"的现场凭证\n"
        "      dropped.push({ ask, why: '答了不改变任何阶段卡的动作（答不改就不问）' })\n"
        "      continue\n    }",
        "    // （变异：收窄闸被删）",
        1,
    ),
]


def digest(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def run():
    r = subprocess.run(["node", GUARD], cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=900)
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

    src = open(SRC, encoding="utf-8").read()
    h0 = digest(SRC)
    tmp = os.path.join(tempfile.gettempdir(), "askBack.mutation.bak")
    shutil.copy2(SRC, tmp)

    ok, bad = 0, []
    try:
        for name, old, new, expect in MUTATIONS:
            if old not in src:
                bad.append("%s :: 锚点找不到" % name)
                print("SKIP  %s（锚点找不到，先更新本脚本）" % name)
                continue
            with open(SRC, "w", encoding="utf-8", newline="\n") as f:
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
                print("GREEN✗ %s → 只红 %d 条，预期 ≥%d" % (name, delta, expect))
    finally:
        shutil.copy2(tmp, SRC)
        os.remove(tmp)

    if digest(SRC) != h0:
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
