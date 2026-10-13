#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# 发布方寸到 GitHub Releases（2026-10-13）
#
#   用法：  bash scripts/publish-release.sh 0.3.4
#
# 为什么要这个脚本（而不是手敲 gh 命令）：
#   ① **凭据只从环境/文件取，绝不回显** —— token 不进命令行参数（会留在 shell 历史与进程列表里）；
#   ② **幂等** —— 发布到一半失败、或想替换资产，重跑即可（用 --clobber 覆盖同名资产）；
#   ③ 资产清单写死在这里（exe + blockmap + latest.yml），不会漏传 latest.yml
#      —— 漏了它用户端的自动更新就是哑的。
#
# 凭据来源（按优先级）：
#   1) 环境变量 GH_TOKEN
#   2) ~/.gh_token（单行 PAT）
#   3) ~/.bashrc / ~/.bash_profile 里的 `export GH_TOKEN="..."` ← **本机的真实来源**
#
# ⚠ 2026-10-13 踩的坑：这台机器的 token 一直躺在 `~/.bashrc` 里，而**非交互 bash 不 source .bashrc**，
#   于是 `env | grep GH_TOKEN` 啥也没有、`gh auth status` 报"未登录" —— 我据此下了"机器上没有 token"的
#   错误结论。其实 `~/.gitconfig` 早就写着 `helper = gh auth git-credential`，那本身就是"gh 是登录着的"的信号。
#   所以这里显式去 shell 配置里捞，而不是只信环境变量。
#
# ⚠ 本脚本不打印 token，也不把它写进任何文件。
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

# 从 shell 配置里抠 `export GH_TOKEN="..."`（只取第一处，去掉引号与 CR）
read_token_from_shellrc() {
  local f
  for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$f" ] || continue
    local v
    v="$(sed -n 's/^[[:space:]]*export[[:space:]]\{1,\}GH_TOKEN=["'"'"']\?\([^"'"'"']*\)["'"'"']\?.*/\1/p' "$f" | head -1 | tr -d '\r\n')"
    if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  done
  return 1
}

VER="${1:-}"
if [ -z "$VER" ]; then
  echo "用法: bash scripts/publish-release.sh <版本号>   例: bash scripts/publish-release.sh 0.3.4" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="v${VER}"
REL_DIR="$REPO_ROOT/desktop/release"
NOTES="$REPO_ROOT/docs/${VER}-发布说明.md"

# ── 凭据 ──────────────────────────────────────────────────────────────
if [ -n "${GH_TOKEN:-}" ]; then
  echo "[凭据] 用环境变量 GH_TOKEN"
elif [ -s "$HOME/.gh_token" ] && [ "$(tr -d '\r\n[:space:]' < "$HOME/.gh_token" | wc -c)" -ge 20 ]; then
  # ⚠ 这个文件本机**存在但是空的**（1 字节）—— 只判 `-s` 会把它当有效凭据，
  #    然后一路走到 "gh api user 失败"（报错指向"权限不足"，误导）。所以额外判长度。
  GH_TOKEN="$(tr -d '\r\n' < "$HOME/.gh_token")"
  export GH_TOKEN
  echo "[凭据] 用 ~/.gh_token（已读入环境，不回显）"
elif SRC_TOKEN="$(read_token_from_shellrc)"; then
  GH_TOKEN="$SRC_TOKEN"
  export GH_TOKEN
  echo "[凭据] 用 shell 配置里的 GH_TOKEN（~/.bashrc 等，已读入环境，不回显）"
else
  cat >&2 <<'MSG'
[!] 没有可用的 GitHub 凭据，无法上传 Release 资产。

    二选一：
      A) 把一枚有 repo 权限的 PAT（经典 PAT 勾 repo，或细粒度 PAT 勾 Contents: Read and write）
         写进 `~/.bashrc`（`export GH_TOKEN="..."`）或 `~/.gh_token`（单行），再重跑本脚本；
      B) 跑一次 `gh auth login`（交互式，一次即可），再用 GH_TOKEN="$(gh auth token)" 重跑。

    ⚠ 不要把 token 直接贴在聊天/提交里。SSH 只能推代码与 tag，**上传 Release 资产必须走 API**。
MSG
  exit 3
fi

# ── 前置检查 ──────────────────────────────────────────────────────────
command -v gh >/dev/null 2>&1 || { echo "[!] 找不到 gh CLI" >&2; exit 4; }

WHO="$(gh api user --jq .login 2>/dev/null || true)"
if [ -z "$WHO" ]; then
  echo "[!] 凭据无效（gh api user 失败）。请确认 PAT 未过期且权限足够。" >&2
  exit 5
fi
echo "[凭据] 已认证为: $WHO"

[ -f "$NOTES" ] || { echo "[!] 找不到发布说明: $NOTES" >&2; exit 6; }

ASSETS=()
for f in "Fangcun-Setup.${VER}.exe" "Fangcun-Setup.${VER}.exe.blockmap" "latest.yml"; do
  if [ -f "$REL_DIR/$f" ]; then ASSETS+=("$REL_DIR/$f"); else echo "[!] 缺资产: $REL_DIR/$f" >&2; exit 7; fi
done
echo "[资产] $(printf '%s ' "${ASSETS[@]##*/}")"

# ── 建 / 更新 Release ─────────────────────────────────────────────────
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "[发布] $TAG 已存在 → 更新说明并覆盖资产"
  gh release edit "$TAG" --title "方寸 ${TAG}" --notes-file "$NOTES"
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
else
  echo "[发布] 新建 $TAG"
  gh release create "$TAG" --title "方寸 ${TAG}" --notes-file "$NOTES" "${ASSETS[@]}"
fi

echo "[完成] https://github.com/MUYU46548/fangcun/releases/tag/${TAG}"
