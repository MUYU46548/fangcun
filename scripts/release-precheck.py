# -*- coding: utf-8 -*-
"""发版前置体检 + 发布后复核 —— publish-release.sh 的判据都搬到这里。

为什么单独一个文件（2026-10-24 踩坑）：
  0.4.1 发版时 `origin/main` 停在 10-18（本地领先 50 笔），而 `gh release create` 会把 tag
  打在**远端 HEAD** 上 —— 资产与说明都对，tag 却指向旧提交，导出源码拿到的是老代码。
  当时脚本没有任何前置检查，"命令退出 0"就掩盖了这件事。

  判据写在 shell 里没法测；写成 Python 就能用**临时 git 仓库 + 真 bare origin + 假 gh**
  逐条跑，每条都有反例自证（`scripts/test/check-release-precheck.py`）。

用法
  # 发版前体检（publish-release.sh 自动调）
  python scripts/release-precheck.py <repo_root> <version> [--move-tag]

  # 发布后复核（拿 gh api 读回来逐项比对，不看命令行"成功"）
  python scripts/release-precheck.py <repo_root> <version> --verify-release <owner/repo> <tag>

  # 测试钩子：把 gh 换成别的命令（默认 `gh`），例：FC_GH="/path/python /tmp/fake_gh.py"
  FC_GH=...

退出码
  0  通过
  10 本地有未推送提交（HEAD 不在 origin/main 上）
  11 本地落后远端
  12 与远端分叉
  13 远端 tag 指向的不是 HEAD（未给 --move-tag）
  14 版本号对不上（desktop/package.json / skills/manifest.json / latest.yml）
  15 待发资产与 latest.yml 对不上（缺文件 / 大小不符）
  16 远端不可达 / 没有 origin / 不是仓库
  17 发布后复核失败（资产缺失、大小不符、说明为空、还是草稿）
"""
import json
import os
import shlex
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

E_OK = 0
E_UNPUSHED = 10
E_BEHIND = 11
E_DIVERGED = 12
E_TAG_STALE = 13
E_VERSION = 14
E_ASSET = 15
E_REMOTE = 16
E_VERIFY = 17

ASSET_NAMES = ("Fangcun-Setup.{v}.exe", "Fangcun-Setup.{v}.exe.blockmap", "latest.yml")


def log(msg=""):
    print(msg, flush=True)


def run(cmd, cwd=None, timeout=120):
    """跑一条命令，返回 (rc, stdout, stderr)。不抛异常 —— 由调用方判 rc。"""
    try:
        p = subprocess.run(cmd, cwd=cwd, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "", str(e)
    enc = "utf-8"
    return (p.returncode,
            p.stdout.decode(enc, "replace").strip(),
            p.stderr.decode(enc, "replace").strip())


def git(repo, *args, **kw):
    rc, out, err = run(["git", "-C", repo] + list(args), timeout=kw.get("timeout", 120))
    return rc, out, err


def sha4010(repo, ref):
    rc, out, _ = git(repo, "rev-parse", ref)
    return out if rc == 0 else ""


def short(sha):
    return sha[:7] if sha else "(无)"


# ── 版本号与资产 ────────────────────────────────────────────────────────

def read_version_file(repo, rel):
    """从 JSON 里抠 version（package.json / skills/manifest.json）。"""
    try:
        with open(os.path.join(repo, rel), encoding="utf-8") as f:
            return str(json.load(f).get("version", "")).strip()
    except (OSError, ValueError):
        return ""


def parse_latest_yml(path):
    """latest.yml 只认三个字段：version / files[0].url / files[0].size。

    不引 yaml 依赖（仓库零外部依赖），按行取首次出现即止 —— 这份文件是
    electron-builder 生成的固定形状，`sha512:` 之类的重复键不影响我们。
    """
    out = {"version": None, "url": None, "size": None}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if out["version"] is None and s.startswith("version:"):
                    out["version"] = s.split(":", 1)[1].strip().strip("'\"")
                elif out["url"] is None and s.startswith("- url:"):
                    out["url"] = s.split(":", 1)[1].strip().strip("'\"")
                elif out["size"] is None and s.startswith("size:"):
                    try:
                        out["size"] = int(s.split(":", 1)[1].strip())
                    except ValueError:
                        pass
    except OSError:
        return None
    return out


def check_versions(repo, ver):
    """返回 (rc, [问题])。查三处：应用版本、技能清单版本、要发的那份 latest.yml。"""
    bad = []
    pkg = read_version_file(repo, os.path.join("desktop", "package.json"))
    man = read_version_file(repo, os.path.join("skills", "manifest.json"))
    if pkg != ver:
        bad.append(f"desktop/package.json 是 {pkg or '(读不到)'}，要发的是 {ver}")
    if man != ver:
        bad.append(f"skills/manifest.json 是 {man or '(读不到)'}，要发的是 {ver}（装完技能版本会对不上）")
    return (E_VERSION if bad else E_OK), bad


def check_assets(repo, ver):
    """资产必须齐，且 latest.yml 描述的就是这份 exe（版本 + 文件名 + 字节数）。

    这一段防的是"包里是上一版" —— 0.4.0 就发过一次说明书和包对不上的包。
    """
    rel_dir = os.path.join(repo, "desktop", "release")
    bad = []
    sizes = {}
    for pat in ASSET_NAMES:
        name = pat.format(v=ver)
        p = os.path.join(rel_dir, name)
        if not os.path.isfile(p):
            bad.append(f"缺资产 {p}")
            continue
        sizes[name] = os.path.getsize(p)
    yml = parse_latest_yml(os.path.join(rel_dir, "latest.yml"))
    if yml is not None and not bad:
        if yml["version"] != ver:
            bad.append(f"latest.yml 写的是版本 {yml['version']}，要发的是 {ver} —— 这份包是别版的")
        exe = "Fangcun-Setup.{v}.exe".format(v=ver)
        if yml["url"] != exe:
            bad.append(f"latest.yml 指向 {yml['url']}，不是 {exe}")
        if yml["size"] != sizes.get(exe):
            bad.append(f"latest.yml 记的大小 {yml['size']} ≠ 实际 {sizes.get(exe)} 字节")
    return (E_ASSET if bad else E_OK), bad, sizes


# ── 远端同步与 tag ─────────────────────────────────────────────────────

def fetch_origin_main(repo):
    """只抓 main 到一个明确的名字 —— 不依赖 bare 仓库的 HEAD 指向。

    ⚠ 陷阱：bare 仓库默认 HEAD 是 master，`git fetch origin main` 在旧 git 上会去写
    FETCH_HEAD 而不更新 origin/main，判据就永远读到旧值。所以写全 refspec。
    """
    return git(repo, "fetch", "--quiet", "--no-tags", "origin",
               "+refs/heads/main:refs/remotes/origin/main", timeout=180)


def remote_tag_sha(repo, tag):
    rc, out, _ = git(repo, "ls-remote", "--tags", "origin", f"refs/tags/{tag}", timeout=120)
    if rc != 0 or not out:
        return ""
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1].endswith(f"refs/tags/{tag}"):
            return parts[0]
    return ""


def check_sync(repo):
    """返回 (rc, 诊断行, head_sha)。判据 = HEAD 必须与 origin/main 同一个提交。

    不只看"领先/落后"，因为这决定了 tag 会落在哪个提交上：gh release create 打的是
    远端 HEAD，本地怎么排都不影响它。所以唯一安全的判据就是"两边是同一个 commit"。
    """
    rc, out, err = git(repo, "rev-parse", "--is-inside-work-tree")
    if rc != 0 or out.strip() != "true":
        return E_REMOTE, [f"不是一个 git 仓库：{repo}"], ""
    rc, out, _ = git(repo, "remote", "get-url", "origin")
    if rc != 0 or not out:
        return E_REMOTE, ["没有 origin 远端"], ""
    rc, _, err = fetch_origin_main(repo)
    if rc != 0:
        return E_REMOTE, [f"抓不到 origin/main（网络或凭据问题）：{err[:200]}"], ""

    head = sha4010(repo, "HEAD")
    remote = sha4010(repo, "refs/remotes/origin/main")
    if not head or not remote:
        return E_REMOTE, ["读不到 HEAD 或 origin/main"], head or ""
    if head == remote:
        return E_OK, [f"HEAD 与 origin/main 同一提交（{short(head)}）"], head

    rc, out, _ = git(repo, "rev-list", "--left-right", "--count", f"{remote}...{head}")
    ahead = behind = -1
    if rc == 0 and out:
        try:
            behind, ahead = (int(x) for x in out.split()[:2])
        except ValueError:
            pass
    detail = f"本地 {short(head)} / 远端 origin/main {short(remote)}（领先 {ahead} 笔 / 落后 {behind} 笔）"
    if ahead > 0 and behind > 0:
        return E_DIVERGED, [detail, "两边都有对方没有的提交 —— 先合并再发版"], head
    if ahead > 0:
        return E_UNPUSHED, [detail,
                            "本地提交没推上去。gh release create 会把 tag 打在**远端 HEAD** 上，",
                            "于是资产是新的、tag 指向旧代码。先 `git push origin main` 再发版。"], head
    if behind > 0:
        return E_BEHIND, [detail, "本地落后远端 —— 先 `git pull --ff-only` 再发版"], head
    return E_DIVERGED, [detail, "无法判定领先/落后（rev-list 读不出来），按危险处理"], head


def check_tag(repo, tag, head, move_tag):
    """远端 tag 若已存在，必须指向 HEAD；给了 --move-tag 就搬过去再核一遍。"""
    cur = remote_tag_sha(repo, tag)
    if not cur:
        return E_OK, [f"远端还没有 {tag}（将在发布时创建）"]
    if cur == head:
        return E_OK, [f"远端 {tag} 已指向 HEAD（{short(head)}）—— 重发同一版，幂等"]
    if not move_tag:
        # 两种"指向不对"要分开说，否则提示会骗人：
        # ① tag 在 HEAD 身后（发版之后又提交了）→ 正常现象，重发才需要 --move-tag；
        # ② tag 与 HEAD 不在一条线上 → 真危险（下载到源码旧、资产新的版本）。
        is_anc = git(repo, "merge-base", "--is-ancestor", cur, head)[0] == 0
        rc_n, out_n, _ = git(repo, "rev-list", "--count", f"{cur}..{head}")
        n = out_n if rc_n == 0 and out_n.isdigit() else ""
        if is_anc and n:
            return E_TAG_STALE, [
                f"远端 {tag} 指向 {short(cur)} —— HEAD 在它之后又动了 {n} 笔（发版后又提交了）",
                "重发同一个版本号会把这个 tag 的指向改掉。确认要重发就加 --move-tag；",
                "如果是新东西要发，换个版本号，别覆盖已经发出去的那一版。",
            ]
        return E_TAG_STALE, [
            f"远端 {tag} 指向 {short(cur)}，与 HEAD {short(head)} 不在一条线上",
            "这会让人下载到源码旧、资产新的版本。确认要搬过去就加 --move-tag：",
            "    bash scripts/publish-release.sh <版本> --move-tag",
        ]
    log(f"[tag] 远端 {tag} 在 {short(cur)} → 搬到 HEAD {short(head)}")
    rc, _, err = git(repo, "tag", "-f", tag, head)
    if rc != 0:
        return E_TAG_STALE, [f"本地改 tag 失败：{err[:200]}"]
    rc, _, err = git(repo, "push", "--force", "origin", f"refs/tags/{tag}", timeout=180)
    if rc != 0:
        return E_TAG_STALE, [f"强推 tag 失败：{err[:200]}"]
    now = remote_tag_sha(repo, tag)
    if now != head:
        return E_TAG_STALE, [f"推完再读还是 {short(now)} —— 没搬成功"]
    return E_OK, [f"远端 {tag} 已搬到 HEAD（{short(head)}）"]


# ── 发布后复核 ─────────────────────────────────────────────────────────

def gh_api_release(slug, tag):
    """用 gh api 读回 Release 元数据。FC_GH 是测试钩子（可带参数，shlex 切）。"""
    cmd = shlex.split(os.environ.get("FC_GH") or "gh")
    cmd += ["api", f"repos/{slug}/releases/tags/{tag}"]
    rc, out, err = run(cmd, timeout=120)
    if rc != 0:
        return None, f"读不到 Release（gh api 退出 {rc}）：{err[:200] or out[:200]}"
    try:
        return json.loads(out), ""
    except ValueError as e:
        return None, f"gh api 返回的不是 JSON：{e}"


def verify_release(repo, ver, slug, tag):
    """资产 state / 大小 / 说明 逐项与本地比对 —— 不看"命令成功"，看远端真有什么。"""
    data, err = gh_api_release(slug, tag)
    if data is None:
        return E_VERIFY, [err]
    bad, ok = [], []
    if data.get("draft"):
        bad.append("Release 还是草稿（draft=true）")
    body = (data.get("body") or "").strip()
    if not body:
        bad.append("Release 说明是空的 —— 发布说明没上去")
    else:
        ok.append(f"说明 {len(body)} 字")

    rel_dir = os.path.join(repo, "desktop", "release")
    got = {a.get("name"): a for a in (data.get("assets") or [])}
    for pat in ASSET_NAMES:
        name = pat.format(v=ver)
        a = got.get(name)
        if a is None:
            bad.append(f"远端缺资产 {name}")
            continue
        local = os.path.join(rel_dir, name)
        if not os.path.isfile(local):
            bad.append(f"本地反而没有 {name}，没法比对")
            continue
        want = os.path.getsize(local)
        if a.get("size") != want:
            bad.append(f"{name} 远端 {a.get('size')} 字节 ≠ 本地 {want}")
            continue
        if a.get("state") != "uploaded":
            bad.append(f"{name} 状态是 {a.get('state')}，不是 uploaded")
            continue
        ok.append(f"{name} {want} 字节 uploaded")
    extra = sorted(set(got) - {p.format(v=ver) for p in ASSET_NAMES})
    if extra:
        ok.append(f"另有 {len(extra)} 个历史资产（{', '.join(extra[:3])}…）")
    if bad:
        return E_VERIFY, bad
    return E_OK, ok


# ── 入口 ───────────────────────────────────────────────────────────────

def main(argv):
    if len(argv) < 2:
        log("用法: python scripts/release-precheck.py <repo_root> <version> [--move-tag]")
        return 2
    repo = os.path.abspath(argv[0])
    ver = argv[1]
    rest = argv[2:]
    move_tag = "--move-tag" in rest
    tag = "v" + ver

    if "--verify-release" in rest:
        i = rest.index("--verify-release")
        if len(rest) < i + 3:
            log("用法: --verify-release <owner/repo> <tag>")
            return 2
        rc, lines = verify_release(repo, ver, rest[i + 1], rest[i + 2])
        head = "发布后复核"
    else:
        rc, lines = E_OK, []
        # ① 版本号与资产（纯本地，最先查，最便宜）
        c, bad = check_versions(repo, ver)
        lines += (["版本号一致（package.json / skills/manifest.json）"] if c == E_OK else bad)
        rc = rc or c
        c, bad, _ = check_assets(repo, ver)
        if c == E_OK:
            lines.append("待发资产齐、latest.yml 与这份 exe 对得上")
        else:
            lines += bad
        rc = rc or c
        # ② 远端同步 + tag（要联网）
        c, diag, head = check_sync(repo)
        lines += diag
        rc = rc or c
        if c == E_OK:
            c, diag = check_tag(repo, tag, head, move_tag)
            lines += diag
            rc = rc or c
        head = "发版前置体检"

    for line in lines:
        log("  " + line)
    log(("OK " if rc == E_OK else "FAIL ") + head + ("" if rc == E_OK else f"（退出码 {rc}）"))
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
