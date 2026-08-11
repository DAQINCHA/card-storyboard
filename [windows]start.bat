@echo off
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0.") do set "PROJECT_DIR=%%~fI"
set "PID_FILE=%PROJECT_DIR%\.storyboard-server.pid"
set "LOG_FILE=%PROJECT_DIR%\storyboard-server.log"
if "%PORT%"=="" set "PORT=5199"
if "%STORYBOARD_PUBLIC_ORIGIN%"=="" set "STORYBOARD_PUBLIC_ORIGIN=http://localhost:%PORT%"
if "%STORYBOARD_ALLOWED_ORIGINS%"=="" set "STORYBOARD_ALLOWED_ORIGINS=%STORYBOARD_PUBLIC_ORIGIN%"
if "%STORYBOARD_PUBLIC_ORIGIN:~0,7%"=="http://" if "%STORYBOARD_ALLOW_INSECURE_HTTP%"=="" set "STORYBOARD_ALLOW_INSECURE_HTTP=1"

cd /d "%PROJECT_DIR%" || exit /b 1
where node >nul 2>nul || (
  echo 未检测到 Node.js，请先安装 Node.js 后重试。
  pause
  exit /b 1
)

if exist "%PID_FILE%" (
  set "RUNNING_PID="
  set /p RUNNING_PID=<"%PID_FILE%"
  if defined RUNNING_PID (
    powershell -NoProfile -Command "if (Get-Process -Id !RUNNING_PID! -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
    if not errorlevel 1 (
      echo 服务已在运行 (PID: !RUNNING_PID!^)。
      start "" "%STORYBOARD_PUBLIC_ORIGIN%"
      exit /b 0
    )
  )
  del /f /q "%PID_FILE%" >nul 2>nul
)

set "PORT_PID="
for /f "tokens=5" %%I in ('netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"') do if not defined PORT_PID set "PORT_PID=%%I"
if defined PORT_PID (
  echo 端口 %PORT% 已被进程 !PORT_PID! 占用。为安全起见不会自动终止该进程。
  pause
  exit /b 1
)

node server.js verify-db >nul 2>nul
if errorlevel 1 (
  echo 数据库尚未完成账户初始化或版本不匹配。
  echo 请在此目录打开终端并执行：node server.js setup-admin --username admin
  pause
  exit /b 1
)

echo 正在启动卡片分镜服务...
set "NEW_PID="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$cmd = 'node server.js ^> ""' + $env:LOG_FILE + '"" 2^>^&1'; $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory $env:PROJECT_DIR -PassThru; $p.Id"`) do set "NEW_PID=%%I"
if not defined NEW_PID (
  echo 启动失败，无法获取进程 PID。
  pause
  exit /b 1
)
>"%PID_FILE%" echo %NEW_PID%
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "if (Get-Process -Id %NEW_PID% -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo 启动成功，PID: %NEW_PID%
  start "" "%STORYBOARD_PUBLIC_ORIGIN%"
  exit /b 0
)
echo 启动失败，请查看日志: %LOG_FILE%
del /f /q "%PID_FILE%" >nul 2>nul
pause
exit /b 1
