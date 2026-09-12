@echo off
REM Python backend wrapper for Tauri sidecar
REM Tauri calls this as: python-backend.exe serve --port 8753

setlocal

REM Determine the directory where this script lives
set "SCRIPT_DIR=%~dp0"

REM Run the Python backend
REM The actual tegula.py is in the parent directory
python "%SCRIPT_DIR%..\..\tegula.py" %*
