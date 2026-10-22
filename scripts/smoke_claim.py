#!/usr/bin/env python3
"""认领（claim）+ 交回（by）冒烟 —— 2026-10-22 · 从 DSH 信箱模式学来的那一刀。

真跑 tegula.cli / tegula.core 里的函数（不是复述逻辑），数据目录指到临时目录。

要钉住的四件事（按重要性）：
  1. 两个 agent 拿到同一张卡，是这次要治的病 —— 认领之后第二个必须跳过它；
  2. 租约必须能让崩溃的 agent 松开锁（否则锁死比重复干更糟）；
  3. A 领的活不能被 B 交回（done --by 比对认领人）；
  4. 认领字段写回不丢（受管键漏输出 = Python 一写回就把认领抹掉，卡又变没人领）。

跑法：python scripts/smoke_claim.py
"""
import argparse
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="tegula_claim_")
TASKS = os.path.join(TMP, "task-data")
os.makedirs(TASKS, exist_ok=True)

from tegula import core as C  # noqa: E402
from tegula import cli as CLI  # noqa: E402

# 两个模块的 TASK_DIR 都要改：`from tegula.core import TASK_DIR` 是值绑定，
# 函数体里引用的是 cli 模块自己的全局名 —— 只改 core 那份等于没改。
C.TASK_DIR = TASKS
CLI.TASK_DIR = TASKS

PASS = 0
FAILS = []


def check(name, cond, detail=""):
    global PASS
    if cond:
        PASS += 1
        print("PASS  " + name)
    else:
        FAILS.append(name)
        print("FAIL  " + name + ("  [" + str(detail) + "]" if detail else ""))


def mkcard(tid, title, status="待办", claim=None, claim_at=None):
    lines = [
        "---",
        "id: " + tid,
        "标题: " + title,
        "项目: [demo]",
        "状态: " + status,
        "优先级: 中",
        "创建: 2026-10-22",
        "指派: hermes",
        "验收: human",
    ]
    if claim:
        lines.append("认领人: " + str(claim))
        lines.append("认领时间: " + str(claim_at))
    lines += ["---", "", "## 方案", "- [ ] 夹具", ""]
    p = os.path.join(TASKS, tid + ".md")
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return p


def ns(**kw):
    base = {"id": None, "project": None, "format": "text", "claim": "",
            "结果": "", "证据": "", "成本": "", "by": "", "force": False,
            "expected_mtime": None}
    base.update(kw)
    return argparse.Namespace(**base)


def run(fn, **kw):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(ns(**kw))
    return buf.getvalue()


print("---- 1. 没认领时：老用法零变化 ----")
mkcard("t-001", "第一张待办")
mkcard("t-002", "第二张待办")
out = run(CLI.cmd_next)
check("next 能取到活", "t-001" in out, out[:80])
check("明说还没人领（不静默）", "还没人领" in out, out[:200])
check("并提醒这次没占住它（否则 agent 会以为已经占住了）",
      "没加 --claim" in out, out[:200])
d1 = C.parse_task(os.path.join(TASKS, "t-001.md"))
check("不带 --claim 就一个字段都不写（只读不占）",
      not str(d1.get("认领人") or "").strip(), d1.get("认领人"))
with open(os.path.join(TASKS, "t-001.md"), encoding="utf-8") as f:
    raw = f.read()
check("盘上文件也没多出「认领人」这行", "认领人" not in raw)

print("")
print("---- 2. 认领：写入认领人 + 时间 ----")
out = run(CLI.cmd_next, claim="hermes")
check("hermes 认领到 t-001", "t-001" in out, out[:80])
check("输出里看出这张是自己的（你）", "你" in out, out[:300])
d1 = C.parse_task(os.path.join(TASKS, "t-001.md"))
check("认领人落到盘上", str(d1.get("认领人") or "").strip() == "hermes", d1.get("认领人"))
try:
    at = float(d1.get("认领时间") or 0)
except (TypeError, ValueError):
    at = 0
check("认领时间是秒级 unix 时间戳且是刚刚（不是 ISO 串、不是毫秒）",
      at > 0 and abs(time.time() - at) < 60, d1.get("认领时间"))

print("")
print("---- 3. 第二个 agent 不会拿到同一张 ----")
out = run(CLI.cmd_next, claim="dsh")
check("dsh 拿到的是下一张 t-002，不是 hermes 领着的 t-001",
      "t-002" in out and "t-001" not in out, out[:120])
d2 = C.parse_task(os.path.join(TASKS, "t-002.md"))
check("dsh 的认领写进了 t-002", str(d2.get("认领人") or "").strip() == "dsh", d2.get("认领人"))
d1 = C.parse_task(os.path.join(TASKS, "t-001.md"))
check("hermes 的认领没被覆盖（这是重复干的根因，现在被挡住了）",
      str(d1.get("认领人") or "").strip() == "hermes", d1.get("认领人"))

# 直接测纯函数 _pick_next：上面那条端到端断言其实是 claim_task 的二次检查兜住的
# （它自己会拒绝已被认领的卡），所以**没有单独咬住 pick 的过滤** —— 注入"不跳过"发现
# 端到端那条仍然绿。这里补一条直接测过滤的，才咬得住。
ids = [t.get("id") for t in CLI._pick_next(C.load_tasks(None, "active"))]
check("_pick_next 的候选里没有已被认领的卡（这条直接咬过滤，不靠 claim_task 兜）",
      "t-001" not in ids and "t-002" not in ids, ids)
check("_pick_next(include_claimed=True) 才把它们列出来（给排查用）",
      "t-001" in [t.get("id") for t in CLI._pick_next(C.load_tasks(None, "active"), include_claimed=True)],
      ids)

out = run(CLI.cmd_next, claim="cursor")
check("活都被别人领走时明说没领到活，不能说成没活",
      "没领到活" in out and "没有可执行任务" not in out, out[:150])
check("并且列出谁在领、还剩多久（否则 agent 不知道该等还是去抢）",
      "hermes" in out and "dsh" in out and "还剩" in out, out[:300])

print("")
print("---- 4. 租约：崩溃的 agent 会把锁松开 ----")
old = str(int(time.time() - CLI.CLAIM_TTL_SECONDS - 60))
mkcard("t-001", "第一张待办", claim="hermes", claim_at=old)
d1 = C.parse_task(os.path.join(TASKS, "t-001.md"))
check("超过租约判定为过期", CLI._claim_expired(d1) is True)

# 不带 --claim 时：应当能选中它，并明确告诉人"原由谁领、租约过期了"
out = run(CLI.cmd_next)
check("过期的卡不会被跳过（lock 必须能松开）", "t-001" in out, out[:120])
check("并且明说原认领人 + 租约已过期（这通常是那个 agent 崩了）",
      "租约已过期" in out and "hermes" in out, out[:250])

# 带 --claim 时：直接接手，认领人应当被改写（注意认领成功后它就不再"过期"了，
# 所以这里断言的是"接手成功"，不是"看到过期提示"）
mkcard("t-001", "第一张待办", claim="hermes", claim_at=old)
out = run(CLI.cmd_next, claim="dsh")
check("过期之后 dsh 能接手 t-001", "t-001" in out, out[:200])
d1 = C.parse_task(os.path.join(TASKS, "t-001.md"))
check("认领人被改成 dsh（过期 = 上一个 agent 崩了，锁必须能松开）",
      str(d1.get("认领人") or "").strip() == "dsh", d1.get("认领人"))

mkcard("t-001", "第一张待办", claim="hermes", claim_at="刚才吧")
d1 = C.parse_task(os.path.join(TASKS, "t-001.md"))
check("认领时间是乱写的字符串时当没认领（不锁死）", CLI._claim_expired(d1) is True)

print("")
print("---- 5. 原子性：一把锁，两个人不能同时占住 ----")
mkcard("t-001", "第一张待办")
check("拿锁成功", CLI._claim_lock() is True)
check("锁被占着时第二次拿失败（这就是检查加占用不可分的前提）",
      CLI._claim_lock(timeout=0.2) is False)
CLI._claim_unlock()
check("放手之后能再拿", CLI._claim_lock(timeout=0.5) is True)
CLI._claim_unlock()

with open(CLI._claim_lock_path(), "w") as f:
    f.write("99999")
ok, msg = CLI.claim_task("t-001", "hermes")
check("锁被别人占着时 claim_task 返回失败并说明原因",
      ok is False and "锁" in msg, msg)
try:
    os.remove(CLI._claim_lock_path())
except OSError:
    pass

print("")
print("---- 6. 同一个 agent 不会重复占（幂等语义） ----")
ok, msg = CLI.claim_task("t-001", "hermes")
check("hermes 认领成功", ok is True, msg)
ok2, msg2 = CLI.claim_task("t-001", "hermes")
check("同一个名字再领一次就拒绝（否则每次 next 都重写时间戳，租约永远不推进）",
      ok2 is False and "已被" in msg2, msg2)
ok3, msg3 = CLI.claim_task("t-001", "")
check("空名字拒绝并说清要填什么", ok3 is False and "谁" in msg3, msg3)
ok4, msg4 = CLI.claim_task("t-not-exist", "hermes")
check("不存在的卡拒绝", ok4 is False and "不存在" in msg4, msg4)

print("")
print("---- 7. 交回校验：A 领的活不能被 B 交回 ----")
errs, warns = CLI._done_precheck(
    C.parse_task(os.path.join(TASKS, "t-001.md")), ns(by="dsh", 结果="我做完了"))
check("认领人 hermes 而交回人 dsh 时拦下",
      len(errs) == 1 and "hermes" in errs[0] and "dsh" in errs[0], errs)
errs, warns = CLI._done_precheck(
    C.parse_task(os.path.join(TASKS, "t-001.md")), ns(by="hermes", 结果="我做完了"))
check("认领人一致时放行", len(errs) == 0, errs)
errs, warns = CLI._done_precheck(
    C.parse_task(os.path.join(TASKS, "t-001.md")), ns(by="", 结果="我做完了"))
check("不带 --by 的老用法一律放行（零破坏），但给一句提醒",
      len(errs) == 0 and any("认领" in w for w in warns), warns)
mkcard("t-009", "没人领的卡")
errs, warns = CLI._done_precheck(
    C.parse_task(os.path.join(TASKS, "t-009.md")), ns(by="dsh", 结果="我做完了"))
check("卡上没有认领人时传 --by 也不拦（认领是可选的）", len(errs) == 0, errs)

print("")
print("---- 8. 写回不丢：受管键漏输出 = 认领被抹掉 ----")
p1 = os.path.join(TASKS, "t-001.md")
d = C.parse_task(p1)
rendered = C.render_task(d)
claim_lines = [ln for ln in rendered.splitlines() if "认领" in ln]
check("render_task 输出了认领人（漏了这条，任何一次 Python 写回都会把认领抹掉）",
      "认领人: hermes" in rendered, claim_lines)
check("也输出了认领时间", "认领时间:" in rendered, claim_lines)
with open(p1, "w", encoding="utf-8") as f:
    f.write(rendered)
d2 = C.parse_task(p1)
unknown_keys = list((d2.get("_unknown") or {}).keys())
check("往返之后仍在受管键里（不是掉进 _unknown 被原样透传）",
      str(d2.get("认领人") or "") == "hermes" and "认领人" not in unknown_keys,
      "认领人=" + str(d2.get("认领人")) + " unknown=" + str(unknown_keys))

p9 = os.path.join(TASKS, "t-009.md")
C.write_task_file(p9, C.parse_task(p9))
with open(p9, encoding="utf-8") as f:
    after = f.read()
check("旧卡（没有认领字段）写回不多出认领人/认领时间两行",
      "认领人" not in after and "认领时间" not in after, after[:200])
check("而且原有内容没被改动（id 与标题还在）", "t-009" in after and "没人领的卡" in after)

print("")
print("---- 9. json 输出：agent 要能直接判是不是我的 ----")
out = run(CLI.cmd_next, format="json", claim="cursor")
try:
    j = json.loads(out)
except Exception as e:
    j = {}
    check("json 能解析", False, str(e))
check("json 带 claimed_by_me（agent 不用自己比字符串）",
      j.get("claimed_by_me") is True, j.get("claimed_by_me"))
check("json 带租约秒数（agent 能据此判断该不该等）",
      j.get("claim_ttl_seconds") == CLI.CLAIM_TTL_SECONDS, j.get("claim_ttl_seconds"))

shutil.rmtree(TMP, ignore_errors=True)

print("")
print("==== %d 通过 / %d 失败 ====" % (PASS, len(FAILS)))
if FAILS:
    for f in FAILS:
        print("  FAILED: " + f)
    sys.exit(1)
