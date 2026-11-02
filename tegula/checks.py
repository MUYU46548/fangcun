#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""判据行解析（P3 的 Python 只读镜像）—— **只解析，不执行**。

为什么要有这一份：CLI / MCP 侧要能回答"这张卡上的判据到底怎么机检"，
但**绝不允许**在 Python 里再跑一遍命令或文件检查（那就是两套执行器、两套审计）。
真执行只在主进程 TS（`desktop/src/main/checks/runner.ts`）。

语法与 `desktop/src/shared/checkSpec.ts` 逐条对齐（e2e-checks 里有跨语言对拍）：

    cmd:  <命令>                          # 退出码 0 即通过（反引号包起来的命令也认）
    str:  <相对路径> 含 '<原文>'           # 引号优先；不含空格的单个词可不加引号
    num:  <相对路径> <指标> <比较> <数字>   # 指标：行数 / 条目数 / 字节数 / 字符数
    file: <相对路径或 glob> 存在[且含 '<原文>'][且每行含 '<原文>']

三条口径同 TS：
  ① 未知前缀（含 `human:`）→ kind=unknown，永不返回"通过"；
  ② 已知前缀但没写清 → 也 unknown，并给出可读 reason；
  ③ 原样保留 raw，结果能指回卡上的那一行。
"""
import re

CHECK_KINDS = ("cmd", "str", "num", "file")
_KIND_SET = set(CHECK_KINDS)
_QUOTES = (("'", "'"), ('"', '"'), ("`", "`"), ("“", "”"), ("『", "』"))


def normalize_check_line(raw):
    """去掉 Markdown 列表符号与首尾空白。"""
    return re.sub(r"^\s*[-*+]\s+", "", str(raw or "")).strip()


def unquote_full(s):
    """整段被一对引号包着 → 返回里面的原文；否则 None。"""
    t = str(s or "").strip()
    for a, b in _QUOTES:
        if len(t) >= len(a) + len(b) and t.startswith(a) and t.endswith(b):
            return t[len(a):len(t) - len(b)]
    return None


def parse_literal(s):
    """要匹配的原文：整段带引号，或不含空格的单个词；都不是 → None。"""
    t = str(s or "").strip()
    if not t:
        return None
    q = unquote_full(t)
    if q is not None:
        return q
    if not re.search(r"\s", t):
        return t
    return None


def parse_metric(s):
    k = str(s or "").strip().lower()
    return {
        "行数": "lines", "lines": "lines", "line": "lines",
        "条目数": "entries", "entries": "entries", "items": "entries",
        "字节数": "bytes", "bytes": "bytes",
        "字符数": "chars", "chars": "chars",
    }.get(k)


def normalize_op(s):
    k = str(s or "").strip()
    return {
        ">=": ">=", "≥": ">=",
        "<=": "<=", "≤": "<=",
        "=": "==", "==": "==", "＝": "==",
        "!=": "!=", "≠": "!=",
        ">": ">", "<": "<",
    }.get(k)


def looks_relative_path(p):
    t = str(p or "").strip()
    if not t:
        return False
    if re.match(r"^[A-Za-z]:[\\/]", t):
        return False
    if t.startswith("/") or t.startswith("\\"):
        return False
    return ("/" in t) or ("\\" in t)


def extract_command(body):
    """`cmd:` 后面取命令：反引号开头取反引号里的；否则去掉尾部“退出码 0”与 `# 注释`。"""
    s = str(body or "").strip()
    m = re.match(r"^`([^`]+)`\s*([\s\S]*)$", s)
    if m:
        return m.group(1).strip()
    out = re.sub(r"\s+#\s.*$", "", s).strip()
    out = re.sub(r"\s*(?:退出码|exit\s*code)\s*(?:为)?\s*0\s*$", "", out, flags=re.I).strip()
    return out


def _unknown(raw, reason):
    return {"kind": "unknown", "raw": raw, "reason": reason}


def parse_criterion(raw):
    """解析一行判据。永不抛；判不了返回 kind=unknown + reason。"""
    line = normalize_check_line(raw)
    m = re.match(r"^([A-Za-z]+)\s*[:：]\s*([\s\S]*)$", line)
    if not m:
        return _unknown(line, "没有 cmd: / str: / num: / file: 前缀，机器判不了")
    prefix = m.group(1).lower()
    body = m.group(2).strip()

    if prefix == "human":
        return _unknown(line, "human: 合法，但那是“人来验”，不是可机检判据")
    if prefix not in _KIND_SET:
        return _unknown(
            line,
            "未知前缀 %s: —— 只认 cmd / str / num / file；未知一律 unknown，绝不当通过" % m.group(1),
        )

    if prefix == "cmd":
        command = extract_command(body)
        if not command:
            return _unknown(line, "cmd: 后面没有命令")
        return {"kind": "cmd", "raw": line, "command": command}

    if prefix == "str":
        sm = re.match(r"^(\S+)\s+(?:含|包含|contains)\s+(\S[\s\S]*)$", body, flags=re.I)
        if not sm:
            return _unknown(line, "str: 只认“<相对路径> 含 '<原文>'”—— 含 两侧要有空格，原文要带引号")
        file_path = unquote_full(sm.group(1)) or sm.group(1).strip()
        if not looks_relative_path(file_path):
            return _unknown(
                line,
                "str: 目标文件要写相对路径（拿到的是“%s”；“本文件”这类指代不认）" % file_path,
            )
        text = parse_literal(sm.group(2))
        if text is None:
            return _unknown(line, "str: 要匹配的原文请用引号括起来（或写成不含空格的单个词）—— 否则分不清原文与说明")
        return {"kind": "str", "raw": line, "path": file_path.replace("\\", "/"), "text": text}

    if prefix == "num":
        nm = re.match(
            r"^(\S+)\s+(\S+)\s*(>=|<=|==|!=|>|<|≥|≤|＝|=)\s*(-?\d+(?:\.\d+)?)\s*$", body
        )
        if not nm:
            return _unknown(
                line,
                "num: 只认“<相对路径> <指标> <比较> <数字>”，指标 = 行数 / 条目数 / 字节数 / 字符数",
            )
        file_path = unquote_full(nm.group(1)) or nm.group(1).strip()
        if not looks_relative_path(file_path):
            return _unknown(line, "num: 目标文件要写相对路径（拿到的是“%s”）" % file_path)
        metric = parse_metric(nm.group(2))
        if not metric:
            return _unknown(
                line,
                "num: 认不出指标“%s”—— 只认 行数 / 条目数 / 字节数 / 字符数（不糊默认值）" % nm.group(2),
            )
        op = normalize_op(nm.group(3))
        if not op:
            return _unknown(line, "num: 认不出比较符“%s”" % nm.group(3))
        num = nm.group(4)
        expected = float(num) if "." in num else int(num)
        return {
            "kind": "num", "raw": line, "path": file_path.replace("\\", "/"),
            "metric": metric, "metricText": nm.group(2), "op": op, "expected": expected,
        }

    # file
    fm = re.match(r"^(\S+)(?:\s+([\s\S]*))?$", body)
    if not fm:
        return _unknown(line, "file: 后面没有路径")
    pattern = unquote_full(fm.group(1)) or fm.group(1).strip()
    if not looks_relative_path(pattern):
        return _unknown(line, "file: 目标要写相对路径（拿到的是“%s”）" % pattern)
    rest = str(fm.group(2) or "").strip()
    rest = re.sub(r"[，,。；;]", " ", rest)
    rest = " ".join(rest.split())
    if not rest:
        return {"kind": "file", "raw": line, "pattern": pattern.replace("\\", "/"), "requireExists": True}

    forms = (
        (r"^存在\s*且每行含\s+(\S[\s\S]*)$", "every"),
        (r"^存在\s*且含\s+(\S[\s\S]*)$", "any"),
        (r"^每行含\s+(\S[\s\S]*)$", "every"),
        (r"^含\s+(\S[\s\S]*)$", "any"),
        (r"^存在$", None),
    )
    for rx, contains in forms:
        r = re.match(rx, rest)
        if not r:
            continue
        literal = None
        if contains:
            literal = parse_literal(r.group(1))
            if literal is None:
                return _unknown(line, "file: “含”后面的原文要带引号（或写成不含空格的单个词）")
        out = {"kind": "file", "raw": line, "pattern": pattern.replace("\\", "/"), "requireExists": True}
        if contains == "any":
            out["contains"] = literal
        if contains == "every":
            out["everyLineContains"] = literal
        return out
    return _unknown(
        line,
        "file: 只认“<路径> 存在”“<路径> 存在且含 '<原文>'”“<路径> 存在且每行含 '<原文>'”",
    )


def parse_criteria(lines):
    """从一批卡上的判据行里解析（空行/纯空白跳过）。"""
    out = []
    for line in lines or []:
        norm = normalize_check_line(line)
        if norm:
            out.append(parse_criterion(norm))
    return out
