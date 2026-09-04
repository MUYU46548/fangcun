@echo off
rem tegula one-click launcher: pythonw runs open mode (no console), auto-exit on window close
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
