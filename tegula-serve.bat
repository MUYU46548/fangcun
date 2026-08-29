@echo off
REM 方寸 tegula 看板一键启动
REM 双击即启动本地服务并在默认浏览器打开看板；关闭窗口即退出。
setlocal
set "DIR=%~dp0"
set "PORT=8753"
set "PY=python"
if not exist "%DIR%tegula.py" (
  echo 找不到 tegula.py，请确认本脚本与 tegula.py 同目录。
  pause
  exit /b 1
)
REM 先尝试释放端口（若上次未正常退出）
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%PORT% "') do (
  if not "%%a"=="" taskkill /pid %%a /f >nul 2>&1
)
start "" http://127.0.0.1:%PORT%/
"%PY%" "%DIR%tegula.py" serve --port %PORT%
endlocal
