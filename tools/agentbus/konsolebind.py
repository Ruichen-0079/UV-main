"""Konsole launch / focus using supported KDE DBus interfaces.

Focus uses org.freedesktop.Application.Activate and Qt QWidget.raise/show
on the Konsole process we launched. No xdotool / click injection.

On Wayland, KWin may still refuse focus stealing. If DBus cannot reach
the window, the caller should reopen.
"""

from __future__ import annotations

import os
import re
import subprocess
from typing import Any

from agentbus.paths import AgentbusError
from agentbus.store import StreamStore
from agentbus.util import pid_is_alive, run_cmd, utc_now


def _merged_env(env: dict[str, str] | None = None) -> dict[str, str]:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    return merged


def konsole_bin(env: dict[str, str] | None = None) -> str:
    return _merged_env(env).get("YUVI_AGENTBUS_KONSOLE") or "konsole"


def qdbus_bin(env: dict[str, str] | None = None) -> str | None:
    for name in ("qdbus6", "qdbus-qt6", "qdbus"):
        from agentbus.util import which

        found = which(name, env)
        if found:
            return found
    return None


def role_title(stream_id: str, role: str) -> str:
    return f"{stream_id.upper()} | {role.upper()}"


def agentctl_path() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "agentctl"))


def slot_alive(slot: dict[str, Any] | None) -> bool:
    if not slot:
        return False
    pid = slot.get("pid")
    if pid and pid_is_alive(int(pid)):
        return True
    runner = slot.get("runner_pid")
    if runner and pid_is_alive(int(runner)):
        token = slot.get("runner_token")
        if not token:
            return True
        from agentbus.util import pid_start_token

        return pid_start_token(int(runner)) == token
    return False


def launch_role_konsole(
    store: StreamStore,
    stream_id: str,
    role: str,
    workdir: str,
    *,
    extra_args: list[str] | None = None,
    env: dict[str, str] | None = None,
    reuse: bool = True,
) -> dict[str, Any]:
    if role not in {"impl", "audit"}:
        raise AgentbusError("role must be impl or audit")
    if not workdir or not os.path.isdir(workdir):
        raise AgentbusError(f"cannot open {role} Konsole: worktree missing")
    title = role_title(stream_id, role)
    runtime = store.load_runtime()
    slot = ((runtime.get("konsole") or {}).get(role)) or {}
    if reuse and slot_alive(slot):
        slot["reused"] = True
        slot["duplicate"] = False
        return slot
    found = discover_konsole_by_title(title, env=env) if reuse else None
    if found and found.get("pid") and pid_is_alive(int(found["pid"])):
        runtime.setdefault("konsole", {})[role] = {**slot, **found, "reused": True, "title": title}
        store.save_runtime(runtime)
        return runtime["konsole"][role]
    argv = [
        konsole_bin(env),
        "--separate",
        "--workdir",
        workdir,
        "-p",
        f"tabtitle={title}",
        "-p",
        f"LocalTabTitleFormat={title}",
        "-e",
        agentctl_path(),
        "--repo",
        store.ctx.repo_root if hasattr(store, "ctx") else os.getcwd(),
        "run",
        stream_id,
        role,
        "--watch",
    ]
    if extra_args:
        argv.extend(extra_args)
    proc = subprocess.Popen(argv, start_new_session=True, env=_merged_env(env))
    konsole = runtime.setdefault("konsole", {})
    konsole[role] = {
        "pid": proc.pid,
        "dbus": f"org.kde.konsole-{proc.pid}",
        "session": None,
        "title": title,
        "started_at": utc_now(),
        "reused": False,
        "runner_pid": None,
        "runner_token": None,
    }
    store.save_runtime(runtime)
    store.append_event("konsole-open", {"role": role, "pid": proc.pid, "title": title})
    return konsole[role]


def count_title_matches(title: str, *, env: dict[str, str] | None = None) -> int:
    found = 0
    binary = qdbus_bin(env)
    if not binary:
        return 0
    listed = run_cmd([binary], timeout=5)
    if listed.returncode != 0:
        return 0
    wanted = title.strip().upper()
    for line in listed.stdout.splitlines():
        service = line.strip()
        if not service.startswith("org.kde.konsole-"):
            continue
        sessions = run_cmd([binary, service], timeout=5)
        for sess_line in sessions.stdout.splitlines():
            path = sess_line.strip()
            if not path.startswith("/Sessions/"):
                continue
            got = run_cmd([binary, service, path, "org.kde.konsole.Session.title", "0"], timeout=5)
            if wanted in (got.stdout or "").strip().upper():
                found += 1
                break
    return found


def _qdbus(service: str, path: str, *args: str, env: dict[str, str] | None = None) -> tuple[int, str]:
    binary = qdbus_bin(env)
    if not binary:
        return 1, "qdbus6 not available"
    result = run_cmd([binary, service, path, *args], timeout=5)
    return result.returncode, (result.stdout or result.stderr).strip()


def focus_role_konsole(
    store: StreamStore,
    stream_id: str,
    role: str,
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    runtime = store.load_runtime()
    slot = ((runtime.get("konsole") or {}).get(role)) or {}
    title = slot.get("title") or role_title(stream_id, role)
    dbus_name = slot.get("dbus")
    pid = slot.get("pid")
    if pid and not pid_is_alive(int(pid)):
        slot["pid"] = None
        store.save_runtime(runtime)
        return {
            "ok": False,
            "reason": "closed",
            "action": "reopen",
            "message": f"{title} Konsole is not running. Open/Reopen will start a new visible terminal. Stream state is unchanged.",
        }
    if not dbus_name and pid:
        dbus_name = f"org.kde.konsole-{pid}"
    if not dbus_name:
        found = discover_konsole_by_title(title, env=env)
        if found:
            dbus_name = found.get("dbus")
            slot.update(found)
            runtime.setdefault("konsole", {})[role] = slot
            store.save_runtime(runtime)
    if not dbus_name:
        return {
            "ok": False,
            "reason": "not_found",
            "action": "reopen",
            "message": f"No Konsole titled {title} is reachable over DBus. Open/Reopen instead.",
        }
    code, out = _qdbus(dbus_name, "/org/kde/konsole", "org.freedesktop.Application.Activate", "{}", env=env)
    _qdbus(dbus_name, "/konsole/MainWindow_1", "org.qtproject.Qt.QWidget.showNormal", env=env)
    _qdbus(dbus_name, "/konsole/MainWindow_1", "org.qtproject.Qt.QWidget.raise", env=env)
    _qdbus(dbus_name, "/konsole/MainWindow_1", "org.qtproject.Qt.QWidget.show", env=env)
    if code != 0 and "does not exist" in out.lower():
        return {
            "ok": False,
            "reason": "closed",
            "action": "reopen",
            "message": f"{title} Konsole DBus name is gone. Window was closed. Stream state is unchanged.",
        }
    return {
        "ok": True,
        "method": "kde-dbus",
        "dbus": dbus_name,
        "message": f"Asked {title} to raise via Konsole/KDE DBus. Wayland may still keep focus if KWin blocks focus stealing.",
    }


def discover_konsole_by_title(title: str, *, env: dict[str, str] | None = None) -> dict[str, Any] | None:
    binary = qdbus_bin(env)
    if not binary:
        return None
    listed = run_cmd([binary], timeout=5)
    if listed.returncode != 0:
        return None
    wanted = title.strip().upper()
    for line in listed.stdout.splitlines():
        service = line.strip()
        if not service.startswith("org.kde.konsole-"):
            continue
        pid_match = re.search(r"org\.kde\.konsole-(\d+)", service)
        sessions = run_cmd([binary, service], timeout=5)
        for sess_line in sessions.stdout.splitlines():
            path = sess_line.strip()
            if not path.startswith("/Sessions/"):
                continue
            for role_id in ("0", "1"):
                got = run_cmd([binary, service, path, "org.kde.konsole.Session.title", role_id], timeout=5)
                text = (got.stdout or "").strip().upper()
                if wanted in text or text == wanted:
                    return {
                        "pid": int(pid_match.group(1)) if pid_match else None,
                        "dbus": service,
                        "session": path.rsplit("/", 1)[-1],
                        "title": title,
                    }
    return None


def record_closed(store: StreamStore, role: str) -> None:
    runtime = store.load_runtime()
    slot = ((runtime.get("konsole") or {}).get(role)) or {}
    slot["pid"] = None
    slot["dbus"] = None
    runtime.setdefault("konsole", {})[role] = slot
    store.save_runtime(runtime)
