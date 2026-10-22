"""给老冒烟脚本用的 tegula 模块代理。

为什么需要它（2026-10-22 修认领时发现）：
这些脚本原本用 importlib 加载仓库根的 `tegula.py`，而那是个 19 行 wrapper
（只 `from tegula.cli import main`）—— 所以 `teg.TASK_DIR` / `teg.QServer` /
`teg._STATUS_CACHE` 一个都不存在，两个脚本**长期是坏的**（一跑就 AttributeError），
只是没人跑过。

而且**不能靠给 tegula.py 补 re-export 来修**：`tegula.TASK_DIR = x` 只会改那个命名
空间里的一份副本，core / cli 里的函数读的仍是各自的全局 —— 脚本会"不报错了，但
跑在真实数据目录上"，比直接报错危险得多（会往真 task-data 里写测试卡）。

所以用代理：**读**从任一模块取，**写**同时写到所有模块。
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tegula import core as _core  # noqa: E402
from tegula import cli as _cli  # noqa: E402
from tegula import web as _web  # noqa: E402

_MODULES = (_core, _cli, _web)


class _TegulaProxy:
    """`teg.FOO` 读最先定义它的那个模块；`teg.FOO = x` 写到所有定义了它的模块。"""

    def __getattr__(self, key):
        for mod in _MODULES:
            if hasattr(mod, key):
                return getattr(mod, key)
        raise AttributeError(
            "tegula 代理找不到 %r —— core / cli / web 三个模块都没有这个属性" % key
        )

    def __setattr__(self, key, value):
        hit = False
        for mod in _MODULES:
            # 只改"本来就有"的模块：新属性一律不撒（否则会在三个模块里各造一份幽灵变量，
            # 谁读谁拿到不同的值 —— 比 AttributeError 更难查）
            if hasattr(mod, key):
                setattr(mod, key, value)
                hit = True
        if not hit:
            raise AttributeError(
                "tegula 代理拒绝新建属性 %r —— core / cli / web 都没有它，"
                "多半是脚本里写错了名字" % key
            )


teg = _TegulaProxy()
