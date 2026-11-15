#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""未完成内容总清单 · 生成器（2026-11-15）

暮雨：「总结方寸所有未完成内容（你真能总结得完吗？估计得有几百条了），以便后续接力施工」。

那个反问就是需求本身。手写几百条**一定会漏**，而且漏了没人知道 —— 所以这份清单由脚本生成：
**每一条都从真身（task-data / docs/执行日志 / questionnaires / plans）里算出来**，不靠回忆。

四类来源，各自一条不漏：
  ① 未完成卡（状态 ≠ 完成/驳回）—— 带项目、状态、多久没动、卡自己说的缺口
  ② 日志「下一步」里提了但没接的条目（复用 audit-log-nextsteps 的判定，不另写一套）
  ③ 问卷：没答完 / 答完没批 / 批了没落卡
  ④ 计划卡：草案待提成 / 阶段待裁决 / 已冻结未推进

输出 Markdown，按项目分组，每条带**出处**（卡 id / 日志 id / 文件）。
脚本**只读**：不写任务卡、不改任何数据。

用法：
  python scripts/inventory-unfinished.py                  # 打到 stdout
  python scripts/inventory-unfinished.py --out docs/x.md  # 落文件
  python scripts/inventory-unfinished.py --check          # 只报数目；非零退出 = 还有未完成
"""
import sys
import os
import re
import json
import glob
import subprocess
from datetime import datetime, timezone, timedelta
from collections import Counter, defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# `FC_INV_ROOT` 让测试能在临时数据根上跑（原地跑脚本，但换数据）——
# 为什么不是"把脚本复制到临时目录"：它靠 `脚本目录的上级` import `tegula.core`，搬走就 import 不到。
ROOT = os.environ.get("FC_INV_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tegula.core as core  # noqa: E402

TZ = timezone(timedelta(hours=8))
NOW = datetime.now(TZ)
DONE_STATUSES = {"完成", "驳回"}


def rel(path):
    return os.path.relpath(path, ROOT).replace("\\", "/")


def days_since(iso):
    """ISO / 秒级 / 毫秒都认；认不出给 None（不猜 0 —— 0 会变成"1970 年晾了两万年"）"""
    if not iso:
        return None
    s = str(iso).strip()
    try:
        if re.fullmatch(r"\d+", s):
            n = int(s)
            if n > 1e12:
                n //= 1000
            dt = datetime.fromtimestamp(n, TZ)
        else:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=TZ)
        return max(0, (NOW - dt).days)
    except Exception:
        return None


def age_label(iso):
    d = days_since(iso)
    if d is None:
        return "时间不详"
    if d == 0:
        return "今天动过"
    return "%d 天没动" % d


# ── ① 未完成卡 ──────────────────────────────────────────────────────────
# "它自己说的缺口"认两种写法，**按可靠性排序**：
#   ① `- [ ] xxx` 未勾选项 —— 本仓最硬的一种（方案节里就是它，能机检）
#   ② `还欠：xxx` / `没做：xxx` 这类显式句子
# ⚠ 第一版只认 ②，于是整张表"缺口"列**全是 —**，而清单看起来照样正常。
#   真身里绝大多数缺口是 ①（`- [ ] 3) 全链截图 + 真实 Electron：未做。`），
#   不是"还欠"这两个字 —— 这类"抓错形态"和字段名写错是同一个病。
RE_TODO = re.compile(r"^\s*[-*]\s*\[\s*\]\s*(.+)$")
RE_GAP = re.compile(
    r"^(?:[-*]\s*)?(?:\*\*)?(?:还欠|没做|未做|没完成|欠着|还差)(?:\*\*)?[:：]?\s*(.+)$"
)


def extract_gaps(body, title=""):
    """卡正文里的**可执行缺口** —— 只回两样东西：未勾选项条数 + 最具体的那一条。

    ⚠ 这里试过三版，前两版都是错的，记下来免得下一个人重走：
      ① 只认 `还欠：/没做：` 这类句子 → 真身里几乎没有这种写法，整列全空；
      ② 连 `- [ ]` 全收 → 账本卡方案节第一条就是标题本身，整列变成**复述标题**；
         再剔掉复述后，剩下的又多是 `出处：账本 B 表…` 这种**bookkeeping**，比空还误导。
    现在只信一个数：**未勾选项有几条**（这个数是硬的：`- [ ]` 就是没做）。
    再附一条"最像干活"的（排除出处/备注类），没有就只给数。

    返回 (未勾条数, 代表性一条)
    """
    todos = []
    noise = re.compile(r"^(?:出处|来源|备注|注|参考|依据|快照|判据见|引用)")
    for line in str(body or "").split("\n"):
        m = RE_TODO.match(line)
        if not m:
            continue
        t = m.group(1).strip()
        if len(t) >= 4:
            todos.append(t[:200])
    pick = ""
    for t in todos:
        if noise.match(t):
            continue
        # 复述标题的跳过
        nt = re.sub(r"[\s\W_]+", "", t)[:60]
        nl = re.sub(r"[\s\W_]+", "", str(title or ""))[:120]
        if nt and nl and (nt in nl or nl in nt):
            continue
        pick = t
        break
    return len(todos), pick


def collect_cards():
    out = []
    for f in sorted(glob.glob(os.path.join(ROOT, "task-data", "*.md"))):
        d = core.parse_task(f)
        if not d:
            continue
        st = str(d.get("状态") or "").strip()
        if st in DONE_STATUSES:
            continue
        p = d.get("项目")
        pid = (p[0] if isinstance(p, list) and p else (str(p) if p else "")) or "(未归属)"
        tid = str(d.get("id") or os.path.basename(f)[:-3])
        body = str(d.get("_body") or "")
        # ⚠ 字段名是 `更新`（不是 `更新时间` / `updated`）—— 第一版按英文字段名取，
        #   于是整张表"多久没动"**全部显示"时间不详"**，而清单看起来完全正常。
        #   这种"字段名写错、输出照样成型"的错必须由断言兜住（见 --check 的自检）。
        upd = d.get("更新") or d.get("更新时间") or d.get("updated") or ""
        out.append({
            "id": tid, "file": rel(f), "title": str(d.get("标题") or ""),
            "status": st, "project": pid,
            "age": age_label(upd), "ageDays": days_since(upd),
            "gaps": extract_gaps(body, str(d.get("标题") or "")),
        })
    return out


# ── ② 日志「下一步」没接的 ─────────────────────────────────────────────
def collect_log_items():
    """读 audit-log-nextsteps 的 JSON —— **只用 JSONDecoder.raw_decode**。

    ⚠ 那个脚本在 `--json` 之后**还会打印人类可读的尾巴**（"（另有 711 条…）"之类），
      直接 `json.loads(raw[start:])` 会 `Extra data` 报错，然后被 except 吞掉 →
      这份清单里日志一栏静默变成 0 条。第一版就是这么错的：**0 条不报红，只是看起来"没欠账"**。
    """
    try:
        p = subprocess.run(
            ["node", os.path.join(ROOT, "scripts", "audit-log-nextsteps.cjs"), "--check", "--json"],
            cwd=ROOT, capture_output=True, timeout=180,
        )
        raw = (p.stdout or b"").decode("utf-8", "replace")
        start = raw.find("{")
        if start < 0:
            return [], "没有 JSON 输出（脚本可能改了口径）"
        j, _end = json.JSONDecoder().raw_decode(raw[start:])
        if isinstance(j, list):
            j = {"items": j}
    except Exception as e:
        return [], "读不到（%s）" % e
    items = [x for x in j.get("items", []) if not x.get("covered") and not x.get("disposed")]
    return items, ""


# ── ③ 问卷 ──────────────────────────────────────────────────────────────
def collect_decks():
    """问卷待办。**只收真正的卷**，并按"卡在哪一步"分开说。

    ⚠ 第一版两个错（都在这份清单里露出来了）：
      ① `*.decision-log.md` 被当成卷 —— 那是决策日志，不是问卷；于是每卷被计算两遍
         （`X.decision-log` 0/0 "答完没批" + `X` 已批准），表翻倍且全是假行；
      ② "已批准但 deliveries=0" 一律报"一条都没落成卡" —— 但**很多卷本来就不需要落卡**
         （宪法层 / 选型卷的产物是决策，不是任务）。统一报红就是制造假欠账。
    现在：只认 `*.md`（排除 `.decision-log`），落卡状态只说**事实**（0 条交付），
    不替它下"这算欠账"的判断 —— 判断留给人在 §7 里做。
    """
    out = []
    qdir = os.path.join(ROOT, "task-data", "questionnaires")
    for f in sorted(glob.glob(os.path.join(qdir, "*.md"))):
        deck = os.path.basename(f)[:-3]
        if deck.endswith(".decision-log"):
            continue
        try:
            txt = open(f, encoding="utf-8").read()
        except Exception:
            continue
        total = len(re.findall(r"(?m)^##\s+[A-Za-z]+\d+\s", txt))
        ans_p = os.path.join(qdir, deck + ".answers.json")
        answered = 0
        approved_at = ""
        voided = False
        deliveries = 0
        if os.path.exists(ans_p):
            try:
                a = json.load(open(ans_p, encoding="utf-8"))
                answered = len(a.get("answers") or {})
                approved_at = str(a.get("approvedAt") or "")
                voided = bool(a.get("voidedAt"))
                deliveries = sum(len(v or []) for v in (a.get("deliveries") or {}).values())
            except Exception:
                pass
        if voided or total == 0:
            continue
        todo = ""
        if answered < total:
            todo = "没答完（%d/%d）" % (answered, total)
        elif not approved_at:
            todo = "答完了但没批准"
        # 已批准且答完：**不算欠账**，只在下面单独计数（它不是"没做完"，是"可选的下一步"）
        if todo:
            out.append({"deck": deck, "total": total, "answered": answered,
                        "todo": todo, "file": rel(f)})
    return out


def count_approved_undelivered():
    """已批准但零交付的卷（**单独统计，不混进欠账**）"""
    n = 0
    qdir = os.path.join(ROOT, "task-data", "questionnaires")
    for f in sorted(glob.glob(os.path.join(qdir, "*.answers.json"))):
        deck = os.path.basename(f)[:-len(".answers.json")]
        if deck.endswith(".decision-log"):
            continue
        try:
            a = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        if a.get("voidedAt"):
            continue
        if not a.get("approvedAt"):
            continue
        deliveries = sum(len(v or []) for v in (a.get("deliveries") or {}).values())
        if deliveries == 0:
            n += 1
    return n


# ── ④ 计划卡 ────────────────────────────────────────────────────────────
def collect_plans():
    out = []
    drafts_dir = os.path.join(ROOT, "task-data", "plans", "_drafts")
    for f in sorted(glob.glob(os.path.join(drafts_dir, "*.md"))):
        out.append({"kind": "草案待提成", "file": rel(f), "id": os.path.basename(f)})
    for f in sorted(glob.glob(os.path.join(ROOT, "task-data", "plans", "*.md"))):
        try:
            txt = open(f, encoding="utf-8").read()
        except Exception:
            continue
        for cid, title in re.findall(r"(?m)^###\s+(P\d+)\s*·\s*(.+)$", txt):
            seg = txt.split("### %s ·" % cid, 1)[-1]
            m = re.search(r"(?m)^-\s*状态:\s*(.+)$", seg)
            st = (m.group(1).strip() if m else "")
            if st in ("待裁决", "未冻结", "待裁决（未冻结）"):
                out.append({"kind": "阶段待裁决", "file": rel(f), "id": "%s %s" % (cid, title)})
            elif st == "已冻结":
                out.append({"kind": "已冻结未推进", "file": rel(f), "id": "%s %s" % (cid, title)})
    return out


# ── 手写段落（模块级三引号：避免内层引号把代码绊住）────────────────────
SECTION6 = """\
- **规划能力仍是雏形**：`方寸` 的作战计划 P0–P11 全绿，但**只有 4 个项目有计划卡**
  （fangcun / sitian / project-3 / memory-sanctuary），剩 10 个项目没有 —— 而它们不是
  「方寸不会写」，是**没有已批准的裁决卷**（闸在卷上，不在能力上）。
- **判据这个概念仍然要人解释**：已做「每条一句人话」，但它仍是技术概念；
  要彻底不需要解释，得动「作战计划」这个产品形态本身 —— 那是决策，不是改样式。
- **每个项目的前端都很差**（暮雨原话，第三次提）：本轮只消了具体那两处，没有整体重做视觉。
- **AI 规划零单**：REV-009 已把方向改成「生成式智能（agent 级）」，
  但**一次真单都没跑通到落卡**（`task-20261025-009` 一直挂在待办，状态不明）。
- **13 个项目没有图标**（`p2-1-品牌资产…`）：这是各项目自己的活 —— 契约写明方寸对 repo 只读。
- **处置过不等于核实过**：711 条已逐条处置里，`非本项目` 占 308（41%）、`已转卡` 224。
  这个比例本身值得怀疑 —— 一条内容被反复归成「不是这个项目的」，可能是归类口径太松。
  判据：随机抽 20 条 `非本项目` 复核，若超过 5 条其实相关，就是口径松了。
- **8 张「结构地图更新」卡**（每个项目一张）：它们只是「该核实了」的提醒，
  `smap_apply` 需要人签字 —— 也就是说这 8 张全部**卡在等人点头**，不是卡在施工。
- **`_drafts/` 里 8 份草案躺了 3–13 天没人提成**：草案是 agent 写的，提成权在用户；
  它们不算欠账，但它们是「离能用只差一次点击」的东西 —— 最该优先清。""".split("\n")

SECTION7 = """\
**不要从「最老的那张卡」开始。** 顺序建议按「卡住别人的程度」：

1. **先看 §3 问卷** —— 卡住的每一份卷都在**挡住一个项目的规划**。答完 + 批准，下游才有东西可派。
2. **再看 §4 计划卡** —— 草案待提成 / 阶段待裁决，都是「点一下就能往前走」的东西。
3. **然后才是 §1 未完成卡** —— 按项目分，**先挑那个项目自己最痛的三张**，别平铺。
4. **§2 日志欠账最后做** —— 它多是零散诉求；而且「非本项目」占比异常，先怀疑归类口径。""".split("\n")

SECTION7_TAIL = """\
> ⚠ 三个**不要**：不要一次全做（这些条数会把你埋了）；不要把「已转卡」当成「已解决」；
> 不要为了减少数字去改状态。""".split("\n")

GUARD_NAMES = (
    "check-ui-copy", "check-ui-freeze", "check-ui-base", "check-themes",
    "check-button-styles", "check-button-heights", "check-ipc-parity",
    "check-template-bindings", "check-skills", "check-composable-exports",
)


def run_guards():
    """跑快守卫。⚠ 结果行有两种格式，都要认：
      · `RESULT 22 / 0`（多数 check-*.cjs）
      · `通过 22 / 失败 0`（check-themes / check-button-styles / check-ipc-parity 等）
    第一版只认前者，于是那几个守卫在清单里永远显示"未跑到结果行" ——
    **看起来像"这个守卫不存在"，其实是解析漏了一种写法**（同类的"抓错形态"第 N 次）。
    """
    out = []
    for name in GUARD_NAMES:
        try:
            p = subprocess.run(["node", os.path.join(ROOT, "scripts", "test", name + ".cjs")],
                               cwd=ROOT, capture_output=True, timeout=180)
            txt = (p.stdout or b"").decode("utf-8", "replace")
            m = re.search(r"RESULT\s+(\d+)\s*/\s*(\d+)", txt)
            if not m:
                m = re.search(r"通过\s+(\d+)\s*/\s*失败\s+(\d+)", txt)
            if m:
                out.append((name, int(m.group(1)), int(m.group(2))))
            else:
                out.append((name, -1, -1))
        except Exception:
            out.append((name, -1, -1))
    return out


def build():
    cards = collect_cards()
    log_items, log_err = collect_log_items()
    decks = collect_decks()
    plans = collect_plans()
    guards = run_guards()
    undelivered = count_approved_undelivered()

    # ── 自检：空值不许静默"看起来没问题" ────────────────────────────────
    # 这一类错本仓栽过多次：字段名写错 → 整列变成"时间不详"→ 输出照样成型 → 没人发现。
    # 判据：**能算出时间的卡必须占多数**（真数据里绝大多数卡都有 `更新:`）。
    # 低于一半就显式红，并在清单顶部点名 —— 不许"清单生成了就算成功"。
    with_age = [c for c in cards if c["ageDays"] is not None]
    age_ratio = (len(with_age) / len(cards)) if cards else 1.0
    warn = []
    if cards and age_ratio < 0.5:
        warn.append("**%d/%d 张卡算不出「多久没动」** —— 多半是字段名又写错了（数据里的键是 `更新:`）。"
                    "这一列现在不可信。" % (len(cards) - len(with_age), len(cards)))
    if log_err:
        warn.append("日志「下一步」读不到：%s" % log_err)
    if not log_items and not log_err:
        warn.append("日志「下一步」解析出 **0 条** —— 真数据里至少该有几条；"
                    "0 条不报红，只是看起来「没欠账」。")

    by_proj = defaultdict(list)
    for c in cards:
        by_proj[c["project"]].append(c)

    total = len(cards) + len(log_items) + len(decks) + len(plans)
    own = len(by_proj.get("fangcun-base", []))

    L = []
    A = L.append
    A("# 方寸 · 未完成内容总清单（机器生成 · 2026-11-15）")
    A("")
    A("> 暮雨问「**你真能总结得完吗？估计得有几百条了**」。")
    A("> 所以这份清单**不是我手写的** —— 手写几百条一定会漏，而且漏了没人知道。")
    A("> 它由 `scripts/inventory-unfinished.py` 从真身算出来：**每一条都能追到卡 / 日志 / 文件**。")
    A("> 改动数据后重跑即刷新；**脚本只读**，不写任务卡、不改任何数据。")
    A("")
    A("```")
    A("python scripts/inventory-unfinished.py                  # 重新生成（打到屏幕）")
    A("python scripts/inventory-unfinished.py --out docs/未完成总清单-20261115.md")
    A("python scripts/inventory-unfinished.py --check          # 只报数目；非零退出 = 还有未完成")
    A("```")
    A("")
    if warn:
        A("## ⚠ 生成时的自检警告（先看这个）")
        A("")
        for w in warn:
            A("- " + w)
        A("")
        A("> 判据：**清单生成成功 ≠ 清单是对的**。上面任一条成立时，这份清单的可信度要打折。")
        A("")
    A("## 0. 一共多少条")
    A("")
    A("| 来源 | 条数 | 说明 |")
    A("|---|---|---|")
    A("| 未完成卡 | **%d** | 状态 ≠ 完成/驳回（真身：`task-data/*.md`） |" % len(cards))
    A("| 日志「下一步」没接的 | **%d** | 提了但既没卡接、也没逐条处置 |" % len(log_items))
    A("| 问卷待办 | **%d** | 没答完 / 答完没批 / 批了没落卡 |" % len(decks))
    A("| 计划卡待办 | **%d** | 草案待提成 / 阶段待裁决 / 已冻结未推进 |" % len(plans))
    A("| **合计** | **%d** | 还没算 §6 那些「脚本读不出来的」 |" % total)
    A("")
    A("> 其中**方寸自己**只有 %d 条；其余 %d 条是别的项目的 —— "
      "方寸是它们的入口，但不是它们的施工队。" % (own, total - own))
    A("")

    # ── 按项目 ──
    A("## 1. 未完成卡 · 按项目（%d 张）" % len(cards))
    A("")
    A("按「多少天没动」降序 —— **最久没动的不一定最急，但一定最容易被忘**。")
    A("")
    for pid, items in sorted(by_proj.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        A("### %s · %d 张" % (pid, len(items)))
        A("")
        A("| 卡 | 状态 | 多久没动 | 正文里未勾的项 |")
        A("|---|---|---|---|")
        items_sorted = sorted(items, key=lambda c: (-(c["ageDays"] if c["ageDays"] is not None else -1), c["id"]))
        for c in items_sorted:
            ntodo, pick = c["gaps"]
            gap = ("%d 项未勾" % ntodo) if ntodo else ""
            if pick:
                gap += ("：" if gap else "") + pick
            A("| `%s` %s | %s | %s | %s |" % (
                c["id"], c["title"].replace("|", "/"), c["status"], c["age"],
                (gap.replace("|", "/")[:130] or "—")))
        A("")

    # ── 日志 ──
    A("## 2. 日志「下一步」· 提了但没人接（%d 条）" % len(log_items))
    A("")
    if log_err:
        A("> ⚠ %s" % log_err)
        A("")
    A("这 %d 条是真欠账：**既没有一张未完成卡在接，也没有逐条处置标记**。" % len(log_items))
    A("处置写法（写进原日志的「下一步」里）：`@序号 已做 / 已放弃 / 已转卡#id / 非本项目 / 已核实`。")
    A("")
    if log_items:
        A("| 日志 | 第几条 | 下一步原文 |")
        A("|---|---|---|")
        for it in log_items:
            nxt = str(it.get("next") or "").replace("\n", " ").replace("|", "/")[:220]
            A("| `%s` %s | %s/%s | %s |" % (it.get("log", ""), it.get("title", ""),
                                           it.get("n", 1), it.get("total", 1), nxt))
    A("")

    # ── 问卷 ──
    A("## 3. 问卷 · 还有事要做的卷（%d 份）" % len(decks))
    A("")
    if decks:
        A("| 卷 | 进度 | 卡在哪 |")
        A("|---|---|---|")
        for d in decks:
            A("| `%s` | %d/%d | %s |" % (d["deck"], d["answered"], d["total"], d["todo"]))
    else:
        A("（没有卡住的卷）")
    A("")
    A("> 另有 **%d 份已批准、零交付**的卷 —— **不算欠账**（宪法层 / 选型卷的产物是决策，不是任务卡），"
      "但如果你想让它落成卡，那是可选的下一步。" % undelivered)
    A("")

    # ── 计划 ──
    A("## 4. 计划卡 · 待办（%d 项）" % len(plans))
    A("")
    if plans:
        for k, n in Counter(p["kind"] for p in plans).most_common():
            A("- **%s**：%d 项" % (k, n))
        A("")
        A("| 类型 | 计划卡 | 哪一格 |")
        A("|---|---|---|")
        for p in plans:
            A("| %s | `%s` | %s |" % (p["kind"], p["file"], p["id"]))
    else:
        A("（没有待办的计划卡）")
    A("")

    # ── 守卫 ──
    A("## 5. 代码层：守卫现在的状态")
    A("")
    A("| 守卫 | 结果 |")
    A("|---|---|")
    for name, ok, bad in guards:
        state = "未跑到结果行" if ok < 0 else ("**全绿**" if bad == 0 else "**红 %d 条**" % bad)
        A("| `%s` | %s |" % (name, state))
    A("")
    A("⚠ 这里只跑「快守卫」（每个 <10 秒）。慢的那批（`verify.py` / `renderer-web` / 各 e2e）"
      "**不在这份清单里跑** —— 它们各有既定入口，跑法写在 `AGENTS.md` 的「常用验证方式」。")
    A("")

    # ── 手写 ──
    A("## 6. 脚本读不出来的那部分（我手写，因此**不保证全**）")
    A("")
    for line in SECTION6:
        A(line)
    A("")
    A("---")
    A("")
    A("## 7. 接力的人从哪开始（我的建议，不是命令）")
    A("")
    for line in SECTION7:
        A(line)
    A("")
    for line in SECTION7_TAIL:
        A(line)

    return "\n".join(L) + "\n", total, len(cards), len(log_items), len(decks), len(plans)


def main():
    out_path = ""
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]
    md, total, nc, nl, nd, np_ = build()
    if "--check" in sys.argv:
        print("未完成合计 %d 条（卡 %d · 日志 %d · 问卷 %d · 计划 %d）" % (total, nc, nl, nd, np_))
        return 0 if total == 0 else 1
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(md)
        print("已写入 %s（%d 条未完成）" % (out_path, total))
        return 0
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
