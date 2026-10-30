#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""返工卡取活（tegula next）回归 —— 2026-10-30 暮雨第 3 条

用户原话：「我原意是 AI 会读驳回里的任务自己重做，现在感觉就是个大号待办。」
真因不是 UI，而是 agent 面入口 `next` 只打印标题/优先级，从来没把驳回理由交给 agent。

这个脚本真跑 `tegula.cli`（临时 task-data），钉四件事：
  ① 返工卡能被认出来（独立字段 / 老卡只写在结果记录里都能认）；
  ② `next` 把返工卡排在最前（不会先被普通待办淹没）；
  ③ 文本输出把「驳回理由 + 返工要求」顶在状态下面；
  ④ JSON 输出带 `rework.is_rework / reason`，agent 可以直接判。

跑法：python scripts/test/check-next-rework.py
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="tegula_next_rework_")
TASKS = os.path.join(TMP, "task-data")
os.makedirs(TASKS, exist_ok=True)

from tegula import core as C  # noqa: E402
from tegula import cli as CLI  # noqa: E402

C.TASK_DIR = TASKS
CLI.TASK_DIR = TASKS

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        FAILURES.append(name + (f" :: {detail}" if detail else ""))
        print(f"FAIL  {name}  -> {detail}")


def mk_task(tid, title, status="待办", priority="低", reject_reason=None, reject_at=None, result_log=""):
    lines = [
        "---",
        f"id: {tid}",
        f"标题: {title}",
        "项目: [fangcun-base]",
        f"状态: {status}",
        f"优先级: {priority}",
        "更新: 2026-10-30T09:00:00+08:00",
    ]
    if reject_reason:
        lines.append(f"reject_reason: {reject_reason}")
    if reject_at:
        lines.append(f"reject_at: {reject_at}")
    if result_log:
        lines.append(f'结果记录: "{result_log}"')
    lines += ["---", "## 方案", "- [ ] 做", ""]
    with open(os.path.join(TASKS, tid + ".md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main():
    # 普通卡优先级「高」，返工卡「低」—— 排序必须把返工卡顶上来，不能只比优先级。
    mk_task("task-normal", "普通待办", priority="高")
    mk_task("task-rework", "返工卡：按钮点不动", priority="低",
            reject_reason="按钮点不动，先修交互再交",
            reject_at="2026-10-29T10:00:00.000Z")
    mk_task("task-rework-old", "老返工卡：只写在结果记录里", status="进行中", priority="中",
            result_log="[2026-10-29 10:00] 验收驳回：文案看不懂，重写")

    tasks = CLI.load_tasks(None, "active")
    by_id = {t.get("id"): t for t in tasks}
    check("独立字段能认出返工卡",
          CLI._task_is_rework(by_id["task-rework"]),
          str(by_id.get("task-rework")))
    check("老卡只写在结果记录里也能认",
          CLI._task_is_rework(by_id["task-rework-old"]),
          str(by_id.get("task-rework-old")))
    check("普通卡不被误判为返工",
          not CLI._task_is_rework(by_id["task-normal"]))
    check("理由取独立字段",
          CLI._task_rework_reason(by_id["task-rework"]) == "按钮点不动，先修交互再交")
    check("老卡理由从结果记录里取最后一条驳回",
          CLI._task_rework_reason(by_id["task-rework-old"]) == "文案看不懂，重写")

    picked = CLI._pick_next(tasks)
    check("★★ 返工卡排在普通高优先级待办前面",
          picked and picked[0].get("id") in ("task-rework", "task-rework-old"),
          [t.get("id") for t in picked])

    ns = type("Args", (), {"format": "text", "project": None, "claim": ""})()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        CLI.cmd_next(ns)
    text = buf.getvalue()
    check("★★ 文本输出标出「返工」", "返工    : 是" in text, text[:160].replace("\n", " | "))
    check("★★ 文本输出带驳回理由", "驳回理由: 按钮点不动，先修交互再交" in text, text[:300].replace("\n", " | "))
    check("文本输出带返工要求（不许原样重交）", "返工要求:" in text and "原方案原样重交" in text)

    ns2 = type("Args", (), {"format": "json", "project": None, "claim": ""})()
    buf2 = io.StringIO()
    with contextlib.redirect_stdout(buf2):
        CLI.cmd_next(ns2)
    data = json.loads(buf2.getvalue())
    check("JSON 输出带 rework.is_rework", data.get("rework", {}).get("is_rework") is True,
          json.dumps(data.get("rework"), ensure_ascii=False))
    check("JSON 输出带 rework.reason",
          "按钮点不动" in str(data.get("rework", {}).get("reason", "")),
          json.dumps(data.get("rework"), ensure_ascii=False))
    check("候选列表也标了返工", any(c.get("返工") for c in data.get("candidates", [])),
          json.dumps(data.get("candidates"), ensure_ascii=False)[:220])

    # 没写理由的返工卡：不能假装普通待办，要明说「当时没写」并让 agent 先问清楚。
    mk_task("task-rework-empty", "返工卡：当时没写理由", reject_at="2026-10-29T10:00:00.000Z")
    t2 = {t.get("id"): t for t in CLI.load_tasks(None, "active")}
    check("空理由仍算返工（有驳回时间）", CLI._task_is_rework(t2["task-rework-empty"]))
    check("空理由不编一个假理由", CLI._task_rework_reason(t2["task-rework-empty"]) == "")

    print(f"\nRESULT {PASS} / {FAIL}")
    if FAIL:
        print("\n失败项：")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
