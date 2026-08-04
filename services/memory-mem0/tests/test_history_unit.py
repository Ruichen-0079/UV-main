from __future__ import annotations

from typing import Any

import pytest

from yuvi_mem0.config import Settings
from yuvi_mem0.errors import MEMORY_NOT_FOUND, UNSUPPORTED_OPERATION, SidecarError
from yuvi_mem0.memory import Mem0Service


class _FakeMemory:
    def __init__(self, history_rows: list[dict[str, Any]] | None = None) -> None:
        self._history = history_rows or []
        self._store: dict[str, dict[str, Any]] = {}

    def get(self, memory_id: str) -> dict[str, Any] | None:
        return self._store.get(memory_id)

    def history(self, memory_id: str) -> list[dict[str, Any]]:
        return [row for row in self._history if row.get("memory_id") == memory_id]


def _service_with_fake(fake: _FakeMemory) -> Mem0Service:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
    )
    service = Mem0Service(settings=settings)
    service._memory = fake  # type: ignore[attr-defined]
    return service


def test_history_normalizes_create_update_delete_events() -> None:
    fake = _FakeMemory(
        history_rows=[
            {
                "id": "h1",
                "memory_id": "m1",
                "event": "ADD",
                "old_memory": None,
                "new_memory": "likes blue",
                "created_at": "2026-01-01T00:00:00",
            },
            {
                "id": "h2",
                "memory_id": "m1",
                "event": "UPDATE",
                "old_memory": "likes blue",
                "new_memory": "likes red",
                "created_at": "2026-01-02T00:00:00",
            },
            {
                "id": "h3",
                "memory_id": "m1",
                "event": "DELETE",
                "old_memory": "likes red",
                "new_memory": None,
                "created_at": "2026-01-03T00:00:00",
            },
        ]
    )
    fake._store["m1"] = {"id": "m1", "memory": "likes red", "user_id": "scope-a"}
    service = _service_with_fake(fake)
    entries = service.history("m1", scope="scope-a")
    assert [e.event for e in entries] == ["ADD", "UPDATE", "DELETE"]
    assert entries[0].newValue == "likes blue"
    assert entries[1].previousValue == "likes blue"
    assert entries[1].newValue == "likes red"
    assert entries[2].previousValue == "likes red"
    assert all(e.memoryId == "m1" for e in entries)


def test_history_missing_id_returns_empty() -> None:
    service = _service_with_fake(_FakeMemory())
    assert service.history("does-not-exist") == []


def test_history_wrong_scope_returns_empty() -> None:
    fake = _FakeMemory(
        history_rows=[
            {
                "id": "h1",
                "memory_id": "m1",
                "event": "ADD",
                "old_memory": None,
                "new_memory": "secret",
                "created_at": "2026-01-01T00:00:00",
            }
        ]
    )
    fake._store["m1"] = {"id": "m1", "memory": "secret", "user_id": "scope-a"}
    service = _service_with_fake(fake)
    assert service.history("m1", scope="scope-b") == []


def test_history_scope_not_found_raises_on_get_path() -> None:
    """get() with wrong scope raises MEMORY_NOT_FOUND; history softens to []."""
    service = _service_with_fake(_FakeMemory())
    with pytest.raises(SidecarError) as exc:
        service.get("missing", scope="scope-a")
    assert exc.value.code == MEMORY_NOT_FOUND


def test_history_missing_method_is_unsupported() -> None:
    class NoHistory:
        def get(self, memory_id: str) -> dict[str, Any] | None:
            return {"id": memory_id, "memory": "x", "user_id": "scope-a"}

    service = _service_with_fake(NoHistory())  # type: ignore[arg-type]
    with pytest.raises(SidecarError) as exc:
        service.history("m1", scope="scope-a")
    assert exc.value.code == UNSUPPORTED_OPERATION
    assert exc.value.retryable is False
