@echo off
setlocal

echo [启动] YUVI Runtime 开发环境
echo.

where wsl >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 wsl 命令。请先启用 WSL，并安装 Ubuntu。
  exit /b 1
)

wsl -d Ubuntu -- true >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到可用的 Ubuntu 发行版。
  echo        请运行：wsl --install -d Ubuntu
  echo        已安装发行版可用以下命令查看：wsl -l -v
  exit /b 1
)

wsl -d Ubuntu bash -lc "set -euo pipefail; if [ -x \"$HOME/uv-main/scripts/dev.sh\" ]; then cd \"$HOME/uv-main\"; elif [ -x \"$HOME/uv-main/uv-main/scripts/dev.sh\" ]; then cd \"$HOME/uv-main/uv-main\"; else echo '[错误] 未找到 repo：请确认 WSL 路径 ~/uv-main 中存在 scripts/dev.sh' >&2; exit 1; fi; ./scripts/dev.sh"
if errorlevel 1 (
  echo.
  echo [错误] 开发环境启动失败。
  exit /b 1
)

echo.
echo [OK] 开发环境已启动。

wsl -d Ubuntu bash -lc "test -d \"$HOME/uv-main/apps/web\" || test -d \"$HOME/uv-main/uv-main/apps/web\"" >nul 2>nul
if not errorlevel 1 (
  echo [打开] http://localhost:5173
  start "" "http://localhost:5173"
) else (
  echo [提示] apps/web 尚未存在，暂不打开 Web UI。
)

exit /b 0
