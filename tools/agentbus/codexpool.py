"""Two-slot Codex invocation pool with conservative capacity failover."""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from agentbus.config import discover_profiles
from agentbus.lock import StreamLock
from agentbus.paths import RepoContext
from agentbus.util import atomic_write_json, pid_is_alive, pid_start_token, read_json, utc_now


AVAILABLE = "AVAILABLE"
BUSY = "BUSY"
COOLDOWN = "COOLDOWN"

SUCCESS = "SUCCESS"
RETRYABLE_TRANSIENT = "RETRYABLE_TRANSIENT"
CAPACITY_WAIT = "CAPACITY_WAIT"
FAILED = "FAILED"

SLOT_PRIMARY = "primary"
SLOT_SECONDARY = "secondary"
SLOT_ORDER = (SLOT_PRIMARY, SLOT_SECONDARY)
CAPACITY_BACKOFF_MINUTES = (15, 30, 60)


def pool_path(ctx: RepoContext) -> str:
    return os.path.join(ctx.repo_state, "codex-pool.json")


def pool_lock(ctx: RepoContext) -> StreamLock:
    return StreamLock(os.path.join(ctx.repo_state, "codex-pool.lock"))


def slot_homes(env: dict[str, str] | None = None) -> dict[str, str]:
    environ = env or os.environ
    home = environ.get("HOME") or os.path.expanduser("~")
    return {
        SLOT_PRIMARY: os.path.abspath(
            environ.get("YUVI_AGENTBUS_CODEX_PRIMARY_HOME") or os.path.join(home, ".codex")
        ),
        SLOT_SECONDARY: os.path.abspath(
            environ.get("YUVI_AGENTBUS_CODEX_SECONDARY_HOME") or os.path.join(home, ".codex-secondary")
        ),
    }


def default_pool(env: dict[str, str] | None = None) -> dict[str, Any]:
    homes = slot_homes(env)
    return {
        "schema_version": 1,
        "slots": {
            name: {
                "name": name,
                "codex_home": homes[name],
                "status": AVAILABLE,
                "last_capacity_error": None,
                "capacity_count": 0,
                "failure_count": 0,
                "last_failure": None,
                "retry_after": None,
                "next_probe_at": None,
                "active_stream": None,
                "active_role": None,
                "owner_pid": None,
                "owner_token": None,
            }
            for name in SLOT_ORDER
        },
    }


def _parse_time(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.strptime(str(raw), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _format_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slot_defaults(name: str, home: str) -> dict[str, Any]:
    return default_pool({
        "HOME": os.path.dirname(home),
        f"YUVI_AGENTBUS_CODEX_{name.upper()}_HOME": home,
    })["slots"][name]


def load_pool(ctx: RepoContext, env: dict[str, str] | None = None) -> dict[str, Any]:
    raw = read_json(pool_path(ctx), default=None)
    if not isinstance(raw, dict):
        raw = default_pool(env)
    raw.setdefault("schema_version", 1)
    slots = raw.setdefault("slots", {})
    homes = slot_homes(env)
    for name in SLOT_ORDER:
        slot = slots.setdefault(name, {})
        defaults = default_pool(env)["slots"][name]
        for key, value in defaults.items():
            slot.setdefault(key, value)
        # Homes are configuration, not copied credentials. Keep them exact.
        slot["codex_home"] = homes[name]
    return raw


def save_pool(ctx: RepoContext, pool: dict[str, Any]) -> dict[str, Any]:
    os.makedirs(ctx.repo_state, exist_ok=True)
    pool["updated_at"] = utc_now()
    atomic_write_json(pool_path(ctx), pool)
    return pool


def _busy_owner_alive(slot: dict[str, Any]) -> bool:
    pid = slot.get("owner_pid")
    if not pid or not pid_is_alive(int(pid)):
        return False
    expected = slot.get("owner_token")
    return not expected or pid_start_token(int(pid)) == expected


def reconcile_pool(pool: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    for slot in (pool.get("slots") or {}).values():
        status = slot.get("status")
        if status == BUSY and not _busy_owner_alive(slot):
            _make_available(slot)
        elif status == COOLDOWN:
            deadline = _parse_time(slot.get("next_probe_at"))
            if deadline is not None and current >= deadline:
                _make_available(slot, keep_capacity=True)
    return pool


def _make_available(slot: dict[str, Any], *, keep_capacity: bool = True) -> None:
    slot["status"] = AVAILABLE
    slot["active_stream"] = None
    slot["active_role"] = None
    slot["owner_pid"] = None
    slot["owner_token"] = None
    slot["retry_after"] = None
    slot["next_probe_at"] = None
    if not keep_capacity:
        slot["capacity_count"] = 0
        slot["last_capacity_error"] = None


def _slot_env(base: dict[str, str] | None, codex_home: str) -> dict[str, str]:
    result = dict(base or os.environ)
    result["CODEX_HOME"] = codex_home
    return result


def _profile_compatible(slot: dict[str, Any], profile: str | None, env: dict[str, str] | None) -> bool:
    if not profile:
        return True
    return profile in discover_profiles(_slot_env(env, str(slot["codex_home"])))


def acquire_slot(
    ctx: RepoContext,
    *,
    stream: str,
    role: str,
    profile: str | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Reserve primary, then secondary. Returns WAIT when neither can run."""
    incompatible: list[str] = []
    with pool_lock(ctx):
        pool = reconcile_pool(load_pool(ctx, env))
        for name in SLOT_ORDER:
            slot = pool["slots"][name]
            if slot.get("status") != AVAILABLE:
                continue
            if not _profile_compatible(slot, profile, env):
                incompatible.append(name)
                continue
            slot["status"] = BUSY
            slot["active_stream"] = stream
            slot["active_role"] = role
            slot["owner_pid"] = os.getpid()
            slot["owner_token"] = pid_start_token(os.getpid())
            slot["acquired_at"] = utc_now()
            save_pool(ctx, pool)
            return {
                "ok": True,
                "slot": name,
                "codex_home": slot["codex_home"],
                "env": _slot_env(env, str(slot["codex_home"])),
            }
        save_pool(ctx, pool)
        statuses = {name: pool["slots"][name].get("status") for name in SLOT_ORDER}
    if len(incompatible) == 2:
        reason = "configured Codex profile is unavailable in both CODEX_HOME slots"
    elif incompatible:
        reason = (
            "configured Codex profile is unavailable on "
            + ", ".join(incompatible)
            + "; the compatible slot is busy or cooling down"
        )
    else:
        reason = "both Codex slots are busy or cooling down"
    return {"ok": False, "wait": True, "reason": reason, "statuses": statuses, "incompatible": incompatible}


def release_slot(
    ctx: RepoContext,
    slot_name: str,
    *,
    success: bool = False,
    env: dict[str, str] | None = None,
) -> None:
    with pool_lock(ctx):
        pool = reconcile_pool(load_pool(ctx, env))
        slot = pool["slots"].get(slot_name)
        if not slot:
            return
        _make_available(slot, keep_capacity=not success)
        if success:
            slot["failure_count"] = 0
            slot["last_failure"] = None
        slot["released_at"] = utc_now()
        save_pool(ctx, pool)


def mark_failure(
    ctx: RepoContext,
    slot_name: str,
    message: str,
    *,
    env: dict[str, str] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Cool down an unexplained failed slot without misclassifying capacity."""
    current = now or datetime.now(timezone.utc)
    with pool_lock(ctx):
        pool = reconcile_pool(load_pool(ctx, env), now=current)
        slot = pool["slots"][slot_name]
        count = int(slot.get("failure_count") or 0) + 1
        slot["failure_count"] = count
        slot["last_failure"] = str(message or "Codex invocation failed")[:500]
        # Unknown failures receive a bounded probe schedule.  They become a
        # human issue only after both independent homes repeatedly fail.
        delay = (5, 15, 30)[min(count - 1, 2)]
        retry = current + timedelta(minutes=delay)
        slot["status"] = COOLDOWN
        slot["retry_after"] = _format_time(retry)
        slot["next_probe_at"] = _format_time(retry)
        slot["active_stream"] = None
        slot["active_role"] = None
        slot["owner_pid"] = None
        slot["owner_token"] = None
        save_pool(ctx, pool)
        return dict(slot)


def _precise_reset(text: str, now: datetime) -> datetime | None:
    duration = re.search(r"(?i)(?:retry|try again)\s+(?:after|in)\s+(\d+)\s*(seconds?|minutes?|hours?)", text)
    if duration:
        amount = int(duration.group(1))
        unit = duration.group(2).lower()
        seconds = amount * (3600 if unit.startswith("hour") else 60 if unit.startswith("minute") else 1)
        return now + timedelta(seconds=max(60, seconds))
    stamp = re.search(r"(?i)(?:reset(?:s)?(?: at)?|retry_after)[:=\s]+(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ)", text)
    if stamp:
        return _parse_time(stamp.group(1))
    epoch = re.search(r'"resets_at"\s*:\s*(\d{10})', text)
    if epoch:
        try:
            reset = datetime.fromtimestamp(int(epoch.group(1)), tz=timezone.utc)
            return reset if reset > now else None
        except (OverflowError, ValueError):
            return None
    return None


def mark_capacity(
    ctx: RepoContext,
    slot_name: str,
    message: str,
    *,
    env: dict[str, str] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    with pool_lock(ctx):
        pool = reconcile_pool(load_pool(ctx, env), now=current)
        slot = pool["slots"][slot_name]
        count = int(slot.get("capacity_count") or 0) + 1
        slot["capacity_count"] = count
        reset = _precise_reset(message, current)
        if reset is None:
            reset = current + timedelta(minutes=CAPACITY_BACKOFF_MINUTES[min(count - 1, len(CAPACITY_BACKOFF_MINUTES) - 1)])
        slot["status"] = COOLDOWN
        slot["last_capacity_error"] = str(message or "capacity exhausted")[:500]
        slot["retry_after"] = _format_time(reset)
        slot["next_probe_at"] = _format_time(reset)
        slot["active_stream"] = None
        slot["active_role"] = None
        slot["owner_pid"] = None
        slot["owner_token"] = None
        save_pool(ctx, pool)
        return dict(slot)


def classify_invocation(exit_code: int, output: str) -> str:
    if exit_code == 0:
        return SUCCESS
    text = str(output or "").lower()
    capacity_patterns = (
        r"you(?:'ve| have) hit (?:your )?(?:codex )?usage limit",
        r"(?:codex )?usage limit (?:has been )?(?:reached|exceeded)",
        r"insufficient_quota",
        r"quota (?:has been )?exceeded",
        r"weekly (?:usage )?limit",
        r"not enough (?:credits|quota)",
        r"limit resets? (?:at|in)",
        r'"rate_limit_reached_type"\s*:\s*"[^"]+"',
        r'"spend_control_reached"\s*:\s*true',
        r'"used_percent"\s*:\s*100(?:\.0+)?',
    )
    if any(re.search(pattern, text) for pattern in capacity_patterns):
        return CAPACITY_WAIT
    transient_patterns = (
        "network error",
        "connection reset",
        "connection timed out",
        "temporary unavailable",
        "temporarily unavailable",
        "service unavailable",
        "gateway timeout",
        "http 502",
        "http 503",
        "http 504",
        "too many requests",
    )
    if any(item in text for item in transient_patterns):
        return RETRYABLE_TRANSIENT
    return FAILED


def pool_status(ctx: RepoContext, env: dict[str, str] | None = None) -> dict[str, Any]:
    with pool_lock(ctx):
        pool = reconcile_pool(load_pool(ctx, env))
        save_pool(ctx, pool)
    slots = pool.get("slots") or {}
    available = any(slot.get("status") == AVAILABLE for slot in slots.values())
    return {"available": available, "slots": slots}
