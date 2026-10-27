# 清理 desktop/release* 旧打包产物（2026-10-27）
#
# 为什么要有这个脚本：electron-builder 每打一次版就新建一个 `release-<ver>` 目录，
# 三个月积了 15 个（3.4GB）。而且这些目录里的 `app.asar` 常被**系统后台进程**
# （OneDrive 同步 / Windows Search 索引）长期持有句柄，正常删除报「正由另一进程使用」，
# 连父目录改名都被拒 —— 用户视角就是"删不掉"。
#
# 用法：
#   pwsh -File scripts/clean-release-dirs.ps1              # 只删，保留最新一个 release 目录
#   pwsh -File scripts/clean-release-dirs.ps1 -DryRun      # 只报告会删什么
#   pwsh -File scripts/clean-release-dirs.ps1 -Keep release-0.4.4
#
# 特点：**逐文件删**，跳过被锁的文件而不是整个目录失败 —— 这样即使 asar 还被占，
# 也能先把 exe / dll / pak 这些大头回收掉（实测 3.4GB 里 3.0GB 能当场删掉）。

param(
  [string]$Keep = '',
  [switch]$DryRun,
  # 锁的持有者实测是 OneDrive 的 FileSyncHelper（服务，Manual）。停它需要管理员。
  # 用户态停不了（报"无法打开服务"），所以这一步只能在提权会话里做。
  [switch]$StopOneDrive,
  # 输出同时写一份到文件（管理员窗口常常一闪而过，看不到内容）
  [string]$LogPath = ''
)

$ErrorActionPreference = 'SilentlyContinue'
function Say([string]$m) {
  Write-Output $m
  if ($LogPath) { $m | Out-File -FilePath $LogPath -Append -Encoding utf8 }
}
if ($LogPath) {
  "" | Out-File -FilePath $LogPath -Encoding utf8
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Say ('运行身份: ' + $(if ($isAdmin) { '管理员' } else { '普通用户（停不了 OneDrive 服务）' }))
  Say ('时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
}
$desktop = Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop'
if (-not (Test-Path $desktop)) { Write-Output "找不到 desktop 目录: $desktop"; exit 1 }

$all = Get-ChildItem $desktop -Directory -Filter 'release*' | Sort-Object Name
if (-not $all) { Say '没有 release* 目录，无需清理。'; exit 0 }

# 没指定 Keep 时保留"最新的那一个"（按名称里的版本号+修改时间）
# 保留**版本号最高**的那一个。
# 不要用 LastWriteTime 挑：`release` 这个老目录今天被碰过（mtime 最新），
# 按 mtime 会保留它、却把 0.4.4 那 515MB 删掉（DryRun 实测踩到）。
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
$dirs = $all | Where-Object { $_.Name -ne $Keep }
if (-not $dirs) { Say "只剩 $Keep，无需清理。"; exit 0 }

Say "保留: $Keep"
Say ('待清: ' + (($dirs | ForEach-Object { $_.Name }) -join ', '))

if ($StopOneDrive) {
  try { Stop-Service FileSyncHelper -Force -ErrorAction Stop; Say '已暂停 OneDrive 文件同步助手（删完会恢复）'; Start-Sleep -Seconds 3 }
  catch { Say ('停 FileSyncHelper 失败（可能不是管理员）: ' + $_.Exception.Message.Split([char]10)[0]) }
}

$freed = 0; $locked = 0; $lockedFiles = @()
foreach ($d in $dirs) {
  Get-ChildItem $d.FullName -Recurse -Force -File | ForEach-Object {
    $len = $_.Length
    if ($DryRun) { $freed += $len; return }
    try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; $freed += $len }
    catch {
      $locked++
      if ($lockedFiles.Count -lt 10) { $lockedFiles += ($_.FullName -replace [regex]::Escape($desktop + '\'), '') }
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
  Say ("仍被占用: $locked 个文件（这些是系统后台进程握着句柄，重启后再跑一次本脚本即可）")
  $lockedFiles | ForEach-Object { Say ('  - ' + $_) }
}
if ($StopOneDrive) {
  try { Start-Service FileSyncHelper -ErrorAction Stop; Say '已恢复 OneDrive 文件同步助手' }
  catch { Say '恢复 FileSyncHelper 失败（重启后会自动起来，不影响使用）' }
}

$left = Get-ChildItem $desktop -Directory -Filter 'release*'
Say '--- 剩余 ---'
$left | ForEach-Object {
  $n = (Get-ChildItem $_.FullName -Recurse -Force -File).Count
  Say ('  ' + $_.Name + '  (' + $n + ' 个文件)')
}
