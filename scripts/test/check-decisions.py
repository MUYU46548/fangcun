# -*- coding: utf-8 -*-
"""决策卡 CLI/core 回归——AI 规划包第 3 件。

隔离：monkeypatch core.TASK_DIR 指向临时目录（check-writeback 同模式），
不碰真实 task-data/；零网络零 LLM。

覆盖：
  1. add → list 全链（id 递增、状态默认有效、出处带出）
  2. 幂等：同内容+同日期重复 add 返回已有 id，不新增
  3. set 改状态（有效→已撤销/已合并）+ 备注追加不覆盖
  4. 状态白名单：非法状态被拒（core 层）；**老值入参被接受并归一新**
  5. 文件格式：decisions.md 节式结构可 round-trip（写→读→一致）
  6. 空内容被拒
  7. 白话三态（2026-10-14）：老文件（作数/已作废/已并入）读取即归一；
     且 **TS 与 Python 两侧枚举/别名表逐字一致**（单一来源判据）
"""
import os
import re
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
    check("状态默认有效", all(i["状态"] == "有效" for i in items))

    print("== 幂等 ==")
    ok, dup = core.decision_add("司天不发版，唯一目标=标注+导出真图", 日期="2026-10-11")
    check("重复 add 返回已有 id", ok and dup.startswith("D-001"), f"got {dup}")
    check("未新增条目", len(core.load_decisions()) == 2)

    print("== set 状态与备注 ==")
    ok, r = core.decision_set_status("D-001", "已撤销", 备注="被 10-12 D-003 取代")
    check("set 有效→已撤销", ok, r)
    ok, r = core.decision_set_status("D-002", "已合并", 备注="并入方寸包")
    check("set 已合并", ok, r)
    items = {i["id"]: i for i in core.load_decisions()}
    check("状态已落盘", items["D-001"]["状态"] == "已撤销" and items["D-002"]["状态"] == "已合并")
    ok, r = core.decision_set_status("D-001", "有效", 备注="第二条备注")
    items = {i["id"]: i for i in core.load_decisions()}
    check("备注追加不覆盖", "第二条备注" in items["D-001"]["备注"] and "被 10-12 D-003 取代" in items["D-001"]["备注"])

    print("== 校验防线 ==")
    ok, r = core.decision_add("x", 状态="不存在的状态")
    check("非法状态被拒", not ok, r)
    ok, r = core.decision_add("   ")
    check("空内容被拒", not ok, r)
    ok, r = core.decision_set_status("D-999", "已撤销")
    check("改不存在的卡被拒", not ok, r)

    print("== 白话三态（2026-10-14）：老值入参归一 ==")
    ok, d5 = core.decision_add("老写法入参兼容", 日期="2026-10-13", 状态="作数")
    check("add 收老值『作数』且落新值『有效』", ok, str(d5))
    ok, r = core.decision_set_status("D-002", "已并入")
    items = {i["id"]: i for i in core.load_decisions()}
    check("set 收老值『已并入』→ 归一为『已合并』", ok and items["D-002"]["状态"] == "已合并", r)
    with open(core.DECISIONS_PATH, encoding="utf-8") as f:
        _txt = f.read()
    check("磁盘上不再出现老值『作数/已作废/已并入』",
          not re.search(r"状态:\s*(作数|已作废|已并入)\s*$", _txt, re.M))

    print("== 文件 round-trip ==")
    with open(core.DECISIONS_PATH, encoding="utf-8") as f:
        text = f.read()
    check("节式头存在", text.startswith("# 决策记录"))
    check("每节含四字段骨架", "- 日期:" in text and "- 状态:" in text and "- 出处:" in text)
    rt = core.load_decisions()
    check("round-trip 条数一致", len(rt) == 3)
    check("round-trip 内容不丢", any(i["内容"] == "启动台等 10-14 裁决" for i in rt))

    print("== 项目字段（13-55 梅林补：防一锅粥） ==")
    ok, d3 = core.decision_add("墨坊模板定制开工", 日期="2026-10-11", 项目="绒花墨坊", 出处="台账 #1")
    check("add 带 项目 成功", ok, str(d3))
    items = core.load_decisions()
    check("项目已落盘", any((i.get("项目") == "绒花墨坊") for i in items))
    check("旧条目无项目可兼容", all("项目" in i for i in items) and any(not i.get("项目") for i in items))
    # 手写文件带项目 + **老写法状态** → 解析回读（模拟哨兵灌料形态 + 存量老文件）
    with open(core.DECISIONS_PATH, "a", encoding="utf-8") as f:
        f.write("## D-099 司天发版=否\n- 日期: 2026-10-11\n- 状态: 作数\n- 项目: 司天\n- 出处: 四答定调②\n\n")
    items = core.load_decisions()
    check("手写灌料项目可解析", any(i.get("id") == "D-099" and i.get("项目") == "司天" for i in items))
    check("★ 老文件里的『作数』读取即归一为『有效』",
          any(i.get("id") == "D-099" and i.get("状态") == "有效" for i in items),
          str([i for i in items if i.get("id") == "D-099"]))
    # set 状态重写文件后项目不丢（往返保真——防桌面端改状态把灌入列洗掉）
    core.decision_set_status("D-099", "已撤销")
    items = core.load_decisions()
    check("改状态后项目不丢", any(i.get("id") == "D-099" and i.get("项目") == "司天" and i["状态"] == "已撤销" for i in items))
    with open(core.DECISIONS_PATH, encoding="utf-8") as f:
        text = f.read()
    check("文件含项目行", "- 项目: 司天" in text)

    print("== 决策归属三种写法（2026-11-23）==")
    # 真数据里 `项目` 同时存在 id / 中文名 / `全局` 三种写法，而每个消费点
    # 原先都各写了一遍"字符串相等才算" → 写「全局」的决策对任何项目都不算数。
    import tegula.core as _c
    _alias = {"fangcun-base": "fangcun-base", "方寸": "fangcun-base",
              "sitian": "sitian", "司天": "sitian"}
    check("★★ 空归属算全局（老卡没写 项目 的那批）",
          _c.decision_matches_project("", "fangcun-base", _alias) is True)
    check("★★ 写「全局」的算全局（老口径把它当成某个叫全局的项目 → 谁都查不到）",
          _c.decision_matches_project("全局", "fangcun-base", _alias) is True,
          "这是 D-033/D-031/D-032 那批全局规矩进不了上下文包的真因")
    check("★★ 写中文名的能按 id 查到（`方寸` → fangcun-base）",
          _c.decision_matches_project("方寸", "fangcun-base", _alias) is True)
    check("★ 写 id 的照旧能查到", _c.decision_matches_project("fangcun-base", "fangcun-base", _alias) is True)
    check("★★ 别的项目的决策不许串味（sitian 的不能算给 fangcun-base）",
          _c.decision_matches_project("sitian", "fangcun-base", _alias) is False)
    check("★★ 认不出的归属对谁都不算数（不猜）",
          _c.decision_matches_project("龙猫", "fangcun-base", _alias) is False)
    check("★ alias 为 None 时按原样比 id（注册表读不到时不许把决策全部判死）",
          _c.decision_matches_project("fangcun-base", "fangcun-base", None) is True)
    check("★ 空 project_id 一律 False（哪条都不属于「没有项目」）",
          _c.decision_matches_project("全局", "", _alias) is False)
    check("★ 写入归一**不把空串改成「全局」**（空=没说，全局=对所有项目算数）",
          _c.normalize_decision_project_for_write("", _alias) == "")
    check("★ 写入归一能认中文名（给迁移脚本用）",
          _c.normalize_decision_project_for_write("方寸", _alias) == "fangcun-base")

    print("== 生效范围 / 落地 两个字段（2026-11-23）==")
    # 问卷落卡一直把 ` 生效范围：本卷` 拼在**内容标题**里（真台账 102/155 条），
    # 于是"这条管到哪儿"长在正文里，比对/去重/喂料都得各自再剥一遍。
    ok, d7 = core.decision_add("范围在内容里的老写法 生效范围：本卷", 日期="2026-11-23",
                               项目="fangcun-base", 出处="测试")
    check("add 收下了范围拼在内容里的写法", ok, str(d7))
    _it = [i for i in core.load_decisions() if i["id"] == d7][0]
    check("★★ 范围被摘成独立字段", _it.get("生效范围") == "本卷", repr(_it.get("生效范围")))
    check("★★ 内容里不再残留范围尾巴", "生效范围" not in _it.get("内容", ""), repr(_it.get("内容")))
    check("★ 内容本体没被摘坏", _it.get("内容") == "范围在内容里的老写法", repr(_it.get("内容")))
    ok, d8 = core.decision_add("带落地字段的一条", 日期="2026-11-23",
                               项目="fangcun-base", 落地="task-20261123-001")
    _it8 = [i for i in core.load_decisions() if i["id"] == d8][0]
    check("★ 落地字段能落盘", _it8.get("落地") == "task-20261123-001", repr(_it8.get("落地")))
    ok, d9 = core.decision_add("没给落地字段的一条", 日期="2026-11-23", 项目="fangcun-base")
    _it9 = [i for i in core.load_decisions() if i["id"] == d9][0]
    check("★★ 没给落地就是空串，**不许**补默认值（补了就等于谎称核过账）",
          _it9.get("落地") == "", repr(_it9.get("落地")))
    # round-trip：写盘后新字段还在（读回来不能丢）
    _rt = {i["id"]: i for i in core.load_decisions()}
    check("★★ 写盘 round-trip 后 生效范围 不丢", _rt[d7].get("生效范围") == "本卷")
    check("★★ 写盘 round-trip 后 落地 不丢", _rt[d8].get("落地") == "task-20261123-001")
    with open(core.DECISIONS_PATH, encoding="utf-8") as f:
        _txt2 = f.read()
    check("★ 文件里确实写了 `- 生效范围:` 行", "- 生效范围: 本卷" in _txt2)
    check("★ 文件里确实写了 `- 落地:` 行", "- 落地: task-20261123-001" in _txt2)
    check("★ 没落地的那条**不**在文件里造空落地行",
          _txt2.count("- 落地:") == sum(1 for i in _rt.values() if i.get("落地")))

    print("== 两侧一致：TS 与 Python 的枚举/别名表逐字相同 ==")
    ts_path = os.path.join(HERE, "desktop", "src", "main", "data", "decisions.ts")
    try:
        ts_src = open(ts_path, encoding="utf-8").read()
    except OSError as e:
        ts_src = ""
        check("能读到 TS 决策卡数据层", False, str(e))
    if ts_src:
        m = re.search(r"DECISION_STATUSES:\s*DecisionStatus\[\]\s*=\s*\[([^\]]*)\]", ts_src)
        ts_statuses = re.findall(r"'([^']+)'", m.group(1)) if m else []
        check("★ TS DECISION_STATUSES 与 Python DECISION_STATUSES 逐字一致",
              ts_statuses == list(core.DECISION_STATUSES),
              f"ts={ts_statuses} py={list(core.DECISION_STATUSES)}")
        m2 = re.search(r"LEGACY_STATUS_ALIASES:\s*Record<string,\s*DecisionStatus>\s*=\s*\{([^}]*)\}", ts_src)
        ts_alias = dict(re.findall(r"(\S+):\s*'([^']+)'", m2.group(1))) if m2 else {}
        check("★ TS 老值别名表 与 Python _LEGACY_DECISION_ALIASES 逐字一致",
              ts_alias == dict(core._LEGACY_DECISION_ALIASES),
              f"ts={ts_alias} py={dict(core._LEGACY_DECISION_ALIASES)}")
        check("  别名表恰好把三个老值映射到三个新值",
              set(ts_alias.values()) == set(core.DECISION_STATUSES) and len(ts_alias) == 3,
              str(ts_alias))
        # ⚠ 这一条比状态枚举更要紧：一侧写出 `- 生效范围:` 行而另一侧不认这个键，
        #   那行就会被当成"续行"拼回上一字段，**下次写盘就把数据写坏**（静默、无报错）。
        # 取法：逐行找 `const kv = /^-\s+(键|键|…)\s*…` 那一行，再抠出括号里的键表。
        # （不写成一个大正则 —— 转义层数一多就会静默匹配空，那是"断言恒绿"的经典死法）
        ts_keys = []
        for _ln in ts_src.splitlines():
            if "const kv =" in _ln and "日期|状态" in _ln:
                _m = re.search(r"\(([^)]+)\)", _ln)
                if _m:
                    ts_keys = [k.strip() for k in _m.group(1).split("|")]
                break
        py_keys = ["日期", "状态", "项目", "出处", "备注", "更新", "生效范围", "落地"]
        check("★★ TS 解析认的键 与 Python 解析认的键 逐字一致（少一个就会把字段写成续行）",
              ts_keys == py_keys,
              f"ts={ts_keys} py={py_keys}")
        check("★ 两个新字段（生效范围 / 落地）两侧都在",
              "生效范围" in ts_keys and "落地" in ts_keys)

        # 范围摘取函数两侧同名同义
        m4 = re.search(r"const RE_SCOPE_TAIL = /([^/]+)/", ts_src)
        check("★★ TS 侧有范围摘取正则（与 Python _RE_SCOPE_TAIL 同口径）",
              bool(m4), "找不到 RE_SCOPE_TAIL")
        check("★ Python 侧有同名正则", hasattr(core, "_RE_SCOPE_TAIL"))
        # 两侧正则源码必须一致（否则"某一边能摘、另一边摘不掉"）
        check("★★ 范围正则两侧源码逐字一致",
              bool(m4) and m4.group(1) == core._RE_SCOPE_TAIL.pattern,
              f"ts={m4.group(1) if m4 else ''} py={core._RE_SCOPE_TAIL.pattern}")

    print(f"\n通过 {PASS} / 失败 {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
