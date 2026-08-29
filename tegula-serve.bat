@echo off
setlocal
set DIR=%~dp0
set PORT=8753
set PY=
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe" set PY=%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe
if "%PY%"=="" if exist "%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\python.exe" set PY=%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\python.exe
if "%PY%"=="" (
  echo Python not found.
  pause
  exit /b 1
)
if not exist "%DIR%tegula.py" (
  echo tegula.py not found.
  pause
  exit /b 1
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%PORT% "') do taskkill /pid %%a /f >nul 2>&1
start "" http://127.0.0.1:%PORT%/
echo tegula board: http://127.0.0.1:%PORT%/  (close this window to stop)
"%PY%" "%DIR%tegula.py" serve --port %PORT%
endlocal
