#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方寸 · 开工口（2026-11-16 · 治病①「没有记忆」的第一刀）

暮雨 2026-11-16：「**先治①（入口）**」

## 这个脚本治的是什么病

卡 `最高优先级ai-施工的五种病…` 列的病①：

> 「各项目几乎没有记忆（哪怕花费极高 token 成本使用带记忆和技能的 agent，也形同虚设，
> token 照扣但是 AI 根本不知道）」

它的判据（原文）：
> 同一个 agent、同一个项目、隔一天再开工，**能说出昨天做了什么、为什么那么做**；
> 不需要人重新贴一遍上下文。

反面现场（同卡）：
> 「今天这一整天，我每次都从 `git log` + `开发日志.md` 重新拼上下文 ——
> **这就是"有零件、没入口"的样子**。」

## 为什么不是"读开发日志"

`AGENTS.md` 第一条铁律是「开工先读 `开发日志.md` 读末条」。但实测：

   开发日志.md = 297 KB

而这张卡的验收线是 **≤ 8KB**，并且写着「不许靠"塞得多"取胜」。
所以正确做法不是让 agent 去啃那份流水账，而是**从真身现算**：
卡状态 / 计划阶段 / 决策 / 日志的 `_next_steps` —— 它们都是**结构化的**，能算得又短又准。

## 输出四格（每一格都对应判据的三个问题之一）

    ① 上次做到哪     ← 最近执行日志的下一步 + 最近提交   （回答"上次做到哪"）
    ② 计划推几格     ← plans/<id>.md 里最小未完成的 Pn + 它的判据原文（回答"这次先做什么"）
    ③ 有谁在等你     ← 待验收 / 待审批 / 驳回           （人才能动的，不是全部 140 张）
    ④ 有哪些规矩别犯 ← AGENTS.md 坑表 + 本项目被驳回的理由（回答"有哪些规矩别犯"）

## 三条纪律

  ① **只读**：不写卡、不写日志、不改任何数据（跑完 task-data 逐字节不变）；
  ② **不编**：算不出就写「算不出，因为 X」，**不拿"暂无"糊过去**；
  ③ **给体积**：末尾必须报总字节数 —— 这条判据是 ≤8KB，得能一眼看见。

用法：
  python scripts/brief.py                     # 方寸自己
  python scripts/brief.py --project sitian
  python scripts/brief.py --out docs/开工.md
  python scripts/brief.py --json              # 机器判据用
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 这条判据来自卡 `最高优先级ai-施工的五种病…` 的验收线
BUDGET_BYTES = 8 * 1024

# 人才能动的三个状态（其余状态 agent 自己能推，不该进"等你"）
WAIT_HUMAN = ("待验收", "待审批", "驳回")


def read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def frontmatter(text):
    """取 `---\\n…\\n---` 之间的块；没有就返回空串（不猜）。"""
    m = re.match(r"^---\r?\n(.*?)\r?\n---", text, re.S)
    return m.group(1) if m else ""


def fm_get_scalar(fm, key):
    """取**单值**字段。块式列表（`key:\\n  - a\\n  - b`）返回空串 —— 不猜。

    ⚠ 2026-11-16 实测踩到：`项目:` 有两种写法同时存在 ——
        项目: sitian            （单值）
        项目:\n  - sitian        （块式列表，YAML 解析出来是数组）
    第一版只用 `^key:\\s*(.*)$` 正则，块式那种取到空串 → `waiting_cards` 判 0 条，
    **而它看起来完全正常**（"没有：都为 0"）。这就是本仓反复踩的"界面说假话"。
    """
    m = re.search(r"^%s:[ \t]*(.*)$" % re.escape(key), fm, re.M)
    if not m:
        return None
    v = m.group(1).strip()
    if v in ("null", "~", ""):
        return ""
    return v.strip("'\"")


def fm_list(fm, key):
    """取列表字段（块式 `  - x` 或行内 `[a, b]`），统一成字符串列表。"""
    out = []
    m = re.search(r"^%s:[ \t]*(.*)$" % re.escape(key), fm, re.M)
    if not m:
        return out
    inline = m.group(1).strip()
    if inline.startswith("[") and inline.endswith("]"):
        body = inline[1:-1].strip()
        if body:
            out = [x.strip().strip("'\"") for x in body.split(",") if x.strip()]
        return out
    if inline and inline not in ("null", "~"):
        return [inline.strip("'\"")]     # 单值写法也认
    # 块式：紧跟着的 `  - x` 行
    rest = fm[m.end():]
    for ln in rest.splitlines():
        if not ln.strip():
            continue
        mm = re.match(r"^\s+-\s+(.*)$", ln)
        if mm:
            out.append(mm.group(1).strip().strip("'\""))
            continue
        break
    return out


def fm_project(project, fm):
    """这张卡属于 `project` 吗？两种写法都认。"""
    blk = fm_list(fm, "项目") + fm_list(fm, "project")
    return project in blk


def fm_get(fm, key):
    return fm_get_scalar(fm, key)


# ══════════════════════════════════════════════════════════════════════
# ① 上次做到哪
# ══════════════════════════════════════════════════════════════════════

def last_log(project):
    """最近一条属于该项目的执行日志 → {id,title,created,next,agent}。

    ⚠ 不能只看 mtime：日志可能被别人编辑过，mtime 会飘。按 `created` 排。
    """
    best = None
    for p in glob.glob(os.path.join(ROOT, "docs", "执行日志", "*.md")):
        try:
            if os.path.getsize(p) > 2 * 1024 * 1024:
                continue
        except OSError:
            continue
        try:
            fm = frontmatter(read(p))
        except Exception:
            continue
        if fm_get(fm, "project") != project:
            continue
        c = fm_get(fm, "created") or ""
        if best is None or c > best[0]:
            best = (c, {
                "id": fm_get(fm, "id") or os.path.basename(p)[:-3],
                "title": fm_get(fm, "title") or "",
                "created": c,
                "next": fm_get(fm, "_next_steps") or "",
                "agent": fm_get(fm, "agent_name") or "",
                "status": fm_get(fm, "status") or "",
            })
    return best[1] if best else None


def recent_commits(repo, n=3):
    """该项目仓库最近 n 条提交标题。读不到就说读不到（不返回空列表冒充"没有提交"）。"""
    try:
        r = subprocess.run(["git", "-C", repo, "log", "--pretty=%h %s", "-n", str(n)],
                           capture_output=True, text=True, timeout=30,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            return None, "git 退出码 %d（可能不是仓库）" % r.returncode
        return [ln for ln in (r.stdout or "").splitlines() if ln.strip()], ""
    except FileNotFoundError:
        return None, "本机没有 git"
    except subprocess.TimeoutExpired:
        return None, "git log 超时"
    except Exception as e:
        return None, str(e)


# ══════════════════════════════════════════════════════════════════════
# ② 计划推几格
# ══════════════════════════════════════════════════════════════════════

def next_stage(project):
    """最小未完成的 Pn + 它的判据原文。

    口径严格照 `scripts/check-plan-card.py` 与 `main/data/plans.ts`：
    阶段标题是 `### P0 · 标题`（也认 `### P8 结论集…` 这种无 `·` 的），
    状态在段内的 `- 状态: xxx`。
    """
    path = os.path.join(ROOT, "task-data", "plans", "%s.md" % project)
    if not os.path.exists(path):
        return None, "没有作战计划文件（task-data/plans/%s.md 不存在）" % project
    t = read(path)
    stages = []
    marks = list(re.finditer(r"^### (P\d+)[^\n]*$", t, re.M))
    for i, m in enumerate(marks):
        sid = m.group(1)
        end = marks[i + 1].start() if i + 1 < len(marks) else len(t)
        seg = t[m.end():end]
        st = re.search(r"^-\s*状态:\s*(.*)$", seg, re.M)
        status = st.group(1).strip() if st else ""
        title = re.sub(r"^P\d+\s*[·、]?\s*", "", m.group(0)[4:]).strip()
        # 判据：段内 `- cmd:` / `- str:` / `- num:` / `- file:` 开头的行
        crit = [ln.strip() for ln in seg.splitlines()
                if re.match(r"^\s*-\s*(cmd|str|num|file):", ln)]
        stages.append({"id": sid, "title": title, "status": status, "criteria": crit})
    todo = [s for s in stages if s["status"] not in ("完成",)]
    if not todo:
        return {"total": len(stages), "allDone": True}, ""
    # 打下标数字排序（P10 要在 P9 之后）
    todo.sort(key=lambda s: int(s["id"][1:]))
    return {"total": len(stages), "allDone": False, "next": todo[0],
            "pending": len(todo)}, ""


# ══════════════════════════════════════════════════════════════════════
# ③ 有谁在等你
# ══════════════════════════════════════════════════════════════════════

def waiting_cards(project):
    """只列**人才能动**的卡（待验收 / 待审批 / 驳回）。"""
    out = []
    for p in glob.glob(os.path.join(ROOT, "task-data", "*.md")):
        base = os.path.splitext(os.path.basename(p))[0]
        if base in ("decisions", "rice-pool", "question-bank",
                    "project-status", "registry", "project-tiers", "activity"):
            continue
        try:
            t = read(p)
        except Exception:
            continue
        fm = frontmatter(t)
        if not fm_project(project, fm):
            continue
        st = fm_get(fm, "状态") or ""
        if st not in WAIT_HUMAN:
            continue
        out.append({"id": fm_get(fm, "id") or base,
                    "title": fm_get(fm, "标题") or base,
                    "status": st,
                    "updated": fm_get(fm, "更新") or ""})
    order = {s: i for i, s in enumerate(WAIT_HUMAN)}
    out.sort(key=lambda x: (order.get(x["status"], 9), x["updated"]))
    return out


# ══════════════════════════════════════════════════════════════════════
# ④ 有哪些规矩别犯
# ══════════════════════════════════════════════════════════════════════

def pitfalls(limit=6):
    """方寸**自己**的坑表（`AGENTS.md` 的「踩过的坑」）。

    ⚠ 2026-11-16 实测的严重问题：给 project-3（明鉴）出简报时，④ 格列的是
    "Vue 代理不能过 contextBridge / tsconfig strict"——**那是方寸的坑**。
    agent 读到的会以为"这些是明鉴的规矩"，照着执行就是**跨项目串味**，
    比不给还糟。所以这一格必须带**归属**，且只在项目 == fangcun-base 时才详列。
    """
    p = os.path.join(ROOT, "AGENTS.md")
    if not os.path.exists(p):
        return None, "AGENTS.md 不存在"
    t = read(p)
    i = t.find("## 踩过的坑")
    if i < 0:
        return None, "AGENTS.md 里没有「踩过的坑」节"
    seg = t[i:]
    nxt = re.search(r"\n## ", seg[3:])
    if nxt:
        seg = seg[:nxt.start() + 3]
    items = re.findall(r"^### (.+)$", seg, re.M)
    return items[:limit], ""


def project_pitfalls_file(project):
    """该项目仓库里自己的坑表（若存在）。

    ⚠ 这里**对方寸自己直接跳过**：方寸的坑表就在本仓 `AGENTS.md`，由 `pitfalls()` 读，
      再走这条路只会多出一条自相矛盾的"算不出"（实测绕了三轮）。
      对**别的项目**才需要去它自己的仓库里找 —— 那才是防串味的关键。

    ⚠ 读不到就说读不到 —— 尤其不能拿方寸的坑表顶替（那是最糟的串味）。
    """
    if project == "fangcun-base":
        return None, ""      # 自己：由 pitfalls() 负责，这里不重复
    repo = repo_of(project)
    if not repo:
        return None, "这个项目没在 registry.yaml 里登记 repo，无法定位它的规矩文件"
    for name in ("AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"):
        p = os.path.join(repo, name)
        if not os.path.exists(p):
            continue
        try:
            t = read(p)
        except Exception:
            continue
        m = re.search(r"^#{2,3}\s*(踩过的坑|坑|Gotchas?|Lessons?)[^\n]*$", t, re.M | re.I)
        if not m:
            continue
        body_start = m.end()
        nxt = re.search(r"^#{1,3}\s", t[body_start:], re.M)
        seg = t[body_start: body_start + nxt.start()] if nxt else t[body_start:]
        lvl = len(m.group(0)) - len(m.group(0).lstrip("#"))
        items = re.findall(r"^#{%d}\s+(.+)$" % (lvl + 1), seg, re.M)
        if items:
            return {"file": name, "items": items[:6]}, ""
    return None, "该项目仓库里没有坑表节（AGENTS.md / CLAUDE.md 的「踩过的坑」）"


def rejected_reasons(project, limit=3):
    """本项目被驳回的卡 → 驳回理由首行（那是"骂过的话"，下次开工该看见）。"""
    out = []
    for p in glob.glob(os.path.join(ROOT, "task-data", "*.md")):
        try:
            t = read(p)
        except Exception:
            continue
        fm = frontmatter(t)
        if not fm_project(project, fm):
            continue
        if (fm_get(fm, "状态") or "") != "驳回":
            continue
        reason = fm_get(fm, "reject_reason") or ""
        first = next((ln.strip() for ln in reason.splitlines() if ln.strip()), "")
        out.append({"id": fm_get(fm, "id") or "", "title": fm_get(fm, "标题") or "",
                    "reason": first[:160]})
    return out[:limit]


def repo_of(project):
    """从 registry.yaml 读 repo 路径（**不猜路径**）。"""
    p = os.path.join(ROOT, "registry.yaml")
    if not os.path.exists(p):
        return ""
    t = read(p)
    blocks = re.split(r"^  - id: ", t, flags=re.M)
    for b in blocks[1:]:
        pid = b.split("\n")[0].strip()
        if pid != project:
            continue
        m = re.search(r"^\s+repo:\s*(\S.*)$", b, re.M)
        if not m:
            return ""
        return m.group(1).strip().strip('"')
    return ""


# ══════════════════════════════════════════════════════════════════════

def build(project):
    return {
        "project": project,
        "lastLog": last_log(project),
        "commits": recent_commits(repo_of(project) or ROOT),
        "plan": next_stage(project),
        "waiting": waiting_cards(project),
        "pitfalls": pitfalls(),
        "ownPitfalls": project_pitfalls_file(project),
        "rejected": rejected_reasons(project),
    }


def render(d):
    L = []
    p = d["project"]
    L.append("# 开工简报 · %s" % p)
    L.append("")
    L.append("> 这个文件是**算出来的**，不是人写的。它回答三个问题：")
    L.append("> **上次做到哪 / 这次先做什么 / 有哪些规矩别犯**。")
    L.append("> 上限 8KB —— 塞得多不算本事（卡 `最高优先级…五种病` 的验收线）。")
    L.append("")

    # ① 上次做到哪
    L.append("## ① 上次做到哪")
    L.append("")
    ll = d["lastLog"]
    if ll:
        L.append("- 最近一条执行日志：`%s` · %s · %s" % (ll["id"], ll["created"][:16], ll["agent"] or "—"))
        if ll["title"]:
            L.append("  - 标题：%s" % ll["title"])
        if ll["next"] and ll["next"] not in ("（待填写）",):
            L.append("  - **下一步（那条日志自己写的）**：%s" % ll["next"])
        else:
            L.append("  - **下一步：那条日志没填** —— 所以我不知道该接着做什么，这是缺数据，不是没有活")
    else:
        L.append("- **算不出**：`docs/执行日志/` 里没有属于 `%s` 的日志" % p)
    cs, err = d["commits"]
    if cs:
        L.append("- 最近提交：")
        for c in cs:
            L.append("  - `%s`" % c)
    else:
        L.append("- 提交：算不出，因为 %s" % (err or "未知"))
    L.append("")

    # ② 这次先做什么
    L.append("## ② 这次先做什么（计划推哪一格）")
    L.append("")
    pl, why = d["plan"]
    if not pl:
        L.append("- **算不出**：%s" % why)
    elif pl.get("allDone"):
        L.append("- 计划 %d 格**全部完成** —— 没有「该推的那一格」了，要开新格得先出草案" % pl["total"])
    else:
        s = pl["next"]
        L.append("- 共 %d 格，还有 **%d 格未完成**；下一格是 **%s %s**（状态：%s）" % (
            pl["total"], pl["pending"], s["id"], s["title"], s["status"] or "—"))
        if s["criteria"]:
            L.append("- 这一格的判据（**原文**，不许我转述）：")
            for c in s["criteria"][:6]:
                L.append("  - `%s`" % c.lstrip("- ").strip())
            if len(s["criteria"]) > 6:
                L.append("  - （还有 %d 条，见计划文件）" % (len(s["criteria"]) - 6))
        else:
            L.append("- ⚠ 这一格**没写判据** —— 推它之前得先有判据")
    L.append("")

    # ③ 有谁在等你
    L.append("## ③ 有谁在等你（只有人才能动的）")
    L.append("")
    w = d["waiting"]
    if not w:
        L.append("- 没有：待验收 / 待审批 / 驳回 **都为 0**")
    else:
        by = {}
        for c in w:
            by.setdefault(c["status"], []).append(c)
        for st in WAIT_HUMAN:
            if st not in by:
                continue
            L.append("- **%s（%d）**" % (st, len(by[st])))
            for c in by[st][:6]:
                L.append("  - `%s` %s" % (c["id"], c["title"][:70]))
            if len(by[st]) > 6:
                L.append("  - （还有 %d 张）" % (len(by[st]) - 6))
    L.append("")

    # ④ 有哪些规矩别犯
    L.append("## ④ 有哪些规矩别犯")
    L.append("")
    # ⚠ 顺序很重要：**本项目自己的规矩优先**，方寸的坑表只在项目就是方寸时才详列。
    #   第一版无条件列方寸的坑表 → 给明鉴的简报里写着"Vue 代理不能过 contextBridge"，
    #   agent 会当成明鉴的规矩执行。**跨项目串味比不给还糟**。
    own, oerr = d.get("ownPitfalls") or (None, "")
    if own:
        L.append("**这个项目自己的**（`%s`）—— 先看这些：" % own["file"])
        for x in own["items"]:
            L.append("- %s" % x)
        L.append("")
    elif oerr:
        L.append("- 这个项目自己的坑表：**算不出** —— %s" % oerr)
        L.append("")
    # 方寸自己的坑表：只在项目就是方寸时才详列；别的项目只给一句归属警告，不列条目
    # （列了就等于把方寸的规矩塞给明鉴/司天 —— 跨项目串味比不给还糟）。

    if p == "fangcun-base":
        pit, perr = d["pitfalls"]
        if pit:
            L.append("方寸自己的坑表（`AGENTS.md`，**只适用于方寸本仓**）：")
            for x in pit:
                L.append("- %s" % x)
        else:
            L.append("- **算不出**：%s" % perr)
    else:
        L.append("> ⚠ 以下这些是**方寸自己的**坑（仓库 `fangcun-base`），"
                 "**不是 `%s` 的规矩** —— 别照着改这个项目。" % p)
        L.append("> 要项目的规矩，看上面那节；上面没有就说明这个项目还没写坑表。")
    rj = d["rejected"]
    if rj:
        L.append("")
        L.append("本项目**被驳回**过的（原文首行）：")
        for r in rj:
            L.append("- `%s` %s → %s" % (r["id"], r["title"][:50], r["reason"] or "（没写理由）"))
    L.append("")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description="开工简报（只读）")
    ap.add_argument("--project", default="fangcun-base")
    ap.add_argument("--out")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true",
                    help="机检：超 8KB / 有「算不出」的格就非零退出")
    args = ap.parse_args()

    d = build(args.project)
    text = render(d)
    nbytes = len(text.encode("utf-8"))

    if args.json:
        d["bytes"] = nbytes
        d["budget"] = BUDGET_BYTES
        d["overBudget"] = nbytes > BUDGET_BYTES
        print(json.dumps(d, ensure_ascii=False, indent=1, default=str))
        return 0

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        print("已写 %d 字节 → %s" % (nbytes, args.out))
    else:
        print(text)

    print("—" * 60)
    print("体积 %d / %d 字节（%s）" % (nbytes, BUDGET_BYTES,
                                  "OK" if nbytes <= BUDGET_BYTES else "**超预算**"))
    if args.check:
        bad = []
        if nbytes > BUDGET_BYTES:
            bad.append("超 8KB（%d 字节）" % nbytes)
        for k, label in (("lastLog", "① 上次做到哪"), ("plan", "② 这次先做什么")):
            if not d.get(k):
                bad.append("%s 算不出" % label)
        if bad:
            print("✗ " + "；".join(bad))
            return 1
        print("✓ 入口成立：不超预算、三格都有数据")
    return 0


if __name__ == "__main__":
    sys.exit(main())
