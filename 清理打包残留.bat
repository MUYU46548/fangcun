@echo off
chcp 65001 >nul
echo 清理 desktop\release* 旧打包产物（保留最新一个；被系统进程占用的会跳过并列出）
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\clean-release-dirs.ps1"
echo.
echo 如果上面提示"仍被占用"：重启电脑后再双击运行一次这个文件即可。
pause
