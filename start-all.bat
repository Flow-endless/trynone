@echo off
REM 双击本文件：无参数时转给 start-all.vbs，全程不保留可见 CMD（仅可能极短闪一下）
REM 实际逻辑在 _HIDDEN 分支，由 vbs 以隐藏窗口启动
if /i "%~1"=="_HIDDEN" goto :main
wscript //nologo "%~dp0start-all.vbs"
exit /b 0

:main
setlocal EnableDelayedExpansion
set "NO_CONSOLE=1"
cd /d "%~dp0"

set "START_LOG=%~dp0start-all-launch.log"
echo.>>"%START_LOG%"
echo === [%date% %time%] start-all _HIDDEN ===>>"%START_LOG%"

set "APP_PORT=8081"
set "JAR_NAME=deepseek-0.0.1-SNAPSHOT.jar"
set "JAR_PATH=target\%JAR_NAME%"

where java >nul 2>&1
if errorlevel 1 (
  echo [err] java not in PATH>>"%START_LOG%"
  set "ERRTXT=java 不在 PATH 中，请先安装 JDK 并配置环境变量。"
  goto :fail
)
echo [step] java ok>>"%START_LOG%"

where mvn >nul 2>&1
if errorlevel 1 (
  echo [err] mvn not in PATH>>"%START_LOG%"
  set "ERRTXT=mvn 不在 PATH 中，请先安装 Maven。"
  goto :fail
)
echo [step] mvn ok>>"%START_LOG%"

REM 必须先停掉本机 8081 上 / deepseek.pid 里记录的 java。否则 mvn 无法重命名 target\*.jar（JAR 被 java 进程锁死 → repackage 失败「打不开」）。
echo [start-all] 停止可能占用本 JAR 的后端，再 mvn 打包...>>"%START_LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\free-port-for-startall.ps1" -Port %APP_PORT% -ProjectRoot "%~dp0"
timeout /t 2 /nobreak >nul

REM 每次启动都打包，把 static 等打进 JAR。仅当「JAR 不存在才 mvn」会导致改前端后仍是旧界面。
echo [start-all] mvn clean package（清 target 后重打 JAR，含 static）...>>"%START_LOG%"
call mvn -q clean package -DskipTests
if errorlevel 1 (
  echo [err] mvn clean package failed>>"%START_LOG%"
  set "ERRTXT=mvn 失败。最常见原因：① 上次多模态的 Java 仍占用 target\%JAR_NAME%，请先关程序或在任务管理器结束对应 java 后再双击 ② 若用 IDEA/杀毒软件打开了 target 下 JAR 也会锁文件 ③ 见 CMD 中 mvn 的英文错误。"
  goto :fail
)
echo [step] mvn clean package ok>>"%START_LOG%"

if not exist "%JAR_PATH%" (
  echo [err] jar missing>>"%START_LOG%"
  set "ERRTXT=缺少 %JAR_PATH% ^(mvn 后仍无 JAR^) 请检查工程。"
  goto :fail
)
echo [step] jar exists>>"%START_LOG%"

REM 与「先手动 java -jar 再起 Electron」一致：由本脚本先隐藏启动 Java 并等待 HTTP，再让 Electron 只连后端（SKIP_EMBEDDED_JAVA=1）
set "JARFULL=%CD%\%JAR_PATH%"
echo [step] port %APP_PORT% spawn java hidden>>"%START_LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-backend-hidden.ps1" -JarPath "%JARFULL%"
if errorlevel 1 (
  echo [err] start-backend-hidden failed>>"%START_LOG%"
  set "ERRTXT=无法以隐藏方式启动 Java，请检查 java 是否在 PATH 中。"
  goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\wait-http.ps1" -Port %APP_PORT% -Seconds 120
if errorlevel 1 (
  echo [err] wait-http timeout>>"%START_LOG%"
  set "ERRTXT=后端在 120 秒内未就绪。请在 CMD 中执行 java -jar target\%JAR_NAME% 查看报错。"
  goto :fail
)
echo [step] backend http ok>>"%START_LOG%"

:after_backend
cd /d "%~dp0desktop"
echo [step] desktop dir>>"%START_LOG%"

for /f "delims=" %%i in ('powershell -NoProfile -Command "$m=[Environment]::GetEnvironmentVariable('Path','Machine'); $u=[Environment]::GetEnvironmentVariable('Path','User'); if ($m -and $u) { $m + [char]59 + $u } elseif ($m) { $m } elseif ($u) { $u } else { '' }"') do set "FRESH_PATH=%%i"
if defined FRESH_PATH set "PATH=%FRESH_PATH%;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo [err] node not in PATH>>"%START_LOG%"
  set "ERRTXT=node 不在 PATH 中，请从 https://nodejs.org/ 安装 Node.js。"
  goto :fail
)
echo [step] node ok>>"%START_LOG%"

if not exist "node_modules\electron\package.json" (
  echo [step] npm install, may take a few minutes...>>"%START_LOG%"
  call npm install
  if errorlevel 1 (
    echo [err] npm install failed>>"%START_LOG%"
    set "ERRTXT=npm install 失败，请检查网络或 Node 环境。"
    goto :fail
  )
  echo [step] npm install ok>>"%START_LOG%"
)

echo [step] npm start (Electron), SKIP_EMBEDDED_JAVA=1>>"%START_LOG%"
set "SKIP_EMBEDDED_JAVA=1"
call npm start
if errorlevel 1 (
  echo [err] npm start failed>>"%START_LOG%"
  set "ERRTXT=npm start 失败（Electron 未正常启动）。请在项目根 CMD 执行：cd desktop ^&^& npm start 查看报错；或打开 start-all-launch.log。"
  goto :fail
)
echo [ok] npm exited 0>>"%START_LOG%"
exit /b 0

:fail
echo [fail] !ERRTXT!>>"%START_LOG%"
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:ERRTXT,'start-all')"
exit /b 1
