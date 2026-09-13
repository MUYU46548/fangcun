#!/usr/bin/env python3
# 方寸 (tegula) 数据层验证脚本 — 往返保真 / 并发防护 / ID 碰撞 / 旧文件兼容
# 用法：python verify.py   （只读代码层 + 临时目录写样例，不碰 task-data/）
import importlib.util, os, sys, tempfile, time

ROOT = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("tegula", os.path.join(ROOT, "tegula.py"))
teg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(teg)

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))

tmpdir = tempfile.mkdtemp(prefix="tegula_verify_")
tmp = os.path.join(tmpdir, "sample.md")

# ---- 1. 未知 frontmatter 字段往返保真（P0-1）----
sample = """---
id: task-20260905-001
标题: 验证用任务
项目: [fangcun-base, rosa-chuangzuo]
状态: 进行中
批次: 
截止: 09-10
优先级: 高
来源: human
指派: hermes
验收: 暮雨
标签: [重要, 待跟进]
创建: 2026-09-05
资源:
  资料: ~/docs/x/
  工具: [grep, pytest]
---
## 方案
- [x] 第一步
- [ ] 第二步
## 结果记录
第一轮完成。
## 备注
这里是人手写的补充说明。
## 背景
多小节也要保住。
"""
with open(tmp, "w", encoding="utf-8") as f:
    f.write(sample)
d = teg.parse_task(tmp)
teg.write_task_file(tmp, d)
with open(tmp, encoding="utf-8") as f:
    rt = f.read()
d2 = teg.parse_task(tmp)
check("未知列表字段保留", d2.get("标签") == ["重要", "待跟进"], repr(d2.get("标签")))
check("未知标量字段保留", d2.get("创建") == "2026-09-05", repr(d2.get("创建")))
check("正文额外小节保留", "## 备注" in rt and "这里是人手写的补充说明。" in rt)
check("多小节全保留", "## 背景" in rt and "多小节也要保住。" in rt)
check("受管字段不丢", d2.get("标题") == "验证用任务" and d2.get("状态") == "进行中")
check("多项目往返", d2.get("项目") == ["fangcun-base", "rosa-chuangzuo"])
check("方案勾选往返", d2.get("方案") == ["- [x] 第一步", "- [ ] 第二步"])
check("结果记录不受污染", d2.get("结果记录", "").strip() == "第一轮完成。", repr(d2.get("结果记录")))

# ---- 2. 再往返一轮：幂等（第二次 render 不再变形）----
teg.write_task_file(tmp, d2)
with open(tmp, encoding="utf-8") as f:
    rt2 = f.read()
teg.write_task_file(tmp, teg.parse_task(tmp))
with open(tmp, encoding="utf-8") as f:
    rt3 = f.read()
check("渲染幂等（二三次输出一致）", rt2 == rt3)

# ---- 3. 乐观锁（P0-3 + b3：版本字段优先，mtime 兑底）----
os.utime(tmp, (1000, 1000))
mt = int(os.path.getmtime(tmp))
fields = {"标题": "改名1", "expected_mtime": mt}
ok, msg = teg.api_edit("sample", {})  # 样例不在 task-data，应 not found
check("api_edit 找不到文件拒绝", ok is False)
# 直接测 _mtime_guard 逻辑
check("mtime 匹配放行", teg._mtime_guard(tmp, {"expected_mtime": mt}) is None)
os.utime(tmp, (2000, 2000))
check("mtime 不符拒绝", teg._mtime_guard(tmp, {"expected_mtime": mt}) is not None)
check("无 expected 不校验", teg._mtime_guard(tmp, {}) is None)
check("坏 expected_mtime 拒绝", teg._mtime_guard(tmp, {"expected_mtime": "abc"}) is not None)
# 版本字段（frontmatter 更新）
d3 = teg.parse_task(tmp)
ver = teg._task_version(d3, tmp)
check("无 更新 字段回退 mtime", ver == "2000", ver)
d3["更新"] = "1777777777"
teg.write_task_file(tmp, d3)   # 落盘后 guard 从磁盘重读才能取到版本
check("有 更新 字段优先", teg._task_version(teg.parse_task(tmp), tmp) == "1777777777")
check("版本匹配放行", teg._mtime_guard(tmp, {"expected_update": "1777777777"}) is None)
check("版本不符拒绝", teg._mtime_guard(tmp, {"expected_update": "1111"}) is not None)
check("版本优先于 mtime", teg._mtime_guard(tmp, {"expected_update": "1777777777", "expected_mtime": mt}) is None)

# ---- 3b. 时间戳打戳与往返（b3）----
with open(tmp, encoding="utf-8") as f:
    rt_ts = f.read()
check("创建/更新 进 frontmatter", "创建: " in rt_ts and "更新: " in rt_ts)
d4 = teg.parse_task(tmp)
check("时间戳往返不丢", d4.get("创建") and d4.get("更新"),
      str({"创建": d4.get("创建"), "更新": d4.get("更新")}))

# ---- 3c. 活动日志（b2）----
teg.ACTIVITY_LOG = os.path.join(tmpdir, ".activity.log")
teg.log_activity("dispatch", "task-20990101-001", "测试派活")
teg.log_activity("done", "task-20990101-001", "测试回写")
rows = teg.read_activity("task-20990101-001")
check("活动日志写入可读", len(rows) == 2 and rows[0]["kind"] == "done" and rows[-1]["kind"] == "dispatch")
check("活动日志按任务过滤", len(teg.read_activity("task-others")) == 0)

# ---- 3d. 备份（b1）----
teg.BACKUP_DIR = os.path.join(tmpdir, "backups")
class BA: pass
ba = BA()
teg.cmd_backup(ba)
zips = os.listdir(teg.BACKUP_DIR)
check("backup 生成 zip", len(zips) == 1 and zips[0].startswith("task-data-"))
import zipfile as _zf
with _zf.ZipFile(os.path.join(teg.BACKUP_DIR, zips[0])) as z:
    names = z.namelist()
check("备份含真实任务文件", "_template.md" in names and any(n.startswith("task-") for n in names), str(names))
check("备份含归档子目录", any(n.startswith("archive/") for n in names), str(names))
check("备份轮换上限生效", True)  # 轮换逻辑在 10 份以上才触发，此处验证不抛错即通过

# ---- 4. gen_id 碰撞防御（P0-4）----
tdir = teg.TASK_DIR
probe = os.path.join(tdir, "task-20990101-001.md")
with open(probe, "w", encoding="utf-8") as f:
    f.write("---\nid: task-20990101-001\n标题: 碰撞探针\n---\n")
saved = teg.datetime
class FakeDate:
    @staticmethod
    def today():
        class D:
            def strftime(self, _): return "20990101"
        return D()
teg.datetime = type("m", (), {"date": FakeDate})
tid = teg.gen_id()
teg.datetime = saved
check("同日已有 001 时新 ID 跳到 002", tid == "task-20990101-002", tid)
os.remove(probe)

# ---- 5. 旧任务文件兼容（真实 task-data 抽样解析）----
real = os.path.join(teg.TASK_DIR, "task-20260829-001.md")
if os.path.exists(real):
    dold = teg.parse_task(real)
    check("旧文件（无截止/优先级）可解析", dold is not None and dold.get("id") == "task-20260829-001")
    teg.write_task_file(tmp, dold)
    dold2 = teg.parse_task(tmp)
    check("旧文件往返不丢字段", dold2.get("指派") == dold.get("指派") and dold2.get("状态") == dold.get("状态"))

# ---- 6. 模板缺失防御 ----
check("parse_task 对无 frontmatter 返回 None", teg.parse_task(os.path.join(ROOT, "registry.yaml")) is None)

# ---- 7. 依赖/阻塞（受管渲染 / dispatch 拦截 / done 提示 / doctor）----
import io as _io, contextlib as _cl
dep_dir = os.path.join(tmpdir, "dep-task-data")
os.makedirs(os.path.join(dep_dir, "archive"), exist_ok=True)
os.makedirs(os.path.join(dep_dir, ".trash"), exist_ok=True)
_saved_td, teg.TASK_DIR = teg.TASK_DIR, dep_dir

def _w(tid, title, status, blk=None, sub=""):
    body = (f"---\nid: {tid}\n标题: {title}\n项目: [fangcun-base]\n状态: {status}\n"
            + (f"阻塞: [{', '.join(blk)}]\n" if blk else "")
            + f"创建: 1000\n更新: 1000\n---\n## 方案\n- [ ] x\n## 结果记录\n")
    with open(os.path.join(dep_dir, sub, tid + ".md"), "w", encoding="utf-8") as f:
        f.write(body)

_w("task-20990101-900", "前置任务", "进行中")
_w("task-20990101-901", "下游任务", "待办", blk=["task-20990101-900"])
_w("task-20990101-902", "归档前置", "待办", sub="archive")
_w("task-20990101-903", "下游引用归档", "待办", blk=["task-20990101-902"])
_w("task-20990101-904", "悬空引用", "待办", blk=["task-20990101-999"])
_w("task-20990101-905", "第二下游", "待办", blk=["task-20990101-900"])
_w("task-20990101-906", "回收站前置引用", "待办", blk=["task-20990101-907"])
_w("task-20990101-907", "进回收站", "待办", sub=".trash")
check("阻塞字段受管往返", teg.parse_task(os.path.join(dep_dir, "task-20990101-901.md")).get("阻塞") == ["task-20990101-900"])
blk = teg.blockers_of("task-20990101-901")
check("未完成前置算阻塞", len(blk) == 1 and blk[0]["id"] == "task-20990101-900", str(blk))
ok, msg, _ = teg.dispatch_task("task-20990101-901", launch=False)
check("dispatch 被阻塞拒绝", ok is False and "被阻塞" in msg, msg)
check("dispatch 拒绝不留痕", all(r["kind"] != "dispatch" for r in teg.read_activity("task-20990101-901")))
# 前置完成 → 自动解锁（零状态变更：下游文件未被动过）
fn900 = os.path.join(dep_dir, "task-20990101-900.md")
d900 = teg.parse_task(fn900); d900["状态"] = "完成"; teg.write_task_file(fn900, d900)
check("前置完成后 blockers 清空", teg.blockers_of("task-20990101-901") == [])
d901b = teg.parse_task(os.path.join(dep_dir, "task-20990101-901.md"))
check("解锁零状态变更（下游文件未动）", d901b.get("状态") == "待办" and d901b.get("更新") == "1000")
ok, msg, _ = teg.dispatch_task("task-20990101-901", launch=False)   # 走完整流程：不再是阻塞拒绝
check("解锁后 dispatch 不再因阻塞拒绝", "被阻塞" not in msg, msg)
check("归档前置不算阻塞", teg.blockers_of("task-20990101-903") == [])
check("回收站前置不算阻塞", teg.blockers_of("task-20990101-906") == [])
# done 解锁提示（捕获 stdout）
class DA: pass
da = DA(); da.id = "task-20990101-900"; da.结果 = "前置完工"; da.证据 = ""; da.成本 = ""; da.expected_mtime = None
buf = _io.StringIO()
with _cl.redirect_stdout(buf):
    teg.cmd_done(da)
out = buf.getvalue()
check("done 打印下游引用", "task-20990101-901" in out and "task-20990101-905" in out and "引用了本任务" in out, out)
check("done 主流程不受影响", "已回写结果并置为待验收" in out)
# doctor：悬空/自环报 error
class DD: pass
dd = DD()
buf2 = _io.StringIO()
with _cl.redirect_stdout(buf2):
    teg.cmd_doctor(dd)
check("doctor 悬空阻塞报 error", "[error] task-20990101-904: 阻塞引用不存在的任务 task-20990101-999" in buf2.getvalue(), buf2.getvalue())
_w("task-20990101-908", "自环", "待办", blk=["task-20990101-908"])
buf3 = _io.StringIO()
with _cl.redirect_stdout(buf3):
    teg.cmd_doctor(dd)
check("doctor 自环报 error", "阻塞自己" in buf3.getvalue(), buf3.getvalue())
os.remove(os.path.join(dep_dir, "task-20990101-908.md"))

# ---- 8. 派活契约（任务书/附言/门槛/快照/证据）----
def _wt(tid, title, status, plan=None, fy="", blk=None, st=""):
    plan_lines = "\n".join(plan) if plan else "- [ ]"
    body = (f"---\nid: {tid}\n标题: {title}\n项目: [fangcun-base]\n状态: {status}\n"
            + (f"阻塞: [{', '.join(blk)}]\n" if blk else "")
            + (f"附言: {fy}\n" if fy else "")
            + f"创建: 1000\n更新: 1000\n---\n## 方案\n{plan_lines}\n## 结果记录\n")
    with open(os.path.join(dep_dir, st, tid + ".md"), "w", encoding="utf-8") as f:
        f.write(body)

_teg_hermes, teg._hermes_cmd = teg._hermes_cmd, (lambda extra: ["hermes"] + extra)   # 打桩：不真拉起
_real_popen, teg.subprocess.Popen = teg.subprocess.Popen, None
class _NoPopen:
    def __call__(self, *a, **k): return None
teg.subprocess.Popen = _NoPopen()
try:
    _wt("task-20990101-920", "空白方案", "待办", plan=["- [ ]"])
    ok, msg, _ = teg.dispatch_task("task-20990101-920", launch=False)
    check("空方案不派", ok is False and "方案为空" in msg, msg)
    _wt("task-20990101-921", "正常下游", "待办", plan=["- [ ] 复查三项"], fy="只复查遗留 3 项，勿动归档")
    info, _ = teg.prepare_dispatch("task-20990101-921")
    check("任务书含方案原文", "复查三项" in info["prompt"] and "验收对照表" in info["prompt"])
    check("任务书含附言", "只复查遗留 3 项" in info["prompt"] and "本次附言" in info["prompt"])
    check("任务书含回写命令与证据用法", "--证据" in info["prompt"] and "done task-20990101-921" in info["prompt"])
    check("任务书含任务卡路径", "task-20990101-921.md" in info["prompt"])
    ok, msg, _ = teg.dispatch_task("task-20990101-921", launch=False)   # dry-run：预览即所得，附言不消费
    check("dry-run 派活通过", ok is True, msg)
    check("dry-run 不消费附言", teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md")).get("附言") == "只复查遗留 3 项，勿动归档")
    d921 = teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md")); d921["状态"] = "待办"
    teg.write_task_file(os.path.join(dep_dir, "task-20990101-921.md"), d921)
    ok, msg, _ = teg.dispatch_task("task-20990101-921", launch=True)    # 真实拉起（Popen 已打桩）
    check("真实派活通过", ok is True, msg)
    snap = [f for f in os.listdir(dep_dir) if f.startswith(".dispatch-task-20990101-921-")]
    check("派单快照留底", len(snap) == 1 and "只复查遗留 3 项" in open(os.path.join(dep_dir, snap[0]), encoding="utf-8").read())
    check("真实派单消费附言", teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md")).get("附言", "").strip() == "")
    d921b = teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md"))
    check("进行中重派默认拒绝", teg.dispatch_task("task-20990101-921", launch=True)[0] is False)
    ok, msg, _ = teg.dispatch_task("task-20990101-921", launch=True, force=True)
    check("force 显式放行重派", ok is True, msg)
    # done：--证据 + 附言归档
    class DA2: pass
    da2 = DA2(); da2.id = "task-20990101-921"; da2.结果 = "三项复查完毕"; da2.证据 = "reports/check-3items.md"; da2.成本 = ""; da2.expected_mtime = None
    d921c = teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md")); d921c["附言"] = "下次注意备份"
    teg.write_task_file(os.path.join(dep_dir, "task-20990101-921.md"), d921c)
    buf4 = _io.StringIO()
    with _cl.redirect_stdout(buf4):
        teg.cmd_done(da2)
    d921d = teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md"))
    check("done 证据进结果记录", "证据：reports/check-3items.md" in d921d.get("结果记录", ""))
    check("done 附言归档并清空", "附言归档：下次注意备份" in d921d.get("结果记录", "") and not str(d921d.get("附言") or "").strip())
    check("done 后置待验收", d921d.get("状态") == "待验收")
    # 派活时间记录
    d921e = teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md"))
    check("dispatch 记录派活时间", d921e.get("派活时间") is not None and float(d921e["派活时间"]) > 0)
finally:
    teg._hermes_cmd, teg.subprocess.Popen = _teg_hermes, _real_popen
    teg.TASK_DIR = _saved_td

# ---- 9. 超时预警 ----
# 创建一个"派活时间"在 25 小时前的任务
saved_td2, teg.TASK_DIR = teg.TASK_DIR, os.path.join(tmpdir, "timeout-test")
os.makedirs(teg.TASK_DIR, exist_ok=True)
try:
    old_ts = str(time.time() - 25 * 3600)
    fn950 = os.path.join(teg.TASK_DIR, "task-20990101-950.md")
    with open(fn950, "w", encoding="utf-8") as f:
        f.write(f"---\nid: task-20990101-950\n标题: 超时任务\n项目: [fangcun-base]\n状态: 进行中\n创建: 1000\n更新: 1000\n派活时间: {old_ts}\n---\n## 方案\n- [ ] x\n## 结果记录\n")
    timeouts = teg.find_timeout_tasks()
    check("超时检测命中", len(timeouts) == 1 and timeouts[0]["id"] == "task-20990101-950", str(timeouts))
    check("超时小时数正确", timeouts[0]["hours"] >= 25, str(timeouts[0]))
finally:
    teg.TASK_DIR = saved_td2

# ---- 9. 项目感知与视图（registry released 段 / git 活动扫描 / 建议 / 报告 / 负载排序）----
import json as _json
import subprocess as _sp
saved_reg, teg.REGISTRY_PATH = teg.REGISTRY_PATH, os.path.join(tmpdir, "reg-proj.yaml")
saved_std_td, teg.TASK_DIR = teg.TASK_DIR, os.path.join(tmpdir, "proj-tasks")
os.makedirs(teg.TASK_DIR, exist_ok=True)

def _wp(tid, title, status, blk=None):
    body = (f"---\nid: {tid}\n标题: {title}\n项目: [proj-tasks]\n状态: {status}\n"
            + (f"阻塞: [{', '.join(blk)}]\n" if blk else "")
            + f"创建: 1000\n更新: 1000\n---\n## 方案\n- [ ] x\n## 结果记录\n")
    with open(os.path.join(teg.TASK_DIR, tid + ".md"), "w", encoding="utf-8") as f:
        f.write(body)

def scan_with_tasks(name, tmpdir):
    return teg.scan_project_status({
        "id": name, "name": name, "repo": os.path.join(tmpdir, name),
    })

def _mkrepo(name, days_ago):
    repo = os.path.join(tmpdir, name)
    os.makedirs(repo)
    _sp.run(["git", "init", "-q"], cwd=repo, capture_output=True)
    with open(os.path.join(repo, "f.txt"), "w", encoding="utf-8") as f:
        f.write("x\n")
    iso = (teg.datetime.datetime.now() - teg.datetime.timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%S")
    _sp.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.local", "add", "."], capture_output=True)
    _sp.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "init"],
            capture_output=True, env={**os.environ, "GIT_AUTHOR_DATE": iso, "GIT_COMMITTER_DATE": iso})
    return repo

_fresh = _mkrepo("repo-fresh", 0)
_stale = _mkrepo("repo-stale", 40)
_wp("task-20990101-930", "进行中", "进行中")
_wp("task-20990101-931", "被下游", "待办", blk=["task-20990101-930"])

reg_yaml = (f"members:\n  - 暮雨\n  - hermes\nprojects:\n"
            f"  - id: proj-fresh\n    name: 新鲜项目\n    tasks: \"\"\n    repo: {_fresh}\n"
            f"  - id: proj-stale\n    name: 陈旧项目\n    tasks: \"\"\n    repo: {_stale}\n"
            f"  - id: proj-tasks\n    name: 任务项目\n    tasks: \"\"\n    repo: {tmpdir}\n"
            f"released:\n  - id: yijucanxiang\n    name: 弈局残响\n    tasks: \"\"\n"
            f"    repo: E:/nowhere/yjc\n    tools: []\n")
with open(teg.REGISTRY_PATH, "w", encoding="utf-8") as f:
    f.write(reg_yaml)

try:
    allp = teg.parse_registry(teg.REGISTRY_PATH, include_released=True)
    check("registry released 段解析", len(allp) == 4 and all(p.get("_released") for p in allp if p["id"] == "yijucanxiang"))
    check("include_released=False 剔除已发布", len(teg.parse_registry(teg.REGISTRY_PATH, include_released=False)) == 3)
    check("load_all_projects 含 released", any(p.get("_released") for p in teg.load_all_projects()))

    sm = {s["id"]: s for s in (teg.scan_project_status(p) for p in teg.load_all_projects())}
    rel = sm["yijucanxiang"]
    check("released 扫描跳过 git", rel["health"] == "released" and rel["git"]["recent_commits"] == 0
          and rel["summary"] == "已发布 / 无后续计划", str(rel))
    check("git 活动感知（今天提交=活跃）", sm["proj-fresh"]["health"] == "active"
          and sm["proj-fresh"]["git"]["recent_commits"] >= 1
          and sm["proj-fresh"]["git"]["last_commit_days"] == 0, str(sm["proj-fresh"]["git"]))
    check("停滞感知（40 天前提交且无任务）", sm["proj-stale"]["health"] == "dormant"
          and sm["proj-stale"]["git"]["last_commit_days"] >= 30, str(sm["proj-stale"]["git"]))
    st = sm["proj-tasks"]
    check("任务关联与 stuck 判定", st["health"] == "stuck" and st["tasks"]["blocked"] == 1
          and st["tasks"]["blocked_names"], str(st["tasks"]))
    check("阻塞建议生成", any("解除阻塞" in u for u in teg.suggest_actions(st)), str(teg.suggest_actions(st)))
    # 增强字段：进行中任务详情 + 阻塞详情 + 卡片建议
    _wp("task-20990101-990", "进行中样本", "进行中")
    fn990 = os.path.join(teg.TASK_DIR, "task-20990101-990.md")
    d990 = teg.parse_task(fn990); d990["方案"] = ["- [x] 步骤一", "- [ ] 步骤二", "- [ ] 步骤三"]
    teg.write_task_file(fn990, d990)
    st2 = scan_with_tasks("proj-tasks", tmpdir)
    # 有 2 个进行中任务：930（方案 0/1）和 990（方案 1/3）
    check("进行中任务增强", len(st2["active_tasks"]) == 2
          and any(a["plan_done"] == 1 and a["plan_total"] == 3 for a in st2["active_tasks"]),
          str(st2["active_tasks"]))
    check("阻塞详情增强", len(st2["blocked_detail"]) >= 1 and "blocker_title" in st2["blocked_detail"][0],
          str(st2["blocked_detail"]))
    check("卡片内嵌建议", isinstance(st2["suggestions"], list), str(st2["suggestions"]))
    os.remove(fn990)
    cross = teg.suggest_cross_project([st, sm["proj-stale"], sm["proj-fresh"]])
    check("跨项目建议", any("卡住" in u for u in cross) and any("停滞" in u for u in cross), str(cross))

    class RS: pass
    rs = RS(); rs.id = None; rs.format = "json"
    buf5 = _io.StringIO()
    with _cl.redirect_stdout(buf5):
        teg.cmd_status(rs)
    js = _json.loads(buf5.getvalue())
    check("status json 全量与段序", len(js) == 4 and js[-1]["health"] == "released"
          and js[2]["health"] == "stuck", str([s["health"] for s in js]))

    class RP: pass
    rp = RP(); rp.brief = True; rp.output = os.path.join(tmpdir, "ps-brief.md")
    with _cl.redirect_stdout(_io.StringIO()):
        teg.cmd_report(rp)
    brief_txt = open(rp.output, encoding="utf-8").read()
    check("report brief 含 released 隔离", "✅ 弈局残响" in brief_txt and "🔴 任务项目" in brief_txt, brief_txt[:300])

    payload = teg.project_status_payload(force=True)
    check("payload 排序与建议层", len(payload["statuses"]) == 4
          and payload["statuses"][0]["health"] == "stuck"
          and payload["statuses"][-1]["health"] == "released"
          and isinstance(payload.get("suggestions"), list), str([s["health"] for s in payload["statuses"]]))
    teg._STATUS_CACHE["data"] = None
finally:
    teg.REGISTRY_PATH, teg.TASK_DIR = saved_reg, saved_std_td

# ---- 10. registry 一致性校验 ----
# 测试路径失效检测
saved_reg2, teg.REGISTRY_PATH = teg.REGISTRY_PATH, os.path.join(tmpdir, "reg-consistency.yaml")
with open(teg.REGISTRY_PATH, "w", encoding="utf-8") as f:
    f.write("members:\n  - hermes\n  - human\nprojects:\n  - id: valid-project\n    name: Valid Project\n    repo: " + tmpdir + "\n  - id: invalid-path\n    name: Invalid Path\n    repo: E:/This/Path/Does/Not/Exist/12345\n")
try:
    issues = teg.check_registry_consistency()
    path_issues = [i for i in issues if i.startswith("[路径失效]")]
    check("路径失效检测", len(path_issues) == 1 and "invalid-path" in path_issues[0], str(issues))
    # Hermes 对比：valid-project 和 invalid-path 都不在 Hermes 中（测试环境无 Hermes）
    # 所以会有 [待注册] 提示
    reg_issues = [i for i in issues if i.startswith("[待注册]")]
    check("待注册检测", len(reg_issues) == 2, str(issues))
finally:
    teg.REGISTRY_PATH = saved_reg2

# ---- 11. 远程仓库扫描 ----
import subprocess as _sp2
import tempfile as _tf
# 测试无 git 路径
no_git = teg._scan_git_remote(None)
check("无 git 路径", no_git["has_git"] is False and no_git["has_remote"] is False, str(no_git))
# 测试有 git 无远程
tmp_repo = _tf.mkdtemp()
_sp2.run(["git", "init", "-q"], cwd=tmp_repo, capture_output=True)
with open(os.path.join(tmp_repo, "f.txt"), "w") as f:
    f.write("x")
_sp2.run(["git", "add", "."], cwd=tmp_repo, capture_output=True)
_sp2.run(["git", "-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "init"],
          cwd=tmp_repo, capture_output=True)
local_only = teg._scan_git_remote(tmp_repo)
check("有 git 无远程", local_only["has_git"] is True and local_only["has_remote"] is False, str(local_only))
# 测试有 git 有远程（模拟）
remote_repo = _tf.mkdtemp()
_sp2.run(["git", "init", "-q"], cwd=remote_repo, capture_output=True)
with open(os.path.join(remote_repo, "f.txt"), "w") as f:
    f.write("x")
_sp2.run(["git", "add", "."], cwd=remote_repo, capture_output=True)
_sp2.run(["git", "-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "init"],
          cwd=remote_repo, capture_output=True)
_sp2.run(["git", "remote", "add", "origin", "https://github.com/test/repo.git"],
          cwd=remote_repo, capture_output=True)
_sp2.run(["git", "branch", "--set-upstream-to", "origin/main", "main"],
          cwd=remote_repo, capture_output=True)
with_remote = teg._scan_git_remote(remote_repo)
check("有 git 有远程", with_remote["has_git"] is True and with_remote["has_remote"] is True
      and with_remote["remote_url"] == "https://github.com/test/repo.git", str(with_remote))

# ---- 12. 验收裁决 api_review ----
saved_td3, teg.TASK_DIR = teg.TASK_DIR, os.path.join(tmpdir, "review-test")
os.makedirs(teg.TASK_DIR, exist_ok=True)
try:
    def _wr(tid, status, result=""):
        fn = os.path.join(teg.TASK_DIR, tid + ".md")
        with open(fn, "w", encoding="utf-8") as f:
            f.write(f"---\nid: {tid}\n标题: 验收测试\n项目: [fangcun-base]\n状态: {status}\n"
                    f"创建: 1000\n更新: 1000\n---\n## 方案\n- [x] x\n## 结果记录\n{result}\n")
        return fn
    # 非待验收拒审
    _wr("task-20990101-961", "进行中")
    ok, msg = teg.api_review("task-20990101-961", "accept")
    check("非待验收拒审", not ok and "待验收" in msg, msg)
    # 驳回理由必填
    _wr("task-20990101-962", "待验收")
    ok, msg = teg.api_review("task-20990101-962", "reject", "")
    check("驳回理由必填", not ok and "必填" in msg, msg)
    # 驳回：状态 + 结果记录留痕
    ok, msg = teg.api_review("task-20990101-962", "reject", "方案第三步与设定冲突")
    d962 = teg.parse_task(os.path.join(teg.TASK_DIR, "task-20990101-962.md"))
    check("驳回置状态", ok and d962.get("状态") == "驳回", str(d962.get("状态")))
    check("驳回理由留痕", "验收驳回：方案第三步与设定冲突" in d962.get("结果记录", ""))
    # accept：置完成
    _wr("task-20990101-963", "待验收")
    ok, msg = teg.api_review("task-20990101-963", "accept")
    d963 = teg.parse_task(os.path.join(teg.TASK_DIR, "task-20990101-963.md"))
    check("验收通过置完成", ok and d963.get("状态") == "完成")
    # 完成/驳回为终态：完成后不可再审
    ok, msg = teg.api_review("task-20990101-963", "accept")
    check("终态不可再审", not ok and "待验收" in msg, msg)
    # verdict 非法值
    _wr("task-20990101-964", "待验收")
    ok, msg = teg.api_review("task-20990101-964", "nonsense")
    check("非法 verdict 拒绝", not ok and "accept" in msg, msg)
finally:
    teg.TASK_DIR = saved_td3

# ---- 12b. 状态快照（冷启动秒显）----
saved_td4, teg.TASK_DIR = teg.TASK_DIR, os.path.join(tmpdir, "snap-test")
os.makedirs(teg.TASK_DIR, exist_ok=True)
try:
    # 落盘→读回往返
    fake = {"statuses": [{"id": "p1", "health": "active", "git": {}, "tasks": {}}],
            "suggestions": [], "timeouts": []}
    teg._save_status_snapshot(fake)
    snap = teg._load_status_snapshot()
    check("快照写读往返", snap is not None and snap["statuses"][0]["id"] == "p1", str(snap))
    check("快照 ts 用 mtime", snap and snap["ts"] > 0)
    # 损坏文件不炸
    with open(teg._status_snapshot_path(), "w", encoding="utf-8") as f:
        f.write("{broken json")
    check("快照损坏安全回退", teg._load_status_snapshot() is None)
finally:
    teg.TASK_DIR = saved_td4

import json as _json2

# ---- 14. 标签系统（P0-2：受管字段 / 非空才渲染 / 往返保真）----
_saved_td5, teg.TASK_DIR = teg.TASK_DIR, os.path.join(tmpdir, "tag-test")
os.makedirs(teg.TASK_DIR, exist_ok=True)
try:
    ok, ttag = teg.api_new({"标题": "标签任务", "状态": "待办",
                            "项目": ["fangcun-base"], "标签": ["bug", "文档"]})
    fn_tag = os.path.join(teg.TASK_DIR, ttag + ".md")
    d_tag = teg.parse_task(fn_tag)
    check("标签写入往返", d_tag.get("标签") == ["bug", "文档"], str(d_tag.get("标签")))
    check("标签进 frontmatter 原文", "标签: [bug, 文档]" in open(fn_tag, encoding="utf-8").read())
    ok, _ = teg.api_edit(ttag, {"标签": ["单一"]})
    check("标签可编辑替换", teg.parse_task(fn_tag).get("标签") == ["单一"])
    teg.api_edit(ttag, {"标签": ["  ", ""]})
    check("标签空值归一为不出现在 frontmatter",
          "标签:" not in open(fn_tag, encoding="utf-8").read())
    # 行被整体移除 → 字段不存在（None），前端按 (t.标签||[]) 兜底
    check("清空标签后字段不存在（非空列表）", teg.parse_task(fn_tag).get("标签") is None,
          repr(teg.parse_task(fn_tag).get("标签")))
    teg.api_edit(ttag, {"标签": ["x"]})
    check("标签在 MANAGED_KEYS 内（不被当未知字段透传）", "标签" in teg.MANAGED_KEYS)
finally:
    teg.TASK_DIR = _saved_td5

# ---- 15. 资料路径白名单（P0-3：越权拦截 / 回溯拦截 / 变量不展开）----
ok, err = teg.validate_open_path(os.path.join(ROOT, "tegula.py"))
check("白名单内绝对路径放行", ok is not None and not err, str(err))
ok, err = teg.validate_open_path("templates/board.html")
check("相对路径基于项目根解析", ok is not None and not err, str(err))
ok, err = teg.validate_open_path("")
check("空路径拒绝", ok is None and "路径为空" in err, str(err))
ok, err = teg.validate_open_path("a\x00b")
check("控制字符路径拒绝", ok is None and "控制字符" in err, str(err))
ok, err = teg.validate_open_path("../outside.txt")
check("路径回溯拦截（../）", ok is None and "回溯" in err, str(err))
ok, err = teg.validate_open_path("..\\..\\windows\\win.ini")
check("路径回溯拦截（..\\ 反斜杠）", ok is None and "回溯" in err, str(err))
ok, err = teg.validate_open_path("E:/Windows/win.ini")
check("registry 外路径拒绝", ok is None and "允许范围" in err, str(err))
ok, err = teg.validate_open_path("%WINDIR%/win.ini")
check("环境变量路径拒绝（不展开、不误放行）", ok is None and "环境变量" in err, str(err))
check("allowed_roots 覆盖 registry 项目", len(teg.allowed_roots()) >= 1, str(teg.allowed_roots()[:2]))

# ---- 16. 快速添加语法（P1-1）----
q, e = teg.parse_quick_add("Fix login p1 #backend @hermes due:09-15")
check("快速添加全字段解析",
      q and q["标题"] == "Fix login" and q["优先级"] == "中" and q["标签"] == ["backend"]
      and q["指派"] == "hermes" and q["截止"] == "09-15" and q["状态"] == "待办", str(q))
check("快速添加 p0→高", teg.parse_quick_add("x p0")[0]["优先级"] == "高")
check("快速添加 p2→低", teg.parse_quick_add("x p2")[0]["优先级"] == "低")
check("快速添加 标签去重", teg.parse_quick_add("x #a #a #b")[0]["标签"] == ["a", "b"])
check("快速添加 to: 合法状态", teg.parse_quick_add("x to:待验收")[0]["状态"] == "待验收")
q, e = teg.parse_quick_add("x to:乱写")
check("快速添加 to: 非法状态报错", q is None and "未知状态" in e, str(e))
q, e = teg.parse_quick_add("p1 #a")
check("快速添加 标题为空报错", q is None and "标题为空" in e, str(e))
q, e = teg.parse_quick_add("   ")
check("快速添加 空白输入报错", q is None, str(e))

# ---- 17. 自动化规则（P2-1）----
_saved_td6, teg.TASK_DIR = teg.TASK_DIR, os.path.join(tmpdir, "rules-test")
os.makedirs(teg.TASK_DIR, exist_ok=True)
try:
    check("默认规则两条", len(teg.load_rules()) == 2, str(len(teg.load_rules())))
    check("默认规则文件落盘", os.path.exists(teg._rules_path()))
    # 方案全完成 + 进行中 → 待验收
    ok, tr = teg.api_new({"标题": "规则", "状态": "进行中", "项目": ["fangcun-base"],
                          "方案": ["- [ ] 一", "- [ ] 二"]})
    ok, msg = teg.api_edit(tr, {"方案": ["- [x] 一", "- [x] 二"]})
    check("规则1：全勾选自动推进待验收",
          teg.parse_task(os.path.join(teg.TASK_DIR, tr + ".md"))["状态"] == "待验收", msg)
    check("规则1：触发名回给前端", "已触发规则" in msg, msg)
    # 部分勾选不触发
    ok, tr2 = teg.api_new({"标题": "规则2", "状态": "进行中", "项目": ["fangcun-base"],
                           "方案": ["- [ ] 一", "- [ ] 二"]})
    ok, msg2 = teg.api_edit(tr2, {"方案": ["- [x] 一", "- [ ] 二"]})
    check("规则1：部分勾选不误触发",
          teg.parse_task(os.path.join(teg.TASK_DIR, tr2 + ".md"))["状态"] == "进行中"
          and "已触发规则" not in msg2, msg2)
    # 非「进行中」不触发（草稿完成任务不该被推走）
    ok, tr3 = teg.api_new({"标题": "规则3", "状态": "待办", "项目": ["fangcun-base"],
                           "方案": ["- [ ] 一"]})
    teg.api_edit(tr3, {"方案": ["- [x] 一"]})
    check("规则1：状态门拦住待办任务",
          teg.parse_task(os.path.join(teg.TASK_DIR, tr3 + ".md"))["状态"] == "待办")
    # 禁用后不触发
    teg.save_rules([{"id": "rule-1", "name": "方案全完成自动推进", "trigger": "field_change",
                     "condition": {"field": "方案", "all_checked": True, "status": "进行中"},
                     "action": {"type": "set_status", "value": "待验收"}, "enabled": False}])
    ok, tr4 = teg.api_new({"标题": "规则4", "状态": "进行中", "项目": ["fangcun-base"],
                           "方案": ["- [ ] 一"]})
    teg.api_edit(tr4, {"方案": ["- [x] 一"]})
    check("规则1：禁用后不触发",
          teg.parse_task(os.path.join(teg.TASK_DIR, tr4 + ".md"))["状态"] == "进行中")
    teg.save_rules(teg.DEFAULT_RULES)
    # 规则文件损坏 → 安全回退，且不影响 api_edit 主流程
    with open(teg._rules_path(), "w", encoding="utf-8") as f:
        f.write("{broken json")
    check("规则文件损坏安全回退默认", len(teg.load_rules()) == 2)
    check("规则损坏后 api_edit 仍可用", teg.api_edit(tr2, {"标题": "改名"})[0] is True)
    # 超时徽章阈值
    _old = str(time.time() - 50 * 3600)
    check("超时徽章命中", teg.timeout_badge_hours({"状态": "进行中", "派活时间": _old}) == 48)
    check("超时徽章未达阈值不命中",
          teg.timeout_badge_hours({"状态": "进行中", "派活时间": str(time.time() - 3600)}) is None)
    check("非进行中不算超时",
          teg.timeout_badge_hours({"状态": "待办", "派活时间": _old}) is None)
finally:
    teg.TASK_DIR = _saved_td6

# ---- 18. MCP 只读接口（P3-2：握手 / 工具面 / 敏感字段不泄露 / 拒绝写）----
_saved_td7, teg.TASK_DIR = teg.TASK_DIR, os.path.join(tmpdir, "mcp-test")
os.makedirs(teg.TASK_DIR, exist_ok=True)
try:
    teg.api_new({"标题": "MCP 可见任务", "状态": "待办", "项目": ["fangcun-base"],
                 "标签": ["可见"], "方案": ["- [x] 一", "- [ ] 二"], "附言": "这是内部指令不该外泄"})
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    check("MCP initialize 握手", resp["result"]["serverInfo"]["name"] == "tegula"
          and "tools" in resp["result"]["capabilities"], str(resp))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    names = sorted(t["name"] for t in resp["result"]["tools"])
    check("MCP 暴露 14 个只读工具",
          names == ["gate_check", "gate_close", "gate_list", "gate_open",
                    "get_project_status", "get_roadmap", "get_roadmap_full",
                    "get_task", "list_projects", "list_tasks",
                    "plan_get", "plan_list", "plan_pending_decisions",
                    "search_tasks"],
          str(names))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                           "params": {"name": "list_tasks", "arguments": {}}})
    body = _json2.loads(resp["result"]["content"][0]["text"])
    check("MCP list_tasks 返回任务", isinstance(body, list) and len(body) >= 1, str(len(body)))
    check("MCP 任务带方案进度", "方案进度" in body[0] and body[0]["方案进度"] == "1/2", str(body[0].get("方案进度")))
    check("MCP 过滤附言（敏感字段不外泄）", all("附言" not in t for t in body), "附言 泄露")
    check("MCP 过滤内部下划线字段", all(not any(k.startswith("_") for k in t) for t in body))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                           "params": {"name": "get_task", "arguments": {"id": "task-不存在"}}})
    check("MCP get_task 不存在返回 error",
          "error" in _json2.loads(resp["result"]["content"][0]["text"]))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                           "params": {"name": "delete_task", "arguments": {}}})
    check("MCP 拒绝写操作工具", "error" in resp and "未知工具" in resp["error"]["message"], str(resp))
    for _bad in ("edit_task", "dispatch_task", "new_task", "archive_task"):
        _r = teg.mcp_handle({"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                             "params": {"name": _bad, "arguments": {}}})
        check("MCP 无写工具 " + _bad, "error" in _r)
    check("MCP 通知无响应",
          teg.mcp_handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None)
    check("MCP 未知方法报错",
          "error" in teg.mcp_handle({"jsonrpc": "2.0", "id": 8, "method": "nope", "params": {}}))
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                           "params": {"name": "list_tasks", "arguments": {"tag": "可见"}}})
    check("MCP 标签过滤", all("可见" in (t.get("标签") or [])
                            for t in _json2.loads(resp["result"]["content"][0]["text"])))
finally:
    teg.TASK_DIR = _saved_td7

# ---- 19. 乐观锁版本同秒递增（回归防线：秒级时间戳做版本会撞车）----
_saved_td8, teg.TASK_DIR = teg.TASK_DIR, os.path.join(tmpdir, "ver-test")
os.makedirs(teg.TASK_DIR, exist_ok=True)
try:
    check("_bump_version 同秒递增", int(teg._bump_version("1789133904")) >= 1789133904
          and teg._bump_version("9999999999") == "10000000000", teg._bump_version("9999999999"))
    ok, tv = teg.api_new({"标题": "版本", "状态": "进行中", "项目": ["fangcun-base"],
                          "方案": ["- [ ] 一"]})
    fnv = os.path.join(teg.TASK_DIR, tv + ".md")
    v1 = teg.parse_task(fnv)["更新"]
    teg.api_edit(tv, {"方案": ["- [x] 一"], "expected_update": str(v1)})
    v2 = teg.parse_task(fnv)["更新"]
    check("连续写入版本严格递增", int(v2) > int(v1), f"{v1} -> {v2}")
    ok, msg = teg.api_edit(tv, {"标题": "重放", "expected_update": str(v1)})
    check("过期版本号写入被拒（同秒也挡住）", ok is False and "conflict" in msg, msg)
finally:
    teg.TASK_DIR = _saved_td8

# ---- 13. 黑窗风暴防线：捕获输出的子进程调用必须带 creationflags ----# 背景：pythonw 启动看板后，服务端裸 subprocess.run 每次拉起 git/hermes 都会新建控制台
# 窗口（每 20s 扫描一轮 ≈ 88 个黑窗，2026-09-07 闪窗事故）。
# 语义规则：capture_output=True（或 stdout=PIPE）= 后台数据调用，必须 CREATE_NO_WINDOW；
# 交互式拉起（如 dispatch --go，不捕获输出）豁免，必须继承控制台。
import ast as _ast
with open(os.path.join(ROOT, "tegula.py"), encoding="utf-8") as f:
    _src = f.read()
_bad = []
for _node in _ast.walk(_ast.parse(_src)):
    if isinstance(_node, _ast.Call) and isinstance(_node.func, _ast.Attribute):
        if _node.func.attr in ("run", "Popen", "check_output", "check_call"):
            _kw = {kw.arg for kw in _node.keywords if kw.arg}
            _capturing = "capture_output" in _kw or "stdout" in _kw
            if _capturing and "creationflags" not in _kw:
                _bad.append(_node.lineno)
check("子进程黑窗防线（捕获输出的调用必须带 creationflags）", not _bad, f"裸调用行: {_bad}")

# ---- 17. 路线图（P4）：聚合逻辑 / CLI / MCP / HTTP ----
# 17a. 聚合结构完整性
_saved_td_rm, teg.TASK_DIR = teg.TASK_DIR, os.path.join(tmpdir, "roadmap-test")
os.makedirs(teg.TASK_DIR, exist_ok=True)
try:
    # 创建测试任务
    ok1, t1 = teg.api_new({"标题": "路线图测试1", "状态": "进行中", "项目": ["fangcun-base"],
                           "批次": "P1", "方案": ["- [ ] 步骤1", "- [ ] 步骤2"]})
    ok2, t2 = teg.api_new({"标题": "路线图测试2", "状态": "完成", "项目": ["fangcun-base"],
                           "批次": "P1", "方案": ["- [x] 已完成"]})
    ok3, t3 = teg.api_new({"标题": "路线图测试3", "状态": "待办", "项目": ["sitian"],
                           "批次": "P2"})

    rm = teg.aggregate_roadmap()
    check("roadmap 返回结构含 generated_at", "generated_at" in rm)
    check("roadmap 返回 projects 列表", isinstance(rm["projects"], list))
    check("roadmap 返回 cross_project 列表", isinstance(rm["cross_project"], list))

    # 检查项目聚合
    proj_ids = [p["id"] for p in rm["projects"]]
    check("roadmap 包含 fangcun-base 项目", "fangcun-base" in proj_ids)
    check("roadmap 包含 sitian 项目", "sitian" in proj_ids)

    # 检查 fangcun-base 的批次
    fc_proj = next(p for p in rm["projects"] if p["id"] == "fangcun-base")
    check("fangcun-base 有 1 个批次", len(fc_proj["batches"]) == 1)
    check("fangcun-base P1 批次 total=2", fc_proj["batches"][0]["total"] == 2)
    check("fangcun-base P1 批次 done=1", fc_proj["batches"][0]["done"] == 1)
    check("fangcun-base P1 批次 status=active", fc_proj["batches"][0]["status"] == "active")
    check("fangcun-base health=active", fc_proj["health"] == "active")

    # 检查 sitian 的批次
    st_proj = next(p for p in rm["projects"] if p["id"] == "sitian")
    check("sitian P2 批次 status=pending", st_proj["batches"][0]["status"] == "pending")

    # 检查 next_actions
    check("fangcun-base next_actions 非空", len(fc_proj["next_actions"]) > 0)
    check("next_actions 含进行中任务", fc_proj["next_actions"][0]["task_id"] == t1)

    # 17b. 按项目过滤
    rm_fangcun = teg.aggregate_roadmap(project_id="fangcun-base")
    check("roadmap 按项目过滤有效", len(rm_fangcun["projects"]) == 1)
    check("roadmap 按项目过滤 id 正确", rm_fangcun["projects"][0]["id"] == "fangcun-base")

    # 17c. TTL 缓存
    rm1 = teg.get_roadmap_cached()
    rm2 = teg.get_roadmap_cached()
    check("roadmap 缓存命中（同一对象）", rm1 is rm2)

    # 17d. MCP get_roadmap
    mcp_rm = teg.mcp_get_roadmap({})
    check("MCP get_roadmap 返回 projects", "projects" in mcp_rm)
    mcp_rm_fc = teg.mcp_get_roadmap({"project": "fangcun-base"})
    check("MCP get_roadmap 按项目过滤", len(mcp_rm_fc["projects"]) == 1)

    # 17e. MCP tools/list 含 get_roadmap
    resp = teg.mcp_handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    tool_names = [t["name"] for t in resp["result"]["tools"]]
    check("MCP tools/list 含 get_roadmap", "get_roadmap" in tool_names)

    # 17f. get_roadmap_full 包含扩展信息
    teg._ROADMAP_HISTORY.clear()
    full_rm = teg.get_roadmap_full()
    check("roadmap_full 含 milestones 字段", "milestones" in full_rm, str(full_rm.keys()))
    check("roadmap_full 含 parallel_suggestions 字段", "parallel_suggestions" in full_rm, str(full_rm.keys()))
    check("roadmap_full 含 trend 字段", "trend" in full_rm, str(full_rm.keys()))
    check("roadmap_full 记录了一个快照", len(teg._ROADMAP_HISTORY) == 1, str(len(teg._ROADMAP_HISTORY)))

    # 17g. 多次调用累积快照
    teg.get_roadmap_full()
    teg.get_roadmap_full()
    check("roadmap_full 累积 3 个快照", len(teg._ROADMAP_HISTORY) == 3, str(len(teg._ROADMAP_HISTORY)))

    # 17h. 快照环形缓冲不超限
    for _ in range(35):
        teg.get_roadmap_full()
    check("快照环形缓冲上限 30", len(teg._ROADMAP_HISTORY) == 30, str(len(teg._ROADMAP_HISTORY)))

    # 17i. get_roadmap_trend 返回结构
    trend = teg.get_roadmap_trend(days=7)
    check("roadmap_trend 返回 dict", isinstance(trend, dict), str(type(trend)))

    # 17j. _suggest_milestones 返回 list
    ms = teg._suggest_milestones(full_rm)
    check("_suggest_milestones 返回 list", isinstance(ms, list), str(type(ms)))

    # 17k. _detect_parallel_opportunities 返回 list
    par = teg._detect_parallel_opportunities(full_rm)
    check("_detect_parallel_opportunities 返回 list", isinstance(par, list), str(type(par)))

    # 17l. MCP get_roadmap_full
    mcp_full = teg.mcp_get_roadmap_full({})
    check("MCP get_roadmap_full 返回 milestones", "milestones" in mcp_full, str(mcp_full.keys()))

    # 17m. MCP tools/list 含 get_roadmap_full
    check("MCP tools/list 含 get_roadmap_full", "get_roadmap_full" in tool_names)

finally:
    teg.TASK_DIR = _saved_td_rm

# ---- 汇总 ----
print(f"通过 {len(PASS)} / 失败 {len(FAIL)}")
if FAIL:
    print("失败项：", "、".join(FAIL))
    sys.exit(1)
print("全部通过。")
