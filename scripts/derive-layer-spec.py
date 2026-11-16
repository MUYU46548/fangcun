#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从项目自己的文档里**推导**「声称的分层」，产出 spec 草案（不是成品）。

由来（2026-11-16 暮雨问）：「spec 文件怎么处理？让方寸自己扫描？是否需要模型调用？」

这个脚本就是那个问题的第一个答案：**大部分能机械推导，不需要模型。**

证据（本轮实测）：项目自己的 `AGENTS.md` 里通常有一节「架构 / 目录 / Architecture」，
写成代码块目录树，或者用反引号点出路径。例如记忆圣所：

    ## Architecture
    ```
    /js/main.js          → Bootstrap, theme switch, ...
    /js/game.js          → Core state machine (resources, time, decay, NG+)
    /js/ui.js            → DOM rendering & event binding (no business logic)
    ```

这段话**就是**它声称的分层。抽出来、验证这些路径真的存在、按一级目录聚合成层 ——
全是确定性操作，一个模型都不用调。

⚠ 但脚本**不直接写 spec**：
  ① 它产的是**草案**（`<id>.draft.json`），带「哪些路径没对上」「哪些层推不出来」；
  ② 正式 spec 仍由人（或人点头的 agent）写进 `task-data/layer-specs/<id>.json`；
  ③ 理由：分层是「项目声称它是什么」，**机器推得出来的是"文档里提到过这些目录"**，
     不等于「项目认为这是它的三层架构」。这两件事的差距必须由人补。

⚠ 真正推不出来的时候（AGENTS.md 只写数据流、没写目录），脚本**明说推不出来**，
   不会硬糊一份 —— 那种 project 该走模型起草（BYOK，落待审批卡），或者干脆等它有文档。

用法：
  python scripts/derive-layer-spec.py                 # 全部项目，只打印
  python scripts/derive-layer-spec.py sitian          # 单个
  python scripts/derive-layer-spec.py --write         # 落 <id>.draft.json（草案目录）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import importlib.util
_spec = importlib.util.spec_from_file_location(
    "layer_profile", os.path.join(ROOT, "scripts", "layer-profile.py"))
LP = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(LP)

DRAFT_DIR = os.path.join(ROOT, "task-data", "layer-specs", "_drafts")

# 宪法文件优先级（与 repoDocs.ts 的 CONSTITUTION_NAMES 同一口径）
CONSTITUTIONS = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md"]

FENCE = re.compile(r"```[^\n]*\n(.*?)```", re.S)
HEADING = re.compile(r"^(#{2,3})\s+(.+?)\s*$", re.M)
# 「架构 / 目录 / 结构 / architecture」这些标题下面才算分层描述
LAYER_HEAD = re.compile(r"(架构|目录|结构|分层|模块|architecture|structure|layout|tree)", re.I)
BACKTICK = re.compile(r"`([^`\n]{2,100})`")

# 目录名断言：至少含 `/`，或者是已知代码扩展名结尾
CODE_EXT = (".js", ".ts", ".tsx", ".jsx", ".vue", ".py", ".go", ".rs", ".java", ".css", ".html")

# 顶层里这些不当"层"（工具/测试/素材），与 layerScan.ts 的 roleOf 同一口径
NON_PRODUCT_TOP = {"scripts", "tests", "test", "docs", "data", "backup", "backups",
                   "tools", "build", "dist", "node_modules", "sample", "refs", "prototype"}


def read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def layer_sections(md):
    """抽出「架构/目录」那几节的正文。没有就返回空 —— 不猜。"""
    out = []
    ms = list(HEADING.finditer(md))
    for i, m in enumerate(ms):
        if not LAYER_HEAD.search(m.group(2)):
            continue
        start = m.end()
        end = ms[i + 1].start() if i + 1 < len(ms) else len(md)
        body = md[start:end]
        if body.strip():
            out.append({"title": m.group(2).strip(), "body": body})
    return out


def paths_in(text):
    """从一段文字里抽「像路径」的 token。返回原文 token（未验证存在性）。"""
    cands = []
    for m in BACKTICK.finditer(text):
        cands.append(m.group(1).strip())
    # 代码块里的裸路径（目录树常见：`/js/main.js  → 说明` 或 `js/main.js`）
    for m in re.finditer(r"(?m)^[\s|│├└─+/]*([A-Za-z0-9_\-./]+/[A-Za-z0-9_\-./]*)", text):
        cands.append(m.group(1).strip())
    return cands


def normalize(cand):
    """规整成仓库相对路径；不像路径的返回空串。"""
    c = cand.strip().rstrip(".,;:）)】]")
    if not c or len(c) > 100:
        return ""
    if c.startswith(("http://", "https://")):
        return ""
    c = re.sub(r"<[^>]*>", "", c).strip()
    c = c.lstrip("/")
    c = c.replace("\\", "/")
    if not c:
        return ""
    # ⚠ 绝对路径（`E:/CODE/...`）不是仓库相对路径 —— 早先版本把它当成一层叫 `E:/`，
    # 那层在报告里会显示成"一个叫 E 的目录"，是纯噪音。
    if re.match(r"^[A-Za-z]:/", c):
        return ""
    if c.startswith("~"):
        return ""
    if " " in c:
        return ""
    has_slash = "/" in c
    has_ext = c.lower().endswith(CODE_EXT)
    if not (has_slash or has_ext):
        return ""
    if "{" in c or "}" in c or "*" in c:
        return ""
    return c


def derive(project, repo):
    """产出一份草案 + 说明「哪些推不出来」。"""
    out = {
        "id": project["id"],
        "name": project.get("name") or project["id"],
        "repo": repo,
        "ok": False,
        "sourceFile": "",
        "sourceSection": "",
        "layers": {},
        "unmatched": [],
        "notes": [],
        "why": "",
    }
    if not repo or not os.path.isdir(repo):
        out["why"] = "仓库不存在，无从推导"
        return out

    src = None
    for name in CONSTITUTIONS:
        p = os.path.join(repo, name)
        if os.path.isfile(p):
            src = (name, p)
            break
    if not src:
        out["why"] = f"仓库里没有 {' / '.join(CONSTITUTIONS)} 里的任何一份 —— 没有可读的分层描述"
        return out
    out["sourceFile"] = src[0]

    md = read(src[1])
    secs = layer_sections(md)
    if not secs:
        out["why"] = (f"{src[0]} 里没有「架构 / 目录 / 结构」这类小节 —— "
                      f"它讲的是别的事（数据流、命令、规矩），推不出分层")
        return out

    # 逐节抽路径，验证存在
    found = {}   # rel -> 出现的节标题
    for s in secs:
        for raw in paths_in(s["body"]):
            rel = normalize(raw)
            if not rel:
                continue
            full = os.path.join(repo, rel.replace("/", os.sep))
            if os.path.exists(full):
                found.setdefault(rel, set()).add(s["title"])
            else:
                if len(out["unmatched"]) < 40:
                    out["unmatched"].append({"path": rel, "section": s["title"],
                                             "why": "文档里提到，仓库里不存在（文档过期或路径写法不同）"})
    if not found:
        out["why"] = (f"{src[0]} 有「{secs[0]['title']}」小节，但里面提到的路径"
                      f"**一条都没在仓库里对上** —— 推不出可信的分层")
        return out

    # 按一级目录聚成层：同一一级目录下的文件归一层（这是**文档说的**那个目录）
    # ⚠ 根目录下散着的文件（`songs/...` 之外的 `render_song.py`）不算一层：
    #   "(根)" 进了次数统计会把"平铺的单文件项目"伪装成两层架构。
    by_top = {}
    for rel in found:
        if "/" not in rel:
            continue          # 根下文件：不是一层，跳过（但保留在 evidence 里）
        top = rel.split("/")[0]
        by_top.setdefault(top, []).append(rel)

    product = {k: v for k, v in by_top.items() if k.lower() not in NON_PRODUCT_TOP}
    trouble = {k: v for k, v in by_top.items() if k.lower() in NON_PRODUCT_TOP}

    for top in sorted(product, key=lambda k: -len(product[k])):
        files = sorted(product[top])
        # 层名：文档里这一节的标题 + 目录名（人能一眼认出来源）
        sec_titles = sorted({t for f in files for t in found[f]})
        label = f"{top}/（{sec_titles[0]}）" if sec_titles else f"{top}/"
        out["layers"][label] = {
            "paths": [top + "/"],
            "note": f"从 {src[0]}「{sec_titles[0] if sec_titles else ''}」推出；"
                    f"文档里点到 {len(files)} 个具体文件，例如 " +
                    "、".join(f"`{x}`" for x in files[:3]),
        }
        out.setdefault("_evidence", {})[top] = files[:12]

    out["ok"] = len(out["layers"]) >= 2
    if not out["ok"]:
        out["why"] = (f"只推出 {len(out['layers'])} 层（至少要 2 层才算「分层」）—— "
                      f"文档里点到的东西集中在 {', '.join(out['layers']) or '无'}")
    out["sourceSection"] = "、".join(s["title"] for s in secs)
    out["notes"].append(f"取舍：按**一级目录**聚层（文档写的是目录树，不是抽象层名）")
    if trouble:
        out["notes"].append(
            "没算进产品层（工具/测试/数据，与界面口径一致）：" + "、".join(sorted(trouble)))
    return out


def main():
    ap = argparse.ArgumentParser(description="从项目文档推导分层 spec 草案（只读 + 草案）")
    ap.add_argument("project", nargs="?")
    ap.add_argument("--write", action="store_true", help="落 <id>.draft.json 到 _drafts/")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    projs = LP.parse_registry(LP._read(LP.REGISTRY))
    if args.project:
        projs = [p for p in projs if p["id"] == args.project or p.get("name") == args.project]

    results = [derive(p, LP.norm_repo(p.get("repo") or "")) for p in projs]

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    ok = [r for r in results if r["ok"]]
    bad = [r for r in results if not r["ok"]]
    print(f"# 分层 spec 草案推导 · {len(results)} 个项目")
    print()
    print(f"**能机械推导出分层的：{len(ok)} 个**（零模型调用）")
    print(f"**推导不出来的：{len(bad)} 个**（各有原因，下面逐条）")
    print()
    for r in ok:
        print(f"## ✅ {r['name']}（{r['id']}）")
        print(f"- 来源：`{r['sourceFile']}` · 小节「{r['sourceSection']}」")
        print(f"- 推出 {len(r['layers'])} 层：")
        for name in r["layers"]:
            print(f"    - {name}")
        for n in r["notes"]:
            print(f"- {n}")
        print()

    if bad:
        print("## ❌ 推导不出来（不是失败，是**这些项目自己没写结构化的分层**）")
        print()
        for r in bad:
            print(f"- **{r['name']}**（{r['id']}）：{r['why']}")
        print()

    if args.write:
        os.makedirs(DRAFT_DIR, exist_ok=True)
        n = 0
        for r in ok:
            payload = {
                "_comment": "**草案** —— 由 scripts/derive-layer-spec.py 从项目文档机械推导，未经验证。"
                            "要用请把内容抄进 ../<id>.json 并删掉本注释（正式 spec 才算口径）。",
                "_evidence": r.get("_evidence", {}),
                "source": f"{r['sourceFile']}「{r['sourceSection']}」（自动推导，待核对）",
                "layers": r["layers"],
            }
            p = os.path.join(DRAFT_DIR, r["id"] + ".draft.json")
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
                f.write("\n")
            n += 1
        print(f"已写 {n} 份草案 → {os.path.relpath(DRAFT_DIR, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
