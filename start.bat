@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 查治的圆桌会议

set PORT=4173
set URL=http://127.0.0.1:%PORT%

echo.
echo   查治的圆桌会议
echo   ----------------
echo.

rem ---- node 在不在 ----
where node >nul 2>nul
if errorlevel 1 goto NONODE

rem ---- 端口是不是已经有人在听 ----
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 goto ALREADY

echo   [1/2] 启动服务...
echo.
rem 等服务起来再开浏览器，免得页面比服务先到
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 1200; Start-Process '%URL%'"

rem 前台跑着，窗口别关；Ctrl+C 或关窗口就停
node server.js

echo.
echo   服务已停止。
pause >nul
exit /b 0

:ALREADY
echo   已经有一个在跑了，直接开浏览器。
start "" "%URL%"
ping -n 2 127.0.0.1 >nul
exit /b 0

:NONODE
echo   没找到 node。
echo   去 https://nodejs.org 装一个 LTS 版本，装完再双击我。
echo.
pause
exit /b 1
