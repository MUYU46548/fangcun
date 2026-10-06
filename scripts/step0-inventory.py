#!/usr/bin/env python3
"""方寸 · Step 0 只读盘点（立项契约主线 · REV-001）

盘点范围：registry.yaml 登记的全部项目（projects + released）。
盘点维度（15 项，逐项可机械复验）：

 1. 项目 id           2. 显示名            3. repo 路径存在（lstat）
 4. registry「状态」   5. registry「路线图」  6. 方针卡 policies/<id>.md
 7. 契约文件 <repo>/立项契约.md（契约主线新增维度）
 8. 未归档卡（在库）    9. 其中已完成        10. 待办
11. 进行中          12. 待验收          13. 带阻塞的卡
14. git 最近提交     15. git 未提交文件数
16. 执行日志条数     17. 在途判据命中（有未完结卡 or 30 天内有提交）
18. 最新日志标题

口径：第 8 项 = task-data 根下未被归档的卡（含已完成未归档），**不等于「未完结」**。
第 16 项：执行日志（`docs/执行日志/*.md`）—— 对「0 张卡但一直在写日志」的项目（如司天）是唯一数据源。

**只读**：不写任何任务/注册表/项目文件。唯一写入 = `--out` 指定的报告路径。
复跑：`python scripts/step0-inventory.py`（默认写 docs/step0-盘点-<日期>.md）
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from tegula import core  # noqa: E402

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CONTRACT_NAME = "立项契约.md"


def _as_list(v):
    if v is None or v == "":
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    return [str(v)]


def _git(repo: str, *args: str, timeout: int = 10) -> str:
    if not repo or not os.path.isdir(repo):
        return ""
    try:
        r = subprocess.run(
            ["git", "-C", repo, *args],
            capture_output=True, text=True, timeout=timeout,
            creationflags=CREATE_NO_WINDOW, encoding="utf-8", errors="replace",
        )
        return (r.stdout or "").strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def _rel_time(iso: str) -> str:
    if not iso:
        return "—"
    try:
        t = _dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso[:10]
    now = _dt.datetime.now(tz=t.astimezone().tzinfo)
    days = (now - t).days
    hours = int((now - t).total_seconds() // 3600)
    if days >= 30:
        return f"{days // 30}个月前"
    if days >= 1:
        return f"{days}天前"
    if hours >= 1:
        return f"{hours}小时前"
    return "今天"


def collect() -> dict:
    data_dir = core.DATA_DIR
    projects = core.load_all_projects()

    active = core.load_tasks()
    archived = core.load_tasks(view="archive")

    # 执行日志（docs/执行日志）按项目归集：0 张卡但一直写日志的项目靠它才有落点
    logs = []
    try:
        logs = core.api_log_list(limit=9999) or []
    except Exception:
        logs = []
    logs_by_proj: dict[str, list] = {}
    for lg in logs:
        logs_by_proj.setdefault(str(lg.get("project") or ""), []).append(lg)
    for v in logs_by_proj.values():
        v.sort(key=lambda x: str(x.get("created") or ""), reverse=True)

    # 任务按项目归集（frontmatter「项目」是数组，必须先归一化）
    by_proj: dict[str, dict] = {}
    for t in active + archived:
        for pid in _as_list(t.get("项目")):
            slot = by_proj.setdefault(pid, {"active": [], "archived": []})
            if t in archived:
                slot["archived"].append(t)
            else:
                slot["active"].append(t)

    rows = []
    for p in projects:
        pid = p.get("id") or ""
        repo = p.get("repo") or ""
        bucket = by_proj.get(pid, {"active": [], "archived": []})
        act = bucket["active"]
        statuses = [str(t.get("状态") or "") for t in act]
        blocked = 0
        for t in act:
            try:
                if core.blockers_of(t.get("id", "")):
                    blocked += 1
            except Exception:
                pass
        policy_fn = os.path.join(data_dir, "policies", pid + ".md")
        contract_fn = os.path.join(repo, CONTRACT_NAME) if repo else ""
        my_logs = logs_by_proj.get(pid, [])
        last_commit_iso = _git(repo, "log", "-1", "--format=%cI")
        recent_commit = False
        if last_commit_iso:
            try:
                _t = _dt.datetime.fromisoformat(last_commit_iso.replace("Z", "+00:00"))
                recent_commit = (_dt.datetime.now(_t.tzinfo) - _t).days <= 30
            except ValueError:
                recent_commit = False
        undone = statuses.count("待办") + statuses.count("进行中") + statuses.count("待验收")

        rows.append({
            "id": pid,
            "name": p.get("name") or "",
            "released": bool(p.get("_released")),
            "repo": repo,
            "repo_exists": os.path.isdir(repo),
            "reg_status": str(p.get("状态") or ""),
            "reg_roadmap": str(p.get("路线图") or ""),
            "policy": os.path.isfile(policy_fn),
            "contract": bool(contract_fn) and os.path.isfile(contract_fn),
            "active": len(act),
            "done": statuses.count("完成"),
            "todo": statuses.count("待办"),
            "doing": statuses.count("进行中"),
            "review": statuses.count("待验收"),
            "blocked": blocked,
            "archived": len(bucket["archived"]),
            "logs": len(my_logs),
            "last_log": str((my_logs[0].get("title") if my_logs else "") or ""),
            "trip": bool(undone) or recent_commit,      # 在途判据（2026-10-05 暮雨拍板）
            "last_commit": _rel_time(last_commit_iso),
            "dirty": len([l for l in _git(repo, "status", "--porcelain").splitlines() if l.strip()]),
        })
    known_ids = {r["id"] for r in rows}
    orphan_logs = [lg for lg in logs if str(lg.get("project") or "") not in known_ids]
    return {"data_dir": data_dir, "rows": rows, "orphan_logs": orphan_logs}


def render_md(data: dict) -> str:
    rows = data["rows"]
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        "# 方寸 · Step 0 盘点（只读）",
        "",
        f"> 生成：{now} · 数据根：`{data['data_dir']}`",
        "> 本表由 `scripts/step0-inventory.py` 生成，**零写入**；重跑同命令即可复验。",
        "> 契约主线（REV-001）落地前置：先看清登记的项目各自缺什么，再谈契约层施工。",
        "",
        "## 一、15 项盘点表",
        "",
        "| # | 项目 | 显示名 | repo | 状态 | 方针 | **契约** | 在库 | 完成 | 待办 | 进行 | 待验 | 阻塞 | **日志** | **在途** | git 最后提交 | 未提交 |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for i, r in enumerate(rows, 1):
        flag = lambda b: "✅" if b else "—"  # noqa: E731
        repo_cell = flag(r["repo_exists"]) + ("" if r["repo_exists"] else " ⚠")
        trip = "**✔**" if r["trip"] else "—"
        lines.append(
            f"| {i} | `{r['id']}` | {r['name']} | {repo_cell} | "
            f"{r['reg_status'] or '—'} | {flag(r['policy'])} | **{flag(r['contract'])}** | {r['active']} | {r['done']} | "
            f"{r['todo']} | {r['doing']} | {r['review']} | {r['blocked']} | {r['logs']} | {trip} | "
            f"{r['last_commit']} | {r['dirty']} |"
        )

    missing_contract = [r for r in rows if not r["contract"] and not r["released"]]
    missing_policy = [r for r in rows if not r["policy"] and not r["released"]]
    broken_repo = [r for r in rows if not r["repo_exists"]]
    trip_rows = [r for r in rows if r["trip"]]
    zero_card = [r for r in rows if r["active"] == 0 and r["archived"] == 0]
    zero_both = [r for r in trip_rows if r["active"] == 0 and r["logs"] == 0]
    orphan_logs = data.get("orphan_logs") or []
    lines += [
        "",
        "## 二、结论（自动汇总）",
        "",
        f"- 登记项目合计 **{len(rows)}**（含 released {sum(1 for r in rows if r['released'])}）",
        f"- **在途（判据＝有未完结卡 或 30 天内有提交）：{len(trip_rows)} 个** —— " +
        "、".join(f"`{r['id']}`" for r in trip_rows),
        f"- **契约文件：{sum(1 for r in rows if r['contract'])}/{len(rows)} 存在 —— 契约层仍近乎空白**",
        f"- 执行日志合计 **{sum(r['logs'] for r in rows)} 条**；**0 卡但有日志的项目**：" +
        ("、".join(f"`{r['id']}`（{r['logs']} 条）" for r in trip_rows if r["active"] == 0 and r["logs"] > 0) or "无"),
        f"- 零任务卡项目 **{len(zero_card)}**：" +
        ("、".join(f"`{r['id']}`" for r in zero_card) or "无"),
        f"- 方针卡缺失 **{len(missing_policy)}**：" +
        ("、".join(f"`{r['id']}`" for r in missing_policy) or "无"),
        f"- repo 路径不存在 **{len(broken_repo)}**：" +
        ("、".join(f"`{r['id']}`（{r['repo']}）" for r in broken_repo) or "无"),
        f"- ⚠ **在途但三样全空**（无卡、无日志）**{len(zero_both)}**：" +
        ("、".join(f"`{r['id']}`" for r in zero_both) or "无") +
        " —— 30 天内有仓库提交（判据放宽的代价，如实显示）",
        (f"- ⚠ **孤儿日志 {len(orphan_logs)} 条**（`project` 不在登记表）：" +
         "、".join(f"`{str(lg.get('project') or '(空)')}`" for lg in orphan_logs) +
         " —— 这些日志在一屏上归不到任何项目" if orphan_logs else "- 孤儿日志：无"),
        "",
        "## 三、口径说明",
        "",
        "- 「在库卡」= task-data 根下**未被归档**的卡（**含已完成未归档**，所以不等于「未完结」）；",
        "- 「完成/待办/进行/待验」按 frontmatter `状态` 字面统计（唯一权威来源，不做二次推断）。",
        "- 「阻塞」= `core.blockers_of(tid)` 非空（前置未终态）的卡数。",
        "- 「契约」= 各项目 repo 内 `立项契约.md`（与 AGENTS.md 同级）是否存在；方寸只读，不写他人仓库。",
        "- 本脚本不修改任何数据；如 `git` 不在 PATH 或该目录非仓库，相关两列为 `—`/`0`。",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="方寸 Step 0 只读盘点")
    ap.add_argument("--out", default="", help="输出 Markdown 路径（默认 docs/step0-盘点-<日期>.md）")
    ap.add_argument("--stdout", action="store_true", help="只打印到 stdout，不写文件")
    args = ap.parse_args()

    data = collect()
    md = render_md(data)

    if not args.stdout:
        out = args.out or os.path.join(
            REPO_ROOT, "docs", f"step0-盘点-{_dt.date.today().strftime('%Y%m%d')}.md")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(md)
        print(f"已写入: {out}")

    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
