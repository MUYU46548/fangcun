#!/usr/bin/env python3
# 方寸 (tegula) — 本地优先多 agent 任务地图
# 零依赖：仅用 Python 标准库。视图服务用 http.server + 轮询 + 编辑 API。
#
# 模块拆分：core（数据层+API） ← web（HTTP+Handler+托盘） ← cli（命令行入口）
import sys, os

# 确保 tegula 包可导入（兼容直接运行 tegula.py 和 PyInstaller 打包）
if getattr(sys, "frozen", False):
    _pkg_dir = os.path.dirname(sys.executable)
else:
    _pkg_dir = os.path.dirname(os.path.abspath(__file__))
if _pkg_dir not in sys.path:
    sys.path.insert(0, _pkg_dir)

from tegula.cli import main

if __name__ == "__main__":
    main()
