# -*- coding: utf-8 -*-
"""方寸 Python 侧许可协议总闸自检（2026-11-18）。

判据在 `tegula_llm.py`：未确认不许联网、数据根读同一份 config/license_ack.json、
版本/正文指纹变化即失效、测试旁路如实标 bypass。
另外比对 Python 常量与桌面端 `desktop/src/shared/license.ts`（改文案忘同步 → 红）。

用法：python scripts/test/check-license-gate.py
"""
import io
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import tegula_llm as t  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print("  [%s] %s%s" % ("PASS" if cond else "FAIL", name,
                           ("  → " + str(detail)[:240]) if detail else ""))


def main():
    tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="fc-lic-py_")))
    (tmp / "config").mkdir(parents=True)
    old_root = os.environ.get("FANGCUN_DATA_DIR")
    old_bypass = os.environ.get(t.ENV_BYPASS)
    os.environ["FANGCUN_DATA_DIR"] = str(tmp)
    os.environ.pop(t.ENV_BYPASS, None)
    try:
        print("\n【P1】未确认：state 为 false，assert_licensed 抛错")
        st = t.license_state()
        check("acked=false", st["acked"] is False, st)
        check("root 指向临时数据根", st.get("root") == str(tmp), st.get("root"))
        raised = ""
        code = None
        try:
            t.assert_licensed("调用模型")
        except t.LLMError as e:                    # noqa: BLE001
            raised = str(e)
            code = getattr(e, "code", None)
        check("抛 LLMError", bool(raised), raised)
        check("拒文指向桌面端 + 同意", "桌面端" in raised and "同意" in raised, raised)
        check("错误码 403", code == 403, code)

        print("\n【P2】签字：读同一份 config/license_ack.json")
        ack = {
            "product": "方寸", "version": t.LICENSE_VERSION, "sha": t.LICENSE_CONTENT_SHA,
            "at": "2026-11-18T21:00:00+08:00", "source": "gui",
        }
        (tmp / "config" / "license_ack.json").write_text(
            json.dumps(ack, ensure_ascii=False), encoding="utf-8")
        st = t.license_state()
        check("acked=true", st["acked"] is True, st)
        check("非 bypass", st["bypass"] is False, st)
        check("assert_licensed 不抛", _not_raises(t.assert_licensed))

        print("\n【P3】条款改版：旧记录失效")
        ack["version"] = "0.9"
        (tmp / "config" / "license_ack.json").write_text(
            json.dumps(ack, ensure_ascii=False), encoding="utf-8")
        st = t.license_state()
        check("旧版本 → acked=false", st["acked"] is False, st)
        check("旧版本 → stale=true", st["stale"] is True, st)
        ack["version"] = t.LICENSE_VERSION
        ack["sha"] = "000000000000"
        (tmp / "config" / "license_ack.json").write_text(
            json.dumps(ack, ensure_ascii=False), encoding="utf-8")
        check("指纹不符 → acked=false", t.license_state()["acked"] is False)

        print("\n【P4】测试旁路：只认 =1，且如实标 bypass")
        (tmp / "config" / "license_ack.json").unlink(missing_ok=True)
        os.environ[t.ENV_BYPASS] = "0"
        check("=0 不生效", t.license_state()["acked"] is False)
        os.environ[t.ENV_BYPASS] = "1"
        st = t.license_state()
        check("=1 放行", st["acked"] is True, st)
        check("标记 bypass", st["bypass"] is True, st)
        check("ack 记录仍为空", not st.get("ack"), st.get("ack"))
        os.environ.pop(t.ENV_BYPASS, None)

        print("\n【P5】咽喉 + 常量同源")
        src = (ROOT / "tegula_llm.py").read_text(encoding="utf-8")
        check("_request 里接了 assert_licensed",
              bool(re.search(r"def _request[\s\S]{0,400}assert_licensed", src)))
        shared = (ROOT / "desktop" / "src" / "shared" / "license.ts").read_text(encoding="utf-8")
        m = re.search(r"LICENSE_VERSION\s*=\s*'([^']+)'", shared)
        m2 = re.search(r"LICENSE_CONTENT_SHA\s*=\s*'([0-9a-f]{12})'", shared)
        check("Python 版本 = 桌面 shared", bool(m) and m.group(1) == t.LICENSE_VERSION,
              (m.group(1) if m else None, t.LICENSE_VERSION))
        check("Python 指纹 = 桌面 shared", bool(m2) and m2.group(1) == t.LICENSE_CONTENT_SHA,
              (m2.group(1) if m2 else None, t.LICENSE_CONTENT_SHA))
    finally:
        if old_root is None:
            os.environ.pop("FANGCUN_DATA_DIR", None)
        else:
            os.environ["FANGCUN_DATA_DIR"] = old_root
        if old_bypass is None:
            os.environ.pop(t.ENV_BYPASS, None)
        else:
            os.environ[t.ENV_BYPASS] = old_bypass
        shutil.rmtree(tmp, ignore_errors=True)

    print("\ncheck-license-gate: %d passed, %d failed" % (len(PASS), len(FAIL)))
    return 1 if FAIL else 0


def _not_raises(fn):
    try:
        fn()
        return True
    except Exception:  # noqa: BLE001
        return False


if __name__ == "__main__":
    raise SystemExit(main())
