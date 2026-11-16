#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hermes 会话捞取器（2026-11-16 · B 任务）

暮雨：「捞 Hermes」。

── 事实（本轮实测，与 DSH 完全不同，不能套用）─────────────────────────
  · DSH 是 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（zstd 多帧，需逐帧解）
  · **Hermes 是 SQLite**：`%LOCALAPPDATA%\\hermes\\state.db`（**887 MB**）
      - `sessions` 表 232 行（source: oneshot 116 / local 58 / subagent 25 / desktop 17 / cron 8）
      - `messages` 表 **42,190** 行（tool 21,803 · assistant 19,531 · **user 858**）
      - 自带 FTS（`messages_fts_*`）
  · 时间起点 **2026-07-26**，比 DSH 更早（DSH 最早 2026-10-01）

── 只捞 `role='user'`，三道筛子与 DSH 那边同一口径 ─────────────────────
  ① 排除 `source='subagent'`（子 agent 的派工提示也是 user 消息）
  ② 排除注入型文本（Hermes 会把自己的后台进程通知写成 user 消息：
     `[IMPORTANT: Background process … matched watch pattern]`）
  ③ 排除 cron / oneshot 的系统触发话术

三条纪律：
  ① **只读**：`mode=ro` URI 打开 SQLite，一个字节都不写；
  ② **缺就说缺**：库不存在 / 表不存在 / 读不动，逐条报；
  ③ **不猜**：只输出原文与时间，不做摘要、不判「做没做」。

用法：
  python scripts/harvest-hermes.py --list
  python scripts/harvest-hermes.py --out docs/捞-Hermes-20261116.md
  python scripts/harvest-hermes.py --raw          # 不滤注入型
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sqlite3
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOME = os.environ.get("HERMES_HOME") or os.path.join(
    os.environ.get("LOCALAPPDATA", ""), "hermes")
DB = os.path.join(HOME, "state.db")

MAX_TEXT = 1500

# 「打着 user 旗号、其实不是人打的」——与 DSH 侧 INJECT_PATTERNS 同源
INJECT_PATTERNS = [
    re.compile(r"^\[IMPORTANT: Background process"),
    re.compile(r"^\[SYSTEM"),
    re.compile(r"^<system-reminder>"),
    re.compile(r"^\[Cron"),
    re.compile(r"^\s*请把以下内容记录"),
]


def strip_attached(text: str) -> str:
    """砍掉「附件上下文」那一段。

    Hermes 会把用户 @ 的文件**整份粘进 user 消息**，形如：

        --- Attached Context ---
        📄 @file:xxx.py (1647 tokens)
        ```python
        …整份代码…
        ```

    不砍的话，捞出来的「用户发言」里大半是**代码**，判定时会被代码里的词骗过
    （和 DSH 那边「交接日志混进 user 消息」是同一类病）。
    """
    s = str(text or "")
    for marker in ("\n--- Attached Context ---", "\n--- Attached", "\n[Attached Context]"):
        i = s.find(marker)
        if i > 0:
            return s[:i].rstrip() + "\n\n（附件上下文已裁掉）"
    return s


def is_injected(t: str) -> bool:
    s = str(t or "").strip()
    return any(p.search(s) for p in INJECT_PATTERNS)


def fmt_ts(v):
    if not v:
        return ""
    try:
        return dt.datetime.fromtimestamp(float(v)).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(v)[:19]


def open_ro():
    if not os.path.exists(DB):
        raise SystemExit("✗ 找不到 Hermes 数据库：%s" % DB)
    uri = "file:%s?mode=ro" % DB.replace("\\", "/")
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


def list_overview(con):
    cur = con.cursor()
    out = {}
    out["db"] = DB
    out["db_mb"] = round(os.path.getsize(DB) / 1048576, 1)
    out["sessions"] = cur.execute("select count(*) from sessions").fetchone()[0]
    out["messages"] = cur.execute("select count(*) from messages").fetchone()[0]
    out["users"] = cur.execute(
        "select count(*) from messages where role='user'").fetchone()[0]
    out["by_source"] = [(r["source"] or "(空)", r["c"]) for r in cur.execute(
        "select source, count(*) c from sessions group by source order by c desc")]
    r = cur.execute("select min(timestamp), max(timestamp) from messages where role='user'").fetchone()
    out["span"] = (fmt_ts(r[0]), fmt_ts(r[1]))
    return out


def harvest(con, drop_injected=True, drop_subagent=True):
    cur = con.cursor()
    sql = """
        select m.session_id, m.role, m.content, m.timestamp,
               s.source, s.cwd, s.title, s.parent_session_id, s.display_name
        from messages m
        left join sessions s on s.id = m.session_id
        where m.role='user' and m.content is not null and length(trim(m.content))>0
        order by m.timestamp
    """
    rows = []
    dropped = {"subagent": 0, "injected": 0, "empty": 0}
    for r in cur.execute(sql):
        text = str(r["content"] or "").strip()
        if not text:
            dropped["empty"] += 1
            continue
        src = (r["source"] or "").strip()
        if drop_subagent and (src == "subagent" or r["parent_session_id"]):
            dropped["subagent"] += 1
            continue
        text = strip_attached(text)
        if drop_injected and is_injected(text):
            dropped["injected"] += 1
            continue
        rows.append({
            "session": r["session_id"] or "",
            "ts": fmt_ts(r["timestamp"]),
            "ts_raw": r["timestamp"],
            "source": src,
            "cwd": r["cwd"] or "",
            "title": r["title"] or "",
            "text": text,
        })
    return rows, dropped


def main():
    ap = argparse.ArgumentParser(description="Hermes 会话捞取（只读）")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--raw", action="store_true", help="不滤注入型 / 子 agent")
    args = ap.parse_args()

    con = open_ro()
    ov = list_overview(con)

    if args.list:
        print("# Hermes 会话库 · %s" % ov["db"])
        print("")
        print("- 大小：**%s MB**" % ov["db_mb"])
        print("- sessions：**%d**" % ov["sessions"])
        print("- messages：**%d**（其中 role=user **%d**）" % (ov["messages"], ov["users"]))
        print("- 时间跨度：%s → %s" % ov["span"])
        print("")
        print("| session source | 会话数 |")
        print("|---|---:|")
        for k, v in ov["by_source"]:
            print("| `%s` | %d |" % (k, v))
        con.close()
        return 0

    rows, dropped = harvest(con, drop_injected=not args.raw, drop_subagent=not args.raw)
    con.close()

    L = []
    L.append("# Hermes 会话里捞到的「用户说过的话」")
    L.append("")
    L.append("- 生成：%s" % dt.datetime.now().strftime("%Y-%m-%d %H:%M"))
    L.append("- 来源：`%s`（**只读**，`mode=ro` 打开，一个字节没写）" % ov["db"])
    L.append("- 库规模：%s MB · sessions %d · messages %d（role=user %d）" % (
        ov["db_mb"], ov["sessions"], ov["messages"], ov["users"]))
    L.append("- 时间跨度：%s → %s" % ov["span"])
    L.append("")
    L.append("- **捞到真人发言：%d 条**" % len(rows))
    L.append("- 筛掉的：子 agent `%d` · 注入型 `%d` · 空 `%d`" % (
        dropped["subagent"], dropped["injected"], dropped["empty"]))
    L.append("")
    L.append("> ⚠ Hermes 是 **SQLite**（`state.db` 887 MB），不是 DSH 那种 zstd 会话文件 —— "
             "两边格式完全不同，不能套用同一个解析器。")
    L.append(">")
    L.append("> ⚠ 只捞 `role='user'`，且排除子 agent 会话与注入型")
    L.append("> （Hermes 会把自己的后台进程通知写成 user 消息："
             "`[IMPORTANT: Background process … matched watch pattern]`）。")
    L.append("")

    # 按会话分组
    from collections import OrderedDict
    groups = OrderedDict()
    for r in rows:
        groups.setdefault(r["session"], []).append(r)

    L.append("## 按会话（%d 个）" % len(groups))
    L.append("")
    for sid, ms in groups.items():
        first = ms[0]
        L.append("### `%s` · %s" % (sid, first["ts"]))
        L.append("")
        meta = []
        if first["source"]:
            meta.append("source `%s`" % first["source"])
        if first["cwd"]:
            meta.append("`%s`" % first["cwd"])
        if first["title"]:
            meta.append(first["title"][:60])
        if meta:
            L.append("- " + " · ".join(meta))
        L.append("- 用户发言：**%d** 条" % len(ms))
        L.append("")
        for m in ms:
            t = m["text"]
            if len(t) > MAX_TEXT:
                t = t[:MAX_TEXT] + "…（原文 %d 字）" % len(m["text"])
            L.append("> " + t.replace("\n", "\n> "))
            L.append("")

    text = "\n".join(L)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        with open(args.out, encoding="utf-8") as f:
            back = f.read()
        print("已写 %d 字节 → %s" % (len(back.encode("utf-8")), args.out))
        print("真人发言 %d 条（筛掉：子 agent %d · 注入 %d · 空 %d）" % (
            len(rows), dropped["subagent"], dropped["injected"], dropped["empty"]))
        return 0

    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
