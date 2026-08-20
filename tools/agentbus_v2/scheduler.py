"""Operational level-triggered scheduling for independent P tick loops."""

from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, replace
import json
import logging
import os
from pathlib import Path
import tempfile
import threading
import time
from typing import Callable, Sequence

from .core import Action, ActionKind, Snapshot
from .facts import FactError, PPaths, load_config, load_gpt_packet, paths_for, read_snapshot


DEFAULT_POLL_INTERVAL = 20.0
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProjectEntry:
    p_id: str
    enabled: bool = True
    allow_merge: bool = False


@dataclass(frozen=True)
class ProjectRegistry:
    path: Path
    entries: tuple[ProjectEntry, ...]

    @property
    def enabled(self) -> tuple[ProjectEntry, ...]:
        return tuple(item for item in self.entries if item.enabled)


@dataclass(frozen=True)
class SchedulerEvent:
    timestamp: float
    p_id: str
    action: str
    changed: bool
    detail: str = ""
    error: str | None = None

    def as_dict(self) -> dict[str, object]:
        value: dict[str, object] = {
            "timestamp": self.timestamp,
            "p_id": self.p_id,
            "action": self.action,
            "changed": self.changed,
            "detail": self.detail,
        }
        if self.error is not None:
            value["error"] = self.error
        return value


TickFunction = Callable[..., tuple[Action, object | None]]


def registry_path(state_root: Path) -> Path:
    return Path(state_root).resolve() / "projects.json"


def _validate_entries(state_root: Path, entries: Sequence[ProjectEntry]) -> None:
    seen_ids: set[str] = set()
    seen_states: set[Path] = set()
    seen_worktrees: dict[Path, str] = {}
    for entry in entries:
        if entry.p_id in seen_ids:
            raise FactError(f"duplicate scheduler P_ID: {entry.p_id}")
        seen_ids.add(entry.p_id)
        paths = paths_for(state_root, entry.p_id)
        state = paths.root.resolve()
        if state in seen_states:
            raise FactError(f"duplicate scheduler state mapping: {state}")
        seen_states.add(state)
        config = load_config(paths)
        if config.p_id != entry.p_id:
            raise FactError(
                f"scheduler P_ID/config mismatch: {entry.p_id} != {config.p_id}"
            )
        if not entry.enabled:
            continue
        worktree = Path(config.worktree).expanduser().resolve()
        prior = seen_worktrees.get(worktree)
        if prior is not None:
            raise FactError(
                f"enabled scheduler Ps share worktree {worktree}: {prior}, {entry.p_id}"
            )
        seen_worktrees[worktree] = entry.p_id


def load_registry(
    state_root: Path, path: Path | None = None, *, validate: bool = True
) -> ProjectRegistry:
    root = Path(state_root).resolve()
    source = Path(path) if path is not None else registry_path(root)
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FactError(f"invalid scheduler registry {source}: {error}") from error
    raw_entries = value.get("projects") if isinstance(value, dict) else None
    if not isinstance(raw_entries, list):
        raise FactError(f"scheduler registry projects must be a list: {source}")
    entries: list[ProjectEntry] = []
    for raw in raw_entries:
        if not isinstance(raw, dict):
            raise FactError(f"scheduler registry entry must be an object: {source}")
        p_id = raw.get("p_id")
        enabled = raw.get("enabled", True)
        allow_merge = raw.get("allow_merge", False)
        if (
            type(p_id) is not str
            or type(enabled) is not bool
            or type(allow_merge) is not bool
        ):
            raise FactError(
                f"scheduler entry requires string p_id and boolean enabled/allow_merge: {source}"
            )
        entries.append(ProjectEntry(p_id, enabled, allow_merge))
    result = ProjectRegistry(source.resolve(), tuple(entries))
    if validate:
        _validate_entries(root, result.entries)
    return result


def update_project(
    state_root: Path,
    p_id: str,
    *,
    enabled: bool | None = None,
    allow_merge: bool | None = None,
    path: Path | None = None,
) -> ProjectRegistry:
    """Atomically update one operational registry entry and nothing semantic."""
    if enabled is None and allow_merge is None:
        raise FactError("project update requires enabled or allow_merge")
    source = Path(path) if path is not None else registry_path(state_root)
    with _REGISTRY_MUTATION_LOCK:
        current = load_registry(state_root, source)
        updated: list[ProjectEntry] = []
        found = False
        for entry in current.entries:
            if entry.p_id != p_id:
                updated.append(entry)
                continue
            found = True
            updated.append(
                replace(
                    entry,
                    enabled=entry.enabled if enabled is None else enabled,
                    allow_merge=entry.allow_merge if allow_merge is None else allow_merge,
                )
            )
        if not found:
            raise FactError(f"unknown scheduler P_ID: {p_id}")
        _validate_entries(Path(state_root).resolve(), updated)
        source.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {"projects": [
                {"p_id": item.p_id, "enabled": item.enabled, "allow_merge": item.allow_merge}
                for item in updated
            ]},
            indent=2,
            sort_keys=True,
        ) + "\n"
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{source.name}.", suffix=".tmp", dir=source.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, source)
        finally:
            temporary.unlink(missing_ok=True)
        return load_registry(state_root, source)


_REGISTRY_MUTATION_LOCK = threading.Lock()


def _default_tick(state_root: Path, p_id: str, *, allow_merge: bool):
    from .cli import tick_once

    return tick_once(state_root, p_id, allow_merge=allow_merge)


def pending_gpt_action(paths: PPaths, snapshot: Snapshot) -> Action | None:
    """Reconstruct one exact pending GPT delivery from a fresh snapshot.

    A fresh snapshot projects at most the exact causally current GPT outbox
    into ``gpt_pending``; the packet supplies only the logical operation needed
    to select the transport lane.
    """
    if len(snapshot.gpt_pending) != 1:
        return None
    job_id = next(iter(snapshot.gpt_pending))
    packet = load_gpt_packet(paths, job_id)
    operation = packet.get("operation")
    if operation == "PLAN_GPT":
        return Action(ActionKind.PLAN, effect_id=job_id)
    if operation == "JUDGE_GPT":
        return Action(ActionKind.JUDGE, effect_id=job_id)
    raise FactError(f"current GPT packet has unsupported operation: {operation!r}")


def _pending_gpt_action(
    state_root: Path, p_id: str, *, allow_merge: bool
) -> Action | None:
    """Fresh-read wrapper used by memoryless scheduler recovery."""
    paths = paths_for(state_root, p_id)
    return pending_gpt_action(
        paths,
        read_snapshot(paths, allow_merge=allow_merge),
    )


class Scheduler:
    """A memory-only level-triggered collection of independent P ticks."""

    def __init__(
        self,
        state_root: Path,
        *,
        registry_path: Path | None = None,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        max_workers: int | None = None,
        tick_function: TickFunction | None = None,
        registry: ProjectRegistry | None = None,
        gpt_transport=None,
    ) -> None:
        if poll_interval <= 0:
            raise ValueError("poll interval must be positive")
        if max_workers is not None and max_workers <= 0:
            raise ValueError("max workers must be positive")
        self.state_root = Path(state_root).resolve()
        self.registry_file = (
            Path(registry_path).resolve()
            if registry_path is not None
            else self.state_root / "projects.json"
        )
        self.poll_interval = float(poll_interval)
        self.max_workers = max_workers
        self.tick_function = tick_function or _default_tick
        self._fixed_registry = registry
        self._in_flight: dict[str, Future[tuple[Action, object | None]]] = {}
        self._immediate_used: set[str] = set()
        self._pool: ThreadPoolExecutor | None = None
        self._stop = threading.Event()
        self._state_lock = threading.RLock()
        self._running = False
        self._closed = False
        self._wake_requested: set[str] = set()
        if gpt_transport is None:
            from .gpt_transport import GPTTransport

            gpt_transport = GPTTransport(self.state_root)
        self.gpt_transport = gpt_transport

    def _registry(self) -> ProjectRegistry:
        if self._fixed_registry is not None:
            return self._fixed_registry
        return load_registry(self.state_root, self.registry_file)

    def _pool_for(self, registry: ProjectRegistry) -> ThreadPoolExecutor:
        if self._closed:
            raise RuntimeError("scheduler is closed")
        if self._pool is None:
            # Registry membership is stable while enable flags are operational.
            # Size for every registered P so later re-enable cannot silently
            # collapse otherwise independent Ps onto the first-start capacity.
            workers = self.max_workers or max(1, len(registry.entries))
            self._pool = ThreadPoolExecutor(
                max_workers=workers, thread_name_prefix="agentbus-v2-p"
            )
        return self._pool

    def _submit(
        self,
        entry: ProjectEntry,
        registry: ProjectRegistry,
        *,
        force: bool = False,
    ) -> bool:
        with self._state_lock:
            if (
                self._closed
                or (not entry.enabled and not force)
                or entry.p_id in self._in_flight
                or self._stop.is_set()
            ):
                return False
            future = self._pool_for(registry).submit(
                self.tick_function,
                self.state_root,
                entry.p_id,
                allow_merge=entry.allow_merge,
            )
            self._in_flight[entry.p_id] = future
            self._wake_requested.discard(entry.p_id)
            return True

    def is_in_flight(self, p_id: str) -> bool:
        with self._state_lock:
            return p_id in self._in_flight

    def is_running(self) -> bool:
        with self._state_lock:
            return self._running

    def submit_now(
        self,
        p_id: str,
        *,
        on_event: Callable[[SchedulerEvent], None] | None = None,
    ) -> Future[tuple[Action, object | None]]:
        """Submit one registered P without creating a persisted tick request."""
        registry = self._registry()
        entry = next((item for item in registry.entries if item.p_id == p_id), None)
        if entry is None:
            raise FactError(f"unknown scheduler P_ID: {p_id}")
        with self._state_lock:
            if self._closed:
                raise RuntimeError("scheduler is closed")
            if p_id in self._in_flight:
                raise RuntimeError(f"P is already in flight: {p_id}")
            was_stopped = self._stop.is_set()
            if was_stopped:
                self._stop.clear()
            submitted = self._submit(entry, registry, force=True)
            if not submitted:
                if was_stopped:
                    self._stop.set()
                raise RuntimeError(f"P could not be submitted: {p_id}")
            future = self._in_flight[p_id]
            # A one-shot submission made while the polling loop is stopped has
            # no collector to retire its future.  Retire it from the callback
            # in that case; a running loop remains the collector so it can
            # apply its normal immediate-retick policy.
            running = self._running
            if not running:
                def finish(done: Future[tuple[Action, object | None]]) -> None:
                    with self._state_lock:
                        if self._in_flight.get(p_id) is not done:
                            return
                        self._in_flight.pop(p_id, None)
                    try:
                        action, _result = done.result()
                    except Exception:
                        action = None
                    if action is not None:
                        self._dispatch_gpt(p_id, action)
                    if on_event is not None:
                        self._emit(on_event, self._event(p_id, done))

                future.add_done_callback(finish)
            elif on_event is not None:
                # The polling loop remains the sole lifecycle collector.  A
                # per-submit callback may observe completion but must not race
                # the loop to retire or redispatch the same future.
                future.add_done_callback(
                    lambda done: self._emit(on_event, self._event(p_id, done))
                )
            if was_stopped:
                self._stop.set()
            return future

    def _submit_enabled(self, registry: ProjectRegistry) -> None:
        for entry in registry.enabled:
            self._submit(entry, registry)

    @staticmethod
    def _emit(
        callback: Callable[[SchedulerEvent], None], event: SchedulerEvent
    ) -> None:
        try:
            callback(event)
        except Exception:
            LOGGER.exception("scheduler event callback failed")

    def _current_entry(self, p_id: str) -> ProjectEntry | None:
        registry = self._registry()
        return next((item for item in registry.entries if item.p_id == p_id), None)

    def _is_enabled(self, p_id: str) -> bool:
        entry = self._current_entry(p_id)
        return bool(entry is not None and entry.enabled)

    def _dispatch_gpt(self, p_id: str, action: Action) -> None:
        with self._state_lock:
            if self._closed or self._stop.is_set():
                return
            wake_on_complete = self._running
        try:
            entry = self._current_entry(p_id)
        except (FactError, OSError):
            return
        if entry is None or not entry.enabled:
            return
        candidate = action
        if candidate.kind not in {ActionKind.PLAN, ActionKind.JUDGE}:
            try:
                candidate = _pending_gpt_action(
                    self.state_root,
                    p_id,
                    allow_merge=entry.allow_merge,
                )
            except (FactError, OSError):
                return
            if candidate is None:
                return
        self.gpt_transport.try_dispatch(
            p_id,
            candidate,
            allow_merge=entry.allow_merge,
            should_send=lambda: self._is_enabled(p_id),
            on_complete=(
                (lambda result: self._gpt_completed(p_id, result))
                if wake_on_complete
                else None
            ),
        )

    def _gpt_completed(self, p_id: str, result: object) -> None:
        if not bool(getattr(result, "changed", False)):
            return
        with self._state_lock:
            if self._closed or self._stop.is_set():
                return
            self._wake_requested.add(p_id)
        self._drain_wake(p_id)

    def _drain_wake(self, p_id: str) -> None:
        with self._state_lock:
            if (
                p_id not in self._wake_requested
                or self._closed
                or self._stop.is_set()
            ):
                return
        try:
            registry = self._registry()
        except (FactError, OSError):
            return
        entry = next((item for item in registry.entries if item.p_id == p_id), None)
        if entry is None or not entry.enabled:
            with self._state_lock:
                self._wake_requested.discard(p_id)
            return
        self._submit(entry, registry)

    @staticmethod
    def _event(p_id: str, future: Future[tuple[Action, object | None]]) -> SchedulerEvent:
        now = time.time()
        try:
            action, result = future.result()
        except Exception as error:
            return SchedulerEvent(now, p_id, "ERROR", False, error=str(error))
        changed = bool(result is not None and getattr(result, "changed", False))
        detail = getattr(result, "detail", "") if result is not None else action.reason
        return SchedulerEvent(now, p_id, action.kind.value, changed, str(detail))

    def _collect(self, done: Sequence[Future[tuple[Action, object | None]]], registry: ProjectRegistry) -> tuple[SchedulerEvent, ...]:
        # Registry flags are operational and may change while a long tick is in
        # flight.  Completion must use the fresh enable/merge permissions, not
        # the registry instance that originally submitted the tick.
        registry = self._registry()
        with self._state_lock:
            by_future = {future: p_id for p_id, future in self._in_flight.items()}
        pending = [future for future in done if future in by_future]
        events: list[SchedulerEvent] = []
        for future in sorted(pending, key=lambda item: by_future[item]):
            p_id = by_future[future]
            with self._state_lock:
                self._in_flight.pop(p_id, None)
            event = self._event(p_id, future)
            events.append(event)
            try:
                action, _result = future.result()
            except Exception:
                action = None
            if action is not None:
                self._dispatch_gpt(p_id, action)
            entry = next((item for item in registry.entries if item.p_id == p_id), None)
            if event.changed and p_id not in self._immediate_used and entry is not None and entry.enabled:
                if self._submit(entry, registry):
                    self._immediate_used.add(p_id)
            else:
                self._immediate_used.discard(p_id)
            self._drain_wake(p_id)
        return tuple(events)

    def run_once(self) -> tuple[SchedulerEvent, ...]:
        """Submit due P ticks and collect already completed work once."""
        registry = self._registry()
        self._submit_enabled(registry)
        with self._state_lock:
            futures = tuple(self._in_flight.values())
        done = tuple(future for future in futures if future.done())
        return self._collect(done, registry) if done else ()

    def run(
        self,
        *,
        on_event: Callable[[SchedulerEvent], None] | None = None,
    ) -> None:
        next_poll = 0.0
        registry: ProjectRegistry | None = None
        with self._state_lock:
            self._running = True
        try:
            while not self._stop.is_set():
                now = time.monotonic()
                if registry is None or now >= next_poll:
                    registry = self._registry()
                    self._submit_enabled(registry)
                    next_poll = now + self.poll_interval
                with self._state_lock:
                    futures = tuple(self._in_flight.values())
                if not futures:
                    self._stop.wait(max(0.0, next_poll - time.monotonic()))
                    continue
                timeout = min(0.2, max(0.0, next_poll - time.monotonic()))
                done, _ = wait(
                    futures,
                    timeout=timeout,
                    return_when=FIRST_COMPLETED,
                )
                if done:
                    for event in self._collect(tuple(done), registry):
                        if on_event is not None:
                            self._emit(on_event, event)
        except KeyboardInterrupt:
            self.stop()
        finally:
            # Fence GPT completion callbacks before publishing that the polling
            # loop is no longer running or closing its pools.
            self.stop()
            with self._state_lock:
                self._running = False
            self.close()

    def stop(self) -> None:
        self._stop.set()

    def close(self) -> None:
        self.stop()
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            self._wake_requested.clear()
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
        close_transport = getattr(self.gpt_transport, "close", None)
        if close_transport is not None:
            close_transport()

    def status(self) -> dict[str, object]:
        registry = self._registry()
        with self._state_lock:
            in_flight = sorted(self._in_flight)
            running = self._running
        return {
            "running": running,
            "enabled_p_ids": [item.p_id for item in registry.enabled],
            "in_flight_p_ids": in_flight,
        }


def scheduler_status(state_root: Path, *, registry_path: Path | None = None) -> dict[str, object]:
    registry = load_registry(state_root, registry_path)
    return {
        "running": False,
        "enabled_p_ids": [item.p_id for item in registry.enabled],
        "in_flight_p_ids": [],
    }
