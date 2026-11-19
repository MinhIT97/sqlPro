@echo off
title SqlPro Dev Mode
cd /d "%~dp0"
echo ========================================================
echo   SqlPro - Che do phat trien (Dev Live-Reload)
echo   Chinh sua code va ung dung se tu dong cap nhat!
echo ========================================================
if exist "node_modules\.bin\electron.cmd" (
    call "node_modules\.bin\electron.cmd" .
) else (
    call npm run dev
)
pause
