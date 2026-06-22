@echo off
chcp 65001 >nul
setlocal

echo [stop] YUVI Runtime development environment
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
exit /b %ERRORLEVEL%
