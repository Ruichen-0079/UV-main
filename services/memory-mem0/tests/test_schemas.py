from yuvi_mem0.schemas import AddMemoryRequest, SearchMemoryRequest


def test_add_request_defaults() -> None:
    req = AddMemoryRequest(scope="yuvi:v1:user:a:character:b", content="hello")
    assert req.infer is True
    assert req.metadata.schemaVersion == 1


def test_search_limit_bounds() -> None:
    req = SearchMemoryRequest(scope="s", query="q", limit=10)
    assert req.limit == 10
