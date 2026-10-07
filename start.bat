@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if "%WORKBENCH_PORT%"=="" set WORKBENCH_PORT=8765
echo 正在启动灵犀工作坊网页版，请保留本窗口。
echo 本机访问：http://127.0.0.1:%WORKBENCH_PORT%/
echo 已启用局域网时，也可使用本机的局域网 IP 访问。
echo.
where python >nul 2>nul
if errorlevel 1 (
  echo 未找到 Python。请先安装 Python 3.12 或更高版本，并加入 PATH。
  pause
  exit /b 1
)
python -B run_web.py --open-browser
if errorlevel 1 echo 启动失败，请查看上方提示及 profile\logs\web-runtime.log。
pause
