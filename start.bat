@echo off
cd /d "%~dp0"
set WORKBENCH_HOST=127.0.0.1
set WORKBENCH_PORT=8765
python -B run_web.py
pause
