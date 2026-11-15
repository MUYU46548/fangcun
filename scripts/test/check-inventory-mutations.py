#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""反例自证：把今天修掉的两个错**真装回去**，看守卫是否精确变红。

为什么必须做这一步（本仓来回栽过的坑）：
  2026-11-15 早些时候，`.decision-log` 那条断言我改了三版，前两版
  「加了断言就算验过」—— 结果删掉过滤行它照样绿。真正拦住它的是第三版：
  把错误装回去、跑一遍、**看到它变红**。

这两个错同理：守卫若只是"读起来更严了"，那和没加的区别只是多一份虚假安全感。
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "inventory-unfinished.py")
GUARD = os.path.join(ROOT, "scripts", "test", "e2e-inventory.cjs")


def run_guard(script_path):
    """用**临时改坏的脚本副本**跑守卫（守卫里 SCRIPT 指向真文件，所以要换文件内容）。"""
    p = subprocess.run(["node", GUARD], cwd=ROOT, capture_output=True, timeout=600)
    out = (p.stdout or b"").decode("utf-8", "replace") + (p.stderr or b"").decode("utf-8", "replace")
    return p.returncode, out


def with_mutation(desc, old, new, expect_red_contains):
    """把 SCRIPT 就地改一处 → 跑守卫 → 必须红 → 还原。"""
    src = open(SCRIPT, encoding="utf-8").read()
    if old not in src:
        print("SETUP-FAIL  %s：找不到要注入的原文" % desc)
        return False
    backup = src
    try:
        open(SCRIPT, "w", encoding="utf-8").write(src.replace(old, new, 1))
        code, out = run_guard(SCRIPT)
        reds = [l for l in out.split("\n") if l.startswith("FAIL")]
        hit = expect_red_contains in out
        ok = code != 0 and hit
        print(("PASS  " if ok else "FAIL  ") + desc)
        if not ok:
            print("        exit=%s 命中预期红线=%s 实际红=%d 条" % (code, hit, len(reds)))
            for l in reds[:4]:
                print("        " + l)
        else:
            print("        红在：" + [l for l in reds if expect_red_contains in l][0][:150])
        return ok
    finally:
        open(SCRIPT, "w", encoding="utf-8").write(backup)


def main():
    results = []

    # ── 反例 1：阶段标题只认 `·`（回到 2026-11-15 之前那版正则）────────────
    results.append(with_mutation(
        "反例①：阶段标题退回「只认 `·`」→ 守卫必须在「一格不漏」上红",
        'HEAD_STAGE = re.compile(r"(?m)^###\\s+(P\\d+)\\s*[·:：]?\\s*(.*)$")',
        'HEAD_STAGE = re.compile(r"(?m)^###\\s+(P\\d+)\\s*·\\s*(.*)$")',
        "计划卡的格子**一格不漏**",
    ))

    # ── 反例 2：草案无脑全收（回到"目录里有几个文件就报几条"）──────────────
    results.append(with_mutation(
        "反例②：草案无脑全收 → 守卫必须在「已提成不算待提成」上红",
        "pending, blocked, promoted = [], [], 0",
        "pending, blocked, promoted = [(sid, title) for sid, title, _s in _split_stage_segments(txt)], [], 0",
        "草案里**已提成**的格子不算待提成",
    ))

    # ── 反例 3：按 `txt.split('### Pn')[-1]` 取段（取到全文 → 每格状态都串成整卡状态）
    #     ⚠ 这个注入换的是**分段手段**，不是正则：`_split_stage_segments` 改成
    #       「拿全文当每格正文」，于是每格读到的 `- 状态:` 都是文件里第一条。
    results.append(with_mutation(
        "反例③：分段退回 `split(...)[-1]`（每格读到整卡状态）→ 必须在「一格不漏」上红",
        "        out.append((m.group(1), (m.group(2) or \"\").strip(), txt[m.end():end]))",
        "        out.append((m.group(1), (m.group(2) or \"\").strip(), txt))",
        "计划卡的格子**一格不漏**",
    ))

    print()
    print("RESULT %d / %d" % (sum(1 for r in results if r), sum(1 for r in results if not r)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
