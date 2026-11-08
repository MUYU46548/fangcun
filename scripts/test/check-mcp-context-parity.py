#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""入口 B（python tegula.py mcp）的只读口 —— 决策 / 方针（含结构地图）/ 作战计划三块。

2026-11-08 暮雨拍板：“开只读口（后续 AI 可写）”。

桌面 MCP 已经有这三件（`e2e-mcp-context.cjs` 在钉），但**入口 B 一件都没有** ——
方寸没开、换机、CI 里它才是唯一入口。这个套件钉三件事：

  ① **真走协议**：用 `core.mcp_handle` 发 tools/call（不是直接调函数）——
     函数写得对、但忘了注册到 MCP_TOOLS/MCP_METHODS，就等于没有入口；
  ② **行为与桌面同语义**：项目/状态/关键词过滤、缺什么点名、概览不带正文；
  ③ **两侧不分叉**：字段名对着 `fixtures/mcp-context-contract.json` 断言 ——
     那张表两侧测试都读，任何一侧改名/丢字段，两侧一起红。

⚠ 临时数据根，不碰真实 task-data。
"""
import json
import os
import shutil
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, REPO)

from tegula import core  # noqa: E402

pass_n = 0
fail_n = 0
failures = []


def check(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("PASS  " + name)
    else:
        fail_n += 1
        failures.append(name + (" :: " + str(detail)[:280] if detail else ""))
        print("FAIL  " + name + ("  → " + str(detail)[:280] if detail else ""))


# ── 临时数据根 ────────────────────────────────────────────────────────
TMP = tempfile.mkdtemp(prefix="fc-mcp-parity-")
DATA = os.path.join(TMP, "data")
TASK = os.path.join(DATA, "task-data")
os.makedirs(os.path.join(TASK, "plans"), exist_ok=True)
os.makedirs(os.path.join(DATA, "policies"), exist_ok=True)

with open(os.path.join(DATA, "registry.yaml"), "w", encoding="utf-8") as f:
    f.write("members: []\nprojects:\n  - id: demo\n    name: 演示项目\n  - id: demo-nomap\n"
            "    name: 缺结构地图\n  - id: demo-skeleton\n    name: 只有骨架\nreleased: []\n")

with open(os.path.join(TASK, "decisions.md"), "w", encoding="utf-8") as f:
    f.write("\n".join([
        "# 决策记录（决策卡）",
        "",
        "## D-001 一期只做索引，不写他人仓库",
        "- 日期: 2026-10-10",
        "- 状态: 有效",
        "- 项目: demo",
        "- 出处: 立项契约 REV-001",
        "",
        "## D-002 备份默认走导出网盘",
        "- 日期: 2026-10-20",
        "- 状态: 有效",
        "- 项目: demo",
        "- 出处: 暮雨 10-20 拍板",
        "- 备注: 密码不落明文",
        "",
        "## D-003 这条已经撤销了",
        "- 日期: 2026-09-01",
        "- 状态: 已撤销",
        "- 项目: demo",
        "- 出处: 旧决定",
        "",
        "## D-004 别的项目的事",
        "- 日期: 2026-11-01",
        "- 状态: 有效",
        "- 项目: other",
        "- 出处: 对照组",
        "",
    ]) + "\n")

with open(os.path.join(DATA, "policies", "demo.md"), "w", encoding="utf-8") as f:
    f.write("\n".join([
        "## 使命",
        "让所有项目有一个统一的活口",
        "## 当前目标",
        "把任务收口做完",
        "## 应用场景",
        "一个人管十几摊",
        "## 方针边界",
        "对项目 repo 只读",
        "## 结构地图",
        "> 最后核实：2026-11-01",
        "",
        "- 模块清单：tegula/ 是 Python CLI；desktop/src/main 是主进程",
        "- 主数据流：task-data/*.md → 主进程解析 → 渲染层 / MCP",
        "",
    ]) + "\n")

with open(os.path.join(DATA, "policies", "demo-nomap.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(["## 使命", "只有正文，没有结构地图", "## 当前目标", "",
                       "## 应用场景", "", "## 方针边界", ""]) + "\n")

with open(os.path.join(DATA, "policies", "demo-skeleton.md"), "w", encoding="utf-8") as f:
    f.write("\n".join([
        "## 使命", "这节是真的有内容",
        "## 当前目标", "把接线做完",
        "## 应用场景", "一个人维护",
        "## 方针边界", "只读别人的仓库",
        "## 结构地图",
        "> 最后核实：（待填 —— 填完写日期；烂地图比没地图危险，因为读者不知道它烂）",
        "",
        "- 模块清单：待填（每模块一句话职责）",
        "- 主数据流：待填（数据从哪来 → 经过谁 → 落到哪 → 谁读它）",
        "",
    ]) + "\n")

with open(os.path.join(TASK, "plans", "demo.md"), "w", encoding="utf-8") as f:
    f.write("\n".join([
        "# 演示项目 · 作战计划",
        "",
        "### P0 · 格式与机检",
        "- 状态: 完成",
        "- 做什么: 把结构定成文件格式",
        "- 技术方案:",
        "  - 用 Markdown + frontmatter",
        "- 照抄点:",
        "  | 抄谁 | 抄什么 |",
        "  |---|---|",
        "  | 旧方寸 | 字段名 |",
        "  | spec-kit | 判据四类 |",
        "  | adr | 决策留痕 |",
        "- 判据:",
        "  - format: 含 `## 要做什么`",
        "  - count: 标题 == 1",
        "",
        "### P1 · 接线",
        "- 状态: 待裁决",
        "- 做什么: 把 MCP 接上",
        "- 技术方案:",
        "  - 只读口先开",
        "- 照抄点:",
        "  | 抄谁 | 抄什么 |",
        "  |---|---|",
        "  | mcp 规范 | 工具命名 |",
        "  | 旧方寸 | bridge |",
        "  | spec-kit | 判据 |",
        "- 判据:",
        "  - cmd: node scripts/test/e2e-mcp-context.cjs",
        "",
        "## 修订记录",
        "- 2026-11-08 开局",
        "",
    ]) + "\n")

core.DATA_DIR = DATA
core.TASK_DIR = TASK
core.DECISIONS_PATH = os.path.join(TASK, "decisions.md")

CONTRACT = json.load(open(os.path.join(REPO, "scripts", "test", "fixtures", "mcp-context-contract.json"),
                          encoding="utf-8"))


def call(name, args=None):
    """真走 JSON-RPC，与客户端同一条路。"""
    resp = core.mcp_handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                            "params": {"name": name, "arguments": args or {}}})
    if "error" in resp:
        return {"__protocolError": resp["error"]}
    return json.loads(resp["result"]["content"][0]["text"])


def has_keys(obj, keys):
    return isinstance(obj, dict) and all(k in obj for k in keys)


print("== ① 注册：真走协议 ===")
names = [t["name"] for t in core.mcp_handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
         ["result"]["tools"]]
check("★★ tools/list 里有只读三件（decision_list / project_charter / stage_plan_get）",
      all(n in names for n in ("decision_list", "project_charter", "stage_plan_get")),
      ",".join(names))
check("★ 三件都在 MCP_METHODS 里（只写 schema 不注册 = 有名字没入口）",
      all(n in core.MCP_METHODS for n in ("decision_list", "project_charter", "stage_plan_get")),
      ",".join(sorted(core.MCP_METHODS)))

print("")
print("== ② 决策 ==")
dec = call("decision_list", {"limit": 50})
check("★★ decision_list 读得到 4 条", dec.get("total") == 4 and len(dec.get("decisions", [])) == 4,
      json.dumps(dec, ensure_ascii=False))
check("★★ 最新在前（文件按时间追加，读者要的是最近定了什么）",
      (dec.get("decisions") or [{}])[0].get("id") == "D-004",
      [d.get("id") for d in dec.get("decisions", [])])

dec_p = call("decision_list", {"project": "demo"})
check("★★ 按项目过滤真生效", len(dec_p.get("decisions", [])) == 3
      and all(d.get("项目") == "demo" for d in dec_p.get("decisions", [])),
      [d.get("id") + "@" + str(d.get("项目")) for d in dec_p.get("decisions", [])])

dec_v = call("decision_list", {"project": "demo", "status": "有效"})
check("★★ 按状态过滤真生效（已撤销的不算已定过）", len(dec_v.get("decisions", [])) == 2
      and all(d.get("状态") == "有效" for d in dec_v.get("decisions", [])),
      [d.get("id") + "/" + str(d.get("状态")) for d in dec_v.get("decisions", [])])

dec_old = call("decision_list", {"status": "已作废"})
check("★ 老状态词归一（已作废 → 已撤销）", len(dec_old.get("decisions", [])) == 1
      and dec_old["decisions"][0]["id"] == "D-003",
      [d.get("id") + "/" + str(d.get("状态")) for d in dec_old.get("decisions", [])])

dec_q = call("decision_list", {"query": "网盘"})
check("★ 关键词命中（内容/备注/出处）", len(dec_q.get("decisions", [])) == 1
      and dec_q["decisions"][0]["id"] == "D-002",
      [d.get("id") for d in dec_q.get("decisions", [])])

dec_lim = call("decision_list", {"limit": 2})
check("  条数上限生效", len(dec_lim.get("decisions", [])) == 2 and dec_lim.get("total") == 4,
      json.dumps({"n": len(dec_lim.get("decisions", [])), "total": dec_lim.get("total")}))
check("★★ 返回体写明只读", "只读" in str(dec.get("readOnly", "")), str(dec.get("readOnly")))
check("★★★ 契约：决策信封与条目键齐全（两侧同键，防分叉）",
      has_keys(dec, CONTRACT["decision_envelope"])
      and all(has_keys(d, CONTRACT["decision_keys"]) for d in dec.get("decisions", [])),
      "缺：" + str([k for k in CONTRACT["decision_envelope"] if k not in dec]))

print("")
print("== ③ 方针 / 结构地图 ==")
ch = call("project_charter", {"project": "demo"})
check("★★ 五节读得到", ch.get("ok") is True and "统一的活口" in ch.get("mission", "")
      and "只读" in ch.get("boundary", ""), json.dumps({k: ch.get(k) for k in ("ok", "mission", "boundary")},
                                                       ensure_ascii=False))
check("★★★ 结构地图读得到（模块清单 + 主数据流）",
      "主数据流" in ch.get("structureMap", "") and "模块清单" in ch.get("structureMap", ""),
      ch.get("structureMap", "")[:120])
check("★ 五节齐全时 missingSections 为空",
      ch.get("missingSections") == [], ch.get("missingSections"))
check("★★ 结构地图时效算成天数", isinstance(ch.get("structureMapAgeDays"), int)
      and ch["structureMapAgeDays"] >= 0,
      json.dumps({"at": ch.get("structureMapVerifiedAt"), "days": ch.get("structureMapAgeDays")}))
check("★ 刚核过的不算 stale", ch.get("structureMapStale") is False,
      json.dumps({"stale": ch.get("structureMapStale"), "days": ch.get("structureMapAgeDays")}))

no_ch = call("project_charter", {"project": "demo-nocharter"})
check("★★★ 没方针的项目明确报错（不返回空对象冒充干净）", no_ch.get("ok") is False
      and "没有方针卡" in str(no_ch.get("error")), json.dumps(no_ch, ensure_ascii=False)[:200])

no_map = call("project_charter", {"project": "demo-nomap"})
check("★★★ 有方针但缺结构地图 → 进 missingSections",
      "结构地图" in (no_map.get("missingSections") or []), no_map.get("missingSections"))
check("★★ 没有“最后核实”日期 → stale",
      no_map.get("structureMapStale") is True, json.dumps({"stale": no_map.get("structureMapStale")}))

skel = call("project_charter", {"project": "demo-skeleton"})
check("★★★ 结构地图只剩“待填”骨架 → 仍算缺（占位符不许当内容）",
      "结构地图" in (skel.get("missingSections") or []), skel.get("missingSections"))
check("★ 骨架反例的另一面：其余四节真有内容 → 不许跟着报缺",
      len(skel.get("missingSections") or []) == 1, skel.get("missingSections"))
check("★★ 骨架里的“（待填”不算日期 → 同样 stale",
      skel.get("structureMapStale") is True, json.dumps({"stale": skel.get("structureMapStale")}))
check("★★★ 契约：方针信封键齐全",
      has_keys(ch, CONTRACT["charter_envelope"]),
      "缺：" + str([k for k in CONTRACT["charter_envelope"] if k not in ch]))

print("")
print("== ④ 作战计划三块 ==")
ov = call("stage_plan_get", {})
check("★★ 不给 file 只给概览（2 格 / 1 待裁决 / 1 完成）",
      ov.get("files") == 1 and ov["plans"][0]["stages"] == 2
      and ov["plans"][0]["pending"] == 1 and ov["plans"][0]["done"] == 1,
      json.dumps(ov.get("plans", []), ensure_ascii=False))
check("★ 概览里不带正文（几十格正文会把 token 烧光）",
      "用 Markdown + frontmatter" not in json.dumps(ov, ensure_ascii=False),
      json.dumps(ov, ensure_ascii=False)[:160])

one = call("stage_plan_get", {"file": "demo.md", "stageId": "P1"})
st = (one.get("stages") or [{}])[0]
check("★★ 带 file + stageId 拿到那一格", one.get("ok") is True and st.get("id") == "P1",
      json.dumps([s.get("id") for s in one.get("stages", [])]))
check("★★★ 三块正文都在（技术方案 / 照抄点 / 判据）",
      len(st.get("approach") or []) >= 1 and len(st.get("copyRows") or []) >= 3
      and len(st.get("criteria") or []) >= 1 and "cmd:" in (st.get("criteria") or [""])[0],
      json.dumps(st, ensure_ascii=False)[:240])
check("★ 状态一起给", st.get("status") == "待裁决", st.get("status"))
check("★ 缺块登记为空（三块齐全）", st.get("missing") == [], st.get("missing"))
check("★ 修订记录可读", len(one.get("revision") or []) >= 1, one.get("revision"))
check("★★★ 契约：阶段信封与阶段键齐全",
      has_keys(one, CONTRACT["stage_envelope"]) and has_keys(st, CONTRACT["stage_keys"]),
      "缺：" + str([k for k in CONTRACT["stage_keys"] if k not in st]))

miss = call("stage_plan_get", {"file": "demo.md", "stageId": "P9"})
check("★★ 不存在的阶段明确报错并列出真实 id",
      miss.get("ok") is False and "P0" in str(miss.get("stages")) and "P1" in str(miss.get("stages")),
      json.dumps(miss, ensure_ascii=False)[:200])
nofile = call("stage_plan_get", {"file": "nope.md"})
check("  计划卡不存在时报错", nofile.get("ok") is False, json.dumps(nofile, ensure_ascii=False)[:160])

print("")
print("== ⑤ 只读：源码不许有写入 ==")
src = open(os.path.join(REPO, "tegula", "core.py"), encoding="utf-8").read()


def slice_fn(name):
    i = src.find("def " + name + "(")
    if i < 0:
        return ""
    j = src.find("\ndef ", i + 5)
    return src[i:j if j > 0 else len(src)]


WRITE_FNS = ["write_plan_verdict", "advance_stage", "save_policy", "decision_add",
             "decision_set_status", "save_decisions", "atomic_write", "open("]
for fn_name in ("mcp_decision_list", "mcp_project_charter", "mcp_stage_plan_get"):
    body = slice_fn(fn_name)
    hit = [w for w in WRITE_FNS if w in body]
    check("★★ 源码守卫：%s 里没有任何写入调用（读口现在真的是只读）" % fn_name,
          bool(body) and not hit, ",".join(hit) or "clean")

shutil.rmtree(TMP, ignore_errors=True)
print("")
if failures:
    print("失败明细：")
    for x in failures:
        print("  · " + x)
print("RESULT %d / %d" % (pass_n, fail_n))
sys.exit(1 if fail_n else 0)
