#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分层 spec · 派工包（2026-11-16 · REV-013 ⑤）

暮雨 2026-11-16：
> 「spec 走 agent 派工，这现在已经是唯一手段了。」

所以这个脚本**不调模型**，它只做方寸该做的那件事（REV-009 原话）：
**出上下文包与约束**。然后把包拼成一份可直接粘给任意 agent 的派工文本。

── 为什么不能只给 agent「你去读这个项目」 ──────────────────────────────
那样每个 agent 都要自己扫盘子、自己判断哪个目录算一层、自己踩那五个假数坑
（浏览器 profile / 打包产物 / 内嵌运行时 / `.ts` 视频分片 / GBK 脚本）。
方寸已经把这些算清楚了 —— 把**事实**给它，让它只做**判断**。

── 包里必须有什么（少一样，agent 就会开始猜）──────────────────────────
  ① 已算好的目录层（行数/文件数/角色）—— 不是让它自己去 find
  ② 项目自己的骨架原文（AGENTS.md 等）—— 它的"声称"在这里
  ③ 现有的 spec（有就带上，让它改而不是重写）
  ④ 已有的手算数字（有就带上，让它对账）
  ⑤ 明确的产出格式 + 几条硬约束（不许编路径 / 推不出就说推不出）

用法：
  python scripts/layer-spec-dispatch.py sitian
  python scripts/layer-spec-dispatch.py sitian --out docs/派工-spec-司天.md
  python scripts/layer-spec-dispatch.py --all                 # 全部推出的（一次一份文件）
"""
from __future__ import annotations

import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import importlib.util

def _load(name, path):
    sp = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(m)
    return m

LP = _load("layer_profile", os.path.join(ROOT, "scripts", "layer-profile.py"))
DV = _load("derive_spec", os.path.join(ROOT, "scripts", "derive-layer-spec.py"))

# 骨架原文最多带多少字（够 agent 看清"项目怎么说自己"，又不至于把整本规矩塞进去）
SKELETON_CHARS = 6000
# 目录层最多列多少行
MAX_LAYERS = 40


def read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def skeleton_brief(repo, limit=SKELETON_CHARS):
    """项目自己的"声称"：AGENTS.md 这类宪法原文（截断但明说截断）。"""
    out = []
    for name in ("AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md"):
        p = os.path.join(repo, name)
        if not os.path.exists(p):
            continue
        t = read(p)
        cut = t[:limit]
        out.append("### `{}`（{} 字{}）".format(
            name, len(t), "，下面只带前 {} 字".format(limit) if len(t) > limit else "，全文"))
        out.append("")
        out.append("```markdown")
        out.append(cut.rstrip())
        out.append("```")
        out.append("")
        break  # 一份宪法就够，别把 README 也塞进来（README 只是说明书）
    return "\n".join(out)


def layers_table(rows):
    out = ["| 层（左列可直接当候选） | 角色 | 文件数 | 行数 |", "|---|---|---:|---:|"]
    for r in rows[:MAX_LAYERS]:
        out.append("| `{}` | {} | {} | {:,} |".format(r["layer"], r["role"], r["files"], r["lines"]))
    if len(rows) > MAX_LAYERS:
        out.append("| …另有 {} 层 | | | |".format(len(rows) - MAX_LAYERS))
    return "\n".join(out)


def existing_spec(pid):
    p = os.path.join(LP.SPEC_DIR, pid + ".json")
    if not os.path.exists(p):
        return ""
    try:
        return read(p).strip()
    except OSError:
        return ""


def derived_hint(project, repo):
    """脚本已经推出来的那部分（如果推得出来）—— 给 agent 当起点，别让它从零开始。"""
    try:
        d = DV.derive(project, repo)
    except Exception as e:
        return "（推导器出错：{}）".format(e)
    if not d.get("ok"):
        return "（自动推导**没推出来**：{} —— 所以更需要你判断）".format(d.get("why") or "未知")
    lines = ["自动推导**推出 {} 层**（仅供你参考，可能有错）：".format(len(d["layers"])), ""]
    for name, item in d["layers"].items():
        lines.append("- `{}` —— {}".format(name, item.get("note", "")))
    return "\n".join(lines)


def build(project_id):
    proj = LP.find_project(project_id)
    if not proj:
        return None, "registry 里没有项目「{}」".format(project_id)
    repo = LP.norm_repo(proj.get("repo") or "")
    if not repo or not os.path.isdir(repo):
        return None, "仓库不存在：{} —— 没有可扫描的东西，派工也没用".format(repo or "(未登记)")

    recs, unreadable, nonText, skipped = LP.scan_files(repo)
    rows = LP.group_layers(recs, 3)
    total = sum(r["lines"] for r in rows)
    prod = sum(r["lines"] for r in rows if r["role"] == "产品")

    name = proj.get("name") or project_id
    L = []

    L.append("# 派工单：给「{}」写分层 spec".format(name))
    L.append("")
    L.append("- 卡类型：数据整理（产出一份 JSON 文件，不改任何代码）")
    L.append("- 项目：{}（`{}`）".format(name, project_id))
    L.append("- 仓库根：`{}`".format(repo))
    L.append("- 产物落点：`task-data/layer-specs/{}.json`（**方寸数据目录**，不是项目仓库）".format(project_id))
    L.append("")

    L.append("## 1 任务目标")
    L.append("")
    L.append("把「{}」**自己声称的分层**写成一份 spec JSON，供方寸回答一个问题：".format(name))
    L.append("")
    L.append("> 这个项目号称是 A，但 88% 的行数在 B。")
    L.append("")
    L.append("⚠ 这句话**只能靠你判断**，因为「哪几层是一伙的」是项目的自我认知，不是目录结构。")
    L.append("方寸已经把**事实**算好了（下面第 3 节），你只需要做**归类与命名**。")
    L.append("")

    L.append("## 2 工作目录 / 范围")
    L.append("")
    L.append("- 只读项目仓库（**一个字都不许写进去**）：`{}`".format(repo))
    L.append("- 唯一允许写入的地方：方寸数据根的 `task-data/layer-specs/{}.json`".format(project_id))
    L.append("- **不许改代码、不许改文档、不许 git 操作**")
    L.append("")

    L.append("## 3 已经算好的事实（别自己重新数）")
    L.append("")
    L.append("方寸扫盘结果：**产品 {:,} 行**（全仓合计 {:,} 行，含测试与脚本）。".format(prod, total))
    L.append("")
    L.append("> 口径：只数能解码成文本的文件（二进制不算）；排除依赖 / 构建产物 / 打包目录 /")
    L.append("> 内嵌运行时 / 隐藏目录。`.ts` 可能是 MPEG 视频分片，GBK 脚本是文本不是二进制 ——")
    L.append("> 这两条方寸已经处理过，**你不用再踩**。")
    L.append("")
    L.append(layers_table(rows))
    L.append("")

    if skipped or nonText:
        L.append("### 被规则挡在分母外面的（方寸已排除，列出来让你知道）")
        L.append("")
        for s in skipped[:16]:
            L.append("- `{}` —— {}".format(s["dir"], s["why"]))
        for n in nonText[:6]:
            L.append("- `{}` —— {}".format(n["file"], n["why"]))
        L.append("")

    L.append("## 4 项目自己怎么说自己（骨架原文）")
    L.append("")
    sk = skeleton_brief(repo)
    L.append(sk if sk else "_这个仓库没有 AGENTS.md / README.md —— 它的自我描述缺失。_")
    L.append("")
    L.append("> ⚠ 上表只是**一级目录**。项目的「分层」往往不等同于目录："
             "像司天那样「生成器 vs 编辑器」是**两套读法**，两者共用同一个 `utils/`。"
             "所以你要做的是：把上面的目录**归成几块**，每块回答'这是什么'。")
    L.append("")

    L.append("## 5 方寸已经推出来的（供你参考，可能错）")
    L.append("")
    L.append(derived_hint(proj, repo))
    L.append("")

    spec = existing_spec(project_id)
    if spec:
        L.append("## 6 现有 spec（**请在这份上改**，不要重写）")
        L.append("")
        L.append("```json")
        L.append(spec)
        L.append("```")
    else:
        # ⚠ 标题本身也得跟着变。2026-11-16 实测踩到：早期版本无条件写
        # 「请在这份上改」，而包里根本没有那份 spec —— 标题和正文自相矛盾，
        # agent 会去找一份不存在的东西。
        L.append("## 6 现有 spec（**这个项目还没有 spec** —— 你要新建一份）")
        L.append("")
        L.append("_没有现成 spec。直接按第 7 节的格式产出一份新的。_")
    L.append("")

    L.append("## 7 产出格式（照抄这个形状）")
    L.append("")
    L.append("```json")
    L.append(json.dumps({
        "_comment": "写清这份 spec 的来路：谁写的、依据哪份文档",
        "source": "依据哪份文档 / 谁的口径（例：AGENTS.md 第 3 节 + 项目负责人确认）",
        "layers": {
            "层名（人话，别用目录名当层名）": {
                "paths": ["相对仓库的路径前缀", "支持 * 通配，如 src/utils/terrain*"],
                "note": "这层是干什么的（一句话）",
            },
        },
        "groups": {
            "大块名（例：生成器 / 编辑器）": ["上面某一层", "上面另一层"],
        },
        "claims": {
            "层名": 0,
        },
        "claimsNote": "claims 是**项目负责人手算过的数字**。没有就整段删掉，别编。",
    }, ensure_ascii=False, indent=2))
    L.append("```")
    L.append("")
    L.append("字段说明：")
    L.append("")
    L.append("- `layers`：**至少 2 层**，否则不叫分层。层名用人话（「生成器」「账本引擎」），不要用目录名。")
    L.append("- `groups`：可选。当项目有「两套读法」（如司天的生成器 / 编辑器）时用它把层归成大块 ——")
    L.append("  这是回答「号称是 A 但 88% 在 B」的关键。没有就别写。")
    L.append("- `claims`：可选。**只有当项目负责人手算过数字时才填**，用于让方寸当场对账。没手算就删掉。")
    L.append("- `paths`：写相对仓库的路径。目录写 `src/foo/`，文件写 `src/foo.js`，通配写 `src/terrain*`。")
    L.append("")

    L.append("## 8 硬约束（越界即打回）")
    L.append("")
    L.append("1. **不许编路径**。`paths` 里每一条都必须**真的匹配到文件**。写完自己验：")
    L.append("   逐条 `paths` 去仓库里找，找不到就删掉那条，不要留着。")
    L.append("2. **推不出来就说推不出来**。如果这个项目根本就没有可辨识的分层")
    L.append("   （比如它是一堆平铺的脚本），**直接回报「推不出来 + 为什么」**，不要硬凑两层。")
    L.append("   硬凑出来的 spec 比没有更糟 —— 方寸会拿它去算一个假结论。")
    L.append("3. **层名必须是人话**。`src/` 不是层名；「渲染层」「数据层」「生成器」才是。")
    L.append("4. **不许声称你理解了这个项目**。你是在做一次**目录归类**，不是代码审查。")
    L.append("   报告里写清「依据是哪个文档的哪一节」。")
    L.append("5. **结论区分「实测」与「推测」**：路径存在性是实测；「这三层是一伙的」是判断。")
    L.append("   判断要写理由。")
    L.append("")

    L.append("## 9 交付")
    L.append("")
    L.append("1. 把 JSON 写进 `task-data/layer-specs/{}.json`".format(project_id))
    L.append("2. 回报一段话，说清四件事：")
    L.append("   - 分了哪几层，每层一句话")
    L.append("   - 依据是哪个文档的哪一节（**必须能指回原文**）")
    L.append("   - 哪些路径你验过存在（实测）、哪些是推测")
    L.append("   - 有没有「两套读法」这种需要 `groups` 的情况；没有就明说没有")
    L.append("3. **不要打包、不要提交 git、不要改任何项目文件**")

    return "\n".join(L), ""


def main():
    ap = argparse.ArgumentParser(description="分层 spec 派工包（纯文本，零模型调用）")
    ap.add_argument("project", nargs="?")
    ap.add_argument("--all", action="store_true", help="给所有项目各出一份")
    ap.add_argument("--out", help="写到这个文件（单项目时）")
    ap.add_argument("--outdir", help="多份时的输出目录")
    args = ap.parse_args()

    ids = [args.project] if args.project else [
        p["id"] for p in LP.parse_registry(LP._read(LP.REGISTRY))] if args.all else []
    if not ids:
        print("用法：python scripts/layer-spec-dispatch.py <项目id>  或  --all")
        return 2

    if len(ids) == 1 and args.out:
        text, err = build(ids[0])
        if err:
            print("✗ " + err)
            return 1
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        print("已写 {} 字节 → {}".format(len((text + "\n").encode("utf-8")), args.out))
        return 0

    if args.all:
        outdir = args.outdir or os.path.join(ROOT, "docs", "派工-spec")
        os.makedirs(outdir, exist_ok=True)
        n = 0
        for pid in ids:
            text, err = build(pid)
            if err:
                print("- {} 跳过：{}".format(pid, err))
                continue
            p = os.path.join(outdir, "{}.md".format(pid))
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write(text + "\n")
            n += 1
        print("已写 {} 份 → {}".format(n, outdir))
        return 0

    text, err = build(ids[0])
    if err:
        print("✗ " + err)
        return 1
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
