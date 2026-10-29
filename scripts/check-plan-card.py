#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作战计划卡格式机检（P0 判据的执行体）。

判据来自 `task-data/plans/<项目>.md` 里每张阶段卡自己的「判据」区：
  - cmd: python scripts/check-plan-card.py 退出码 0
  - str: 五个二级标题一字不差且都存在
  - num: 每张非「待起草」阶段卡照抄点行数 >= 1、判据条数 >= 2

设计纪律（与项目既有 e2e 一致）：
  · 零依赖（纯 stdlib），只读，不写任何文件
  · 「待起草」的卡**跳过格式检查但计数**，不许静默忽略（缺口要报告）
  · 失败逐条列出，不合并成一句「格式错误」
"""
import sys
import re
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
PLAN_DIR = ROOT / "task-data" / "plans"

SECTIONS = ["范围", "交付物", "验收标准", "里程碑", "除外责任"]
COLUMNS = ["抄哪块", "落到哪", "不抄什么", "怎么算抄到位"]
PREFIXES = ("cmd:", "str:", "num:", "file:")

RE_CARD = re.compile(r"^### (P\d+)\s*·\s*(.+)$")


def block_after(lines, start_idx):
    """取 `- 键:` 之后、下一个顶级 `- ` / `#` 之前的正文行。"""
    out = []
    for ln in lines[start_idx + 1:]:
        if ln.startswith("- ") or ln.startswith("#"):
            break
        out.append(ln)
    return out


def find_key(lines, key):
    pat = "- " + key + ":"
    for i, ln in enumerate(lines):
        if ln.startswith(pat):
            return i
    return -1


def check_file(path):
    errors, notes = [], []
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")

    h2 = [ln[3:].strip() for ln in lines if ln.startswith("## ")]
    missing = [s for s in SECTIONS if s not in h2]
    if missing:
        errors.append("缺二级标题: " + " / ".join(missing))

    cards, cur = [], None
    for ln in lines:
        m = RE_CARD.match(ln)
        if m:
            cur = {"id": m.group(1), "title": m.group(2).strip(), "lines": []}
            cards.append(cur)
        elif ln.startswith("## ") or ln.startswith("# "):
            cur = None
        elif cur is not None:
            cur["lines"].append(ln)

    if not cards:
        errors.append("没有找到任何阶段卡（### P<n> · 标题）")

    for c in cards:
        cl = c["lines"]
        si = find_key(cl, "状态")
        status = cl[si].split(":", 1)[1].strip() if si >= 0 else ""
        tag = "%s %s" % (c["id"], c["title"])

        if status == "待起草":
            notes.append("%s · 待起草（跳过格式检查）" % tag)
            continue

        for key in ("技术方案", "照抄点", "判据"):
            if find_key(cl, key) < 0:
                errors.append("%s · 缺 `- %s:`" % (tag, key))

        i = find_key(cl, "照抄点")
        if i >= 0:
            body = [x for x in block_after(cl, i) if x.strip().startswith("|")]
            sep = [x for x in body if re.match(r"^\|[\s:\-|]+\|$", x.strip())]
            head = body[0] if body else ""
            if not head:
                errors.append("%s · 照抄点表为空 —— 抄了也验不了，不许抄" % tag)
            else:
                cols = [x.strip() for x in head.strip().strip("|").split("|")]
                lack = [x for x in COLUMNS if x not in cols]
                rows = len(body) - 1 - len(sep)
                if lack:
                    errors.append("%s · 照抄点缺栏: %s" % (tag, " / ".join(lack)))
                if rows < 1:
                    errors.append("%s · 照抄点数据行 0 条（只有表头）" % tag)
                if not lack and rows >= 1:
                    notes.append("%s · 照抄点 %d 行 / 四栏齐" % (tag, rows))

        i = find_key(cl, "判据")
        if i >= 0:
            items = [x.strip()[2:].strip() for x in block_after(cl, i) if x.strip().startswith("- ")]
            if len(items) < 2:
                errors.append("%s · 判据只有 %d 条（要 >= 2）" % (tag, len(items)))
            bad = [x for x in items if not x.startswith(PREFIXES)]
            if bad:
                errors.append("%s · 判据缺前缀（cmd:/str:/num:/file:）: %s"
                              % (tag, bad[0][:40]))
            if not bad and len(items) >= 2:
                notes.append("%s · 判据 %d 条 / 前缀齐" % (tag, len(items)))

    return errors, notes, len(cards)


def main():
    files = sorted(PLAN_DIR.glob("*.md"))
    print("== 作战计划卡机检 ==")
    print("目录: %s" % PLAN_DIR.as_posix())
    if not files:
        print("结果: FAIL —— 一份计划都没有")
        return 1

    total_err = 0
    card_total = 0
    for f in files:
        errs, notes, ncards = check_file(f)
        card_total += ncards
        print("\n-- %s（%d 张阶段卡）" % (f.name, ncards))
        for n in notes:
            print("   ok   " + n)
        for e in errs:
            print("   FAIL " + e)
        total_err += len(errs)

    print("\n结果: %s（%d 个文件 / %d 张卡 / %d 处失败）"
          % ("PASS" if total_err == 0 else "FAIL", len(files), card_total, total_err))
    return 0 if total_err == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
