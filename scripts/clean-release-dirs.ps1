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
  [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'
$desktop = Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop'
if (-not (Test-Path $desktop)) { Write-Output "找不到 desktop 目录: $desktop"; exit 1 }

$all = Get-ChildItem $desktop -Directory -Filter 'release*' | Sort-Object Name
if (-not $all) { Write-Output '没有 release* 目录，无需清理。'; exit 0 }

# 没指定 Keep 时保留"最新的那一个"（按名称里的版本号+修改时间）
if (-not $Keep) {
  $Keep = ($all | Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name
}
$dirs = $all | Where-Object { $_.Name -ne $Keep }
if (-not $dirs) { Write-Output "只剩 $Keep，无需清理。"; exit 0 }

Write-Output "保留: $Keep"
Write-Output ('待清: ' + (($dirs | ForEach-Object { $_.Name }) -join ', '))

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

Write-Output ('释放: ' + [math]::Round($freed / 1MB, 1) + ' MB')
if ($locked -gt 0) {
  Write-Output ("仍被占用: $locked 个文件（这些是系统后台进程握着句柄，重启后再跑一次本脚本即可）")
  $lockedFiles | ForEach-Object { Write-Output ('  - ' + $_) }
}
$left = Get-ChildItem $desktop -Directory -Filter 'release*'
Write-Output '--- 剩余 ---'
$left | ForEach-Object {
  $n = (Get-ChildItem $_.FullName -Recurse -Force -File).Count
  Write-Output ('  ' + $_.Name + '  (' + $n + ' 个文件)')
}
