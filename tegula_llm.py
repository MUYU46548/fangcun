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

import json
import os
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Generator, Optional

__all__ = [
    "chat",
    "stream_chat",
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
    model: str = "gpt-4o-mini"
    timeout: int = 60

    @classmethod
    def from_env(cls) -> "LLMConfig":
        return cls(
            base_url=os.environ.get("TEGULA_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
            api_key=os.environ.get("TEGULA_LLM_API_KEY", ""),
            model=os.environ.get("TEGULA_LLM_MODEL", "gpt-4o-mini"),
            timeout=int(os.environ.get("TEGULA_LLM_TIMEOUT", "60")),
        )

    def validate(self) -> None:
        if not self.api_key:
            raise LLMError(
                "TEGULA_LLM_API_KEY 未设置，无法调用 LLM。\n"
                "  set TEGULA_LLM_API_KEY=sk-xxx\n"
                "  或 set TEGULA_LLM_BASE_URL=https://your-provider.com/v1"
            )
        if not self.base_url:
            raise LLMError("TEGULA_LLM_BASE_URL 不能为空")


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

def chat(
    content: str | list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    timeout: int | None = None,
    system: str = "",
    **extra: Any,
) -> str:
    """非流式调用，返回文本。

    用法：
        chat("分析这个项目的卡点")
        chat([{"role":"user","content":"..."}], system="你是项目管理专家")
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
    raw = _request(url, payload, cfg, stream=False)
    resp = json.loads(raw)

    try:
        return resp["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as e:
        raise LLMError(f"LLM 响应格式异常: {resp}") from e


def stream_chat(
    content: str | list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    system: str = "",
    **extra: Any,
) -> Generator[str, None, None]:
    """流式调用，逐个产出文本片段。"""
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
    resp = _request(url, payload, cfg, stream=True)

    for line in resp:
        line_str = line.decode("utf-8").strip()
        if not line_str or not line_str.startswith("data: "):
            continue
        chunk_data = line_str[6:]
        if chunk_data == "[DONE]":
            return
        try:
            chunk = json.loads(chunk_data)
            delta = chunk["choices"][0].get("delta", {})
            piece = delta.get("content", "")
            if piece:
                yield piece
        except (json.JSONDecodeError, KeyError, IndexError):
            continue


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
            print(chat(content, model=model))
        elif cmd == "stream":
            for chunk in stream_chat(content, model=model):
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
