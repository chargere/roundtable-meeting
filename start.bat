@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 查治的圆桌会议

rem 端口可以从外面改（测试用），不改就是 4173
if not defined PORT set PORT=4173
set URL=http://127.0.0.1:%PORT%

echo.
echo   查治的圆桌会议
echo   ----------------
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 goto ALREADY

:START
echo   [1/2] 启动服务...
echo.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 1200; Start-Process '%URL%'"
node server.js
echo.
echo   服务已停止。
pause >nul
exit /b 0

:ALREADY
echo   %PORT% 上已经有一个在跑了。
echo   如果刚改过代码，必须重启它才会生效 ——
echo   不重启的话，你看到的永远是老版本。
echo.
choice /c YN /n /t 8 /d Y /m "   现在重启它？(Y=重启 N=只开浏览器，8 秒后自动重启) "
if errorlevel 2 goto OPENONLY

echo   正在关掉旧的...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>nul
ping -n 3 127.0.0.1 >nul
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo   关不掉 —— 那个窗口可能不是你开的，手动关掉它再双击我。
  pause
  exit /b 1
)
goto START

:OPENONLY
echo   只开浏览器，服务不动。
start "" "%URL%"
exit /b 0

:NONODE
echo   没找到 node。
echo   去 https://nodejs.org 装一个 LTS 版本，装完再双击我。
echo.
pause
exit /b 1
