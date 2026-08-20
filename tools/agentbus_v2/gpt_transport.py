"""Operational automatic GPT lanes; semantic response handling stays in effects."""

from __future__ import annotations

from collections import deque
from contextlib import contextmanager
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from dataclasses import dataclass
import fcntl
import json
import logging
import os
from pathlib import Path
import tempfile
import threading
import time
from typing import Callable, Mapping, Protocol

from .core import Action, ActionKind
from .effects import submit_gpt_response
from .facts import FactError, load_config, load_gpt_packet, paths_for, read_snapshot


LANE_NAMES = ("plan", "judge")
OPERATION_LANES = {"PLAN_GPT": "plan", "JUDGE_GPT": "judge"}
LANE_CONFIG_FILE = "gpt_lanes.json"
LOGGER = logging.getLogger(__name__)


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
    conversation_url: str | None = None
    bridge_token: str | None = None


@dataclass(frozen=True)
class TransportResult:
    accepted: bool
    changed: bool = False
    detail: str = ""


@dataclass(frozen=True)
class _QueuedDispatch:
    p_id: str
    action: Action
    allow_merge: bool
    lane: str
    transport_name: str
    should_send: Callable[[], bool] | None
    on_complete: Callable[[TransportResult], None] | None


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
        bridge_token = value.get("bridge_token")
        if bridge_token is not None and (
            type(bridge_token) is not str or not bridge_token.strip()
        ):
            raise TypeError("bridge_token must be a non-empty string when supplied")
        for name in LANE_NAMES:
            raw = value.get(name, {})
            if not isinstance(raw, dict):
                raise TypeError(f"{name} lane must be an object")
            enabled = raw.get("enabled", False)
            transport = raw.get("transport", "manual")
            conversation_url = raw.get("conversation_url")
            lane_token = raw.get("bridge_token", bridge_token)
            if conversation_url is not None and (
                type(conversation_url) is not str or not conversation_url.strip()
            ):
                raise TypeError(f"{name} conversation_url must be a non-empty string")
            if lane_token is not None and (
                type(lane_token) is not str or not lane_token.strip()
            ):
                raise TypeError(f"{name} bridge_token must be a non-empty string")
            if type(enabled) is not bool or transport not in {"manual", "fake", "browser"}:
                raise TypeError(
                    f"{name} lane requires boolean enabled and manual/fake/browser transport"
                )
            result[name] = LaneConfig(
                name,
                enabled,
                transport,
                conversation_url=conversation_url,
                bridge_token=lane_token,
            )
        unknown = set(value) - set(LANE_NAMES) - {"bridge_token"}
        if unknown:
            raise TypeError(f"unknown GPT lanes: {sorted(unknown)}")
        enabled_browser = [
            config
            for config in result.values()
            if config.enabled and config.transport == "browser"
        ]
        if enabled_browser:
            from .browser_transport import canonical_conversation_url

            if any(
                config.conversation_url is None or config.bridge_token is None
                for config in enabled_browser
            ):
                raise TypeError(
                    "enabled browser lanes require conversation_url and bridge_token"
                )
            try:
                urls = [
                    canonical_conversation_url(str(config.conversation_url))
                    for config in enabled_browser
                ]
            except RuntimeError as error:
                raise TypeError(str(error)) from error
            if len(set(urls)) != len(urls):
                raise TypeError("enabled browser lanes require distinct conversation URLs")
            if len({config.bridge_token for config in enabled_browser}) != 1:
                raise TypeError("enabled browser lanes must share one bridge_token")
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
        browser_adapter: GPTAdapter | None = None,
        max_workers: int = 2,
    ) -> None:
        if max_workers <= 0:
            raise ValueError("max workers must be positive")
        self.state_root = Path(state_root).resolve()
        self.config_path = Path(config_path).resolve() if config_path else None
        self.adapters = dict(adapters or {})
        self._browser_adapter = browser_adapter
        self.max_workers = max_workers
        self._lock = threading.RLock()
        self._queues: dict[str, deque[_QueuedDispatch]] = {
            lane: deque() for lane in LANE_NAMES
        }
        self._active: dict[
            str, tuple[_QueuedDispatch, Future[TransportResult]]
        ] = {}
        self._jobs: set[str] = set()
        self._last_errors: dict[str, str] = {}
        # Ephemeral operational fencing only. A failed external boundary must
        # not cause this process to replay the same job or advance its lane
        # before an operator has classified whether Send may have happened.
        self._halted_lanes: set[str] = set()
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="agentbus-v2-gpt")
        self._closed = False

    def _config(self) -> dict[str, LaneConfig]:
        return load_lane_config(self.state_root, self.config_path)

    def _adapter_for(self, transport_name: str) -> GPTAdapter | None:
        adapter = self.adapters.get(transport_name)
        if adapter is not None:
            return adapter
        if transport_name != "browser":
            return None
        with self._lock:
            if self._closed:
                raise TransportError("GPT transport is closed")
            if self._browser_adapter is None:
                from .browser_transport import BrowserAdapter

                self._browser_adapter = BrowserAdapter(
                    self.state_root,
                    config_path=self.config_path,
                )
            return self._browser_adapter

    def mode_for(self, action: Action) -> str | None:
        lane = lane_for_action(action)
        if lane is None:
            return None
        config = self._config()[lane]
        with self._lock:
            dispatching = bool(action.effect_id and action.effect_id in self._jobs)
        if config.enabled and config.transport != "manual":
            return "AUTO DISPATCHING" if dispatching else "AUTO"
        return "MANUAL"

    @staticmethod
    def _notify(
        callback: Callable[[TransportResult], None] | None,
        result: TransportResult,
    ) -> None:
        if callback is None:
            return
        try:
            callback(result)
        except Exception:
            LOGGER.exception("GPT transport completion callback failed")

    def _start_next_locked(self, lane: str) -> None:
        if self._closed or lane in self._active or not self._queues[lane]:
            return
        queued = self._queues[lane].popleft()
        future = self._pool.submit(
            self._run,
            queued.p_id,
            queued.action,
            queued.allow_merge,
            queued.lane,
            queued.transport_name,
            queued.should_send,
        )
        self._active[lane] = (queued, future)
        future.add_done_callback(
            lambda done, lane=lane, queued=queued: self._finish(lane, queued, done)
        )

    def _finish(
        self,
        lane: str,
        queued: _QueuedDispatch,
        future: Future[TransportResult],
    ) -> None:
        try:
            result = future.result()
        except CancelledError:
            result = TransportResult(False, detail="GPT dispatch was cancelled during close")
        except Exception as error:
            result = TransportResult(False, detail=f"GPT transport exception: {error}")
        job_id = queued.action.effect_id
        with self._lock:
            active = self._active.get(lane)
            if active is None or active[0] is not queued or active[1] is not future:
                return
            self._active.pop(lane, None)
            if job_id is not None:
                self._jobs.discard(job_id)
            if result.accepted:
                self._last_errors.pop(lane, None)
                self._halted_lanes.discard(lane)
            else:
                self._last_errors[lane] = result.detail
                self._halted_lanes.add(lane)
            if result.accepted:
                self._start_next_locked(lane)
        self._notify(queued.on_complete, result)

    @staticmethod
    def _operation_for_lane(lane: str) -> str:
        if lane == "plan":
            return "PLAN_GPT"
        if lane == "judge":
            return "JUDGE_GPT"
        raise TransportError(f"unsupported GPT lane: {lane}")

    def _recheck_pending(
        self,
        paths,
        action: Action,
        lane: str,
        *,
        allow_merge: bool,
    ) -> str:
        """Confirm an already-created exact GPT effect remains deliverable.

        Once the packet exists, ``core.decide`` intentionally observes IDLE while
        the exact result is absent.  Delivery authority is instead the freshly
        recomputed, causally filtered ``gpt_pending`` identity plus the validated
        packet at that exact address.
        """
        if not action.effect_id:
            raise TransportError("GPT action has no effect identity")
        snapshot = read_snapshot(paths, allow_merge=allow_merge)
        if action.effect_id not in snapshot.gpt_pending:
            raise TransportError("GPT job is no longer a current pending effect")
        expected_operation = self._operation_for_lane(lane)
        packet = load_gpt_packet(paths, action.effect_id)
        if packet.get("operation") != expected_operation:
            raise TransportError("GPT packet operation no longer matches its lane")
        return expected_operation

    def try_dispatch(
        self,
        p_id: str,
        action: Action,
        *,
        allow_merge: bool = False,
        should_send: Callable[[], bool] | None = None,
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
        try:
            self._recheck_pending(
                paths,
                action,
                lane,
                allow_merge=allow_merge,
            )
        except (FactError, OSError, TransportError) as error:
            return TransportResult(False, detail=f"GPT transport unavailable: {error}")
        if result_path.exists():
            return TransportResult(False, detail="GPT result appeared before dispatch")
        with self._lock:
            if self._closed:
                return TransportResult(False, detail="GPT transport is closed")
            if lane in self._halted_lanes:
                return TransportResult(
                    False,
                    detail=(
                        f"{lane} lane is halted after operational failure: "
                        f"{self._last_errors.get(lane, 'unknown failure')}"
                    ),
                )
            if job_id in self._jobs:
                return TransportResult(False, detail=f"GPT job already queued or in flight: {job_id}")
            queued = _QueuedDispatch(
                p_id,
                action,
                allow_merge,
                lane,
                config.transport,
                should_send,
                on_complete,
            )
            self._jobs.add(job_id)
            self._queues[lane].append(queued)
            queued_behind = lane in self._active
            self._start_next_locked(lane)
        detail = "queued" if queued_behind else "dispatched"
        return TransportResult(True, detail=f"{detail} {job_id} on {lane}")

    def _run(
        self,
        p_id: str,
        action: Action,
        allow_merge: bool,
        lane: str,
        transport_name: str,
        should_send: Callable[[], bool] | None,
    ) -> TransportResult:
        paths = paths_for(self.state_root, p_id)
        result_path = paths.root / "gpt" / "results" / f"{action.effect_id}.json"
        try:
            with lane_lock(self.state_root, lane) as acquired:
                if not acquired:
                    return TransportResult(False, detail=f"{lane} lane is busy")
                if result_path.exists():
                    return TransportResult(False, detail="GPT result appeared before send")
                if should_send is not None and not should_send():
                    return TransportResult(False, detail="P was disabled before GPT send")
                lane_config = self._config()[lane]
                if not lane_config.enabled or lane_config.transport != transport_name:
                    return TransportResult(False, detail="GPT lane configuration changed before send")
                load_config(paths)
                operation = self._recheck_pending(
                    paths,
                    action,
                    lane,
                    allow_merge=allow_merge,
                )
                packet = paths.root / "gpt" / "outbox" / f"{action.effect_id}.md"
                packet_text = packet.read_text(encoding="utf-8")
                adapter = self._adapter_for(transport_name)
                if adapter is None:
                    raise TransportError(f"no adapter configured for {transport_name}")
                if result_path.exists():
                    return TransportResult(False, detail="GPT result appeared before send")
                if should_send is not None and not should_send():
                    return TransportResult(False, detail="P was disabled before GPT send")
                self._recheck_pending(
                    paths,
                    action,
                    lane,
                    allow_merge=allow_merge,
                )
                raw_response = adapter.send(
                    lane, action.effect_id, operation, packet_text
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
            busy = set(self._active)
            queued = {lane: len(items) for lane, items in self._queues.items()}
            halted = set(self._halted_lanes)
        rows: list[dict[str, object]] = []
        for lane in LANE_NAMES:
            row: dict[str, object] = {
                "name": lane,
                "enabled": configs[lane].enabled,
                "transport": configs[lane].transport,
                "busy": lane in busy,
                "queued": queued[lane],
                "halted": lane in halted,
            }
            if lane in self._last_errors:
                row["last_error"] = self._last_errors[lane]
            if configs[lane].transport == "browser":
                row["conversation_configured"] = bool(configs[lane].conversation_url)
                row["bridge_token_configured"] = bool(configs[lane].bridge_token)
            adapter = self.adapters.get(configs[lane].transport)
            if adapter is None and configs[lane].transport == "browser":
                adapter = self._browser_adapter
            lane_status = getattr(adapter, "lane_status", None)
            if lane_status is not None:
                try:
                    row.update(lane_status(lane))
                except Exception:
                    pass
            rows.append(row)
        return tuple(rows)

    def close(self) -> None:
        cancelled: list[_QueuedDispatch] = []
        with self._lock:
            if self._closed:
                return
            self._closed = True
            for lane in LANE_NAMES:
                cancelled.extend(self._queues[lane])
                for queued in self._queues[lane]:
                    if queued.action.effect_id is not None:
                        self._jobs.discard(queued.action.effect_id)
                self._queues[lane].clear()
        self._pool.shutdown(wait=False, cancel_futures=True)
        adapters = list(self.adapters.values())
        if self._browser_adapter is not None:
            adapters.append(self._browser_adapter)
        seen: set[int] = set()
        for adapter in adapters:
            if id(adapter) in seen:
                continue
            seen.add(id(adapter))
            close_adapter = getattr(adapter, "close", None)
            if close_adapter is not None:
                close_adapter()
        result = TransportResult(False, detail="GPT transport closed before queued dispatch")
        for queued in cancelled:
            self._notify(queued.on_complete, result)
