#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""私有专名扫描器 · 反例自证（2026-11-16）

为什么必须有：这个扫描器 6/0 全绿，但"全绿"可能是**空转**
（词表解不出、扫错目录、剥注释把一切都剥掉、正则不匹配）。
所以把已知的泄漏装回去，它必须精确变红。

暮雨原话：「**司天/墨坊永不该出现在方寸的任何一处文案中**」

跑法：python scripts/test/check-privacy-mutations.py
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
SCAN = os.path.join(ROOT, "scripts", "privacy-scan.cjs")
TERMS = os.path.join(ROOT, "scripts", "privacy-terms.cjs")
GUIDE = os.path.join(ROOT, "desktop", "src", "renderer", "utils", "userGuide.ts")


def digest(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def run():
    r = subprocess.run(["node", SCAN], cwd=ROOT, capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=600)
    out = (r.stdout or "") + (r.stderr or "")
    m = re.search(r"RESULT (\d+) / (\d+)", out)
    return (int(m.group(1)), int(m.group(2)), out) if m else (None, None, out)


def main():
    bp, bf, out = run()
    if bp is None:
        print("✗ 扫描器跑不起来：")
        print(out[-1200:])
        return 1
    print("基线：RESULT %d / %d" % (bp, bf))
    if bf:
        print("✗ 基线本来就红，反例自证无意义")
        return 1

    # ── 反例一：往**界面文案**（非注释）里塞一个专名 → 必须红 ──
    src = open(GUIDE, encoding="utf-8").read()
    h0 = digest(GUIDE)
    tmp = os.path.join(tempfile.gettempdir(), "userGuide.privacy.bak")
    shutil.copy2(GUIDE, tmp)
    ok, bad = 0, []
    try:
        anchor = "本手册只覆盖方寸自己的功能。"
        # 直接找一个真实存在于 blocks 里的字符串行来改
        m = re.search(r"(\{ t: 'p', v: ')([^']{10,})", src)
        if not m:
            print("SKIP  找不到可注入的文案行")
        else:
            injected = src[:m.start(2)] + "【测试专名】" + src[m.start(2):]
            open(GUIDE, "w", encoding="utf-8", newline="\n").write(injected)
            # 用词表里的词注入（不写死明文，从 base64 解）
            import base64, json
            tb = open(TERMS, encoding="utf-8").read()
            mm = re.search(r"const B64 =\s*([\s\S]*?)\n\n", tb)
            terms = json.loads(base64.b64decode(
                "".join(re.findall(r"'([A-Za-z0-9+/=]*)'", mm.group(1)))).decode())["terms"]
            word = terms[0]
            injected2 = src[:m.start(2)] + word + src[m.start(2):]
            open(GUIDE, "w", encoding="utf-8", newline="\n").write(injected2)
            p2, f2, o2 = run()
            if f2 > bf:
                print("RED✓  文案里塞进专名 → 新增红 %d 条" % (f2 - bf))
                ok += 1
            else:
                bad.append("文案里塞专名没被抓到（扫描器空转）")
                print("GREEN✗ 文案里塞专名 → 红 %d 条，预期 >%d" % (f2, bf))
    finally:
        shutil.copy2(tmp, GUIDE)
        os.remove(tmp)

    if digest(GUIDE) != h0:
        print("✗ 还原后字节不一致")
        return 1
    print("还原：逐字节一致")

    # ── 反例二：词表里塞明文 → 必须红（"扫描器自己就是泄漏源"）──
    h1 = digest(TERMS)
    tmp2 = os.path.join(tempfile.gettempdir(), "privacy-terms.bak")
    shutil.copy2(TERMS, tmp2)
    try:
        tb = open(TERMS, encoding="utf-8").read()
        # 在代码区（非注释）里明文写一个专名
        leaked = tb.replace("module.exports = {", "const LEAK = '司天'\nmodule.exports = {", 1)
        open(TERMS, "w", encoding="utf-8", newline="\n").write(leaked)
        p3, f3, _ = run()
        if f3 > bf:
            print("RED✓  词表文件里明文写专名 → 新增红 %d 条" % (f3 - bf))
            ok += 1
        else:
            print("GREEN✗ 词表明文没被抓到")
            bad.append("词表明文没被抓到")
    finally:
        shutil.copy2(tmp2, TERMS)
        os.remove(tmp2)

    if digest(TERMS) != h1:
        print("✗ 词表还原后字节不一致")
        return 1

    print()
    if bad:
        print("反例自证 %d / 2 通过，%d 组没抓到：" % (ok, len(bad)))
        for b in bad:
            print("  - " + b)
        return 1
    print("反例自证全部通过（2 组）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
