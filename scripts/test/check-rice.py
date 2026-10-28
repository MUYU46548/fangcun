# -*- coding: utf-8 -*-
"""需求矩阵（RICE）Python 腿回归 —— 2026-10-28

隔离：monkeypatch core.TASK_DIR / core.RICE_POOL_PATH 指向临时目录（check-decisions 同模式），
不碰真实 task-data/；零网络零 LLM。

覆盖：
  1. 节式解析（四维原始分 / 多行备注 / 未知字段 / 坏数字原文 / 拍板 / 决策id / 预算）
  2. 渲染 → 再解析 round-trip 稳定（含多行备注与未知字段）
  3. 数字渲染与 TS `String(number)` 对齐（整数不带 .0 —— 否则双腿写回分叉）
  4. 评分（RICE = R×I×C÷E）与等级（池内相对位置，CUT 恒 CUT）、预算未设置不说成 0%
  5. **双腿对账**：Python 渲染出的文件交给编译产物 `desktop/dist/shared/rice.js` 解析并重渲染，
     逐字节与 Python 文件一致（node 不可用时明确 SKIP，不假装通过）
  6. TS 与 Python 的取值域 / 证据映射逐字一致（单一来源判据）
  7. 只读 CLI `tegula rice --json` 能跑通（写口只在桌面端 MCP）
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from types import SimpleNamespace

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, HERE)

import tegula.core as core  # noqa: E402

PASS = 0
FAIL = 0
SKIP = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


SAMPLE = """# 需求矩阵评估池（RICE）

> 四个原始分在这里，总分由页签现算（不落盘）。口径见 docs/ADR-002-需求矩阵.md。
> 月预算（元）: 500

## rice-task-T-042 关窗行为开关
- 标题: 设置页加「关窗行为」开关（默认真退出）
- 来源: task:task-T-042
- R: 5
- I: 1
- C: 0.85
- E天: 2
- E元: 0
- 证据: 实测踩过
- 打分: 全栈 2026-10-24
- 备注: 病灶 A1
第二行备注
- 拍板:
- 决策id:
- 自定义列: 值A

## rice-ext-x1 外部清单条目
- 标题: 外部条目
- 来源: external:code-audit-1
- R: 2
- I: 0.5
- C: abc
- E天: 1.5
- E元: 12
- 证据: agent推断
- 打分: 全栈 2026-10-25
- 备注: 手改坏数字
- 拍板: CUT
- 决策id: D-009

"""

REPO = HERE
DIST_RICE = os.path.join(REPO, "desktop", "dist", "shared", "rice.js")


def main():
    global PASS, FAIL, SKIP
    tmp = tempfile.mkdtemp(prefix="fc-rice-")
    core.TASK_DIR = os.path.join(tmp, "task-data")
    core.RICE_POOL_PATH = os.path.join(core.TASK_DIR, "rice-pool.md")
    os.makedirs(core.TASK_DIR, exist_ok=True)

    print("== 1. 解析（节式 / 多行 / 未知字段 / 坏数字原文）==")
    with open(core.RICE_POOL_PATH, "w", encoding="utf-8") as f:
        f.write(SAMPLE)
    pool = core.load_rice_pool()
    check("预算读到 500", pool["budget"] == 500)
    check("两条条目", len(pool["items"]) == 2, str(len(pool["items"])))
    a = pool["items"][0]
    check("四维原始分", (a["R"], a["I"], a["C"], a["E_days"]) == (5.0, 1.0, 0.85, 2.0), str([a["R"], a["I"], a["C"], a["E_days"]]))
    check("证据 / 打分 / 拍板空", a["evidence"] == "实测踩过" and a["by"] == "全栈 2026-10-24" and a["verdict"] == "")
    check("多行备注拼回上一字段", "病灶 A1" in a["note"] and "第二行备注" in a["note"], repr(a["note"]))
    check("未知字段进 extra（不丢）", any(x["k"] == "自定义列" and x["v"] == "值A" for x in a.get("extra", [])), str(a.get("extra")))
    b = pool["items"][1]
    check("★ 坏数字原文进 raw（不静默清空）", (b.get("raw") or {}).get("C") == "abc", str(b.get("raw")))
    check("CUT / 决策id 读对", b["verdict"] == "CUT" and b["decision_id"] == "D-009")

    print("== 2. 渲染 round-trip ==")
    text1 = core._render_rice_pool(pool)
    check("渲染含月预算行", "月预算（元）: 500" in text1)
    check("数字渲染整数不带 .0（对齐 TS String）", "- R: 5\n" in text1 and "- E天: 2\n" in text1, text1.replace("\n", "|")[:200])
    with open(core.RICE_POOL_PATH + ".out", "w", encoding="utf-8") as f:
        f.write(text1)
    saved = core.RICE_POOL_PATH
    core.RICE_POOL_PATH = saved + ".out"
    pool2 = core.load_rice_pool()
    core.RICE_POOL_PATH = saved
    check("round-trip 条数 / 值不变", len(pool2["items"]) == 2 and pool2["items"][0]["note"] == a["note"])
    check("round-trip 未知字段不丢", any(x["k"] == "自定义列" for x in pool2["items"][0].get("extra", [])))
    check("round-trip 坏数字原文不丢", (pool2["items"][1].get("raw") or {}).get("C") == "abc")
    check("★ 二次渲染逐字节稳定", core._render_rice_pool(pool2) == text1)

    print("== 3. 评分 / 等级 / 汇总 ==")
    check("RICE = 5×1×0.85÷2 = 2.13", core.rice_score(a) == 2.13, str(core.rice_score(a)))
    check("E 非正 → None", core.rice_score({"R": 1, "I": 1, "C": 1, "E_days": 0}) is None)
    items = [
        {"eid": "a", "R": 10, "I": 3, "C": 0.95, "E_days": 1},
        {"eid": "b", "R": 5, "I": 1, "C": 0.85, "E_days": 2},
        {"eid": "c", "R": 2, "I": 0.5, "C": 0.6, "E_days": 3},
        {"eid": "d", "R": 1, "I": 1, "C": 0.7, "E_days": 1, "verdict": "CUT"},
    ]
    lv = core.rice_levels(items)
    check("3 条可算 → P0/P1/P2 各一档", lv["a"] == "P0" and lv["b"] == "P1" and lv["c"] == "P2", str(lv))
    check("★ CUT 恒 CUT（分再高也不进 P0）", lv["d"] == "CUT")
    s0 = core.rice_summary({"budget": 0, "items": [items[1]]})
    check("★ 预算未设置 → 明说未设置，不说 0%", "未设置" in s0, s0)
    s1 = core.rice_summary({"budget": 100, "items": [{**items[0], "E_cost": 10}]})
    check("预算设置 → P0 花费/占比", "P0 花费 ¥10" in s1 and "10%" in s1, s1)

    print("== 4. 双腿对账（Python 渲染 → TS 解析/重渲染）==")
    node = shutil.which("node")
    if not node or not os.path.exists(DIST_RICE):
        SKIP += 1
        print("  SKIP 未找到 node 或编译产物（先 cd desktop && npm run build）")
    else:
        pyfile = os.path.join(tmp, "py-rendered.md")
        with open(pyfile, "w", encoding="utf-8") as f:
            f.write(text1)
        script = os.path.join(tmp, "_ts.cjs")
        with open(script, "w", encoding="utf-8") as f:
            f.write(
                "const fs=require('fs');const R=require(process.argv[2]);\n"
                "const t=fs.readFileSync(process.argv[3],'utf8');const p=R.parseRicePool(t);\n"
                "process.stdout.write(JSON.stringify({items:p.items.length,budget:p.budget,"
                "note:p.items[0]&&p.items[0].note,raw:(p.items[1]&&p.items[1].raw)||{},"
                "extra:(p.items[0]&&p.items[0].extra)||[],render:R.renderRicePool(p)}));\n"
            )
        try:
            proc = subprocess.run([node, script, DIST_RICE, pyfile], capture_output=True, timeout=120)
            out = json.loads(proc.stdout.decode("utf-8") or "{}")
        except Exception as e:  # noqa: BLE001
            out = {}
            print("  !! TS 侧调用失败:", e)
        check("TS 能解析 Python 渲染的文件（条数/预算）", out.get("items") == 2 and out.get("budget") == 500, str(out)[:200])
        check("TS 读到同一段多行备注", out.get("note") == a["note"], repr(out.get("note")))
        check("TS 读到坏数字原文", (out.get("raw") or {}).get("C") == "abc", str(out.get("raw")))
        check("TS 读到未知字段", any(x.get("k") == "自定义列" for x in out.get("extra", [])))
        check("★★ TS 重渲染与 Python 文件逐字节一致", out.get("render") == text1,
              "差异处：" + str([(i, x, y) for i, (x, y) in enumerate(zip(str(out.get("render", "")), text1)) if x != y][:3]))

    print("== 5. 两侧取值域 / 证据映射逐字一致 ==")
    ts_src_path = os.path.join(REPO, "desktop", "src", "shared", "rice.ts")
    try:
        ts_src = open(ts_src_path, encoding="utf-8").read()
    except OSError as e:
        ts_src = ""
        check("能读到 TS 纯逻辑文件", False, str(e))
    if ts_src:
        m = re.search(r"RICE_IMPACT_VALUES\s*=\s*\[([^\]]*)\]", ts_src)
        ts_impact = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", m.group(1))] if m else []
        check("★ I 五档逐字一致", ts_impact == list(core.RICE_IMPACT_VALUES), f"ts={ts_impact} py={list(core.RICE_IMPACT_VALUES)}")
        m = re.search(r"RICE_CONFIDENCE_VALUES\s*=\s*\[([^\]]*)\]", ts_src)
        ts_conf = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", m.group(1))] if m else []
        check("★ C 四档逐字一致", ts_conf == list(core.RICE_CONFIDENCE_VALUES), f"ts={ts_conf} py={list(core.RICE_CONFIDENCE_VALUES)}")
        m = re.search(r"RICE_EVIDENCE_TO_C[^=]*=\s*\{([^}]*)\}", ts_src, re.S)
        ts_ev = dict(re.findall(r"([\u4e00-\u9fa5A-Za-z]+)\s*:\s*([0-9.]+)", m.group(1))) if m else {}
        ts_ev_f = {k: float(v) for k, v in ts_ev.items()}
        check("★ 证据→C 映射逐字一致", ts_ev_f == dict(core.RICE_EVIDENCE_TO_C), f"ts={ts_ev_f} py={dict(core.RICE_EVIDENCE_TO_C)}")
        check("两侧池文件名一致（rice-pool.md）", "rice-pool.md" in ts_src and os.path.basename(core.RICE_POOL_PATH) == "rice-pool.md")

    print("== 6. 只读 CLI ==")
    import tegula.cli as cli
    cli.RICE_POOL_PATH = core.RICE_POOL_PATH
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = cli.cmd_rice(SimpleNamespace(level="", json=True))
    try:
        j = json.loads(buf.getvalue())
    except Exception:  # noqa: BLE001
        j = {}
    check("tegula rice --json 返回 0", rc == 0)
    check("JSON 里有条目 + 现算分数 + 等级", len(j.get("items", [])) == 2 and j["items"][0].get("score") is not None and j["items"][0].get("level") in ("P0", "P1", "P2", "CUT"), str(j)[:200])
    buf2 = io.StringIO()
    with redirect_stdout(buf2):
        rc2 = cli.cmd_rice(SimpleNamespace(level="", json=False))
    check("人类可读输出能跑通并带汇总", rc2 == 0 and "需求矩阵 ·" in buf2.getvalue(), buf2.getvalue()[:120])
    empty_path = os.path.join(tmp, "no-pool.md")
    core.RICE_POOL_PATH = empty_path
    cli.RICE_POOL_PATH = empty_path
    buf3 = io.StringIO()
    with redirect_stdout(buf3):
        rc3 = cli.cmd_rice(SimpleNamespace(level="", json=False))
    check("空池文案显式说没有（不白屏、不说 0 条了事）", rc3 == 0 and "池里还没有条目" in buf3.getvalue(), buf3.getvalue()[:120])

    print(f"\n通过 {PASS} / 失败 {FAIL}" + (f" / 跳过 {SKIP}" if SKIP else ""))
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
