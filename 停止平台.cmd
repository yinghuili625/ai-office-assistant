@echo off
setlocal
set "PSModulePath="
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
set "platform_exit=%errorlevel%"
if /i not "%~1"=="-NoPause" pause
exit /b %platform_exit%
