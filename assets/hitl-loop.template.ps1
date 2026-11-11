<#
hitl-loop.template.ps1 —— 复现回路模板（2026-11-11 · 卡 task-20261108-013）

为什么有 .ps1 版：契约 REV-006 钉死「运行环境 = Windows 11 桌面，Linux 完全不在考虑范围」。
原模板来自 diagnosing-bugs 的 hitl-loop（bash）。Windows 上别让 agent 去装 Git Bash ——
本文件是同一件事的原生 PowerShell 版；.sh 那份留给确实装着 Git Bash 的机器。

干三件事：
  ① 一条命令跑一遍，stdout/stderr 收进临时文件；
  ② 与「期望现象」对照，判定这次是否复现；
  ③ 结论 echo 出来，供任务书的「复现命令：」一行原样引用。

用法：
  1) Copy-Item assets/hitl-loop.template.ps1 scripts/repro-<卡id>.ps1
  2) 改下面三个 param 默认值（-Cmd / -Expect / -ExitWant）
  3) powershell -NoProfile -File scripts/repro-<卡id>.ps1     # 复现 → 退出码 0；未复现 → 1
  4) done 的 --结果 里写：复现命令：powershell -NoProfile -File scripts/repro-<卡id>.ps1

纪律（与任务书同一句）：跑不出复现就**停下来要三样之一**（能复现的环境 / 脱敏后的产物 /
临时埋点授权），不许直接进入“我猜是 X”的假设阶段。
#>
param(
    [string]$Cmd = 'Write-Output "把这里换成真正会出错的那条命令"',
    [string]$Expect = '把这里换成期望看到的错（子串即可，比如 ECONNRESET / 500 / 白屏）',
    [int]$ExitWant = 1,
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutFile) {
    $OutFile = Join-Path $env:TEMP ('hitl-loop-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}

# 用 powershell.exe 跑命令：Windows 11 必带，不用装 Git Bash / WSL（REV-006）
& powershell.exe -NoProfile -Command $Cmd *> $OutFile
$code = $LASTEXITCODE
$text = ''
try { $text = Get-Content -LiteralPath $OutFile -Raw -ErrorAction Stop } catch { $text = '' }

$expectSet = ($Expect -and ($Expect -notlike '把这里换成*'))
$hit = $false
if ($expectSet -and $text -and $text.Contains($Expect)) { $hit = $true }
if ($ExitWant -ne 0 -and $code -ne 0) { $hit = $true }

Write-Output ("命令：" + $Cmd)
Write-Output ("退出码：" + $code + "（期望：" + $(if ($ExitWant -ne 0) { '非 0' } else { '0' }) + "）")
Write-Output ("输出文件：" + $OutFile)
if ($expectSet) { Write-Output ("期望现象：" + $Expect + " → " + $(if ($hit) { '命中' } else { '未命中' })) }
Write-Output '---- 最后 20 行输出 ----'
if ($text) { ($text -split "`r?`n" | Select-Object -Last 20) | Write-Output }

if ($hit) {
    Write-Output 'RESULT: 已复现（把上面「命令」一行原样写进 done 的 --结果：复现命令：…）'
    exit 0
}
Write-Output 'RESULT: 未复现 —— 不要进入假设阶段。停下来要三样之一：能复现的环境 / 脱敏后的产物 / 临时埋点授权'
exit 1
