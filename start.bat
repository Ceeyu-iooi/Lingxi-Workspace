@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo 未找到 Node.js。请安装 Node.js 24 LTS 后重新运行。
 pause
 exit /b 1
)
node scripts/web_launcher.mjs --open-browser
if errorlevel 1 echo 启动未完成，请查看上方提示。
pause
