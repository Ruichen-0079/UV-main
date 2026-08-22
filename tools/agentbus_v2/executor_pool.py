"""Operational executor selection; semantic WORK facts stay authoritative."""

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


@dataclass(frozen=True)
class GrokExecutorAccount:
    name: str
    grok_home: Path
    model: str
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


def _validated_accounts(
    accounts: tuple[ExecutorAccount, ...], source: str
) -> tuple[ExecutorAccount, ...]:
    names: set[str] = set()
    homes: set[Path] = set()
    validated: list[ExecutorAccount] = []
    for account in accounts:
        home = Path(account.codex_home).expanduser().resolve()
        if not ACCOUNT_NAME_RE.fullmatch(account.name) or account.name in names:
            raise FactError(f"executor accounts require unique valid names: {source}")
        if home in homes:
            raise FactError(f"executor accounts share one CODEX_HOME: {source}")
        if type(account.enabled) is not bool:
            raise FactError(f"executor account enabled flag is invalid: {source}")
        names.add(account.name)
        homes.add(home)
        validated.append(ExecutorAccount(account.name, home, account.enabled))
    return tuple(validated)


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
            accounts.append(ExecutorAccount(name, Path(codex_home), enabled))
        return _validated_accounts(tuple(accounts), str(path))
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise FactError(f"invalid executor configuration {path}: {error}") from error


def list_executor_accounts(state_root: Path) -> tuple[dict[str, object], ...]:
    return tuple({"name": item.name, "enabled": item.enabled} for item in load_accounts(state_root))


def grok_executor_config_path(state_root: Path) -> Path:
    return Path(state_root) / "grok_executors.json"


def _validated_grok_accounts(
    accounts: tuple[GrokExecutorAccount, ...], source: str
) -> tuple[GrokExecutorAccount, ...]:
    names: set[str] = set()
    homes: set[Path] = set()
    validated: list[GrokExecutorAccount] = []
    for account in accounts:
        home = Path(account.grok_home).expanduser().resolve()
        if not ACCOUNT_NAME_RE.fullmatch(account.name) or account.name in names:
            raise FactError(f"Grok executors require unique valid names: {source}")
        if home in homes:
            raise FactError(f"Grok executors share one GROK_HOME: {source}")
        if type(account.enabled) is not bool:
            raise FactError(f"Grok executor enabled flag is invalid: {source}")
        if type(account.model) is not str or not account.model.strip():
            raise FactError(f"Grok executor model must be non-empty: {source}")
        names.add(account.name)
        homes.add(home)
        validated.append(GrokExecutorAccount(account.name, home, account.model, account.enabled))
    return tuple(validated)


def load_grok_executors(state_root: Path) -> tuple[GrokExecutorAccount, ...]:
    path = grok_executor_config_path(state_root)
    if not path.exists():
        return ()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        entries = value.get("executors") if isinstance(value, dict) else None
        if not isinstance(entries, list):
            raise TypeError("executors must be a list")
        accounts: list[GrokExecutorAccount] = []
        names: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {
                "name", "grok_home", "model", "enabled"
            }:
                raise TypeError("each Grok executor requires name, grok_home, model, enabled")
            name = entry.get("name")
            grok_home = entry.get("grok_home")
            model = entry.get("model")
            enabled = entry.get("enabled")
            if (
                type(name) is not str
                or not ACCOUNT_NAME_RE.fullmatch(name)
                or name in names
                or type(grok_home) is not str
                or not grok_home.strip()
                or type(model) is not str
                or not model.strip()
                or type(enabled) is not bool
            ):
                raise TypeError("Grok executor requires unique name, home, model, and boolean enabled")
            names.add(name)
            accounts.append(GrokExecutorAccount(name, Path(grok_home), model, enabled))
        return _validated_grok_accounts(tuple(accounts), str(path))
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise FactError(f"invalid Grok executor configuration {path}: {error}") from error


def grok_account_lock_path(state_root: Path, account: GrokExecutorAccount) -> Path:
    return Path(state_root) / "executors" / "grok" / f"{account.name}.lock"


@contextmanager
def grok_account_lock(
    state_root: Path, account: GrokExecutorAccount, *, expose_fd: bool = False
) -> Iterator[bool | int | None]:
    with _lock_path(grok_account_lock_path(state_root, account), expose_fd=expose_fd) as locked:
        yield locked


def _account_availability(state_root: Path, account: GrokExecutorAccount) -> str:
    if not account.enabled:
        return "disabled"
    with grok_account_lock(state_root, account) as acquired:
        return "configured" if acquired else "busy"


def list_grok_executors(state_root: Path) -> tuple[dict[str, object], ...]:
    accounts = load_grok_executors(state_root)
    return tuple(
        {
            "backend": "GROK",
            "name": item.name,
            "enabled": item.enabled,
            "model": item.model,
            "grok_home": str(item.grok_home),
            "availability": _account_availability(state_root, item),
        }
        for item in accounts
    )


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
        self,
        state_root: Path,
        accounts: tuple[ExecutorAccount, ...] | None = None,
        grok_accounts: tuple[GrokExecutorAccount, ...] | None = None,
    ) -> None:
        self.state_root = Path(state_root)
        self.accounts = (
            _validated_accounts(accounts, "ExecutorPool")
            if accounts is not None
            else load_accounts(self.state_root)
        )
        self.grok_accounts = (
            _validated_grok_accounts(grok_accounts, "ExecutorPool")
            if grok_accounts is not None
            else load_grok_executors(self.state_root)
        )

    def run(
        self,
        paths: PPaths,
        config: PConfig,
        snapshot: Snapshot,
        action: Action,
        *,
        executor: Executor | None = None,
        backend: str = "CODEX",
    ) -> "EffectResult":
        if action.kind is not ActionKind.WORK or not action.effect_id:
            raise FactError("executor pool received a non-WORK action")
        backend = str(backend).upper()
        if backend not in {"CODEX", "GROK"}:
            raise FactError(f"unsupported executor backend: {backend}")
        use_owned_executor = executor is None
        default_grok_executor = False
        if executor is None:
            if backend == "CODEX":
                from .effects import run_codex_work

                executor = run_codex_work
            else:
                from .effects import run_grok_work

                executor = run_grok_work
                default_grok_executor = True
        accounts = self.accounts if backend == "CODEX" else self.grok_accounts
        backend_label = "Codex" if backend == "CODEX" else "Grok"
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
            for account in accounts:
                if not account.enabled:
                    continue
                account_context = (
                    nullcontext(True)
                    if use_owned_executor
                    else (
                        account_lock(self.state_root, account)
                        if backend == "CODEX"
                        else grok_account_lock(self.state_root, account)
                    )
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
                    account_home = (
                        account.codex_home
                        if backend == "CODEX"
                        else account.grok_home
                    )
                    account_path = (
                        account_lock_path(self.state_root, account)
                        if backend == "CODEX"
                        else grok_account_lock_path(self.state_root, account)
                    )
                    try:
                        if use_owned_executor:
                            executor_kwargs = {
                                "worktree_lock_path": worktree_path,
                                "account_lock_path": account_path,
                            }
                            if default_grok_executor:
                                executor_kwargs["model"] = account.model
                            result = executor(
                                paths, config, snapshot, action, account_home, **executor_kwargs
                            )
                        else:
                            result = executor(paths, config, snapshot, action, account_home)
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
                        if result.detail == f"{backend_label} account lock is unavailable":
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
                    if result is not None and "identities drifted before" in result.detail:
                        return _result(False, f"executor={account.name}; {result.detail}")
                    continue
        if attempted:
            return _result(
                False,
                f"all selected {backend_label} attempts were operationally unavailable: "
                + ", ".join(attempted),
            )
        return _result(
            False,
            "no configured Codex account is currently available"
            if backend == "CODEX"
            else "no configured Grok executor is currently available",
        )


def dispatch_work(
    state_root: Path,
    paths: PPaths,
    config: PConfig,
    snapshot: Snapshot,
    action: Action,
    *,
    backend: str = "CODEX",
) -> "EffectResult":
    return ExecutorPool(state_root).run(
        paths, config, snapshot, action, backend=backend
    )
