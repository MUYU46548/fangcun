# -*- coding: utf-8 -*-
"""tegula_writeback.py — AI 规划写回层（2026-10-12 开工，方案卡：AI 规划功能 2.5 天主体）。

为什么有这个模块：
    tegula_planning.py 的五个规划函数（audit / decompose / decide_dp /
    quarterly / roadmap）全部只返回字符串——输出只在终端闪一下，方寸自身
    不留任何痕。这是「方寸记不住东西」的一半病灶（另一半是拍板无卡片
    承载，由决策卡方案另治）。

    本模块把 LLM 输出结构化落进方寸（任务卡 / 笔记），让
    「AI 起草 → 人在 GUI 确认」变成一条可回溯的链。

设计红线（REV-002 + 2026-10-11 契约页口径）：
    1. 不侵入 tegula_planning.py —— 它的行为零改动，本模块平行存在。
    2. AI 起草的任务卡一律落「待审批」状态，绝不直接进「待办」——
       转正的唯一路径是用户在 GUI 里点头（方寸既有工作流，零新机制）。
    3. 来源字段固定 ai-planning、标签自动加 ai-draft —— 审计可查
       「哪些卡是 AI 起草的」，一条标签过滤就能全部捞出来复核。
    4. 项目说明草稿只落方寸笔记区。立项契约真源在各项目 repo，
       方寸对契约只读 —— 用户点头后由各线 agent 落各 repo 契约。
    5. 失败不丢内容：LLM 返回了但解析不了时，原文兜底落笔记，
       错误信息里带笔记 id，人还能去救。

对外入口（两个，cli.py 已各挂一条子命令）：
    plan_to_draft(goal, project_id, model)    目标拆解 → 待审批任务卡
    draft_project_brief(project_id, model)    四栏项目说明草稿 → 笔记
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date

from tegula import core
from tegula_llm import chat, LLMError

# ---------------------------------------------------------------------------
# 提示词
# ---------------------------------------------------------------------------

PLAN_SYSTEM = """你是项目规划助手。把用户目标拆解为可独立验收的任务卡。

只输出一个 JSON 对象，不要解释文字，不要 markdown 代码围栏。格式：
{"tasks": [
  {"标题": "动宾短语，15字内",
   "优先级": "高" | "中" | "低",
   "标签": ["0-3个，不带#"],
   "方案": ["步骤1", "步骤2"],
   "验收标准": "完成后怎么验证：具体到可观察的结果，如'跑 X 命令输出 Y'"
  }
]}

拆解规则：
- 每张卡独立可验收，不造「什么都沾一点」的巨石卡
- 用户消息里会给出该项目现有任务列表——语义重复的不要生成
- 数量 3-8 张，宁少勿滥；确实只需一两张就只给一两张
- 验收标准必填且可执行，"完成开发"不算验收，"跑通X且输出Y"才算"""

BRIEF_SYSTEM = """你是项目档案员。根据项目现状起草一份项目说明草稿。

只输出一个 JSON 对象，不要解释文字，不要 markdown 代码围栏。格式：
{"现状": "2-4句白话：这个项目现在是什么形态、最近在动什么",
 "目标": "2-4句白话：终态长什么样、给谁用",
 "不做": "明确的边界：哪些事这个项目永远不碰",
 "欠着什么": "已知的未决事项：等谁点头、缺什么素材、悬而未决的分歧"
}

规则：
- 只依据用户消息里给出的项目事实，不脑补
- 「不做」宁多勿少——边界写清楚比写少值钱
- 语气：平实陈述，不用感叹号"""

# ---------------------------------------------------------------------------
# JSON 提取容错
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)


def _extract_json(text: str) -> dict:
    """从 LLM 输出里抠出 JSON 对象。

    为什么要容错（2026-10 实测教训）：即使 system 里写了「不要围栏」，
    模型仍有一定概率输出 ```json 围栏或前后缀说明文字。直接
    json.loads 全文会炸，所以按「围栏优先、大括号区间兜底」两级抠。

    抠不出来抛 ValueError，由调用方决定兜底动作（落笔记）。
    """
    if not text or not text.strip():
        raise ValueError("LLM 返回空内容")
    m = _FENCE_RE.search(text)
    candidate = m.group(1).strip() if m else text.strip()
    # 大括号区间兜底：丢掉前后缀的说明文字
    if not candidate.startswith("{"):
        i, j = candidate.find("{"), candidate.rfind("}")
        if i < 0 or j <= i:
            raise ValueError("输出里找不到 JSON 对象")
        candidate = candidate[i:j + 1]
    try:
        obj = json.loads(candidate)
    except json.JSONDecodeError as e:
        raise ValueError(f"JSON 解析失败: {e}") from e
    if not isinstance(obj, dict):
        raise ValueError("JSON 顶层不是对象")
    return obj


# ---------------------------------------------------------------------------
# 上下文组装
# ---------------------------------------------------------------------------

def _existing_titles(project_id: str) -> list[str]:
    """该项目现有任务标题列表（防 AI 生成重复卡）。

    load_tasks 出错一律返回空列表：上下文是「锦上添花」，
    不能因为它挂了把整个写回拦死。
    """
    if not project_id:
        return []
    try:
        return [t.get("标题", "") for t in core.load_tasks(project_id, "active") if t.get("标题")]
    except Exception:
        return []


def _project_digest(project_id: str) -> str:
    """项目现状摘要（说明草稿的上下文）：任务统计 + 标题列表。

    只用任务侧公开信息；repo 里的代码方寸不读（红线：方寸只管账，不管码）。
    """
    try:
        tasks = core.load_tasks(project_id, "active")
    except Exception:
        tasks = []
    if not tasks:
        return "（该项目当前没有在途任务）"
    by_status: dict[str, int] = {}
    for t in tasks:
        st = t.get("状态") or "未知"
        by_status[st] = by_status.get(st, 0) + 1
    stat = "，".join(f"{k}×{v}" for k, v in sorted(by_status.items()))
    titles = "\n".join(f"- [{t.get('状态', '')}] {t.get('标题', '')}" for t in tasks[:40])
    return f"在途任务统计：{stat}\n{titles}"


# ---------------------------------------------------------------------------
# 入口 1：目标拆解 → 待审批任务卡
# ---------------------------------------------------------------------------

def plan_to_draft(goal: str, project_id: str = "", model: str | None = None) -> dict:
    """把一个目标拆解成待审批任务卡。

    返回（机器可读，CLI 层负责翻译成人话）：
        {"ok": True, "created": [tid, ...], "count": n}
        {"ok": False, "error": "……", "note_id": "note-…"}   # note_id 仅解析失败兜底时存在
    """
    goal = (goal or "").strip()
    if not goal:
        return {"ok": False, "error": "目标为空"}

    parts = [f"目标：{goal}", f"项目：{project_id or '未指定'}"]
    existing = _existing_titles(project_id)
    if existing:
        parts.append("现有任务（避免重复）：\n" + "\n".join(existing[:60]))
    user_msg = "\n".join(parts)

    try:
        raw = chat(user_msg, model=model, system=PLAN_SYSTEM,
                   temperature=0.2, max_tokens=3000)
    except LLMError as e:
        return {"ok": False, "error": f"LLM 调用失败：{e}"}

    try:
        obj = _extract_json(raw)
    except ValueError as e:
        # 红线 5：解析失败不丢内容，原文兜底落笔记
        note_title = f"AI 拆解失败存档 {date.today().isoformat()}"
        ok_note, note_id_or_err = core.api_note_create(note_title, raw)
        err = f"{e}"
        if ok_note:
            err += f"（原文已存笔记 {note_id_or_err}，可人工救回）"
        return {"ok": False, "error": err,
                **({"note_id": note_id_or_err} if ok_note else {})}

    tasks = obj.get("tasks")
    if not isinstance(tasks, list):
        return {"ok": False, "error": "JSON 里没有 tasks 数组"}

    created: list[str] = []
    skipped: list[str] = []
    for t in tasks:
        if not isinstance(t, dict):
            continue
        title = str(t.get("标题", "")).strip()
        if not title:
            skipped.append("(无标题项)")
            continue
        prio = t.get("优先级", "中")
        if prio not in ("高", "中", "低"):
            prio = "中"
        tags = [str(x).strip().lstrip("#") for x in
                (t.get("标签") or []) if str(x).strip()]
        tags.append("ai-draft")  # 审计标签：一条过滤捞出全部 AI 起草卡
        steps = [s for s in (t.get("方案") or []) if str(s).strip()]
        plan_lines = [f"- [ ] {str(s).strip()}" for s in steps] or ["- [ ] "]
        accept = str(t.get("验收标准", "")).strip()
        # 验收标准进附言：卡面上可见（「AI 起草（验收标准）：……」），
        # 且派活时随任务书下发给执行方——哨兵 2026-10-11 建议「任务卡必带
        # 怎么确认修好了」，落点在此。
        ps = f"AI 起草（验收标准）：{accept}" if accept else "AI 起草，验收标准缺失待补"
        fields = {
            "标题": title,
            "状态": "待审批",          # 红线 2：转正只能靠用户 GUI 点头
            "来源": "ai-planning",      # 红线 3：审计可查
            "指派": "hermes",
            "验收": "human",
            "优先级": prio,
            "标签": tags,
            "方案": plan_lines,
            "附言": ps,
        }
        if project_id:
            fields["项目"] = [project_id]
        ok, tid_or_err = core.api_new(fields)
        if ok:
            created.append(tid_or_err)
        else:
            skipped.append(f"{title}: {tid_or_err}")

    result: dict = {"ok": True, "created": created, "count": len(created)}
    if skipped:
        result["skipped"] = skipped
    return result


# ---------------------------------------------------------------------------
# 入口 2：四栏项目说明草稿 → 笔记
# ---------------------------------------------------------------------------

_BRIEF_COLS = ("现状", "目标", "不做", "欠着什么")


def draft_project_brief(project_id: str, model: str | None = None) -> dict:
    """起草四栏项目说明，落方寸笔记。

    红线 4：说明只是方寸笔记区的一份草稿。立项契约真源在各项目
    repo —— 用户点头后由各线 agent 把定稿落进各自 repo 的契约页，
    方寸侧永远不写契约文件。
    """
    project_id = (project_id or "").strip()
    if not project_id:
        return {"ok": False, "error": "未指定项目"}

    user_msg = f"项目：{project_id}\n\n{_project_digest(project_id)}"
    try:
        raw = chat(user_msg, model=model, system=BRIEF_SYSTEM,
                   temperature=0.3, max_tokens=1500)
    except LLMError as e:
        return {"ok": False, "error": f"LLM 调用失败：{e}"}

    try:
        obj = _extract_json(raw)
    except ValueError as e:
        # 同红线 5：原文落笔记防丢
        note_title = f"{project_id} 说明草稿（解析失败存档） {date.today().isoformat()}"
        ok_note, note_id_or_err = core.api_note_create(note_title, raw)
        err = f"{e}"
        if ok_note:
            err += f"（原文已存笔记 {note_id_or_err}）"
        return {"ok": False, "error": err,
                **({"note_id": note_id_or_err} if ok_note else {})}

    missing = [c for c in _BRIEF_COLS if not str(obj.get(c, "")).strip()]
    # 四栏缺任何一栏都算残品——宁可打回重试，不落一份缺栏说明当「档案」
    if missing:
        return {"ok": False, "error": f"输出缺栏：{'、'.join(missing)}（原文未落盘，可重试）"}

    lines = [f"# {project_id} 项目说明草稿（AI 起草 {date.today().isoformat()}）", ""]
    lines.append("> 起草说明：AI 依据任务侧信息生成，仅供过目；"
                 "定稿由你拍板后落各项目 repo 契约页，方寸侧不存权威版。")
    lines.append("")
    for col in _BRIEF_COLS:
        lines.append(f"## {col}")
        lines.append(str(obj[col]).strip())
        lines.append("")
    ok_note, note_id_or_err = core.api_note_create(
        f"{project_id} 项目说明草稿 {date.today().isoformat()}",
        "\n".join(lines).strip(),
    )
    if not ok_note:
        return {"ok": False, "error": f"笔记写入失败：{note_id_or_err}"}
    return {"ok": True, "note_id": note_id_or_err}


# ---------------------------------------------------------------------------
# 薄 CLI（python tegula_writeback.py …；正式入口在 tegula/cli.py 的子命令）
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in ("plan", "brief"):
        print("用法: tegula_writeback.py plan <目标> [--project 项目ID] [--model 模型]\n"
              "      tegula_writeback.py brief --project 项目ID [--model 模型]")
        return 2
    cmd = argv.pop(0)
    project, model = "", None
    args = list(argv)
    while args:
        a = args.pop(0)
        if a in ("--project", "-p") and args:
            project = args.pop(0)
        elif a in ("--model", "-m") and args:
            model = args.pop(0)
    if cmd == "plan":
        goal = " ".join(a for a in argv if not a.startswith("-"))
        if not goal:
            print("缺目标")
            return 2
        r = plan_to_draft(goal, project, model)
    else:
        if not project:
            print("brief 需要 --project")
            return 2
        r = draft_project_brief(project, model)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
