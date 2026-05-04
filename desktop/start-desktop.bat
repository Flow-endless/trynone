@echo off
REM 双击本文件：无参数时转给 start-desktop.vbs，无可见 CMD
if /i "%~1"=="_HIDDEN" goto :main
wscript //nologo "%~dp0start-desktop.vbs"
exit /b 0

:main
setlocal
set "APP_PORT=8081"
set "APP_URL=http://127.0.0.1:%APP_PORT%/index.html"
cd /d "%~dp0"

for /f "delims=" %%i in ('powershell -NoProfile -Command "$m=[Environment]::GetEnvironmentVariable('Path','Machine'); $u=[Environment]::GetEnvironmentVariable('Path','User'); if ($m -and $u) { $m + [char]59 + $u } elseif ($m) { $m } elseif ($u) { $u } else { '' }"') do set "FRESH_PATH=%%i"
if defined FRESH_PATH set "PATH=%FRESH_PATH%;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  set "ERRTXT=node 不在 PATH 中，请从 https://nodejs.org/ 安装 Node.js。"
  goto :fail
)

if not exist "node_modules\electron\package.json" (
  call npm install
  if errorlevel 1 (
    set "ERRTXT=npm install 失败，请检查网络或 Node 环境。"
    goto :fail
  )
)

call npm start
exit /b

:fail
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:ERRTXT,'desktop')"
exit /b 1
