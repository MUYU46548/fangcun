#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""层厚度检查器 · 只读（2026-11-16）

暮雨 2026-11-15 深夜的转向：「骨架补齐以后，规划会自己长出来」。
第一批要验的不是"能不能做"，而是**这个数能不能自动算出来** ——
那晚「编辑器 92% / 生成器 8%」是我手工算的，而手工算的数没人能复算。

所以本脚本只做一件事：**给一个项目，算出「层 → 文件数 → 行数 → 占比」**，
并回答一句它该回答的话：

    这个项目号称是 A，但 88% 的行数在 B。

而不是把所有模块罗列一遍（罗列等于没回答：用户自己也看得见目录）。

三条纪律（沿用本仓反复吃亏的口径）：
  ① **只读**：除 `--out` 指定的报告外，一个字节都不写（不写 task-data、不写项目仓库）；
  ② **缺就说缺**：仓库不在 / 路径不存在 = `missing` 并写明缺什么，**绝不填 0**
     （0 会被读成"这层真的没有代码"，与"没扫到"是两件事）；
  ③ **数字自带局限**：行数只是**体量**，不是"成熟度"也不是"质量"。每个数旁边说清它证明不了什么。

用法：
  python scripts/layer-profile.py sitian                    # 单项目
  python scripts/layer-profile.py                           # registry 里全部项目
  python scripts/layer-profile.py sitian --depth 2           # 更粗的层
  python scripts/layer-profile.py sitian --spec scripts/layer-specs/sitian.json
  python scripts/layer-profile.py sitian --json
  python scripts/layer-profile.py sitian --out docs/层厚度-司天-20261116.md
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# registry 可被 FC_REGISTRY 覆盖 —— 只给测试用（造一份"项目路径不存在"的注册表），
# 生产路径永远是仓库根下那一份。
REGISTRY = os.environ.get("FC_REGISTRY") or os.path.join(ROOT, "registry.yaml")
# spec 的**唯一真源**在 task-data/layer-specs/（随备份包走、桌面版也读这一份）。
# ⚠ 不许在 scripts/ 下再放一份 —— 双源必然漂移（本仓栽过多次）。
SPEC_DIR = os.environ.get("FC_LAYER_SPEC_DIR") or os.path.join(ROOT, "task-data", "layer-specs")

# 代码扩展名。**刻意不含 .md** —— 文档不是"层厚度"。
CODE_EXTS = (
    ".py", ".pyw", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
    ".vue", ".svelte", ".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php",
    ".c", ".h", ".cpp", ".hpp", ".sh", ".ps1", ".bat", ".html", ".css", ".scss", ".sql",
)

# 一律不进的目录（依赖 / 构建产物 / 缓存 / 备份 / 临时 / 内嵌运行时）。
# 每条都写理由：删掉任何一条都会让某个项目的第一名变成 node_modules。
# ⚠ 2026-11-16 全项目首跑后补了四类 —— 每一类都曾在真项目上把"产品代码"算成一个假数：
#   ① `win-unpacked` / `pkg`：方寸 50 万行"产品代码"里 36 万行是打包出来的 Electron 副本；
#   ② `runtime` / `site-packages`：墨坊 31.9 万行、明鉴 12.7 万行几乎全是内嵌 Python 运行时；
#   ③ `Temp`：临时目录；
#   ④ `_attachments`：执行日志附件（含误挂的大 bundle），是用户数据不是代码。
SKIP_DIRS = {
    "node_modules": "依赖",
    ".git": "版本库",
    "dist": "构建产物",
    "build": "构建产物",
    "out": "构建产物",
    "release": "打包产物",
    "win-unpacked": "打包产物（electron-builder 未压缩目录）",
    "desktop-build": "打包产物（记忆圣所这个目录名）",
    "pkg": "发版取件目录（官方定义：desktop/pkg 放安装包）",
    "coverage": "覆盖率产物",
    "__pycache__": "字节码缓存",
    ".venv": "虚拟环境",
    "venv": "虚拟环境",
    "env": "虚拟环境",
    "site-packages": "第三方库（vendored）",
    "runtime": "内嵌运行时（python/node 发行版整份拷进来）",
    "Temp": "临时目录",
    "temp": "临时目录",
    "tmp": "临时目录",
    "backups": "备份",
    "_attachments": "执行日志附件（用户数据，不是代码）",
    ".pkg-tmp": "打包暂存",
    ".sitian": "运行时缓存",
    ".workbuddy": "agent 私有目录",
    ".hermes": "agent 私有目录",
    ".trash": "回收站",
}
# 前缀 / 模式类跳过（release-0.6.4 这种无法枚举）
SKIP_PREFIX = ("release-", "release_", ".pkg-tmp", "dist-")
# 这些文件名出现 = 这是一个内嵌解释器/虚拟环境，而不是项目自己的代码。
# 光靠目录名挡不住（`console/runtime/python` 的 `python` 也可能是正常模块名）。
VENDOR_MARKERS = ("pyvenv.cfg", "python.exe", "python3.dll", "node.exe", "electron.exe")
# 这些目录名说明"这一层不是产品，是测试或工具"
TEST_DIR_NAMES = {"test", "tests", "spec", "specs", "__tests__", "e2e"}
TOOL_DIR_NAMES = {"scripts", "tools", "tooling", "dev-scripts"}


def _read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def count_lines(p):
    """按 \n 切行（splitlines 口径）。

    ⚠ 判文本**不能只看 UTF-8**（2026-11-16 实测踩到两面）：
      · 一面：`.ts` 既是 TypeScript 也是 **MPEG 视频分片** —— 那边的 `frames/seg_04.ts`
        一片 7 千行，不挡就是全仓最厚的"产品代码"。所以二进制（含 NUL）必须挡。
      · 另一面：`96 事务管理/索引预览.bat` 是 **GBK 编码的合法脚本**（`chcp 936`），
        只认 UTF-8 会把它当成二进制丢掉 —— 那就是拿"看不见"当成"没有"。
    所以：先按 NUL 字节 + 高控制字符判二进制；再依次试 utf-8 / gbk / utf-16。
    """
    with open(p, "rb") as f:
        raw = f.read()
    if not raw:
        return 0
    if _looks_binary(raw):
        raise ValueError("二进制（含 NUL 或高比例控制字节）")
    for enc in ("utf-8", "gbk", "utf-16"):
        try:
            raw.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    else:
        raise ValueError("解不出文本（utf-8 / gbk / utf-16 全失败）")
    return raw.count(b"\n") + (0 if raw.endswith(b"\n") else 1)


def _looks_binary(raw):
    """二进制判据：有 NUL 字节就算（文本文件不会有）；
    否则看控制字符比例（除 \\t \\r \\n 之外的 <0x09 / 0x0E-0x1F）超过 5% 也算。"""
    head = raw[:8192]
    if b"\x00" in head:
        return True
    ctrl = sum(1 for b in head if b < 0x09 or (0x0E <= b <= 0x1F))
    return bool(head) and (ctrl / len(head)) > 0.05


def parse_registry(text):
    """按项目切块取 id / name / repo / 状态。不 YAML load（与 check-mismatch.py 同一原则）。"""
    projects, cur = [], None
    for line in text.splitlines():
        m = re.match(r"^\s*-\s+id:\s*(.+?)\s*$", line)
        if m:
            if cur:
                projects.append(cur)
            cur = {"id": m.group(1).strip().strip('"\''), "name": "", "repo": "", "status": ""}
            continue
        if cur is None:
            continue
        for key, field in (("name", "name"), ("repo", "repo"), ("状态", "status")):
            m = re.match(r"^\s+%s:\s*(.*)$" % re.escape(key), line)
            if m:
                cur[field] = m.group(1).strip().strip('"\'')
    if cur:
        projects.append(cur)
    return projects


def find_project(pid):
    if not os.path.exists(REGISTRY):
        return None
    pid_l = pid.lower()
    for p in parse_registry(_read(REGISTRY)):
        if p["id"].lower() == pid_l or p["name"] == pid:
            return p
    return None


def norm_repo(repo):
    if not repo:
        return ""
    r = os.path.expanduser(repo.replace("\\", "/"))
    return r


def walk_files(repo):
    """返回 ([(abs_path, rel_path)], skipped)。

    `skipped` 记下**因为规则而没进去的顶层目录** —— 不静默：
    分母被一个浏览器 profile 目录撑到 300 万行，所有百分比就全是假的（2026-11-16 实测踩到）。
    """
    out, skipped = [], []
    for entry in sorted(os.listdir(repo)):
        ap = os.path.join(repo, entry)
        if not os.path.isdir(ap):
            continue
        if entry in SKIP_DIRS:
            skipped.append({"dir": entry, "why": SKIP_DIRS[entry]})
        elif entry.startswith(SKIP_PREFIX):
            skipped.append({"dir": entry, "why": "打包/构建产物（前缀规则）"})
        elif entry.startswith("."):
            # 隐藏目录一律不进：本机实测有 .test-edge-profile-3d / .lab-edge-profile
            # 这类浏览器 profile，一个顶得上整个产品的 20 倍行数。
            skipped.append({"dir": entry, "why": "隐藏目录（VCS / 浏览器 profile / 缓存）"})
        elif any(os.path.exists(os.path.join(ap, mk)) for mk in VENDOR_MARKERS):
            # 目录名正常、里面却是一整份解释器（如 console/runtime/python 里带 python.exe）
            skipped.append({"dir": entry, "why": "目录里带解释器可执行文件 = 内嵌运行时，不是项目代码"})
    def is_skip(d):
        return d in SKIP_DIRS or d.startswith(SKIP_PREFIX) or d.startswith(".")
    for dp, dn, fn in os.walk(repo):
        # 走到子目录时也要挡住内嵌运行时（顶层那份检测不到深层）
        keep = []
        for d in dn:
            sub = os.path.join(dp, d)
            rel = os.path.relpath(sub, repo).replace("\\", "/")
            if is_skip(d):
                # 只有顶层已经在上面记过了，这里补记嵌套的（nest 才是大头：
                # 墨坊 267k 行在 console/runtime/python，顶层看不出任何异常）
                if "/" in rel and len(skipped) < 60:
                    why = SKIP_DIRS.get(d) or "打包/构建产物（前缀规则）"
                    skipped.append({"dir": rel, "why": why, "nested": True})
                continue
            if any(os.path.exists(os.path.join(sub, mk)) for mk in VENDOR_MARKERS):
                if len(skipped) < 60:
                    skipped.append({"dir": rel,
                                    "why": "目录里带解释器可执行文件 = 内嵌运行时，不是项目代码",
                                    "nested": True})
                continue
            keep.append(d)
        dn[:] = keep
        for f in fn:
            if not f.lower().endswith(CODE_EXTS):
                continue
            ap = os.path.join(dp, f)
            rel = os.path.relpath(ap, repo).replace("\\", "/")
            out.append((ap, rel))
    return out, skipped


def layer_of(rel, depth):
    """齿到 depth 段。不足 depth 段就用父目录全路径；根下文件记 (根)。"""
    segs = rel.split("/")
    if len(segs) == 1:
        return "(根)"
    if len(segs) - 1 <= depth:
        return "/".join(segs[:-1])
    return "/".join(segs[:depth])


def role_of(layer):
    """把层粗分三类：产品 / 测试 / 工具。判据是**目录名**，不是文件内容 —— 说清这一点。"""
    parts = [x.lower() for x in layer.split("/")]
    if any(p in TEST_DIR_NAMES for p in parts):
        return "测试"
    if any(p in TOOL_DIR_NAMES for p in parts):
        return "工具"
    return "产品"


def scan_files(repo, extra_excludes=None):
    """返回逐文件 [(rel, lines)] + 读不动的清单 + 被规则挡在外面的顶层目录。

    这是唯一的数据源 —— 目录层与「声称的分层」都从它派生，
    避免两套扫描口径对不上（本仓栽过：同一份数据两处口径，一份说 71 一份说 130）。

    `extra_excludes` 来自项目 spec：**通用规则猜不到的**才写在这里。
    例：quartz 的 `public/` 是生成的站点（10 万行 HTML），但别的项目里 `public/`
    就是源码 —— 所以只能按项目声明，不能进全局黑名单。"""
    files, skipped = walk_files(repo)
    recs, unreadable, nonText = [], [], []
    extra = [p.rstrip("/") for p in (extra_excludes or [])]
    for ap, rel in files:
        if extra and any(rel == e or rel.startswith(e + "/") for e in extra):
            continue
        try:
            recs.append((rel, count_lines(ap)))
        except ValueError as e:
            # 扩展名像代码、其实不是（`.ts` 视频分片 / 二进制资源）
            nonText.append({"file": rel, "why": str(e)})
        except OSError as e:
            unreadable.append({"file": rel, "why": str(e)})
    for e in extra:
        skipped.append({"dir": e, "why": "项目 spec 里声明排除（通用规则猜不到：在该项目里它是生成物）"})
    return recs, unreadable, nonText, skipped


def group_layers(recs, depth):
    layers = {}
    for rel, n in recs:
        layer = layer_of(rel, depth)
        rec = layers.setdefault(layer, {"files": 0, "lines": 0})
        rec["files"] += 1
        rec["lines"] += n
    rows = [{"layer": k, "role": role_of(k), "files": v["files"], "lines": v["lines"]}
            for k, v in layers.items()]
    rows.sort(key=lambda r: (-r["lines"], r["layer"]))
    return rows


def _match(rel, pats):
    """路径匹配：以 `/` 结尾 = 目录前缀；含 `*` = fnmatch 通配；否则按目录前缀或整文件相等。"""
    import fnmatch
    for p in pats:
        if "*" in p or "?" in p:
            if fnmatch.fnmatch(rel, p):
                return True
            continue
        q = p.rstrip("/")
        if rel == q or rel.startswith(q + "/"):
            return True
    return False


def apply_spec(recs, spec):
    """按 spec 把**逐文件行数**聚成「声称的分层」。跑在文件级而不是目录级 ——
    因为 `utils/terrain*.js` 这种"一层是文件名前缀"的分法，目录聚合天生看不见。"""
    named = []
    for name, item in spec.get("layers", {}).items():
        pats = item.get("paths", [])
        hit = [(rel, n) for rel, n in recs if _match(rel, pats)]
        hit.sort(key=lambda x: -x[1])
        named.append({"name": name,
                      "lines": sum(n for _, n in hit),
                      "files": len(hit),
                      "sample": [rel for rel, _ in hit[:4]],
                      "note": item.get("note", "")})
    named.sort(key=lambda r: -r["lines"])
    return named


def apply_groups(named, spec):
    """spec 里可选 declare「哪几层是一伙的」（如 生成器 / 编辑器）。
    这个分法是**人给的**，脚本不猜。没有 groups 就不报这一节。"""
    groups = spec.get("groups") or {}
    if not groups:
        return []
    by_name = {n["name"]: n for n in named}
    out = []
    for gname, members in groups.items():
        lines = sum(by_name[m]["lines"] for m in members if m in by_name)
        missing = [m for m in members if m not in by_name]
        out.append({"name": gname, "lines": lines, "members": members, "missing": missing})
    out.sort(key=lambda g: -g["lines"])
    return out


def verdict(rows, named, total_lines, groups=None):
    """必须回答一句话，而不是罗列。这就是这个脚本存在的理由。

    ⚠ 分母口径（2026-11-16 首跑踩到）：第一版拿**全部代码行**当分母，
    于是「编辑器占 8.9%」—— 剩下的 91% 是测试和脚本。那不是"薄"，是**分错了母**。
    分层占比只在**产品代码**内部比较才有意义；所以这里同时给两个分母，说清哪个是哪个。
    """
    groups = groups or []
    if total_lines <= 0:
        return ("扫不到任何代码行 —— 这不是「厚度为 0」，是**没扫到**："
                "路径/扩展名/排除规则至少有一个不对。")
    by_role = {}
    for r in rows:
        by_role[r["role"]] = by_role.get(r["role"], 0) + r["lines"]
    prod = by_role.get("产品", 0)
    out = []

    if groups:
        base = prod or total_lines
        top = groups[0]
        share = top["lines"] / base * 100 if base else 0
        out.append("**【{}】{:,} 行，占产品代码 {:.1f}%。**".format(top["name"], top["lines"], share))
        for g in groups[1:]:
            s = g["lines"] / base * 100 if base else 0
            out.append("【{}】{:,} 行（{:.1f}%）。".format(g["name"], g["lines"], s))
        if len(groups) >= 2 and groups[-1]["lines"] > 0:
            ratio = groups[0]["lines"] / groups[-1]["lines"]
            out.append("「{}」是「{}」的 **{:.1f} 倍**。".format(
                groups[0]["name"], groups[-1]["name"], ratio))
    elif named:
        base = prod or total_lines
        top = named[0]
        out.append("声称的分层里最厚的是「{}」：{:,} 行，占产品代码 {:.1f}%。".format(
            top["name"], top["lines"], (top["lines"] / base * 100) if base else 0))

    out.append("产品 {:,} 行 · 测试 {:,} 行 · 工具 {:,} 行（全仓合计 {:,}）。".format(
        prod, by_role.get("测试", 0), by_role.get("工具", 0), total_lines))
    if rows[:3]:
        out.append("最厚的三个目录层：" + " · ".join(
            "{} {:,}行".format(r["layer"], r["lines"]) for r in rows[:3]))
    return " ".join(out)


def render_text(project, repo, rows, named, total, unreadable, spec, depth,
                skipped=None, groups=None, nonText=None):
    skipped = skipped or []
    groups = groups or []
    nonText = nonText or []
    out = []
    out.append("# 层厚度 · {}".format(project["name"] or project["id"]))
    out.append("")
    out.append("- 项目 id：`{}`".format(project["id"]))
    out.append("- 仓库：`{}`".format(repo or "(registry 未登记 repo)"))
    if repo and not os.path.isdir(repo):
        out.append("- ⚠ **仓库路径不存在** —— 下面没有任何数字，因为扫不到 ≠ 厚度为 0。")
        return "\n".join(out)
    out.append("- 扫描时刻：{}".format(_dt.datetime.now().strftime("%Y-%m-%d %H:%M")))
    out.append("- 层齿深 depth={}（路径前 {} 段当作一层）".format(depth, depth))
    out.append("- 代码扩展名 {} 种；**不含 .md**（文档不算层厚度）".format(len(CODE_EXTS)))
    out.append("- 排除目录 {} 个（依赖/构建产物/缓存/备份/虚拟环境）".format(len(SKIP_DIRS)))
    out.append("")
    out.append("## 一句话结论")
    out.append("")
    out.append(verdict(rows, named, total, groups))
    out.append("")
    if groups:
        out.append("## 大账（按 spec 给的分法）")
        out.append("")
        prod = sum(r["lines"] for r in rows if r["role"] == "产品")
        base = prod or total
        out.append("| 大块 | 行数 | 占产品代码 | 由哪几层合成 |")
        out.append("|---|---:|---:|---|")
        for g in groups:
            out.append("| {} | {:,} | {:.1f}% | {} |".format(
                g["name"], g["lines"], (g["lines"] / base * 100) if base else 0,
                "、".join(g["members"])))
        out.append("")
        if any(g["missing"] for g in groups):
            miss = sorted({m for g in groups for m in g["missing"]})
            out.append("> ⚠ spec 里点了名但没扫到的层：{} —— **不是这层是 0，是名字对不上**。".format(
                "、".join(miss)))
            out.append("")
        out.append("> 分母是**产品代码** {} 行，不是全仓 {} 行。拿全仓当分母会把测试的行数算成「编辑器很厚」。".format(
            "{:,}".format(base), "{:,}".format(total)))
        out.append("")
        # 只在 spec 点名的这几块内部比 —— 这是"两块之间谁厚谁薄"的唯一诚实口径。
        # 2026-11-15 手工说的「编辑器 92% / 生成器 8%」正是这个口径；复算得 93.2% / 6.8%，成立。
        named_total = sum(g["lines"] for g in groups)
        if named_total > 0:
            out.append("只算这几块（合计 {:,} 行）内部的占比：{}。".format(
                named_total,
                " · ".join("{} **{:.1f}%**".format(g["name"], g["lines"] / named_total * 100)
                           for g in groups)))
            out.append("")
    if named:
        out.append("## 按「声称的分层」对账")
        out.append("")
        if spec.get("source"):
            out.append("> 声称出处：{}".format(spec["source"]))
            out.append("")
        out.append("| 层 | 文件数 | 行数 | 占全仓代码 | 命中的文件（示例） |")
        out.append("|---|---:|---:|---:|---|")
        for n in named:
            share = (n["lines"] / total * 100) if total else 0
            out.append("| {} | {} | {:,} | {:.1f}% | {} |".format(
                n["name"], n["files"], n["lines"], share,
                "、".join("`{}`".format(x) for x in n["sample"][:3]) or "**（没扫到任何文件）**"))
        out.append("")
        if spec.get("claims"):
            out.append("### 与声称的数字逐条对账")
            out.append("")
            out.append("| 层 | 声称 | 实测 | 差 |")
            out.append("|---|---:|---:|---|")
            for name, claim in spec["claims"].items():
                got = next((n["lines"] for n in named if n["name"] == name), None)
                if got is None:
                    out.append("| {} | {:,} | **不在 spec 里** | — |".format(name, claim))
                    continue
                delta = got - claim
                if delta == 0:
                    out.append("| {} | {:,} | {:,} | 一致 |".format(name, claim, got))
                    continue
                sign = "实测多" if delta > 0 else "实测少"
                out.append("| {} | {:,} | {:,} | {} {:,}（{:+.1f}%） |".format(
                    name, claim, got, sign, abs(delta),
                    (delta / claim * 100) if claim else 0))
            out.append("")
            out.append("> 这一节存在的理由：手工算的数**没人能复算**。当场对出来才叫数。")
            if spec.get("claimsNote"):
                out.append(">")
                for ln in str(spec["claimsNote"]).splitlines():
                    out.append("> " + ln)
            out.append("")
    out.append("## 全部目录层（按行数降序，前 25）")
    out.append("")
    out.append("| 层 | 角色 | 文件数 | 行数 | 占比 |")
    out.append("|---|---|---:|---:|---:|")
    for r in rows[:25]:
        share = (r["lines"] / total * 100) if total else 0
        out.append("| `{}` | {} | {} | {:,} | {:.1f}% |".format(
            r["layer"], r["role"], r["files"], r["lines"], share))
    if len(rows) > 25:
        out.append("")
        out.append("（另有 {} 层未列出，合计 {:,} 行 —— 折叠不等于没有）".format(
            len(rows) - 25, sum(r["lines"] for r in rows[25:])))
    out.append("")
    out.append("## 这个数证明不了什么")
    out.append("")
    out.append("- **行数 = 体量，不是成熟度**。同一个人写的 100 行与 1 万行，前者未必更差。")
    out.append("- 「产品/测试/工具」是按**目录名**分的，不是按内容。项目若把测试放进 `src/` 就会算进产品。")
    out.append("- 排除规则是一张**白名单式的黑名单**：新框架的新产物目录（如 `__generated__`）不在表里，会被算进去。")
    out.append("- 它回答的是「哪里重、哪里薄」，**不回答「薄的那层该不该补」** —— 那是判断，得人来下。")
    if nonText:
        out.append("")
        out.append("## ⚠ 扩展名像代码、其实是二进制（{:,} 个，**未计入**）".format(len(nonText)))
        out.append("")
        for u in nonText[:10]:
            out.append("- `{}` —— {}".format(u["file"], u["why"]))
        if len(nonText) > 10:
            out.append("- …另有 {} 个".format(len(nonText) - 10))
        out.append("")
        out.append("> 这一节存在的理由：`.ts` 既是 TypeScript 也是 **MPEG 视频分片**。"
                   "2026-11-16 实测「视频制作」项目里 `frames/seg_04.ts` 一片 7 千行，"
                   "不挡的话它会被算成全仓最厚的「产品代码」。**扩展名不够判代码。**")
    if unreadable:
        out.append("")
        out.append("## ⚠ 读不动的文件（{:,} 个，未计入）".format(len(unreadable)))
        out.append("")
        for u in unreadable[:20]:
            out.append("- `{}` —— {}".format(u["file"], u["why"]))
        if len(unreadable) > 20:
            out.append("- …另有 {} 个".format(len(unreadable) - 20))
    if skipped:
        out.append("")
        out.append("## 被规则挡在外面的顶层目录（{:,} 个，**未计入分母**）".format(len(skipped)))
        out.append("")
        out.append("| 目录 | 为什么不算 |")
        out.append("|---|---|")
        for s in skipped:
            out.append("| `{}` | {} |".format(s["dir"], s["why"]))
        out.append("")
        out.append("> 这一节存在的理由：2026-11-16 首跑时司天根下有一个 `.test-edge-profile-3d`"
                   "（浏览器 profile），287 万行扩展代码把分母撑到 300 万 —— 于是"
                   "「编辑器占 92%」被算成 0.4%，**所有百分比连同结论一起是假的**。"
                   "排除规则必须点名，不许静默。")
    return "\n".join(out)


def profile_one(pid, depth, spec_path, as_json):
    project = find_project(pid)
    if not project:
        return {"id": pid, "missing": "registry.yaml 里没有这个项目（projects / released 都查了）"}
    repo = norm_repo(project["repo"])
    if not repo:
        return {"id": pid, "name": project["name"], "missing": "registry 登记里 repo 为空"}
    if not os.path.isdir(repo):
        return {"id": pid, "name": project["name"], "repo": repo,
                "missing": "repo 路径不存在，扫不到任何文件（不是厚度为 0）"}
    spec = {}
    if spec_path:
        if not os.path.exists(spec_path):
            return {"id": pid, "name": project["name"], "repo": repo,
                    "missing": "spec 文件不存在：{}".format(spec_path)}
        spec = json.loads(_read(spec_path))
    recs, unreadable, nonText, skipped = scan_files(repo, spec.get("exclude"))
    rows = group_layers(recs, depth)
    total = sum(r["lines"] for r in rows)
    named = apply_spec(recs, spec) if spec else []
    groups = apply_groups(named, spec) if spec else []
    if as_json:
        return {"id": project["id"], "name": project["name"], "repo": repo,
                "depth": depth, "total_lines": total, "total_files": sum(r["files"] for r in rows),
                "rows": rows, "named": named, "groups": groups, "spec": spec,
                "verdict": verdict(rows, named, total, groups),
                "unreadable": unreadable, "nonText": nonText, "skipped": skipped}
    return render_text(project, repo, rows, named, total, unreadable, spec, depth,
                       skipped, groups, nonText)


def main():
    ap = argparse.ArgumentParser(description="层厚度检查器（只读）")
    ap.add_argument("project", nargs="?", help="项目 id 或显示名；省略 = registry 全部")
    ap.add_argument("--depth", type=int, default=3, help="路径前 N 段算一层（默认 3）")
    ap.add_argument("--spec", help="声称分层的 JSON（scripts/layer-specs/<id>.json）")
    ap.add_argument("--auto-spec", action="store_true",
                    help="自动用 scripts/layer-specs/<项目id>.json（存在才用）")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out", help="把报告写到这个路径（唯一允许的写入）")
    args = ap.parse_args()

    ids = [args.project] if args.project else [
        p["id"] for p in parse_registry(_read(REGISTRY))] if os.path.exists(REGISTRY) else []

    def spec_for(pid):
        if args.spec:
            return args.spec
        if args.auto_spec:
            proj = find_project(pid)
            key = (proj["id"] if proj else pid)
            cand = os.path.join(SPEC_DIR, key + ".json")
            return cand if os.path.exists(cand) else None
        return None

    if args.json:
        print(json.dumps([profile_one(i, args.depth, spec_for(i), True) for i in ids],
                         ensure_ascii=False, indent=2))
        return 0

    blocks = []
    for i in ids:
        blocks.append(profile_one(i, args.depth, spec_for(i), False))
    text = "\n\n---\n\n".join(blocks)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        # 读回证明写进去了（AGENTS.md 的规矩：写后读回校验）
        back = _read(args.out)
        print("已写 {} 字节 → {}".format(len(back.encode("utf-8")), args.out))
        return 0
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
