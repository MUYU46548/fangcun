#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""签字信息包生成器（只读）。

2026-11-19 · 卡「【施工·当前】『等我签字』第一轮：只读信息包」。
回答暮雨的问题：「待办里根本没有」「除了看板还能去哪」「一堆没做完的怎么办」。

它只做一件事：把**卡在签字前**的东西摊成一份清单 ——
  ① 5 份重号草案（_drafts/）；
  ② 14 张结构地图提案（13 待签 + 1 已完成）；
  ③ 6 份章程草稿；
  ④ 待审批卡；
  ⑤ 驳回卡（理由 + 去处）。

⚠ 本脚本**只读**：不 move / update / delete 任何卡。
   跑完会自己核对 `task-data/` 的逐文件哈希，有一个字节变了就报错退出。
⚠ `--check`：重新生成并与 `docs/签字信息包-20261119.md` 逐字比对；
   不一致退出 1（说明文件是手改的或数据变了，该重跑）。
"""
import argparse
import glob
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tegula.core import parse_task, DATA_DIR  # noqa: E402

OUT = os.path.join(DATA_DIR, "docs", "签字信息包-20261119.md")
TASK_DIR = os.path.join(DATA_DIR, "task-data")
DRAFT_DIR = os.path.join(TASK_DIR, "plans", "_drafts")
VOID_DIR = os.path.join(DRAFT_DIR, "_void-20261119")

# 5 份重号草案里，4 份已作废（见 _void-20261119/），第 5 份 2026-11-19 改号保留（P16–P20）。
DUP_DRAFTS = set()

# 2026-11-19 用户拍板：这三家的缺节「维持现状」，不再列为待补
CHARTER_KEEP_AS_IS = {"python-workspace", "rosa-rag", "zhizhen-chiming"}


# ── 只读自检 ────────────────────────────────────────────────────────────
def tree_hash(root):
    """task-data 下每个文件的 sha256（只看内容，不看 mtime）。"""
    h = {}
    for p in glob.glob(os.path.join(root, "**", "*"), recursive=True):
        if not os.path.isfile(p):
            continue
        rel = os.path.relpath(p, root).replace("\\", "/")
        with open(p, "rb") as f:
            h[rel] = hashlib.sha256(f.read()).hexdigest()
    return h


def diff_hash(a, b):
    changed = sorted(set(a) | set(b))
    return [k for k in changed if a.get(k) != b.get(k)]


# ── 读卡 ────────────────────────────────────────────────────────────────
def load_cards():
    rows = []
    for p in glob.glob(os.path.join(TASK_DIR, "*.md")):
        if os.path.basename(p).startswith("_"):
            continue
        t = parse_task(p)
        if t:
            rows.append(t)
    return rows


def projects_of(card):
    p = card.get("项目")
    if isinstance(p, list):
        return [str(x) for x in p if str(x).strip()]
    return [str(p)] if str(p or "").strip() else []


def one_line(s, n=110):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    s = re.sub(r"^[#>\-\*\s]+", "", s)
    return s[:n] + ("…" if len(s) > n else "")


def first_para(body):
    for block in re.split(r"\n\s*\n", body or ""):
        b = block.strip()
        if not b or b.startswith("#") or b.startswith("---") or b.startswith("|"):
            continue
        return one_line(b)
    return ""


def draft_summary(text):
    """草案的一句摘要：优先取「宪法（一页结论）」表第一行的结论列。"""
    m = re.search(r"^##\s*宪法[^\n]*\n(.*?)(?=^##\s|\Z)", text or "", re.M | re.S)
    seg = m.group(1) if m else (text or "")
    rows = [l for l in seg.splitlines() if re.match(r"^\s*\|\s*[^|]", l) and "---" not in l]
    if len(rows) >= 2:
        cells = [c.strip() for c in rows[1].strip().strip("|").split("|")]
        if len(cells) >= 2 and cells[1]:
            return one_line(cells[1])
    # 回落：跳过元信息列表 / 引用块 / 表格后的第一段
    for block in re.split(r"\n\s*\n", text or ""):
        b = block.strip()
        if not b or b.startswith(("#", "-", ">", "|", "---")):
            continue
        return one_line(b)
    return ""


def last_verified(body):
    m = re.search(r"最后核实[：:]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})", body or "")
    return m.group(1) if m else "取不到"


def map_is_empty(body):
    """模块清单是不是空的：认 Markdown 表格与 `- ` 列表两种写法。"""
    seg = body or ""
    if "新版结构地图" in seg:
        seg = seg.split("新版结构地图", 1)[1]
    seg = seg[:2000]
    lines = seg.splitlines()
    table_rows = [l for l in lines if re.match(r"^\s*\|\s*[^|\s]", l) and "---" not in l]
    bullets = [l for l in lines if re.match(r"^\s*-\s+\S", l)]
    placeholder = re.search(r"待填|TODO|（空）|\(空\)", seg[:800])
    # 表格：表头 + 至少 2 行才算有内容
    has_modules = len(table_rows) >= 3 or len(bullets) >= 2
    return bool(placeholder) or not has_modules


def map_flow_empty(body):
    seg = body or ""
    if "主数据流" not in seg:
        return True
    tail = seg.split("主数据流", 1)[1][:600]
    return len(one_line(tail)) < 12


def section_of(body, title):
    """取 `### title` 到下一个 `###`/`---` 之间的正文。"""
    m = re.search(r"^###\s*" + re.escape(title) + r"\s*$", body or "", re.M)
    if not m:
        return ""
    rest = (body or "")[m.end():]
    m2 = re.search(r"^(###\s|---\s*$)", rest, re.M)
    return rest[:m2.start()] if m2 else rest


def section_empty(sec):
    s = re.sub(r"\s+", " ", sec or "").strip()
    if not s:
        return True
    if re.search(r"契约(里)?[没未]写|不替它编|留空等你|待填|需你补|建议你补", s):
        return True
    return False


# ── 生成 ────────────────────────────────────────────────────────────────
def build(hashes_before):
    cards = load_cards()
    lines = []
    ap = lines.append

    # 5 份重号草案
    drafts = []
    for p in sorted(glob.glob(os.path.join(DRAFT_DIR, "*.md"))):
        fn = os.path.basename(p)
        text = open(p, encoding="utf-8").read()
        stages = re.findall(r"^###\s+(P\d+)", text, re.M)
        dt = re.search(r"(20[0-9]{2}-[0-9]{2}-[0-9]{2})", fn)
        drafts.append({
            "file": fn,
            "date": dt.group(1) if dt else "取不到",
            "stages": stages,
            "summary": draft_summary(text),
            "chars": len(text),
        })
    dup = [d for d in drafts if d["file"] in DUP_DRAFTS]
    others = [d for d in drafts if d["file"] not in DUP_DRAFTS]
    # 已作废（2026-11-19）：4 份撞号草案移进 _void-20261119/（保留备份、可逆）
    voided = []
    if os.path.isdir(VOID_DIR):
        for p in sorted(glob.glob(os.path.join(VOID_DIR, "*.md"))):
            fn = os.path.basename(p)
            if fn == "README.md":
                continue
            text = open(p, encoding="utf-8").read()
            dt = re.search(r"(20[0-9]{2}-[0-9]{2}-[0-9]{2})", fn)
            voided.append({
                "file": fn,
                "date": dt.group(1) if dt else "取不到",
                "summary": draft_summary(text),
                "chars": len(text),
            })

    # 结构地图提案（标签含「结构地图」且标题含「更新」；排除问题卡 12ba2175）
    maps_all = [c for c in cards if "结构地图" in (c.get("标签") or []) and "更新" in str(c.get("标题") or "")]
    maps_done = [c for c in maps_all if str(c.get("状态")) == "完成"]
    maps_rejected = [c for c in maps_all if str(c.get("状态")) == "驳回"]
    maps = [c for c in maps_all if str(c.get("状态")) in ("待办", "待审批", "草稿")]
    by_proj = {}
    for c in maps:
        by_proj.setdefault(projects_of(c)[0] if projects_of(c) else "未归属", []).append(c)

    def map_row(c):
        proj = projects_of(c)[0] if projects_of(c) else "未归属"
        same = by_proj.get(proj, [])
        body = c.get("_body") or ""
        empty = map_is_empty(body)
        flow_empty = map_flow_empty(body)
        # 重复：同项目多于 1 份且这份不是最新（按最后核实日期）
        dup_note = ""
        if len(same) > 1:
            newest = max(same, key=lambda x: last_verified(x.get("_body") or ""))
            if c is not newest:
                dup_note = "重复（同项目 %d 份，建议留最新的 %s）" % (len(same), last_verified(newest.get("_body") or ""))
            else:
                dup_note = "同项目 %d 份，建议留这份、其余作废" % len(same)
        if empty:
            verdict = "先别签：空壳"
        elif dup_note.startswith("重复"):
            verdict = "先别签：重复"
        elif dup_note:
            verdict = "可签（其余重复项先作废）"
        elif flow_empty:
            verdict = "可签（主数据流偏空，签前看一眼）"
        else:
            verdict = "可签"
        cat = "空壳" if empty else ("重复" if dup_note.startswith("重复") else ("只改日期" if False else "有内容"))
        return {
            "id": c.get("id", ""),
            "project": proj,
            "verified": last_verified(body),
            "empty": empty,
            "cat": cat,
            "verdict": verdict,
            "status": c.get("状态", ""),
            "flow_empty": flow_empty,
        }

    map_rows = [map_row(c) for c in sorted(maps, key=lambda x: (projects_of(x)[0] if projects_of(x) else ""))]
    done_rows = [{
        "id": c.get("id", ""), "project": projects_of(c)[0] if projects_of(c) else "未归属",
        "verified": last_verified(c.get("_body") or ""), "status": c.get("状态"),
    } for c in maps_done]

    # 章程草稿
    charters = []
    for c in cards:
        if "章程草稿" not in str(c.get("标题") or ""):
            continue
        # 2026-11-24（K2 第八个状态）：已取消的卡不该被当成"待签收的章程草稿"。
        if str(c.get("状态")) in ("完成", "驳回", "已取消"):
            continue
        body = c.get("_body") or ""
        project_name = projects_of(c)[0] if projects_of(c) else "未归属"
        secs = {k: section_of(body, k) for k in ("使命", "当前目标", "应用场景", "方针边界")}
        empt = {k: section_empty(v) for k, v in secs.items()}
        need = [k for k, v in empt.items() if v]
        if project_name in CHARTER_KEEP_AS_IS:
            need = []  # 用户已定：维持现状，不再催补
        charters.append({
            "id": c.get("id", ""),
            "project": project_name,
            "empty": empt,
            "need": need,
            "keep": project_name in CHARTER_KEEP_AS_IS,
            "title": str(c.get("标题") or ""),
        })

    # 待审批 / 驳回
    pending = [c for c in cards if str(c.get("状态")) == "待审批"]
    rejected = [c for c in cards if str(c.get("状态")) == "驳回"]

    # ── 总表 ──
    ap("# 签字信息包 · 2026-11-19")
    ap("")
    ap("> 由 `python scripts/gen-sign-inbox.py` 从真身只读生成，**不替你做任何决定**；")
    ap("> 所有签字仍由你在界面点。`--check` 可校验这份文件与数据是否一致。")
    ap("")
    ap("## 总表（先看这一张）")
    ap("")
    ap("| 类别 | 条数 | 现在该做什么 |")
    ap("|---|---:|---|")
    if dup:
        ap("| 重号草案 | %d 已作废 + %d 待定 | 作废的已备份到 `%s`；待定的看摘要再定 |" % (
            len(voided), len(dup), "_drafts/_void-20261119/"))
    else:
        ap("| 重号草案 | %d 已作废 | 11-15 已改号保留（P16–P20），无需再处理 |" % len(voided))
    can_sign = len([r for r in map_rows if r["verdict"].startswith("可签")])
    cant_sign = len([r for r in map_rows if r["verdict"].startswith("先别签")])
    ap("| 结构地图提案 | %d 待签 + %d 已完成 + %d 驳回 | %d 张可签；%d 张先别签 |" % (
        len(map_rows), len(maps_done), len(maps_rejected), can_sign, cant_sign))
    need_fix = len([c for c in charters if c["need"]])
    keep_n = len([c for c in charters if c.get("keep")])
    ap("| 章程草稿 | %d | %d 份边界待你认；%d 份维持现状（你 2026-11-19 已定） |" % (
        len(charters), need_fix, keep_n))
    ap("| 待审批卡 | %d | 无 |" % len(pending))
    ap("| 驳回卡 | %d | 按「去处」列处理 |" % len(rejected))
    ap("")
    ap("**一句话**：真正还等你动手的是 **%d 张待签地图 + %d 份边界待你认 + %d 张驳回卡**；"
       "重号草案已按决定作废（备份保留）。" % (len(map_rows), need_fix, len(rejected)))
    ap("")

    # ── 1 ──
    ap("## 1. 重号草案（%d 份已作废 + %d 份待定）" % (len(voided), len(dup)))
    ap("")
    ap("为什么重号：这些 `_drafts/` 草案的格号是 **P0–P4**，而 `task-data/plans/fangcun-base.md`")
    ap("里 P0–P4 已经被**完成**的阶段占用 —— 提成时必然报「格号已存在」，点十次都一样。")
    ap("")
    if voided:
        ap("### 已作废（2026-11-19，按计划总卡 v3：前 4 份作废、先备份）")
        ap("")
        ap("备份位置：`task-data/plans/_drafts/_void-20261119/`（**没有删除**，移回上一级即恢复）。")
        ap("")
        ap("| 文件名 | 日期 | 一句摘要 | 处置 |")
        ap("|---|---|---|---|")
        for d in sorted(voided, key=lambda x: x["date"]):
            ap("| `%s` | %s | %s（%d 字） | 已移入 `_void-20261119/` |" % (
                d["file"], d["date"], d["summary"], d["chars"]))
        ap("")
    if dup:
        ap("### 仍待你定")
        ap("")
        ap("| 文件名 | 日期 | 一句摘要 | 为什么要你定 |")
        ap("|---|---|---|---|")
        for d in sorted(dup, key=lambda x: x["date"]):
            ap("| `%s` | %s | %s（%d 字，%s） | 计划总卡写的是「先看摘要再定」 |" % (
                d["file"], d["date"], d["summary"], d["chars"], "/".join(d["stages"]) or "无阶段"))
        ap("")

    # ── 2 ──
    ap("## 2. 结构地图提案（%d 张待签 + %d 张已完成 + %d 张驳回）" % (
        len(map_rows), len(maps_done), len(maps_rejected)))
    ap("")
    ap("| 项目 | 提案 id | 最后核实 | 是否空壳 | 分类 | 建议 |")
    ap("|---|---|---|---|---|---|")
    for r in map_rows:
        ap("| %s | `%s` | %s | %s | %s | %s |" % (
            r["project"], r["id"], r["verified"], "空壳" if r["empty"] else "有内容", r["cat"], r["verdict"]))
    for r in done_rows:
        ap("| %s | `%s` | %s | — | 已完成 | 无需签 |" % (r["project"], r["id"], r["verified"]))
    for c in maps_rejected:
        ap("| %s | `%s` | %s | — | 已驳回 | 已作废（未应用） |" % (
            projects_of(c)[0] if projects_of(c) else "未归属", c.get("id", ""), last_verified(c.get("_body") or "")))
    ap("")
    ap("判定口径：模块清单里既没有表格行也没有列表项（或写着「待填」）= 空壳；")
    ap("同一项目有多份提案 = 重复，建议保留最新那份、其余作废；")
    ap("「主数据流」偏空只提示、不拦（它不是签字硬闸）。")
    ap("")

    # ── 3 ──
    ap("## 3. 章程草稿（%d 份）" % len(charters))
    ap("")
    ap("| 目标项目 | 提案 id | 目标 | 场景 | 边界 | 需要你补 |")
    ap("|---|---|---|---|---|---|")
    for c in sorted(charters, key=lambda x: x["project"]):
        e = c["empty"]
        cell = lambda k: "空" if e[k] else "有"
        need = "维持现状" if c.get("keep") else ("、".join(c["need"]) or "—")
        ap("| %s | `%s` | %s | %s | %s | %s |" % (c["project"], c["id"], cell("当前目标"), cell("应用场景"), cell("方针边界"), need))
    ap("")
    ap("「空」不等于要你写一篇：多数是契约里本来没写、草稿没有替它编 ——")
    ap("你补一句或确认「就按草稿」即可。")
    ap("")

    # ── 4 ──
    ap("## 4. 待审批卡（%d 张）" % len(pending))
    ap("")
    if not pending:
        ap("当前没有停在「待审批」的卡 —— 这是真数据，不是取不到。")
    else:
        ap("| 标题 | 项目 | 为什么卡在待审批 |")
        ap("|---|---|---|")
        for c in pending:
            ap("| %s | %s | 状态=待审批；打开卡看正文 |" % (one_line(c.get("标题"), 60), projects_of(c)[0] if projects_of(c) else "未归属"))
    ap("")

    # ── 5 ──
    ap("## 5. 驳回卡（%d 张：理由 + 去处）" % len(rejected))
    ap("")
    ap("| 卡 | 项目 | 驳回理由 | 去处 |")
    ap("|---|---|---|---|")
    for c in rejected:
        rec = str(c.get("结果记录") or "")
        m = re.findall(r"\[[^\]]+\]\s*驳回[：:]\s*([^\n]+)", rec)
        reason = one_line(m[-1] if m else "取不到理由", 60)
        title = one_line(c.get("标题"), 50)
        # 去处：已作废 → 留档；测试/可删 → 归档；其余 → 返工
        if "已作废" in title:
            dest = "已作废（留档，不返工）"
        elif re.search(r"测试|可删|冒烟", title + reason):
            dest = "归档（测试卡，无返工价值）"
        else:
            dest = "返工（按卡正文重做一版）"
        ap("| %s | %s | %s | %s |" % (title, projects_of(c)[0] if projects_of(c) else "未归属", reason, dest))
    ap("")

    # ── 附 ──
    ap("## 附：其余草案（不是欠账）")
    ap("")
    ap("| 文件 | 日期 | 阶段 | 状态 |")
    ap("|---|---|---|---|")
    for d in sorted(others, key=lambda x: x["file"]):
        if d["file"].startswith("rosa-chuangzuo"):
            st = "待提成（P0–P2 可提）"
        elif d["file"] == "fangcun-base-2026-11-15.md":
            st = "待提成（2026-11-19 已改号 P16–P20，不再撞号）"
        else:
            st = "已提成（副本没删，不是欠账）"
        ap("| `%s` | %s | %s | %s |" % (d["file"], d["date"], "/".join(d["stages"]) or "—", st))
    ap("")

    # ── 数怎么来的 ──
    ap("## 数怎么来的")
    ap("")
    ap("- 数据源：`task-data/*.md`（活跃卡）+ `task-data/plans/_drafts/*.md` + `_drafts/_void-20261119/*.md`；**不含 archive/ 与 .trash/**。")
    ap("- 结构地图：标签含「结构地图」且标题含「更新」的卡；问题卡 `12ba2175` 不算提案。")
    ap("- 章程草稿：标题含「章程草稿」且状态不是完成/驳回的卡。")
    ap("- 驳回卡：`状态: 驳回` 的活跃卡；理由取 `结果记录` 里**最后一条**驳回记录。")
    ap("- 只读：生成前后对 `task-data/**` 逐文件 sha256，必须一个都不变。")
    ap("")

    text = "\n".join(lines) + "\n"

    after = tree_hash(TASK_DIR)
    changed = diff_hash(hashes_before, after)
    if changed:
        raise SystemExit("FAIL 生成过程改了 task-data：%s" % ", ".join(changed[:5]))
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只比对文件，不写盘")
    args = ap.parse_args()

    before = tree_hash(TASK_DIR)
    text = build(before)

    if args.check:
        if not os.path.exists(OUT):
            print("FAIL 文件不存在：%s（先跑 python scripts/gen-sign-inbox.py）" % OUT)
            return 1
        cur = open(OUT, encoding="utf-8").read()
        if cur != text:
            # 给出第一条差异，别打整篇
            a, b = cur.splitlines(), text.splitlines()
            for i in range(max(len(a), len(b))):
                x = a[i] if i < len(a) else "<缺行>"
                y = b[i] if i < len(b) else "<缺行>"
                if x != y:
                    print("FAIL 与数据不一致（第 %d 行）" % (i + 1))
                    print("  文件: " + x[:160])
                    print("  应为: " + y[:160])
                    break
            print("      → 重跑 python scripts/gen-sign-inbox.py")
            return 1
        print("PASS 签字信息包与数据一致（只读自检通过）")
        return 0

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print("已生成 %s（%d 行）" % (OUT, text.count("\n")))
    print("只读自检：task-data 逐文件 sha256 未变")
    return 0


if __name__ == "__main__":
    sys.exit(main())
