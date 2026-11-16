#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""开工简报 · 守卫 + 反例自证（2026-11-16 · 治病①「没有记忆」的入口）

## 钉的是什么口径

卡 `最高优先级ai-施工的五种病…` 的验收线（原文）：

> 跑完让 agent 回答三个问题：**上次做到哪 / 这次先做什么 / 有哪些规矩别犯**
> —— 三个都答对才算治了病 ①；
> `num: 该入口输出的上下文体积 <= 8KB`（不许靠"塞得多"取胜）；
> 反面：**如果 agent 仍需人贴一遍上下文，本条判失败。**

## 为什么不能只测"脚本跑得动"

这条链错了也照样出东西，而且**看起来完全正常**。2026-11-16 实测踩到两个：

  ① `项目:` 有单值与**块式列表**两种写法（`项目:\\n  - sitian`）。
     第一版只认单值 → 「谁在等你」判 0 条，而它显示成「没有：都为 0」——
     **与真身一致时一模一样，不一致时也一模一样**。这是本仓最忌讳的"界面说假话"。
  ② 方寸的 P12 是"界面整站重做 19 个视图"——脚本**如实算出**它是下一格，
     但它并不是用户想要的那一格。**算出 ≠ 判断**，所以卡片必须能被人覆盖。

## 跑法

    python scripts/test/check-brief.py

退出码：0 = 全过；1 = 有失败。
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRIEF = os.path.join(ROOT, "scripts", "brief.py")
BUDGET = 8 * 1024

pass_n = 0
fail_n = 0
failures = []


def check(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("PASS  %s" % name + ("  — %s" % detail if detail else ""))
    else:
        fail_n += 1
        failures.append("%s%s" % (name, " :: " + detail if detail else ""))
        print("FAIL  %s%s" % (name, "  → %s" % detail if detail else ""))
    return bool(cond)


def run(*args):
    r = subprocess.run([sys.executable, "-X", "utf8", BRIEF, *args],
                       cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=300)
    return r.returncode, (r.stdout or ""), (r.stderr or "")


PROJECTS = ["fangcun-base", "sitian", "project-3", "memory-sanctuary", "project-2"]


def main():
    # ══ 一、每个项目都能出简报，且不超预算 ══
    print("=== 一、体积与可生成性 ===")
    texts = {}
    for p in PROJECTS:
        code, out, err = run("--project", p)
        texts[p] = out
        m = re.search(r"体积 (\d+) / (\d+) 字节（(OK|\*\*超预算\*\*)）", out)
        check("★ %s：出得来且报体积" % p, m is not None,
              (err or out)[:120] if not m else "")
        if m:
            check("★★ %s：不超 8KB（塞得多不算本事）" % p, int(m.group(1)) <= BUDGET,
                  "%s 字节" % m.group(1))

    # ══ 二、四个问题（卡上的三个 + 体积）都必须有答案 ══
    print("\n=== 二、四个问题都得有答案 ===")
    for p in PROJECTS[:3]:
        t = texts[p]
        for label in ("① 上次做到哪", "② 这次先做什么", "③ 有谁在等你", "④ 有哪些规矩别犯"):
            check("★★ %s：有「%s」这一格" % (p, label), label in t)

    # ══ 三、不许把"算不出"糊成"没有" ══
    print("\n=== 三、算不出要说算不出，不许说没有 ===")
    # project-3 的下一步实测为空 → 必须出现"算不出/没填"，不许写成"没有活"
    t3 = texts["project-3"]
    # ⚠ 这条断言第一版写的是 `"没有活" not in t3` —— 而简报原文正是
    #   「**这是缺数据，不是没有活**」。纯子串匹配把**否定句**判成违规（红了一条真断言）。
    #   现在要求：既说了"没填/算不出"，又要它明确区分"缺数据 ≠ 没活"。
    check('★★ 日志没填下一步时，必须说「算不出/没填」，且明确「缺数据 ≠ 没活」',
          ("算不出" in t3 or "没填" in t3) and ("不是没有活" in t3 or "缺数据" in t3),
          str([ln for ln in t3.splitlines() if "下一步" in ln][:1]))

    # ⚠ 还有一条分支此前**根本没被断言覆盖**（反例自证抓到的）：
    #   「该项目在 docs/执行日志/ 里一条日志都没有」→ 必须说"算不出"，不许静默省略。
    #   现实中 registry 里很多项目（vedio-maker / yijucanxiang…）就是这种。
    print("\n=== 三·2、完全没有日志的项目 ===")
    code, out, _err = run("--project", "vedio-maker")
    # ⚠ 断言第一版写的是 `"算不出" in out` —— **恒为真**：这份简报里"算不出"
    #   至少出现在三处（日志 / 提交 / 计划），所以把日志那一行删掉也照样绿。
    #   反例自证当场抓到了它（GREEN✗ 只红 0 条）。现在钉**具体那一句**。
    check('★★ 没有任何执行日志的项目：必须点名「没有属于 xx 的日志」',
          re.search(r"没有属于 `?vedio-maker`? 的日志", out) is not None,
          str([l for l in out.splitlines() if "日志" in l][:2]))
    check('★ 且不许把它写成「没有活/都没有」',
          "没有活" not in out.replace("不是没有活", ""), "")

    # ══ 四、块式 `项目:` 必须被认（否则"谁在等你"恒为 0）══
    print("\n=== 四、块式 project 写法 ===")
    spec = importlib.util.spec_from_file_location("b", BRIEF)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    blk = "id: x\n项目:\n  - sitian\n状态: 待验收"
    check("★★ 块式 `项目:\\n  - sitian` 能被认出来", m.fm_project("sitian", blk),
          repr(m.fm_list(blk, "项目")))
    check("★ 单值 `项目: sitian` 也能认", m.fm_project("sitian", "id: x\n项目: sitian"))
    check("★ 别的项目**不许**误判命中", not m.fm_project("project-3", blk))

    # ══ 五、只读 ══
    print("\n=== 五、只读 ===")
    def fp(d):
        out = []
        for dp, _, fns in os.walk(d):
            for fn in fns:
                p2 = os.path.join(dp, fn)
                try:
                    st = os.stat(p2)
                except OSError:
                    continue
                out.append("%s:%d:%d" % (os.path.relpath(p2, d), st.st_size, st.st_mtime_ns))
        return "\n".join(sorted(out))
    before = fp(os.path.join(ROOT, "task-data"))
    run("--project", "fangcun-base")
    check("★★ 跑一遍简报，task-data 逐字节 + mtime 全不变", fp(os.path.join(ROOT, "task-data")) == before)

    # ══ 六、源码守卫（只读 + 口径不许在别处重写）══
    print("\n=== 六、源码守卫 ===")
    src = open(BRIEF, encoding="utf-8").read()
    stripped = "\n".join(l for l in src.splitlines()
                         if not l.strip().startswith("#") and not l.strip().startswith('"'))
    # ⚠ 只读铁律的正确口径：**不许写 task-data / policies / 日志**。
    #   第一版一刀切「源码里不许出现写文件」→ 咬到了 `--out`（那是**人主动要的导出**，
    #   写的是 `docs/开工简报-*.md`，不碰任何真身）。判据要盯"写到哪"，不是"有没有 write"。
    check('★★ 简报**不写** task-data / policies / docs/执行日志（只读真身）',
          not re.search(r"(task-data|policies|执行日志)[^\n]{0,80}['\"]w",
                         stripped),
          "命中即表示会写真身目录")
    check('★ `--out` 只允许写 docs/ 下的简报文件', 'docs' in src and '开工简报' in src)
    check("★★ 预算常量的唯一真源在这里（别处不许另写一个 8KB）",
          "BUDGET_BYTES = 8 * 1024" in src)

    print("\nRESULT %d / %d" % (pass_n, fail_n))
    if fail_n:
        print("FAILURES:")
        for f in failures:
            print("  - " + f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
