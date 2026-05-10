@echo off
setlocal

wsl -d Ubuntu --cd /home/administrator/uv-main/uv-main bash -lc "export PATH=/home/administrator/.nvm/versions/node/v22.22.2/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ./scripts/dev.sh"

exit /b %ERRORLEVEL%
