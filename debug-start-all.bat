@echo off
chcp 65001 >nul
title Deepseek 调试启动（可见控制台）
cd /d "%~dp0"
echo 将调用 start-all.bat _HIDDEN，输出会显示在本窗口。
echo.
call start-all.bat _HIDDEN
echo.
echo 脚本结束，退出码: %ERRORLEVEL%
echo 若仍有问题，请查看: %~dp0start-all-launch.log
pause
