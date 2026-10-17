#!/usr/bin/env python3
# check-recurring.py — 周期任务（cron-check）验证（2026-10-17，补 9-07 调研 Donetick 借鉴欠账）
# 用法：python scripts/test/check-recurring.py
# 不碰真实 task-data：TASK_DIR 指向临时目录；零网络。
# 覆盖：表达式归一 / 触发点推算（含周日映射·OR 语义·永假报错）/ 族扫描与生成 /
#       幂等（重复调用不重复生成）/ 回收站不复活 / recurring_id 落盘往返保真 /
#       api_new 透传 / cli cmd_cron_check 不再 NameError（2026-10-17 实锤的炸点）。
import os
import sys
import tempfile
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import tegula.core as core  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))


# ---- 测试环境：临时数据目录 ----
tmpdir = tempfile.mkdtemp(prefix="recurring_check_")
_saved = {k: getattr(core, k, None) for k in ("TASK_DIR", "REGISTRY_PATH")}
core.TASK_DIR = os.path.join(tmpdir, "task-data")
core.REGISTRY_PATH = os.path.join(tmpdir, "registry.yaml")
os.makedirs(os.path.join(core.TASK_DIR, "archive"), exist_ok=True)
os.makedirs(os.path.join(core.TASK_DIR, ".trash"), exist_ok=True)
with open(core.REGISTRY_PATH, "w", encoding="utf-8") as f:
    f.write("members:\n  - 暮雨\n  - hermes\nprojects:\n  - id: proj-x\n    name: 测试项目\n")

NOW = datetime.datetime.now()
YDAY = NOW - datetime.timedelta(days=1)


def ts(dt):
    return str(int(dt.timestamp()))


def make_card(tid, **kw):
    d = {
        "id": tid, "标题": kw.get("标题", tid), "项目": ["proj-x"], "状态": kw.get("状态", "待办"),
        "创建": kw.get("创建", ts(YDAY)), "更新": kw.get("更新", ts(YDAY)),
        "来源": kw.get("来源", "human"), "指派": "hermes", "验收": "human",
        "cron": kw.get("cron", ""), "recurring_id": kw.get("recurring_id", ""),
    }
    sub = kw.get("目录", "active")
    base = core.TASK_DIR if sub == "active" else os.path.join(core.TASK_DIR, sub)
    core.write_task_file(os.path.join(base, tid + ".md"), d)
    return d


# ═══ 1. 表达式归一 cron_normalize ═══
check("归一 @daily", core.cron_normalize("@daily") == "0 0 * * *")
check("归一 @weekly", core.cron_normalize("@weekly") == "0 0 * * 1")
check("归一 每天", core.cron_normalize("每天") == "0 0 * * *")
check("归一 每周三", core.cron_normalize("每周三") == "0 0 * * 3")
check("归一 每月15号", core.cron_normalize("每月15号") == "0 0 15 * *")
check("归一 5段式原样", core.cron_normalize("30 8 1 * *") == "30 8 1 * *")
check("归一 大小写 @Daily", core.cron_normalize("@Daily") == "0 0 * * *")
check("归一 垃圾返回 None", core.cron_normalize("随便写的") is None)
check("归一 空 None", core.cron_normalize("") is None)
check("归一 每月32日 None", core.cron_normalize("每月32日") is None)

# ═══ 2. 触发点推算 cron_next_after ═══
base_dt = datetime.datetime(2026, 10, 17, 8, 0)          # 周六
nxt = core.cron_next_after("@daily", base_dt)
check("daily 次日 0 点", nxt == datetime.datetime(2026, 10, 18, 0, 0), f"got {nxt}")
nxt = core.cron_next_after("0 8 * * *", base_dt)          # 每天 08:00，08:00 整已过 → 明天
check("严格 > after（同时刻不算）", nxt == datetime.datetime(2026, 10, 18, 8, 0), f"got {nxt}")
nxt = core.cron_next_after("0 8 * * *", datetime.datetime(2026, 10, 17, 7, 59))
check("同日未来时刻命中", nxt == datetime.datetime(2026, 10, 17, 8, 0), f"got {nxt}")
nxt = core.cron_next_after("每周一", base_dt)              # 10-17 是周六 → 下周一 10-19
check("每周一 推到周一", nxt == datetime.datetime(2026, 10, 19, 0, 0), f"got {nxt}")
nxt = core.cron_next_after("每周日", base_dt)              # 周日 cron 0 → python weekday 6
check("周日映射（cron0→py6）", nxt == datetime.datetime(2026, 10, 18, 0, 0), f"got {nxt}")
nxt = core.cron_next_after("0 0 13 * 1", base_dt)         # 13号或周一（OR）
check("日/周 OR 语义", nxt == datetime.datetime(2026, 10, 19, 0, 0), f"got {nxt}")  # 下一个周一
nxt = core.cron_next_after("*/15 * * * *", datetime.datetime(2026, 10, 17, 8, 1))
check("分钟步进 */15", nxt == datetime.datetime(2026, 10, 17, 8, 15), f"got {nxt}")
try:
    core.cron_next_after("0 0 30 2 *", base_dt)           # 2 月 30 日=永假
    check("永假表达式报 ValueError", False)
except ValueError:
    check("永假表达式报 ValueError", True)
try:
    core.cron_next_after("看不懂", base_dt)
    check("垃圾表达式报 ValueError", False)
except ValueError:
    check("垃圾表达式报 ValueError", True)

# ═══ 3. 族扫描与生成 check_recurring_tasks ═══
spawned = core.check_recurring_tasks()                    # 空库先跑一遍
check("空库返回空列表", spawned == [])

make_card("task-20261017-901", cron="@daily", 标题="每日站会")          # 昨天创建 → 到期
make_card("task-20261017-902", cron="每周三", 标题="周报", 创建=ts(NOW - datetime.timedelta(days=8)))
make_card("task-20261017-903", cron="随便写的", 标题="坏表达式卡")       # 非法表达式 → 跳过
make_card("task-20261017-904", 标题="非周期卡", cron="")                # 无 cron → 不触发
make_card("task-20261017-905", cron="@daily", 标题="回收站的周期卡", 目录=".trash")
make_card("task-20261017-906", cron="@daily", 标题="归档的周期卡", 目录="archive",
          状态="完成", 创建=ts(NOW - datetime.timedelta(days=2)))

spawned = core.check_recurring_tasks()
# 901（昨天 @daily）✓ 902（8 天前每周三，上周三已过）✓ 906（2 天前 @daily）✓
# 903 坏表达式跳过 / 904 无 cron / 905 在回收站不扫
check("到期生成 3 个实例（901/902/906）", len(spawned) == 3, f"got {spawned}")

# 生成的实例内容核验
new_tasks = {t["id"]: t for t in core.load_tasks()}
inst_901 = [t for t in new_tasks.values() if t.get("附言", "").find("task-20261017-901") >= 0]
check("901 实例生成", len(inst_901) == 1, f"got {[t['id'] for t in inst_901]}")
if inst_901:
    t = inst_901[0]
    check("实例状态=待办", t.get("状态") == "待办", f"got {t.get('状态')}")
    check("实例 recurring_id=母卡id", t.get("recurring_id") == "task-20261017-901",
          f"got {t.get('recurring_id')}")
    check("实例来源=recurring", t.get("来源") == "recurring", f"got {t.get('来源')}")
    check("实例截止=触发日", t.get("截止") == NOW.strftime("%Y-%m-%d"), f"got {t.get('截止')}")
    check("实例 cron 继承", t.get("cron") == "@daily", f"got {t.get('cron')}")
    check("实例标题继承", t.get("标题") == "每日站会", f"got {t.get('标题')}")
    # 往返保真：落盘文件里 recurring_id 行真实存在（render_task 显式输出验证）
    raw = open(t["_file"] if os.path.isabs(t.get("_file", "")) else
               os.path.join(core.TASK_DIR, t.get("_file", t["id"] + ".md")), encoding="utf-8").read()
    check("落盘含 recurring_id 行", "recurring_id: task-20261017-901" in raw)
    check("落盘含 cron 行", "cron: @daily" in raw)

# ═══ 4. 幂等：重复调用不重复生成 ═══
spawned2 = core.check_recurring_tasks()
check("二次调用不重复生成", spawned2 == [], f"got {spawned2}")
all_tasks = core.load_tasks() + core.load_tasks(view="archive")
cnt_901 = sum(1 for t in all_tasks if t.get("recurring_id") == "task-20261017-901")
check("901 族恰好 1 个新实例", cnt_901 == 1, f"got {cnt_901}")

# ═══ 5. 族链：实例的实例（最新实例作锚点）═══
# 把 901 实例的创建时间改到 3 天前，再跑 → 应基于它再生成下一期
if inst_901:
    t = inst_901[0]
    path = os.path.join(core.TASK_DIR, t["id"] + ".md")
    d2 = core.parse_task(path)
    d2["创建"] = ts(NOW - datetime.timedelta(days=3))
    core.write_task_file(path, d2)
    spawned3 = core.check_recurring_tasks()
    check("族链推进：基于最新实例再生成", len(spawned3) == 1, f"got {spawned3}")
    if spawned3:
        check("三代同族", core.parse_task(
            os.path.join(core.TASK_DIR, spawned3[0] + ".md")).get("recurring_id") == "task-20261017-901")

# ═══ 6. api_new 透传 recurring_id ═══
ok, tid = core.api_new({"标题": "手工周期母卡", "cron": "每天", "recurring_id": ""})
d3 = core.parse_task(os.path.join(core.TASK_DIR, tid + ".md"))
check("api_new 支持 cron 字段", d3.get("cron") == "每天", f"got {d3.get('cron')}")

# ═══ 7. CLI 命令不再 NameError（2026-10-17 实锤炸点）═══
import tegula.cli as cli  # noqa: E402
try:
    cli.cmd_cron_check(type("Args", (), {})())            # 原 NameError 在此复现
    check("cmd_cron_check 不再 NameError", True)
except NameError as e:
    check("cmd_cron_check 不再 NameError", False, str(e))

# ---- 收尾 ----
for k, v in _saved.items():
    if v is not None:
        setattr(core, k, v)

print(f"\n=== check-recurring: {len(PASS)} pass / {len(FAIL)} fail ===")
sys.exit(1 if FAIL else 0)
