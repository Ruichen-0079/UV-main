from __future__ import annotations

import builtins
import multiprocessing
import os
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from yuvi_mem0 import runtime_paths


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, False),
        ("", False),
        ("0", False),
        ("false", False),
        ("random", False),
        ("1", True),
        ("true", True),
        ("yes", True),
        ("on", True),
        ("TrUe", True),
        (" YES ", True),
    ],
)
def test_is_packaged_mode(
    monkeypatch: pytest.MonkeyPatch, value: str | None, expected: bool
) -> None:
    if value is None:
        monkeypatch.delenv("YUVI_MEM0_PACKAGED", raising=False)
    else:
        monkeypatch.setenv("YUVI_MEM0_PACKAGED", value)
    assert runtime_paths.is_packaged_mode() is expected


def test_development_mode_is_a_noop(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("YUVI_MEM0_PACKAGED", raising=False)
    monkeypatch.setenv("MEM0_DIR", "C:/existing/mem0")
    monkeypatch.setenv("MEM0_TELEMETRY", "true")
    missing = tmp_path / "not-created"
    monkeypatch.setenv("YUVI_MEM0_DATA_DIR", str(missing))
    monkeypatch.setenv("YUVI_MEM0_LOG_DIR", str(missing / "logs"))

    paths = runtime_paths.prepare_runtime_environment()

    assert paths == runtime_paths.RuntimePaths(False, None, None, None)
    assert not missing.exists()
    assert sys.modules.get("yuvi_mem0.runtime_paths") is not None
    assert "MEM0_DIR" in os.environ
    assert os.environ["MEM0_DIR"] == "C:/existing/mem0"
    assert os.environ["MEM0_TELEMETRY"] == "true"


def test_packaged_default_paths_and_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    local_app_data = tmp_path / "Local App 非ASCII"
    resource_dir = tmp_path / "readonly resources"
    monkeypatch.setenv("YUVI_MEM0_PACKAGED", "1")
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))
    monkeypatch.setenv("YUVI_MEM0_RESOURCE_DIR", str(resource_dir))
    monkeypatch.delenv("YUVI_MEM0_DATA_DIR", raising=False)
    monkeypatch.delenv("YUVI_MEM0_LOG_DIR", raising=False)
    monkeypatch.setenv("MEM0_DIR", "C:/stale/mem0")
    monkeypatch.setenv("MEM0_TELEMETRY", "true")

    paths = runtime_paths.prepare_runtime_environment()

    assert paths.packaged is True
    assert paths.resource_dir == resource_dir.resolve()
    assert paths.data_dir == (local_app_data / "YUVI" / "Mem0" / "data").resolve()
    assert paths.log_dir == (local_app_data / "YUVI" / "Mem0" / "logs").resolve()
    assert paths.data_dir.is_dir()
    assert paths.log_dir.is_dir()
    assert not resource_dir.exists()
    assert os.environ["MEM0_DIR"] == str(paths.data_dir)
    assert os.environ["MEM0_TELEMETRY"] == "false"


def test_packaged_explicit_paths_override_defaults(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    resource_dir = tmp_path / "resource"
    data_dir = tmp_path / "data"
    log_dir = tmp_path / "logs"
    monkeypatch.setenv("YUVI_MEM0_PACKAGED", "true")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local app"))
    monkeypatch.setenv("YUVI_MEM0_RESOURCE_DIR", str(resource_dir))
    monkeypatch.setenv("YUVI_MEM0_DATA_DIR", str(data_dir))
    monkeypatch.setenv("YUVI_MEM0_LOG_DIR", str(log_dir))

    paths = runtime_paths.prepare_runtime_environment()

    assert paths.resource_dir == resource_dir.resolve()
    assert paths.data_dir == data_dir.resolve()
    assert paths.log_dir == log_dir.resolve()
    assert data_dir.is_dir()
    assert log_dir.is_dir()
    assert not resource_dir.exists()


def test_packaged_paths_do_not_depend_on_cwd_or_dotenv(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cwd = tmp_path / "empty cwd"
    cwd.mkdir()
    (cwd / ".env").write_text("MEM0_SIDECAR_PORT=6199\n", encoding="utf-8")
    resource_dir = tmp_path / "resources"
    data_dir = tmp_path / "data"
    log_dir = tmp_path / "logs"
    monkeypatch.chdir(cwd)
    monkeypatch.setenv("YUVI_MEM0_PACKAGED", "on")
    monkeypatch.setenv("YUVI_MEM0_RESOURCE_DIR", str(resource_dir))
    monkeypatch.setenv("YUVI_MEM0_DATA_DIR", str(data_dir))
    monkeypatch.setenv("YUVI_MEM0_LOG_DIR", str(log_dir))
    monkeypatch.delenv("MEM0_SIDECAR_PORT", raising=False)

    from yuvi_mem0.config import get_settings

    get_settings.cache_clear()
    try:
        settings = get_settings()
    finally:
        get_settings.cache_clear()

    assert settings.mem0_sidecar_port == 6131
    assert cwd not in settings.model_dump().values()


def test_packaged_requires_localappdata_without_explicit_writable_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("YUVI_MEM0_PACKAGED", "1")
    monkeypatch.setenv("YUVI_MEM0_RESOURCE_DIR", str(tmp_path / "resources"))
    monkeypatch.delenv("YUVI_MEM0_DATA_DIR", raising=False)
    monkeypatch.delenv("YUVI_MEM0_LOG_DIR", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)

    with pytest.raises(runtime_paths.RuntimePathError, match="LOCALAPPDATA") as exc_info:
        runtime_paths.resolve_runtime_paths()

    assert "MEM0_" not in str(exc_info.value)
    assert "password" not in str(exc_info.value).lower()


def test_frozen_resource_fallback_uses_executable_parent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    executable = tmp_path / "安装目录" / "yuvi-mem0.exe"
    monkeypatch.setenv("YUVI_MEM0_PACKAGED", "1")
    monkeypatch.delenv("YUVI_MEM0_RESOURCE_DIR", raising=False)
    monkeypatch.setenv("YUVI_MEM0_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("YUVI_MEM0_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setattr(runtime_paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(runtime_paths.sys, "executable", str(executable), raising=False)

    paths = runtime_paths.resolve_runtime_paths()

    assert paths.resource_dir == executable.parent.resolve()


def test_entry_prepares_environment_before_app_import_and_passes_app_object(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    fake_app_object = object()
    fake_app_module = types.ModuleType("yuvi_mem0.app")
    fake_app_module.app = fake_app_object
    fake_config_module = types.ModuleType("yuvi_mem0.config")
    fake_config_module.get_settings = lambda: SimpleNamespace(
        mem0_sidecar_host="127.0.0.1", mem0_sidecar_port=6198
    )
    monkeypatch.setitem(sys.modules, "yuvi_mem0.app", fake_app_module)
    monkeypatch.setitem(sys.modules, "yuvi_mem0.config", fake_config_module)

    import yuvi_mem0.__main__ as entry

    monkeypatch.setattr(multiprocessing, "freeze_support", lambda: events.append("freeze"))
    monkeypatch.setattr(entry, "prepare_runtime_environment", lambda: events.append("prepare"))

    original_import = builtins.__import__

    def tracked_import(name: str, *args: object, **kwargs: object):
        if name in {"yuvi_mem0.app", "yuvi_mem0.config"}:
            events.append(f"import:{name}")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", tracked_import)
    captured: dict[str, object] = {}

    import uvicorn

    monkeypatch.setattr(
        uvicorn,
        "run",
        lambda app, **kwargs: captured.update(app=app, **kwargs),
    )

    entry.main()

    assert events[:4] == [
        "freeze",
        "prepare",
        "import:yuvi_mem0.app",
        "import:yuvi_mem0.config",
    ]
    assert captured == {
        "app": fake_app_object,
        "host": "127.0.0.1",
        "port": 6198,
        "reload": False,
    }
