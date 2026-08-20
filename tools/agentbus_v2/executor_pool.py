"""Operational Codex account selection; semantic WORK facts stay authoritative."""

from __future__ import annotations

from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
import fcntl
import hashlib
import json
from pathlib import Path
import re
from typing import Callable, Iterator, TYPE_CHECKING

from .core import Action, ActionKind, Observation, Snapshot
from .facts import (
    FactError,
    PConfig,
    PPaths,
    _load_work,
    _work_from_head,
    git,
)

if TYPE_CHECKING:
    from .effects import EffectResult


ACCOUNT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


@dataclass(frozen=True)
class ExecutorAccount:
    name: str
    codex_home: Path
    enabled: bool = True


class UnsafeExecutorAttempt(RuntimeError):
    pass

def executor_config_path(state_root: Path) -> Path:
    return Path(state_root) / "executors.json"


def _default_accounts() -> tuple[ExecutorAccount, ...]:
    home = Path.home()
    return (
        ExecutorAccount("primary", home / ".codex"),
        ExecutorAccount("secondary", home / ".codex-secondary"),
    )


def load_accounts(state_root: Path) -> tuple[ExecutorAccount, ...]:
    path = executor_config_path(state_root)
    if not path.exists():
        return _default_accounts()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        entries = value["accounts"] if isinstance(value, dict) else None
        if not isinstance(entries, list) or not entries:
            raise TypeError("accounts must be a non-empty list")
        accounts: list[ExecutorAccount] = []
        names: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise TypeError("each account must be an object")
            name = entry.get("name")
            codex_home = entry.get("codex_home")
            enabled = entry.get("enabled", True)
            if (
                type(name) is not str
                or not ACCOUNT_NAME_RE.fullmatch(name)
                or name in names
                or type(codex_home) is not str
                or not codex_home.strip()
                or type(enabled) is not bool
            ):
                raise TypeError("account requires unique name, codex_home, and boolean enabled")
            names.add(name)
            accounts.append(ExecutorAccount(name, Path(codex_home).expanduser(), enabled))
        return tuple(accounts)
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise FactError(f"invalid executor configuration {path}: {error}") from error


def list_executor_accounts(state_root: Path) -> tuple[dict[str, object], ...]:
    return tuple({"name": item.name, "enabled": item.enabled} for item in load_accounts(state_root))


@contextmanager
def _lock_path(path: Path, *, expose_fd: bool = False) -> Iterator[bool | int | None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield handle.fileno() if expose_fd else True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def account_lock(
    state_root: Path, account: ExecutorAccount, *, expose_fd: bool = False
) -> Iterator[bool | int | None]:
    with _lock_path(account_lock_path(state_root, account), expose_fd=expose_fd) as locked:
        yield locked


def account_lock_path(state_root: Path, account: ExecutorAccount) -> Path:
    return Path(state_root) / "executors" / f"{account.name}.lock"


def worktree_lock_path(state_root: Path, worktree: str | Path) -> Path:
    identity = str(Path(worktree).expanduser().resolve()).encode("utf-8")
    key = hashlib.sha256(identity).hexdigest()[:32]
    return Path(state_root) / "executors" / "worktrees" / f"{key}.lock"


def worktree_execution_lock(
    state_root: Path, worktree: str | Path, *, expose_fd: bool = False
) -> Iterator[bool | int | None]:
    return _lock_path(worktree_lock_path(state_root, worktree), expose_fd=expose_fd)


def _branch_refs(config: PConfig) -> dict[str, str]:
    lines = git(
        Path(config.worktree), "for-each-ref", "--format=%(refname) %(objectname)",
        "refs/heads",
    ).splitlines()
    return dict(line.split(" ", 1) for line in lines if " " in line)


def _semantic_work_state(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> str | None:
    if action.kind is not ActionKind.WORK or not action.effect_id:
        raise FactError("executor pool received a non-WORK action")
    spec_id = str(action.payload.get("spec_id"))
    spec = next((item for item in snapshot.specs if item.spec_id == spec_id), None)
    if spec is None:
        raise FactError("WORK effect references an absent SPEC")
    head = git(Path(config.worktree), "rev-parse", "HEAD")
    recovered = _work_from_head(config, head)
    if (
        recovered is not None
        and recovered.effect_id == action.effect_id
        and recovered.spec_id == spec.spec_id
        and recovered.input_head == snapshot.head
    ):
        return "PASS"
    failure = _load_work(
        paths,
        config,
        snapshot,
        spec,
        trigger=action.payload.get("trigger_judge_id"),
    )
    if failure is not None and failure.status is Observation.FAIL:
        return "FAIL"
    return None


def _result(changed: bool, detail: str) -> "EffectResult":
    from .effects import EffectResult

    return EffectResult(changed, detail)


Executor = Callable[[PPaths, PConfig, Snapshot, Action, Path], "EffectResult"]


class ExecutorPool:
    def __init__(
        self, state_root: Path, accounts: tuple[ExecutorAccount, ...] | None = None
    ) -> None:
        self.state_root = Path(state_root)
        self.accounts = accounts if accounts is not None else load_accounts(self.state_root)

    def run(
        self,
        paths: PPaths,
        config: PConfig,
        snapshot: Snapshot,
        action: Action,
        *,
        executor: Executor | None = None,
    ) -> "EffectResult":
        if action.kind is not ActionKind.WORK or not action.effect_id:
            raise FactError("executor pool received a non-WORK action")
        use_owned_executor = executor is None
        if executor is None:
            from .effects import run_codex_work

            executor = run_codex_work
        attempted: list[str] = []
        worktree_path = worktree_lock_path(self.state_root, config.worktree)
        worktree_context = (
            nullcontext(True)
            if use_owned_executor
            else worktree_execution_lock(self.state_root, config.worktree)
        )
        with worktree_context as worktree_fd:
            if worktree_fd is None or worktree_fd is False:
                return _result(False, "worktree execution lock is unavailable")
            for account in self.accounts:
                if not account.enabled:
                    continue
                account_context = (
                    nullcontext(True)
                    if use_owned_executor
                    else account_lock(self.state_root, account)
                )
                with account_context as account_fd:
                    if account_fd is None or account_fd is False:
                        continue
                    attempted.append(account.name)
                    existing = _semantic_work_state(paths, config, snapshot, action)
                    if existing in {"PASS", "FAIL"}:
                        return _result(False, f"executor={account.name}; recovered WORK {existing}")
                    worktree = Path(config.worktree)
                    before_head = git(worktree, "rev-parse", "HEAD")
                    before_refs = _branch_refs(config)
                    try:
                        if use_owned_executor:
                            result = executor(
                                paths,
                                config,
                                snapshot,
                                action,
                                account.codex_home,
                                worktree_lock_path=worktree_path,
                                account_lock_path=account_lock_path(
                                    self.state_root, account
                                ),
                            )
                        else:
                            result = executor(paths, config, snapshot, action, account.codex_home)
                    except UnsafeExecutorAttempt as error:
                        return _result(
                            False,
                            f"executor={account.name}; operational retry blocked: {error}",
                        )
                    except FactError as error:
                        result = None
                        fatal_error = str(error) or type(error).__name__
                    except Exception:
                        result = None
                        fatal_error = None
                    else:
                        fatal_error = None

                    if use_owned_executor and result is not None:
                        if result.detail == "worktree execution lock is unavailable":
                            return _result(False, f"executor={account.name}; {result.detail}")
                        if result.detail == "Codex account lock is unavailable":
                            continue

                    state = _semantic_work_state(paths, config, snapshot, action)
                    if state in {"PASS", "FAIL"}:
                        return _result(
                            bool(result and result.changed),
                            f"executor={account.name}; recovered WORK {state}"
                            if result is None
                            else f"executor={account.name}; {result.detail}",
                        )
                    if fatal_error is not None:
                        return _result(
                            False,
                            f"executor={account.name}; operational retry blocked: {fatal_error}",
                        )
                    if result is not None and result.changed:
                        return _result(True, f"executor={account.name}; {result.detail}")

                    try:
                        after_head = git(worktree, "rev-parse", "HEAD")
                        after_refs = _branch_refs(config)
                        dirty = git(worktree, "status", "--porcelain=v1")
                    except FactError as error:
                        return _result(
                            False,
                            f"executor={account.name}; operational retry blocked: {error}",
                        )
                    if after_head != before_head or after_refs != before_refs or dirty:
                        return _result(
                            False,
                            f"executor={account.name}; operational retry blocked by ambiguous worktree",
                        )
                    if result is not None and "identities drifted before Codex" in result.detail:
                        return _result(False, f"executor={account.name}; {result.detail}")
                    continue
        if attempted:
            return _result(
                False,
                "all selected Codex attempts were operationally unavailable: "
                + ", ".join(attempted),
            )
        return _result(False, "no configured Codex account is currently available")


def dispatch_work(
    state_root: Path, paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> "EffectResult":
    return ExecutorPool(state_root).run(paths, config, snapshot, action)
