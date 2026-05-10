#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

state_dir="${XDG_RUNTIME_DIR:-/tmp}/yuvi-runtime-dev"
server_pid_file="$state_dir/server.pid"
web_pid_file="$state_dir/web.pid"

server_url="http://localhost:6121/health"
web_url="http://localhost:5173"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少必要工具：$1" >&2
    exit 1
  fi
}

is_running() {
  local pid_file="$1"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1
}

require_tool docker
docker compose version >/dev/null

if [ -f "infra/docker-compose.yml" ]; then
  echo "Docker Compose 服务状态："
  docker compose -f infra/docker-compose.yml ps
else
  echo "未找到 infra/docker-compose.yml，跳过 Docker Compose 状态"
fi

if is_running "$server_pid_file"; then
  echo "检查 Server: $server_url"
  require_tool curl
  curl --fail --silent --show-error "$server_url"
  echo
elif [ -f "$server_pid_file" ]; then
  echo "Server PID 文件存在，但进程未运行：$(cat "$server_pid_file")" >&2
  exit 1
else
  echo "Server 未由 dev.sh 记录为运行中，跳过 /health"
fi

if is_running "$web_pid_file"; then
  echo "检查 Web UI: $web_url"
  require_tool curl
  curl --fail --silent --show-error --output /dev/null "$web_url"
  echo "Web UI 可访问"
elif [ -f "$web_pid_file" ]; then
  echo "Web UI PID 文件存在，但进程未运行：$(cat "$web_pid_file")" >&2
  exit 1
else
  echo "Web UI 未由 dev.sh 记录为运行中，跳过 URL 检查"
fi
