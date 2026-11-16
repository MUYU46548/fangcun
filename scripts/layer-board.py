#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""层厚度 · 跨项目横比（2026-11-16）

单项目报告回答"这个项目哪里重哪里薄"；这一份回答**只有方寸能回答的那个问题**：

    十几个项目横着放，谁在写业务、谁在写测试、谁在堆素材？

这正是暮雨 2026-11-15 那句话的意思 —— 方寸唯一比人强的地方是**跨项目横着比**。
人手工算一个项目要半小时，算十四个不可能。

⚠ 口径（每个数旁边都写清它证明不了什么）：
  · `产品` / `测试` / `工具` 按**目录名**分（`scripts`→工具，`test(s)`→测试）；
  · 分母只算**能解码成 UTF-8 的文本**，二进制（`.ts` 视频分片等）不计；
  · 隐藏目录 / 依赖 / 构建产物 / 内嵌运行时 / 备份 一律不计，且**逐条点名**；
  · 行数是**体量**，不是质量、不是成熟度、更不是"这个项目做得对不对"。

用法：
  python scripts/layer-board.py                # 打到屏幕
  python scripts/layer-board.py --out docs/层厚度-横比-20261116.md
  python scripts/layer-board.py --json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import importlib.util
_spec = importlib.util.spec_from_file_location(
    "layer_profile", os.path.join(ROOT, "scripts", "layer-profile.py"))
LP = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(LP)


def spec_for(pid):
    cand = os.path.join(LP.SPEC_DIR, pid + ".json")
    return cand if os.path.exists(cand) else None


def collect(depth=3):
    if not os.path.exists(LP.REGISTRY):
        return []
    out = []
    for p in LP.parse_registry(LP._read(LP.REGISTRY)):
        out.append(LP.profile_one(p["id"], depth, spec_for(p["id"]), True))
    return out


def build(rows_data):
    ok = [r for r in rows_data if not r.get("missing")]
    miss = [r for r in rows_data if r.get("missing")]

    def agg(r, role):
        return sum(x["lines"] for x in r["rows"] if x["role"] == role)

    for r in ok:
        r["_prod"] = agg(r, "产品")
        r["_test"] = agg(r, "测试")
        r["_tool"] = agg(r, "工具")
        r["_ratio"] = (r["_test"] / r["_prod"]) if r["_prod"] else None

    out = ["# 层厚度 · 跨项目横比", ""]
    out.append("- 生成时刻：{}".format(
        __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M")))
    # 「扫到东西」必须按**真的扫到文件**判，不能按"没报 missing"判 ——
    # 2026-11-16 首版就写成 15/0，而 ROSA 创作实际扫到 0 个文件（那是个 Obsidian 库）。
    scanned = [r for r in ok if r.get("total_files", 0) > 0]
    out.append("- 项目数：{}（{} 个扫到代码文件 / {} 个仓库在但没扫到代码 / {} 个扫不到仓库）".format(
        len(rows_data), len(scanned), len(ok) - len(scanned), len(miss)))
    out.append("- ⚠ **行数是体量，不是质量**。这份表能指方向，不能判好坏。")
    out.append("")
    out.append("## 一张表")
    out.append("")
    out.append("| 项目 | 产品 | 测试 | 工具 | 测试/产品 | 最厚的层 |")
    out.append("|---|---:|---:|---:|---:|---|")
    for r in sorted(ok, key=lambda x: -x["_prod"]):
        ratio = "{:.2f}".format(r["_ratio"]) if r["_ratio"] is not None else "—"
        top = r["rows"][0]["layer"] if r["rows"] else "—"
        name = "{} ({})".format(r["name"], r["id"]) if r.get("name") else r["id"]
        out.append("| {} | {:,} | {:,} | {:,} | {} | `{}` |".format(
            name, r["_prod"], r["_test"], r["_tool"], ratio, top))
    out.append("")

    # 只有这一节是"判断"，其余都是数
    out.append("## 三个能直接看的异常")
    out.append("")
    hi = [r for r in ok if r["_ratio"] is not None and r["_ratio"] >= 1.0 and r["_prod"] > 1000]
    if hi:
        out.append("### ① 测试比产品还厚（测试/产品 ≥ 1）")
        out.append("")
        for r in sorted(hi, key=lambda x: -x["_ratio"]):
            out.append("- **{}**：产品 {:,} 行，测试 {:,} 行 —— 测试是产品的 **{:.2f} 倍**。".format(
                r.get("name") or r["id"], r["_prod"], r["_test"], r["_ratio"]))
        out.append("")
        out.append("  这不一定是坏 —— 也可能是产品被内嵌运行时/生成物挡掉了。**看数之前先看下面那节排除清单。**")
    else:
        out.append("### ① 测试比产品还厚 —— 没有项目踩到（测试/产品 全部 < 1）。")
    out.append("")

    empty = [r for r in ok if r["_prod"] == 0]
    if empty:
        out.append("### ② 产品代码 0 行")
        out.append("")
        for r in empty:
            nt = len(r.get("nonText") or [])
            out.append("- **{}**：扫到 {} 个代码文件、产品 **0 行**{} —— ".format(
                r.get("name") or r["id"], r["total_files"],
                "（另有 {} 个像代码的二进制被挡）".format(nt) if nt else "") +
                ("这仓库本来就不是代码库（如 Obsidian 笔记库），**不是它没代码**。" if r["total_files"] <= 5
                 else "要么扩展名/排除规则把它的代码全挡掉了，要么它真的没有产品代码。"))
        out.append("")
    else:
        out.append("### ② 产品代码 0 行 —— 没有项目踩到。")
    out.append("")

    no_meta = [r for r in ok if r["_prod"] > 1000 and not r.get("groups")]
    out.append("### ③ 没有「声称的分层」可比")
    out.append("")
    if no_meta:
        out.append("这些项目产品代码不少，但 `scripts/layer-specs/<id>.json` 里没写它**自己声称**分几层 —— "
                   "所以只能给目录占比，回答不了「号称是 A 但 88% 在 B」：")
        out.append("")
        for r in sorted(no_meta, key=lambda x: -x["_prod"]):
            out.append("- {}（{:,} 行）".format(r.get("name") or r["id"], r["_prod"]))
        out.append("")
        out.append("> 要让它进入「对账」模式，需要在 spec 里写清 layers + groups。"
                   "**这个口径必须由人来给**，脚本不替人决定哪层叫什么。")
    else:
        out.append("所有产品代码 > 1,000 行的项目都有 spec。")
    out.append("")

    if miss:
        out.append("## ⚠ 扫不到的项目（{:,} 个）".format(len(miss)))
        out.append("")
        out.append("| 项目 | 为什么 |")
        out.append("|---|---|")
        for r in miss:
            out.append("| {} | {} |".format(r["id"], r["missing"]))
        out.append("")
        out.append("> **扫不到 ≠ 这项目是空的。** 上面这些没有出现在表里，不是 0 行。")
        out.append("")

    # 排除清单必须摊开 —— 否则读者没法判断上面的数是真数还是被规则改过的数
    out.append("## 被规则挡在外面的东西（按项目）")
    out.append("")
    out.append("这一节存在的理由：**排除规则会改变分母。** 2026-11-16 首跑时，"
               "方寸 50 万行「产品代码」里 36 万行是打包出来的 Electron 副本；"
               "墨坊 31.9 万行、明鉴 12.7 万行几乎全是内嵌 Python 运行时；"
               "司天有一个 287 万行的浏览器 profile。不点名的话，读者会以为那些数是产品。")
    out.append("")
    for r in sorted(ok, key=lambda x: -(x["total_lines"] + sum(1 for _ in x.get("skipped") or []))):
        sk = r.get("skipped") or []
        nt = r.get("nonText") or []
        if not sk and not nt:
            continue
        out.append("**{}**（{} 项规则命中）".format(r.get("name") or r["id"], len(sk) + len(nt)))
        out.append("")
        for s in sk[:12]:
            out.append("- `{}` —— {}".format(s["dir"], s["why"]))
        if len(sk) > 12:
            out.append("- …另有 {} 个被排除的目录".format(len(sk) - 12))
        if nt:
            out.append("- 非文本（未计入）：{} 个，例如 `{}`".format(
                len(nt), nt[0]["file"]))
        out.append("")

    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description="层厚度 · 跨项目横比（只读）")
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args()

    data = collect(args.depth)
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    text = build(data)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        back = LP._read(args.out)
        print("已写 {} 字节 → {}".format(len(back.encode("utf-8")), args.out))
        return 0
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
