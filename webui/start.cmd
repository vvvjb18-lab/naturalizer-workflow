@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "Humanizer UI" http://127.0.0.1:8790
node server.mjs
pause
