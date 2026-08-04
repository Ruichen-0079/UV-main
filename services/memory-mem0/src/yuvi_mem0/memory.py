"""Mem0 service wrapper with health probes and YUVI-normalized results."""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from yuvi_mem0.config import Settings, get_settings
from yuvi_mem0.errors import (
    EMBEDDER_UNAVAILABLE,
    INTERNAL_ERROR,
    MEM0_EMBEDDER_PATCH_UNSUPPORTED,
    MEM0_INITIALIZATION_FAILED,
    MEMORY_LLM_NOT_CONFIGURED,
    MEMORY_NOT_FOUND,
    UNSUPPORTED_OPERATION,
    VALIDATION_ERROR,
    SidecarError,
)
from yuvi_mem0.schemas import (
    AddMemoryRequest,
    HealthCapabilities,
    HealthComponents,
    HealthData,
    HealthEmbedding,
    MemoryHistoryEntry,
    MemoryRecord,
    MemoryWriteResult,
    SearchMemoryRequest,
    UpdateMemoryRequest,
)

logger = logging.getLogger("yuvi_mem0.memory")


class Mem0Service:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._memory: Any | None = None
        self._init_error: str | None = None
        # Cached health probe results (no side-effectful re-init per request).
        self._embed_cache: tuple[float, str, str | None] | None = None
        self._vector_cache: tuple[float, str, str | None] | None = None

    def shutdown(self) -> None:
        """
        Release Mem0 resources at process shutdown (lifespan end).

        Safe to call multiple times. After shutdown, a later initialize() may
        recreate Memory (startup path only — not per request).
        """
        memory = self._memory
        self._memory = None
        self._embed_cache = None
        self._vector_cache = None
        if memory is None:
            return
        # Best-effort close of known mem0ai 0.1.107 resources.
        for attr in ("db", "vector_store", "_telemetry_vector_store"):
            obj = getattr(memory, attr, None)
            if obj is None:
                continue
            for method_name in ("close", "disconnect", "shutdown"):
                method = getattr(obj, method_name, None)
                if not callable(method):
                    continue
                try:
                    method()
                except Exception:  # noqa: BLE001
                    logger.debug(
                        "Mem0Service.shutdown: %s.%s failed",
                        attr,
                        method_name,
                        exc_info=True,
                    )
                break
        logger.info("Mem0Service shut down")

    def initialize(self) -> None:
        if self._memory is not None:
            return
        try:
            from mem0 import Memory  # type: ignore

            from yuvi_mem0.ollama_embedder_patch import (
                EMBEDDER_MODEL_NOT_LOCAL,
                Mem0EmbedderPatchError,
                is_private_ollama_tag,
                patch_ollama_embedder,
            )

            # Private yuvi-* tags require the 0.1.107 patch (strict fail-fast).
            # Public models: warn + skip patch on unsupported mem0ai; keep pull.
            private_embedder = is_private_ollama_tag(self.settings.mem0_embedder_model)
            try:
                patch_result = patch_ollama_embedder(strict_version=private_embedder)
            except Mem0EmbedderPatchError as exc:
                self._memory = None
                self._init_error = exc.message
                if exc.code == MEM0_EMBEDDER_PATCH_UNSUPPORTED:
                    logger.error(
                        "Mem0 refuse start: private embedder requires mem0ai==0.1.107 "
                        "patch (model=%s)",
                        self.settings.mem0_embedder_model,
                    )
                    raise SidecarError(
                        MEM0_EMBEDDER_PATCH_UNSUPPORTED,
                        exc.message,
                        retryable=False,
                        status_code=400,
                    ) from exc
                raise SidecarError(
                    EMBEDDER_UNAVAILABLE,
                    exc.message,
                    retryable=False,
                    status_code=503,
                ) from exc

            if not patch_result.applied:
                logger.warning(
                    "Ollama embedder patch skipped code=%s reason=%s mem0=%s private_embedder=%s",
                    patch_result.code or MEM0_EMBEDDER_PATCH_UNSUPPORTED,
                    patch_result.reason,
                    patch_result.mem0_version,
                    private_embedder,
                )

            config = self.settings.build_mem0_config()
            # Ensure noop provider is registered before Memory constructs LLM.
            if not self.settings.has_memory_llm:
                from yuvi_mem0.noop_llm import register_yuvi_noop_llm

                register_yuvi_noop_llm()
            self._memory = Memory.from_config(config)
            self._init_error = None
            logger.info(
                "Mem0 initialized collection=%s dims=%s model=%s llm_configured=%s",
                self.settings.mem0_pg_collection,
                self.settings.mem0_embedder_dimensions,
                self.settings.mem0_embedder_model,
                self.settings.has_memory_llm,
            )
        except SidecarError as exc:
            self._memory = None
            if self._init_error is None:
                self._init_error = exc.message
            raise
        except Exception as exc:  # noqa: BLE001
            from yuvi_mem0.ollama_embedder_patch import (
                EMBEDDER_MODEL_NOT_LOCAL,
                Mem0EmbedderPatchError,
            )

            self._memory = None
            if isinstance(exc, Mem0EmbedderPatchError):
                self._init_error = exc.message
                if exc.code == EMBEDDER_MODEL_NOT_LOCAL:
                    raise SidecarError(
                        EMBEDDER_UNAVAILABLE,
                        exc.message,
                        retryable=False,
                        status_code=503,
                    ) from exc
                if exc.code == MEM0_EMBEDDER_PATCH_UNSUPPORTED:
                    raise SidecarError(
                        MEM0_EMBEDDER_PATCH_UNSUPPORTED,
                        exc.message,
                        retryable=False,
                        status_code=400,
                    ) from exc
            self._init_error = _safe_error_message(exc)
            logger.exception("Mem0 initialization failed")
            raise SidecarError(
                MEM0_INITIALIZATION_FAILED,
                f"Mem0 initialization failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=503,
            ) from exc

    @property
    def ready(self) -> bool:
        return self._memory is not None

    def ensure_ready(self) -> Any:
        if self._memory is None:
            self.initialize()
        assert self._memory is not None
        return self._memory

    def probe_embedder(self, *, force: bool = False) -> tuple[str, str | None]:
        ttl = max(0, int(self.settings.mem0_health_embed_cache_ttl_s))
        now = time.monotonic()
        if not force and self._embed_cache is not None and ttl > 0:
            cached_at, status, msg = self._embed_cache
            if now - cached_at < ttl:
                return status, msg
        try:
            url = f"{self.settings.mem0_ollama_base_url.rstrip('/')}/api/embed"
            with httpx.Client(timeout=5.0) as client:
                response = client.post(
                    url,
                    json={
                        "model": self.settings.mem0_embedder_model,
                        "input": "yuvi-health-check",
                    },
                )
            if response.status_code >= 400:
                result: tuple[str, str | None] = (
                    "unhealthy",
                    f"Ollama embed HTTP {response.status_code}",
                )
            else:
                data = response.json()
                vectors = data.get("embeddings") or []
                if not vectors:
                    result = ("unhealthy", "Ollama returned no embeddings")
                else:
                    dims = len(vectors[0])
                    if dims != self.settings.mem0_embedder_dimensions:
                        result = (
                            "unhealthy",
                            f"embedding dimensions mismatch: expected "
                            f"{self.settings.mem0_embedder_dimensions}, got {dims}",
                        )
                    else:
                        result = ("healthy", None)
        except Exception as exc:  # noqa: BLE001
            result = ("unhealthy", _safe_error_message(exc))
        self._embed_cache = (now, result[0], result[1])
        return result

    def probe_vector_store(self, *, force: bool = False) -> tuple[str, str | None]:
        ttl = max(0, int(self.settings.mem0_health_embed_cache_ttl_s))
        now = time.monotonic()
        if not force and self._vector_cache is not None and ttl > 0:
            cached_at, status, msg = self._vector_cache
            if now - cached_at < ttl:
                return status, msg
        if not self.settings.has_pg:
            result: tuple[str, str | None] = (
                "unhealthy",
                "MEM0_PG_CONNECTION_STRING is not configured",
            )
            self._vector_cache = (now, result[0], result[1])
            return result
        try:
            import psycopg

            # Hard timeouts so /health never blocks for minutes on bad DNS/network.
            with psycopg.connect(
                self.settings.mem0_pg_connection_string,
                connect_timeout=3,
                options="-c statement_timeout=3000",
            ) as conn:
                with conn.cursor() as cur:
                    cur.execute("select 1")
                    # Read-only probe: do not CREATE EXTENSION on every health hit.
                    cur.execute(
                        "select exists(select 1 from pg_extension where extname = 'vector')"
                    )
                    row = cur.fetchone()
                    has_vector = bool(row and row[0])
                    if not has_vector:
                        result = ("unhealthy", "pgvector extension is not installed")
                    else:
                        collection = self.settings.mem0_pg_collection
                        cur.execute("select to_regclass(%s) is not null", (collection,))
                        table_row = cur.fetchone()
                        if table_row and table_row[0]:
                            result = ("healthy", None)
                        else:
                            # Table may be created lazily on first write; connectivity ok.
                            result = (
                                "healthy",
                                f"collection table '{collection}' not yet created",
                            )
        except Exception as exc:  # noqa: BLE001
            result = ("unhealthy", _safe_error_message(exc))
        self._vector_cache = (now, result[0], result[1])
        return result

    def probe_memory_llm(self) -> tuple[str, str | None]:
        if not self.settings.has_memory_llm:
            return "not_configured", "Memory LLM is not configured (infer=true unavailable)"
        return "healthy", None

    def health(self) -> HealthData:
        # Health must not re-initialize Mem0 or run add/search.
        embedder_status, embedder_msg = self.probe_embedder()
        vector_status, vector_msg = self.probe_vector_store()
        llm_status, llm_msg = self.probe_memory_llm()

        mem0_status = "healthy" if self.ready else "unhealthy"
        if self._init_error and not self.ready:
            mem0_status = "unhealthy"

        crud_ok = self.ready and embedder_status == "healthy" and vector_status == "healthy"
        infer_ok = bool(self.settings.has_memory_llm and crud_ok)

        hard_fail = (
            embedder_status == "unhealthy"
            or vector_status == "unhealthy"
            or mem0_status == "unhealthy"
        )
        if hard_fail:
            overall = "unhealthy"
        elif llm_status == "not_configured" or not infer_ok:
            overall = "degraded"
        else:
            overall = "healthy"

        messages = [m for m in (embedder_msg, vector_msg, llm_msg, self._init_error) if m]
        return HealthData(
            status=overall,  # type: ignore[arg-type]
            components=HealthComponents(
                mem0=mem0_status,
                embedder=embedder_status,
                vectorStore=vector_status,
                memoryLlm=llm_status,
            ),
            capabilities=HealthCapabilities(
                infer=infer_ok,
                crud=crud_ok,
                search=crud_ok,
            ),
            embedding=HealthEmbedding(
                provider=self.settings.mem0_embedder_provider,
                model=self.settings.mem0_embedder_model,
                dimensions=self.settings.mem0_embedder_dimensions,
            ),
            collection=self.settings.mem0_pg_collection,
            message="; ".join(messages) if messages else None,
        )

    def add(self, request: AddMemoryRequest) -> MemoryWriteResult:
        if request.infer and not self.settings.has_memory_llm:
            raise SidecarError(
                MEMORY_LLM_NOT_CONFIGURED,
                "infer=true requires Memory LLM configuration.",
                retryable=False,
                status_code=400,
            )
        memory = self.ensure_ready()
        metadata = request.metadata.model_dump(exclude_none=True)
        metadata.setdefault("schemaVersion", 1)

        payload: Any
        if request.messages:
            payload = [message.model_dump() for message in request.messages]
        elif request.content and request.content.strip():
            payload = request.content.strip()
        else:
            raise SidecarError(
                VALIDATION_ERROR,
                "Either content or messages is required.",
                status_code=400,
            )

        try:
            result = memory.add(
                payload,
                user_id=request.scope,
                metadata=metadata,
                infer=request.infer,
            )
        except SidecarError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 add failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=500,
            ) from exc

        return self._normalize_write_result(result, scope=request.scope, metadata=metadata)

    def search(self, request: SearchMemoryRequest) -> list[MemoryRecord]:
        memory = self.ensure_ready()
        try:
            raw = memory.search(
                request.query,
                user_id=request.scope,
                limit=request.limit,
            )
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 search failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=500,
            ) from exc
        items = self._extract_list(raw)
        return [self._to_record(item, default_scope=request.scope) for item in items]

    def get(self, memory_id: str, scope: str | None = None) -> MemoryRecord:
        memory = self.ensure_ready()
        try:
            raw = memory.get(memory_id)
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 get failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=500,
            ) from exc
        if not raw:
            raise SidecarError(MEMORY_NOT_FOUND, f"Memory {memory_id} not found.", status_code=404)
        record = self._to_record(raw, default_scope=scope or "")
        if scope and not self._scope_matches(raw, scope, record):
            raise SidecarError(MEMORY_NOT_FOUND, f"Memory {memory_id} not found.", status_code=404)
        return record

    def list_memories(self, scope: str, limit: int = 20, offset: int = 0) -> list[MemoryRecord]:
        memory = self.ensure_ready()
        try:
            if hasattr(memory, "get_all"):
                raw = memory.get_all(user_id=scope)
            else:
                raw = []
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 list failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=500,
            ) from exc
        items = self._extract_list(raw)
        sliced = items[offset : offset + limit]
        return [self._to_record(item, default_scope=scope) for item in sliced]

    def update(self, memory_id: str, request: UpdateMemoryRequest) -> MemoryRecord:
        memory = self.ensure_ready()
        if request.scope:
            # Enforce scope isolation before update.
            self.get(memory_id, scope=request.scope)
        try:
            if hasattr(memory, "update"):
                memory.update(memory_id, data=request.content)
            else:
                raise SidecarError(
                    INTERNAL_ERROR,
                    "Mem0 update is not available in this package version.",
                    status_code=501,
                )
        except SidecarError:
            raise
        except Exception as exc:  # noqa: BLE001
            message = str(exc).lower()
            if "not found" in message:
                raise SidecarError(
                    MEMORY_NOT_FOUND, f"Memory {memory_id} not found.", status_code=404
                ) from exc
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 update failed: {_safe_error_message(exc)}",
                retryable=True,
            ) from exc
        return self.get(memory_id, scope=request.scope)

    def delete(self, memory_id: str, scope: str | None = None) -> None:
        memory = self.ensure_ready()
        if scope:
            self.get(memory_id, scope=scope)
        try:
            memory.delete(memory_id)
        except Exception as exc:  # noqa: BLE001
            message = str(exc).lower()
            if "not found" in message:
                raise SidecarError(
                    MEMORY_NOT_FOUND, f"Memory {memory_id} not found.", status_code=404
                ) from exc
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 delete failed: {_safe_error_message(exc)}",
                retryable=True,
            ) from exc

    def history(self, memory_id: str, scope: str | None = None) -> list[MemoryHistoryEntry]:
        """
        Normalize mem0ai 0.1.107 history rows into MemoryHistoryEntry.

        mem0 stores history in a local SQLite history.db keyed by memory_id.
        When scope is provided we verify the memory belongs to that scope first.
        Missing IDs return an empty list (stable), not a vague structure.
        """
        memory = self.ensure_ready()
        if scope:
            # Scope isolation: wrong-scope IDs must not leak history.
            try:
                self.get(memory_id, scope=scope)
            except SidecarError as exc:
                if exc.code == MEMORY_NOT_FOUND:
                    return []
                raise
        try:
            if not hasattr(memory, "history"):
                # Explicit: do not invent history from unrelated SDK fields.
                raise SidecarError(
                    UNSUPPORTED_OPERATION,
                    "Memory history is not available in this Mem0 build.",
                    retryable=False,
                    status_code=501,
                )
            raw = memory.history(memory_id)
        except SidecarError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 history failed: {_safe_error_message(exc)}",
                retryable=True,
            ) from exc
        # Stable empty list when SDK returns nothing (missing id or no events).
        items = self._extract_list(raw)
        results: list[MemoryHistoryEntry] = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                # Skip non-dict rows rather than returning unstable shapes.
                continue
            event = str(item.get("event") or item.get("action") or "unknown").strip() or "unknown"
            # Only accept known-ish event tokens; unknown remains "unknown" (stable).
            results.append(
                MemoryHistoryEntry(
                    id=str(item.get("id") or f"{memory_id}:{index}"),
                    memoryId=str(item.get("memory_id") or memory_id),
                    event=event,
                    previousValue=_as_optional_str(
                        item.get("previous_value") or item.get("old_memory")
                    ),
                    newValue=_as_optional_str(item.get("new_value") or item.get("new_memory")),
                    createdAt=_as_optional_str(item.get("created_at") or item.get("updated_at")),
                )
            )
        return results

    def _normalize_write_result(
        self,
        raw: Any,
        *,
        scope: str,
        metadata: dict[str, Any],
    ) -> MemoryWriteResult:
        items = self._extract_list(raw)
        if not items and isinstance(raw, dict):
            items = self._extract_list(raw.get("results"))
        if not items:
            return MemoryWriteResult(memoryId="unchanged", operation="unchanged", record=None)

        first = items[0] if isinstance(items[0], dict) else {"id": str(items[0]), "memory": ""}
        memory_id = str(
            first.get("id") or first.get("memory_id") or first.get("event_id") or "unknown"
        )
        event = str(first.get("event") or first.get("action") or "ADD").upper()
        if "DELETE" in event:
            operation = "deleted"
        elif "UPDATE" in event:
            operation = "updated"
        elif "NOOP" in event or "NONE" in event:
            operation = "unchanged"
        else:
            operation = "created"
        content = str(first.get("memory") or first.get("data") or first.get("text") or "")
        record = MemoryRecord(
            id=memory_id,
            content=content,
            scope=scope,
            metadata={**metadata, **(first.get("metadata") or {})},
            createdAt=_as_optional_str(first.get("created_at")),
            updatedAt=_as_optional_str(first.get("updated_at")),
        )
        return MemoryWriteResult(memoryId=memory_id, operation=operation, record=record)  # type: ignore[arg-type]

    def _to_record(self, item: Any, *, default_scope: str) -> MemoryRecord:
        if not isinstance(item, dict):
            return MemoryRecord(id=str(item), content=str(item), scope=default_scope, metadata={})
        memory_id = str(item.get("id") or item.get("memory_id") or "unknown")
        content = str(
            item.get("memory") or item.get("data") or item.get("text") or item.get("content") or ""
        )
        scope = str(item.get("user_id") or item.get("scope") or default_scope)
        raw_meta = item.get("metadata")
        metadata: dict[str, Any] = raw_meta if isinstance(raw_meta, dict) else {}
        score = item.get("score")
        return MemoryRecord(
            id=memory_id,
            content=content,
            scope=scope,
            metadata=metadata,
            score=float(score) if isinstance(score, (int, float)) else None,
            createdAt=_as_optional_str(item.get("created_at")),
            updatedAt=_as_optional_str(item.get("updated_at")),
        )

    @staticmethod
    def _scope_matches(raw: Any, scope: str, record: MemoryRecord) -> bool:
        if record.scope and record.scope == scope:
            return True
        if isinstance(raw, dict):
            user_id = raw.get("user_id") or ""
            if user_id and user_id == scope:
                return True
            if user_id and user_id != scope:
                return False
            # Some get() payloads omit user_id; fall back to record.scope.
        return not record.scope or record.scope == scope

    @staticmethod
    def _extract_list(raw: Any) -> list[Any]:
        if raw is None:
            return []
        if isinstance(raw, list):
            return raw
        if isinstance(raw, dict):
            for key in ("results", "memories", "data", "items"):
                value = raw.get(key)
                if isinstance(value, list):
                    return value
            return [raw]
        return []


_service: Mem0Service | None = None


def get_service() -> Mem0Service:
    global _service
    if _service is None:
        _service = Mem0Service()
    return _service


def reset_service_for_tests() -> None:
    """Test helper: shutdown + clear the process-global service singleton."""
    global _service
    if _service is not None:
        try:
            _service.shutdown()
        except Exception:  # noqa: BLE001
            logger.debug("reset_service_for_tests shutdown failed", exc_info=True)
    _service = None


def _as_optional_str(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _safe_error_message(exc: BaseException) -> str:
    """Strip likely secrets from exception strings before surfacing them."""
    text = str(exc)
    blocked = ("sk-", "api_key", "password=", "Bearer ", "Authorization")
    lowered = text.lower()
    for token in blocked:
        if token.lower() in lowered:
            return type(exc).__name__
    if len(text) > 300:
        return text[:300] + "…"
    return text
