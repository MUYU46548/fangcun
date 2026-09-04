@echo off
rem 方寸 tegula 一键打开：pythonw 无窗口运行 open 模式，服务随进程起、关窗自退
setlocal
set DIR=%~dp0
set PYW=
if exist "%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\pythonw.exe" set PYW=%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\pythonw.exe
if "%PYW%"=="" set PYW=pythonw.exe
if not exist "%DIR%tegula.py" (
  echo tegula.py not found.
  pause
  exit /b 1
)
start "" "%PYW%" "%DIR%tegula.py" open --port 8753
endlocal
