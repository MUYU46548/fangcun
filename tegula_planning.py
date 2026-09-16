"""方寸 LLM 规划决策层 — 业务逻辑

提供 5 个核心能力：
  audit_project   — 项目健康度审计
  decompose_goal  — 智能任务拆解
  decide_dp       — 决策支持
  quarterly_review— 季度复盘
  generate_roadmap— 路线图生成

设计约束：
  - 所有 LLM 调用走 tegula_llm.py（本模块不直接发 HTTP）
  - 输出结构化（Markdown 模板，非自由文本）
  - 先输出建议、确认后才写入（本模块只读不调 API 写入）
  - 密钥安全：API_KEY 仅存环境变量，不在任何输出/日志中出现
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from typing import Any, Optional

from tegula_llm import chat as _llm_chat, LLMError
from tegula.core import (
    ROOT, TASK_DIR, REGISTRY_PATH,
    load_all_projects, load_tasks, parse_task,
    read_activity, aggregate_roadmap, _now_ts,
    locate_task, api_plan_get, parse_registry,
)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

AUDIT_SYSTEM = """你是方寸项目管理系统 AI 顾问。你正在执行「项目健康度审计」。

你的职责：
1. 根据提供的任务数据，将任务归入四个类别：已交付且有效 / 已交付但表现不佳 / 已取消或延迟 / 计划外新增
2. 识别卡点和资源浪费
3. 给出明确的废弃或整改建议

输出要求：
- 严格按 Markdown 模板输出（### 四分类 / ### 关键指标 / ### 废弃建议 / ### 整改建议）
- 不输出寒暄或客套
- 每条建议必须对应具体任务 ID"""

DECOMPOSE_SYSTEM = """你是方寸项目管理系统 AI 顾问。你正在执行「智能任务拆解」。

你的职责：
1. 将用户输入的目标拆解为层级化任务（P0/P1/P2/P3）
2. 明确依赖关系和前置条件
3. 给出合理的工时预估（人天）
4. 建议执行顺序（拓扑排序后的结果）

输出要求：
- 严格按 Markdown 模板输出（## P0 必须有 / ## P1 应该有 / ## P2 可以有 / ## P3 不会有 / ## 依赖关系 / ## 建议执行顺序 / ## 工时汇总）
- 每项任务带简短标题和一句描述
- 工时估单人天，范围 0.5-5"""

DECIDE_SYSTEM = """你是方寸项目管理系统 AI 顾问。你正在执行「决策支持」。

你的职责：
1. 基于提供的决策点上下文（选项、项目现状、历史决策），给出推荐选项
2. 分析每个选项的利弊
3. 识别关键风险
4. 给出具体的下一步行动

输出要求：
- 严格按 Markdown 模板输出（### 推荐选项 / ### 选项分析 / ### 关键风险 / ### 下一步行动）
- 推荐必须基于数据，不能模糊
- 如果信息不足以判断，明确指出需要补充什么"""

REVIEW_SYSTEM = """你是方寸项目管理系统 AI 顾问。你正在执行「季度复盘」。

你的职责：
1. 回顾上季度的任务交付情况（交付率、卡点、超支原因）
2. 识别计划外工作及其影响
3. 评估技术债务积累
4. 给出下季度建议和优先级

输出要求：
- 严格按 Markdown 模板输出（## 上季度回顾 / ## 功能废弃建议 / ## 技术债务评估 / ## 下季度建议）
- 所有数据引用必须标注来源任务 ID
- 下季度建议必须带优先级标签（P0/P1/P2）"""

ROADMAP_SYSTEM = """你是方寸项目管理系统 AI 顾问。你正在执行「路线图生成」。

你的职责：
1. 基于当前路线图、未完成任务、决策点，生成未来 3 个季度的路线图
2. 明确里程碑、依赖关系和风险
3. 给出资源分配建议

输出要求：
- 严格按 Markdown 模板输出（## Q+1 / ## Q+2 / ## Q+3 / ## 关键风险 / ## 资源分配建议）
- 每季度列出 1-3 个里程碑，每个里程碑带预期产出和依赖
- 风险按发生概率 x 影响程度排序"""


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------

def _safe_project_summary(project_id: str) -> dict:
    """安全地收集项目数据（供 prompt 使用）。"""
    projects = load_all_projects()
    proj_meta = None
    for p in projects:
        if p.get("id") == project_id:
            proj_meta = p
            break
    
    if proj_meta is None:
        return {"error": f"项目 {project_id} 不存在"}
    
    tasks = load_tasks(project=project_id, view="active")
    if not tasks:
        tasks = []
    
    # 计算时间范围
    now = datetime.now()
    q_ago = now - timedelta(days=90)
    
    # 统计
    status_counts: dict[str, int] = {}
    recent_activity = []
    for t in tasks:
        s = t.get("状态", "未知")
        status_counts[s] = status_counts.get(s, 0) + 1
        
        # 90 天内更新过的
        mtime = t.get("mtime", 0)
        if mtime:
            try:
                ts = datetime.fromtimestamp(mtime)
                if ts > q_ago:
                    recent_activity.append(t)
            except (ValueError, OSError):
                pass
    
    return {
        "project": proj_meta,
        "tasks": tasks,
        "total": len(tasks),
        "status_counts": status_counts,
        "recent_count": len(recent_activity),
        "now": now.strftime("%Y-%m-%d %H:%M"),
    }


def _format_tasks_for_audit(tasks: list[dict]) -> str:
    """将任务列表格式化为 LLM 可读的摘要。"""
    lines = []
    for t in tasks:
        tid = t.get("id", "?")
        title = t.get("标题", "")
        status = t.get("状态", "")
        plan = "有" if t.get("方案") else "无"
        result = "有" if t.get("结果记录") else "无"
        updated = t.get("更新", "")
        batch = t.get("批次", "")
        priority = t.get("优先级", "中")
        blockers = ", ".join(t.get("阻塞", [])) or "无"
        
        lines.append(
            f"- [{tid}] {title}\n"
            f"  状态={status} 优先级={priority} 批次={batch}\n"
            f"  方案={plan} 结果记录={result} 阻塞={blockers}\n"
            f"  最近更新={updated}"
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 1. 项目健康度审计
# ---------------------------------------------------------------------------

def audit_project(project_id: str, model: str | None = None) -> str:
    """审计项目，将任务归入四分类。"""
    data = _safe_project_summary(project_id)
    if "error" in data:
        return f"错误：{data['error']}"
    
    proj = data["project"]
    tasks = data["tasks"]
    
    user_msg = f"""项目 ID：{project_id}
项目名称：{proj.get('name', project_id)}
项目描述：{proj.get('desc', '无')}
注册时间：{proj.get('registered_at', '未知')}
状态统计：{data['status_counts']}
近 90 天更新任务数：{data['recent_count']}

任务详情：
{_format_tasks_for_audit(tasks)}"""
    
    try:
        return _llm_chat(
            user_msg,
            model=model,
            system=AUDIT_SYSTEM,
            temperature=0.15,
            max_tokens=3000,
        )
    except LLMError as e:
        return f"LLM 调用失败：{e}\n（TEGULA_LLM_API_KEY 可能未设置或已过期）"


# ---------------------------------------------------------------------------
# 2. 智能任务拆解
# ---------------------------------------------------------------------------

def decompose_goal(goal: str, project_id: str = "", model: str | None = None) -> str:
    """将目标拆解为层级化任务。"""
    context = ""
    if project_id:
        data = _safe_project_summary(project_id)
        if "error" not in data:
            existing = _format_tasks_for_audit(data["tasks"])
            context = f"\n\n当前项目任务（避免重复）：\n{existing}"
    
    user_msg = f"""目标：{goal}
项目：{project_id or "未指定"}{context}"""
    
    try:
        return _llm_chat(
            user_msg,
            model=model,
            system=DECOMPOSE_SYSTEM,
            temperature=0.25,
            max_tokens=3500,
        )
    except LLMError as e:
        return f"LLM 调用失败：{e}"


# ---------------------------------------------------------------------------
# 3. 决策支持
# ---------------------------------------------------------------------------

def decide_dp(dp_id: str, tid: str = "", model: str | None = None) -> str:
    """分析决策点并给出推荐。"""
    # 优先从 tid 里找决策点
    dp_data = None
    plan_title = ""
    project_context = ""
    
    if tid:
        plan = api_plan_get(tid)
        if plan:
            plan_title = plan.get("标题", tid)
            decisions = plan.get("plan", {}).get("decisions", [])
            for dp in decisions:
                if dp.get("id") == dp_id:
                    dp_data = dp
                    # 提取项目上下文
                    plan_tasks = load_tasks(view="active")
                    # 简单上下文：决策点所在规划的任务
                    project_context = f"规划标题：{plan_title}\n规划 ID：{tid}"
                    break
    
    if dp_data is None:
        # 尝试在所有规划里搜索
        all_tasks = load_tasks(view="active")
        for t in all_tasks:
            if t.get("type") == "plan":
                plan_raw = t.get("plan", {})
                if isinstance(plan_raw, dict):
                    for dp in plan_raw.get("decisions", []):
                        if dp.get("id") == dp_id:
                            dp_data = dp
                            plan_title = t.get("标题", "")
                            project_context = f"规划标题：{plan_title}\n规划 ID：{t.get('id', '')}"
                            break
            if dp_data:
                break
    
    if dp_data is None:
        return f"错误：未找到决策点 {dp_id}（请确认 dp_id 和 tid 正确）"
    
    user_msg = f"""决策点 ID：{dp_id}
问题：{dp_data.get('question', '')}
选项：{' / '.join(dp_data.get('options', []))}
当前状态：{dp_data.get('status', 'pending')}
已选：{dp_data.get('chosen', '无')}
决策时间：{dp_data.get('decided_at', '未决策')}

上下文：
{project_context}"""
    
    try:
        return _llm_chat(
            user_msg,
            model=model,
            system=DECIDE_SYSTEM,
            temperature=0.1,
            max_tokens=2500,
        )
    except LLMError as e:
        return f"LLM 调用失败：{e}"


# ---------------------------------------------------------------------------
# 4. 季度复盘
# ---------------------------------------------------------------------------

def quarterly_review(project_id: str = "", model: str | None = None) -> str:
    """季度复盘：回顾上季度、规划下季度。"""
    now = datetime.now()
    q_ago = now - timedelta(days=90)
    
    # 收集所有项目或指定项目
    if project_id:
        projects = [project_id]
    else:
        all_projs = load_all_projects()
        projects = [p["id"] for p in all_projs if p.get("status") != "released"]
    
    # 收集所有任务
    all_tasks = load_tasks(view="active")
    
    # 按项目分组
    proj_summaries = []
    for pid in projects:
        proj_tasks = [t for t in all_tasks if pid in (t.get("项目") or [])]
        if not proj_tasks:
            continue
        
        # 上季度交付的任务
        delivered = []
        for t in proj_tasks:
            if t.get("状态") == "完成":
                mtime = t.get("mtime", 0)
                if mtime:
                    try:
                        ts = datetime.fromtimestamp(mtime)
                        if ts > q_ago:
                            delivered.append(t)
                    except (ValueError, OSError):
                        pass
        
        # 卡住的任务
        stuck = [t for t in proj_tasks if t.get("状态") in ("进行中", "待办")]
        
        # 计划外任务（无批次或批次为"临时"）
        unplanned = [t for t in proj_tasks if not t.get("批次") or t.get("批次") == "临时"]
        
        proj_summaries.append({
            "id": pid,
            "total": len(proj_tasks),
            "delivered": len(delivered),
            "stuck": len(stuck),
            "unplanned": len(unplanned),
            "stuck_tasks": ["[" + t.get('id', '') + "] " + t.get('标题', '') for t in stuck[:5]],
            "unplanned_tasks": ["[" + t.get('id', '') + "] " + t.get('标题', '') for t in unplanned[:5]],
        })
    
    # 活动日志摘要
    activity = read_activity(limit=50)
    activity_summary = []
    for a in activity[:20]:
        activity_summary.append(f"- {a.get('ts', '')} {a.get('kind', '')} {a.get('id', '')} {a.get('detail', '')[:60]}")
    
    user_msg = f"""当前日期：{now.strftime('%Y-%m-%d')}
复盘区间：{q_ago.strftime('%Y-%m-%d')} ~ {now.strftime('%Y-%m-%d')}

项目概览：
"""
    for ps in proj_summaries:
        user_msg += f"""
### {ps['id']}
- 总任务：{ps['total']}
- 上季度交付：{ps['delivered']}
- 卡住中：{ps['stuck']}（{', '.join(ps['stuck_tasks'][:3])}）
- 计划外：{ps['unplanned']}（{', '.join(ps['unplanned_tasks'][:3])}）
"""
    
    user_msg += f"""
最近活动日志（前 20 条）：
{chr(10).join(activity_summary)}"""
    
    try:
        return _llm_chat(
            user_msg,
            model=model,
            system=REVIEW_SYSTEM,
            temperature=0.2,
            max_tokens=4000,
        )
    except LLMError as e:
        return f"LLM 调用失败：{e}"


# ---------------------------------------------------------------------------
# 5. 路线图生成
# ---------------------------------------------------------------------------

def generate_roadmap(project_id: str = "", goal: str = "", model: str | None = None) -> str:
    """生成未来 3 个季度的路线图。"""
    # 获取当前路线图
    roadmap = aggregate_roadmap(project_id if project_id else None)
    
    # 获取未完成的决策点
    pending_decisions = []
    all_tasks = load_tasks(view="active")
    for t in all_tasks:
        if t.get("type") == "plan":
            plan_raw = t.get("plan", {})
            if isinstance(plan_raw, dict):
                for dp in plan_raw.get("decisions", []):
                    if dp.get("status") == "pending":
                        pending_decisions.append({
                            "id": dp.get("id"),
                            "question": dp.get("question", ""),
                            "plan_title": t.get("标题", ""),
                        })
    
    # 获取项目元数据
    if project_id:
        projects = load_all_projects()
        proj_meta = None
        for p in projects:
            if p.get("id") == project_id:
                proj_meta = p
                break
        proj_name = proj_meta.get("name", project_id) if proj_meta else project_id
    else:
        proj_name = "全部项目"
    
    # 格式化路线图
    roadmap_text = ""
    for proj in roadmap.get("projects", []):
        roadmap_text += f"\n## {proj.get('name', proj.get('id'))}\n"
        for batch in proj.get("batches", []):
            roadmap_text += f"### 批次：{batch.get('name')}（{batch.get('done')}/{batch.get('total')} 完成）\n"
            for t in batch.get("tasks", []):
                roadmap_text += f"- [{t.get('status')}] {t.get('title')}\n"
    
    # 格式化决策点
    dp_text = ""
    for dp in pending_decisions[:10]:
        dp_text += f"- [{dp['id']}] {dp['question']}（来自：{dp['plan_title']}）\n"
    
    user_msg = f"""目标项目：{proj_name}
用户目标：{goal or "无额外目标，基于当前路线图延展"}

当前路线图：
{roadmap_text or "（无活跃任务）"}

待决策点：
{dp_text or "（无待决策项）"}"""
    
    try:
        return _llm_chat(
            user_msg,
            model=model,
            system=ROADMAP_SYSTEM,
            temperature=0.25,
            max_tokens=4000,
        )
    except LLMError as e:
        return f"LLM 调用失败：{e}"


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------

def main() -> None:
    """测试入口。"""
    print("tegula_planning — 方寸 LLM 规划决策层")
    print("通过 tegula audit / tegula decompose / tegula decide / tegula review / tegula roadmap 调用")
    print("不要直接运行本模块")


if __name__ == "__main__":
    main()
