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
# 阶段标题在真身里有**两种写法**，只认一种就会整块漏掉：
#   · `### P0 · 清既有红…`（sitian 的 P0–P3、fangcun-base 的 P0–P7）
#   · `### P8 结论集落代码…`（无 `·`：fangcun-base P8–P11、memory-sanctuary P0、project-3 P0）
# ⚠ 2026-11-15 实测：旧正则写成 `^###\s+(P\d+)\s*·\s*(.+)$`（强制 `·`），于是
#   **memory-sanctuary / project-3 两整个项目 0 条、fangcun-base 少 4 条** ——
#   而清单照样生成、数字照样自洽，只是"计划卡待办"悄悄少了一半。
#   这与本轮前面踩的六次是同一个病：**抓错形态，输出看起来完全正常**。
HEAD_STAGE = re.compile(r"(?m)^###\s+(P\d+)\s*[·:：]?\s*(.*)$")


def _split_stage_segments(txt):
    """按 `### Pn` 的**真实位置**切段。

    ⚠ 不能用 `txt.split("### Pn ·")[-1]`：那是找第一次出现、取最后一块 ——
    标题不带 `·` 时它根本不命中，`[-1]` 返回**全文**，
    于是每格的"状态"都取到文件里第一条 `- 状态:`（整卡状态），
    把全部格子判成同一个值。必须按 match 的位置切。
    """
    ms = list(HEAD_STAGE.finditer(txt))
    out = []
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(txt)
        out.append((m.group(1), (m.group(2) or "").strip(), txt[m.end():end]))
    return out


def _stage_criteria(seg):
    """一格自己的判据原文（去掉空白差异后比较用）"""
    return [re.sub(r"\s+", " ", l.strip()) for l in seg.split("\n")
            if re.match(r"^\s*-\s*(cmd|str|num|file):", l)]


def _draft_target(path):
    """草案该提到哪个计划卡：文件名到第一个 `-YYYY-MM-DD` 为止就是项目 id。

    与 `desktop/src/main/data/planDrafts.ts` 的取法一致（那边也是按日期段截断，
    因为项目 id 自己就带连字符：`fangcun-base` / `dsh-fangcun`）。
    """
    name = os.path.basename(path)[:-3]
    return re.sub(r"-\d{4}-\d{2}-\d{2}.*$", "", name)


def collect_plans():
    """计划卡待办 + 草案的真实状态。

    ⚠ 草案这一栏我第一版是**无脑全收**（`_drafts/*.md` 有一个算一个，全报"待提成"），
      于是清单上写「8 份草案躺了 3–13 天没人提成，离能用只差一次点击」。**这是假的**：
      实测逐格比对判据后，8 份里 4 份的每一格**早就提成进计划卡了**（判据逐条相同），
      另 4 份（fangcun-base 11-02 / 11-10 三份）的 P0–P4 与计划卡里已有的 P0–P4 **重号**，
      `proposeStage` 会以「阶段 P0 已存在」直接拒绝 —— 它们不是"点一下就能用"，是**点不动**。
      "文件在目录里"不等于"事情没做"。
    """
    out = []
    extra = {"promoted": 0, "blocked": [], "fully": []}
    drafts_dir = os.path.join(ROOT, "task-data", "plans", "_drafts")

    # 先把每张计划卡已有的格子读出来（id -> 判据），供草案对账
    plans_dir = os.path.join(ROOT, "task-data", "plans")
    existing = {}
    for f in sorted(glob.glob(os.path.join(plans_dir, "*.md"))):
        try:
            txt = open(f, encoding="utf-8").read()
        except Exception:
            continue
        pid = os.path.basename(f)[:-3]
        segs = _split_stage_segments(txt)
        existing[pid] = {sid: _stage_criteria(seg) for sid, _t, seg in segs}
        for sid, title, seg in segs:
            m = re.search(r"(?m)^-\s*状态:\s*(.+)$", seg)
            st = (m.group(1).strip() if m else "")
            if st in ("待裁决", "未冻结", "待裁决（未冻结）"):
                out.append({"kind": "阶段待裁决", "file": rel(f), "id": "%s %s" % (sid, title)})
            elif st == "已冻结":
                out.append({"kind": "已冻结未推进", "file": rel(f), "id": "%s %s" % (sid, title)})

    # 草案：逐格对账，只有"计划卡里没有这一格"才算待提成
    for f in sorted(glob.glob(os.path.join(drafts_dir, "*.md"))):
        try:
            txt = open(f, encoding="utf-8").read()
        except Exception:
            continue
        target = _draft_target(f)
        have = existing.get(target, {})
        pending, blocked, promoted = [], [], 0
        for sid, title, seg in _split_stage_segments(txt):
            if sid not in have:
                pending.append((sid, title))
            elif have[sid] and have[sid] == _stage_criteria(seg):
                promoted += 1
            else:
                blocked.append("%s %s" % (sid, title))
        extra["promoted"] += promoted
        if pending:
            out.append({"kind": "草案待提成", "file": rel(f),
                        "id": "%s（%s 格：%s）" % (os.path.basename(f), len(pending),
                                                  "、".join(p[0] for p in pending))})
        if blocked:
            extra["blocked"].append({"file": os.path.basename(f), "target": target,
                                     "stages": blocked})
            out.append({"kind": "草案提不进（与计划卡重号）", "file": rel(f),
                        "id": "%s → %s.md 已有 %s，提成会被拒；需作废本草案或改号"
                              % (os.path.basename(f), target,
                                 "、".join(b.split(" ")[0] for b in blocked))})
        # 每一格都已提成 → 单独列出来，**不许只在汇总数字里消失**。
        # （2026-11-15 补：第一版只把它加进一个计数，"文件还在"的草案在表里根本找不到，
        #   读清单的人无从判断它到底做没做 —— 那和第 5 次"日志静默 0 条"是同一个病。）
        if not pending and not blocked and promoted:
            extra["fully"].append({"file": os.path.basename(f), "target": target,
                                   "stages": promoted})
    return out, extra


# ── §6 手写段落（只留"算不出来"的判断；能算的一律现算）──────────────────
#
# ⚠ 2026-11-20 实测：这一节原来整段写死，**三处已经说过时了**，而且错得一模一样 ——
#   **数的是文件名 / 印象，不是卡的状态**：
#     · 「14 张结构地图卡全在等人点头」→ 实为 13 张「完成」+ 1 张「驳回」（旧版作废），一张都不欠；
#     · 「结构地图仍是最后核实 2026-10-17」→ `policies/fangcun-base.md` 早就是 2026-11-12；
#     · 「AI 规划零单」→ 首单 2026-11-11 真跑过（卡自己的结果记录写着），产物还提成了 P8–P11。
#   暮雨的原话是「各项目依然记不住东西」—— 这就是它的形态：**人写的段落会漂，而且没有闸**。
#   所以现在：能算的现算（`hand_facts()`），算不出来就明说"读不到"，绝不凭印象补一句。

def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def _front_field(txt, key):
    """只认文件开头那段 YAML frontmatter 里的一个字段"""
    m = re.match(r"^---\s*\n([\s\S]*?)\n---", txt or "")
    if not m:
        return ""
    m2 = re.search(r"^" + re.escape(key) + r":\s*(.*)$", m.group(1), re.M)
    return (m2.group(1) or "").strip() if m2 else ""


def hand_facts():
    """§6 里"能被算"的那几条。返回 dict[键] = 一行 Markdown。"""
    f = {}

    # ① 结构地图提议卡：按**状态**数（不按文件名数 —— 上一版就是数文件名，把"已签完"说成"全在等人"）
    cnt = Counter()
    for p in sorted(glob.glob(os.path.join(ROOT, "task-data", "结构地图更新--*.md"))):
        cnt[_front_field(_read_text(p), "状态") or "(无状态)"] += 1
    if cnt:
        total = sum(cnt.values())
        parts = "、".join(f"「{k}」{v}" for k, v in cnt.most_common())
        waiting = cnt.get("待审批", 0) + cnt.get("待办", 0)
        if waiting:
            f["smap"] = (f"- **结构地图提议卡 {total} 张：{parts}** —— 还在等人签字的 **{waiting} 张**。"
                         f"（`smap_apply` 只认「完成」的卡；其余是历史，别当欠账）")
        else:
            f["smap"] = (f"- **结构地图提议卡 {total} 张：{parts}** —— **一张都不在等人签字**（都处置过了）。"
                         f"`smap_apply` 只认「完成」的卡，处置过的不该再算欠账")
    else:
        f["smap"] = "- **结构地图提议卡**：一个文件都没读到 —— 这不是「没有」，是路径变了，先查 `task-data/结构地图更新--*.md`"

    # ② 结构地图的最后核实日期：从 policies 现读
    dates = {}
    for p in sorted(glob.glob(os.path.join(ROOT, "policies", "*.md"))):
        m = re.search(r"最后核实[：:]\s*(\d{4}-\d{2}-\d{2})", _read_text(p))
        if m:
            dates[os.path.splitext(os.path.basename(p))[0]] = m.group(1)
    if dates:
        fb = dates.get("fangcun-base", "")
        oldest = min(dates.values())
        f["verified"] = (f"- **结构地图最后核实**：fangcun-base = **{fb or '未写'}**；"
                         f"全部 policies 里最早的是 **{oldest}**（超过 90 天 agent 会看到「已过期」标记）")
    else:
        f["verified"] = "- **结构地图最后核实**：policies/ 里一个“最后核实”都没读到 —— 先查这个目录"

    # ③ AI 首单：读那张卡自己的状态与结果记录（别再凭"状态=待办"就断言没跑过）
    order = _read_text(os.path.join(ROOT, "task-data", "task-20261025-009.md"))
    if order:
        st = _front_field(order, "状态") or "(无状态)"
        ran = "已出 0.7.0 规划" in order or "真出了 0.7.0 规划" in order
        if ran:
            f["order"] = (f"- **AI 首单：跑过了**（卡 `task-20261025-009` 的结果记录里就写着“真出了 0.7.0 规划”），"
                          f"产物是 `task-data/plans/_drafts/fangcun-base-2026-11-11.md`，P8–P11 已提成进计划卡；"
                          f"它现在状态是「{st}」—— **缺的是一次处置，不是一次施工**")
        else:
            f["order"] = (f"- **AI 首单：卡在「{st}」，结果记录里没有“已出 0.7.0 规划”** —— "
                          f"要么真没跑，要么跑完没记账（后者更麻烦：记账的地方不止一处）")
    else:
        f["order"] = "- **AI 首单**：读不到 `task-data/task-20261025-009.md` —— 这张卡不在原处了，先确认它去哪了"

    # ④ 草案现状：顶层还剩几份、作废目录里有几份（别再拿"8 份"说事）
    live = glob.glob(os.path.join(ROOT, "task-data", "plans", "_drafts", "*.md"))
    voided = glob.glob(os.path.join(ROOT, "task-data", "plans", "_drafts", "_void-*", "*.md"))
    f["drafts"] = (f"- **草案（`_drafts/`）**：还在一级的 **{len(live)} 份**，作废区里 **{len(voided)} 份**"
                   f"（作废 = 移到 `_drafts/_void-<日期>/`，可逆、不删）。"
                   f"⚠ 重号的四份（11-02 / 11-10 三个版本）**已经作废**，别再按“提成必被拒”去处理它们")
    return f


SECTION6_STATIC = """\
- **规划能力仍是雏形**：`方寸` 的作战计划 P0–P11 **全部「完成」**，但注册表 13 个活跃项目里
  **只有 4 个有计划卡**（fangcun-base / sitian / project-3 / memory-sanctuary），**剩 9 个没有** ——
  而它们不是「方寸不会写」，是**没有已批准的裁决卷**（闸在卷上，不在能力上）。
- **判据这个概念仍然要人解释**：已做「每条一句人话」，但它仍是技术概念；
  要彻底不需要解释，得动「作战计划」这个产品形态本身 —— 那是决策，不是改样式。
- **每个项目的前端都很差**（暮雨原话，第三次提）：本轮只消了具体那两处，没有整体重做视觉。
- **13 个项目没有图标**（`p2-1-品牌资产…`）：这是各项目自己的活 —— 契约写明方寸对 repo 只读。
- **处置过不等于核实过**：711 条已逐条处置里，`非本项目` 占 308（41%）、`已转卡` 224。
  这个比例本身值得怀疑 —— 一条内容被反复归成「不是这个项目的」，可能是归类口径太松。
  判据：随机抽 20 条 `非本项目` 复核，若超过 5 条其实相关，就是口径松了。""".split("\n")


def section6_lines():
    """§6 的最终行：**先摆现算的事实，再摆判断**（判断没有闸，所以越少越好）。"""
    facts = hand_facts()
    out = []
    # 事实在前：这四条以前是手写的，全漂了
    for k in ("smap", "verified", "order", "drafts"):
        if k in facts:
            out.append(facts[k])
    out.append("")
    out.extend(SECTION6_STATIC)
    return out

SECTION7 = """\
**不要从「最老的那张卡」开始。** 顺序建议按「卡住别人的程度」：

1. **先看 §3 问卷** —— 卡住的每一份卷都在**挡住一个项目的规划**。答完 + 批准，下游才有东西可派。
2. **再看 §4 计划卡** —— 只有标「草案待提成」的才真能提；标「提不进（重号）」的**先去作废或改号**，
   否则按十次都是同一个报错。
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
    plans, plan_extra = collect_plans()
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
        A("")
        # 草案的真实状态：文件在目录里 ≠ 事情没做
        if plan_extra["fully"]:
            A("> **%d 份草案每一格都已提成进计划卡**（逐格比对判据，逐条相同）—— "
              "**它们不是欠账，也不是「差一次点击」**，只是 `_drafts/` 里的副本没删："
              % len(plan_extra["fully"]))
            A("")
            for x in plan_extra["fully"]:
                A("> - `%s` → `%s`：%d 格全部已提成" % (x["file"], x["target"], x["stages"]))
            A("")
        if plan_extra["promoted"] and not plan_extra["fully"]:
            A("> 另有 **%d 格草案内容早已提成进计划卡**（逐格比对判据，逐条相同）。"
              % plan_extra["promoted"])
            A("")
        if plan_extra["blocked"]:
            A("> ⚠ **%d 份草案提不动**：它要落的格子号在计划卡里已被占用，"
              "`proposeStage` 会以「阶段 Pn 已存在」拒绝。**不是「差一次点击」，是点不动。**"
              % len(plan_extra["blocked"]))
            A("")
            for b in plan_extra["blocked"]:
                A("> - `%s` → `%s`：%s" % (b["file"], b["target"], "、".join(b["stages"])))
            A("")
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
    A("## 6. 脚本读不出来的那部分（事实现算 + 我写的判断）")
    A("")
    for line in section6_lines():
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
