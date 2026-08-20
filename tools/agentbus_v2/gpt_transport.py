"""Operational automatic GPT lanes; semantic response handling stays in effects."""

from __future__ import annotations

from contextlib import contextmanager
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from typing import Callable, Mapping, Protocol

from .core import Action, ActionKind, decide
from .effects import submit_gpt_response
from .facts import FactError, load_config, paths_for, read_snapshot


LANE_NAMES = ("plan", "judge")
OPERATION_LANES = {"PLAN_GPT": "plan", "JUDGE_GPT": "judge"}
LANE_CONFIG_FILE = "gpt_lanes.json"


class TransportError(RuntimeError):
    """An operational transport failure, never a semantic GPT result."""


class GPTAdapter(Protocol):
    def send(self, lane: str, job_id: str, operation: str, packet_text: str) -> str:
        ...


@dataclass(frozen=True)
class LaneConfig:
    name: str
    enabled: bool
    transport: str


@dataclass(frozen=True)
class TransportResult:
    accepted: bool
    changed: bool = False
    detail: str = ""


def lane_for_operation(operation: str) -> str:
    try:
        return OPERATION_LANES[operation]
    except KeyError as error:
        raise TransportError(f"unsupported GPT operation: {operation}") from error


def lane_for_action(action: Action) -> str | None:
    if action.kind is ActionKind.PLAN:
        return "plan"
    if action.kind is ActionKind.JUDGE:
        return "judge"
    return None


def lane_config_path(state_root: Path) -> Path:
    return Path(state_root).resolve() / LANE_CONFIG_FILE


def _default_lanes() -> dict[str, LaneConfig]:
    return {name: LaneConfig(name, False, "manual") for name in LANE_NAMES}


def load_lane_config(state_root: Path, path: Path | None = None) -> dict[str, LaneConfig]:
    source = Path(path) if path is not None else lane_config_path(state_root)
    if not source.exists():
        return _default_lanes()
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise TypeError("lane config must be an object")
        result: dict[str, LaneConfig] = {}
        for name in LANE_NAMES:
            raw = value.get(name, {})
            if not isinstance(raw, dict):
                raise TypeError(f"{name} lane must be an object")
            enabled = raw.get("enabled", False)
            transport = raw.get("transport", "manual")
            if type(enabled) is not bool or transport not in {"manual", "fake"}:
                raise TypeError(f"{name} lane requires boolean enabled and manual/fake transport")
            result[name] = LaneConfig(name, enabled, transport)
        unknown = set(value) - set(LANE_NAMES)
        if unknown:
            raise TypeError(f"unknown GPT lanes: {sorted(unknown)}")
        return result
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise FactError(f"invalid GPT lane configuration {source}: {error}") from error


@contextmanager
def lane_lock(state_root: Path, lane: str):
    if lane not in LANE_NAMES:
        raise TransportError(f"unknown GPT lane: {lane}")
    path = lane_lock_path(state_root, lane)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def lane_lock_path(state_root: Path, lane: str) -> Path:
    return Path(state_root).resolve() / "gpt" / "lanes" / f"{lane}.lock"


class FakeGPTAdapter:
    """Deterministic adapter for tests; values are raw response strings."""

    def __init__(
        self,
        responses: Mapping[str, str | BaseException] | None = None,
        *,
        delay: float = 0.0,
        started: Callable[[str], None] | None = None,
    ) -> None:
        self.responses = dict(responses or {})
        self.delay = delay
        self.started = started

    def send(self, lane: str, job_id: str, operation: str, packet_text: str) -> str:
        if self.started is not None:
            self.started(job_id)
        if self.delay:
            time.sleep(self.delay)
        response = self.responses.get(job_id)
        if response is None:
            raise TransportError(f"fake response is absent for {job_id}")
        if isinstance(response, BaseException):
            raise response
        return response


class GPTTransport:
    """Level-triggered automatic dispatch with memory-only in-flight jobs."""

    def __init__(
        self,
        state_root: Path,
        *,
        config_path: Path | None = None,
        adapters: Mapping[str, GPTAdapter] | None = None,
        max_workers: int = 2,
    ) -> None:
        self.state_root = Path(state_root).resolve()
        self.config_path = Path(config_path).resolve() if config_path else None
        self.adapters = dict(adapters or {})
        self.max_workers = max_workers
        self._lock = threading.RLock()
        self._in_flight: dict[str, tuple[str, Future[TransportResult]]] = {}
        self._last_errors: dict[str, str] = {}
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="agentbus-v2-gpt")
        self._closed = False

    def _config(self) -> dict[str, LaneConfig]:
        return load_lane_config(self.state_root, self.config_path)

    def mode_for(self, action: Action) -> str | None:
        lane = lane_for_action(action)
        if lane is None:
            return None
        config = self._config()[lane]
        with self._lock:
            dispatching = bool(action.effect_id and action.effect_id in self._in_flight)
        if config.enabled and config.transport != "manual":
            return "AUTO DISPATCHING" if dispatching else "AUTO"
        return "MANUAL"

    def _finish(self, job_id: str, future: Future[TransportResult]) -> None:
        with self._lock:
            item = self._in_flight.get(job_id)
            if item is not None and item[1] is future:
                self._in_flight.pop(job_id, None)
                try:
                    result = future.result()
                except Exception as error:
                    self._last_errors[item[0]] = str(error)
                else:
                    if result.accepted:
                        self._last_errors.pop(item[0], None)
                    else:
                        self._last_errors[item[0]] = result.detail

    def try_dispatch(
        self,
        p_id: str,
        action: Action,
        *,
        allow_merge: bool = False,
        on_complete: Callable[[TransportResult], None] | None = None,
    ) -> TransportResult:
        lane = lane_for_action(action)
        if lane is None or not action.effect_id:
            return TransportResult(False, detail="not a GPT action")
        try:
            config = self._config()[lane]
        except FactError as error:
            return TransportResult(False, detail=f"GPT transport configuration error: {error}")
        if not config.enabled or config.transport == "manual":
            return TransportResult(False, detail=f"{lane} lane is manual")
        job_id = action.effect_id
        try:
            paths = paths_for(self.state_root, p_id)
            result_path = paths.root / "gpt" / "results" / f"{job_id}.json"
            packet_path = paths.root / "gpt" / "outbox" / f"{job_id}.md"
        except (FactError, OSError) as error:
            return TransportResult(False, detail=f"GPT transport cannot address P: {error}")
        if result_path.exists():
            return TransportResult(False, detail=f"GPT result already exists: {job_id}")
        if not packet_path.exists():
            return TransportResult(False, detail=f"GPT packet is absent: {packet_path}")
        with self._lock:
            if self._closed:
                self._pool = ThreadPoolExecutor(
                    max_workers=self.max_workers, thread_name_prefix="agentbus-v2-gpt"
                )
                self._closed = False
            if job_id in self._in_flight:
                return TransportResult(False, detail=f"GPT job already in flight: {job_id}")
            future = self._pool.submit(
                self._run, p_id, action, allow_merge, lane, config.transport
            )
            self._in_flight[job_id] = (lane, future)
            future.add_done_callback(lambda done: self._finish(job_id, done))
            if on_complete is not None:
                future.add_done_callback(lambda done: on_complete(done.result()))
        return TransportResult(True, detail=f"dispatched {job_id} on {lane}")

    def _run(
        self,
        p_id: str,
        action: Action,
        allow_merge: bool,
        lane: str,
        transport_name: str,
    ) -> TransportResult:
        paths = paths_for(self.state_root, p_id)
        result_path = paths.root / "gpt" / "results" / f"{action.effect_id}.json"
        try:
            with lane_lock(self.state_root, lane) as acquired:
                if not acquired:
                    return TransportResult(False, detail=f"{lane} lane is busy")
                if result_path.exists():
                    return TransportResult(False, detail="GPT result appeared before send")
                config = load_config(paths)
                snapshot = read_snapshot(paths, allow_merge=allow_merge)
                current = decide(snapshot)
                if current.kind is not action.kind or current.effect_id != action.effect_id:
                    return TransportResult(False, detail="GPT job is no longer current")
                packet = paths.root / "gpt" / "outbox" / f"{action.effect_id}.md"
                packet_text = packet.read_text(encoding="utf-8")
                adapter = self.adapters.get(transport_name)
                if adapter is None:
                    raise TransportError(f"no adapter configured for {transport_name}")
                raw_response = adapter.send(
                    lane, action.effect_id, "PLAN_GPT" if lane == "plan" else "JUDGE_GPT", packet_text
                )
                if not isinstance(raw_response, str) or not raw_response.strip():
                    raise TransportError("GPT adapter returned an empty response")
                fd, temporary_name = tempfile.mkstemp(
                    prefix=".gpt-transport-", suffix=".json", dir=paths.root
                )
                temporary = Path(temporary_name)
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as handle:
                        handle.write(raw_response)
                        handle.flush()
                    result = submit_gpt_response(paths, temporary)
                finally:
                    temporary.unlink(missing_ok=True)
                return TransportResult(True, result.changed, result.detail)
        except (FactError, OSError, TransportError, TimeoutError) as error:
            return TransportResult(False, detail=f"GPT transport unavailable: {error}")
        except Exception as error:
            return TransportResult(False, detail=f"GPT transport exception: {error}")

    def status(self) -> tuple[dict[str, object], ...]:
        try:
            configs = self._config()
        except FactError as error:
            return ({"error": str(error)},)
        with self._lock:
            busy = {lane for lane, _future in self._in_flight.values()}
        return tuple(
            {
                "name": lane,
                "enabled": configs[lane].enabled,
                "transport": configs[lane].transport,
                "busy": lane in busy,
                **({"last_error": self._last_errors[lane]} if lane in self._last_errors else {}),
            }
            for lane in LANE_NAMES
        )

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._pool.shutdown(wait=False, cancel_futures=True)
