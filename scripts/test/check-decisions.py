# -*- coding: utf-8 -*-
"""决策卡（拍板记录）CLI/core 回归——AI 规划包第 3 件。

隔离：monkeypatch core.TASK_DIR 指向临时目录（check-writeback 同模式），
不碰真实 task-data/；零网络零 LLM。

覆盖：
  1. add → list 全链（id 递增、状态默认作数、出处带出）
  2. 幂等：同内容+同日期重复 add 返回已有 id，不新增
  3. set 改状态（作数→已作废/已并入）+ 备注追加不覆盖
  4. 状态白名单：非法状态被拒（core 层）
  5. 文件格式：decisions.md 节式结构可 round-trip（写→读→一致）
  6. 空内容被拒
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, HERE)

import tegula.core as core

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def main():
    tmp = tempfile.mkdtemp(prefix="fc-dec-test-")
    core.TASK_DIR = os.path.join(tmp, "task-data")
    # DECISIONS_PATH 是 import 时常量，跟着 TASK_DIR 重定位
    core.DECISIONS_PATH = os.path.join(core.TASK_DIR, "decisions.md")
    os.makedirs(core.TASK_DIR, exist_ok=True)

    print("== add/list 基本链 ==")
    ok, d1 = core.decision_add("司天不发版，唯一目标=标注+导出真图", 日期="2026-10-11", 出处="10-11 09:42 四答定调②")
    check("首条 add 成功", ok and d1 == "D-001", f"got {d1}")
    ok, d2 = core.decision_add("启动台等 10-14 裁决", 日期="2026-09-14")
    check("第二条 id 递增", ok and d2 == "D-002", f"got {d2}")
    items = core.load_decisions()
    check("list 两条", len(items) == 2, f"got {len(items)}")
    check("排序按日期（旧在前）", items[0]["id"] == "D-002" and items[1]["id"] == "D-001")
    check("状态默认作数", all(i["状态"] == "作数" for i in items))

    print("== 幂等 ==")
    ok, dup = core.decision_add("司天不发版，唯一目标=标注+导出真图", 日期="2026-10-11")
    check("重复 add 返回已有 id", ok and dup.startswith("D-001"), f"got {dup}")
    check("未新增条目", len(core.load_decisions()) == 2)

    print("== set 状态与备注 ==")
    ok, r = core.decision_set_status("D-001", "已作废", 备注="被 10-12 D-003 取代")
    check("set 作数→已作废", ok, r)
    ok, r = core.decision_set_status("D-002", "已并入", 备注="并入方寸包")
    check("set 已并入", ok, r)
    items = {i["id"]: i for i in core.load_decisions()}
    check("状态已落盘", items["D-001"]["状态"] == "已作废" and items["D-002"]["状态"] == "已并入")
    ok, r = core.decision_set_status("D-001", "作数", 备注="第二条备注")
    items = {i["id"]: i for i in core.load_decisions()}
    check("备注追加不覆盖", "第二条备注" in items["D-001"]["备注"] and "被 10-12 D-003 取代" in items["D-001"]["备注"])

    print("== 校验防线 ==")
    ok, r = core.decision_add("x", 状态="不存在的状态")
    check("非法状态被拒", not ok, r)
    ok, r = core.decision_add("   ")
    check("空内容被拒", not ok, r)
    ok, r = core.decision_set_status("D-999", "已作废")
    check("改不存在的卡被拒", not ok, r)

    print("== 文件 round-trip ==")
    with open(core.DECISIONS_PATH, encoding="utf-8") as f:
        text = f.read()
    check("节式头存在", text.startswith("# 拍板记录"))
    check("每节含四字段骨架", "- 日期:" in text and "- 状态:" in text and "- 出处:" in text)
    rt = core.load_decisions()
    check("round-trip 条数一致", len(rt) == 2)
    check("round-trip 内容不丢", any(i["内容"] == "启动台等 10-14 裁决" for i in rt))

    print(f"\n通过 {PASS} / 失败 {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
