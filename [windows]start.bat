@echo off
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0.") do set "PROJECT_DIR=%%~fI"
set "PID_FILE=%PROJECT_DIR%\.storyboard-server.pid"
set "LOG_FILE=%PROJECT_DIR%\storyboard-server.log"
if "%PORT%"=="" set "PORT=5188"
set "HEALTH_URL=http://127.0.0.1:%PORT%/api/health"

cd /d "%PROJECT_DIR%" || (
  echo 无法进入项目目录: %PROJECT_DIR%
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 后重试。
  echo 下载地址: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "%PROJECT_DIR%\node_modules\" (
  echo 首次启动，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络或 npm 配置。
    pause
    exit /b 1
  )
)

if exist "%PID_FILE%" (
  set "OLD_PID="
  set /p OLD_PID=<"%PID_FILE%"
  if defined OLD_PID (
    call :is_pid_running "!OLD_PID!"
    if not errorlevel 1 (
      call :is_current_project_service
      if not errorlevel 1 (
        echo 服务已在运行 (PID: !OLD_PID!^)。
        start "" "http://localhost:%PORT%"
        exit /b 0
      )
      echo 检测到服务运行目录已变化，正在自动重启...
      call :stop_pid "!OLD_PID!"
    )
  )
  del /f /q "%PID_FILE%" >nul 2>nul
)

set "PORT_PID="
call :get_listening_pid_on_port
if defined PORT_PID (
  call :is_current_project_service
  if not errorlevel 1 (
    >"%PID_FILE%" echo %PORT_PID%
    echo 服务已在运行 (PID: %PORT_PID%^)。
    start "" "http://localhost:%PORT%"
    exit /b 0
  )
  echo 检测到端口 %PORT% 被旧目录服务占用，正在自动替换...
  call :stop_pid "%PORT_PID%"
)

echo 正在启动卡片分镜服务...
set "NEW_PID="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$cmd = 'npm start ^> ""' + $env:LOG_FILE + '"" 2^>^&1'; $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory $env:PROJECT_DIR -PassThru; $p.Id"`) do (
  set "NEW_PID=%%I"
)

if not defined NEW_PID (
  echo 启动失败，无法获取进程 PID。
  echo 请查看日志: %LOG_FILE%
  pause
  exit /b 1
)

>"%PID_FILE%" echo %NEW_PID%
timeout /t 1 /nobreak >nul

call :is_pid_running "%NEW_PID%"
if not errorlevel 1 (
  echo 启动成功，PID: %NEW_PID%
  echo 日志文件: %LOG_FILE%
  start "" "http://localhost:%PORT%"
  exit /b 0
)

echo 启动失败，请查看日志: %LOG_FILE%
del /f /q "%PID_FILE%" >nul 2>nul
pause
exit /b 1

:get_listening_pid_on_port
set "PORT_PID="
for /f "tokens=5" %%I in ('netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  set "PORT_PID=%%I"
  goto :eof
)
exit /b 0

:is_current_project_service
powershell -NoProfile -Command "$url = $env:HEALTH_URL; $expected = Join-Path $env:PROJECT_DIR 'data\storyboard.db'; try { $h = Invoke-RestMethod -Uri $url -TimeoutSec 2 -ErrorAction Stop } catch { exit 1 }; $db = [string]$h.dbPath; if ([string]::IsNullOrWhiteSpace($db)) { exit 1 }; try { $db = [System.IO.Path]::GetFullPath($db) } catch {}; $expected = [System.IO.Path]::GetFullPath($expected); if ($db.TrimEnd('\') -ieq $expected.TrimEnd('\')) { exit 0 } else { exit 1 }" >nul 2>nul
exit /b %ERRORLEVEL%

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
