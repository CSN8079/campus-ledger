@echo off
chcp 65001 >nul
title 大学生活记账本
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo 正在启动本地服务...
node tools\serve.js --open
pause
exit /b 0

:nonode
echo.
echo  未检测到 Node.js。
echo.
echo  请任选其一：
echo   1) 安装 Node.js（https://nodejs.org）后重新双击本文件；
echo   2) 直接双击 web\index.html 用浏览器打开（功能可用，
echo      但「添加到主屏幕 / 离线缓存」需要本地服务）。
echo.
choice /c 12 /m "选择 1 打开下载页，2 直接打开网页版"
if errorlevel 2 goto direct
start "" "https://nodejs.org/zh-cn"
exit /b 0

:direct
start "" "%~dp0web\index.html"
exit /b 0