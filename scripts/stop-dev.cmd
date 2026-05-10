@echo off
chcp 65001 >nul
setlocal

echo [停止] YUVI Runtime 开发环境
echo.

where wsl >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 wsl 命令。请先启用 WSL。
  exit /b 1
)

wsl -d Ubuntu -- true >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到可用的 Ubuntu 发行版。
  exit /b 1
)

wsl -d Ubuntu bash -lc "set -euo pipefail; if [ -x ~/uv-main/scripts/stop.sh ]; then cd ~/uv-main; elif [ -x ~/uv-main/uv-main/scripts/stop.sh ]; then cd ~/uv-main/uv-main; else echo '[错误] 未找到 repo：请确认 WSL 路径 ~/uv-main 中存在 scripts/stop.sh' >&2; exit 1; fi; ./scripts/stop.sh"

exit /b %ERRORLEVEL%
