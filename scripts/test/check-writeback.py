#!/usr/bin/env python3
# check-writeback.py — AI 规划写回层验证（2026-10-12，方案卡：AI 规划功能）
# 用法：python scripts/test/check-writeback.py
# 不碰真实 task-data/notes：TASK_DIR/_NOTES_DIR 指向临时目录；LLM 全程打桩零网络。
import os
import sys
import json
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
tmpdir = tempfile.mkdtemp(prefix="writeback_check_")
_saved = {}
for k in ("TASK_DIR", "_NOTES_DIR", "REGISTRY_PATH", "DECISIONS_PATH"):
    _saved[k] = getattr(core, k, None)
core.TASK_DIR = os.path.join(tmpdir, "task-data")
core._NOTES_DIR = os.path.join(tmpdir, "notes")
core.REGISTRY_PATH = os.path.join(tmpdir, "registry.yaml")
# DECISIONS_PATH 是 import 时冻结的常量——测试改 TASK_DIR 后同步重算（第 10 组喂卡断言用）
core.DECISIONS_PATH = os.path.join(core.TASK_DIR, "decisions.md")
os.makedirs(core.TASK_DIR, exist_ok=True)
with open(core.REGISTRY_PATH, "w", encoding="utf-8") as f:
    f.write("members:\n  - 暮雨\n  - hermes\nprojects:\n  - id: proj-x\n    name: 测试项目\n")

_saved_chat = wb.chat


def mock_chat(payload=None, raise_llm=False, raw=None):
    def _fake(content, *, model=None, temperature=0.3, max_tokens=2048,
             timeout=None, system="", **extra):
        if raise_llm:
            raise LLMError("桩：模拟网络失败")
        return raw if raw is not None else json.dumps(payload, ensure_ascii=False)
    return _fake


try:
    # ---- 1. _extract_json 容错 ----
    check("裸 JSON", wb._extract_json('{"a":1}') == {"a": 1})
    check("围栏 JSON", wb._extract_json('```json\n{"a":1}\n```') == {"a": 1})
    check("无语言围栏", wb._extract_json('```\n{"a":1}\n```') == {"a": 1})
    check("前后带废话", wb._extract_json('好的，结果如下：\n{"a":1}\n以上。') == {"a": 1})
    for bad in ("", "   ", "完全不是 JSON", "[1,2,3]", '"字符串"'):
        try:
            wb._extract_json(bad)
            check(f"垃圾输入应拒绝 ({bad[:8]!r})", False, "未抛 ValueError")
        except ValueError:
            check(f"垃圾输入应拒绝 ({bad[:8]!r})", True)

    # ---- 2. plan_to_draft 成功路径 ----
    payload = {"tasks": [
        {"标题": "修 README 截图", "优先级": "高", "标签": ["文档"],
         "方案": ["跑截图命令", "比对更新"], "验收标准": "README 三图与新 UI 一致"},
        {"标题": "补数据迁移测试", "优先级": "中", "标签": [],
         "方案": ["写迁移用例"], "验收标准": "pytest 全绿"},
    ]}
    wb.chat = mock_chat(payload=payload)
    r = wb.plan_to_draft("本周工程卫生", "proj-x")
    check("拆解返回 ok", r.get("ok") is True, str(r))
    check("拆解建卡两张", r.get("count") == 2, str(r))
    tids = r.get("created", [])
    fn = os.path.join(core.TASK_DIR, tids[0] + ".md")
    d = core.parse_task(fn)
    check("卡状态=待审批（不直接进待办）", d.get("状态") == "待审批", str(d.get("状态")))
    check("卡来源=ai-planning", d.get("来源") == "ai-planning", str(d.get("来源")))
    check("卡验收=human", d.get("验收") == "human", str(d.get("验收")))
    check("卡标签含 ai-draft", "ai-draft" in (d.get("标签") or []), str(d.get("标签")))
    check("验收标准进附言", "验收标准" in str(d.get("附言", "")), str(d.get("附言")))
    check("方案格式化为勾选框", (d.get("方案") or [""])[0].startswith("- [ ] "),
          str(d.get("方案")))
    d2 = core.parse_task(os.path.join(core.TASK_DIR, tids[1] + ".md"))
    check("第二张卡优先级非法值兜底为中", d2.get("优先级") == "中", str(d2.get("优先级")))

    # ---- 3. plan_to_draft LLM 失败：不建卡不落笔记 ----
    os.makedirs(core._NOTES_DIR, exist_ok=True)  # 先保证目录在，之后的"零副作用"比对才成立
    before_tasks = set(os.listdir(core.TASK_DIR))
    before_notes = set(os.listdir(core._NOTES_DIR))
    wb.chat = mock_chat(raise_llm=True)
    r = wb.plan_to_draft("再拆一个", "proj-x")
    check("LLM 失败返回错误", r.get("ok") is False and "LLM 调用失败" in r.get("error", ""), str(r))
    check("LLM 失败零副作用（无新卡无新笔记）",
          set(os.listdir(core.TASK_DIR)) == before_tasks
          and set(os.listdir(core._NOTES_DIR)) == before_notes)

    # ---- 4. plan_to_draft 解析失败：原文兜底落笔记 ----
    wb.chat = mock_chat(raw="模型犯病了，这是一段无法解析的自由发挥……")
    r = wb.plan_to_draft("拆不出来的目标", "proj-x")
    check("解析失败返回错误+笔记id", r.get("ok") is False and "note_id" in r, str(r))
    note_fn = os.path.join(core._NOTES_DIR, r["note_id"] + ".md")
    check("兜底笔记含原文", os.path.exists(note_fn)
          and "无法解析的自由发挥" in open(note_fn, encoding="utf-8").read())

    # ---- 5. plan_to_draft 输入校验 ----
    wb.chat = mock_chat(payload={"tasks": []})
    r = wb.plan_to_draft("   ")
    check("空目标拒绝", r.get("ok") is False, str(r))
    r = wb.plan_to_draft("合法目标但 JSON 无 tasks")
    # tasks 缺失
    wb.chat = mock_chat(raw='{"没有tasks": 1}')
    r = wb.plan_to_draft("合法目标", "proj-x")
    check("缺 tasks 数组拒绝", r.get("ok") is False, str(r))

    # ---- 6. draft_project_brief 成功路径 ----
    brief_payload = {"现状": "v0.3 桌面端，85 测试全绿。", "目标": "单机零依赖的个人项目中枢。",
                     "不做": "云端同步、多人协作。", "欠着什么": "决策卡机制等用户点头。"}
    wb.chat = mock_chat(payload=brief_payload)
    r = wb.draft_project_brief("proj-x")
    check("说明草稿返回 ok", r.get("ok") is True, str(r))
    note_fn = os.path.join(core._NOTES_DIR, r["note_id"] + ".md")
    note_txt = open(note_fn, encoding="utf-8").read()
    check("笔记标题含项目与日期", "proj-x" in note_txt and "项目说明草稿" in note_txt, note_txt[:80])
    check("四栏齐全", all(f"## {c}" in note_txt for c in ("现状", "目标", "不做", "欠着什么")),
          note_txt[:200])
    check("笔记注明方寸侧非权威版", "repo 契约" in note_txt, note_txt[:300])

    # ---- 7. draft_project_brief 缺栏拒绝（不落残品） ----
    notes_before = set(os.listdir(core._NOTES_DIR))
    wb.chat = mock_chat(payload={"现状": "x", "目标": "y", "不做": "z"})  # 缺 欠着什么
    r = wb.draft_project_brief("proj-x")
    check("缺栏拒绝", r.get("ok") is False and "欠着什么" in r.get("error", ""), str(r))
    check("缺栏不落笔记", set(os.listdir(core._NOTES_DIR)) == notes_before)

    # ---- 8. draft_project_brief 输入校验 ----
    r = wb.draft_project_brief("")
    check("无项目拒绝", r.get("ok") is False, str(r))

    # ---- 9. 防重复上下文注入（prompt 应含现有任务标题） ----
    captured = {}

    def spy_chat(content, *, model=None, temperature=0.3, max_tokens=2048,
                 timeout=None, system="", **extra):
        captured["user_msg"] = content
        return json.dumps({"tasks": []}, ensure_ascii=False)

    wb.chat = spy_chat
    wb.plan_to_draft("新目标", "proj-x")
    check("prompt 注入现有任务列表（防重复）",
          "修 README 截图" in captured.get("user_msg", ""), captured.get("user_msg", "")[:150])

    # ---- 10. 决策卡注入（2026-10-16 批次第 6 项机制件）----
    # 夹具：D-001 有效且属 proj-x；D-002 已撤销（必须被滤）；D-003 有效但属 proj-y（全库补齐该进）。
    dec_md = (
        "# 决策记录（决策卡）\n\n"
        "## D-001 断言拍板：司天不发版\n"
        "- 日期: 2026-10-16\n"
        "- 状态: 有效\n"
        "- 项目: proj-x\n"
        "- 出处: 群 10-16\n\n"
        "## D-002 已撤销的旧拍板\n"
        "- 日期: 2026-10-15\n"
        "- 状态: 已撤销\n"
        "- 项目: proj-x\n\n"
        "## D-003 别项目拍板：全局红线\n"
        "- 日期: 2026-10-14\n"
        "- 状态: 有效\n"
        "- 项目: proj-y\n"
    )
    with open(os.path.join(core.TASK_DIR, "decisions.md"), "w", encoding="utf-8") as f:
        f.write(dec_md)

    wb.plan_to_draft("再拆一个目标", "proj-x")
    m = captured.get("user_msg", "")
    check("拆目标 prompt 注入有效决策卡（本项目 D-001 全文）",
          "D-001" in m and "断言拍板：司天不发版" in m, m[-200:])
    check("已撤销卡被滤（D-002 不进 prompt）", "D-002" not in m, m[-200:])
    check("全库有效卡补齐（proj-y 的 D-003 也进）", "D-003" in m, m[-200:])
    check("注入段带「作数」约束头", "不得违背或重复提" in m, m[-200:])

    def spy_brief_chat(content, **kw):
        captured["brief_msg"] = content
        return json.dumps({"现状": "a", "目标": "b", "不做": "c", "欠着什么": "d"}, ensure_ascii=False)

    wb.chat = spy_brief_chat
    wb.draft_project_brief("proj-x")
    bm = captured.get("brief_msg", "")
    check("起草说明 prompt 同样注入决策卡（D-001 进、D-002 滤）",
          "D-001" in bm and "断言拍板：司天不发版" in bm and "D-002" not in bm, bm[-200:])

    # 空决策库（删夹具）→ 喂卡段静默缺席，主链不拦
    os.remove(os.path.join(core.TASK_DIR, "decisions.md"))
    wb.chat = spy_chat
    r = wb.plan_to_draft("空决策库目标", "proj-x")
    check("决策卡文件不存在 → 主链照常跑通（锦上添花不拦路）",
          r.get("ok") is True and "最近拍板" not in captured.get("user_msg", ""), str(r.get("ok")))

finally:
    wb.chat = _saved_chat
    for k, v in _saved.items():
        if v is not None:
            setattr(core, k, v)

print()
print(f"通过 {len(PASS)} / 失败 {len(FAIL)}")
if FAIL:
    print("失败项：", FAIL)
sys.exit(1 if FAIL else 0)
