@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo === Naturalizer Workflow 一鍵啟動 ===

curl -s -o nul -m 3 http://127.0.0.1:8080/health
if errorlevel 1 (
  echo [!] 模型服務未運行（端口 8080）。請先啟動 Humanizer App / llama-server 再回來。
  choice /c YN /m "仍要繼續啟動 UI（跑不了生成任務）？"
  if errorlevel 2 exit /b 1
)

echo [1/2] 啟動 WebUI（http://127.0.0.1:8790）
start "Naturalizer WebUI" cmd /c "cd /d %cd%\webui && node server.mjs"
timeout /t 2 >nul

echo [2/2] 完成。瀏覽器打開 http://127.0.0.1:8790
start http://127.0.0.1:8790
endlocal
