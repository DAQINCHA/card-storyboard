@echo off
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0.") do set "PROJECT_DIR=%%~fI"
set "PID_FILE=%PROJECT_DIR%\.storyboard-server.pid"
if "%PORT%"=="" set "PORT=5188"

if not exist "%PID_FILE%" (
  set "PORT_PIDS="
  for /f "tokens=5" %%I in ('netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"') do (
    set "PORT_PIDS=!PORT_PIDS! %%I"
  )

  if defined PORT_PIDS (
    for %%P in (%PORT_PIDS%) do call :stop_pid %%P
    echo 已按端口 %PORT% 停止服务进程。
    pause
    exit /b 0
  )

  echo 未找到运行中的服务记录。
  pause
  exit /b 0
)

set "PID="
set /p PID=<"%PID_FILE%"
if not defined PID (
  del /f /q "%PID_FILE%" >nul 2>nul
  echo PID 记录为空，已清理。
  pause
  exit /b 0
)

call :is_pid_running "%PID%"
if not errorlevel 1 (
  call :stop_pid "%PID%"
  echo 已停止服务 (PID: %PID%^)
) else (
  echo 服务进程不存在，已清理 PID 记录。
)

del /f /q "%PID_FILE%" >nul 2>nul
pause
exit /b 0

:is_pid_running
powershell -NoProfile -Command "if (Get-Process -Id %~1 -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
exit /b %ERRORLEVEL%

:stop_pid
if "%~1"=="" exit /b 0
taskkill /PID %~1 >nul 2>nul
timeout /t 1 /nobreak >nul
call :is_pid_running %~1
if not errorlevel 1 taskkill /F /PID %~1 >nul 2>nul
exit /b 0
