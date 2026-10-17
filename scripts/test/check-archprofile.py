#!/usr/bin/env python3
# check-archprofile.py — 项目分层档案验证（2026-10-17 四件补立项③）
# 用法：python scripts/test/check-archprofile.py
# 不碰真实 task-data/notes：全指向临时目录；LLM 打桩零网络；repo 树用临时目录实扫。
import contextlib
import io
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import tegula.core as core  # noqa: E402
from tegula import cli as tegcli  # noqa: E402
import tegula_llm as llm  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))


# ---- 测试环境：临时数据目录 + 假 repo 树 + 打桩 ----
tmpdir = tempfile.mkdtemp(prefix="archprofile_check_")
_saved = {}
for k in ("TASK_DIR", "_NOTES_DIR", "REGISTRY_PATH"):
    _saved[k] = getattr(core, k, None)
core.TASK_DIR = os.path.join(tmpdir, "task-data")
core._NOTES_DIR = os.path.join(tmpdir, "notes")
core.REGISTRY_PATH = os.path.join(tmpdir, "registry.yaml")
os.makedirs(core.TASK_DIR, exist_ok=True)
os.makedirs(core._NOTES_DIR, exist_ok=True)
with open(core.REGISTRY_PATH, "w", encoding="utf-8") as f:
    f.write("members:\n  - hermes\nprojects:\n  - id: proj-y\n    name: 档案测试项目\n"
            f"    repo: {tmpdir}/fakerepo\n    tools: [python]\n    说明: 测试说明行\n")

# 假 repo：两级目录+文件+该跳过的依赖目录
repo = os.path.join(tmpdir, "fakerepo")
os.makedirs(os.path.join(repo, "tegula"))
os.makedirs(os.path.join(repo, "node_modules", "react"))
os.makedirs(os.path.join(repo, ".git"))
open(os.path.join(repo, "README.md"), "w").write("x")
open(os.path.join(repo, "tegula", "core.py"), "w").write("x")
open(os.path.join(repo, "node_modules", "react", "index.js"), "w").write("x")

_saved_chat = llm.chat

try:
    # ---- 1. _repo_tree ----
    tree, err = core._repo_tree(repo)
    check("目录树扫描成功", tree is not None and not err, str(err))
    joined = "\n".join(tree or [])
    check("根文件在树中", "README.md" in joined, joined[:200])
    check("子目录在树中", "tegula/" in joined and "core.py" in joined, joined[:200])
    check("node_modules 被跳过", "node_modules" not in joined, joined[:200])
    check(".git 被跳过", ".git" not in joined, joined[:200])
    tree2, err2 = core._repo_tree(os.path.join(tmpdir, "nowhere"))
    check("repo 不可达返回人话原因", tree2 is None and "不可达" in (err2 or ""), str(err2))
    # 条目上限
    big = os.path.join(tmpdir, "bigrepo")
    os.makedirs(big)
    for i in range(250):
        open(os.path.join(big, f"f{i:03d}.txt"), "w").write("x")
    tree3, _ = core._repo_tree(big, max_entries=50)
    check("条目上限截断", len(tree3) <= 51 and any("上限" in l for l in tree3[-3:]), str(len(tree3)))

    # ---- 2. build_arch_profile 骨架（零 AI）----
    md, err = core.build_arch_profile("proj-y")
    check("骨架生成成功", md is not None and not err, str(err))
    check("标题带项目名", "档案测试项目" in (md or "") and "proj-y" in md, (md or "")[:120])
    check("目录树进档案", "README.md" in md and "core.py" in md, "")
    check("registry 说明进档案", "测试说明行" in md, "")
    md_bad, err_bad = core.build_arch_profile("no-such-project")
    check("未知项目报错列出现有", md_bad is None and "no-such-project" in err_bad, str(err_bad))

    # ---- 3. CLI：无 key → 纯骨架 + 落笔记 ----
    os.environ["TEGULA_LLM_BASE_URL"] = ""
    os.environ["TEGULA_LLM_API_KEY"] = ""
    llm._config = None
    args = type("A", (), {})()
    args.id = "proj-y"
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = tegcli.cmd_arch_profile(args)
    check("CLI 无 key 退出码 0（骨架兜底）", rc == 0, f"rc={rc}")
    out = buf.getvalue()
    check("CLI 输出含骨架", "结构分层" in out and "契约骨架" in out, out[:200])
    check("无 key 不含 AI 解读章节", "## AI 解读" not in out, "")
    check("骨架已落笔记", len(os.listdir(core._NOTES_DIR)) == 1, str(os.listdir(core._NOTES_DIR)))

    # ---- 4. CLI：有 key（打桩）→ AI 解读追加 ----
    def _fake_chat(content, **kw):
        assert kw.get("trigger") == "arch.profile", f"trigger 丢了: {kw}"
        return "AI 解读正文。" * 60  # >200 字符
    llm.chat = _fake_chat
    os.environ["TEGULA_LLM_API_KEY"] = "stub"
    llm._config = None
    buf2 = io.StringIO()
    with contextlib.redirect_stdout(buf2):
        rc2 = tegcli.cmd_arch_profile(args)
    out2 = buf2.getvalue()
    check("CLI 有 key 退出码 0", rc2 == 0, f"rc2={rc2}")
    check("AI 解读追加在骨架后", out2.index("## AI 解读") > out2.index("## 契约骨架"), "")
    check("骨架仍在 AI 解读前保真", "结构分层" in out2.split("## AI 解读")[0], "")
    check("笔记累计两版", len(os.listdir(core._NOTES_DIR)) == 2, str(os.listdir(core._NOTES_DIR)))

    # ---- 5. AI 挂了 → 静默退化骨架 ----
    def _boom(content, **kw):
        raise llm.LLMError("桩：模拟网络失败")
    llm.chat = _boom
    buf3 = io.StringIO()
    with contextlib.redirect_stdout(buf3):
        rc3 = tegcli.cmd_arch_profile(args)
    check("AI 挂掉退出码仍 0", rc3 == 0, f"rc3={rc3}")
    check("AI 挂掉输出仍是完整骨架", "AI 解读" not in buf3.getvalue() and "结构分层" in buf3.getvalue(), "")
    check("笔记累计三版", len(os.listdir(core._NOTES_DIR)) == 3, str(len(os.listdir(core._NOTES_DIR))))

except Exception as e:  # noqa: BLE001
    import traceback
    check("测试体异常", False, f"{e!r}\n{traceback.format_exc()[:400]}")
finally:
    llm.chat = _saved_chat
    for k, v in _saved.items():
        setattr(core, k, v)

print(f"\n{'=' * 50}\n通过 {len(PASS)} / 失败 {len(FAIL)}")
if FAIL:
    print("失败清单：")
    for name in FAIL:
        print(f"  - {name}")
sys.exit(1 if FAIL else 0)
