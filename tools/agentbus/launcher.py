"""Start-or-reuse the localhost WebUI. Never writes shell startup files."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

from agentbus.paths import AgentbusError, RepoContext, default_state_root
from agentbus.util import atomic_write_json, pid_is_alive, read_json
from agentbus.web import DEFAULT_HOST, DEFAULT_PORT, serve_forever


def web_meta_path(env: dict[str, str] | None = None) -> str:
    return os.path.join(default_state_root(env), "webui.json")


def probe(host: str, port: int, timeout: float = 0.4) -> dict[str, Any] | None:
    url = f"http://{host}:{port}/api/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None
    if isinstance(data, dict) and data.get("ok") and data.get("service") == "yuvi-agentbus":
        return data
    return None


def port_in_use(host: str, port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(0.2)
        return sock.connect_ex((host, port)) == 0
    finally:
        sock.close()


def choose_port(host: str, preferred: int) -> int:
    if not port_in_use(host, preferred):
        return preferred
    health = probe(host, preferred)
    if health:
        return preferred
    for candidate in range(preferred + 1, preferred + 6):
        if not port_in_use(host, candidate):
            return candidate
    raise AgentbusError(
        f"port {preferred} is in use by something that is not AgentBus, "
        f"and no fallback in {preferred + 1}-{preferred + 5} is free. "
        "Refusing to kill the other listener."
    )


def write_meta(ctx: RepoContext, host: str, port: int, pid: int, env: dict[str, str] | None = None) -> str:
    path = web_meta_path(env)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    atomic_write_json(
        path,
        {
            "host": host,
            "port": port,
            "url": f"http://{host}:{port}/",
            "pid": pid,
            "repo_id": ctx.repo_id,
            "repo_root": ctx.repo_root,
        },
    )
    return path


def existing_url(ctx: RepoContext, host: str, port: int, env: dict[str, str] | None = None) -> str | None:
    health = probe(host, port)
    if health:
        return f"http://{host}:{port}/"
    meta = read_json(web_meta_path(env), default=None)
    if not isinstance(meta, dict):
        return None
    meta_port = int(meta.get("port") or 0)
    meta_host = str(meta.get("host") or host)
    if meta_port and probe(meta_host, meta_port):
        return f"http://{meta_host}:{meta_port}/"
    pid = meta.get("pid")
    if pid and not pid_is_alive(int(pid)):
        return None
    return None


def open_browser(url: str) -> None:
    subprocess.Popen(["xdg-open", url], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def desktop_path(env: dict[str, str] | None = None) -> str:
    environ = env or os.environ
    data = environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(data, "applications", "yuvi-agentbus.desktop")


def install_desktop_entry(repo_root: str, env: dict[str, str] | None = None) -> str:
    launch = os.path.abspath(os.path.join(repo_root, "scripts", "yuvi-agentbus-launch"))
    icon = os.path.abspath(os.path.join(repo_root, "tools", "agentbus", "webui", "icon.svg"))
    path = desktop_path(env)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = f"""[Desktop Entry]
Type=Application
Name=Yuvi AgentBus
Comment=Local multi-agent orchestration dashboard
Exec={launch}
Icon={icon}
Terminal=false
Categories=Development;Utility;
StartupNotify=true
Keywords=yuvi;agentbus;codex;
"""
    from agentbus.util import atomic_write_text

    atomic_write_text(path, body)
    updater = os.path.join(os.path.dirname(path))
    subprocess.run(["update-desktop-database", updater], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return path


def spawn_daemon(ctx: RepoContext, host: str, port: int) -> None:
    argv = [
        sys.executable,
        "-m",
        "agentbus",
        "--repo",
        ctx.repo_root,
        "web",
        "--no-open",
        "--foreground",
        "--host",
        host,
        "--port",
        str(port),
    ]
    log_path = os.path.join(ctx.state_root, "webui.log")
    os.makedirs(ctx.state_root, exist_ok=True)
    log = open(log_path, "a", encoding="utf-8")
    env = os.environ.copy()
    tools = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    env["PYTHONPATH"] = tools + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    subprocess.Popen(argv, start_new_session=True, stdout=log, stderr=log, env=env, cwd=ctx.repo_root)


def run_web(
    ctx: RepoContext,
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    open_browser_tab: bool = True,
    foreground: bool = False,
    install_desktop: bool = False,
    env: dict[str, str] | None = None,
) -> int:
    if host not in {"127.0.0.1", "localhost"}:
        raise AgentbusError("WebUI binds to 127.0.0.1 only")
    host = "127.0.0.1"
    if install_desktop:
        install_desktop_entry(ctx.repo_root, env)
    url = existing_url(ctx, host, port, env)
    if url:
        if open_browser_tab:
            open_browser(url)
        print(url)
        print("Already running. Reusing the existing WebUI (no second server).")
        return 0
    chosen = choose_port(host, port)
    if chosen != port:
        print(f"preferred port {port} is busy with a non-AgentBus listener; using {chosen}")
    if foreground:
        write_meta(ctx, host, chosen, os.getpid(), env)
        print(f"http://{host}:{chosen}/")
        if open_browser_tab:
            open_browser(f"http://{host}:{chosen}/")
        serve_forever(ctx, host, chosen, env)
        return 0
    spawn_daemon(ctx, host, chosen)
    deadline = time.time() + 8
    while time.time() < deadline:
        if probe(host, chosen):
            write_meta(ctx, host, chosen, 0, env)
            url = f"http://{host}:{chosen}/"
            if open_browser_tab:
                open_browser(url)
            print(url)
            return 0
        time.sleep(0.15)
    raise AgentbusError("WebUI did not become healthy after start")
