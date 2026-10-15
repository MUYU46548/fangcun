# -*- coding: utf-8 -*-
"""把 decisions.md 的老三态迁成白话三态（2026-10-14 暮雨「说中文」）。

老值：作数 / 已作废 / 已并入
新值：有效 / 已撤销 / 已合并

行为：
  · 默认 **dry-run**（只报会改什么，不写盘）；加 --apply 才真写。
  · 写前先备份到 <repo>/backups/decisions.md.bak-YYYYMMDD-HHMMSS。
  · 走 core.load_decisions / core.save_decisions —— 与两端同一套解析/渲染，
    所以顺带把节式头也更新成新版措辞。
  · 幂等：已经迁过的文件再跑，报告「0 处改动」。

用法：
  python scripts/migrate-decision-status.py            # 预览
  python scripts/migrate-decision-status.py --apply    # 执行
"""
import os
import shutil
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import tegula.core as core

REPO = HERE
TASK_DATA = os.path.join(REPO, "task-data")
BACKUPS = os.path.join(REPO, "backups")
DEC_PATH = os.path.join(TASK_DATA, "decisions.md")

OLD = {"作数", "已作废", "已并入"}


def main():
    apply = "--apply" in sys.argv

    if not os.path.exists(DEC_PATH):
        print(f"没有 {DEC_PATH}，无需迁移。")
        return 0

    with open(DEC_PATH, encoding="utf-8") as f:
        before = f.read()

    # 指向真实文件（core 的路径常量是 import 时算的）
    core.TASK_DIR = TASK_DATA
    core.DECISIONS_PATH = DEC_PATH

    old_lines = [ln for ln in before.splitlines() if any(f"状态: {o}" in ln for o in OLD)]
    items = core.load_decisions()
    print(f"文件：{DEC_PATH}")
    print(f"条目：{len(items)} 条；命中老值的状态行：{len(old_lines)} 行")
    for ln in old_lines:
        print("  · " + ln.strip())

    # 渲染一份"迁移后"的文本做对比（不落盘）——与写盘走同一个 _render_decisions
    after_render = core._render_decisions(items)
    if after_render == before:
        print("\n已经是新写法，0 处改动（幂等）。")
        return 0

    print(f"\n迁移后：{len(items)} 条，全部为 有效/已撤销/已合并；节式头同步更新。")
    if not apply:
        print("（dry-run，未写盘。加 --apply 执行）")
        return 0

    os.makedirs(BACKUPS, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = os.path.join(BACKUPS, f"decisions.md.bak-{stamp}")
    shutil.copy2(DEC_PATH, bak)
    print(f"已备份：{bak}")

    core.save_decisions(items)
    with open(DEC_PATH, encoding="utf-8") as f:
        after = f.read()
    left = [ln for ln in after.splitlines() if any(f"状态: {o}" in ln for o in OLD)]
    print(f"写入完成。残留老值状态行：{len(left)}（应为 0）")
    return 1 if left else 0


if __name__ == "__main__":
    sys.exit(main())
