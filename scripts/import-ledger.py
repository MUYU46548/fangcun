#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「项目需求对账账本」落进方寸（2026-10-15 · 清单第 1 条「AI 规划真活」的等价动作）

为什么要有这个脚本（一句话）：
    账本把"提过、没做完、也没被否决"的挂账盘出来了，但它自己躺在一个 md 文件里 ——
    **方寸里一条都没有**，于是"记不住"这件事一点没变。这份脚本做的是**收口**：
    账本里的每一条挂账 → 方寸里一张真卡（可筛选、可派活、可关账）。

口径（不许违反）：
    ① **账本是真源**：本脚本只做解析 + 建卡，不改写账本、不"顺手优化"它的措辞；
    ② **幂等**：每张卡的附言里带一个稳定标记 `[账本:<版本>:<key>]`，
       重跑时按标记跳过已建过的 —— 不许重复建卡（方寸会报"重复登记"）；
    ③ **细节不丢**：条目的原文（含括号里的现状说明）整段进正文，不做摘要式压缩；
    ④ **E 表与〔未达〕栏也进卡**（它们是最容易"再丢一次"的两类），但不混进挂账卡里。

用法：
    python scripts/import-ledger.py <账本.md> [--dry-run] [--ledger-version 20261015]
"""
import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import tegula.core as core  # noqa: E402

# 账本分节名 → 方寸 registry 里的项目 id（对不上就留空 = 未归属，不硬凑）
PROJECT_OF = {
    "司天": "sitian",
    "绒花墨坊": "project-2",
    "滞针迟鸣": "zhizhen-chiming",
    "方寸": "fangcun-base",
    "记忆圣所": "memory-sanctuary",
    "明鉴": "project-3",
    "订阅/资产": None,
    "游戏四": None,
    "全局": None,
}

TAG_BASE = "账本"


# ── 解析 ────────────────────────────────────────────────────────────────

def split_sections(text):
    """按 `## ` 顶层标题切段，返回 [(标题, 正文)]"""
    out = []
    cur = None
    for line in text.splitlines():
        if line.startswith("## "):
            if cur:
                out.append(cur)
            cur = [line[3:].strip(), []]
        elif cur:
            cur[1].append(line)
    if cur:
        out.append(cur)
    return [(t, "\n".join(b)) for t, b in out]


def clean_md(s):
    """去掉 markdown 强调标记与反引号（卡面/标题里不该出现裸 ** 或 `）"""
    s = str(s or "")
    s = s.replace("**", "").replace("~~", "")
    s = s.replace("`", "")
    return re.sub(r"\s+", " ", s).strip()


def sec_title(head, n=44):
    t = clean_md(head)
    t = re.split(r"[（(]", t)[0].strip()
    return t[:n]


def section_of(head, key):
    m = re.match(r"^\s*([A-F])\s*表", clean_md(head))
    if m:
        return m.group(1)
    if "未达" in head:
        return "P"      # 附：未达栏
    return key


def parse_a(body):
    """A 表：markdown 表格 → 整表原样留档（它是索引，不重复建 12 张卡）"""
    lines = [ln for ln in body.splitlines() if ln.strip().startswith("|")]
    rows = []
    for ln in lines:
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if len(cells) < 5 or set(cells[0]) <= set("-: "):
            continue
        if cells[0] in ("#",):
            continue
        rows.append(cells[:5])
    return rows


def parse_b(body):
    """B 表：`### 项目（N 条…）` 分块，块内 `1. xxx` / `- xxx` 都是条目"""
    blocks = []
    cur = None
    for line in body.splitlines():
        if line.startswith("### "):
            if cur:
                blocks.append(cur)
            cur = [line[4:].strip(), []]
        elif cur is not None:
            cur[1].append(line)
    if cur:
        blocks.append(cur)

    items = []
    for head, lines in blocks:
        sec = sec_title(head)
        for ln in lines:
            m = re.match(r"^\s*(\d+)\.\s+(.*)$", ln)
            if m:
                items.append((sec, int(m.group(1)), clean_md(m.group(2))))
                continue
            m = re.match(r"^-\s+(.*)$", ln)
            if m:
                txt = clean_md(m.group(1))
                if txt and not set(txt) <= set("-"):
                    # 划掉的行（~~…~~ → 已修/已销）也是账的一部分，照样留档
                    items.append((sec, None, txt))
    return items


def parse_numbered_items(body):
    """D 表那种 `1. xxx` 列表（跳过 `- ~~…~~ → 销账` 这种补充行，单独收）"""
    items, notes = [], []
    for ln in body.splitlines():
        m = re.match(r"^\s*(\d+)\.\s+(.*)$", ln)
        if m:
            items.append(clean_md(m.group(2)))
            continue
        m = re.match(r"^-\s+(.*)$", ln)
        if m:
            notes.append(clean_md(m.group(1)))
    return items, notes


def parse_c_list(body):
    """C 表 / E 表：第一段被 `·` 串起来的清单 → (条目列表, 其余段落)

    ⚠ 不能把整段一起 join 再切 —— C 表后面还有一段「观察」（那是判词，不是条目），
    混进去会让最后一条条目粘上整段观察。按空行分段，只切第一段。
    """
    paras = [p.strip() for p in body.split("\n\n") if p.strip()]
    if not paras:
        return [], []
    first = " ".join(ln.strip() for ln in paras[0].splitlines() if ln.strip())
    items = [clean_md(x) for x in first.split("·") if clean_md(x)]
    return items, paras[1:]


def safe_tag(s):
    return re.sub(r"[\[\],:/\\]", "·", str(s or "")).strip()


# ── 建卡 ────────────────────────────────────────────────────────────────

def existing_keys():
    """扫一遍现有卡，收已经建过的账本标记（幂等的唯一依据）

    返回的是**标记内文**（形如 `20261015:B-司天-1`），与 `版本:key` 拼法一致。
    """
    keys = set()
    tdir = core.TASK_DIR
    for sub in ("", "archive", ".trash"):
        d = os.path.join(tdir, sub) if sub else tdir
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith(".md"):
                continue
            try:
                with open(os.path.join(d, fn), encoding="utf-8") as f:
                    txt = f.read()
            except OSError:
                continue
            for m in re.finditer(r"\[账本:([^\]]+)\]", txt):
                keys.add(m.group(1))
    return keys


class Plan:
    def __init__(self, version, tag):
        self.version = version
        self.tag = tag
        self.cards = []

    def add(self, key, title, project, body_lines, remark, priority="中",
            assignee="hermes", tags=None, status="待办", result=""):
        self.cards.append({
            "key": key,
            "标题": title,
            "项目": ([project] if project else []),
            "状态": status,
            "优先级": priority,
            "标签": [self.tag] + list(tags or []),
            # ⚠ 标记里**必须带版本**：账本改版后老卡还在，不带版本的话新版重跑会认不出老卡 → 重复建卡。
            "附言": "[账本:%s:%s] %s" % (self.version, key, remark),
            "指派": assignee,
            "验收": "暮雨",
            "来源": "human",
            "方案": body_lines,
            "结果记录": result,
        })


def build_plan(ledger, version):
    tag = "%s%s" % (TAG_BASE, version)
    plan = Plan(version, tag)
    sections = split_sections(ledger)

    for head, body in sections:
        letter = section_of(head, "")
        label = sec_title(head, 40)

        if letter == "A":
            rows = parse_a(body)
            lines = ["- [ ] **这是索引，不是任务本身** —— 表中每一件在 B 表都有独立卡，"
                     "去那张卡上推进；此卡只负责留住「提了几遍」这个事实。", ""]
            for r in rows:
                lines.append("- `%s` %s ｜ %s ｜ 次数 %s ｜ %s" % (r[0], r[1], r[2], r[3], r[4]))
            lines += ["", "- [ ] 来源：《项目需求对账账本-20261015-终版v2.md》（2026-10-15 三方终验）"]
            plan.add("A-index", "[账本] A 表 · 提了两遍以上还没落地的 %d 条（索引）" % len(rows),
                     None, lines, "账本 A 表整表留档；逐条见 B 表对应卡", priority="高",
                     tags=["顽固挂账"])

        elif letter == "B":
            items = parse_b(body)
            for sec, num, txt in items:
                if not txt:
                    continue
                k = "B-%s-%s" % (sec, num if num is not None else "x")
                # 同一节里可能有多条无编号补充行 → 加序号避免 key 撞车
                n = 1
                base = k
                while any(c["key"] == k for c in plan.cards):
                    n += 1
                    k = "%s-%d" % (base, n)
                # 账本里带 `→ 已修 / 已落地 / 已合入 / 已被你的产线做掉` 的条目**已经是闭环**，
                # 直接建成「完成」卡 —— 不许让做完的事继续挂在待办上冒充欠账（那就是账变浆糊的起点）。
                done = bool(re.search(r"→\s*已|已修（|已落地|已合入|已被你的产线做掉|已交付", txt))
                title = "[账本] %s：%s" % (sec, txt[:56])
                plan.add(k, title, PROJECT_OF.get(sec),
                         ["- [%s] %s" % ("x" if done else " ", txt),
                          "",
                          "- [ ] 出处：账本 B 表 · %s 第 %s 条（快照与判据见账本原文）"
                          % (sec, num if num is not None else "补充")],
                         remark="账本 B 表 · %s%s" % (sec, "（账本记为已完成）" if done else ""),
                         tags=["挂账", safe_tag(sec)],
                         status="完成" if done else "待办",
                         result=("2026-10-15 按账本记载销账：" + txt) if done else "")

        elif letter == "C":
            items, rest = parse_c_list(body)
            if items:
                lines = ["- [ ] **这些是「回一个字 / 点一下」级的动作，却卡着下游 agent 侧一大串活。**",
                         "      对应卡在 B 表里（同一件事不重复建卡），去那张卡上回字。", ""]
                for it in items:
                    lines.append("- [ ] %s" % it)
                for p in rest:
                    lines += ["", "- %s" % clean_md(p)]
                # ⚠ 账本标题写「共 11 件」，实际 `·` 分隔出来只有 10 条 —— 差异如实记下，不替它圆。
                lines += ["", "- [ ] ⚠ 本清单实际列出 **%d 条**，账本小标题写的是「共 11 件」——"
                              "差 1 条，未擅自补齐（账本是真源）。" % len(items)]
                plan.add("C-index", "[账本] C 表 · 只有暮雨能做的（回字清单）",
                         None, lines, "账本 C 表整段留档", priority="高",
                         assignee="暮雨", tags=["你的工位"])

        elif letter == "D":
            items, notes = parse_numbered_items(body)
            for i, txt in enumerate(items, 1):
                plan.add("D-%d" % i, "[账本·欠账] %s" % txt[:56], None,
                         ["- [ ] %s" % txt, "", "- [ ] 出处：账本 D 表第 %d 条（agent 侧明确认领后没交的）" % i],
                         remark="账本 D 表（agent 侧欠账）", priority="高", tags=["欠账"])
            for j, nt in enumerate(notes, 1):
                plan.add("D-note-%d" % j, "[账本·销账] %s" % nt[:56], None,
                         ["- [x] %s" % nt, "", "- [ ] 出处：账本 D 表补充行（已销账记录，留档防重复追讨）"],
                         remark="账本 D 表补充行", status="完成", tags=["销账"])

        elif letter == "E":
            items, _rest = parse_c_list(body)
            lines = ["- [ ] **这些是提过、暮雨亲口否决/改判的 —— 防复活，也防「当成丢了」。**", ""]
            for it in items:
                lines.append("- `已死` %s" % it)
            plan.add("E-index", "[账本] E 表 · 已死之单 %d 条（防复活）" % len(items),
                     None, lines, "账本 E 表整段留档", tags=["已死之单"])

        elif letter == "P":
            lines = ["- [ ] **「做完了、但从没到过你手里」—— 比「没做」更隐蔽。**", ""]
            for para in [p.strip() for p in body.split("\n\n") if p.strip()]:
                lines.append("- %s" % clean_md(para))
            plan.add("P-unreached", "[账本] 〔未达〕栏 · 做完了但从没到过你手里", None,
                     lines, "账本附录整段留档", priority="高", tags=["未达"])

    # 总纲卡：一句话结论 + 边界声明 + 两条机制建议（账本自己的判词，原样留）
    head_line = ""
    mech = []
    for head, body in sections:
        if head.startswith("一句话结论"):
            head_line = clean_md(body)
        if head.startswith("两条机制建议"):
            mech = [clean_md(x) for x in body.splitlines() if x.strip()]
    lines = ["- [ ] %s" % head_line, "", "- [ ] **两条机制建议（账本原话）**："]
    for x in mech:
        lines.append("      %s" % x)
    lines += ["", "- [ ] 本卡的用处：以后任何 agent 问「这个之前定过吗 / 做过吗」，先翻这一组卡。"]
    plan.add("Z-summary", "[账本] 总纲 · 47 条挂账是怎么来的（读我先）", None,
             lines, "账本总纲；全部条目见同标签其它卡", priority="高", tags=["总纲"])

    return plan


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ledger", help="账本 md 路径")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--ledger-version", default="20261015")
    args = ap.parse_args()

    with open(args.ledger, encoding="utf-8") as f:
        ledger = f.read()

    plan = build_plan(ledger, args.ledger_version)
    have = existing_keys()

    def marker(c):
        return "%s:%s" % (args.ledger_version, c["key"])

    todo = [c for c in plan.cards if marker(c) not in have]
    print("账本：%s" % args.ledger)
    print("解析出 %d 张卡；已存在 %d 张；本次要建 %d 张"
          % (len(plan.cards), len(plan.cards) - len(todo), len(todo)))
    for c in plan.cards:
        flag = "已存在" if marker(c) in have else "新建  "
        print("  %s [%s] %s" % (flag, c["key"], c["标题"]))

    if args.dry_run:
        print("\n--dry-run：一张都没写。")
        return 0

    made = []
    for c in todo:
        fields = dict(c)
        fields.pop("key")
        ok, tid = core.api_new(fields)
        if not ok:
            print("FAIL 建卡失败：%s" % c["标题"])
            return 1
        # ⚠ `api_new` 的字段兜底把**空数组**也当"没填" → 项目留空会被写成默认的 fangcun-base。
        #   账本里"全局 / 订阅 / 游戏四 / A·C·D·E 表"这些条目本来就**不该有归属**，
        #   所以这里必须**显式**回写一次空数组（2026-10-15 实测踩到：23 张卡被错挂到方寸名下）。
        if not c["项目"]:
            core.api_edit(tid, {"项目": []})
        made.append((c["key"], tid))

    print("\n已建 %d 张：" % len(made))
    for k, tid in made:
        print("  %s  ←  %s" % (tid, k))

    # 建完自校验：每张卡的标记都真的落盘了（"写成功"不等于"读得回来"）
    after = existing_keys()
    miss = [k for k, _ in made if k not in after]
    if miss:
        print("FAIL 这些标记读不回来（写失败？）：%s" % miss)
        return 1
    print("自校验：%d/%d 张卡的标记都能读回来。" % (len(made), len(made)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
