"""方寸 LLM 链路诊断 — 只读探测，绝不回显密钥。

用法：
    python scripts/diag_llm.py            # 读 %APPDATA%/fangcun-desktop/llm-config.json
    python scripts/diag_llm.py --env      # 读 TEGULA_LLM_* 环境变量

输出：每个候选 endpoint / 鉴权组合的状态码 + 响应体（已脱敏 + 截断）。
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path(os.environ.get("APPDATA", "")) / "fangcun-desktop" / "llm-config.json"
TIMEOUT = 20


def load_config() -> dict:
    if "--env" in sys.argv:
        return {
            "baseUrl": os.environ.get("TEGULA_LLM_BASE_URL", ""),
            "apiKey": os.environ.get("TEGULA_LLM_API_KEY", ""),
            "model": os.environ.get("TEGULA_LLM_MODEL", ""),
        }
    if not CONFIG.exists():
        sys.exit(f"配置文件不存在: {CONFIG}")
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def mask_key(k: str) -> str:
    if not k:
        return "(空)"
    if len(k) <= 8:
        return k[0] + "*" * (len(k) - 2) + k[-1]
    return f"{k[:3]}{'*' * (len(k) - 7)}{k[-4:]} (len={len(k)})"


def probe(name: str, url: str, key: str, *, method: str = "GET",
          body: dict | None = None, auth: str = "bearer") -> None:
    headers = {"Content-Type": "application/json"}
    if auth == "bearer":
        headers["Authorization"] = f"Bearer {key}"
    elif auth == "raw":
        headers["Authorization"] = key
    elif auth == "x-api-key":
        headers["x-api-key"] = key

    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            txt = r.read().decode("utf-8", "replace")
            print(f"[{name}] {r.status} {r.reason}  auth={auth}")
            print("  " + txt.replace(key, "<KEY>")[:700])
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace").replace(key, "<KEY>")
        print(f"[{name}] HTTP {e.code} {e.reason}  auth={auth}")
        print("  " + txt[:700])
    except Exception as e:  # noqa: BLE001
        print(f"[{name}] {type(e).__name__}: {e}  auth={auth}")
    print("-" * 60)


def main() -> int:
    cfg = load_config()
    base = (cfg.get("baseUrl") or "").rstrip("/")
    key = cfg.get("apiKey") or ""
    model = cfg.get("model") or ""

    print(f"baseUrl : {base}")
    print(f"model   : {model}")
    print(f"apiKey  : {mask_key(key)}")
    print("=" * 60)

    if not base:
        sys.exit("baseUrl 为空")

    # 推导根地址（去掉 /v1/chat/completions 之类的尾巴）
    root = base
    for suffix in ("/chat/completions", "/completions"):
        if root.endswith(suffix):
            root = root[: -len(suffix)]
            break
    root = root.rstrip("/")

    # 1) 鉴权是否成立：标准 OpenAI 兼容 /models
    probe("models", f"{root}/models", key)
    # 2) 当前实现实际请求的 endpoint
    probe("chat", base, key, method="POST",
          body={"model": model, "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5})
    # 3) 鉴权头变体（同样 endpoint）
    probe("chat-nobearer", base, key, method="POST", auth="raw",
          body={"model": model, "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5})
    probe("chat-xapikey", base, key, method="POST", auth="x-api-key",
          body={"model": model, "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 5})
    # 4) 根路径探测（排除 baseUrl 多/少一层前缀）
    probe("root-models", f"{root.rsplit('/v1', 1)[0]}/models", key)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
