"""方寸 LLM 调用内核 — 项目规划决策

零依赖设计，仅用 stdlib。
供 tegula CLI 和看板视图调用，不依赖 Hermes。

环境变量：
  TEGULA_LLM_BASE_URL  API 端点（OpenAI 兼容）
  TEGULA_LLM_API_KEY   密钥
  TEGULA_LLM_MODEL     模型名
  TEGULA_LLM_TIMEOUT   超时秒数（默认 60）
"""

from __future__ import annotations

import datetime
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Generator, Optional

__all__ = [
    "chat",
    "stream_chat",
    "trace_path",
    "read_trace",
    "plan_project",
    "LLMError",
    "LLMConfig",
    "get_config",
]


# ---------------------------------------------------------------------------
# 异常
# ---------------------------------------------------------------------------

class LLMError(Exception):
    """统一 LLM 异常，附带 HTTP 状态码和响应体摘要。"""

    def __init__(self, message: str, code: int | None = None, body: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.body = body


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

@dataclass
class LLMConfig:
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout: int = 60

    @classmethod
    def from_env(cls) -> "LLMConfig":
        # 2026-10-12 模型通道去默认化：不预填任何端点/模型（含国外默认），
        # 未配置时由 validate() 报人话错误。桌面端配置走设置页「模型通道」（llm-config.json）。
        return cls(
            base_url=os.environ.get("TEGULA_LLM_BASE_URL", "").rstrip("/"),
            api_key=os.environ.get("TEGULA_LLM_API_KEY", ""),
            model=os.environ.get("TEGULA_LLM_MODEL", ""),
            timeout=int(os.environ.get("TEGULA_LLM_TIMEOUT", "60")),
        )

    def validate(self) -> None:
        if not self.api_key or not self.base_url or not self.model:
            raise LLMError(
                "模型通道未配置。环境变量三件：\n"
                "  set TEGULA_LLM_BASE_URL=https://your-provider.com（OpenAI 兼容端点）\n"
                "  set TEGULA_LLM_API_KEY=sk-xxx\n"
                "  set TEGULA_LLM_MODEL=your-model\n"
                "桌面端用户：设置 → 模型通道 里填（带预设按钮），无需环境变量。"
            )


_config: Optional[LLMConfig] = None


def get_config() -> LLMConfig:
    """获取单例配置（懒加载）。"""
    global _config
    if _config is None:
        _config = LLMConfig.from_env()
    return _config


def reset_config() -> None:
    """重置配置（测试用）。"""
    global _config
    _config = None


# ---------------------------------------------------------------------------
# 底层 HTTP
# ---------------------------------------------------------------------------

def _request(
    url: str,
    payload: dict[str, Any],
    cfg: LLMConfig,
    stream: bool = False,
) -> urllib.request.addinfourl | bytes:
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg.api_key}",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")

    # 允许自签证书（某些本地代理场景）
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    try:
        if stream:
            return urllib.request.urlopen(req, timeout=cfg.timeout, context=ctx)
        else:
            with urllib.request.urlopen(req, timeout=cfg.timeout, context=ctx) as resp:
                return resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise LLMError(
            f"LLM API HTTP {e.code}: {e.reason}",
            code=e.code,
            body=body,
        ) from e
    except urllib.error.URLError as e:
        raise LLMError(f"LLM API 连接失败: {e.reason}") from e
    except TimeoutError:
        raise LLMError(f"LLM API 超时（{cfg.timeout}s）")


# ---------------------------------------------------------------------------
# 公共 API
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# AI 调用链追踪（2026-10-17 用户拍板：四件补立项之一，本件先做——后续
# 文档转任务/分层档案两件 AI 功能的调用都会被它留痕）
#
# 铁律（写代码时不可回退）：
#   1. 只落元数据（时间/触发点/模型/字符数/耗时/成败），**绝不落 prompt
#      与响应正文** —— 留痕文件可能被截图/分享，正文里有用户敏感内容。
#   2. 写失败静默（except 吞掉）——追踪是锦上添花，绝不能打断 AI 主链路。
#   3. 失败的调用也留痕（ok=False + error 摘要），否则排查"模型挂了没"
#      就没有证据面。
# ---------------------------------------------------------------------------

def trace_path() -> str:
    """留痕文件路径。测试/特殊场景可用 TEGULA_AI_TRACE 覆盖。

    ⚠ 留痕必须与任务数据同根（2026-10-17 复核实锤）：首版在这里**另起一套**目录推导
    （本文件旁边有 registry.yaml/task-data 就用它，否则 APPDATA/Fangcun），看着与
    core.DATA_DIR 等价，实际是两份口径——桌面端的写入口走 userData 解析出的数据根，
    CLI 走代码目录，`tegula ai-trace` 于是看不到桌面点按钮产生的调用。
    现统一取 core.DATA_DIR（单一出处），桌面侧 trace.ts 也取同一个根。
    """
    env = os.environ.get("TEGULA_AI_TRACE")
    if env:
        return env
    try:
        from tegula.core import DATA_DIR as _data_dir
        if _data_dir:
            return os.path.join(_data_dir, "ai-trace.jsonl")
    except Exception:
        pass  # core 不可用（独立脚本场景）才退回下面这套推导
    app_dir = os.path.dirname(os.path.abspath(__file__))
    if not (os.path.exists(os.path.join(app_dir, "registry.yaml"))
            or os.path.isdir(os.path.join(app_dir, "task-data"))):
        appdata = os.environ.get("APPDATA", os.path.expanduser("~"))
        app_dir = os.path.join(appdata, "Fangcun")
    return os.path.join(app_dir, "ai-trace.jsonl")


def _prompt_len(content: str | list[dict[str, str]]) -> int:
    """prompt 字符数（只数长度不存内容）。"""
    if isinstance(content, str):
        return len(content)
    try:
        return sum(len(str(m.get("content") or "")) for m in content)
    except Exception:
        return 0


def _trace_call(*, trigger: str, model: str, prompt_chars: int,
                completion_chars: int, duration_ms: int, ok: bool,
                stream: bool, error: str = "") -> None:
    """追加一条调用留痕（JSONL，一行一调）。见上方铁律。"""
    try:
        rec = {
            # ⚠ 2026-10-27 修：原先写的是**本地时间且不带时区标记**，而 TS 侧写的是 UTC，
            #   两端混在同一个 ai-trace.jsonl 里 —— 同一天两条记录能差 8 小时，月报跨月会算错月。
            #   现在统一写 **UTC 且带 +00:00**（与 TS 侧的 Z 等价），两端可比。
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "trigger": str(trigger or "unknown"),
            "model": str(model or ""),
            "prompt_chars": int(prompt_chars),
            "completion_chars": int(completion_chars),
            "duration_ms": int(duration_ms),
            "ok": bool(ok),
            "stream": bool(stream),
        }
        if error:
            rec["error"] = str(error)[:200]
        path = trace_path()
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass  # 铁律 2：追踪永不打断主链路


def read_trace(limit: int = 50, date: str = "", trigger: str = "") -> dict:
    """读取留痕（CLI / MCP 查看口共用）。按 ts 倒序返回最近 limit 条 +
    当日汇总（总次数/成功/失败/字符量/耗时）。零依赖手写解析。"""
    path = trace_path()
    recs: list[dict] = []
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if date and not str(r.get("ts", "")).startswith(date):
                        continue
                    if trigger and r.get("trigger") != trigger:
                        continue
                    recs.append(r)
        except Exception as e:
            return {"records": [], "summary": {}, "error": f"读取失败: {e}"}
    recs.sort(key=lambda r: str(r.get("ts", "")), reverse=True)
    total = len(recs)
    ok_n = sum(1 for r in recs if r.get("ok"))
    summary = {
        "count": total,
        "ok": ok_n,
        "fail": total - ok_n,
        "prompt_chars": sum(int(r.get("prompt_chars") or 0) for r in recs),
        "completion_chars": sum(int(r.get("completion_chars") or 0) for r in recs),
        "duration_ms": sum(int(r.get("duration_ms") or 0) for r in recs),
    }
    return {"records": recs[:limit], "summary": summary, "path": path}


def chat(
    content: str | list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    timeout: int | None = None,
    system: str = "",
    trigger: str = "unknown",
    **extra: Any,
) -> str:
    """非流式调用，返回文本。

    用法：
        chat("分析这个项目的卡点")
        chat([{"role":"user","content":"..."}], system="你是项目管理专家")
        chat("...", trigger="writeback.plan_to_draft")   # 带触发点，进调用链留痕
    """
    cfg = get_config()
    cfg.validate()

    # 统一 messages 格式
    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    if isinstance(content, str):
        messages.append({"role": "user", "content": content})
    else:
        messages = content

    payload: dict[str, Any] = {
        "model": model or cfg.model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        **extra,
    }
    if timeout:
        payload["timeout"] = timeout

    url = f"{cfg.base_url}/chat/completions"
    _t0 = time.monotonic()
    _pchars = _prompt_len(content)
    try:
        raw = _request(url, payload, cfg, stream=False)
        resp = json.loads(raw)
        try:
            out = resp["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as e:
            raise LLMError(f"LLM 响应格式异常: {resp}") from e
        _trace_call(trigger=trigger, model=str(model or cfg.model),
                    prompt_chars=_pchars, completion_chars=len(out or ""),
                    duration_ms=int((time.monotonic() - _t0) * 1000),
                    ok=True, stream=False)
        return out
    except LLMError as e:
        _trace_call(trigger=trigger, model=str(model or cfg.model),
                    prompt_chars=_pchars, completion_chars=0,
                    duration_ms=int((time.monotonic() - _t0) * 1000),
                    ok=False, stream=False, error=str(e))
        raise


def stream_chat(
    content: str | list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    system: str = "",
    trigger: str = "unknown",
    **extra: Any,
) -> Generator[str, None, None]:
    """流式调用，逐个产出文本片段。结束后落一条留痕（stream=True，
    completion_chars=实际产出总长）；请求/迭代失败也落（ok=False）。"""
    cfg = get_config()
    cfg.validate()

    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    if isinstance(content, str):
        messages.append({"role": "user", "content": content})
    else:
        messages = content

    payload: dict[str, Any] = {
        "model": model or cfg.model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
        **extra,
    }

    url = f"{cfg.base_url}/chat/completions"
    _t0 = time.monotonic()
    _pchars = _prompt_len(content)
    _got = 0
    try:
        resp = _request(url, payload, cfg, stream=True)

        for line in resp:
            line_str = line.decode("utf-8").strip()
            if not line_str or not line_str.startswith("data: "):
                continue
            chunk_data = line_str[6:]
            if chunk_data == "[DONE]":
                break
            try:
                chunk = json.loads(chunk_data)
                delta = chunk["choices"][0].get("delta", {})
                piece = delta.get("content", "")
                if piece:
                    _got += len(piece)
                    yield piece
            except (json.JSONDecodeError, KeyError, IndexError):
                continue
        _trace_call(trigger=trigger, model=str(model or cfg.model),
                    prompt_chars=_pchars, completion_chars=_got,
                    duration_ms=int((time.monotonic() - _t0) * 1000),
                    ok=True, stream=True)
    except LLMError as e:
        _trace_call(trigger=trigger, model=str(model or cfg.model),
                    prompt_chars=_pchars, completion_chars=_got,
                    duration_ms=int((time.monotonic() - _t0) * 1000),
                    ok=False, stream=True, error=str(e))
        raise


# ---------------------------------------------------------------------------
# 业务封装：项目规划决策
# ---------------------------------------------------------------------------

PLAN_SYSTEM = """你是方寸项目管理系统的 AI 规划顾问。

你的职责：
1. 分析项目当前状态，识别卡点和风险
2. 给出优先级建议和下一步行动
3. 估算工作量和依赖关系
4. 任务拆解建议

输出风格：
- 简洁结构化，用列表
- 给出明确的"下一步"建议
- 不要废话和客套"""


def plan_project(
    project_summary: str,
    tasks_summary: str = "",
    *,
    model: str | None = None,
) -> str:
    """项目规划决策：输入项目概况，输出规划建议。"""
    user_msg = f"项目概况：\n{project_summary}"
    if tasks_summary:
        user_msg += f"\n\n当前任务：\n{tasks_summary}"
    return chat(user_msg, model=model, system=PLAN_SYSTEM, temperature=0.2)


def analyze_blocker(
    task_description: str,
    context: str = "",
    *,
    model: str | None = None,
) -> str:
    """分析单个卡点，给出解法建议。"""
    user_msg = f"卡点描述：\n{task_description}"
    if context:
        user_msg += f"\n\n上下文：\n{context}"
    return chat(user_msg, model=model, system=PLAN_SYSTEM, temperature=0.1)


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    """CLI 用法：python tegula_llm.py chat "问题" 或 plan "项目概况" """
    if len(argv) < 2:
        print("用法: python tegula_llm.py <chat|plan|stream> <内容> [--model xxx]")
        return 1

    cmd, content, *rest = argv[0], argv[1], argv[2:]
    model = None
    i = 0
    while i < len(rest):
        if rest[i] == "--model" and i + 1 < len(rest):
            model = rest[i + 1]
            break
        i += 1

    try:
        if cmd == "chat":
            print(chat(content, model=model, trigger="cli.chat"))
        elif cmd == "stream":
            for chunk in stream_chat(content, model=model, trigger="cli.stream"):
                print(chunk, end="", flush=True)
            print()
        elif cmd == "plan":
            print(plan_project(content, model=model))
        else:
            print(f"未知命令: {cmd}")
            return 1
    except LLMError as e:
        print(f"错误: {e}", file=__import__("sys").stderr)
        return 1
    return 0


if __name__ == "__main__":
    import sys
    raise SystemExit(main(sys.argv[1:]))
