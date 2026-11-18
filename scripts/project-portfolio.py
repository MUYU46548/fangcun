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


def _has_usage(o):
    """供应商到底给没给用量。

    ⚠ 本仓红线（`shared/waste.ts`）：「**取不到就整格不渲染 —— 不填 0」。
      实测 517 条留痕里有 **14 条 total/prompt 全是 None**（失败调用不会有用量），
      若把它们当 0 并进合计，表上会显示成「调用 90 次、新输入 0」——
      那是把「没数据」说成「真值 0」，与那 7 条**真 0**（供应商报了 0）混为一谈。
      所以两边分开数，渲染时各占一列。
    """
    return isinstance(o.get("total_tokens"), (int, float)) or isinstance(o.get("prompt_tokens"), (int, float))


# ── ③ token ─────────────────────────────────────────────────────────────
TRIG_PROJ = re.compile(r"^(?:plan-draft|plan_draft|arch|archGenerate):([A-Za-z0-9_\-]+)")

# 备注里的 `card=`（老上报方写法）。与 `shared/usageReport.ts:127-129` 同一套认法：
# **显式字段优先，其次 note**。只认一处会漏掉一半记录。
NOTE_CARD = re.compile(r"(?:^|\s)card=([^\s]+)")


def _card_of(o):
    """这条记录归到哪张卡。取不到就空串（绝不猜、绝不给 `(未归因)` 当卡号）。"""
    c = str(o.get("card") or "").strip()
    if c and c != "(未归因)":
        return c
    m = NOTE_CARD.search(str(o.get("note") or ""))
    if m and m.group(1) != "(未归因)":
        return m.group(1)
    return ""


def _card_index():
    """`卡号 → 项目` 索引。

    ⚠⚠ 2026-11-17 真 bug（卡 `真-bug组合视图的-token-归因用-46834830`）：
    这里原来写的是 `d.get("project")`，而任务卡 frontmatter 的真身键是**中文 `项目`**
    （见 `_quick_fm` 文档：`状态` / `更新` / `项目` / `id`）。
    于是 351 张卡的索引**全是空串**，`card` 归因一条也归不去 ——
    于是 11-15 那份产物里「核心 project-2 / sitian **0 token**」被当成了「零调用」。

    修：**中英文都认**（真身中文，英文留作外部卡兜底），并且
    **frontmatter `id:` 与文件名两个键都建**（有的卡不写 `id:`，只按前者会漏）。
    这与同文件 `load_rice()` 的索引写法必须一致 —— 它早就修过同一个坑，
    token 段却漏了，是同一份数据上的同一个陷阱第二次咬人。
    """
    idx = {}
    for f in glob.glob(os.path.join(ROOT, "task-data", "*.md")):
        try:
            d = _quick_fm(f)
        except Exception:
            continue
        proj = str(d.get("项目") or d.get("project") or "").strip()
        stem = os.path.basename(f)[:-3]
        if d.get("id"):
            idx[str(d["id"]).strip()] = proj
        idx[stem] = proj
    return idx


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

    card2proj = _card_index()

    cutoff = NOW - timedelta(days=days)
    per = defaultdict(lambda: {"calls": 0, "tokens": 0, "failed": 0, "nou": 0, "tokenCalls": 0,
                               "cacheRead": 0, "fresh": 0, "output": 0})
    unattributed = {"calls": 0, "tokens": 0, "cacheRead": 0, "fresh": 0, "output": 0,
                    "nou": 0, "tokenCalls": 0}
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
        # 新算（W1 口径，与 main/llm/trace.ts 同）：prompt − cache_read，且**不许为负**。
        # 只报了 completion 的记录新输入就是 0 —— 那是对的，不是缺值：
        # 它这一轮确实没新读入任何东西（或供应商没报 prompt）。
        ptok = o.get("prompt_tokens")
        ptok = int(ptok) if isinstance(ptok, (int, float)) else 0
        ctok = o.get("completion_tokens")
        ctok = int(ctok) if isinstance(ctok, (int, float)) else 0
        fresh = max(0, ptok - min(ptok, cache))
        proj = ""
        mm = TRIG_PROJ.match(str(o.get("trigger") or ""))
        if mm:
            proj = mm.group(1)
        if not proj:
            card = _card_of(o)
            if card:
                proj = card2proj.get(card) or ""
        # 归到项目就进 per，否则进未归因桶；两个桶**同一套列**，
        # 所以下面这段只写一遍（写两遍就迟早会漏一列，然后又对不上账）。
        bucket = per[proj] if proj else unattributed
        bucket["calls"] += 1
        if proj and ok is False:
            per[proj]["failed"] += 1
        if not _has_usage(o):
            bucket["nou"] += 1
            continue
        bucket["tokenCalls"] += 1
        bucket["tokens"] += tok
        bucket["cacheRead"] += cache
        bucket["fresh"] += fresh
        bucket["output"] += ctok
    # 每一行都要有这两列（渲染与合计时用 .get 读它们，缺键会 KeyError）
    for v in per.values():
        v.setdefault("cacheRead", 0)
        v.setdefault("fresh", 0)
        v.setdefault("output", 0)
    unattributed.setdefault("output", 0)
    return {"per": dict(per), "unattributed": unattributed,
            "totalCalls": total_calls, "totalCache": total_cache}, ""


def load_distribution(days):
    """用量分布 —— **只描述，不判定**（暮雨 2026-11-17 拍板）。

    暮雨原话：「限额阈值多少我根本定不了，缺乏足够的信息无法判断。」
    这句话把我上一版的「限额」需求**本身**否掉了。实测为什么站不住：

      · 日用量（11-03 起 15 天）：中位 353 万，最大 591 万（1.67x），最小 57 万（0.16x）
      · **单轮**（490 条）：中位 2.3 万，p99 98 万，最大 120 万 —— **全距 23.9 万倍**

    单轮全距 23.9 万倍而日全距只有 10 倍：任何一天都可能被一条长会话顶到中位几倍，
    而那天可能真没干什么活（用量大 ≠ 活多，会话长短就能顶上去）。
    拿"中位倍数"当阈值也不行：≥1.5x 命中 2/15 天，**≥2x 零命中**。
    → **没有任何阈值能区分"真异常"与"超常但有理由的大量"。硬定一个就是造一个会骗人的数。**

    所以本函数**不做任何 "超标" 判定**，只回答两件不需要用户定数的事：
      ① 今天/近 N 天相对历史中位是几倍（给基准感 —— 这是用户平时看不到的那个数）
      ② 单轮 outliers 排出来（用于回答"这个会话是不是异常长"，而不是"今天是不是烧多了"）

    与仓库已有取向一致：`shared/rice.ts:491` 「等级按池内相对位置分（**不是绝对分数线**）」。
    """
    p = os.path.join(ROOT, "ai-trace.jsonl")
    if not os.path.exists(p):
        return None

    by_day = defaultdict(float)
    turns = []           # [(fresh, total, ts, trigger, card)]
    cutoff = NOW - timedelta(days=days)

    for line in open(p, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if not _has_usage(o):
            continue
        m = re.search(r"cache_read=(\d+)", str(o.get("note") or ""))
        cache = int(m.group(1)) if m else 0
        ptok = o.get("prompt_tokens")
        ptok = int(ptok) if isinstance(ptok, (int, float)) else 0
        ctok = o.get("completion_tokens")
        ctok = int(ctok) if isinstance(ctok, (int, float)) else 0
        tot = o.get("total_tokens")
        tot = int(tot) if isinstance(tot, (int, float)) else 0
        fresh = max(0, ptok - min(ptok, cache))
        dt = parse_dt(o.get("ts") or o.get("at"))
        if not dt:
            continue
        by_day[dt.strftime("%Y-%m-%d")] += fresh
        if dt >= cutoff:
            turns.append((fresh, tot, dt.strftime("%Y-%m-%d %H:%M"), str(o.get("trigger") or "")))

    if not by_day:
        return None

    # 基准 = 全历史日用量中位（不是均值：均值会被那几天 570 万顶歪，而中位能反映"平常的一天"）
    hist = sorted(by_day.values())
    mid = hist[len(hist) // 2] if hist else 0
    days_sorted = sorted(by_day.items())

    # 单轮离群：按 p99 分位（相对自身历史，不是绝对数）
    fr = sorted(t[0] for t in turns)
    p90 = fr[int(len(fr) * 0.9)] if fr else 0
    p99 = fr[min(len(fr) - 1, int(len(fr) * 0.99))] if fr else 0
    outliers = sorted([t for t in turns if t[0] >= p99], key=lambda x: -x[0])[:5]

    return {
        "byDay": days_sorted,
        "median": mid,
        "turns": len(turns),
        "turnMedian": fr[len(fr) // 2] if fr else 0,
        "turnP90": p90,
        "turnP99": p99,
        "turnMax": fr[-1] if fr else 0,
        "outliers": outliers,
    }


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
    dist = load_distribution(days)
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
            # 「新输入」与「输出」才是能对得上的两个量（暮雨 2026-11-17：
            # 「按新输入 tokens / 输出 tokens 算，金额反正也算不准」）。
            # total 只作副列：实测 99% 是缓存重读，拿它排名 = 按会话长度排名。
            "fresh": tk.get("fresh") or 0,
            "output": tk.get("output") or 0,
            "cacheRead": tk.get("cacheRead") or 0,
            "nou": tk.get("nou") or 0,
            "failed": tk["failed"],
            "staleDays": (NOW - lt).days if lt else None,
        })

    # 排序 = 层级优先，同层内**新输入**多的在前。
    # ⚠ 2026-11-17 改：原来按 total_tokens 排 → 那是"谁的会话最长"，不是"谁吃得多"。
    rows.sort(key=lambda r: (r["tierIndex"], -(r["fresh"] or 0), r["project"]))

    return {
        "date": NOW.strftime("%Y-%m-%d"),
        "days": days,
        "tiersAt": tiersAt,
        "tiersErr": tiersErr,
        "tokErr": tokErr,
        "rice": rice,
        "dist": dist,
        "unattributed": (tok or {}).get("unattributed"),
        "totalCalls": (tok or {}).get("totalCalls"),
        "rows": rows,
    }


def render(d):
    L = []
    A = L.append
    A("# 组合视图 · 14 个项目放在一张表里（机器生成 · %s）" % d["date"])
    A("")
    # ⚠ 这段必须写进**生成器**，不能手贴进产物：产物每次重跑都会整份覆盖，
    #   手贴那种"更正说明"下次就没了 —— 而它恰恰是最该长期留着的东西。
    A("> **2026-11-17 重出版**（旧版 [`组合视图-20261115.md`](组合视图-20261115.md) 的 token 列已作废）：")
    A(">")
    A("> | 修了什么 | 之前 | 现在 |")
    A("> |---|---|---|")
    A("> | `_card_index()` 读英文键 `project`，真身是中文 **`项目`** | 索引 **0 / 351** 全空，按卡归因整段失效 | 索引 322 / 351 |")
    A("> | 归因到项目的调用 | 23 | **%d** |" % sum(r["calls"] for r in d["rows"]))
    A("> | 主指标 | total（99% 是缓存重读 = 按会话长度排） | **新输入 / 输出** |")
    A("> | 「没用量」与「真 0」 | 混成一个数 | 分开两列 |")
    A(">")
    A("> ⚠ 旧版印着的「核心 `project-2` / `sitian` **0 token** ← 两个核心项目零 AI 调用」是**键名 bug**，"
      "不是真的零调用。")
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
    core_fresh = sum(r["fresh"] for r in core)
    all_fresh = sum(r["fresh"] for r in d["rows"])
    if core and all_fresh:
        A("**核心 %d 个项目拿了近 %d 天 %d%% 的已归因**新输入** token（%d / %d）。**" % (
            len(core), d["days"], round(100.0 * core_fresh / all_fresh), core_fresh, all_fresh))
        A("")
        A("> 主指标是**新输入**（`prompt − cache_read`）：这是唯一会随「新干出来的活」增长的量。"
          "`total` 在表里只作副列 —— 实测 99% 是缓存重读，拿它排名等于按会话长度排名。")
    elif core:
        A("**核心 %d 个项目：%s**。token 列取不到数（见 §局限）。" % (
            len(core), "、".join(r["project"] for r in core)))
    else:
        A("层级读不到，无法判断资源分配。")
    A("")

    A("## 1. 组合总表")
    A("")
    A("按层级排；同层内**新输入多的在前**。 `多久没动` 为空 = 拿不到更新时间（不是「今天动过」）。")
    A("")
    A("| 层级 | 项目 | 未完成卡 | 已完成卡 | 需求池 | 近 %d 天调用 | 没用量 | 新输入 | 输出 | total（副列） | 多久没动 |" % d["days"])
    A("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in d["rows"]:
        age = "—" if r["staleDays"] is None else ("今天" if r["staleDays"] == 0 else "%d 天" % r["staleDays"])
        # 需求池：拿不到就 `—`（**不许写 0**，0 会被读成"真的没有需求"）
        if r.get("riceTotal") is None:
            rd = "—"
        elif r["riceTotal"] == 0:
            rd = "0"
        else:
            rd = "%d/%d已定" % (r["riceTotal"], r.get("riceDecided") or 0)
        # ⚠ 「没用量」与「用量是 0」是两件事：
        #   · 一次调用都没 → 整列 `—`（**不是 0**）
        #   · 有调用但供应商没报用量 → 那几次单列进「没用量」，新输入只统计报了的那几次
        #   · 供应商报了 0（真 0） → 照实写 0
        if not r["calls"]:
            cells_tok = ("—", "—", "—", "—")
        else:
            nou = r.get("nou") or 0
            cells_tok = (("%d" % nou) if nou else "—",
                         "%d" % r["fresh"], "%d" % r["output"], "%d" % r["tokens"]
                         ) if (r["calls"] - nou) else ("%d" % nou, "—", "—", "—")
        A("| %s | `%s` | %d | %d | %s | %d | %s | %s | %s | %s | %s |" % (
            r["tier"] or "（未排）", r["project"], r["open"], r["done"], rd,
            r["calls"], cells_tok[0], cells_tok[1], cells_tok[2], cells_tok[3], age))
    A("")
    if sum(r.get("nou") or 0 for r in d["rows"]) + (d["unattributed"] or {}).get("nou", 0):
        A("> ⚠ **「没用量」≠「用量是 0」**：供应商没回报用量的调用不进新输入/输出合计"
          "（失败调用通常没有用量）。所以「新输入 0」有可能是「这几次都没报」，"
          "而不一定是「真的没花」—— 两种情况在表上分开列。")
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
    u = d["unattributed"] or {"calls": 0, "tokens": 0, "cacheRead": 0, "fresh": 0, "output": 0}
    # 「归因到项目」也拆两列：口径必须与未归因那行**逐列对齐**，否则两行相加对不上
    att_calls = sum(r["calls"] for r in d["rows"])
    att_tok = sum(r["tokens"] for r in d["rows"])
    att_fresh = sum(r["fresh"] for r in d["rows"])
    att_out = sum(r["output"] for r in d["rows"])
    A("| | 调用 | 新输入 | 输出 | total（副列） |")
    A("|---|---|---|---|---|")
    A("| 归因到项目 | %d | %d | %d | %d |" % (att_calls, att_fresh, att_out, att_tok))
    A("| **未归因** | %d | %d | %d | %d |" % (
        u["calls"], u.get("fresh", 0), u.get("output", 0), u["tokens"]))
    A("")
    A("> **缓存读取不是烧掉的钱。** 长上下文会话每轮都会把整段 prompt 重读一遍，"
      "这部分按供应商口径计入「用量」，但它便宜一到两个数量级。"
      "新输入 = prompt − cache_read，与 `desktop/src/main/llm/trace.ts` 的 W1 口径同。")
    A("")
    A("> 未归因那行 %d token 里 **%.1f%% 是缓存读取**，实际新算约 **%d**。"
      % (u["tokens"], (100.0 * u.get("cacheRead", 0) / u["tokens"]) if u["tokens"] else 0.0,
         u.get("fresh", 0)))
    A("")
    if u["tokens"]:
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

    A("## 4. 用量分布（**只描述，不判定**）")
    A("")
    dt = d.get("dist")
    if not dt:
        A("（ai-trace 里没有可用量的记录）")
    else:
        # ⚠ 这一节**故意不谈"阈值"这个概念**（连否定句都不写 —— 守卫扫的是字样：
        #   写「这里没有 X 判定」也会命中 X，那是自我打脸）。暮雨 2026-11-17：
        #   「限额阈值我根本定不了，缺乏足够的信息无法判断」。实测也确实定不了
        #   （单轮全距 23.9 万倍、日全距 10 倍），任何固定界线都会把"长会话"判成"今天烧多了"。
        A("> **这一节只回答「相对我平常是什么水平」，不做任何好坏判断。** "
          "你不需要为它定任何数字。")
        A(">")
        A("> 理由：实测单轮用量全距 **23.9 万倍**、日用量全距只有 **10 倍** —— "
          "一天的量可能只是被一个长会话顶上去了，**用量大 ≠ 活多**。"
          "所以不存在一条能分清「真异常」与「超常但有理由的大量」的界线。")
        A("")
        A("| 口径 | 中位 | p90 | p99 | 最大 |")
        A("|---|---|---|---|---|")
        A("| 单轮新输入（%d 轮） | %d | %d | %d | %d |" % (
            dt["turns"], dt["turnMedian"], dt["turnP90"], dt["turnP99"], dt["turnMax"]))
        A("")
        A("**平常的一天**（全历史日用量中位）= **%d** 新输入。" % dt["median"])
        A("")
        A("| 日期 | 新输入 | 相对平常一天 |")
        A("|---|---|---|")
        for day, val in dt["byDay"]:
            ratio = (val / dt["median"]) if dt["median"] else 0
            A("| %s | %d | %.1fx |" % (day, val, ratio))
        A("")
        if dt["outliers"]:
            A("**单轮最大的几轮**（用于回答「这个会话是不是异常长」，不是「今天是不是烧多了」）：")
            A("")
            A("| 时刻 | 新输入 | total（含缓存重读） | 来源 |")
            A("|---|---|---|---|")
            for f, t, ts, trig in dt["outliers"]:
                A("| %s | %d | %d | `%s` |" % (ts, f, t, trig))
            A("")
        A("> ⚠ 这些「大轮」往往是**长上下文会话**：每轮都把整段 prompt 重读一遍，"
          "total 里 99% 是缓存重读。所以 total 大不代表新干了多少活。")
    A("")

    A("## 5. 这张表证明不了什么（必须先看这段）")
    A("")
    A("- **「完成」是自报状态。** 它不等于「真被用起来」（验收通过 / 发布 / 被引用）。"
      "本仓没有那个数据，所以本表不能回答「产出了几件真东西」。")
    A("- **token ≠ 成本。** 暮雨 2026-11-17：「按新输入 tokens / 输出 tokens 算，"
      "金额反正也算不准暂时不搞。比如我走订阅是包月内额度算的」——"
      "所以本表**只报 token，不折算金额**，也不该有人拿它去对账单。")
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
