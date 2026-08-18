from __future__ import annotations

import os
import re
from dataclasses import dataclass

from agentbus.util import run_cmd


STATE_DIRNAME = "yuvi-agent-bus"
STREAM_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class AgentbusError(Exception):
    """User-facing orchestration error."""

    def __init__(self, message: str = "", *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


def default_state_root(env: dict[str, str] | None = None) -> str:
    environ = env or os.environ
    override = environ.get("YUVI_AGENTBUS_STATE")
    if override:
        return os.path.abspath(override)
    xdg = environ.get("XDG_STATE_HOME")
    if xdg:
        return os.path.join(os.path.abspath(xdg), STATE_DIRNAME)
    home = environ.get("HOME") or os.path.expanduser("~")
    return os.path.join(home, ".local", "state", STATE_DIRNAME)


def normalize_stream_id(raw: str) -> str:
    value = raw.strip().lower()
    if not STREAM_ID_RE.match(value):
        raise AgentbusError(
            f"invalid stream id {raw!r}; use lowercase letters, digits, '.', '_' or '-'"
        )
    return value


def sanitize_repo_id(origin_url: str) -> str:
    value = origin_url.strip()
    value = re.sub(r"^git@([^:]+):", r"\1/", value)
    value = re.sub(r"^https?://", "", value)
    value = re.sub(r"^ssh://git@", "", value)
    value = value.removesuffix(".git")
    value = value.replace(":", "/")
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", value)
    value = value.strip("._-")
    return value or "local-repo"


@dataclass(frozen=True)
class RepoContext:
    repo_root: str
    common_dir: str
    origin: str
    repo_id: str
    state_root: str
    repo_state: str

    @property
    def streams_root(self) -> str:
        return self.repo_state


def find_git_root(start: str | None = None) -> str:
    cwd = os.path.abspath(start or os.getcwd())
    result = run_cmd(["git", "rev-parse", "--show-toplevel"], cwd=cwd, timeout=10)
    if result.returncode != 0:
        raise AgentbusError(f"not inside a git repository: {cwd}")
    return result.stdout.strip()


def find_common_dir(repo_root: str) -> str:
    result = run_cmd(["git", "rev-parse", "--git-common-dir"], cwd=repo_root, timeout=10)
    if result.returncode != 0:
        raise AgentbusError("unable to resolve git common dir")
    common = result.stdout.strip()
    if not os.path.isabs(common):
        common = os.path.abspath(os.path.join(repo_root, common))
    return common


def origin_url(repo_root: str) -> str:
    result = run_cmd(["git", "remote", "get-url", "origin"], cwd=repo_root, timeout=10)
    if result.returncode != 0:
        return "local"
    return result.stdout.strip() or "local"


def discover_repo(start: str | None = None, env: dict[str, str] | None = None) -> RepoContext:
    repo_root = find_git_root(start)
    common = find_common_dir(repo_root)
    origin = origin_url(repo_root)
    repo_id = sanitize_repo_id(origin)
    state_root = default_state_root(env)
    repo_state = os.path.join(state_root, repo_id)
    return RepoContext(
        repo_root=repo_root,
        common_dir=common,
        origin=origin,
        repo_id=repo_id,
        state_root=state_root,
        repo_state=repo_state,
    )


def stream_dir(ctx: RepoContext, stream_id: str) -> str:
    return os.path.join(ctx.repo_state, normalize_stream_id(stream_id))


def ensure_stream_dirs(path: str) -> None:
    for name in ("inbox", "inbox/processed", "artifacts", "logs"):
        os.makedirs(os.path.join(path, name), exist_ok=True)
