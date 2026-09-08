#!/usr/bin/env python3
"""再生成 docs/ARCHITECTURE_MAP.md 的「结构清单」节（GEN 标记之间）。

分工纪律（同 SiTian 版）：
  - 快变量（文件清单、行数）= 本脚本负责
  - 慢变量（每文件一句话职责）= 人工维护，再生成自动保留
  - --check 自检模式：exit 1 = 清单已过期

fangcun 形态特化：没有 src 树，根目录少文件+大脚本，显式列举 + scripts/templates 扫描。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC = os.path.join(ROOT, "docs", "ARCHITECTURE_MAP.md")

# fangcun 形态：根目录关键文件显式列举，其余目录常规扫描
ROOT_FILES = ["AGENTS.md", "registry.yaml", "tegula.py", "verify.py",
              "tegula", "方寸看板.bat", "tegula-serve.bat"]
SCAN_DIRS = ["scripts", "templates"]
EXTS = (".py", ".js", ".html", ".bat", ".yaml")


def scan():
    rows = {}
    for f in ROOT_FILES:
        p = os.path.join(ROOT, f)
        if os.path.isfile(p):
            with open(p, encoding="utf-8", errors="replace") as fh:
                rows[f] = sum(1 for _ in fh)
    for d in SCAN_DIRS:
        base = os.path.join(ROOT, d)
        for dp, dn, fn in os.walk(base):
            dn[:] = [x for x in dn if x != "__pycache__"]
            for f in fn:
                if f.endswith(EXTS):
                    p = os.path.join(dp, f)
                    rel = os.path.relpath(p, ROOT).replace("\\", "/")
                    with open(p, encoding="utf-8", errors="replace") as fh:
                        rows[rel] = sum(1 for _ in fh)
    order = ROOT_FILES + []
    for d in SCAN_DIRS:
        order = order + [os.path.join(d, x).replace("\\", "/") for x in sorted(os.listdir(os.path.join(ROOT, d)))
                         if x.endswith(EXTS) and os.path.isfile(os.path.join(ROOT, d, x))]
    return {k: rows[k] for k in order if k in rows}


def parse_old(text):
    descs = {}
    m = re.search(r"<!-- GEN:START -->\n(.*?)<!-- GEN:END -->", text, re.S)
    if not m:
        return descs
    for line in m.group(1).splitlines():
        mm = re.match(r"\|\s*\d+\s*\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|?\s*$", line)
        if mm:
            descs[mm.group(1)] = mm.group(2)
    return descs


def build(rows, descs):
    out = ["| 行数 | 文件 | 职责 |", "|---:|---|---|"]
    for rel, n in rows.items():
        out.append("| {} | `{}` | {} |".format(n, rel, descs.get(rel, "（待补）")))
    return "\n".join(out)


def main():
    check = "--check" in sys.argv
    text = ""
    if os.path.exists(DOC):
        with open(DOC, encoding="utf-8") as fh:
            text = fh.read()
    descs = parse_old(text)
    rows = scan()
    new_block = build(rows, descs)
    if check:
        old_lines = set(text.splitlines())
        stale = [l for l in new_block.splitlines()
                 if l not in old_lines and not l.startswith(("| 行数", "---"))]
        if stale:
            print("check: {} 行需更新".format(len(stale)))
            for l in stale[:8]:
                print("  " + l)
            sys.exit(1)
        print("check: 一致（{} 文件，{} 条职责）".format(len(rows), len(descs)))
        return
    if "<!-- GEN:START -->" in text:
        new_text = re.sub(r"<!-- GEN:START -->\n.*?<!-- GEN:END -->",
                          "<!-- GEN:START -->\n" + new_block + "\n<!-- GEN:END -->", text, flags=re.S)
    else:
        new_text = text.rstrip("\n") + "\n\n<!-- GEN:START -->\n" + new_block + "\n<!-- GEN:END -->\n"
    with open(DOC, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(new_text)
    print("ok: {} 个文件已写入（保留职责 {} 条）".format(len(rows), len(descs)))


if __name__ == "__main__":
    main()
