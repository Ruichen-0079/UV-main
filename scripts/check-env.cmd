@echo off
setlocal

echo [检查] Windows LTSC + WSL 开发环境
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

echo [OK] wsl 命令可用
echo [OK] Ubuntu 发行版可用
echo.
echo 预期 WSL 路径：~/uv-main
echo Windows 源路径参考：C:\Users\Administrator.DESKTOP-NPU6DHJ\Desktop\uv-main
echo.
echo 正在检查 Ubuntu 内的 Node.js、pnpm、Docker 和 docker compose...

wsl -d Ubuntu bash -lc "set -euo pipefail; if [ -d \"$HOME/.nvm/versions/node\" ]; then node_bin=$(find \"$HOME/.nvm/versions/node\" -mindepth 2 -maxdepth 2 -type f -name node -printf '%%h\n' | sort -V | tail -n 1 || true); if [ -n \"$node_bin\" ]; then export PATH=\"$node_bin:$PATH\"; fi; fi; command -v node; node --version; command -v pnpm; pnpm --version; command -v docker; docker --version; docker compose version"

exit /b %ERRORLEVEL%
