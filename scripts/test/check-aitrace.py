#!/usr/bin/env python3
# check-aitrace.py — AI 调用链留痕验证（2026-10-17 四件补立项之一）
# 用法：python scripts/test/check-aitrace.py
# LLM 全程打桩零网络；留痕文件指向临时路径，不碰真实 %APPDATA%/Fangcun。
import io
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import tegula_llm as llm  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))


# ---- 测试环境：临时留痕文件 + _request 打桩 ----
tmpdir = tempfile.mkdtemp(prefix="aitrace_check_")
TRACE = os.path.join(tmpdir, "ai-trace.jsonl")
os.environ["TEGULA_AI_TRACE"] = TRACE
os.environ["TEGULA_LLM_BASE_URL"] = "http://stub.local/v1"
os.environ["TEGULA_LLM_API_KEY"] = "stub-key"
os.environ["TEGULA_LLM_MODEL"] = "stub-model"
llm._config = None  # 重置单例，让新环境变量生效

_resp_bytes = []


def _mock_request(url, payload, cfg, stream=False):
    if _RAISE:
        raise llm.LLMError("桩：模拟网络失败")
    if stream:
        return list(_STREAM_LINES)
    return _resp_bytes[0]


_RAISE = False
_STREAM_LINES = []
llm._request = _mock_request


def _read_jsonl(path=TRACE):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(x) for x in f.read().splitlines() if x.strip()]


def _reset_trace():
    if os.path.exists(TRACE):
        os.remove(TRACE)


try:
    # ---- 1. chat 成功 → 落一条元数据留痕 ----
    _reset_trace()
    _resp_bytes.append(json.dumps(
        {"choices": [{"message": {"content": "分析结果：一切正常"}}]}).encode("utf-8"))
    out = llm.chat("帮我分析项目卡点", trigger="test.success")
    check("chat 返回响应文本", out == "分析结果：一切正常", out)
    recs = _read_jsonl()
    check("成功调用落 1 条留痕", len(recs) == 1, str(len(recs)))
    r = recs[0]
    check("trigger 透传", r.get("trigger") == "test.success", str(r.get("trigger")))
    check("model 记录", r.get("model") == "stub-model", str(r.get("model")))
    check("prompt_chars 正确", r.get("prompt_chars") == len("帮我分析项目卡点"), str(r.get("prompt_chars")))
    check("completion_chars 正确", r.get("completion_chars") == len("分析结果：一切正常"), str(r.get("completion_chars")))
    check("ok=True / stream=False", r.get("ok") is True and r.get("stream") is False, str(r))
    check("duration_ms 是非负整数", isinstance(r.get("duration_ms"), int) and r["duration_ms"] >= 0, str(r.get("duration_ms")))

    # ---- 2. 隐私铁律：正文绝不落盘 ----
    raw_file = io.open(TRACE, encoding="utf-8").read()
    check("prompt 正文不落盘", "帮我分析项目卡点" not in raw_file)
    check("响应正文不落盘", "分析结果：一切正常" not in raw_file)

    # ---- 3. 失败调用也留痕 ----
    _reset_trace()
    _RAISE = True
    try:
        llm.chat("这次会失败", trigger="test.fail")
        check("失败应抛 LLMError", False, "未抛")
    except llm.LLMError:
        check("失败抛 LLMError", True)
    _RAISE = False
    recs = _read_jsonl()
    check("失败调用落 1 条留痕", len(recs) == 1, str(len(recs)))
    check("失败 ok=False", recs and recs[0].get("ok") is False, str(recs))
    check("失败带 error 摘要", recs and "模拟网络失败" in str(recs[0].get("error", "")), str(recs))

    # ---- 4. 流式调用留痕 ----
    _reset_trace()
    _STREAM_LINES = [
        b'data: {"choices":[{"delta":{"content":"\xe4\xbd\xa0"}}]}\n\n',   # 你
        b'data: {"choices":[{"delta":{"content":"\xe5\xa5\xbd"}}]}\n\n',   # 好
        b'data: [DONE]\n\n',
    ]
    got = list(llm.stream_chat("流式一下", trigger="test.stream"))
    check("stream_chat 产出片段", "".join(got) == "你好", str(got))
    recs = _read_jsonl()
    check("流式调用落 1 条留痕", len(recs) == 1, str(len(recs)))
    r = recs[0] if recs else {}
    check("流式 stream=True", r.get("stream") is True, str(r))
    check("流式 completion_chars=实际产出", r.get("completion_chars") == 2, str(r.get("completion_chars")))

    # ---- 5. messages 列表形态的 prompt 长度 ----
    _reset_trace()
    msgs = [{"role": "system", "content": "你是助手"},
            {"role": "user", "content": "分析"}]
    llm.chat(msgs, trigger="test.msgs")
    recs = _read_jsonl()
    check("messages 列表 prompt_chars 合计", recs and recs[0].get("prompt_chars") == len("你是助手") + len("分析"), str(recs))

    # ---- 6. 写失败静默：追踪绝不打断主链路 ----
    bad_dir = os.path.join(tmpdir, "no-such-dir", "sub", "ai-trace.jsonl")
    os.environ["TEGULA_AI_TRACE"] = os.path.join(tmpdir, "readonly", "t.jsonl")
    ro_dir = os.path.join(tmpdir, "readonly")
    os.makedirs(ro_dir, exist_ok=True)
    os.chmod(ro_dir, 0o500)  # 只读目录
    try:
        out = llm.chat("主链路不能断", trigger="test.silent")
        check("留痕写失败时 chat 仍正常", out == "分析结果：一切正常", out)
    finally:
        os.chmod(ro_dir, 0o700)
    os.environ["TEGULA_AI_TRACE"] = TRACE

    # ---- 7. read_trace 过滤与汇总 ----
    _reset_trace()
    rows = [
        {"ts": "2026-10-17T09:00:00", "trigger": "writeback.plan_to_draft", "model": "m1",
         "prompt_chars": 100, "completion_chars": 50, "duration_ms": 900, "ok": True, "stream": False},
        {"ts": "2026-10-17T10:00:00", "trigger": "writeback.plan_to_draft", "model": "m1",
         "prompt_chars": 200, "completion_chars": 80, "duration_ms": 1200, "ok": False, "stream": False,
         "error": "超时"},
        {"ts": "2026-10-16T08:00:00", "trigger": "planning.audit", "model": "m2",
         "prompt_chars": 30, "completion_chars": 20, "duration_ms": 300, "ok": True, "stream": True},
    ]
    with open(TRACE, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    data = llm.read_trace(limit=10)
    check("read_trace 全量条数", data["summary"]["count"] == 3, str(data["summary"]))
    check("read_trace 倒序（最新在前）", data["records"][0]["ts"] == "2026-10-17T10:00:00", str(data["records"][0]["ts"]))
    check("read_trace 汇总成功数", data["summary"]["ok"] == 2, str(data["summary"]))
    check("read_trace 汇总失败数", data["summary"]["fail"] == 1, str(data["summary"]))
    check("read_trace 汇总字符量", data["summary"]["prompt_chars"] == 330, str(data["summary"]))
    data = llm.read_trace(date="2026-10-16")
    check("date 过滤", data["summary"]["count"] == 1 and data["records"][0]["trigger"] == "planning.audit", str(data["summary"]))
    data = llm.read_trace(trigger="writeback.plan_to_draft")
    check("trigger 过滤", data["summary"]["count"] == 2, str(data["summary"]))
    data = llm.read_trace(limit=1)
    check("limit 截断", len(data["records"]) == 1 and data["summary"]["count"] == 3, str(len(data["records"])))

    # ---- 8. 调用方 trigger 实标（5 planning + 2 writeback + 2 cli）----
    src_checks = [
        ("tegula_planning.py", 'trigger="planning.audit"'),
        ("tegula_planning.py", 'trigger="planning.decompose_goal"'),
        ("tegula_planning.py", 'trigger="planning.decide_dp"'),
        ("tegula_planning.py", 'trigger="planning.quarterly_review"'),
        ("tegula_planning.py", 'trigger="planning.generate_roadmap"'),
        ("tegula_writeback.py", 'trigger="writeback.plan_to_draft"'),
        ("tegula_writeback.py", 'trigger="writeback.draft_project_brief"'),
        ("tegula_llm.py", 'trigger="cli.chat"'),
        ("tegula_llm.py", 'trigger="cli.stream"'),
    ]
    for fname, needle in src_checks:
        src = io.open(os.path.join(ROOT, fname), encoding="utf-8").read()
        check(f"{fname} 标注 {needle}", needle in src)

    # ---- 9. MCP 工具暴露与调用 ----
    import tegula.core as core  # noqa: E402
    resp = core.mcp_handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    names = sorted(t["name"] for t in resp["result"]["tools"])
    check("MCP tools/list 含 ai_trace", "ai_trace" in names, str(names))
    resp = core.mcp_handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                            "params": {"name": "ai_trace", "arguments": {"limit": 5}}})
    body = json.loads(resp["result"]["content"][0]["text"])
    check("MCP ai_trace 返回 ok+汇总", body.get("ok") is True and body.get("summary", {}).get("count") == 3, str(body)[:200])
    resp = core.mcp_handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                            "params": {"name": "ai_trace", "arguments": {"trigger": "planning.audit"}}})
    body = json.loads(resp["result"]["content"][0]["text"])
    check("MCP ai_trace 过滤生效", body.get("summary", {}).get("count") == 1, str(body)[:200])
    check("MCP ai_trace 不泄露正文键", all(k not in (body.get("records") or [{}])[0]
                                           for k in ("prompt", "content", "messages")), "泄露正文")

except Exception as e:  # noqa: BLE001
    import traceback
    check("测试体异常", False, f"{e!r}\n{traceback.format_exc()[:400]}")

print(f"\n{'=' * 50}\n通过 {len(PASS)} / 失败 {len(FAIL)}")
if FAIL:
    print("失败清单：")
    for name in FAIL:
        print(f"  - {name}")
sys.exit(1 if FAIL else 0)
