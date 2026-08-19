"""Reproducible packaging and supported Firefox policy deployment.

The extension is transport-only.  This module owns the small amount of host
integration needed to turn the three extension source files into an XPI and,
after Mozilla signing, install it through Firefox's enterprise policy
mechanism.  It never edits a Firefox profile and never changes signature
enforcement.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from agentbus.paths import AgentbusError
from agentbus.util import atomic_write_json, read_json


EXTENSION_ID = "yuvi-agentbus-bridge@local"
SOURCE_FILES = ("manifest.json", "background.js", "content.js")
EXPECTED_PERMISSIONS = (
    "storage",
    "tabs",
    "https://chatgpt.com/*",
    "http://127.0.0.1/*",
)
JOBS_URL = "http://127.0.0.1:6738/api/browser/jobs"
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
SIGNATURE_SUFFIXES = (".RSA", ".SF", ".DSA", ".EC", ".P7S")


def extension_source_dir() -> Path:
    return Path(__file__).resolve().parent


def default_artifact_dir(repo_state: str | os.PathLike[str] | None = None) -> Path:
    if repo_state:
        return Path(repo_state).resolve() / "browser"
    state_root = os.environ.get("YUVI_AGENTBUS_STATE")
    if state_root:
        return Path(state_root).resolve() / "browser"
    xdg_state = os.environ.get("XDG_STATE_HOME")
    if xdg_state:
        return Path(xdg_state).resolve() / "yuvi-agent-bus" / "browser"
    return Path.home() / ".local" / "state" / "yuvi-agent-bus" / "browser"


def _read_sources(source_dir: Path) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    for name in SOURCE_FILES:
        path = source_dir / name
        if not path.is_file() or path.is_symlink():
            raise AgentbusError(f"browser extension source is missing or unsafe: {path}")
        result[name] = path.read_bytes()
    return result


def _manifest_from_bytes(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AgentbusError(f"invalid browser extension manifest: {exc}") from exc
    if not isinstance(value, dict):
        raise AgentbusError("browser extension manifest must be a JSON object")
    return value


def _validate_manifest_and_runtime(sources: dict[str, bytes]) -> dict[str, Any]:
    manifest = _manifest_from_bytes(sources["manifest.json"])
    if manifest.get("manifest_version") != 2:
        raise AgentbusError("browser bridge packaging requires manifest_version 2")
    gecko = ((manifest.get("browser_specific_settings") or {}).get("gecko") or {})
    if gecko.get("id") != EXTENSION_ID:
        raise AgentbusError(f"browser bridge extension id must remain {EXTENSION_ID}")
    permissions = manifest.get("permissions")
    if not isinstance(permissions, list) or len(permissions) != len(set(permissions)):
        raise AgentbusError("browser bridge permissions must be a unique list")
    if set(permissions) != set(EXPECTED_PERMISSIONS):
        raise AgentbusError(
            "browser bridge permissions must remain storage, tabs, chatgpt.com, and 127.0.0.1"
        )
    if "http://127.0.0.1:6738/*" in permissions:
        raise AgentbusError("Firefox match patterns must not contain an explicit localhost port")
    if any(
        token in permissions
        for token in ("http://0.0.0.0/*", "http://*/*", "https://*/*", "<all_urls>")
    ):
        raise AgentbusError("browser bridge permissions contain an unsafe host pattern")

    background = sources["background.js"].decode("utf-8")
    scripts = "\n".join(sources[name].decode("utf-8") for name in ("background.js", "content.js"))
    match = re.search(r'const\s+JOBS_URL\s*=\s*["\']([^"\']+)["\']', background)
    if not match or match.group(1) != JOBS_URL:
        raise AgentbusError(f"browser bridge runtime endpoint must remain exactly {JOBS_URL}")
    literal_urls = re.findall(r"https?://[^\s\"'`<>]+", scripts)
    if any(url not in {JOBS_URL, "https://chatgpt.com/*"} for url in literal_urls):
        raise AgentbusError("browser bridge scripts contain an unapproved network endpoint")
    all_source = "\n".join(raw.decode("utf-8") for raw in sources.values())
    for forbidden in (
        "0.0.0.0",
        "http://*/*",
        "https://*/*",
        "http://127.0.0.1:",
        "http://localhost:",
    ):
        if forbidden in all_source and forbidden != "http://127.0.0.1:":
            raise AgentbusError(f"browser bridge source contains unsafe endpoint text: {forbidden}")
    # The one fixed runtime port is allowed in background.js; the manifest and
    # content code must not introduce another local or remote endpoint.
    if all_source.count("http://127.0.0.1:") != 1:
        raise AgentbusError("browser bridge must contain exactly one fixed localhost runtime URL")
    return manifest


def validate_extension_sources(source_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Validate the narrow Firefox source boundary and return its manifest."""

    return _validate_manifest_and_runtime(_read_sources(Path(source_dir or extension_source_dir()).resolve()))


def _source_digest(sources: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name in SOURCE_FILES:
        raw = sources[name]
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()


def _version_tuple(value: str) -> tuple[int, int, int]:
    match = VERSION_RE.fullmatch(value)
    if not match:
        raise AgentbusError("browser bridge version must have the form MAJOR.MINOR.PATCH")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def _next_patch(value: str) -> str:
    major, minor, patch = _version_tuple(value)
    return f"{major}.{minor}.{patch + 1}"


def _resolve_version(
    manifest: dict[str, Any],
    source_digest: str,
    artifact_dir: Path,
    *,
    requested: str | None,
    bump: bool,
) -> str:
    base = str(manifest.get("version") or "")
    _version_tuple(base)
    metadata_path = artifact_dir / "version.json"
    metadata = read_json(str(metadata_path), default={})
    if not isinstance(metadata, dict):
        metadata = {}
    previous = str(metadata.get("version") or "")
    if previous:
        _version_tuple(previous)

    if requested:
        _version_tuple(requested)
        return requested
    if previous and metadata.get("source_digest") == source_digest and not bump:
        return previous
    if previous and (bump or metadata.get("source_digest") != source_digest):
        return max((base, _next_patch(previous)), key=_version_tuple)
    return base


def _manifest_bytes(sources: dict[str, bytes], manifest: dict[str, Any], version: str) -> bytes:
    if str(manifest.get("version")) == version:
        return sources["manifest.json"]
    stamped = deepcopy(manifest)
    stamped["version"] = version
    return (json.dumps(stamped, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _xpi_bytes(sources: dict[str, bytes], manifest: dict[str, Any], version: str) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in SOURCE_FILES:
            raw = _manifest_bytes(sources, manifest, version) if name == "manifest.json" else sources[name]
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, raw)
    return output.getvalue()


def _atomic_write_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def package_extension(
    *,
    source_dir: str | os.PathLike[str] | None = None,
    artifact_dir: str | os.PathLike[str] | None = None,
    output: str | os.PathLike[str] | None = None,
    version: str | None = None,
    bump: bool = False,
) -> dict[str, Any]:
    """Create a deterministic unsigned XPI from the allowlisted source files."""

    source = Path(source_dir or extension_source_dir()).resolve()
    artifacts = Path(artifact_dir or default_artifact_dir()).resolve()
    sources = _read_sources(source)
    manifest = _validate_manifest_and_runtime(sources)
    digest = _source_digest(sources)
    artifacts.mkdir(parents=True, exist_ok=True)
    resolved_version = _resolve_version(
        manifest,
        digest,
        artifacts,
        requested=version,
        bump=bump,
    )
    destination = Path(output).resolve() if output else artifacts / f"yuvi-agentbus-bridge-{resolved_version}.xpi"
    raw = _xpi_bytes(sources, manifest, resolved_version)
    _atomic_write_bytes(destination, raw)
    atomic_write_json(
        str(artifacts / "version.json"),
        {
            "extension_id": EXTENSION_ID,
            "source_digest": digest,
            "version": resolved_version,
            "xpi": str(destination),
        },
    )
    return {
        "xpi": str(destination),
        "version": resolved_version,
        "extension_id": EXTENSION_ID,
        "signed": False,
        "source_digest": digest,
        "files": list(SOURCE_FILES),
    }


def _xpi_entries(path: Path) -> tuple[set[str], dict[str, bytes]]:
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            contents = {name: archive.read(name) for name in names if not name.endswith("/")}
    except (OSError, zipfile.BadZipFile) as exc:
        raise AgentbusError(f"invalid browser bridge XPI {path}: {exc}") from exc
    return names, contents


def _signature_entries(names: Iterable[str]) -> list[str]:
    return sorted(
        name
        for name in names
        if name.upper().startswith("META-INF/")
        and name.upper().endswith(SIGNATURE_SUFFIXES)
    )


def verify_signed_xpi(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Validate the signed-XPI packaging boundary.

    Cryptographic signature verification remains Firefox/Mozilla's job.  This
    checks that a signed archive has signature metadata and that its payload is
    still exactly the bridge payload plus META-INF signature files.
    """

    xpi = Path(path).resolve()
    names, contents = _xpi_entries(xpi)
    signatures = _signature_entries(names)
    if not signatures:
        raise AgentbusError(
            "Mozilla-signed XPI required before Firefox Release policy install",
            code="SIGNING_SETUP_REQUIRED",
        )
    if any(name.startswith("/") or ".." in Path(name).parts for name in names):
        raise AgentbusError("browser bridge XPI contains an unsafe path")
    unexpected = {
        name
        for name in names
        if not name.endswith("/")
        and name not in SOURCE_FILES
        and not name.upper().startswith("META-INF/")
    }
    if unexpected:
        raise AgentbusError(f"browser bridge XPI contains unexpected files: {sorted(unexpected)}")
    sources = {name: contents[name] for name in SOURCE_FILES if name in contents}
    if set(sources) != set(SOURCE_FILES):
        raise AgentbusError("signed browser bridge XPI is missing required source files")
    manifest = _validate_manifest_and_runtime(sources)
    return {
        "xpi": str(xpi),
        "signed": True,
        "signatures": signatures,
        "version": str(manifest.get("version") or ""),
        "extension_id": EXTENSION_ID,
    }


def is_signed_xpi(path: str | os.PathLike[str]) -> bool:
    try:
        verify_signed_xpi(path)
    except (AgentbusError, OSError):
        return False
    return True


def _safe_signing_config() -> tuple[str | None, str | None, str | None]:
    web_ext = shutil.which("web-ext")
    issuer = os.environ.get("AMO_JWT_ISSUER")
    secret = os.environ.get("AMO_JWT_SECRET")
    return web_ext, issuer, secret


def sign_extension(
    *,
    source_dir: str | os.PathLike[str] | None = None,
    artifact_dir: str | os.PathLike[str] | None = None,
    version: str | None = None,
    bump: bool = False,
) -> dict[str, Any]:
    """Submit the exact bridge payload to Mozilla's unlisted signing flow.

    Credentials are read only from the process environment and are never
    written to AgentBus state or included in command output.
    """

    web_ext, issuer, secret = _safe_signing_config()
    if not web_ext or not issuer or not secret:
        missing = []
        if not web_ext:
            missing.append("web-ext")
        if not issuer:
            missing.append("AMO_JWT_ISSUER")
        if not secret:
            missing.append("AMO_JWT_SECRET")
        raise AgentbusError(
            "Mozilla unlisted signing setup required; configure " + ", ".join(missing),
            code="SIGNING_SETUP_REQUIRED",
        )

    artifacts = Path(artifact_dir or default_artifact_dir()).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    packaged = package_extension(
        source_dir=source_dir,
        artifact_dir=artifacts,
        version=version,
        bump=bump,
    )
    resolved_version = packaged["version"]
    source = Path(source_dir or extension_source_dir()).resolve()
    sources = _read_sources(source)
    manifest = _validate_manifest_and_runtime(sources)
    with tempfile.TemporaryDirectory(prefix=".yuvi-sign-", dir=str(artifacts)) as staging_name:
        staging = Path(staging_name)
        for name in SOURCE_FILES:
            raw = _manifest_bytes(sources, manifest, resolved_version) if name == "manifest.json" else sources[name]
            (staging / name).write_bytes(raw)
        before = {item.resolve() for item in artifacts.glob("*.xpi")}
        command = [
            web_ext,
            "sign",
            "--source-dir",
            str(staging),
            "--artifacts-dir",
            str(artifacts),
            "--channel",
            "unlisted",
            "--api-key",
            issuer,
            "--api-secret",
            secret,
        ]
        result = subprocess.run(
            command,
            cwd=str(source),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            safe_error = (result.stderr or result.stdout or "web-ext sign failed")
            safe_error = safe_error.replace(secret, "[REDACTED]").replace(issuer, "[REDACTED]")
            raise AgentbusError(f"Mozilla unlisted signing failed: {safe_error[-500:]}")
        produced = [item for item in artifacts.glob("*.xpi") if item.resolve() not in before]
        produced = [item for item in produced if item.resolve() != Path(packaged["xpi"]).resolve()]
        signed = next((item for item in sorted(produced) if is_signed_xpi(item)), None)
        if signed is None:
            raise AgentbusError("web-ext completed without a verifiable signed XPI")
        destination = artifacts / f"yuvi-agentbus-bridge-{resolved_version}-signed.xpi"
        _atomic_write_bytes(destination, signed.read_bytes())
    verified = verify_signed_xpi(destination)
    verified.update({"xpi": str(destination), "version": resolved_version})
    return verified


def _firefox_distribution_candidates() -> list[Path]:
    candidates: list[Path] = []
    override = os.environ.get("YUVI_AGENTBUS_FIREFOX_POLICY")
    if override:
        candidates.append(Path(override).expanduser().resolve())
    firefox = shutil.which("firefox")
    if firefox:
        resolved = Path(os.path.realpath(firefox))
        candidates.append(resolved.parent / "distribution" / "policies.json")
    candidates.extend(
        [
            Path("/usr/lib/firefox/distribution/policies.json"),
            Path("/usr/lib64/firefox/distribution/policies.json"),
            Path("/opt/firefox/distribution/policies.json"),
            Path("/usr/local/lib/firefox/distribution/policies.json"),
            Path("/etc/firefox/policies/policies.json"),
        ]
    )
    result: list[Path] = []
    for item in candidates:
        item = item.resolve()
        if item not in result:
            result.append(item)
    return result


def firefox_policy_path(explicit: str | os.PathLike[str] | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    candidates = _firefox_distribution_candidates()
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    for candidate in candidates:
        if candidate.parent.is_dir() and str(candidate).startswith(("/usr/", "/opt/", "/etc/")):
            return candidate
    return candidates[0] if candidates else Path("/etc/firefox/policies/policies.json")


def _load_policy(path: Path) -> tuple[dict[str, Any], bool]:
    if not path.exists():
        return {"policies": {}}, False
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AgentbusError(f"invalid Firefox policies.json {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise AgentbusError(f"Firefox policies.json must contain an object: {path}")
    return raw, True


def merge_extension_policy(
    policy: dict[str, Any],
    *,
    install_url: str,
) -> tuple[dict[str, Any], bool]:
    result = deepcopy(policy)
    policies = result.setdefault("policies", {})
    if not isinstance(policies, dict):
        raise AgentbusError("Firefox policies.json has a non-object policies value")
    settings = policies.setdefault("ExtensionSettings", {})
    if not isinstance(settings, dict):
        raise AgentbusError("Firefox ExtensionSettings policy is not an object")
    desired = {"installation_mode": "normal_installed", "install_url": install_url}
    changed = settings.get(EXTENSION_ID) != desired
    settings[EXTENSION_ID] = desired
    return result, changed


def _file_url(path: Path) -> str:
    return path.resolve().as_uri()


def install_persistent_extension(
    xpi: str | os.PathLike[str],
    *,
    policy_path: str | os.PathLike[str] | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Install a Mozilla-signed XPI via ExtensionSettings only."""

    verified = verify_signed_xpi(xpi)
    package = Path(xpi).resolve()
    policy = firefox_policy_path(policy_path)
    current, existed = _load_policy(policy)
    merged, changed = merge_extension_policy(current, install_url=_file_url(package))
    backup = None
    if changed and not dry_run:
        parent_writable = os.access(policy.parent, os.W_OK)
        file_writable = not policy.exists() or os.access(policy, os.W_OK)
        if not parent_writable or not file_writable:
            raise AgentbusError(
                f"Firefox policy requires one privileged install at {policy}; "
                "rerun the same browser install command with sudo",
                code="POLICY_WRITE_REQUIRED",
            )
        if existed:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = Path(f"{policy}.bak-{stamp}-{os.getpid()}")
            shutil.copy2(policy, backup)
        atomic_write_json(str(policy), merged)
    return {
        **verified,
        "policy_path": str(policy),
        "policy_existed_before": existed,
        "changed": changed,
        "dry_run": dry_run,
        "backup": str(backup) if backup else None,
        "installation_mode": "normal_installed",
        "install_url": _file_url(package),
    }


def browser_artifact_status(artifact_dir: str | os.PathLike[str]) -> dict[str, Any]:
    artifacts = Path(artifact_dir).resolve()
    unsigned = sorted(str(path) for path in artifacts.glob("yuvi-agentbus-bridge-*.xpi") if not path.name.endswith("-signed.xpi"))
    signed = sorted(str(path) for path in artifacts.glob("yuvi-agentbus-bridge-*-signed.xpi") if is_signed_xpi(path))
    return {
        "artifact_dir": str(artifacts),
        "unsigned_xpis": unsigned,
        "signed_xpis": signed,
        "web_ext": shutil.which("web-ext"),
        "signing_credentials_configured": bool(
            os.environ.get("AMO_JWT_ISSUER") and os.environ.get("AMO_JWT_SECRET")
        ),
    }
