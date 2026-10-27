# -*- coding: utf-8 -*-
"""发版前置体检 / 发布后复核的回归 —— `scripts/release-precheck.py`。

为什么要有这个测试（2026-10-24）：
  0.4.1 那次 `gh release create` 把 tag 打在**远端旧 HEAD** 上（本地领先 50 笔没推），
  资产对、说明对、命令退出 0 —— 只有导出源码的人会发现不对。判据搬进 Python 之后，
  这里用**真 git + 真 bare origin + 假 gh** 逐条跑，每条都配反例。

覆盖：
  1. 干净仓库 → 0；版本号 / 资产 / latest.yml 都对得上
  2. 本地领先（就是 0.4.1 那次的现场）→ 10，且提示里给出 `git push origin main`
  3. 本地落后 → 11；两边都有 → 12
  4. 远端 tag 指向旧提交：不加 --move-tag → 13，**且远端 tag 一个字节没动**（反例自证）
  5. 同上加 --move-tag → 0，且远端 tag 真搬到 HEAD
  6. tag 已指 HEAD（重发同一版）→ 0，幂等
  7. 版本号三处任一不符 → 14；资产缺失 / latest.yml 大小不符 → 15
  8. 没有 origin → 16
  9. --verify-release：资产大小 / state / 说明 / draft 逐项对不上 → 17
 10. 源码守卫：publish-release.sh 真的调了体检与复核，且 --move-tag 透传
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(HERE)
PRECHECK = os.path.join(HERE, "release-precheck.py")
PUBLISH_SH = os.path.join(HERE, "publish-release.sh")

VER = "0.4.1"
EXE = f"Fangcun-Setup.{VER}.exe"
BLOCK = EXE + ".blockmap"
EXE_BYTES = 2048
BLOCK_BYTES = 128

PASS = 0
FAIL = 0
TMP = []


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}" + (f"  ← {detail}" if detail else ""))


def run(cmd, cwd=None, env=None):
    e = dict(os.environ)
    e.update(env or {})
    p = subprocess.run(cmd, cwd=cwd, env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return (p.returncode,
            p.stdout.decode("utf-8", "replace"),
            p.stderr.decode("utf-8", "replace"))


def git(*args, cwd=None):
    rc, out, err = run(["git"] + list(args), cwd=cwd)
    if rc != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{err or out}")
    return out.strip()


def tmpdir(tag):
    d = tempfile.mkdtemp(prefix=f"fc-rel-{tag}-")
    TMP.append(d)
    return d


def write_latest_yml(repo, version=VER, url=EXE, size=EXE_BYTES):
    p = os.path.join(repo, "desktop", "pkg", "latest.yml")
    with open(p, "w", encoding="utf-8") as f:
        f.write(
            f"version: {version}\n"
            "files:\n"
            f"  - url: {url}\n"
            "    sha512: AAAA==\n"
            f"    size: {size}\n"
            f"path: {url}\n"
            "sha512: AAAA==\n"
            "releaseDate: '2026-10-24T00:00:00.000Z'\n"
        )


def make_repo(tag="a", ver=VER):
    """造 origin（bare）+ work（真工作副本），推一笔 main 上去。"""
    base = tmpdir(tag)
    origin = os.path.join(base, "origin.git")
    work = os.path.join(base, "work")
    os.makedirs(work)
    run(["git", "init", "--bare", "-q", origin])
    git("init", "-q", cwd=work)
    git("config", "user.email", "t@t", cwd=work)
    git("config", "user.name", "t", cwd=work)
    git("config", "commit.gpgsign", "false", cwd=work)
    git("checkout", "-q", "-b", "main", cwd=work)

    os.makedirs(os.path.join(work, "desktop", "pkg"))
    os.makedirs(os.path.join(work, "skills"))
    with open(os.path.join(work, "desktop", "package.json"), "w", encoding="utf-8") as f:
        json.dump({"name": "fangcun-desktop", "version": ver}, f)
    with open(os.path.join(work, "skills", "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"version": ver}, f)
    with open(os.path.join(work, "desktop", "pkg", EXE), "wb") as f:
        f.write(b"x" * EXE_BYTES)
    with open(os.path.join(work, "desktop", "pkg", BLOCK), "wb") as f:
        f.write(b"y" * BLOCK_BYTES)
    write_latest_yml(work)

    git("add", "-A", cwd=work)
    git("commit", "-q", "-m", "init", cwd=work)
    git("remote", "add", "origin", origin, cwd=work)
    git("push", "-q", "-u", "origin", "main", cwd=work)
    return origin, work


def commit_more(work, name="a.txt", body="more"):
    with open(os.path.join(work, name), "w", encoding="utf-8") as f:
        f.write(body)
    git("add", "-A", cwd=work)
    git("commit", "-q", "-m", "more", cwd=work)


def push_from_side(origin, tmp_tag="side"):
    """另开一个副本往 origin 推一笔 —— 造"远端有新提交"。"""
    side = tmpdir(tmp_tag)
    run(["git", "clone", "-q", origin, side])
    git("config", "user.email", "t@t", cwd=side)
    git("config", "user.name", "t", cwd=side)
    git("config", "commit.gpgsign", "false", cwd=side)
    git("checkout", "-q", "main", cwd=side)
    commit_more(side, "side.txt", "side")
    git("push", "-q", "origin", "main", cwd=side)
    return side


def precheck(work, *args, env=None):
    rc, out, err = run([sys.executable, PRECHECK, work, VER] + list(args), env=env)
    return rc, out + err


def main():
    print("=" * 70)
    print("release-precheck：真 git + 真 bare origin + 假 gh")
    print("=" * 70)

    # ── 1. 干净仓库 ────────────────────────────────────────────────────
    origin, work = make_repo("clean")
    rc, out = precheck(work)
    check("干净仓库：前置体检通过", rc == 0, f"rc={rc} out={out[-300:]}")
    check("干净仓库：认得出版本号一致", "版本号一致" in out, out[-200:])
    check("干净仓库：认出 latest.yml 与 exe 对得上", "latest.yml 与这份 exe 对得上" in out, out[-200:])
    check("干净仓库：远端还没有 tag 时会说「将在发布时创建」", "将在发布时创建" in out, out[-200:])

    # ── 2. 本地领先（0.4.1 的真实现场）────────────────────────────────
    _, w2 = make_repo("ahead")
    commit_more(w2)
    rc, out = precheck(w2)
    check("★ 本地领先：判 10（不推就发版 = tag 打远端旧 HEAD）", rc == 10, f"rc={rc} out={out[-300:]}")
    check("★ 本地领先：提示里给出 `git push origin main`", "git push origin main" in out, out[-300:])
    check("★ 本地领先：把「领先 N 笔」说清楚", "领先 1 笔" in out, out[-300:])

    # ── 3. 落后 / 分叉 ────────────────────────────────────────────────
    o3, w3 = make_repo("behind")
    push_from_side(o3)
    rc, out = precheck(w3)
    check("本地落后：判 11", rc == 11, f"rc={rc} out={out[-300:]}")
    check("本地落后：提示 `git pull --ff-only`", "git pull --ff-only" in out, out[-300:])

    o4, w4 = make_repo("diverge")
    push_from_side(o4)
    commit_more(w4)
    rc, out = precheck(w4)
    check("两边都有新提交：判 12，且说「先合并再发版」", rc == 12 and "先合并再发版" in out,
          f"rc={rc} out={out[-300:]}")

    # ── 4. tag 指向旧提交（--move-tag 两态）───────────────────────────
    o5, w5 = make_repo("stale-tag")
    git("add", "-A", cwd=w5)
    commit_more(w5, "second.txt", "second")
    git("push", "-q", "origin", "main", cwd=w5)
    old = git("rev-parse", "HEAD~1", cwd=w5)
    git("tag", f"v{VER}", old, cwd=w5)
    git("push", "-q", "origin", f"refs/tags/v{VER}", cwd=w5)
    rc, out = precheck(w5)
    check("★ tag 在 HEAD 身后（发版后又提交）：判 13", rc == 13, f"rc={rc} out={out[-300:]}")
    check("★ tag 在 HEAD 身后：说「又动了 1 笔」，不吓唬人", "又动了 1 笔" in out, out[-300:])
    check("★ tag 在 HEAD 身后：提示「要重发才 --move-tag，新东西换版本号」",
          "--move-tag" in out and "换个版本号" in out, out[-300:])
    check("★ 反例：判 13 时远端 tag 一个字节没动",
          git("ls-remote", "--tags", "origin", f"refs/tags/v{VER}", cwd=w5).split()[0] == old,
          git("ls-remote", "--tags", "origin", f"refs/tags/v{VER}", cwd=w5))

    rc, out = precheck(w5, "--move-tag")
    head = git("rev-parse", "HEAD", cwd=w5)
    moved = git("ls-remote", "--tags", "origin", f"refs/tags/v{VER}", cwd=w5).split()[0]
    check("★ --move-tag：整体通过", rc == 0, f"rc={rc} out={out[-300:]}")
    check("★ --move-tag：远端 tag 真的搬到 HEAD", moved == head, f"{moved} vs {head}")
    check("--move-tag：输出里记了搬运（不静默）", "搬到 HEAD" in out, out[-300:])

    rc, out = precheck(w5)
    check("重发同一版（tag 已指 HEAD）：判 0，幂等", rc == 0, f"rc={rc} out={out[-300:]}")
    check("重发同一版：明说「幂等」", "幂等" in out, out[-200:])

    # ── 4b. tag 与 HEAD 不在一条线上（tag 是别处来的）──────────────────
    o5b, w5b = make_repo("foreign-tag")
    side = tmpdir("foreign")
    run(["git", "clone", "-q", o5b, side])
    git("config", "user.email", "t@t", cwd=side)
    git("config", "user.name", "t", cwd=side)
    git("config", "commit.gpgsign", "false", cwd=side)
    git("checkout", "-q", "main", cwd=side)
    commit_more(side, "foreign.txt", "foreign")
    git("tag", f"v{VER}", cwd=side)
    git("push", "-q", "origin", f"refs/tags/v{VER}", cwd=side)
    rc, out = precheck(w5b)
    check("★ tag 与 HEAD 不在一条线上（别处来的 tag）：判 13", rc == 13, f"rc={rc} out={out[-300:]}")
    check("★ 这一种才说「下载到源码旧、资产新」的危害",
          "不在一条线上" in out and "源码旧" in out, out[-300:])

    # ── 5. 版本号与资产 ───────────────────────────────────────────────
    _, w6 = make_repo("badpkg")
    with open(os.path.join(w6, "desktop", "package.json"), "w", encoding="utf-8") as f:
        json.dump({"version": "0.4.0"}, f)
    rc, out = precheck(w6)
    check("package.json 版本不符：判 14", rc == 14, f"rc={rc} out={out[-300:]}")

    _, w7 = make_repo("badman")
    with open(os.path.join(w7, "skills", "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"version": "0.4.0"}, f)
    rc, out = precheck(w7)
    check("skills/manifest.json 版本不符：判 14（装完技能版本会错）", rc == 14, f"rc={rc}")

    _, w8 = make_repo("badyml")
    write_latest_yml(w8, version="0.4.0")
    rc, out = precheck(w8)
    check("★ latest.yml 版本不符：判 15（这份包是别版的）", rc == 15, f"rc={rc} out={out[-300:]}")

    _, w9 = make_repo("badsize")
    write_latest_yml(w9, size=EXE_BYTES + 1)
    rc, out = precheck(w9)
    check("★ latest.yml 大小不符：判 15", rc == 15, f"rc={rc} out={out[-300:]}")

    _, w10 = make_repo("noexe")
    os.remove(os.path.join(w10, "desktop", "pkg", EXE))
    rc, out = precheck(w10)
    check("缺 exe：判 15", rc == 15, f"rc={rc} out={out[-300:]}")

    # ── 6. 没有 origin ────────────────────────────────────────────────
    _, w11 = make_repo("noorigin")
    git("remote", "remove", "origin", cwd=w11)
    rc, out = precheck(w11)
    check("没有 origin：判 16，不硬撑", rc == 16, f"rc={rc} out={out[-300:]}")

    # ── 7. 发布后复核（假 gh）─────────────────────────────────────────
    _, w12 = make_repo("verify")
    fake_dir = tmpdir("fakegh")
    fake = os.path.join(fake_dir, "fake_gh.py")
    with open(fake, "w", encoding="utf-8") as f:
        f.write(
            "import json, os, sys\n"
            "print(open(os.environ['FC_FAKE_JSON'], encoding='utf-8').read())\n"
            "sys.exit(int(os.environ.get('FC_FAKE_RC', '0')))\n"
        )
    # ⚠ Windows 路径里全是反斜杠，而 shlex.split 会把 \ 当转义 → 统一换正斜杠
    env = {"FC_GH": (sys.executable + " " + fake).replace("\\", "/")}

    def release_json(ref_exe=EXE_BYTES, ref_block=BLOCK_BYTES, body="# 方寸 v0.4.1\n正文",
                     draft=False, state="uploaded", drop=None):
        assets = []
        for n, s in ((EXE, ref_exe), (BLOCK, ref_block), ("latest.yml", 0)):
            if n == drop:
                continue
            sz = s if n != "latest.yml" else os.path.getsize(
                os.path.join(w12, "desktop", "pkg", "latest.yml"))
            assets.append({"name": n, "size": sz, "state": state})
        return {"tag_name": f"v{VER}", "name": f"方寸 v{VER}", "draft": draft,
                "prerelease": False, "body": body, "assets": assets}

    def verify(payload, rc_override=0):
        p = os.path.join(fake_dir, "release.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        e = dict(env)
        e["FC_FAKE_JSON"] = p
        e["FC_FAKE_RC"] = str(rc_override)
        return run([sys.executable, PRECHECK, w12, VER, "--verify-release",
                    "MUYU46548/fangcun", f"v{VER}"], env=e)

    rc, out, _ = verify(release_json())
    check("复核：资产大小 / state / 说明全对上 → 0", rc == 0, f"rc={rc} out={out[-300:]}")
    check("复核：逐条打印资产字节数（看得见在比什么）",
          f"{EXE} {EXE_BYTES} 字节 uploaded" in out, out[-300:])

    rc, out, _ = verify(release_json(ref_exe=EXE_BYTES - 1))
    check("★ 复核：远端 exe 大小少 1 字节 → 17", rc == 17, f"rc={rc} out={out[-300:]}")
    check("★ 复核：把两侧字节数都报出来", f"≠ 本地 {EXE_BYTES}" in out, out[-300:])

    rc, out, _ = verify(release_json(body="   "))
    check("★ 复核：说明为空 → 17", rc == 17, f"rc={rc} out={out[-300:]}")

    rc, out, _ = verify(release_json(draft=True))
    check("复核：还是草稿 → 17", rc == 17, f"rc={rc} out={out[-300:]}")

    rc, out, _ = verify(release_json(drop=BLOCK))
    check("复核：远端缺 blockmap → 17", rc == 17, f"rc={rc} out={out[-300:]}")

    rc, out, _ = verify(release_json(), rc_override=1)
    check("复核：gh api 本身失败 → 17，不许当成通过", rc == 17, f"rc={rc} out={out[-300:]}")

    # ── 8. 源码守卫：脚本必须真的调 ───────────────────────────────────
    with open(PUBLISH_SH, encoding="utf-8") as f:
        sh = f.read().replace("\r\n", "\n")
    check("★ 守卫：publish-release.sh 调了前置体检（认调用行，不认「文件里出现过这个词」）",
          '"${PRECHECK_ARGS[@]}"' in sh, "")
    check("★ 守卫：体检不过就 exit 掉那个退出码", 'exit "$PRC"' in sh, "")
    check("★ 守卫：--move-tag 会透传给体检",
          "PRECHECK_ARGS+=(--move-tag)" in sh, "")
    check("★ 守卫：publish-release.sh 调了 --verify-release 复核",
          "--verify-release" in sh, "")
    check("守卫：复核失败会 exit，不当成成功", 'exit "$VRC"' in sh, "")

    # 顺序判据必须**先剥掉注释行** —— 头部注释里也写着 `gh release create`（讲事故现场），
    # 直接 find 会撞上注释，判定就成了"注释在代码前面"（第一版就这么假红过一次）。
    code = "\n".join(l for l in sh.split("\n") if not l.lstrip().startswith("#"))
    i_chk = code.find('"${PRECHECK_ARGS[@]}"')
    i_pub = code.find("gh release create")
    check("★ 守卫：体检在 `gh release create` 之前", 0 <= i_chk < i_pub, f"chk={i_chk} pub={i_pub}")
    i_ver = code.find("--verify-release")
    check("★ 守卫：复核在 `gh release create` 之后", i_ver > i_pub > 0, f"ver={i_ver} pub={i_pub}")

    # ── 9. 三处路径必须一致：pack.cjs 写哪 / publish-release.sh 读哪 / release-precheck.py 查哪 ──
    # 为什么要这条：2026-10-27 把输出从 `release` 改成 `pkg` 时，只改了 pack.cjs，
    # 而发版脚本仍读 `release` → 链路当场就断了，但要等**真发版**才暴露（exit 7 缺资产）。
    # 这三条断言就是为了让这种"改一半"在本地先红，而不是在发版时才发现。
    with open(os.path.join(HERE, "pack.cjs"), encoding="utf-8") as f:
        pack_src = f.read()
    with open(PRECHECK, encoding="utf-8") as f:
        pre_src = f.read().replace("\r\n", "\n")
    check("★ 守卫：pack.cjs 输出到 desktop/pkg",
          "path.join(DESKTOP, 'pkg')" in pack_src, "")
    check("★ 守卫：publish-release.sh 从 desktop/pkg 取件",
          "desktop/pkg" in sh, "")
    n_pkg = pre_src.count('"desktop", "pkg"')
    check("★ 守卫：release-precheck.py 两处都查 desktop/pkg", n_pkg == 2, f"count={n_pkg}")

    print(f"\n通过 {PASS} / 失败 {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        for d in TMP:
            shutil.rmtree(d, ignore_errors=True)
    sys.exit(code)
