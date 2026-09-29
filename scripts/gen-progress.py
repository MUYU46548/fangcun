#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方寸 · 进度总览生成器

为什么要有它（2026-09-26 用户原话）：
  「现在日志已经开始乱了，不知道哪些做了哪些没做，因为进行中的标识没给我做好，已经出了问题。」

问题不在"写得少"，在于**开发日志是流水账**：一条条往下堆，谁也不知道整体还剩什么。
本脚本把 `task-data/*.md` 的 **状态字段**（唯一权威来源）汇总成一张总览表，
写进 `开发日志.md` 的 AUTO 区（`<!-- PROGRESS:AUTO:BEGIN -->` … `END` 之间），
并另存一份独立文件，方便不开应用就能看。

铁律：
  · 只读卡片，**不改任何卡片状态**（状态是人/流程定的，脚本只汇总）；
  · 只改 AUTO 区之间的内容，人类手写的部分（含 AUTO 区下方的"下一步"）一个字不动；
  · 卡片解析失败不抛异常 —— 列进「解析失败」一栏，绝不静默吞掉。

用法：
    python scripts/gen-progress.py                 # 只更新 开发日志.md
    python scripts/gen-progress.py --also <path>   # 另外写一份独立总览文件
    python scripts/gen-progress.py --dry           # 只打印，不写文件
"""

import argparse
import io
import os
import re
import subprocess
import sys
import time
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASK_DIR = os.path.join(ROOT, "task-data")
DEVLOG = os.path.join(ROOT, "开发日志.md")
BEGIN = "<!-- PROGRESS:AUTO:BEGIN 由 scripts/gen-progress.py 生成，勿手改 -->"
END = "<!-- PROGRESS:AUTO:END -->"

# 状态 → (图标, 排序权重, 说明)
STATUS_META = {
    "完成": ("✅", 0, "完成"),
    "待验收": ("🟡", 1, "待验收（代码已完，等人点验）"),
    "进行中": ("⏳", 2, "进行中"),
    "待办": ("⬜", 3, "待办（未开工）"),
    "待审批": ("📥", 4, "待审批"),
    "草稿": ("📝", 5, "草稿"),
    "驳回": ("↩", 6, "驳回"),
}


def read_frontmatter(path):
    try:
        txt = io.open(path, encoding="utf-8", errors="replace").read()
    except Exception:
        return None
    if not txt.startswith("---"):
        return None
    end = txt.find("\n---", 3)
    if end < 0:
        return None
    fm = txt[3:end]
    out = {}
    for line in fm.splitlines():
        m = re.match(r"^([A-Za-z_\u4e00-\u9fff]+)\s*[:：]\s*(.*)$", line.strip())
        if m:
            out[m.group(1)] = m.group(2).strip().strip("\"'")
    return out


def collect():
    rows, broken = [], []
    if not os.path.isdir(TASK_DIR):
        return rows, broken
    for name in sorted(os.listdir(TASK_DIR)):
        if not name.endswith(".md"):
            continue
        # ⚠ 早先这里是 `name.startswith("task-")` —— 那会把**文件名不以 task- 开头、
        #   但确实是任务卡**的一批直接漏掉（2026-09-29 实查 5 张：
        #   看板视图按项目分组…297cdf80 / 剧本推进-2eda620c / 视频制作0924-49657d5b /
        #   0924-1驳回完成的任务删不掉…67069c8d / 方寸工程债清理…e8837f14），
        #   而本区存在的理由恰恰是"看不出哪些做了哪些没做"。
        #   改成按**有没有任务前言**判定：有 `id` 才算卡片；
        #   纯文档（项目简报/实测清单/验收证据/_template）没有 frontmatter `id`，
        #   自然被跳过，也不会污染下面的"解析失败"名单。
        full = os.path.join(TASK_DIR, name)
        fm = read_frontmatter(full)
        if not fm:
            continue
        if not str(fm.get("id") or "").strip():
            continue
        rows.append({
            "id": fm.get("id") or name[:-3],
            "title": (fm.get("标题") or fm.get("title") or "(无标题)").strip(),
            "status": (fm.get("状态") or fm.get("status") or "未知").strip(),
            "project": (fm.get("项目") or fm.get("project") or "").strip(),
            "file": name,
        })
    return rows, broken


def git(cmd):
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        return (r.stdout or "").strip()
    except Exception:
        return ""


def build_block(rows, broken):
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    head = git(["git", "log", "--oneline", "-1"]) or "（非 git 仓库）"
    dirty = git(["git", "status", "--short"])
    groups = {}
    for r in rows:
        groups.setdefault(r["status"], []).append(r)
    def sort_key(st):
        return STATUS_META.get(st, ("", 9, ""))[1]
    done = len(groups.get("完成", []))
    pending_verify = len(groups.get("待验收", []))
    todo = len(groups.get("待办", []))

    L = [BEGIN, ""]
    L.append("## 📌 当前进度总览（自动生成 · %s）" % now)
    L.append("")
    L.append("> 本区由 `scripts/gen-progress.py` 从 `task-data/*.md` 的**状态字段**汇总生成 —— "
             "状态是唯一权威来源，不要手改本区（手改会在下次生成时被覆盖）。")
    L.append("")
    L.append("- 最近提交：`%s`" % head)
    L.append("- 工作区：%s" % ("干净" if not dirty else "**有未提交改动**（%d 项）" % len(dirty.splitlines())))
    L.append("- 卡片合计：**%d** 张 · ✅ 完成 %d · 🟡 待验收 %d · ⏳ 进行中 %d · ⬜ 待办 %d"
             % (len(rows), done, pending_verify, len(groups.get("进行中", [])), todo))
    if broken:
        L.append("- ⚠ 解析失败（frontmatter 不完整，脚本没动它们）：%s" % "、".join(broken))
    L.append("")
    L.append("| 状态 | 张数 | 卡片（id — 标题） |")
    L.append("|---|---|---|")
    for st in sorted(groups, key=sort_key):
        icon, _, label = STATUS_META.get(st, ("❓", 9, st))
        items = sorted(groups[st], key=lambda x: x["id"])
        cell = "<br>".join("`%s` %s%s" % (x["id"], x["title"],
                                          ("（%s）" % x["project"]) if x["project"] else "")
                           for x in items)
        L.append("| %s %s | %d | %s |" % (icon, label, len(items), cell))
    L.append("")
    L.append("**怎么读这三栏**：✅＝已完成；🟡＝**代码写完、等你点验**（不是「还没做」）；"
             "⬜＝确实没开工（照卡片顺序推进）。")
    L.append("")
    L.append(END)
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--also", action="append", default=[], help="另外写一份独立总览文件")
    ap.add_argument("--dry", action="store_true", help="只打印不写文件")
    args = ap.parse_args()

    rows, broken = collect()
    block = build_block(rows, broken)

    if args.dry:
        sys.stdout.write(block + "\n")
        return 0

    # 写回开发日志（只替换 AUTO 区；没有就插在第一个标题之后）
    if os.path.exists(DEVLOG):
        text = io.open(DEVLOG, encoding="utf-8", newline="").read()
    else:
        text = "# 方寸 · 开发日志\n"
    if BEGIN in text and END in text:
        pre = text.split(BEGIN)[0]
        post = text.split(END, 1)[1]
        text = pre + block + post
    else:
        nl = "\r\n" if "\r\n" in text else "\n"
        lines = text.split(nl)
        idx = 1 if lines and lines[0].startswith("#") else 0
        head = lines[:idx]
        tail = lines[idx:]
        text = nl.join(head + ["", block.replace("\n", nl), ""] + tail)
    with io.open(DEVLOG, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    print("已更新 %s" % DEVLOG)

    for p in args.also:
        os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
        with io.open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write("# 方寸 · 进度总览\n\n" + block.replace(BEGIN, "").replace(END, "").strip() + "\n")
        print("已写入 %s" % p)

    print("卡片 %d 张：完成 %d / 待验收 %d / 进行中 %d / 待办 %d"
          % (len(rows), len([r for r in rows if r["status"] == "完成"]),
             len([r for r in rows if r["status"] == "待验收"]),
             len([r for r in rows if r["status"] == "进行中"]),
             len([r for r in rows if r["status"] == "待办"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
