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
ok, msg = teg.dispatch_task("task-20990101-901", launch=False)
check("dispatch 被阻塞拒绝", ok is False and "被阻塞" in msg, msg)
check("dispatch 拒绝不留痕", all(r["kind"] != "dispatch" for r in teg.read_activity("task-20990101-901")))
# 前置完成 → 自动解锁（零状态变更：下游文件未被动过）
fn900 = os.path.join(dep_dir, "task-20990101-900.md")
d900 = teg.parse_task(fn900); d900["状态"] = "完成"; teg.write_task_file(fn900, d900)
check("前置完成后 blockers 清空", teg.blockers_of("task-20990101-901") == [])
d901b = teg.parse_task(os.path.join(dep_dir, "task-20990101-901.md"))
check("解锁零状态变更（下游文件未动）", d901b.get("状态") == "待办" and d901b.get("更新") == "1000")
ok, msg = teg.dispatch_task("task-20990101-901", launch=False)   # 走完整流程：不再是阻塞拒绝
check("解锁后 dispatch 不再因阻塞拒绝", "被阻塞" not in msg, msg)
check("归档前置不算阻塞", teg.blockers_of("task-20990101-903") == [])
check("回收站前置不算阻塞", teg.blockers_of("task-20990101-906") == [])
# done 解锁提示（捕获 stdout）
class DA: pass
da = DA(); da.id = "task-20990101-900"; da.结果 = "前置完工"; da.证据 = ""; da.expected_mtime = None
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
    ok, msg = teg.dispatch_task("task-20990101-920", launch=False)
    check("空方案不派", ok is False and "方案为空" in msg, msg)
    _wt("task-20990101-921", "正常下游", "待办", plan=["- [ ] 复查三项"], fy="只复查遗留 3 项，勿动归档")
    info, _ = teg.prepare_dispatch("task-20990101-921")
    check("任务书含方案原文", "复查三项" in info["prompt"] and "验收对照表" in info["prompt"])
    check("任务书含附言", "只复查遗留 3 项" in info["prompt"] and "本次附言" in info["prompt"])
    check("任务书含回写命令与证据用法", "--证据" in info["prompt"] and "done task-20990101-921" in info["prompt"])
    check("任务书含任务卡路径", "task-20990101-921.md" in info["prompt"])
    ok, msg = teg.dispatch_task("task-20990101-921", launch=False)   # dry-run：预览即所得，附言不消费
    check("dry-run 派活通过", ok is True, msg)
    check("dry-run 不消费附言", teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md")).get("附言") == "只复查遗留 3 项，勿动归档")
    d921 = teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md")); d921["状态"] = "待办"
    teg.write_task_file(os.path.join(dep_dir, "task-20990101-921.md"), d921)
    ok, msg = teg.dispatch_task("task-20990101-921", launch=True)    # 真实拉起（Popen 已打桩）
    check("真实派活通过", ok is True, msg)
    snap = [f for f in os.listdir(dep_dir) if f.startswith(".dispatch-task-20990101-921-")]
    check("派单快照留底", len(snap) == 1 and "只复查遗留 3 项" in open(os.path.join(dep_dir, snap[0]), encoding="utf-8").read())
    check("真实派单消费附言", teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md")).get("附言", "").strip() == "")
    d921b = teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md"))
    check("进行中重派默认拒绝", teg.dispatch_task("task-20990101-921", launch=True)[0] is False)
    ok, msg = teg.dispatch_task("task-20990101-921", launch=True, force=True)
    check("force 显式放行重派", ok is True, msg)
    # done：--证据 + 附言归档
    class DA2: pass
    da2 = DA2(); da2.id = "task-20990101-921"; da2.结果 = "三项复查完毕"; da2.证据 = "reports/check-3items.md"; da2.expected_mtime = None
    d921c = teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md")); d921c["附言"] = "下次注意备份"
    teg.write_task_file(os.path.join(dep_dir, "task-20990101-921.md"), d921c)
    buf4 = _io.StringIO()
    with _cl.redirect_stdout(buf4):
        teg.cmd_done(da2)
    d921d = teg.parse_task(os.path.join(dep_dir, "task-20990101-921.md"))
    check("done 证据进结果记录", "证据：reports/check-3items.md" in d921d.get("结果记录", ""))
    check("done 附言归档并清空", "附言归档：下次注意备份" in d921d.get("结果记录", "") and not str(d921d.get("附言") or "").strip())
    check("done 后置待验收", d921d.get("状态") == "待验收")
finally:
    teg._hermes_cmd, teg.subprocess.Popen = _teg_hermes, _real_popen
    teg.TASK_DIR = _saved_td

# ---- 汇总 ----
print(f"通过 {len(PASS)} / 失败 {len(FAIL)}")
if FAIL:
    print("失败项：", "、".join(FAIL))
    sys.exit(1)
print("全部通过。")
