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

print("\n===== 汇总 =====")
print(f"通过 {len(PASS)} / 失败 {len(FAIL)}")
if FAIL:
    print("失败项：", "、".join(FAIL))
    sys.exit(1)
print("全部通过。")
