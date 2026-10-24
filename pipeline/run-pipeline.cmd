@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%~1"=="" goto :usage

echo.
echo 原稿：%~1
echo 流程：hz（Humanizer）→ 學術性修補 → 報告
echo.

node pipeline.mjs "%~1"
echo.
pause
exit /b

:usage
echo.
echo 將原稿（.txt 或 .md）拖到這個檔案上。
echo 會自動跑 Humanizer 與學術修補，輸出：
echo   ^<name^>.humanized.txt   A：Humanizer 原始輸出
echo   ^<name^>.final.txt       B：學術修補後
echo   ^<name^>.final.report.md 中文報告
echo.
pause
exit /b 1
