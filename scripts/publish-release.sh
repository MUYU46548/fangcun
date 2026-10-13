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
#   2) ~/.gh_token（单行 PAT；该文件就在本机，此前是空的）
#
# ⚠ 本脚本不打印 token，也不把它写进任何文件。
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

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
else
  TOKEN_FILE="$HOME/.gh_token"
  # ⚠ 本机这个文件是**存在但空**的（1 字节）—— 只判 `-s` 会把它当有效凭据，
  #    然后一路走到 "gh api user 失败"（报错指向"权限不足"，误导）。所以额外判长度。
  if [ -s "$TOKEN_FILE" ] && [ "$(tr -d '\r\n[:space:]' < "$TOKEN_FILE" | wc -c)" -ge 20 ]; then
    GH_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
    export GH_TOKEN
    echo "[凭据] 用 $TOKEN_FILE（已读入环境，不回显）"
  else
    cat >&2 <<'MSG'
[!] 没有可用的 GitHub 凭据，无法上传 Release 资产。

    二选一：
      A) 把一枚有 repo 权限的 PAT（经典 PAT 勾 repo，或细粒度 PAT 勾 Contents: Read and write）
         写进 ~/.gh_token（单行，不要多余空行），然后重跑本脚本；
      B) 跑一次 `gh auth login`（交互式，一次即可），再用 GH_TOKEN="$(gh auth token)" 重跑。

    ⚠ 不要把 token 直接贴在聊天/提交里。SSH 只能推代码与 tag，**上传 Release 资产必须走 API**。
MSG
    exit 3
  fi
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
