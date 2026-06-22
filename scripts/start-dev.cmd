@echo off
chcp 65001 >nul
setlocal

echo [start] YUVI Runtime development environment
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
exit /b %ERRORLEVEL%
