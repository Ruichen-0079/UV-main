from yuvi_mem0.schemas import (
    AddMemoryRequest,
    IdempotentMemoryReconcileRequest,
    IdempotentMemoryWriteRequest,
    SearchMemoryRequest,
)


def test_add_request_defaults() -> None:
    req = AddMemoryRequest(scope="yuvi:v1:user:a:character:b", content="hello")
    assert req.infer is True
    assert req.metadata.schemaVersion == 1


def test_search_limit_bounds() -> None:
    req = SearchMemoryRequest(scope="s", query="q", limit=10)
    assert req.limit == 10


def test_idempotent_requests_require_exact_identity_inputs() -> None:
    write = IdempotentMemoryWriteRequest(
        scope="s", content="hello", idempotencyKey="k", payloadDigest="d"
    )
    reconcile = IdempotentMemoryReconcileRequest(idempotencyKey="k", payloadDigest="d")
    assert write.idempotencyKey == "k"
    assert reconcile.payloadDigest == "d"
