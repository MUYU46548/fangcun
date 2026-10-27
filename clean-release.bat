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

REM No admin needed: the lock is held by a file indexer (close it), not by a service.
REM desktop\pkg is the release pickup dir - this script never touches it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -LogPath "%LOG%"
echo.
echo ---- log ----
type "%LOG%"
echo.
echo Done. If files are still locked, quit the indexer app (tray - Exit) and run again.
pause
