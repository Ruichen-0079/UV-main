@echo off
setlocal

wsl -d Ubuntu --cd /home/administrator/uv-main/uv-main bash -lc "./scripts/stop.sh"

exit /b %ERRORLEVEL%
