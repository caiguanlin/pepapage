@echo off
rem Start the worker: double-click, or run pepapage-worker\start-worker.cmd from any directory.
rem Keep this file ASCII-only: cmd.exe parses .cmd files in the console code page (936 on Chinese
rem Windows), and switching to UTF-8 with chcp mid-file makes cmd misread the remaining lines.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo .venv not found. Run these in pepapage-worker first:
    echo   python -m venv .venv
    echo   .venv\Scripts\python.exe -m pip install -r requirements.txt
    echo   .venv\Scripts\python.exe -m pip install --no-deps "kittenml>=0.9.7"
    pause
    exit /b 1
)

if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo Created .env from .env.example. Sync OSS settings from the server with tools\sync_env.py
)

".venv\Scripts\python.exe" -m worker.main
set "CODE=%ERRORLEVEL%"
rem Keep the window open on abnormal exit so errors stay visible after a double-click start
if not "%CODE%"=="0" pause
exit /b %CODE%
