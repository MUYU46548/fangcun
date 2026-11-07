#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
竞品档案 · 数据层（2026-11-07 · REV-007 的 P1 第一刀）

判据（每条都有反例）：
 ① 往某个项目加竞品 → **只多几行**：其它项目逐字节不变、注释保留、项目数不变；
 ② 三条反例：重名 / 项目不存在 / 没写 URL —— 一律拒，且**不写盘**；
 ③ 采集任务单里**不许出现任何密钥字段**（方寸不联网，采集单只是给 agent 的活）；
 ④ 没有采集数据时 `competitor_reports` 是空列表（不是"假装看过"的空报告）。

运行：python scripts/test/check-competitors.py
"""
import os
import sys
import shutil
import tempfile
import importlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

core = importlib.import_module("tegula.core")

TMP = tempfile.mkdtemp(prefix="fc-comp-")
DATA = os.path.join(TMP, "data")
TASKD = os.path.join(DATA, "task-data")
os.makedirs(TASKD, exist_ok=True)

# 把 core 的路径指到临时目录（模块级全局，改了就是全局生效 —— 与 e2e 里 setDataDir 同理）
core.DATA_DIR = DATA
core.REGISTRY_PATH = os.path.join(DATA, "registry.yaml")
core.REGISTRY_BAK = os.path.join(DATA, "registry.yaml.bak")
core.TASK_DIR = TASKD

FIXTURE = """# 方寸 (tegula) 项目注册表
# 这段注释必须活下来 —— 它是给人看的说明。

projects:
  - id: alpha
    name: 甲项目
    repo: E:/tmp/alpha
    状态: 在跑

  - id: beta
    name: 乙项目
    repo: E:/tmp/beta
    状态: 停着
"""
with open(core.REGISTRY_PATH, "w", encoding="utf-8") as f:
    f.write(FIXTURE)

pass_n = 0
fail_n = 0
failures = []


def check(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("PASS  " + name)
    else:
        fail_n += 1
        failures.append(name + ((" :: " + str(detail)) if detail else ""))
        print("FAIL  %s  -> %s" % (name, detail))


def read(p):
    # 前置步骤失败时可能拿到空路径；返回空串让断言变红，而不是让整份测试崩在
    # "测试自身异常"（硬约束③：显式跳过 + 打印原因，不要连锁红）
    if not p or not os.path.exists(p):
        return ""
    with open(p, encoding="utf-8") as f:
        return f.read()


print("== ① 加一条竞品：只多几行，别处不动 ==")
before = read(core.REGISTRY_PATH)
ok, msg = core.add_competitor("alpha", "Linear", "https://linear.app", "需求收口怎么做的")
after = read(core.REGISTRY_PATH)
check("★ 登记成功", ok, msg)
check("★★ 项目数没变（只该多一条竞品，不该多一个项目）",
      len(core.parse_registry(core.REGISTRY_PATH)) == 2)
check("★★ 顶部注释还在（禁 load+dump 的理由就在这）",
      "# 这段注释必须活下来" in after)
check("★★ 另一个项目（beta）整块逐字节没动",
      after.split("  - id: beta")[1] == before.split("  - id: beta")[1],
      "beta 块被改动了")
# 第一次登记 = 4 行：`    competitors:` 段头 + name/url/focus 三行。
# 第二条起才是 3 行（段头已存在）—— 下面单独验。
check("★ 第一次登记只多 4 行（段头 + 3 个字段），别处一行没动",
      len(after.splitlines()) - len(before.splitlines()) == 4,
      "%d → %d 行" % (len(before.splitlines()), len(after.splitlines())))
check("★ 读得回来", bool((core.load_competitors("alpha").get("alpha") or [{}])[0].get("name") == "Linear"))
check("★ 写前留了备份（registry.yaml.bak）", os.path.exists(core.REGISTRY_BAK))

# 第二条：插进已有 competitors 列表末尾
snap2 = read(core.REGISTRY_PATH)
ok2, msg2 = core.add_competitor("alpha", "Spec Kit", "https://github.com/github/spec-kit", "规格驱动怎么写")
rows = core.load_competitors("alpha").get("alpha", [])
check("★ 第二条追加在列表末尾（顺序稳定，视觉不乱）",
      ok2 and [r["name"] for r in rows] == ["Linear", "Spec Kit"], msg2)
check("★★ 第二条只多 3 行，且没插进第一条的属性行中间（YAML 仍是好的）",
      len(read(core.REGISTRY_PATH).splitlines()) - len(snap2.splitlines()) == 3
      and rows[0]["url"] == "https://linear.app", str(rows))
check("★★ parse_registry 不把竞品当项目（否则 next / report / 盘点全被污染）",
      len(core.parse_registry(core.REGISTRY_PATH)) == 2,
      str([p.get("id") for p in core.parse_registry(core.REGISTRY_PATH)]))

print("\n== ② 三条反例：都要拒，且不写盘 ==")
snap = read(core.REGISTRY_PATH)
r1 = core.add_competitor("alpha", "Linear", "https://other.example", "")
check("★★ 反例：重名 → 拒", r1[0] is False and "同名" in r1[1], r1)
r2 = core.add_competitor("nope", "X", "https://x.example", "")
check("★★ 反例：项目不存在 → 拒", r2[0] is False and "没有项目" in r2[1], r2)
r3 = core.add_competitor("alpha", "无地址竞品", "", "")
check("★★ 反例：没写 URL → 拒（没地址就没法采）", r3[0] is False and "地址" in r3[1], r3)
check("★★ 三条反例之后 registry 一个字节都没变", read(core.REGISTRY_PATH) == snap)

print("\n== ③ 采集任务单：给 agent 的活，不含密钥 ==")
task_path = core.write_competitor_task("alpha")
check("★ 任务单落盘", bool(task_path) and os.path.exists(task_path), task_path)
text = read(task_path) if task_path else ""
check("★ 里面有两个竞品和它们的地址", "Linear" in text and "linear.app" in text and "spec-kit" in text)
check("★ 关注点写进去了", "需求收口怎么做的" in text)
low = text.lower()
check("★★ 不含任何密钥字样（key/token/password/secret/api_key）",
      all(w not in low for w in ["api_key", "apikey", "token", "password", "secret", "passwd"]),
      "任务单里出现了疑似密钥字段")
check("★ 明说方寸不联网、要 agent 执行", "不联网" in text and "agent" in text)

print("\n== ④ 没有采集结果时，别装作看过 ==")
check("★★ 还没人回填 → 空列表（不是编一份空报告）", core.competitor_reports("alpha") == [])
rep_dir = core.competitors_dir("alpha")
os.makedirs(rep_dir, exist_ok=True)   # 前置失败时目录可能还没建 —— 别让测试自己连锁崩
with open(os.path.join(rep_dir, "2026-11-07-采集.md"), "w", encoding="utf-8") as f:
    f.write("## Linear\n变更：新增 intake 表单\n影响：可抄\n证据：linear.app/intake\n")
reps = core.competitor_reports("alpha")
check("★ 回填后能读到", len(reps) == 1 and "新增 intake 表单" in reps[0][1], reps)
check("★ 任务单本身不会被当成采集结果（否则天天报同一条）",
      all(n != "采集任务单.md" for n, _ in reps))

print("\n== ⑤ 不带 --project 时要递归，别假报「没采过」 ==")
check("★★ 不指定项目也能读到 alpha 的回填结果",
      any("新增 intake 表单" in t for _, t in core.competitor_reports("")),
      str([n for n, _ in core.competitor_reports("")]))
check("★ 递归结果带项目前缀（同名文件不撞车）",
      any(n.startswith("alpha/") for n, _ in core.competitor_reports("")),
      str([n for n, _ in core.competitor_reports("")]))

print("\n== ⑥ CLI 端到端（真跑 argparse，不是只调函数） ==")
import io
import contextlib
import tegula.cli as climod


def run_cli(argv):
    old = sys.argv
    buf = io.StringIO()
    try:
        sys.argv = ["tegula.py"] + argv
        try:
            with contextlib.redirect_stdout(buf):
                rc = climod.main()
        except SystemExit as e:
            # main() 在子命令返回 int 时会 sys.exit(rc)（10-14 修退出码那条）
            rc = e.code if e.code is not None else 0
    finally:
        sys.argv = old
    return (rc, buf.getvalue())


rc, out = run_cli(["competitor", "list", "--project", "alpha"])
check("★ CLI list 真能列出两条", rc in (0, None) and "Linear" in out and "Spec Kit" in out, out.strip()[:120])
rc, out = run_cli(["competitor", "add", "--project", "alpha", "--name", "Kiro", "--url", "https://kiro.dev", "--focus", "EARS"])
check("★★ CLI add 真写进 registry 并生成任务单",
      rc in (0, None) and "已登记竞品" in out and "采集任务单" in out
      and any(r["name"] == "Kiro" for r in core.load_competitors("alpha").get("alpha", [])),
      out.strip()[:160])
check("★ CLI add 的任务单里带第三条（不是只生成一次就固定）",
      "Kiro" in read(core.write_competitor_task("alpha")))
rc, out = run_cli(["competitor", "report", "--project", "alpha"])
check("★ CLI report 能读到回填内容", rc in (0, None) and "新增 intake 表单" in out, out.strip()[:120])
rc, out = run_cli(["competitor", "report", "--project", "beta"])
check("★★ 没采集数据时，明白说「要 agent 去采」——不许输出一张空报表冒充成功",
      rc in (0, None) and "没有采集数据" in out and "agent" in out, out.strip()[:160])

print("\n== ⑦ 写前护栏本身可测（不是\"永远真\"的摆设） ==")
clean = ["projects:", "  - id: alpha", "    name: 甲", "      - name: Linear", "  - id: beta"]
check("★ 只认项目 id，竞品的 `- name:` 不算项目",
      core._registry_project_ids(clean) == ["alpha", "beta"], str(core._registry_project_ids(clean)))
ghost = clean[:3] + ["  - id: ghost"] + clean[3:]
check("★★ 反例：文本里被意外插进一个 `- id: ghost` → 护栏抓得到",
      core._registry_project_ids(ghost) == ["alpha", "ghost", "beta"],
      str(core._registry_project_ids(ghost)))

print("")
if failures:
    print("失败明细：")
    for x in failures:
        print("  · " + x)
print("RESULT %d / %d" % (pass_n, fail_n))
try:
    shutil.rmtree(TMP, ignore_errors=True)
except Exception:
    pass
sys.exit(1 if fail_n else 0)
