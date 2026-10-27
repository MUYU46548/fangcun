# 清理 desktop/ 下**历史堆积**的旧打包产物（release-<ver>/、release/）
#
# 为什么要有这个脚本：electron-builder 曾经每打一次版就新建一个 `release-<ver>` 目录，
# 三个月积了 15 个（3.4GB），其中 6 个是中断留下的半成品（只有 app.asar）。
# 2026-10-27 起流程改成**固定单目录** `desktop/pkg`（见 scripts/pack.cjs），不再堆积；
# 本脚本只用于清理**历史垃圾**。
#
# ⚠ `desktop/pkg` 是**发版取件目录**（`publish-release.sh` / `release-precheck.py` 都从这里取资产），
#   本脚本**永远不碰它**。pkg 里的旧版安装包请手动挑文件删。
#   历史教训：我一度把 pkg 当"过渡期废弃目录"写进清理目标，差点把待发的包删了。
#
# 为什么"删不掉" —— 2026-10-27 用 Windows Restart Manager 点名的结论，不要再猜：
#   持有者 = **文件索引器**（实测是 WorkBuddy 的后台 daemon，
#   `daemon-app-server-entry.js --stdio`），它把工作区里所有 `*.asar` 打开且不释放。
#   · 删除 → err 32 共享冲突；目录改名 → err 5 拒绝访问；**重启电脑无效**（开机又扫一遍）。
#   · 已逐个排除：OneDrive FileSyncHelper、Windows Search(WSearch)、Defender、火绒、
#     权限(ACL 有 Modify)、junction、文件系统(E 盘是本地 NTFS/Healthy)。
#     那两个服务停过，结果 `释放 0 MB` —— 停它们纯属浪费，已从脚本里删掉。
#   → **正解不是停服务，是把索引器退出**。脚本开头会检测并提醒。
#   ⚠ 退出索引器后删除**不需要管理员权限**。
#
# 用法：
#   powershell -File scripts/clean-release-dirs.ps1                # 只删，保留最新一个
#   powershell -File scripts/clean-release-dirs.ps1 -DryRun        # 只报告会删什么
#   powershell -File scripts/clean-release-dirs.ps1 -Keep release-0.4.4
#
# 特点：**逐文件删**，跳过被锁的文件而不是整个目录失败 —— 这样即使 asar 还被占，
# 也能先把 exe / dll / pak 这些大头回收掉（实测 3.4GB 里 3.0GB 能当场删掉）。

param(
  [string]$Keep = '',
  [switch]$DryRun,
  # 输出同时写一份到文件（窗口常常一闪而过，看不到内容）
  [string]$LogPath = ''
)

$ErrorActionPreference = 'SilentlyContinue'
function Say([string]$m) {
  Write-Output $m
  if ($LogPath) { $m | Out-File -FilePath $LogPath -Append -Encoding Default }
}
if ($LogPath) {
  "" | Out-File -FilePath $LogPath -Encoding Default
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Say ('运行身份: ' + $(if ($isAdmin) { '管理员' } else { '普通用户（本脚本不需要管理员）' }))
  Say ('时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
}
$desktop = Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop'
if (-not (Test-Path $desktop)) { Write-Output "找不到 desktop 目录: $desktop"; exit 1 }

# 只清**历史堆积**的 `release*`（`release-<ver>/`、`release/`）。
# ⚠ `desktop/pkg` 是**发版取件目录**（`pack.cjs` 的输出，`publish-release.sh` 从这里取资产），
#   **永远不清理**。要清 pkg 里的旧版包，手动挑文件删。
$all = Get-ChildItem $desktop -Directory | Where-Object {
  $_.Name -like 'release*'
} | Sort-Object Name
if (-not $all) { Say '没有需要清理的历史堆积目录（release*）。'; exit 0 }

# 没指定 Keep 时保留**版本号最高**的那一个 `release*`（安全阀：万一有人用 release-<ver> 打过包）。
# 不要用 LastWriteTime 挑：`release` 这个老目录曾被碰过（mtime 最新），
# 按 mtime 会保留它、却把带版本号的新包删掉（DryRun 实测踩到）。
# 只认 x.y.z；`release` / `release-035` 这类没有版本号的算 0.0.0（最旧）。
if (-not $Keep) {
  $ranked = $all | ForEach-Object {
    $v = [version]'0.0.0'
    if ($_.Name -match '(\d+)\.(\d+)\.(\d+)') {
      try { $v = [version]("$($Matches[1]).$($Matches[2]).$($Matches[3])") } catch { }
    }
    [pscustomobject]@{ Name = $_.Name; Ver = $v; Mtime = $_.LastWriteTime }
  } | Sort-Object Ver, Mtime -Descending
  $Keep = $ranked[0].Name
}
$dirs = $all | Where-Object { -not $Keep -or $_.Name -ne $Keep }
if (-not $dirs) { Say "只剩 $Keep，无需清理。"; exit 0 }

Say ('保留: ' + $(if ($Keep) { $Keep } else { '（无）' }))
Say ('待清: ' + (($dirs | ForEach-Object { $_.Name }) -join ', '))

# ── 先看谁在锁 ────────────────────────────────────────────────────────
# 2026-10-27 用 Windows Restart Manager 点名（`RmStartSession`/`RmRegisterResources`/`RmGetList`）：
# 唯一持有者 = WorkBuddy 的后台 daemon（`daemon-app-server-entry.js --stdio`），
# 它把工作区里所有 `*.asar` 打开且不释放。**不是** OneDrive / Windows Search —— 那两个
# 停过，结果 `释放 0 MB`，相关逻辑已删除（停服务只会白要管理员权限）。
$holderNames = @('WorkBuddy')
$holders = @()
foreach ($n in $holderNames) {
  $holders += @(Get-Process -Name $n -ErrorAction SilentlyContinue)
}
if ($holders.Count -gt 0 -and -not $DryRun) {
  Say ''
  Say ('⚠ 检测到可能正在索引工作区的进程（' + $holders.Count + ' 个）：')
  # 只列前 3 个：一个 Electron 应用常有 8-10 个进程，全列会把屏幕刷满
  foreach ($p in ($holders | Select-Object -First 3)) { Say ('    ' + $p.ProcessName + '.exe  (PID ' + $p.Id + ')') }
  if ($holders.Count -gt 3) { Say ('    …另有 ' + ($holders.Count - 3) + ' 个同名进程') }
  Say '  它们会持有 desktop 下 *.asar 的句柄 → 删除报「正由另一进程使用」。'
  Say '  本脚本**不会**中止它们；若下面出现"仍被占用"，请手动彻底退出后再跑一次。'
  Say ''
}

$freed = 0; $locked = 0; $lockedFiles = @()
foreach ($d in $dirs) {
  Get-ChildItem $d.FullName -Recurse -Force -File | ForEach-Object {
    $file = $_
    $len = $file.Length
    if ($DryRun) { $freed += $len; return }
    try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop; $freed += $len }
    catch {
      $locked++
      # ⚠ catch 块里的 $_ 是 ErrorRecord，不是文件对象 —— 第一版用 $_ 取路径，清单永远是空行
      if ($lockedFiles.Count -lt 10) { $lockedFiles += ($file.FullName -replace [regex]::Escape($desktop + '\'), '') }
    }
  }
  # 空目录收拾掉（被锁文件所在目录会留下来，这是正常的）
  Get-ChildItem $d.FullName -Recurse -Directory -Force |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object { if (-not (Get-ChildItem $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force } }
  if (-not $DryRun -and -not (Get-ChildItem $d.FullName -Force)) { Remove-Item -LiteralPath $d.FullName -Force }
}

Say ('释放: ' + [math]::Round($freed / 1MB, 1) + ' MB')
if ($locked -gt 0) {
  Say ("仍被占用: $locked 个文件 —— 持有者是**文件索引器**（见文件头），")
  Say ("  把索引器彻底退出（托盘右键退出，不是关窗口）后再跑一次本脚本即可。")
  $lockedFiles | ForEach-Object { Say ('  - ' + $_) }
}

$left = Get-ChildItem $desktop -Directory | Where-Object { $_.Name -like 'release*' }
Say '--- 剩余历史目录 ---'
if (-not $left) { Say '  （无）' }
$left | ForEach-Object {
  $n = (Get-ChildItem $_.FullName -Recurse -Force -File).Count
  Say ('  ' + $_.Name + '  (' + $n + ' 个文件)')
}
$pkg = Join-Path $desktop 'pkg'
if (Test-Path $pkg) {
  $n = (Get-ChildItem $pkg -Recurse -Force -File).Count
  Say ('--- 发版取件目录 pkg：' + $n + ' 个文件（本脚本不碰，旧版请手动挑删）---')
}
