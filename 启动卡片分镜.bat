@echo off
rem 双击启动「卡片分镜」（Windows）。脚本按自身所在目录定位项目，整个文件夹可以搬到任何位置。
setlocal EnableExtensions
chcp 936 >nul 2>nul
cd /d "%~dp0" || exit /b 1

set "PORT=5199"
set "HEALTH=/api/health"
set "NODE_PROBE=require('node:sqlite')"
set "NODE_MIN=22.13"
set "URL=http://127.0.0.1:%PORT%"

if /i "%~1"=="--open" goto :open_when_ready

cls
title 卡片分镜 · 本地服务

rem 找一个能用的 Node：PATH → 官方安装位置 → nvm-windows → Volta → WorkBuddy 自带
set "NODE_BIN="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" call :try_node "%%~$PATH:I"
if not defined NODE_BIN call :try_node "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN call :try_node "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if defined NVM_SYMLINK call :try_node "%NVM_SYMLINK%\node.exe"
if not defined NODE_BIN call :try_node "%LOCALAPPDATA%\Volta\bin\node.exe"
set "VERSIONS=%USERPROFILE%\.workbuddy\binaries\node\versions"
if not defined NODE_BIN if exist "%VERSIONS%\current" (
  set /p WB_CURRENT=<"%VERSIONS%\current"
  call :try_node "%VERSIONS%\%%WB_CURRENT%%\node.exe"
  call :try_node "%VERSIONS%\%%WB_CURRENT%%\bin\node.exe"
)
if not defined NODE_BIN for /d %%D in ("%VERSIONS%\*") do (
  if not defined NODE_BIN call :try_node "%%~fD\node.exe"
  if not defined NODE_BIN call :try_node "%%~fD\bin\node.exe"
)

if not defined NODE_BIN (
  echo.
  echo   没有找到可用的 Node.js。
  echo   需要 %NODE_MIN% 或更高版本，安装后重新双击本文件即可。
  echo   下载地址：https://nodejs.org/
  goto :pause_exit_1
)

call :health 2
if not errorlevel 1 (
  echo.
  echo   服务已在运行，无需重复启动。
  echo   本机    %URL%
  echo   已为你打开浏览器。
  echo.
  start "" "%URL%"
  exit /b 0
)

netstat -ano -p tcp | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   无法启动：端口 %PORT% 已被其他程序占用。
  echo   请先关闭占用该端口的程序，或用 PORT 指定其他端口。
  goto :pause_exit_1
)

start "" /min "%~f0" --open
set "HOST=0.0.0.0"
set "STORYBOARD_ALLOW_INSECURE_HTTP=1"
set "LAN_IP="
"%NODE_BIN%" -e "const n=require('os').networkInterfaces();for(const k in n)for(const a of n[k])if(a.family==='IPv4'&&!a.internal){console.log(a.address);process.exit(0)}" > "%TEMP%\storyboard-lan-ip.txt" 2>nul
set /p LAN_IP=<"%TEMP%\storyboard-lan-ip.txt"
del "%TEMP%\storyboard-lan-ip.txt" >nul 2>nul
rem .env 里配置过的项一律以 .env 为准，这里只在没有配置时用局域网地址兜底
set "ENV_HAS_PUBLIC="
set "ENV_HAS_ALLOWED="
if exist ".env" findstr /b /i /c:"STORYBOARD_PUBLIC_ORIGIN=" ".env" >nul 2>nul && set "ENV_HAS_PUBLIC=1"
if exist ".env" findstr /b /i /c:"STORYBOARD_ALLOWED_ORIGINS=" ".env" >nul 2>nul && set "ENV_HAS_ALLOWED=1"
if defined LAN_IP (
  if not defined ENV_HAS_PUBLIC if not defined STORYBOARD_PUBLIC_ORIGIN set "STORYBOARD_PUBLIC_ORIGIN=http://%LAN_IP%:%PORT%"
  if not defined ENV_HAS_ALLOWED if not defined STORYBOARD_ALLOWED_ORIGINS set "STORYBOARD_ALLOWED_ORIGINS=http://127.0.0.1:%PORT%,http://localhost:%PORT%,http://%LAN_IP%:%PORT%"
)

"%NODE_BIN%" --disable-warning=ExperimentalWarning server.js
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" goto :stopped
if "%EXIT_CODE%"=="130" goto :stopped
if "%EXIT_CODE%"=="-1073741510" goto :stopped
echo   启动失败（退出码 %EXIT_CODE%）。
echo   上方是服务的错误输出，修好之后重新双击本文件即可。
echo.
echo   按任意键关闭窗口…
pause >nul
exit /b %EXIT_CODE%

:stopped
echo   服务已停止。
echo.
exit /b 0

:pause_exit_1
echo.
echo   按任意键关闭窗口…
pause >nul
exit /b 1

rem ---- 子程序 ----

:try_node
if not exist "%~1" exit /b 0
"%~1" -e "%NODE_PROBE%" >nul 2>nul && set "NODE_BIN=%~1"
exit /b 0

:health
curl.exe -fsS --max-time %~1 "%URL%%HEALTH%" >nul 2>nul
exit /b %ERRORLEVEL%

:open_when_ready
for /l %%N in (1,1,15) do (
  call :health 1
  if not errorlevel 1 (
    start "" "%URL%"
    exit
  )
  "%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul 2>nul
)
exit
