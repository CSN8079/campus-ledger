@echo off
chcp 65001 >nul
title jizhangben

rem ------------------------------------------------------------------
rem  This launcher is intentionally ASCII-only.
rem  cmd.exe is not reliable at parsing non-ASCII batch files, so all the
rem  Chinese guidance is printed by the Node server instead (see tools/serve.js).
rem ------------------------------------------------------------------

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node tools\serve.js --open

echo.
echo [Server stopped]
echo If you did not press Ctrl+C yourself, please send the error above.
echo.
pause
exit /b 0

:nonode
echo.
echo [Node.js not found]
echo.
echo Node.js is required to run the local server. Choose one:
echo   1) Install Node.js from https://nodejs.org and run this file again.
echo   2) Open web\index.html directly in a browser (works, but
echo      "add to home screen / offline" needs the local server).
echo.
choice /c 12 /m "1 = open download page, 2 = open the web app directly"
if errorlevel 2 goto direct
start "" "https://nodejs.org/zh-cn"
exit /b 0

:direct
start "" "%~dp0web\index.html"
exit /b 0