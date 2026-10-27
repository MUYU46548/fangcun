@echo off
chcp 65001 >nul
REM 2026-10-27：清 desktop\release* 旧打包产物（含被 OneDrive 锁住的那批）
REM
REM 为什么要"以管理员身份运行"：
REM   锁的持有者是 OneDrive 的 FileSyncHelper（服务，Manual 启动）。用户态停不了它
REM   （报"无法打开服务"），只有管理员能停。停掉 → 删除 → 再启回来，全过程约 30 秒。
REM   不想提权也行：重启电脑后双击"清理打包残留.bat"（那个不需要管理员）。

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [需要管理员权限]
  echo   请右键这个文件 -^> "以管理员身份运行"
  echo.
  pause
  exit /b 1
)

echo 正在暂停 OneDrive 文件同步助手，清理 release* 目录...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\clean-release-dirs.ps1" -StopOneDrive
echo.
pause
