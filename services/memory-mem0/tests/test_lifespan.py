"""FastAPI lifespan lifecycle: lazy init, shutdown release, no on_event."""

from __future__ import annotations

import warnings

import pytest
from fastapi.testclient import TestClient

from yuvi_mem0.schemas import (
    HealthCapabilities,
    HealthComponents,
    HealthData,
    HealthEmbedding,
)


class TrackingService:
    """Minimal stand-in for Mem0Service used by lifespan tests."""

    def __init__(self) -> None:
        self.init_calls = 0
        self.shutdown_calls = 0
        self.health_calls = 0
        self._ready = False

    def initialize(self) -> None:
        self.init_calls += 1
        self._ready = True

    def shutdown(self) -> None:
        self.shutdown_calls += 1
        self._ready = False

    def health(self) -> HealthData:
        self.health_calls += 1
        return HealthData(
            status="degraded" if not self._ready else "healthy",
            components=HealthComponents(
                mem0="healthy" if self._ready else "unhealthy",
                embedder="healthy",
                vectorStore="healthy",
                memoryLlm="not_configured",
            ),
            capabilities=HealthCapabilities(
                infer=False,
                crud=self._ready,
                search=self._ready,
            ),
            embedding=HealthEmbedding(
                provider="ollama",
                model="yuvi-embedding:0.6b",
                dimensions=1024,
            ),
            collection="yuvi_mem0_qwen3_1024_v1",
            message="lifespan-test",
        )


def test_app_module_has_no_on_event_decorators() -> None:
    import inspect

    import yuvi_mem0.app as app_module

    source = inspect.getsource(app_module)
    assert "@app.on_event" not in source
    assert "on_event(" not in source
    assert "lifespan" in source


def test_lifespan_defers_initialization_and_shuts_down(monkeypatch: pytest.MonkeyPatch) -> None:
    import yuvi_mem0.app as app_module

    tracker = TrackingService()
    monkeypatch.setattr(app_module, "get_service", lambda: tracker)
    # Force has_pg path by ensuring settings.has_pg True via real settings if present;
    # startup validates configuration but does not initialize Mem0.
    from yuvi_mem0.config import Settings

    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
        mem0_llm_model="",
        mem0_llm_api_key="",
    )
    monkeypatch.setattr(app_module, "get_settings", lambda: settings)

    with TestClient(app_module.app) as client:
        assert tracker.init_calls == 0
        r1 = client.get("/health")
        r2 = client.get("/health")
        assert r1.status_code == 200
        assert r2.status_code == 200
        # Health does not initialize Mem0.
        assert tracker.init_calls == 0
        assert tracker.health_calls == 2
        assert tracker.shutdown_calls == 0

    assert tracker.shutdown_calls == 1
    # No initialize was needed for an idle sidecar.
    assert tracker.init_calls == 0


def test_lifespan_startup_without_pg_skips_initialize(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import yuvi_mem0.app as app_module
    from yuvi_mem0.config import Settings

    tracker = TrackingService()
    monkeypatch.setattr(app_module, "get_service", lambda: tracker)
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="",
        mem0_llm_model="",
        mem0_llm_api_key="",
    )
    monkeypatch.setattr(app_module, "get_settings", lambda: settings)

    with TestClient(app_module.app) as client:
        assert tracker.init_calls == 0
        response = client.get("/health")
        assert response.status_code == 200
        assert tracker.init_calls == 0

    assert tracker.shutdown_calls == 1


def test_service_shutdown_clears_memory_and_is_idempotent() -> None:
    from yuvi_mem0.config import Settings
    from yuvi_mem0.memory import Mem0Service

    service = Mem0Service(
        settings=Settings(
            _env_file=None,  # type: ignore[call-arg]
            mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
        )
    )
    service._memory = object()  # type: ignore[attr-defined]
    service._embed_cache = (0.0, "healthy", None)
    service._vector_cache = (0.0, "healthy", None)

    service.shutdown()
    assert service._memory is None
    assert service._embed_cache is None
    assert service._vector_cache is None
    # Second call must not raise.
    service.shutdown()


def test_no_on_event_deprecation_warning_on_client_startup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import yuvi_mem0.app as app_module
    from yuvi_mem0.config import Settings

    tracker = TrackingService()
    monkeypatch.setattr(app_module, "get_service", lambda: tracker)
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
    )
    monkeypatch.setattr(app_module, "get_settings", lambda: settings)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        with TestClient(app_module.app) as client:
            client.get("/health")

    messages = [str(w.message) for w in caught]
    dep = [m for m in messages if "on_event" in m.lower() or "deprecated" in m.lower()]
    # Filter only FastAPI on_event deprecations (our migration target).
    on_event_deps = [m for m in dep if "on_event" in m]
    assert on_event_deps == [], f"unexpected on_event deprecations: {on_event_deps}"
