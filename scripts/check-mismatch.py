#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对不上检测（只读，零写入）

判三件事，全部机械可判、不需要 LLM：
  ① 状态过期：registry 的「状态」里写的日期，比该仓库最后一次提交旧了 >= 阈值
  ② 引用断裂：卡正文里写的仓库内路径，文件已经不存在
  ③ 无判据完成：状态=完成的卡，正文里找不到任何验收判据字样

用法:
  python scripts/check-mismatch.py                 # 全部三类
  python scripts/check-mismatch.py --only stale    # only: stale|broken|nocriteria
  python scripts/check-mismatch.py --days 3        # 状态过期阈值（默认 3 天）
  python scripts/check-mismatch.py --json
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "registry.yaml")
TASK_DIR = os.path.join(ROOT, "task-data")

DATE_PATTERNS = [
    re.compile(r"(\d{4})-(\d{2})-(\d{2})"),
    re.compile(r"(?<!\d)(\d{2})-(\d{2})(?!\d)"),
]
CRITERIA_WORDS = ("验收标准", "验收判据", "判定标准", "验收条件", "Definition of Done", "DoD")
PATH_IN_TEXT = re.compile(r"`((?:desktop|scripts|docs|tegula|templates|task-data|skills|references)/[^`\s]+?)`")


def read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def parse_registry(text):
    """按项目切块，取 id / name / repo / 状态。不做 YAML load（禁整体 dump 同一原则：只读切片）。"""
    projects, cur = [], None
    for line in text.splitlines():
        m = re.match(r"^\s*-\s+id:\s*(.+?)\s*$", line)
        if m:
            if cur:
                projects.append(cur)
            cur = {"id": m.group(1).strip(), "name": "", "repo": "", "status": ""}
            continue
        if cur is None:
            continue
        for key, field in (("name", "name"), ("repo", "repo"), ("状态", "status")):
            m = re.match(r"^\s+%s:\s*(.*)$" % re.escape(key), line)
            if m:
                cur[field] = m.group(1).strip()
    if cur:
        projects.append(cur)
    return projects


def repo_map():
    """id / name → repo 绝对路径。跨仓库引用的判据。"""
    out = {}
    if not os.path.exists(REGISTRY):
        return out
    for p in parse_registry(read(REGISTRY)):
        repo = (p.get("repo") or "").strip()
        if not repo:
            continue
        repo = os.path.expanduser(repo.replace("/", os.sep))
        if p.get("id"):
            out[p["id"]] = repo
        if p.get("name"):
            out[p["name"]] = repo
    return out


def last_commit(repo):
    if not repo or not os.path.isdir(repo):
        return None
    try:
        out = subprocess.run(
            ["git", "-C", repo, "log", "-1", "--format=%ad", "--date=short"],
            capture_output=True, text=True, timeout=20,
            encoding="utf-8", errors="replace",
        )
        s = (out.stdout or "").strip()
        return s or None
    except Exception:
        return None


def status_date(text, today):
    """从状态文字里抠出最像“它说这个是哪天”的日期。返回 (date, 原文片段)。"""
    best = None
    for pat in DATE_PATTERNS:
        for m in pat.finditer(text):
            g = m.groups()
            try:
                if len(g) == 3:
                    d = date(int(g[0]), int(g[1]), int(g[2]))
                else:
                    d = date(today.year, int(g[0]), int(g[1]))
            except ValueError:
                continue
            if d > today:  # 未来日期不算“上次核对”
                continue
            if best is None or d > best[0]:
                best = (d, m.group(0))
    return best


def check_stale(days, today):
    rows = []
    if not os.path.exists(REGISTRY):
        return rows
    for p in parse_registry(read(REGISTRY)):
        sd = status_date(p["status"], today)
        lc = last_commit(p["repo"])
        if not lc:
            continue
        try:
            lcd = datetime.strptime(lc, "%Y-%m-%d").date()
        except ValueError:
            continue
        if sd is None:
            rows.append({
                "kind": "stale", "project": p["name"] or p["id"], "why": "状态里没写日期",
                "status_date": None, "last_commit": lc, "delta_days": None,
            })
            continue
        delta = (lcd - sd[0]).days
        if delta >= days:
            rows.append({
                "kind": "stale", "project": p["name"] or p["id"],
                "why": "仓库还在动，状态停在 %s" % sd[1],
                "status_date": sd[0].isoformat(), "last_commit": lc, "delta_days": delta,
            })
    return rows


def task_projects(text):
    """取卡的「项目」字段（数组或标量），返回去空后的列表。"""
    m = re.search(r"^项目:\s*(.*)$", text, re.M)
    if not m:
        return []
    raw = m.group(1).strip()
    if raw.startswith("["):
        items = raw.strip("[]").split(",")
    elif raw:
        items = [raw]
    else:
        items = []
        for line in text.splitlines():
            mm = re.match(r"^\s+-\s+(\S.*)$", line)
            if mm and ":" not in mm.group(1):
                items.append(mm.group(1))
            elif mm is None and items:
                break
    return [i.strip().strip("'\"") for i in items if i.strip()]


def sanitize_ref(raw):
    """剥行号、丢带通配/花括号/省略号的伪路径。返回去重后的真路径或 None。"""
    s = raw.rstrip(".,;)）】")
    s = re.sub(r":\d+(-\d+)?$", "", s)          # ideas.ts:269 → ideas.ts
    if any(c in s for c in "*?<>|{}"):
        return None
    if "..." in s or "…" in s:
        return None
    if not s or s.endswith("/") and s.count("/") < 2:
        return None
    return s


def is_noise(fname):
    """备份 / 隐藏 / 编辑器临时文件不参与扫描。"""
    return fname.startswith(".") or fname.endswith(".bak") or fname.endswith("~")


def check_broken():
    """引用断裂：卡正文里写的路径，在本仓库与该卡「项目」对应的仓库里都找不到。"""
    rows = []
    if not os.path.isdir(TASK_DIR):
        return rows
    repos = repo_map()
    for name in sorted(os.listdir(TASK_DIR)):
        if not name.endswith(".md") or is_noise(name):
            continue
        fp = os.path.join(TASK_DIR, name)
        try:
            text = read(fp)
        except OSError:
            continue
        alt_repos = []
        for pid in task_projects(text):
            rp = repos.get(pid)
            if rp and os.path.isdir(rp) and os.path.abspath(rp) != os.path.abspath(ROOT):
                alt_repos.append((pid, rp))
        seen = set()
        for m in PATH_IN_TEXT.finditer(text):
            rel = sanitize_ref(m.group(1))
            if not rel or rel in seen:
                continue
            seen.add(rel)
            if os.path.exists(os.path.join(ROOT, rel.replace("/", os.sep))):
                continue
            # 归档 / 回收站的卡：路径前缀补一层再试（task-data/x.md → task-data/archive/x.md）
            if rel.startswith("task-data/") and rel.endswith(".md"):
                tail = rel[len("task-data/"):]
                if any(os.path.exists(os.path.join(TASK_DIR, sub, tail.replace("/", os.sep)))
                       for sub in ("archive", ".trash")):
                    rows.append({"kind": "moved", "task": name, "ref": rel,
                                 "why": "指向的卡已归档/进回收站，引用未回改"})
                    continue
            hit = None
            for pid, rp in alt_repos:
                if os.path.exists(os.path.join(rp, rel.replace("/", os.sep))):
                    hit = pid
                    break
            if hit:
                continue  # 在它自己项目的仓库里，正常
            rows.append({
                "kind": "broken", "task": name, "ref": rel,
                "searched": ["本仓"] + [p for p, _ in alt_repos],
            })
    return rows


def check_nocriteria():
    rows = []
    if not os.path.isdir(TASK_DIR):
        return rows
    for name in sorted(os.listdir(TASK_DIR)):
        if not name.endswith(".md") or is_noise(name):
            continue
        text = read(os.path.join(TASK_DIR, name))
        m = re.search(r"^状态:\s*(.+)$", text, re.M)
        if not m or m.group(1).strip() != "完成":
            continue
        body = text.split("---", 2)[-1] if text.startswith("---") else text
        if not any(w in body for w in CRITERIA_WORDS):
            t = re.search(r"^标题:\s*(.+)$", text, re.M)
            rows.append({"kind": "nocriteria", "task": name, "title": (t.group(1).strip() if t else name)})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["stale", "broken", "nocriteria"])
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    today = date.today()

    out = []
    if a.only in (None, "stale"):
        out += check_stale(a.days, today)
    if a.only in (None, "broken"):
        out += check_broken()
    if a.only in (None, "nocriteria"):
        out += check_nocriteria()

    if a.json:
        print(json.dumps({"count": len(out), "rows": out}, ensure_ascii=False, indent=2))
        return 0

    labels = {"stale": "① 状态过期", "broken": "② 引用断裂", "nocriteria": "③ 完成但没判据",
              "moved": "④ 指向已归档的卡"}
    for kind in ("stale", "broken", "moved", "nocriteria"):
        group = [r for r in out if r["kind"] == kind]
        print("\n%s —— %d 条" % (labels[kind], len(group)))
        if not group:
            print("    （没有）")
            continue
        for r in group:
            if kind == "stale":
                if r["delta_days"] is None:
                    print("    %-12s %s｜最后提交 %s" % (r["project"], r["why"], r["last_commit"]))
                else:
                    print("    %-12s %s｜最后提交 %s（差 %d 天）"
                          % (r["project"], r["why"], r["last_commit"], r["delta_days"]))
            elif kind == "broken":
                where = "/".join(r.get("searched") or ["本仓"])
                print("    %-30s → %-46s [找过: %s]" % (r["task"], r["ref"], where))
            elif kind == "moved":
                print("    %-30s → %-46s [%s]" % (r["task"], r["ref"], r["why"]))
            elif kind == "nocriteria":
                print("    %-28s %s" % (r["task"], r["title"][:44]))
    print("\n合计 %d 条。这只是「对不上」，不是「该做什么」。" % len(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
