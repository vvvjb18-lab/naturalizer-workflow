@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo === Naturalizer Workflow 環境檢查與安裝 ===
echo.

where node >nul 2>nul || (echo [X] 找不到 Node.js（需要 18+）。請安裝：https://nodejs.org && exit /b 1)
for /f "tokens=*" %%v in ('node -v') do echo [OK] Node %%v

where python >nul 2>nul || (echo [X] 找不到 Python（需要 3.10+）。請安裝：https://python.org && exit /b 1)
for /f "tokens=*" %%v in ('python --version') do echo [OK] %%v

echo.
echo --- 安裝 polish/ Node 依賴 ---
cd polish
call npm install --no-audit --no-fund || (echo [X] npm install 失敗 && exit /b 1)
cd ..

echo.
echo --- 安裝 Python 依賴 ---
python -m pip install --quiet language_tool_python || (echo [X] pip 安裝 language_tool_python 失敗 && exit /b 1)
echo [OK] language_tool_python

echo.
echo === 檢查模型後端 ===
curl -s -o nul -m 3 http://127.0.0.1:8080/health && echo [OK] 本地模型服務已在 8080 運行 || echo [!] 本地模型服務（Humanizer App / llama-server，端口 8080）未運行 —— 請先啟動，見 README「模型後端」

echo.
echo === 完成 ===
echo 快速開始：scripts\start-all.cmd
endlocal
