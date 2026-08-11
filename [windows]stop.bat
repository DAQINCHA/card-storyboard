@echo off
setlocal EnableExtensions
for %%I in ("%~dp0.") do set "PROJECT_DIR=%%~fI"
set "PID_FILE=%PROJECT_DIR%\.storyboard-server.pid"
if not exist "%PID_FILE%" (
  echo 未找到由本项目启动的服务记录；不会按端口终止未知进程。
  pause
  exit /b 0
)
set "PID="
set /p PID=<"%PID_FILE%"
if defined PID (
  taskkill /PID %PID% >nul 2>nul
  timeout /t 1 /nobreak >nul
  powershell -NoProfile -Command "if (Get-Process -Id %PID% -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }" >nul 2>nul
  if errorlevel 1 (
    echo 服务未在等待时间内退出，请手动检查 PID %PID%。
    exit /b 1
  )
  echo 已停止服务 (PID: %PID%^)
)
del /f /q "%PID_FILE%" >nul 2>nul
pause
