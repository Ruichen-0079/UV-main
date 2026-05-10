#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

state_dir="${XDG_RUNTIME_DIR:-/tmp}/yuvi-runtime-dev"
server_pid_file="$state_dir/server.pid"
web_pid_file="$state_dir/web.pid"

stop_pid_file() {
  local label="$1"
  local pid_file="$2"

  if [ ! -f "$pid_file" ]; then
    echo "$label 未记录 PID，跳过"
    return
  fi

  local pid
  pid="$(cat "$pid_file")"

  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "停止 $label，PID $pid"
    pkill -TERM -P "$pid" >/dev/null 2>&1 || true
    kill "$pid"
    for _ in $(seq 1 10); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "$label 未及时退出，发送 SIGTERM 后仍在运行" >&2
    fi
  else
    echo "$label PID $pid 已不存在"
  fi

  rm -f "$pid_file"
}

echo "停止开发进程..."
stop_pid_file "Web UI" "$web_pid_file"
stop_pid_file "Server" "$server_pid_file"

if [ -f "infra/docker-compose.yml" ]; then
  echo "停止 Docker infra..."
  docker compose -f infra/docker-compose.yml down
else
  echo "未找到 infra/docker-compose.yml，跳过 Docker infra"
fi

echo "停止完成"
