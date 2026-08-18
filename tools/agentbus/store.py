from __future__ import annotations

import json
import os
from typing import Any, Iterator

from agentbus.lock import StreamLock
from agentbus.models import empty_runtime, empty_state, migrate_state
from agentbus.paths import AgentbusError, RepoContext, ensure_stream_dirs, normalize_stream_id, stream_dir
from agentbus.util import append_text, atomic_write_json, read_json, utc_now


EVENT_SOFT_LIMIT = 2_000_000


class StreamStore:
    def __init__(self, ctx: RepoContext, stream_id: str) -> None:
        self.ctx = ctx
        self.stream_id = normalize_stream_id(stream_id)
        self.path = stream_dir(ctx, self.stream_id)
        self.state_path = os.path.join(self.path, "state.json")
        self.runtime_path = os.path.join(self.path, "runtime.json")
        self.events_path = os.path.join(self.path, "events.jsonl")
        self.lock_path = os.path.join(self.path, "lock")
        self.inbox_dir = os.path.join(self.path, "inbox")
        self.processed_dir = os.path.join(self.path, "inbox", "processed")
        self.artifacts_dir = os.path.join(self.path, "artifacts")
        self.logs_dir = os.path.join(self.path, "logs")

    def exists(self) -> bool:
        return os.path.isfile(self.state_path)

    def lock(self, *, exclusive: bool = True) -> StreamLock:
        return StreamLock(self.lock_path, exclusive=exclusive)

    def initialize(self, **overrides: Any) -> dict[str, Any]:
        if self.exists():
            raise AgentbusError(f"stream {self.stream_id} already exists")
        ensure_stream_dirs(self.path)
        state = empty_state(self.stream_id)
        state.update({k: v for k, v in overrides.items() if v is not None})
        state["updated_at"] = utc_now()
        atomic_write_json(self.state_path, state)
        atomic_write_json(self.runtime_path, empty_runtime())
        self.append_event("created", {"state": state["phase"]})
        return state

    def load(self) -> dict[str, Any]:
        if not self.exists():
            raise AgentbusError(f"unknown stream {self.stream_id}")
        try:
            state = read_json(self.state_path)
        except json.JSONDecodeError as exc:
            raise AgentbusError(f"corrupt state.json for {self.stream_id}: {exc}") from exc
        if not isinstance(state, dict):
            raise AgentbusError(f"corrupt state.json for {self.stream_id}")
        return migrate_state(state)

    def save(self, state: dict[str, Any]) -> dict[str, Any]:
        state["updated_at"] = utc_now()
        atomic_write_json(self.state_path, state)
        return state

    def load_runtime(self) -> dict[str, Any]:
        data = read_json(self.runtime_path, default=None)
        if not isinstance(data, dict):
            data = empty_runtime()
        return data

    def save_runtime(self, runtime: dict[str, Any]) -> dict[str, Any]:
        atomic_write_json(self.runtime_path, runtime)
        return runtime

    def append_event(self, kind: str, payload: dict[str, Any] | None = None) -> None:
        record = {"ts": utc_now(), "stream": self.stream_id, "kind": kind}
        if payload:
            record.update(payload)
        line = json.dumps(record, sort_keys=True)
        rotate_events(self.events_path)
        append_text(self.events_path, line)

    def artifact_path(self, name: str) -> str:
        return os.path.join(self.artifacts_dir, name)

    def write_artifact(self, name: str, content: str) -> str:
        path = self.artifact_path(name)
        from agentbus.util import atomic_write_text

        atomic_write_text(path, content if content.endswith("\n") else content + "\n")
        return path

    def impl_log(self) -> str:
        return os.path.join(self.logs_dir, "impl.log")

    def audit_log(self) -> str:
        return os.path.join(self.logs_dir, "audit.log")

    def log_path(self, role: str) -> str:
        if role == "audit":
            return self.audit_log()
        return self.impl_log()


def list_stream_ids(ctx: RepoContext) -> list[str]:
    if not os.path.isdir(ctx.repo_state):
        return []
    found: list[str] = []
    for name in sorted(os.listdir(ctx.repo_state)):
        if os.path.isfile(os.path.join(ctx.repo_state, name, "state.json")):
            found.append(name)
    return found


def iter_stores(ctx: RepoContext) -> Iterator[StreamStore]:
    for stream_id in list_stream_ids(ctx):
        yield StreamStore(ctx, stream_id)


def rotate_events(path: str, limit: int = EVENT_SOFT_LIMIT) -> None:
    if not os.path.isfile(path):
        return
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    if size < limit:
        return
    archived = path + ".1"
    try:
        os.replace(path, archived)
    except OSError:
        return
