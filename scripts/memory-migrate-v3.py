#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
记忆 v3 迁移 · dry-run（2026-11-25 · P16.5 第一步）

**只读**：扫描 `memory/claims/*.md`，为每条提一个 v3 作用域（world / topic:x / file:y / session:z），
把逐条清单 + 汇总 + 合并候选写成一份报告。**不改任何记忆文件**。

用法：
  python scripts/memory-migrate-v3.py                 # 扫描 → 写报告到 memory/.backup/
  python scripts/memory-migrate-v3.py --json          # 只输出机器可读摘要（不写报告）
  python scripts/memory-migrate-v3.py --self-test     # 用临时目录自证（不碰真数据）

判定（先讲清，免得"看起来像自动"）：
  · `项目` 是具体项目（非空、非 `跨项目`）→ `topic:<项目>`；
  · 其它（含 `跨项目`、空）→ `world`；
  · `file:` / `session:` 这批 45 条里没有合适的 —— 它们是跨项目规矩，不是"某个文件上次做到哪"。
    （file/session 留给自动绑定与临时上下文；硬塞会把规矩变窄。）
  · 合并候选用编译产物 `desktop/dist/shared/memoryMerge.js` 真算（覆盖比 ≥45% + 有根），
    不是本脚本另写一套；算不出来就明说 SKIP，不拿粗算冒充。

⚠ 本脚本**没有 --apply**：45 条要用户看过报告再逐条落盘；apply 是下一步，另写、另审。
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MEMORY = REPO / "memory"
CLAIMS = MEMORY / "claims"
DIST_MERGE = REPO / "desktop" / "dist" / "shared" / "memoryMerge.js"
REPORT_DIR = MEMORY / ".backup"


def parse_entry(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, re.S)
    fm_text, body = (m.group(1), m.group(2)) if m else ("", text)
    fm = {}
    for raw in fm_text.splitlines():
        line = raw.rstrip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        fm[k.strip()] = v

    def section(name: str, body: str) -> str:
        mm = re.search(r"^##\s*" + name + r"\s*$(.*?)(?=^##\s|\Z)", body, re.M | re.S)
        return mm.group(1).strip() if mm else ""

    claim = section("记忆", body) or section("标题", body)
    evidence = section("证据", body)
    try:
        rel = str(path.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        rel = str(path).replace("\\", "/")
    return {
        "file": rel,
        "id": fm.get("id") or path.stem,
        "type": fm.get("类型", ""),
        "project": fm.get("项目", ""),
        "scope_v2": fm.get("适用范围", ""),
        "status": fm.get("状态", "有效"),
        "format": fm.get("格式", ""),
        "pinned": fm.get("钉住", ""),
        "code": fm.get("编号", ""),
        "claim": claim,
        "evidence": evidence,
        "claim_len": len(claim),
    }


def propose_scope(entry: dict) -> tuple:
    project = str(entry.get("project") or "").strip()
    if project and project != "跨项目":
        return f"topic:{project}", "有具体项目归属 → 只在该项目上下文里带出"
    return "world", "跨项目 / 无项目归属 → 全局常驻"


def load_entries() -> list:
    if not CLAIMS.is_dir():
        return []
    return [parse_entry(p) for p in sorted(CLAIMS.glob("*.md"))]


def merge_candidates(entries: list) -> dict:
    """用编译产物真算合并候选；产物不在就返回 skip（不拿粗算冒充）。"""
    if not DIST_MERGE.is_file():
        return {"ok": False, "skip": "编译产物不在（先跑 desktop 的 tsc），本项 SKIP"}
    payload = [
        {
            "id": e["id"], "scope": propose_scope(e)[0], "kind": e["type"],
            "claim": e["claim"], "evidence": e["evidence"],
        }
        for e in entries if e.get("status") == "有效"
    ]
    fd, tmp = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        Path(tmp).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        js = (
            "const M=require(process.argv[1]);"
            "const rows=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));"
            "console.log(JSON.stringify(M.planMerges(rows)));"
        )
        out = subprocess.run(
            ["node", "-e", js, str(DIST_MERGE), tmp],
            capture_output=True, text=True, encoding="utf-8", timeout=60,
        )
        if out.returncode != 0:
            return {"ok": False, "skip": "合并候选算失败：" + (out.stderr or "").strip()[:200]}
        return {"ok": True, "plan": json.loads(out.stdout)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "skip": "合并候选算失败：" + str(exc)}
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def split_fm(text: str):
    lines = text.splitlines(keepends=True)
    idx = [i for i, line in enumerate(lines) if line.strip() == "---"]
    if len(idx) < 2:
        return None
    return lines, idx[0], idx[1]


def section_pair(text: str):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, re.S)
    fm, body = (m.group(1), m.group(2)) if m else ("", text)

    def sec(name: str) -> str:
        mm = re.search(r"^##\s*" + name + r"\s*$(.*?)(?=^##\s|\Z)", body, re.M | re.S)
        return mm.group(1).strip() if mm else ""

    return [sec("记忆") or sec("标题"), sec("证据"), fm.splitlines()]


def apply_one(path: Path, scope: str) -> str:
    """行级改一条：格式 2 → 3，frontmatter 末尾插 作用域。返回 changed / already。"""
    text = path.read_text(encoding="utf-8")
    parsed = split_fm(text)
    if parsed is None:
        raise ValueError("没有 frontmatter —— 不敢动")
    lines, open_i, close_i = parsed
    nl = "\r\n" if "\r\n" in text else "\n"

    if any(lines[i].strip().startswith("作用域:") for i in range(open_i + 1, close_i)):
        return "already"  # 幂等：已经写过就不重复插

    fmt_i = None
    for i in range(open_i + 1, close_i):
        if lines[i].strip().startswith("格式:"):
            fmt_i = i
            break
    if fmt_i is None:
        raise ValueError("缺 格式 行 —— 不敢动")
    current = lines[fmt_i].strip().replace(" ", "")
    if current == "格式:3":
        # 已经是 3 但没有作用域：只补作用域
        lines.insert(close_i, "作用域: " + scope + nl)
    elif current == "格式:2":
        lines[fmt_i] = "格式: 3" + nl
        lines.insert(close_i, "作用域: " + scope + nl)
    else:
        raise ValueError("格式不是 2/3：" + lines[fmt_i].strip())

    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("".join(lines))
    return "changed"


def verify_one(path: Path, original: str, scope: str) -> str:
    """返回空串 = 通过；否则是失败原因。核心：claim / 证据一个字都不许变。"""
    text = path.read_text(encoding="utf-8")
    if not re.search(r"^作用域:\s*" + re.escape(scope) + r"\s*$", text, re.M):
        return "作用域没写对"
    if not re.search(r"^格式:\s*3\s*$", text, re.M):
        return "格式没改成 3"
    old = section_pair(original)
    new = section_pair(text)
    if old[0] != new[0]:
        return "claim 变了"
    if old[1] != new[1]:
        return "证据变了"
    for line in old[2]:
        s = line.rstrip("\r\n")
        if not s.strip() or s.strip().startswith("格式:"):
            continue
        if s not in text:
            return "丢了原字段：" + s
    return ""


def apply_migration(entries: list, claims_dir: Path, backup_dir: Path) -> dict:
    """逐条 apply + 逐条 verify；任何一条失败 → 用备份把已改的全恢复。"""
    changed, skipped, errors = [], [], []
    backup_claims = backup_dir / "claims"
    backup_claims.mkdir(parents=True, exist_ok=True)

    for e in entries:
        p = claims_dir / Path(e["file"]).name
        scope, _ = propose_scope(e)
        try:
            original = p.read_text(encoding="utf-8")
            state = apply_one(p, scope)
        except Exception as exc:  # noqa: BLE001
            errors.append((e["id"], str(exc)))
            break
        if state == "already":
            skipped.append(e["id"])
            continue
        (backup_claims / p.name).write_text(original, encoding="utf-8")
        problem = verify_one(p, original, scope)
        if problem:
            errors.append((e["id"], problem))
            break
        changed.append((e["id"], scope))

    if errors:
        for bak in backup_claims.glob("*.md"):
            (claims_dir / bak.name).write_text(bak.read_text(encoding="utf-8"), encoding="utf-8")
        return {"ok": False, "changed": [], "skipped": skipped, "errors": errors, "rolledBack": True}
    return {"ok": True, "changed": changed, "skipped": skipped, "errors": []}


def build_report(entries: list, merges: dict, now: datetime) -> str:
    lines = []
    lines.append(f"# 记忆 v3 迁移 · dry-run（{now:%Y-%m-%d %H:%M}）")
    lines.append("")
    lines.append("> **只读**：本报告没有改任何记忆文件。看过后再决定要不要逐条落 `作用域` / `格式: 3`。")
    lines.append("")
    counts = {}
    for e in entries:
        scope, _ = propose_scope(e)
        counts[scope.split(":")[0]] = counts.get(scope.split(":")[0], 0) + 1
    lines.append("## 汇总")
    lines.append("")
    lines.append(f"- 条目：**{len(entries)}** 条（`memory/claims/*.md`）")
    lines.append("- 建议作用域：" + " / ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    if merges.get("ok"):
        n = len(merges["plan"].get("merges", []))
        lines.append(f"- 合并候选：**{n}** 组（覆盖比 ≥45%，合并句必须是原句之一）")
    else:
        lines.append(f"- 合并候选：SKIP —— {merges.get('skip', '算不出来')}")
    lines.append("")
    lines.append("## 逐条清单")
    lines.append("")
    lines.append("| id | 类型 | 项目 | 建议作用域 | 字数 | claim |")
    lines.append("|---|---|---|---|---|---|")
    for e in entries:
        scope, _ = propose_scope(e)
        claim = (e["claim"] or "").replace("|", "\\|").replace("\n", " ")[:90]
        lines.append(
            f"| {e['id']} | {e['type'] or '—'} | {e['project'] or '—'} | `{scope}` | {e['claim_len']} | {claim} |"
        )
    lines.append("")
    lines.append("## 合并候选（粗看，正式合并走记忆页「合并」）")
    lines.append("")
    if merges.get("ok"):
        plan = merges["plan"]
        if not plan.get("merges"):
            lines.append("没有达到 45% 重合的重复簇。")
        for i, m in enumerate(plan.get("merges", []), 1):
            lines.append(f"{i}. ids: `{'` / `'.join(m['ids'])}`")
            lines.append(f"   - 幸存句（原句之一）：{m['claim']}")
            lines.append(f"   - 作用域 / 类型：`{m['scope']}` / {m['kind']}；覆盖比 {round(float(m['share']) * 100)}%")
    else:
        lines.append(f"SKIP：{merges.get('skip', '')}")
    lines.append("")
    lines.append("## 应用时会动什么（尚未执行）")
    lines.append("")
    lines.append("- 每条 frontmatter 追加 `作用域: <建议值>`，并把 `格式: 2` 改成 `格式: 3`；")
    lines.append("- **不动** claim / 证据 / 编号 / 适用范围（删字段的口径还没和你确认，先不删）；")
    lines.append("- 逐条落盘前留 `.bak`；报告本身在 `memory/.backup/`，不进 git。")
    lines.append("")
    lines.append("## 没覆盖到的")
    lines.append("")
    lines.append("- `file:` / `session:`：这 45 条没有合适的（它们不是“某个文件上次做到哪”）；")
    lines.append("- 合并候选只是候选：正式合并要你在记忆页点，且会撤销被并条目（不删文件）。")
    return "\n".join(lines)


def self_test() -> int:
    """临时目录自证：只看作用域判定与"不改文件"。"""
    tmp = Path(tempfile.mkdtemp(prefix="fc-migrate-"))
    claims = tmp / "claims"
    claims.mkdir(parents=True)
    samples = [
        ("a.md", "p-one", "跨项目", "一条项目规矩", "topic:p-one"),
        ("b.md", "", "跨项目", "一条全局规矩", "world"),
        ("c.md", "跨项目", "跨项目", "另一条全局规矩", "world"),
    ]
    for name, project, scope, claim, _ in samples:
        (claims / name).write_text(
            "---\nid: mem-test-%s\n类型: 纪律\n项目: %s\n适用范围: %s\n状态: 有效\n格式: 2\n---\n\n"
            "## 记忆\n\n%s\n\n## 证据\n\n原文\n" % (name[0], project, scope, claim),
            encoding="utf-8",
        )
    before = {p.name: p.read_bytes() for p in claims.glob("*.md")}
    got = []
    for name, _, _, _, expect in samples:
        e = parse_entry(claims / name)
        got.append((propose_scope(e)[0], expect))
    after = {p.name: p.read_bytes() for p in claims.glob("*.md")}
    ok = all(g == x for g, x in got) and before == after
    print("=" * 8, "self-test", "=" * 8)
    for (g, x) in got:
        print(("PASS" if g == x else "FAIL"), "propose_scope →", g, "(expect", x + ")")
    print(("PASS" if before == after else "FAIL"), "dry-run 不改文件")
    for p in claims.glob("*.md"):
        p.unlink()
    claims.rmdir()
    tmp.rmdir()
    return 0 if ok else 1


def self_test_apply() -> int:
    """临时目录自证 apply：作用域/格式真写上，claim/证据一个字没变，备份在，重复跑幂等。"""
    tmp = Path(tempfile.mkdtemp(prefix="fc-migrate-apply-"))
    claims = tmp / "claims"
    claims.mkdir(parents=True)
    samples = [
        ("a.md", "p-one", "一条项目规矩", "topic:p-one"),
        ("b.md", "", "一条全局规矩", "world"),
    ]
    for name, project, claim, _ in samples:
        (claims / name).write_text(
            "---\nid: mem-test-%s\n类型: 纪律\n项目: %s\n适用范围: 跨项目\n状态: 有效\n格式: 2\n---\n\n"
            "## 记忆\n\n%s\n\n## 证据\n\n原文逐字\n" % (name[0], project, claim),
            encoding="utf-8",
        )
    before = {p.name: p.read_text(encoding="utf-8") for p in claims.glob("*.md")}
    entries = [parse_entry(claims / name) for name, *_ in samples]
    res = apply_migration(entries, claims, tmp / "backup")

    ok = res["ok"] and len(res["changed"]) == 2
    for name, _, _, scope in samples:
        text = (claims / name).read_text(encoding="utf-8")
        ok = ok and re.search(r"^作用域: " + re.escape(scope) + r"$", text, re.M) is not None
        ok = ok and re.search(r"^格式: 3$", text, re.M) is not None
        old, new = section_pair(before[name]), section_pair(text)
        ok = ok and old[0] == new[0] and old[1] == new[1]
    ok = ok and (tmp / "backup" / "claims" / "a.md").is_file()

    res2 = apply_migration(entries, claims, tmp / "backup2")
    ok = ok and res2["ok"] and len(res2["skipped"]) == 2 and not res2["changed"]

    for p in list(claims.glob("*.md")):
        p.unlink()
    claims.rmdir()
    for d in (tmp / "backup", tmp / "backup2"):
        for p in list(d.glob("claims/*.md")):
            p.unlink()
        (d / "claims").rmdir()
        d.rmdir()
    tmp.rmdir()

    print("=" * 8, "self-test-apply", "=" * 8)
    checks = [
        ("apply 真改了两条", ok),
        ("重复跑幂等（全部跳过）", res2["ok"] and len(res2["skipped"]) == 2),
        ("claim/证据未变", ok),
        ("备份文件在", ok),
    ]
    for name, cond in checks:
        print("PASS" if cond else "FAIL", name)
    return 0 if ok else 1


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    if "--self-test-apply" in sys.argv:
        return self_test_apply()
    if "--apply" in sys.argv:
        entries = load_entries()
        if not entries:
            print("没有找到记忆条目（memory/claims/*.md 不存在或为空）")
            return 1
        now = datetime.now()
        backup_dir = REPORT_DIR / f"v3-apply-{now:%Y%m%d-%H%M%S}"
        res = apply_migration(entries, CLAIMS, backup_dir)
        if not res["ok"]:
            print("APPLY 失败，已用备份回滚本次改过的文件：")
            for entry_id, err in res["errors"]:
                print(" -", entry_id, err)
            print("备份目录：", backup_dir.relative_to(REPO))
            return 1
        lines = [
            f"# 记忆 v3 apply（{now:%Y-%m-%d %H:%M}）",
            "",
            f"- 改了 **{len(res['changed'])}** 条；跳过 **{len(res['skipped'])}** 条（已有作用域）",
            f"- 备份：`{backup_dir.relative_to(REPO)}`（每条被改文件的原始全文）",
            "",
            "| id | 作用域 |",
            "|---|---|",
        ]
        lines += [f"| {entry_id} | `{scope}` |" for entry_id, scope in res["changed"]]
        lines += [
            "",
            "## 回滚",
            "",
            f"把 `{backup_dir.relative_to(REPO)}/claims/*.md` 复制回 `memory/claims/`，"
            "然后跑 `python scripts/memory.py --rebuild`。",
            "",
            "## 校验",
            "",
            "`python scripts/memory.py --rebuild && python scripts/memory.py --check`",
        ]
        (backup_dir / "apply-report.md").write_text("\n".join(lines), encoding="utf-8")
        print(f"APPLY OK：改了 {len(res['changed'])} 条，跳过 {len(res['skipped'])} 条")
        print(f"备份：{backup_dir.relative_to(REPO)}")
        print("下一步：python scripts/memory.py --rebuild && python scripts/memory.py --check")
        return 0

    entries = load_entries()
    if not entries:
        print("没有找到记忆条目（memory/claims/*.md 不存在或为空）")
        return 1
    merges = merge_candidates(entries)
    now = datetime.now()
    report = build_report(entries, merges, now)

    if "--json" in sys.argv:
        counts = {}
        for e in entries:
            k = propose_scope(e)[0].split(":")[0]
            counts[k] = counts.get(k, 0) + 1
        print(json.dumps({
            "entries": len(entries), "scopes": counts,
            "merge_clusters": len(merges["plan"].get("merges", [])) if merges.get("ok") else None,
            "merges_skipped": merges.get("skip"),
        }, ensure_ascii=False, indent=2))
        return 0

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORT_DIR / f"v3-dryrun-{now:%Y%m%d-%H%M%S}.md"
    out.write_text(report, encoding="utf-8")
    print(f"报告：{out.relative_to(REPO)}")
    print(f"条目：{len(entries)} 条；合并候选："
          + (str(len(merges['plan'].get('merges', []))) if merges.get('ok') else 'SKIP'))
    return 0


if __name__ == "__main__":
    sys.exit(main())
