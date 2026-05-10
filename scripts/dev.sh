#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

state_dir="${XDG_RUNTIME_DIR:-/tmp}/yuvi-runtime-dev"
mkdir -p "$state_dir"

server_pid_file="$state_dir/server.pid"
web_pid_file="$state_dir/web.pid"
server_log="$state_dir/server.log"
web_log="$state_dir/web.log"

server_url="http://localhost:6121"
web_url="http://localhost:5173"
websocket_url="ws://localhost:6121/ws"

add_node_path() {
  if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
    return
  fi

  if [ -d "$HOME/.nvm/versions/node" ]; then
    local node_bin
    node_bin="$(find "$HOME/.nvm/versions/node" -mindepth 3 -maxdepth 3 -type f -name node -printf '%h\n' | sort -V | tail -n 1 || true)"
    if [ -n "$node_bin" ]; then
      export PATH="$node_bin:$PATH"
    fi
  fi
}

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

check_file_presence() {
  if [ -f ".env.example" ]; then
    echo "已找到 .env.example"
  else
    echo "缺少 .env.example" >&2
    exit 1
  fi

  if [ -f ".env" ]; then
    echo "已找到 .env（不会打印内容）"
  else
    echo "未找到 .env；开发模式会依赖当前 shell 环境和 mock fallback"
  fi
}

start_infra() {
  if [ -f "infra/docker-compose.yml" ]; then
    echo "启动 Docker infra..."
    docker compose -f infra/docker-compose.yml up -d
  else
    echo "未找到 infra/docker-compose.yml，跳过 Docker infra"
  fi
}

install_dependencies_if_needed() {
  if [ ! -d "node_modules" ]; then
    echo "未找到 node_modules，执行 pnpm install..."
    pnpm install
  else
    echo "已找到 node_modules，跳过 pnpm install"
  fi
}

start_server() {
  if [ ! -f "apps/server/package.json" ]; then
    echo "未找到 apps/server，跳过 server"
    return
  fi

  if is_running "$server_pid_file"; then
    echo "Server 已在运行，PID $(cat "$server_pid_file")"
    return
  fi

  echo "启动 Server: $server_url"
  env \
    NODE_ENV="${NODE_ENV:-development}" \
    PROVIDER_ALLOW_MOCKS="${PROVIDER_ALLOW_MOCKS:-true}" \
    MEMORY_REPOSITORY="${MEMORY_REPOSITORY:-memory}" \
    DATABASE_URL="${DATABASE_URL:-postgres://airi:airi_dev_password@localhost:5432/companion}" \
    SERVER_HOST="${SERVER_HOST:-127.0.0.1}" \
    SERVER_PORT="${SERVER_PORT:-6121}" \
    setsid bash -lc 'cd apps/server && exec ../../node_modules/.bin/tsx --conditions development src/index.ts' >"$server_log" 2>&1 < /dev/null &

  echo "$!" > "$server_pid_file"

  wait_for_server
}

start_web() {
  if [ ! -f "apps/web/package.json" ]; then
    echo "未找到 apps/web，跳过 Web UI"
    return
  fi

  if is_running "$web_pid_file"; then
    echo "Web UI 已在运行，PID $(cat "$web_pid_file")"
    return
  fi

  echo "启动 Web UI: $web_url"
  setsid bash -lc 'cd apps/web && exec pnpm dev -- --host 0.0.0.0 --port 5173' >"$web_log" 2>&1 < /dev/null &

  echo "$!" > "$web_pid_file"
  sleep 2

  if ! is_running "$web_pid_file"; then
    echo "Web UI 启动失败，最近日志：" >&2
    tail -n 80 "$web_log" >&2 || true
    exit 1
  fi
}

wait_for_server() {
  for _ in $(seq 1 20); do
    if ! is_running "$server_pid_file"; then
      echo "Server 启动失败，最近日志：" >&2
      tail -n 80 "$server_log" >&2 || true
      rm -f "$server_pid_file"
      exit 1
    fi

    if command -v curl >/dev/null 2>&1 && curl --fail --silent --show-error "$server_url/health" >/dev/null 2>&1; then
      echo "Server health check 通过"
      return
    fi

    sleep 1
  done

  echo "Server 已启动但 /health 暂未通过，最近日志：" >&2
  tail -n 80 "$server_log" >&2 || true
  exit 1
}

add_node_path

echo "检查开发工具..."
require_tool node
require_tool pnpm
require_tool docker
require_tool setsid
docker compose version >/dev/null

node --version
pnpm --version
docker --version
docker compose version

check_file_presence
start_infra
install_dependencies_if_needed
start_server
start_web

echo
echo "开发服务已启动："
echo "  Server:    $server_url"
echo "  Web UI:    $web_url"
echo "  WebSocket: $websocket_url"
echo
echo "日志目录：$state_dir"
echo "检查状态：./scripts/health.sh"
echo "停止服务：./scripts/stop.sh"
