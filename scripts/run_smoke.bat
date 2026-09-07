@echo off
rem 方寸冒烟：以 pythonw（与方寸看板.bat 同方式）拉起 scripts/smoke_pythonw.py，
rem 验证 /ping /tasks.json /status.json /api review 全链路，结果在 %TEMP%\tegula_smoke_result.json
setlocal
set DIR=%~dp0..
set PYW=
if exist "%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\pythonw.exe" set PYW=%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\pythonw.exe
if "%PYW%"=="" set PYW=pythonw.exe
if exist "%TEMP%\tegula_smoke_result.json" del "%TEMP%\tegula_smoke_result.json"
start "" /wait "%PYW%" "%DIR%\scripts\smoke_pythonw.py" %1
type "%TEMP%\tegula_smoke_result.json"
endlocal
