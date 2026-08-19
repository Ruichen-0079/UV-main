"""Konsole launch / focus using supported KDE DBus interfaces.

Focus uses org.freedesktop.Application.Activate and Qt QWidget.raise/show
on the Konsole process we launched. No xdotool / click injection.

On Wayland, KWin may still refuse focus stealing. If DBus cannot reach
the window, the caller should reopen.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import time
from datetime import datetime, timezone
from typing import Any

from agentbus.paths import AgentbusError
from agentbus.store import StreamStore
from agentbus.util import pid_is_alive, run_cmd, utc_now


# Bump this when the AgentBus-owned watch-runner contract changes.  A runner
# from an older generation is not safe to reuse for a newly required role:
# replace its owned surface on the next reconciliation tick.
AGENTBUS_EXECUTOR_GENERATION = "agentbus-executor-v3"
EXECUTOR_START_GRACE_SECONDS = 15.0


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


def _launch_executor_process(argv: list[str], *, env: dict[str, str]) -> Any:
    """Launch one executor surface.

    Kept as a narrow seam so lifecycle tests can inject a deterministic
    process owner without ever opening a desktop terminal or watch runner.
    Production callers still use the normal detached subprocess path.
    """

    return subprocess.Popen(argv, start_new_session=True, env=env)


def _as_pid(value: Any) -> int | None:
    try:
        pid = int(value)
    except (TypeError, ValueError):
        return None
    return pid if pid > 0 else None


def _runner_token(slot: dict[str, Any]) -> str | None:
    for key in ("runner_token", "runner_start_token", "start_token"):
        value = slot.get(key)
        if value:
            return str(value)
    return None


def _runner_generation(slot: dict[str, Any]) -> str | None:
    for key in ("runner_generation", "executor_generation", "generation"):
        value = slot.get(key)
        if value:
            return str(value)
    return None


def _expected_dbus(pid: int) -> str:
    return f"org.kde.konsole-{pid}"


def agentbus_konsole_owned(slot: dict[str, Any] | None, stream_id: str, role: str) -> bool:
    """Return whether runtime facts prove this is our role surface.

    Legacy AgentBus slots did not persist explicit stream/role/owner fields.
    Their exact role title plus the DBus service identity remains sufficient to
    recognize those slots for safe replacement.  A title-only discovery is
    deliberately not ownership evidence.
    """

    if not isinstance(slot, dict) or role not in {"impl", "audit"}:
        return False
    expected_title = role_title(stream_id, role)
    if str(slot.get("title") or "").strip().upper() != expected_title.upper():
        return False
    owner = slot.get("owner") or slot.get("managed_by")
    if owner and str(owner).strip().lower() not in {"agentbus", "yuvi-agentbus"}:
        return False
    recorded_stream = slot.get("stream_id", slot.get("stream"))
    if recorded_stream is not None and str(recorded_stream) != str(stream_id):
        return False
    recorded_role = slot.get("role")
    if recorded_role is not None and str(recorded_role).lower() != role.lower():
        return False
    pid = _as_pid(slot.get("pid"))
    dbus = str(slot.get("dbus") or "")
    return bool(pid and dbus == _expected_dbus(pid))


def agentbus_runner_owned(slot: dict[str, Any] | None, stream_id: str, role: str) -> bool:
    """Prove ownership of a runner even after its Konsole has disappeared."""

    if not isinstance(slot, dict):
        return False
    expected_title = role_title(stream_id, role)
    if str(slot.get("title") or "").strip().upper() != expected_title.upper():
        return False
    owner = slot.get("owner") or slot.get("managed_by")
    if owner and str(owner).strip().lower() not in {"agentbus", "yuvi-agentbus"}:
        return False
    recorded_stream = slot.get("runner_stream_id", slot.get("stream_id", slot.get("stream")))
    recorded_role = slot.get("runner_role", slot.get("role"))
    if recorded_stream is not None and str(recorded_stream) != str(stream_id):
        return False
    if recorded_role is not None and str(recorded_role).lower() != role.lower():
        return False
    runner_pid = _as_pid(slot.get("runner_pid"))
    if not runner_pid or not _runner_token(slot):
        return False
    # If the Konsole identity is still present, validate it too.  When both
    # pid and DBus fields are gone, the runner PID start token is the remaining
    # safe ownership fact and lets us clean up an orphan without touching a
    # user's process.
    konsole_pid = _as_pid(slot.get("pid"))
    dbus = str(slot.get("dbus") or "")
    if konsole_pid and dbus != _expected_dbus(konsole_pid):
        return False
    if not konsole_pid and dbus:
        return False
    return True


def runner_is_usable(slot: dict[str, Any] | None, stream_id: str, role: str) -> bool:
    """Check the complete current-generation AgentBus runner identity."""

    if not agentbus_konsole_owned(slot, stream_id, role):
        return False
    assert slot is not None
    runner_pid = _as_pid(slot.get("runner_pid"))
    token = _runner_token(slot)
    if not runner_pid or not token or not pid_is_alive(runner_pid):
        return False
    from agentbus.util import pid_start_token

    actual = pid_start_token(runner_pid)
    if not actual or actual != token:
        return False
    if _runner_generation(slot) != AGENTBUS_EXECUTOR_GENERATION:
        return False
    recorded_stream = slot.get("runner_stream_id", slot.get("stream_id", slot.get("stream")))
    recorded_role = slot.get("runner_role", slot.get("role"))
    if recorded_stream is not None and str(recorded_stream) != str(stream_id):
        return False
    if recorded_role is not None and str(recorded_role).lower() != role.lower():
        return False
    return True


def _pending_runner_alive(slot: dict[str, Any], stream_id: str, role: str) -> bool:
    if not agentbus_konsole_owned(slot, stream_id, role):
        return False
    if slot.get("runner_pid") or not slot.get("runner_pending"):
        return False
    pid = _as_pid(slot.get("pid"))
    if not pid or not pid_is_alive(pid):
        return False
    raw = slot.get("runner_pending_since") or slot.get("started_at")
    if not raw:
        return False
    try:
        started = datetime.strptime(str(raw), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return time.time() - started.timestamp() <= EXECUTOR_START_GRACE_SECONDS


def executor_slot_status(slot: dict[str, Any] | None, stream_id: str, role: str) -> str:
    if runner_is_usable(slot, stream_id, role):
        return "live"
    if isinstance(slot, dict) and _pending_runner_alive(slot, stream_id, role):
        return "starting"
    if agentbus_konsole_owned(slot, stream_id, role) or agentbus_runner_owned(slot, stream_id, role):
        return "stale"
    return "foreign"


def slot_alive(slot: dict[str, Any] | None) -> bool:
    if not slot:
        return False
    pid = _as_pid(slot.get("pid"))
    if pid and pid_is_alive(pid):
        return True
    runner = _as_pid(slot.get("runner_pid"))
    if runner and pid_is_alive(runner):
        token = _runner_token(slot)
        if not token:
            return True
        from agentbus.util import pid_start_token

        return pid_start_token(runner) == token
    return False


def _clear_konsole_runtime(slot: dict[str, Any]) -> None:
    slot["pid"] = None
    slot["dbus"] = None
    slot["session"] = None
    slot["runner_pid"] = None
    slot["runner_token"] = None
    slot["runner_start_token"] = None
    slot["runner_pending"] = False
    slot["runner_pending_since"] = None


def _stop_owned_slot(
    runtime: dict[str, Any],
    stream_id: str,
    role: str,
    *,
    reason: str,
) -> dict[str, Any]:
    slot = ((runtime.get("konsole") or {}).get(role)) or {}
    konsole_owned = agentbus_konsole_owned(slot, stream_id, role)
    runner_owned = agentbus_runner_owned(slot, stream_id, role)
    if not konsole_owned and not runner_owned:
        return {"ok": False, "reason": "ownership fence rejected stop", "ownership": False}

    notes: list[str] = []
    runner_pid = _as_pid(slot.get("runner_pid"))
    runner_token = _runner_token(slot)
    if runner_pid and pid_is_alive(runner_pid):
        from agentbus.util import pid_start_token

        # Never signal a runner whose PID has been reused or whose legacy
        # record lacks a start token.  Closing our verified Konsole below is
        # still safe and will normally take the child runner with it.
        if runner_token and pid_start_token(runner_pid) == runner_token:
            try:
                os.kill(runner_pid, signal.SIGTERM)
                notes.append(f"stopped runner {runner_pid}")
            except OSError as exc:
                return {"ok": False, "reason": f"could not stop owned runner {runner_pid}: {exc}"}
        else:
            notes.append(f"left unverified runner {runner_pid} untouched")

    konsole_pid = _as_pid(slot.get("pid"))
    if konsole_owned and konsole_pid and pid_is_alive(konsole_pid):
        try:
            os.kill(konsole_pid, signal.SIGTERM)
            notes.append(f"closed Konsole {konsole_pid}")
        except OSError as exc:
            return {"ok": False, "reason": f"could not close owned Konsole {konsole_pid}: {exc}"}

    _clear_konsole_runtime(slot)
    slot["last_replaced_at"] = utc_now()
    slot["last_replace_reason"] = reason
    return {"ok": True, "notes": notes, "ownership": True}


def close_role_konsole(
    store: StreamStore,
    stream_id: str,
    role: str,
    *,
    reason: str = "executor replacement",
) -> dict[str, Any]:
    """Stop only a role surface proven AgentBus-owned by runtime facts."""

    if role not in {"impl", "audit"}:
        raise AgentbusError("role must be impl or audit")
    runtime = store.load_runtime()
    result = _stop_owned_slot(runtime, stream_id, role, reason=reason)
    if result.get("ok"):
        store.save_runtime(runtime)
        store.append_event("konsole-close", {"role": role, "reason": reason})
    return result


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
    status = executor_slot_status(slot, stream_id, role)
    if reuse and status in {"live", "starting"}:
        slot["reused"] = True
        slot["duplicate"] = False
        return slot
    if status == "stale":
        stopped = _stop_owned_slot(runtime, stream_id, role, reason="stale executor replacement")
        if not stopped.get("ok"):
            raise AgentbusError(str(stopped.get("reason") or "cannot replace stale executor"))
        store.save_runtime(runtime)
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
    launch_token = f"{stream_id}:{role}:{os.getpid()}:{time.time_ns()}"
    launch_env = _merged_env(env)
    launch_env.update(
        {
            "YUVI_AGENTBUS_EXECUTOR_GENERATION": AGENTBUS_EXECUTOR_GENERATION,
            "YUVI_AGENTBUS_EXECUTOR_TOKEN": launch_token,
            "YUVI_AGENTBUS_EXECUTOR_STREAM": str(stream_id),
            "YUVI_AGENTBUS_EXECUTOR_ROLE": role,
        }
    )
    proc = _launch_executor_process(argv, env=launch_env)
    konsole = runtime.setdefault("konsole", {})
    konsole[role] = {
        "pid": proc.pid,
        "dbus": f"org.kde.konsole-{proc.pid}",
        "session": None,
        "title": title,
        "started_at": utc_now(),
        "reused": False,
        "duplicate": False,
        "owner": "agentbus",
        "managed_by": "agentbus",
        "stream_id": stream_id,
        "role": role,
        "runner_stream_id": stream_id,
        "runner_role": role,
        "runner_generation": AGENTBUS_EXECUTOR_GENERATION,
        "executor_generation": AGENTBUS_EXECUTOR_GENERATION,
        "runner_pending": True,
        "runner_pending_since": utc_now(),
        "runner_launch_token": launch_token,
        "runner_pid": None,
        "runner_token": None,
    }
    store.save_runtime(runtime)
    store.append_event(
        "konsole-open",
        {"role": role, "pid": proc.pid, "title": title, "generation": AGENTBUS_EXECUTOR_GENERATION},
    )
    return konsole[role]


def ensure_role_konsole(
    store: StreamStore,
    stream_id: str,
    role: str,
    workdir: str,
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Ensure one current-generation AgentBus-owned role watch surface."""

    runtime = store.load_runtime()
    slot = ((runtime.get("konsole") or {}).get(role)) or {}
    status = executor_slot_status(slot, stream_id, role)
    if status == "live":
        slot["reused"] = True
        slot["duplicate"] = False
        return {"ok": True, "status": "reused", "role": role, "konsole": slot}
    if status == "starting":
        slot["reused"] = True
        slot["duplicate"] = False
        return {"ok": True, "status": "starting", "role": role, "konsole": slot}
    if status == "stale":
        stopped = close_role_konsole(
            store,
            stream_id,
            role,
            reason="dead or old-generation executor replacement",
        )
        if not stopped.get("ok"):
            return {"ok": False, "status": "wait", "role": role, **stopped}
    try:
        info = launch_role_konsole(
            store,
            stream_id,
            role,
            workdir,
            env=env,
            reuse=False,
        )
    except (AgentbusError, OSError) as exc:
        return {"ok": False, "status": "wait", "role": role, "reason": str(exc)}
    return {"ok": True, "status": "launched", "role": role, "konsole": info}


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
    if not agentbus_konsole_owned(slot, stream_id, role):
        return {
            "ok": False,
            "reason": "not_found",
            "action": "reopen",
            "message": f"No AgentBus-owned {title} Konsole is recorded. Open/Reopen instead.",
        }
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
    _clear_konsole_runtime(slot)
    runtime.setdefault("konsole", {})[role] = slot
    store.save_runtime(runtime)
