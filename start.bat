@echo off
cd /d "%~dp0"
if "%WORKBENCH_PORT%"=="" set WORKBENCH_PORT=8765
python -B run_web.py
pause
