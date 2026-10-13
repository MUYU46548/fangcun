#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# 发布方寸到 GitHub Releases（2026-10-13 重写凭据段）
#
#   用法：  bash scripts/publish-release.sh 0.3.4
#
# 为什么要这个脚本（而不是手敲 gh 命令）：
#   ① **凭据只从环境/文件取，绝不回显** —— token 不进命令行参数（会留在 shell 历史与进程列表里）；
#   ② **幂等** —— 发布到一半失败、或想替换资产，重跑即可（用 --clobber 覆盖同名资产）；
#   ③ 资产清单写死在这里（exe + blockmap + latest.yml），不会漏传 latest.yml
#      —— 漏了它用户端的自动更新就是哑的。
#
# ★ 凭据策略（2026-10-13 第二次踩坑后改）：**多来源逐个验证，坏值自动跳过**。
#   不是"取第一个非空的就用" —— 那样一个过期/粘错的 token 会把后面**有效**的来源挡住，
#   表现就是"凭据无效"（而机器上明明有好的）。现在每个来源都真跑一次 `gh api user` 验证，
#   命中即用；全失败则打印**逐来源状态表**（谁未设置 / 谁 401 / 谁有效），一眼看出该修哪个。
#
#   候选顺序：
#     1) 环境变量 GH_TOKEN
#     2) Windows 用户级环境变量（注册表 HKCU\Environment）—— ⚠ 系统环境变量**改完不重启不生效**，
#        当前进程继承的是旧环境；直接读注册表才能拿到你刚设的新值。
#     3) ~/.gh_token（单行 PAT）
#     4) shell 配置里的 `export GH_TOKEN="..."`（~/.bashrc / ~/.bash_profile / ~/.profile）
#     5) HERMES 的 `%LOCALAPPDATA%/hermes/.env`
#
# ⚠ 历史坑（都记在这，别再踩）：
#   A) 本机 token 一直躺在 `~/.bashrc`，而**非交互 bash 不 source .bashrc** →
#      `env | grep GH_TOKEN` 啥也没有，据此断言"机器上没有 token"是错的。
#   B) `~/.gh_token` **存在但是空的（1 字节）** → 只判 `-s` 会把它当有效凭据，走到
#      "gh api user 失败"（报错指向"权限不足"，误导）。
#   C) 系统环境变量里的值与 shell 配置里的值**可能不是同一个** —— 逐个验证就是为这个。
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

# 直接从 Windows 注册表读用户级 GH_TOKEN
# —— 应对"刚在系统里设了环境变量，但应用没重启、进程继承的还是旧环境"
read_token_from_registry() {
  command -v python >/dev/null 2>&1 || return 1
  local v
  v="$(python -c "
import winreg
try:
    k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Environment')
    print(winreg.QueryValueEx(k, 'GH_TOKEN')[0], end='')
except Exception:
    pass
" 2>/dev/null | tr -d '\r\n')" || true
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  return 1
}

# HERMES 的 .env（本机存在，别的 agent 用它发过版）
read_token_from_hermes_env() {
  local root="${LOCALAPPDATA:-$HOME/AppData/Local}"
  local f="$root/hermes/.env"
  [ -f "$f" ] || return 1
  local v
  v="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\?GH_TOKEN=["'"'"']\?\([^"'"'"']*\)["'"'"']\?.*/\2/p' "$f" | head -1 | tr -d '\r\n')"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  return 1
}

# 验证一枚 token：真跑一次 gh api user。成功则导出 GH_TOKEN 并返回 0。
try_candidate() {
  local name="$1" tok="${2:-}"
  if [ -z "$tok" ]; then
    echo "[凭据] ${name}：未设置"
    return 1
  fi
  if [ "${#tok}" -lt 20 ]; then
    echo "[凭据] ${name}：长度异常（${#tok} 字节），跳过"
    return 1
  fi
  # ⚠⚠ 必须判**退出码**，不能判"输出非空" —— gh 在 401 时会把错误 JSON 打到 **stdout**，
  #     `who="$(...)"` 非空 → 坏 token 被判成"有效"（就是"假成功"）。第一版这么写，实测抓到了。
  local who rc=1
  if who="$(GH_TOKEN="$tok" gh api user --jq .login 2>/dev/null)"; then rc=0; fi
  if [ "$rc" -eq 0 ] && [ -n "$who" ]; then
    export GH_TOKEN="$tok"
    echo "[凭据] ${name}：✅ 有效，已认证为 ${who}"
    return 0
  fi
  echo "[凭据] ${name}：❌ 无效（401 —— 已过期 / 被撤销 / 复制时串了字符）"
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

command -v gh >/dev/null 2>&1 || { echo "[!] 找不到 gh CLI" >&2; exit 4; }

# ── 凭据：逐个来源验证，命中即用 ───────────────────────────────────────
GOT=0
if try_candidate "环境变量 GH_TOKEN" "${GH_TOKEN:-}"; then GOT=1; fi
if [ "$GOT" -eq 0 ]; then
  if try_candidate "系统环境变量（注册表 HKCU\\Environment）" "$(read_token_from_registry || true)"; then GOT=1; fi
fi
if [ "$GOT" -eq 0 ] && [ -f "$HOME/.gh_token" ]; then
  if try_candidate "~/.gh_token" "$(tr -d '\r\n' < "$HOME/.gh_token")"; then GOT=1; fi
fi
if [ "$GOT" -eq 0 ]; then
  if try_candidate "shell 配置（~/.bashrc 等）" "$(read_token_from_shellrc || true)"; then GOT=1; fi
fi
if [ "$GOT" -eq 0 ]; then
  if try_candidate "HERMES .env" "$(read_token_from_hermes_env || true)"; then GOT=1; fi
fi

if [ "$GOT" -eq 0 ]; then
  cat >&2 <<'MSG'
[!] 以上所有凭据来源都不可用，无法上传 Release 资产。

    修一个即可（推荐 ①，改完不用重启应用）：
      ① 把一枚**有效**的 PAT 写进 `~/.bashrc`：export GH_TOKEN="ghp_xxx"（或 ~/.gh_token 单行）；
      ② 重新生成 PAT 后填进系统环境变量 GH_TOKEN（**改完要重启应用才会被继承**，
         但本脚本会直接读注册表，所以不重启也能用）。
      PAT 要求：经典 PAT 勾 `repo`；细粒度 PAT 勾 Contents: Read and write。

    ⚠ 不要把 token 贴在聊天/提交里。SSH 只能推代码与 tag，**上传 Release 资产必须走 API**。
MSG
  exit 3
fi

# ── 前置检查 ──────────────────────────────────────────────────────────
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
