#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自检报告入口（P7 判据的执行体）—— 只做调度，不执行判据。

判据执行只有一套：主进程 TS 的 `main/checks/runner.ts`（由 `selfcheck-cli.js` 调起）。
Python 侧 `tegula/checks.py` 仍然**只解析、不执行**；这里也不另写第二套检查，
只负责：
  1. 找到仓库根与 node；
  2. 调 `node desktop/dist/main/checks/selfcheck-cli.js --repo … --out docs/自检报告-<日期>.md`；
  3. 确认报告真的落盘；失败如实报错，不伪造退出码。

用法：python scripts/selfcheck-plan.py [--days 30] [--out <路径>]
退出码：0 = 报告已生成（**不代表所有判据都过**，逐格结论见报告）；2 = 环境不齐；1 = 自检失败。
"""
import os
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "desktop" / "dist" / "main" / "checks" / "selfcheck-cli.js"


def _arg(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    for a in argv:
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return default


def main(argv):
    if not CLI.exists():
        print(f"找不到自检执行器：{CLI}", file=sys.stderr)
        print("先把主进程构建出来：cd desktop && npm run build", file=sys.stderr)
        return 2
    node = os.environ.get("NODE_BIN") or shutil.which("node") or "node"
    days = str(_arg(argv, "--days", "30"))
    out = Path(_arg(argv, "--out", str(ROOT / "docs" / f"自检报告-{date.today().isoformat()}.md"))).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [node, str(CLI), "--repo", str(ROOT), "--data-dir", str(ROOT),
           "--days", days, "--out", str(out)]
    try:
        p = subprocess.run(cmd, cwd=str(ROOT))
    except OSError as e:
        print(f"启动 node 失败：{e}", file=sys.stderr)
        return 2
    if p.returncode != 0:
        print(f"自检执行器退出码 {p.returncode}（报告可能没写成）", file=sys.stderr)
        return 1
    if not out.exists():
        print(f"执行器退出 0 但报告不在：{out}", file=sys.stderr)
        return 1
    print(f"自检报告已生成：{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
