#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""组合视图 · 把四份各说各话的数据拼成一张表（2026-11-15）

暮雨：「虽然有主次，而且主次已经能在方寸里排，排序功能已经实现了」。
这句话点破了此前的盲点：**经营计划不缺原料，缺的是把原料拼起来的那一步。**

四份数据各自都在，而且都是真数据：
  ① `task-data/project-tiers.json`  —— 项目的**层级**（核心 / 次优先 / 排队 / 搁置）
  ② `task-data/rice-pool.md`        —— **需求池**（R/I/C/E 与 P0/P1/P2）
  ③ `ai-trace.jsonl`                —— **花了多少 token**（trigger 里带项目 id，card 字段归因到卡）
  ④ `task-data/*.md` + archive/     —— **产出了什么**（完成/驳回状态、更新时间）

它们此前**没有任何一个视图能拼起来**，于是"核心项目到底拿到了多少资源"这个问题
只能靠感觉回答。这份脚本只做一次 join，不建新字段、不改任何数据。

三条纪律（沿用本仓反复吃亏的口径）：
  ① **只读**：一个字节都不写 task-data；
  ② **缺就说缺**：取不到的数给 None 并写明"缺什么"，**绝不填 0**（0 会被读成"真的没有"，
     和"没开始记"是两件事——`never_read` 那条断言栽过同一个坑）；
  ③ **数字自带局限**：每个数旁边说清它证明不了什么。

用法：
  python scripts/project-portfolio.py                    # 打到屏幕
  python scripts/project-portfolio.py --out docs/x.md    # 落文件
  python scripts/project-portfolio.py --json             # 机器可读
  python scripts/project-portfolio.py --days 30          # 时间窗（默认 30）
"""
import sys
import os
import re
import json
import glob
from datetime import datetime, timezone, timedelta
from collections import defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.environ.get("FC_PF_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TZ = timezone(timedelta(hours=8))
NOW = datetime.now(TZ)
DONE = {"完成", "驳回"}
# 「真的被用起来」= 验收通过 / 已发布 / 被别处引用。**不算"卡变完成"**——
# 那是自报。这里能拿到的最强证据只有"状态=完成且没被驳回"，所以口径必须写出来。
HONEST_DONE = "完成"


def rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")


def parse_dt(iso):
    if not iso:
        return None
    s = str(iso).strip()
    try:
        if re.fullmatch(r"\d+", s):
            n = int(s)
            if n > 1e12:
                n //= 1000
            return datetime.fromtimestamp(n, TZ)
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=TZ)
    except Exception:
        return None


# ── ① 层级 ──────────────────────────────────────────────────────────────
def load_tiers():
    p = os.path.join(ROOT, "task-data", "project-tiers.json")
    if not os.path.exists(p):
        return {}, "", "没有 project-tiers.json"
    try:
        j = json.load(open(p, encoding="utf-8"))
    except Exception as e:
        return {}, "", "读不出 tiers（%s）" % e
    out = {}
    for i, t in enumerate(j.get("tiers") or []):
        for pid in (t.get("items") or []):
            out[pid] = {"tierIndex": i, "tierLabel": str(t.get("label") or ""), "tierId": str(t.get("id") or "")}
    return out, str(j.get("updatedAt") or ""), ""


# ── ② 需求池 ────────────────────────────────────────────────────────────
def load_rice():
    """需求池，**按项目归因**。

    ⚠ 字段名是**中文**：`标题` / `来源` / `拍板` / `决策id` / `E天` / `E元`。
      第一版按 `eid` / `origin` / `verdict` 读 → **全池 0 条**，而输出照样成型
      （"全池 0 条：已决定 0 / 未决定 0"看起来像"还没有需求"，其实是读错了键）。
      这是本仓第 N 次栽在同一个坑上：**抓错形态，输出不报错。**

    ⚠ 第二版坑：`- 拍板: ` 后面**没有值**时，`\\s*(.*)` 里的 `\\s*` 会吃掉换行符，
      于是把**下一行**「- 决策id:」当成拍板的值 → 11 条全被判成"已决定"，
      而 `rice_pool_list` 里它们明明全是"未决定"。
      修法：行内字段一律 `[^\\n]*`，不许跨行。

    ⚠ 归因：`来源` 形如 `task:<卡id>` 或 `external:<名字>`。
      卡 id 反查 `task-data/*.md` 的 `项目:` 字段即可（实测 9/11 能反查，
      剩下 2 条是 `external:notify-*`，**本来就没有卡**）——
      归不了的必须进 `unattributed`，不许悄悄丢掉。
    """
    p = os.path.join(ROOT, "task-data", "rice-pool.md")
    if not os.path.exists(p):
        return None
    try:
        txt = open(p, encoding="utf-8").read()
    except Exception:
        return None

    c2p = {}
    for f in glob.glob(os.path.join(ROOT, "task-data", "*.md")):
        try:
            d = _quick_fm(f)
        except Exception:
            continue
        # ⚠ 索引键要**两个都给**：真身里有的卡写了 `id:`，有的没写
        #   （`appvue-后三刀拆分-10597382.md` 就没有 `id:` 字段）。
        #   第一版只按 frontmatter 的 `id:` 建索引 → 需求池 11 条**全部归不到项目**，
        #   而渲染照样成型（"（归不到项目） | 11"），看起来像数据本身缺项目。
        #   文件名本身就是 id 的兜底来源。
        stem = os.path.basename(f)[:-3]
        proj = d.get("project") or d.get("项目") or ""
        if d.get("id"):
            c2p[str(d["id"])] = proj
        c2p[stem] = proj

    items = []
    for blk in re.split(r"(?m)^##\s+", txt)[1:]:
        head = blk.split("\n", 1)[0].strip()
        eid = head.split()[0] if head else ""
        row = {"eid": eid}
        for k, v in re.findall(r"(?m)^-\s*([^:：\n]+)[:：][ \t]*([^\n]*)$", blk):
            row[k.strip()] = v.strip()
        if not eid:
            continue
        # 源头反查项目
        src = str(row.get("来源") or "").strip()
        cid = src.split(":", 1)[1] if ":" in src else ""
        row["_project"] = c2p.get(cid) or ""
        row["_decided"] = bool(str(row.get("拍板") or "").strip())
        items.append(row)

    by_proj = defaultdict(lambda: {"total": 0, "decided": 0})
    unattributed = 0
    for x in items:
        pid = x["_project"]
        if not pid:
            unattributed += 1
            continue
        by_proj[pid]["total"] += 1
        if x["_decided"]:
            by_proj[pid]["decided"] += 1

    decided = sum(1 for x in items if x["_decided"])
    return {
        "total": len(items),
        "decided": decided,
        "undecided": len(items) - decided,
        "byProject": dict(by_proj),
        "unattributed": unattributed,
    }


# ── ③ token ─────────────────────────────────────────────────────────────
TRIG_PROJ = re.compile(r"^(?:plan-draft|plan_draft|arch|archGenerate):([A-Za-z0-9_\-]+)")


def load_tokens(days):
    """按项目归因 token。

    三种归因来源，按可靠性排序，全部记账（不许把归不了因的悄悄丢掉）：
      ① `trigger` 里带项目 id（`plan-draft:rosa-chuangzuo`）—— 最硬；
      ② `card` 字段 → 查那张卡的项目 —— 次硬（卡可能已归档）；
      ③ 其余 → 计入 `(未归因)`，并单独报数。

    ⚠ **2026-11-15 订正（重要）**：我第一版看到未归因 50 亿，随口判成"坏记录"。
      暮雨当场质疑：「有没有可能真的用了 50 亿？上个月总用量 80 亿以上」。
      查完发现**他是对的**，而且真相比"坏记录"更有信息量：
        · 372 条 external:dsh 记录，中位数 **476 万 token/轮**；
        · 其中 `cache_read` 占 **99.1%**（5,055,848,011 / 5,102,937,414）；
        · 扣掉缓存后真正新算的只有 **约 4,700 万**。
      所以「50 亿」不是坏数，是**长上下文会话每轮重读整段 prompt** 的必然结果。
      这也解释了为何供应商账单上的"用量"远大于"实际新算"——两边口径不同。
      表里必须把 `cache_read` 拆出来，否则读者会把缓存读取当成烧掉的钱。
    """
    p = os.path.join(ROOT, "ai-trace.jsonl")
    if not os.path.exists(p):
        return None, "没有 ai-trace.jsonl"

    card2proj = {}
    for f in glob.glob(os.path.join(ROOT, "task-data", "*.md")):
        try:
            d = _quick_fm(f)
        except Exception:
            continue
        if d.get("id"):
            card2proj[d["id"]] = d.get("project") or ""

    cutoff = NOW - timedelta(days=days)
    per = defaultdict(lambda: {"calls": 0, "tokens": 0, "failed": 0})
    unattributed = {"calls": 0, "tokens": 0, "cacheRead": 0, "fresh": 0}
    total_calls = 0
    total_cache = 0
    for line in open(p, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        dt = parse_dt(o.get("ts") or o.get("at"))
        if not dt or dt < cutoff:
            continue
        total_calls += 1
        tok = o.get("total_tokens")
        tok = int(tok) if isinstance(tok, (int, float)) else 0
        ok = o.get("ok", True)
        # cache_read：note 里写着（`cache_read=102705280`）。取不到就当 0，但**不假装它是新算的**。
        m = re.search(r"cache_read=(\d+)", str(o.get("note") or ""))
        cache = int(m.group(1)) if m else 0
        total_cache += cache
        proj = ""
        mm = TRIG_PROJ.match(str(o.get("trigger") or ""))
        if mm:
            proj = mm.group(1)
        if not proj and o.get("card"):
            proj = card2proj.get(str(o["card"])) or ""
        if proj:
            per[proj]["calls"] += 1
            per[proj]["tokens"] += tok
            if ok is False:
                per[proj]["failed"] += 1
        else:
            unattributed["calls"] += 1
            unattributed["tokens"] += tok
            unattributed["cacheRead"] += cache
            unattributed["fresh"] += max(0, tok - cache)
    return {"per": dict(per), "unattributed": unattributed,
            "totalCalls": total_calls, "totalCache": total_cache}, ""


def _quick_fm(path):
    """只读 frontmatter 的几个键（不走 tegula.core，避免与清单脚本耦合）。

    ⚠ 键名是**中文**：`状态` / `更新` / `项目` / `id`。写成英文会全部读到空串 ——
      清单脚本第一版就栽在这（整列"时间不详"，而输出照样成型）。

    ⚠⚠ 2026-11-15 第三坑（组合视图第二轮）：`项目:` 可以是**块式列表**：
        ```
        项目:
          - fangcun-base
        ```
      只抓同一行会得到空串 → 那条需求归不到项目。
      这与 `e2e-fm-contract` 钉的"块式列表 / 行内列表两个方向都要能读"是同一个契约。
    """
    d = {}
    try:
        txt = open(path, encoding="utf-8").read()
    except Exception:
        return d
    m = re.match(r"(?s)^---\r?\n(.*?)\r?\n---", txt)
    if not m:
        return d
    lines = m.group(1).split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        mm = re.match(r"^(\w+):[ \t]*(.*)$", line)
        i += 1
        if not mm:
            continue
        k, v = mm.group(1), mm.group(2).strip()
        if v.startswith("[") and v.endswith("]"):
            v = v[1:-1]
        # 块式列表：值为空，后面跟若干 `  - xxx`
        if v == "":
            seq = []
            while i < len(lines) and re.match(r"^[ \t]*-\s*\S", lines[i]):
                seq.append(re.sub(r"^[ \t]*-\s*", "", lines[i]).strip())
                i += 1
            if seq:
                d[k] = seq[0]
                continue
        d[k] = v.strip().strip('"').strip("'")
    return d


# ── ④ 产出 ──────────────────────────────────────────────────────────────
def load_outputs(days):
    """每项目的卡数与"完成"数，分成活跃区与归档区。

    ⚠ 「完成」是**自报状态**，不等于"真被用起来"。这条局限必须在输出里写出来。
    """
    active = defaultdict(lambda: {"open": 0, "done": 0, "lastTouched": None})
    archived = defaultdict(lambda: {"done": 0})
    cutoff = NOW - timedelta(days=days)

    def eat(path, bucket, is_archive):
        try:
            d = _quick_fm(path)
        except Exception:
            return
        st = str(d.get("状态") or "").strip()
        pid = str(d.get("项目") or "").strip() or "(未归属)"
        upd = parse_dt(d.get("更新") or d.get("更新时间"))
        if is_archive:
            if st in DONE:
                archived[pid]["done"] += 1
            return
        if st in DONE:
            bucket[pid]["done"] += 1
        else:
            bucket[pid]["open"] += 1
        if upd and (bucket[pid]["lastTouched"] is None or upd > bucket[pid]["lastTouched"]):
            bucket[pid]["lastTouched"] = upd

    for f in glob.glob(os.path.join(ROOT, "task-data", "*.md")):
        eat(f, active, False)
    for f in glob.glob(os.path.join(ROOT, "task-data", "archive", "*.md")):
        eat(f, archived, True)
    return dict(active), dict(archived)


# ── 组装 ────────────────────────────────────────────────────────────────
def build(days=30):
    tiers, tiersAt, tiersErr = load_tiers()
    rice = load_rice()
    tok, tokErr = load_tokens(days)
    active, archived = load_outputs(days)

    allpids = set(tiers) | set(active) | set(archived)
    if tok:
        allpids |= set(tok["per"].keys())
    allpids.discard("")
    allpids.discard("(未归属)")

    rows = []
    rice_by = (rice or {}).get("byProject") or {}
    for pid in allpids:
        t = tiers.get(pid) or {}
        a = active.get(pid) or {"open": 0, "done": 0, "lastTouched": None}
        ar = archived.get(pid) or {"done": 0}
        tk = (tok or {}).get("per", {}).get(pid) or {"calls": 0, "tokens": 0, "failed": 0}
        lt = a.get("lastTouched")
        rb = rice_by.get(pid) or {}
        rows.append({
            "project": pid,
            "tier": t.get("tierLabel") or "",
            "tierIndex": t.get("tierIndex", 99),
            "open": a["open"],
            "done": a["done"],
            "archived": ar["done"],
            "riceTotal": rb.get("total"),
            "riceDecided": rb.get("decided"),
            "calls": tk["calls"],
            "tokens": tk["tokens"],
            "failed": tk["failed"],
            "staleDays": (NOW - lt).days if lt else None,
        })

    # 排序 = 层级优先，同层内 token 多的在前（谁吃得多、产出多少，一眼可见）
    rows.sort(key=lambda r: (r["tierIndex"], -(r["tokens"] or 0), r["project"]))

    return {
        "date": NOW.strftime("%Y-%m-%d"),
        "days": days,
        "tiersAt": tiersAt,
        "tiersErr": tiersErr,
        "tokErr": tokErr,
        "rice": rice,
        "unattributed": (tok or {}).get("unattributed"),
        "totalCalls": (tok or {}).get("totalCalls"),
        "rows": rows,
    }


def render(d):
    L = []
    A = L.append
    A("# 组合视图 · 14 个项目放在一张表里（机器生成 · %s）" % d["date"])
    A("")
    A("> **这份表只做一件事：把四份各说各话的数据 join 起来。**")
    A("> 层级来自 `project-tiers.json`（你排的）· token 来自 `ai-trace.jsonl` · "
      "卡数来自 `task-data/`。")
    A("> **不建新字段、不写任何数据、不替你下判断。**")
    A("")
    A("```")
    A("python scripts/project-portfolio.py            # 打到屏幕")
    A("python scripts/project-portfolio.py --out x.md # 落文件")
    A("python scripts/project-portfolio.py --days 30  # 时间窗")
    A("```")
    A("")
    if d["tiersErr"]:
        A("> ⚠ %s —— 层级列会是空的（**不是「没有核心项目」**，是读不到 tiers）。" % d["tiersErr"])
        A("")

    A("## 0. 一句话")
    A("")
    core = [r for r in d["rows"] if r["tier"] == "核心"]
    core_tok = sum(r["tokens"] for r in core)
    all_tok = sum(r["tokens"] for r in d["rows"])
    if core and all_tok:
        A("**核心 %d 个项目拿了近 %d 天 %d%% 的已归因 token（%d / %d）。**" % (
            len(core), d["days"], round(100.0 * core_tok / all_tok), core_tok, all_tok))
    elif core:
        A("**核心 %d 个项目：%s**。token 列取不到数（见 §局限）。" % (
            len(core), "、".join(r["project"] for r in core)))
    else:
        A("层级读不到，无法判断资源分配。")
    A("")

    A("## 1. 组合总表")
    A("")
    A("按层级排；同层内**吃得多的在前**。 `多久没动` 为空 = 拿不到更新时间（不是「今天动过」）。")
    A("")
    A("| 层级 | 项目 | 未完成卡 | 已完成卡 | 需求池 | 近 %d 天调用 | token | 多久没动 |" % d["days"])
    A("|---|---|---|---|---|---|---|---|")
    for r in d["rows"]:
        age = "—" if r["staleDays"] is None else ("今天" if r["staleDays"] == 0 else "%d 天" % r["staleDays"])
        # 需求池：拿不到就 `—`（**不许写 0**，0 会被读成"真的没有需求"）
        if r.get("riceTotal") is None:
            rd = "—"
        elif r["riceTotal"] == 0:
            rd = "0"
        else:
            rd = "%d/%d已定" % (r["riceTotal"], r.get("riceDecided") or 0)
        A("| %s | `%s` | %d | %d | %s | %d | %s | %s |" % (
            r["tier"] or "（未排）", r["project"], r["open"], r["done"], rd,
            r["calls"], ("%d" % r["tokens"]) if r["calls"] else "0", age))
    A("")

    A("## 2. 需求池")
    A("")
    if d["rice"] is None:
        A("（没有 rice-pool.md）")
    else:
        A("全池 **%d** 条：已决定 **%d** / 未决定 **%d**。" % (
            d["rice"]["total"], d["rice"]["decided"], d["rice"]["undecided"]))
        A("")
        A("| 项目 | 需求条数 | 其中已决定 |")
        A("|---|---|---|")
        for pid, v in sorted((d["rice"]["byProject"] or {}).items(),
                             key=lambda kv: -kv[1]["total"]):
            A("| `%s` | %d | %d |" % (pid, v["total"], v["decided"]))
        if d["rice"].get("unattributed"):
            A("| *（归不到项目）* | %d | — |" % d["rice"]["unattributed"])
            A("")
            A("> 归不到的这几条 `来源` 写成 `external:<名字>`，**本来就没有卡**，"
              "所以反查不到项目 —— 这不是解析失败，是数据本身如此。")
        A("")
        A("> 归因方式：`来源: task:<卡id>` → 反查 `task-data/*.md` 的 `项目:` 字段"
          "（实测 9/11 能反查）。**没有给 rice-pool 加新字段**，只做只读反查。")
    A("")

    A("## 3. token 归因的去向（这个数最容易被读错）")
    A("")
    u = d["unattributed"] or {"calls": 0, "tokens": 0, "cacheRead": 0, "fresh": 0}
    A("| | 调用 | token | 其中缓存读取 | 实际新算 |")
    A("|---|---|---|---|---|")
    A("| 归因到项目 | %d | %d | — | — |" % (
        sum(r["calls"] for r in d["rows"]), sum(r["tokens"] for r in d["rows"])))
    A("| **未归因** | %d | %d | %d | %d |" % (
        u["calls"], u["tokens"], u.get("cacheRead", 0), u.get("fresh", 0)))
    A("")
    A("> **缓存读取不是烧掉的钱。** 长上下文会话每轮都会把整段 prompt 重读一遍，"
      "这部分按供应商口径计入「用量」，但它便宜一到两个数量级。")
    A("")
    if u["tokens"]:
        pct = 100.0 * u.get("cacheRead", 0) / u["tokens"]
        A("> 本轮实测：未归因的 %d token 里 **%.1f%% 是缓存读取**，实际新算约 **%d**。"
          % (u["tokens"], pct, u.get("fresh", 0)))
        A("> 所以「50 亿」和「上个月 80 亿用量」是两个口径的数，**都可能是真的** —— "
          "一个含缓存、一个不含，或者反过来。要对账必须先把口径对齐。")
        A("")
    A("> ⚠ **未归因的大头是外部 agent 上报的**（`external:dsh`），它自带 `card` 的能归，"
      "不带卡的就归不了。所以「某项目 token 少」**不等于它花得少** —— 可能是花在没挂卡的会话上。")
    A("")
    A("> ⚠ **2026-11-15 订正**：我第一版把未归因的 50 亿判成「明显是坏记录」，"
      "暮雨当场质疑「有没有可能真的用了 50 亿」。查完 **他是对的**："
      "372 条记录中位数 476 万/轮，99.1% 是缓存读取。"
      "**「看起来不像真的」不等于「不是真的」——这是我这一轮最该记住的一条。**")
    A("")

    A("## 4. 这张表证明不了什么（必须先看这段）")
    A("")
    A("- **「完成」是自报状态。** 它不等于「真被用起来」（验收通过 / 发布 / 被引用）。"
      "本仓没有那个数据，所以本表不能回答「产出了几件真东西」。")
    A("- **token ≠ 成本。** 没填模型单价的调用只记 token、不折算金额；且不同模型单价差一个量级。")
    A("- **未归因 ≠ 没花。** 见 §3。")
    A("- **卡数 ≠ 工作量。** 一张卡可能三天，也可能是批量导入的占位。")
    A("- **箭头只有这一条是硬的**：层级是你亲手排的（%s）。其余列都是二手。" % (d["tiersAt"] or "时间不详"))
    A("")
    return "\n".join(L) + "\n"


def main():
    days = 30
    if "--days" in sys.argv:
        try:
            days = int(sys.argv[sys.argv.index("--days") + 1])
        except Exception:
            pass
    d = build(days)
    if "--json" in sys.argv:
        print(json.dumps(d, ensure_ascii=False, indent=1, default=str))
        return 0
    md = render(d)
    if "--out" in sys.argv:
        p = sys.argv[sys.argv.index("--out") + 1]
        with open(p, "w", encoding="utf-8") as f:
            f.write(md)
        print("已写入 %s" % p)
        return 0
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
