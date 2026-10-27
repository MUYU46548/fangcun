@echo off
REM Admin cleanup for desktop\release* (2026-10-27)
REM NOTE: pure ASCII on purpose. A UTF-8 .bat with Chinese text is decoded as GBK
REM by cmd.exe, which garbles text and can break IF blocks -> instant exit,
REM user sees "nothing happened".
setlocal
set LOG=%TEMP%\fc-clean.log
set PS1=%~dp0scripts\clean-release-dirs.ps1

echo ============================================
echo  Fangcun: clean old release* folders
echo ============================================
echo Log: %LOG%
echo.

if not exist "%PS1%" (
  echo [ERROR] script not found: %PS1%
  pause
  exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
  echo [WARN] Not running as Administrator.
  echo        Right-click - "Run as administrator".
  echo        It will still try, but the OneDrive lock will not be released.
  echo.
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -StopOneDrive -LogPath "%LOG%"
echo.
echo ---- log ----
type "%LOG%"
echo.
echo Done. If folders are still there, reboot and run clean-release.bat instead.
pause
