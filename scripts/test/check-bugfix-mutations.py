#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""两个 11-15 bug 的反例自证：把错装回去，看守卫精确变红。

为什么必须做：本仓反复吃亏在「断言写得太松，自己以为验过了」。
本轮写这两个守卫时也各栽过一次（一个把 `存在` 吃进路径、一个注入 `.lower()` 啥也没改），
所以这里每条注入都必须**命中具体那条断言**才算过。
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DESKTOP = os.path.join(ROOT, "desktop")

CASES = [
    {
        "name": "反例①：判据路径退回「只认无空格」（`^(\\S+)\\s+`）→ 守卫必须在「带空格目录」上红",
        "file": os.path.join(DESKTOP, "src", "shared", "checkSpec.ts"),
        "old": "  const parts = s.split(/\\s+/)\n  for (let n = 1; n <= parts.length; n++) {",
        "new": "  const parts = s.split(/\\s+/)\n  for (let n = 1; n <= 1; n++) {",
        "guard": "e2e-check-paths.cjs",
        "expect": "带空格目录",
    },
    {
        "name": "反例②：路径取「最长」而不是最短 → 守卫必须在「路径完整 / 谓词没被吃进」上红",
        "file": os.path.join(DESKTOP, "src", "shared", "checkSpec.ts"),
        "old": "  for (let n = 1; n <= parts.length; n++) {",
        "new": "  for (let n = parts.length; n >= 1; n--) {",
        "guard": "e2e-check-paths.cjs",
        "expect": "带空格目录",
    },
    {
        "name": "反例③：白名单退回按喂料集合截断（不给 decisionIds）→ 守卫必须在「两个集合没拆开」上红",
        "file": os.path.join(DESKTOP, "src", "main", "llm", "planDraftInput.ts"),
        "old": "    decisionIds: effectiveDecisionIds(want),",
        "new": "    decisionIds: undefined,",
        "guard": "e2e-decision-whitelist.cjs",
        # 期望命中哪条断言文案 —— 必须与实际断言一致，否则反例本身假绿
        "expect": "两个集合真的拆开了",
    },
    {
        "name": "反例④：同日排序退回「按文件顺序」（去掉 tie-break）→ 守卫必须在「按 id 降序」上红",
        "file": os.path.join(DESKTOP, "src", "main", "llm", "planDraftInput.ts"),
        # ⚠ 第一版注入写的是 `` return `${日期}#` `` —— 那条**编译不过**（模板串里多了反引号），
        #   于是跑到的是 SETUP-FAIL 而不是断言变红。改成返回纯日期（可编译、且同日无 tie-break）。
        "old": "  return `${String(d.日期 || '')}#${String(idNum).padStart(8, '0')}`",
        "new": "  return String(d.日期 || '')",
        "guard": "e2e-decision-whitelist.cjs",
        "expect": "同日决策按 id 降序",
    },
    {
        # 2026-11-15 · 决策 D-141（O1 选 A）：产出格退回「数自报完成卡」
        "name": "反例⑤：产出格退回「数自报完成卡」→ 守卫必须在「不再出现 N 张卡完成」上红",
        "file": os.path.join(DESKTOP, "src", "shared", "waste.ts"),
        "old": "    if (verified !== null) parts.push(`${verified.length} 件可核实产出`)",
        "new": "    if (doneList !== null) parts.push(`${doneList.length} 张卡完成`)",
        "guard": "e2e-verifiable-output.cjs",
        "expect": "不再出现",
    },
    {
        # 判不了时偷偷退回完成卡当分母 —— 这是最阴的一种回潮（看起来还是算出了数）
        "name": "反例⑥：insight 判不了时退回「完成卡」当分母 → 守卫必须在「不许拿完成卡当分母」上红",
        "file": os.path.join(DESKTOP, "src", "shared", "waste.ts"),
        "old": "  const verified = output?.raw?.verified",
        "new": "  const verified = output?.raw?.verified ?? output?.raw?.done",
        "guard": "e2e-verifiable-output.cjs",
        "expect": "不许拿完成卡当分母",
    },
    {
        # 同一天两份判据各写各的（本仓反复犯的病：判词四档散 5 处 / 日志挑卡写三份）
        "name": "反例⑦：mismatch 退回自写一套 URL 判据 → 守卫必须在「不许再自己写一套」上红",
        "file": os.path.join(DESKTOP, "src", "shared", "mismatch.ts"),
        "old": "export { hasVerifiableOutput } from './verifiableOutput'",
        "new": "const RE_URL = /https?:\\/\\/[^\\s)）]+/\nexport { hasVerifiableOutput } from './verifiableOutput'",
        "guard": "e2e-verifiable-output.cjs",
        "expect": "不许再自己写一套",
    },
]


def build():
    p = subprocess.run(["npm", "run", "build"], cwd=DESKTOP, capture_output=True, timeout=600, shell=True)
    out = ((p.stdout or b"") + (p.stderr or b"")).decode("utf-8", "replace")
    errs = [l for l in out.split("\n") if "error TS" in l]
    return p.returncode, errs


def run_guard(name):
    p = subprocess.run(["node", os.path.join(ROOT, "scripts", "test", name)],
                       cwd=ROOT, capture_output=True, timeout=300)
    out = ((p.stdout or b"") + (p.stderr or b"")).decode("utf-8", "replace")
    return p.returncode, out


def main():
    results = []
    for c in CASES:
        src = open(c["file"], encoding="utf-8").read()
        if c["old"] not in src:
            print("SETUP-FAIL  %s：找不到注入点" % c["name"])
            results.append(False)
            continue
        try:
            open(c["file"], "w", encoding="utf-8").write(src.replace(c["old"], c["new"], 1))
            rc, errs = build()
            if rc != 0:
                print("SETUP-FAIL  %s：注入后编译失败（不是断言变红）%s" % (c["name"], errs[:1]))
                results.append(False)
                continue
            code, out = run_guard(c["guard"])
            reds = [l for l in out.split("\n") if l.startswith("FAIL")]
            hit = any(c["expect"] in l for l in reds)
            ok = code != 0 and hit
            print(("PASS  " if ok else "FAIL  ") + c["name"])
            if ok:
                print("        红在：" + [l for l in reds if c["expect"] in l][0][:150])
            else:
                print("        exit=%s 命中=%s 实际红 %d 条" % (code, hit, len(reds)))
                for l in reds[:3]:
                    print("        " + l)
            results.append(ok)
        finally:
            open(c["file"], "w", encoding="utf-8").write(src)
    # 还原后必须重新 build 一次，别把坏产物留在 dist 里
    build()
    print()
    print("RESULT %d / %d" % (sum(1 for r in results if r), sum(1 for r in results if not r)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
