@echo off
title SqlPro Dev Mode
cd /d "%~dp0"
echo ========================================================
echo   SqlPro - Che do phat trien
echo   Tep thay doi se co thong bao. Ctrl+Shift+R de tai lai.
echo ========================================================
if exist "node_modules\.bin\electron.cmd" (
    call "node_modules\.bin\electron.cmd" .
) else (
    call npm run dev
)
pause
