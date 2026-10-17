#!/usr/bin/env python3
# check-aidoc.py — 文档一键转任务验证（2026-10-17 四件补立项之二）
# 用法：python scripts/test/check-aidoc.py
# 不碰真实 task-data/notes：TASK_DIR/_NOTES_DIR 指向临时目录；LLM 全程打桩零网络。
import io
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import tegula.core as core  # noqa: E402
import tegula_writeback as wb  # noqa: E402
from tegula_llm import LLMError  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))


# ---- 测试环境：临时数据目录 + LLM 打桩 ----
tmpdir = tempfile.mkdtemp(prefix="aidoc_check_")
_saved = {}
for k in ("TASK_DIR", "_NOTES_DIR", "REGISTRY_PATH", "DECISIONS_PATH"):
    _saved[k] = getattr(core, k, None)
core.TASK_DIR = os.path.join(tmpdir, "task-data")
core._NOTES_DIR = os.path.join(tmpdir, "notes")
core.REGISTRY_PATH = os.path.join(tmpdir, "registry.yaml")
core.DECISIONS_PATH = os.path.join(tmpdir, "decisions.json")
os.makedirs(core.TASK_DIR, exist_ok=True)
os.makedirs(core._NOTES_DIR, exist_ok=True)
with open(core.REGISTRY_PATH, "w", encoding="utf-8") as f:
    f.write("members:\n  - 暮雨\n  - hermes\nprojects:\n  - id: proj-x\n    name: 测试项目\n")

_saved_chat = wb.chat


def mock_chat(payload=None, raise_llm=False, raw=None, capture=None):
    def _fake(content, *, model=None, temperature=0.3, max_tokens=2048,
              timeout=None, system="", **extra):
        if raise_llm:
            raise LLMError("桩：模拟网络失败")
        if capture is not None:
            capture["content"] = content
            capture["system"] = system
            capture.update(extra)
        return raw if raw is not None else json.dumps(payload, ensure_ascii=False)
    return _fake


try:
    DOC = """周会纪要 2026-10-16

一、背景：登录页转化率连续三周下滑，用户反馈验证码收不到。
二、决定：换短信服务商（已拍板，别再提自建网关）。
三、下周要做：
   - 注册页 A/B 两版文案
   - 修复验证码重发按钮 60 秒倒计时不走的问题
四、感想：这次改版大家辛苦了。"""

    # ---- 1. 入参守卫 ----
    r = wb.doc_to_drafts("", "proj-x")
    check("空文档拒绝", r.get("ok") is False and "为空" in r.get("error", ""), str(r))
    r = wb.doc_to_drafts("字" * 60001, "proj-x")
    check("超 60000 字符硬拒（上限保护）", r.get("ok") is False and "过长" in r.get("error", ""), str(r)[:120])

    # ---- 2. 成功路径：拆卡+红线字段 ----
    payload = {"tasks": [
        {"标题": "注册页 A/B 文案各出一版", "说明": "对应周会第三条", "优先级": "高",
         "标签": ["文案"], "方案": ["列卖点", "各写一版"], "验收标准": "两版文案齐且卖点覆盖"},
        {"标题": "修验证码倒计时不走", "优先级": "中", "标签": [],
         "方案": ["复现", "修定时器"], "验收标准": "重发按钮 60 秒递减可见"},
        {"标题": "", "优先级": "高"},                     # 无标题项 → skipped
        {"标题": "非法优先级兜底", "优先级": "紧急"},     # 优先级兜底为中
    ]}
    cap = {}
    wb.chat = mock_chat(payload=payload, capture=cap)
    r = wb.doc_to_drafts(DOC, "proj-x")
    check("拆卡返回 ok", r.get("ok") is True, str(r))
    check("成功建卡三张（无标题项被跳过）", r.get("count") == 3, str(r))
    check("跳过清单报出无标题项", any("无标题" in s for s in r.get("skipped", [])), str(r.get("skipped")))
    tids = r.get("created", [])
    d = core.parse_task(os.path.join(core.TASK_DIR, tids[0] + ".md"))
    check("卡状态=待审批（不直接进待办）", d.get("状态") == "待审批", str(d.get("状态")))
    check("卡来源=ai-doc（与 ai-planning 分开审计）", d.get("来源") == "ai-doc", str(d.get("来源")))
    check("卡验收=human", d.get("验收") == "human", str(d.get("验收")))
    check("卡标签含 ai-draft", "ai-draft" in (d.get("标签") or []), str(d.get("标签")))
    check("说明进附言", "对应周会第三条" in str(d.get("附言", "")), str(d.get("附言")))
    check("验收标准进附言", "验收标准" in str(d.get("附言", "")), str(d.get("附言")))
    check("方案格式化为勾选框", (d.get("方案") or [""])[0].startswith("- [ ] "), str(d.get("方案")))
    check("卡挂到指定项目", d.get("项目") == ["proj-x"], str(d.get("项目")))
    d3 = core.parse_task(os.path.join(core.TASK_DIR, tids[2] + ".md"))
    check("非法优先级兜底为中", d3.get("优先级") == "中", str(d3.get("优先级")))

    # ---- 3. prompt 组装：文档全文在、去重清单在、决策卡红线在、trigger 带了 ----
    check("prompt 带文档全文", "周会纪要" in cap.get("content", ""), "全文丢失")
    check("trigger=writeback.doc_to_drafts", cap.get("trigger") == "writeback.doc_to_drafts", str(cap.get("trigger")))
    check("system 提示上限 20", "20" in cap.get("system", ""), cap.get("system", "")[:120])

    # ---- 4. tasks 非数组 / 空 tasks ----
    wb.chat = mock_chat(raw=json.dumps({"tasks": "不是数组"}, ensure_ascii=False))
    r = wb.doc_to_drafts("内容", "proj-x")
    check("tasks 非数组拒绝", r.get("ok") is False and "tasks" in r.get("error", ""), str(r))
    wb.chat = mock_chat(raw=json.dumps({"tasks": []}, ensure_ascii=False))
    r = wb.doc_to_drafts("内容", "proj-x")
    check("空 tasks 返回 ok 零卡", r.get("ok") is True and r.get("count") == 0, str(r))

    # ---- 5. 解析失败：原文落笔记可救回（红线 5 同款） ----
    before_notes = set(os.listdir(core._NOTES_DIR))
    wb.chat = mock_chat(raw="这是完全不是 JSON 的回复")
    r = wb.doc_to_drafts("内容", "proj-x")
    check("解析失败返回错误", r.get("ok") is False and "JSON" in r.get("error", ""), str(r))
    after_notes = set(os.listdir(core._NOTES_DIR))
    check("解析失败原文落笔记（可人工救回）", len(after_notes) > len(before_notes), str(after_notes - before_notes))

    # ---- 6. LLM 失败：零副作用 ----
    before_tasks = set(os.listdir(core.TASK_DIR))
    wb.chat = mock_chat(raise_llm=True)
    r = wb.doc_to_drafts("内容", "proj-x")
    check("LLM 失败返回错误", r.get("ok") is False and "LLM 调用失败" in r.get("error", ""), str(r))
    check("LLM 失败零建卡", set(os.listdir(core.TASK_DIR)) == before_tasks, "有新卡")
    check("LLM 失败零笔记", set(os.listdir(core._NOTES_DIR)) == after_notes, "有新笔记")

    # ---- 7. max_cards 上限硬截 ----
    big = {"tasks": [{"标题": f"任务{i}"} for i in range(30)]}
    wb.chat = mock_chat(payload=big)
    r = wb.doc_to_drafts("内容", "proj-x", max_cards=20)
    check("模型超发 30 张被硬截为 20", r.get("count") == 20, str(r.get("count")))

    # ---- 8. CLI 层：cmd_ai_doc 读文件路径 ----
    docfile = os.path.join(tmpdir, "doc.md")
    with open(docfile, "w", encoding="utf-8") as f:
        f.write(DOC)
    wb.chat = mock_chat(payload={"tasks": [{"标题": "CLI 路径的卡"}]})
    from tegula import cli as tegcli
    args = type("A", (), {})()
    args.file = docfile
    args.项目 = "proj-x"
    args.model = ""
    args.max = 20
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = tegcli.cmd_ai_doc(args)
    check("CLI ai-doc 退出码 0", rc == 0, f"rc={rc}")
    check("CLI 输出含建卡结果", "已落 1 张" in buf.getvalue(), buf.getvalue()[:200])

except Exception as e:  # noqa: BLE001
    import traceback
    check("测试体异常", False, f"{e!r}\n{traceback.format_exc()[:400]}")
finally:
    wb.chat = _saved_chat
    for k, v in _saved.items():
        setattr(core, k, v)

print(f"\n{'=' * 50}\n通过 {len(PASS)} / 失败 {len(FAIL)}")
if FAIL:
    print("失败清单：")
    for name in FAIL:
        print(f"  - {name}")
sys.exit(1 if FAIL else 0)
