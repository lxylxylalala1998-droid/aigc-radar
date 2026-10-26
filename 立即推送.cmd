@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts/trigger.mjs daily-now
echo.
pause
