@echo off
setlocal
set "PSModulePath="
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
set "platform_exit=%errorlevel%"
if not "%platform_exit%"=="0" if /i not "%~1"=="-NoBrowser" pause
exit /b %platform_exit%
