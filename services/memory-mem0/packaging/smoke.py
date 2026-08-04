"""Run a Windows Mem0 onedir artifact from a copied clean-room directory."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import http.server
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MANIFEST = {
    "schemaVersion": 1,
    "protocolVersion": 1,
    "platform": "win32",
    "arch": "x64",
    "executable": "yuvi-mem0.exe",
    "healthPath": "/health",
    "defaultHost": "127.0.0.1",
    "defaultPort": 6131,
}
MIN_FILES = 1000
MIN_BYTES = 50 * 1024 * 1024
SMOKE_SECRET = "P3_SMOKE_SECRET_DO_NOT_LOG"
POISON_ENV = "MEM0_EMBEDDER_MODEL=poison-model-must-not-load\nMEM0_EMBEDDER_DIMENSIONS=999\n"
HARD_LOG_MARKERS = (
    "module not founderror",
    "no module named",
    "importerror",
    "dll load failed",
    "the specified module could not be found",
    "fatal python error",
    "failed to execute script",
    "poison-model-must-not-load",
    SMOKE_SECRET.lower(),
)


class SmokeError(RuntimeError):
    """A clean-room smoke precondition or runtime validation failed."""


@dataclass(frozen=True)
class SmokeLayout:
    repo_root: Path
    artifact_source: Path


@dataclass(frozen=True)
class ProcessInfo:
    pid: int
    parent_pid: int
    exe_name: str


@dataclass(frozen=True)
class OllamaStub:
    server: http.server.ThreadingHTTPServer
    requests: list[str]


def resolve_layout(script_path: Path | None = None) -> SmokeLayout:
    """Resolve the repository and default artifact from this file's location."""

    packaging_dir = (script_path or Path(__file__)).resolve().parent
    memory_root = packaging_dir.parent
    repo_root = memory_root.parent.parent
    return SmokeLayout(
        repo_root=repo_root,
        artifact_source=repo_root / "build" / "desktop" / "win32-x64" / "mem0",
    )


def _resolve(path: Path) -> Path:
    return path.expanduser().resolve()


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def validate_manifest(artifact_dir: Path) -> Path:
    """Validate the fixed manifest and return the resolved executable path."""

    artifact = _resolve(artifact_dir)
    manifest_path = artifact / "mem0-manifest.json"
    try:
        actual = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SmokeError("Copied artifact manifest is unreadable.") from exc
    if actual != MANIFEST:
        raise SmokeError("Copied artifact manifest does not match the fixed schema.")

    executable_name = actual["executable"]
    executable_path = Path(executable_name)
    if executable_path.name != executable_name or executable_path.is_absolute():
        raise SmokeError("Manifest executable must be a relative basename.")
    if ".." in executable_path.parts:
        raise SmokeError("Manifest executable must not contain '..'.")
    executable = (artifact / executable_path).resolve()
    if not _is_relative_to(executable, artifact) or not executable.is_file():
        raise SmokeError("Manifest executable is outside or missing from the artifact.")
    internal = artifact / "_internal"
    if not internal.is_dir() or not any(internal.iterdir()):
        raise SmokeError("Copied artifact _internal directory is missing or empty.")
    return executable


def artifact_metrics(artifact_dir: Path) -> dict[str, int]:
    """Return conservative size metrics for a complete copied onedir."""

    artifact = _resolve(artifact_dir)
    files = [path for path in artifact.rglob("*") if path.is_file()]
    if any(path.is_symlink() for path in artifact.rglob("*")):
        raise SmokeError("Clean-room artifact must not contain symlinks.")
    total_bytes = sum(path.stat().st_size for path in files)
    metrics = {"files": len(files), "bytes": total_bytes}
    if len(files) <= MIN_FILES or total_bytes <= MIN_BYTES:
        raise SmokeError(
            f"Copied artifact is unexpectedly small ({len(files)} files, {total_bytes} bytes)."
        )
    return metrics


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_snapshot(root: Path) -> dict[str, tuple[int, str]]:
    """Capture relative file path, size, and SHA-256 for a directory tree."""

    base = _resolve(root)
    if not base.is_dir():
        raise SmokeError(f"Snapshot root is not a directory: {base}")
    snapshot: dict[str, tuple[int, str]] = {}
    for path in sorted(base.rglob("*")):
        if path.is_symlink():
            raise SmokeError(f"Symlink is not allowed in snapshot: {path}")
        if path.is_file():
            relative = path.relative_to(base).as_posix()
            snapshot[relative] = (path.stat().st_size, _sha256(path))
    return snapshot


def tree_stat_snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Capture a lightweight path/size/mtime snapshot for the source artifact."""

    base = _resolve(root)
    result: dict[str, tuple[int, int]] = {}
    for path in sorted(base.rglob("*")):
        if path.is_file():
            result[path.relative_to(base).as_posix()] = (
                path.stat().st_size,
                path.stat().st_mtime_ns,
            )
    return result


def copy_destination_guard(destination: Path, *, temp_root: Path, repo_root: Path) -> Path:
    """Validate that a copy destination is a new child of system TEMP."""

    target = _resolve(destination)
    temp = _resolve(temp_root)
    repo = _resolve(repo_root)
    if target == temp or not _is_relative_to(target, temp):
        raise SmokeError("Clean-room destination must be below the system TEMP directory.")
    if _is_relative_to(target, repo):
        raise SmokeError("Clean-room destination must not be inside the repository.")
    if target.exists():
        raise SmokeError("Clean-room copy destination must not already exist.")
    return target


def create_cleanroom(repo_root: Path) -> Path:
    """Create a uniquely named clean-room directly below the system TEMP."""

    temp_root = _resolve(Path(tempfile.gettempdir()))
    cleanroom = _resolve(Path(tempfile.mkdtemp(prefix="yuvi-mem0-clean-room-")))
    if not _is_relative_to(cleanroom, temp_root) or _is_relative_to(cleanroom, _resolve(repo_root)):
        raise SmokeError("Temporary clean-room escaped the system TEMP directory.")
    return cleanroom


def safe_cleanup_cleanroom(cleanroom: Path) -> None:
    """Remove only a validated clean-room below the system TEMP directory."""

    target = _resolve(cleanroom)
    temp_root = _resolve(Path(tempfile.gettempdir()))
    if target == temp_root or not _is_relative_to(target, temp_root):
        raise SmokeError("Refusing to clean a path outside system TEMP.")
    if not target.name.startswith("yuvi-mem0-clean-room-"):
        raise SmokeError("Refusing to clean a non-clean-room directory.")
    if target.exists():
        shutil.rmtree(target)


def restricted_path() -> str:
    """Return the deliberately minimal child PATH."""

    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows"
    return os.pathsep.join((str(Path(system_root) / "System32"), system_root))


def validate_restricted_path(path: str) -> dict[str, bool]:
    """Assert that executable lookup cannot find development runtimes."""

    names = ("python", "python3", "py", "pip", "uv")
    result = {name: shutil.which(name, path=path) is None for name in names}
    if not all(result.values()):
        failed = ", ".join(name for name, missing in result.items() if not missing)
        raise SmokeError(f"Restricted PATH resolves forbidden executable(s): {failed}")
    return result


def build_child_env(
    *,
    cleanroom: Path,
    artifact_dir: Path,
    port: int,
    ollama_url: str | None = None,
    pg_url: str | None = None,
) -> dict[str, str]:
    """Build an explicit child environment without inheriting the parent env."""

    runtime = cleanroom / "runtime"
    home = runtime / "home"
    env: dict[str, str] = {}
    for key in (
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "OS",
    ):
        value = os.environ.get(key)
        if value:
            env[key] = value
    env["SystemRoot"] = env.get("SystemRoot", os.environ.get("WINDIR", r"C:\Windows"))
    env["WINDIR"] = env.get("WINDIR", env["SystemRoot"])
    env["PATH"] = restricted_path()
    env.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "APPDATA": str(runtime / "appdata"),
            "LOCALAPPDATA": str(runtime / "localappdata"),
            "TEMP": str(runtime / "temp"),
            "TMP": str(runtime / "temp"),
            "YUVI_MEM0_PACKAGED": "1",
            "YUVI_MEM0_RESOURCE_DIR": str(_resolve(artifact_dir)),
            "YUVI_MEM0_DATA_DIR": str(runtime / "data"),
            "YUVI_MEM0_LOG_DIR": str(runtime / "logs"),
            "MEM0_TELEMETRY": "false",
            "MEM0_SIDECAR_HOST": "127.0.0.1",
            "MEM0_SIDECAR_PORT": str(port),
            "MEM0_REQUEST_TIMEOUT_MS": "1000",
        }
    )
    if ollama_url is not None:
        env["MEM0_OLLAMA_BASE_URL"] = ollama_url
        env["OLLAMA_HOST"] = ollama_url
    if pg_url is not None:
        env["MEM0_PG_CONNECTION_STRING"] = pg_url
    return env


def poison_env_text() -> str:
    """Return the fixed .env trap without any secret material."""

    return POISON_ENV


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _closed_port() -> int:
    port = _free_port()
    return port


def _json_response(
    handler: http.server.BaseHTTPRequestHandler, status: int, payload: dict[str, Any]
) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def start_ollama_stub() -> OllamaStub:
    """Start a local, non-networking Ollama HTTP stub for the fake-PG case."""

    requests: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args: Any) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802
            requests.append(f"GET {self.path}")
            if self.path == "/api/tags":
                _json_response(
                    self,
                    200,
                    {
                        "models": [
                            {
                                "name": "yuvi-embedding:0.6b",
                                "model": "yuvi-embedding:0.6b",
                            }
                        ]
                    },
                )
            else:
                _json_response(self, 404, {"error": "unknown Ollama stub endpoint"})

        def do_POST(self) -> None:  # noqa: N802
            requests.append(f"POST {self.path}")
            length = int(self.headers.get("Content-Length", "0"))
            if length:
                self.rfile.read(length)
            if self.path in {"/api/embed", "/api/embeddings"}:
                _json_response(self, 200, {"embeddings": [[0.0] * 1024]})
            elif self.path == "/api/show":
                _json_response(
                    self, 200, {"name": "yuvi-embedding:0.6b", "model": "yuvi-embedding:0.6b"}
                )
            else:
                _json_response(self, 404, {"error": "unknown Ollama stub endpoint"})

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, name="yuvi-ollama-stub", daemon=True)
    thread.start()
    return OllamaStub(server=server, requests=requests)


def stop_ollama_stub(stub: OllamaStub) -> None:
    stub.server.shutdown()
    stub.server.server_close()


def health_request(port: int, timeout: float) -> dict[str, Any]:
    """Fetch and validate the packaged health envelope."""

    url = f"http://127.0.0.1:{port}/health"
    with urllib.request.urlopen(url, timeout=timeout) as response:
        if response.status != 200:
            raise SmokeError(f"Health returned HTTP {response.status}.")
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("ok") is not True:
        raise SmokeError("Health envelope ok was not true.")
    status = payload.get("data", {}).get("status")
    if status not in {"unhealthy", "degraded"}:
        raise SmokeError(f"Health status was not degraded/unhealthy: {status!r}.")
    return payload


def poll_health(port: int, deadline: float) -> tuple[dict[str, Any], str | None]:
    last_error: str | None = None
    while time.monotonic() < deadline:
        try:
            return health_request(port, timeout=1.0), last_error
        except (
            OSError,
            urllib.error.URLError,
            TimeoutError,
            json.JSONDecodeError,
            SmokeError,
        ) as exc:
            last_error = str(exc)
            time.sleep(0.2)
    raise SmokeError(f"Health did not become ready: {last_error or 'timeout'}")


def _windows_process_snapshot() -> dict[int, ProcessInfo]:
    if sys.platform != "win32":
        return {}
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    snapshot_handle = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    invalid_handle = ctypes.c_void_p(-1).value
    if snapshot_handle == invalid_handle:
        raise SmokeError("CreateToolhelp32Snapshot failed.")

    class ProcessEntry32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", ctypes.c_ulong),
            ("cntUsage", ctypes.c_ulong),
            ("th32ProcessID", ctypes.c_ulong),
            ("th32DefaultHeapID", ctypes.c_void_p),
            ("th32ModuleID", ctypes.c_ulong),
            ("cntThreads", ctypes.c_ulong),
            ("th32ParentProcessID", ctypes.c_ulong),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", ctypes.c_ulong),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    first = kernel32.Process32FirstW
    next_process = kernel32.Process32NextW
    close_handle = kernel32.CloseHandle
    first.argtypes = [ctypes.c_void_p, ctypes.POINTER(ProcessEntry32W)]
    next_process.argtypes = [ctypes.c_void_p, ctypes.POINTER(ProcessEntry32W)]
    close_handle.argtypes = [ctypes.c_void_p]
    entry = ProcessEntry32W()
    entry.dwSize = ctypes.sizeof(ProcessEntry32W)
    result: dict[int, ProcessInfo] = {}
    try:
        if not first(snapshot_handle, ctypes.byref(entry)):
            return result
        while True:
            pid = int(entry.th32ProcessID)
            result[pid] = ProcessInfo(pid, int(entry.th32ParentProcessID), entry.szExeFile)
            if not next_process(snapshot_handle, ctypes.byref(entry)):
                break
    finally:
        close_handle(snapshot_handle)
    return result


def descendant_pids(root_pid: int, snapshot: dict[int, ProcessInfo]) -> set[int]:
    descendants: set[int] = set()
    pending = [root_pid]
    while pending:
        parent = pending.pop()
        children = [info.pid for info in snapshot.values() if info.parent_pid == parent]
        for child in children:
            if child not in descendants:
                descendants.add(child)
                pending.append(child)
    return descendants


def process_tree_clear(
    pid: int,
    before: dict[int, ProcessInfo],
    after: dict[int, ProcessInfo],
) -> bool:
    """Confirm this run's PID, descendants, and new same-name processes are gone."""

    if sys.platform != "win32":
        return True
    if pid in after or descendant_pids(pid, after):
        return False
    new_same_name = {
        info.pid
        for info in after.values()
        if info.exe_name.casefold() == "yuvi-mem0.exe" and info.pid not in before
    }
    return not new_same_name


def acceptable_exit_code(code: int | None) -> bool:
    """Accept normal exit and Windows CTRL_BREAK/CTRL_C-style code 3."""

    return code in {0, 3}


def classify_logs(
    stdout_text: str,
    stderr_text: str,
    *,
    health_ok: bool,
    repo_root: Path,
    case_env: dict[str, str],
) -> dict[str, Any]:
    """Scan child logs without printing their sensitive contents."""

    combined = f"{stdout_text}\n{stderr_text}"
    lowered = combined.casefold()
    hard = [marker for marker in HARD_LOG_MARKERS if marker in lowered]
    connection_traceback = "traceback" in lowered and any(
        marker in lowered
        for marker in ("connection refused", "connection timeout", "operationalerror")
    )
    if "traceback" in lowered and not connection_traceback:
        hard.append("unexpected traceback")
    forbidden = {
        str(repo_root).casefold(),
        str(Path(sys.executable).resolve().parent).casefold(),
    }
    for value in case_env.values():
        if value and (
            "postgresql://" in value.casefold() or SMOKE_SECRET.casefold() in value.casefold()
        ):
            forbidden.add(value.casefold())
    leaked_paths = [value for value in forbidden if value and value in lowered]
    if leaked_paths:
        hard.append("sensitive path or URL")
    return {
        "hard_failures": sorted(set(hard)),
        "expected_connection_traceback": connection_traceback,
        "ok": not hard and health_ok,
    }


def _tail(path: Path, limit: int = 1600) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text[-limit:]


def run_case(
    *,
    name: str,
    cleanroom: Path,
    artifact_dir: Path,
    empty_cwd: Path,
    timeout: float,
    case_env: dict[str, str],
) -> dict[str, Any]:
    case_dir = cleanroom / name
    case_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = case_dir / "stdout.log"
    stderr_path = case_dir / "stderr.log"
    executable = validate_manifest(artifact_dir)
    restricted = validate_restricted_path(case_env["PATH"])
    before_processes = _windows_process_snapshot()
    with (
        stdout_path.open("w", encoding="utf-8", newline="") as stdout,
        stderr_path.open("w", encoding="utf-8", newline="") as stderr,
    ):
        process = subprocess.Popen(
            [str(executable)],
            cwd=str(empty_cwd),
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            env=case_env,
            shell=False,
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        health: dict[str, Any] | None = None
        last_http_error: str | None = None
        try:
            health, last_http_error = poll_health(
                int(case_env["MEM0_SIDECAR_PORT"]), time.monotonic() + timeout
            )
        except SmokeError:
            last_http_error = last_http_error or "health timeout"
        shutdown_method = "ctrl_break"
        if process.poll() is None:
            try:
                process.send_signal(signal.CTRL_BREAK_EVENT)
            except (AttributeError, OSError, ValueError):
                shutdown_method = "terminate"
                process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            shutdown_method = "kill"
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    after_processes = _windows_process_snapshot()
    stdout_text = stdout_path.read_text(encoding="utf-8", errors="replace")
    stderr_text = stderr_path.read_text(encoding="utf-8", errors="replace")
    logs = classify_logs(
        stdout_text,
        stderr_text,
        health_ok=health is not None,
        repo_root=resolve_layout().repo_root,
        case_env=case_env,
    )
    tree_clear = process_tree_clear(process.pid, before_processes, after_processes)
    if not tree_clear:
        logs["hard_failures"].append("process tree remained")
    if not logs["ok"]:
        raise SmokeError(
            f"{name} failed: health={health is not None}, logs={logs['hard_failures']}, "
            f"pid={process.pid}, last_http_error={last_http_error}"
        )
    return {
        "name": name,
        "pid": process.pid,
        "health_status": health["data"]["status"] if health else None,
        "http_status": 200 if health else None,
        "restricted_path": restricted,
        "shutdown": shutdown_method,
        "exit_code": process.returncode,
        "exit_code_accepted": acceptable_exit_code(process.returncode),
        "pid_exited": process.poll() is not None,
        "descendants_clear": tree_clear,
        "stdout": str(stdout_path),
        "stderr": str(stderr_path),
        "log_scan": logs,
        "stdout_tail": _tail(stdout_path),
        "stderr_tail": _tail(stderr_path),
    }


def _assert_empty_cwd_unchanged(before: dict[str, tuple[int, str]], empty_cwd: Path) -> None:
    after = tree_snapshot(empty_cwd)
    if after != before:
        raise SmokeError("empty-cwd was modified beyond its poison .env file.")


def run_smoke(
    artifact_dir: Path, *, timeout: float = 30.0, keep_temp: bool = False
) -> dict[str, Any]:
    """Copy an onedir artifact and run both clean-room health cases."""

    source = _resolve(artifact_dir)
    source_executable = validate_manifest(source)
    source_metrics = artifact_metrics(source)
    source_stat_before = tree_stat_snapshot(source)
    cleanroom = create_cleanroom(resolve_layout().repo_root)
    stub: OllamaStub | None = None
    try:
        copied = cleanroom / "artifact"
        copy_destination_guard(
            copied, temp_root=Path(tempfile.gettempdir()), repo_root=resolve_layout().repo_root
        )
        empty_cwd = cleanroom / "empty-cwd"
        runtime = cleanroom / "runtime"
        empty_cwd.mkdir(parents=True)
        for name in ("data", "logs", "home", "localappdata", "temp", "appdata"):
            (runtime / name).mkdir(parents=True, exist_ok=True)
        (empty_cwd / ".env").write_text(poison_env_text(), encoding="utf-8")
        empty_before = tree_snapshot(empty_cwd)
        shutil.copytree(source, copied, symlinks=False)
        copied_executable = validate_manifest(copied)
        copied_metrics = artifact_metrics(copied)
        artifact_before = tree_snapshot(copied)
        restricted = validate_restricted_path(restricted_path())
        case_results: list[dict[str, Any]] = []
        case1_port = _free_port()
        case1_env = build_child_env(
            cleanroom=cleanroom,
            artifact_dir=copied,
            port=case1_port,
            ollama_url="http://127.0.0.1:1",
        )
        case_results.append(
            run_case(
                name="case-no-pg",
                cleanroom=cleanroom,
                artifact_dir=copied,
                empty_cwd=empty_cwd,
                timeout=timeout,
                case_env=case1_env,
            )
        )
        stub = start_ollama_stub()
        fake_pg_port = _closed_port()
        fake_pg_url = f"postgresql://yuvi_test:{SMOKE_SECRET}@127.0.0.1:{fake_pg_port}/yuvi_test"
        case2_port = _free_port()
        case2_env = build_child_env(
            cleanroom=cleanroom,
            artifact_dir=copied,
            port=case2_port,
            ollama_url=f"http://127.0.0.1:{stub.server.server_port}",
            pg_url=fake_pg_url,
        )
        case_results.append(
            run_case(
                name="case-fake-pg",
                cleanroom=cleanroom,
                artifact_dir=copied,
                empty_cwd=empty_cwd,
                timeout=timeout,
                case_env=case2_env,
            )
        )
        artifact_after = tree_snapshot(copied)
        source_stat_after = tree_stat_snapshot(source)
        _assert_empty_cwd_unchanged(empty_before, empty_cwd)
        if artifact_after != artifact_before:
            raise SmokeError("Copied artifact tree changed during clean-room smoke.")
        if source_stat_after != source_stat_before:
            raise SmokeError("Original repository artifact changed during clean-room smoke.")
        home_mem0 = list((runtime / "home").rglob(".mem0"))
        if home_mem0:
            raise SmokeError("Trap HOME contains a .mem0 path.")
        result = {
            "artifact_source": str(source),
            "artifact_source_executable": str(source_executable),
            "artifact_copied_destination": str(copied),
            "copied_executable": str(copied_executable),
            "copied_metrics": copied_metrics,
            "source_metrics": source_metrics,
            "manifest_valid": True,
            "restricted_path": restricted,
            "cases": case_results,
            "ollama_stub_requests": list(stub.requests) if stub is not None else [],
            "artifact_snapshot_unchanged": True,
            "empty_cwd_unchanged": True,
            "trap_home_mem0": False,
            "source_stat_unchanged": True,
            "cleanroom": str(cleanroom),
            "cleanup": not keep_temp,
        }
        return result
    finally:
        try:
            if stub is not None:
                stop_ollama_stub(stub)
        finally:
            if not keep_temp and cleanroom.exists():
                safe_cleanup_cleanroom(cleanroom)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", type=Path, default=None)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--keep-temp", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if sys.platform != "win32":
        print("ERROR: clean-room smoke requires Windows.", file=sys.stderr)
        return 2
    if args.timeout <= 0:
        print("ERROR: --timeout must be positive.", file=sys.stderr)
        return 2
    artifact = args.artifact_dir or resolve_layout().artifact_source
    try:
        result = run_smoke(artifact, timeout=args.timeout, keep_temp=args.keep_temp)
    except (OSError, SmokeError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
