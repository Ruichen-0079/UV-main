"""Small Linux process guardian for mutating Codex WORK executions."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import os
import select
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Sequence


PARENT_GONE = 125
GUARDIAN_TIMEOUT = 124
GUARDIAN_ERROR = 126
WORKTREE_BUSY = 123
ACCOUNT_BUSY = 122
IDENTITY_DRIFT = 121
_GUARDIAN_CODES = {
    PARENT_GONE,
    GUARDIAN_TIMEOUT,
    GUARDIAN_ERROR,
    WORKTREE_BUSY,
    ACCOUNT_BUSY,
    IDENTITY_DRIFT,
}


@dataclass(frozen=True)
class GuardianResult:
    returncode: int
    parent_lost: bool = False
    timed_out: bool = False
    worktree_busy: bool = False
    account_busy: bool = False
    identity_drift: bool = False


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _terminate_group(pgid: int, grace: float = 1.0) -> None:
    if not _group_alive(pgid):
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + grace
    while _group_alive(pgid) and time.monotonic() < deadline:
        time.sleep(0.02)
    if _group_alive(pgid):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + grace
        while _group_alive(pgid) and time.monotonic() < deadline:
            time.sleep(0.02)


def _parent_gone(read_fd: int) -> bool:
    try:
        ready, _, _ = select.select([read_fd], [], [], 0)
        if not ready:
            return False
        return os.read(read_fd, 1) == b""
    except OSError:
        return True


@contextmanager
def _owned_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
            return
        try:
            yield handle
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _guarded_main(
    command: Sequence[str],
    cwd: Path,
    log_path: Path,
    read_fd: int,
    worktree_lock: Path,
    account_lock: Path,
    timeout: float,
    expected_head: str | None = None,
    expected_branch: str | None = None,
) -> int:
    child: subprocess.Popen[bytes] | None = None
    stop_requested = False

    def request_stop(_signum: int, _frame: object) -> None:
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        # Drain the parent-supplied prompt before attempting locks.  This
        # keeps a busy-account response from blocking the parent on a full
        # stdin pipe, while the liveness pipe still fences parent death.
        try:
            input_data = sys.stdin.buffer.read()
        except OSError:
            input_data = b""
        if _parent_gone(read_fd) or stop_requested:
            return PARENT_GONE
        with _owned_lock(worktree_lock) as work_handle:
            if work_handle is None:
                return WORKTREE_BUSY
            with _owned_lock(account_lock) as account_handle:
                if account_handle is None:
                    return ACCOUNT_BUSY
                if _parent_gone(read_fd) or stop_requested:
                    return PARENT_GONE
                if expected_head is not None or expected_branch is not None:
                    if expected_head is None or expected_branch is None:
                        return GUARDIAN_ERROR
                    try:
                        head = subprocess.run(
                            ("git", "rev-parse", "HEAD"),
                            cwd=cwd,
                            text=True,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            timeout=10,
                            check=False,
                        )
                        branch = subprocess.run(
                            ("git", "branch", "--show-current"),
                            cwd=cwd,
                            text=True,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            timeout=10,
                            check=False,
                        )
                        status = subprocess.run(
                            ("git", "status", "--porcelain=v1"),
                            cwd=cwd,
                            text=True,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            timeout=10,
                            check=False,
                        )
                    except (OSError, subprocess.TimeoutExpired):
                        return GUARDIAN_ERROR
                    if (
                        head.returncode != 0
                        or branch.returncode != 0
                        or status.returncode != 0
                    ):
                        return GUARDIAN_ERROR
                    if (
                        head.stdout.strip() != expected_head
                        or branch.stdout.strip() != expected_branch
                        or bool(status.stdout.strip())
                    ):
                        return IDENTITY_DRIFT
                if _parent_gone(read_fd) or stop_requested:
                    return PARENT_GONE
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with log_path.open("wb") as log:
                    child = subprocess.Popen(
                        list(command),
                        cwd=cwd,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.PIPE,
                        start_new_session=True,
                        close_fds=True,
                        pass_fds=(work_handle.fileno(), account_handle.fileno()),
                    )
                    if child.stdin is not None:
                        try:
                            child.stdin.write(input_data)
                            child.stdin.close()
                        except BrokenPipeError:
                            pass
                    deadline = time.monotonic() + timeout
                    while child.poll() is None:
                        if stop_requested:
                            _terminate_group(child.pid)
                            return GUARDIAN_TIMEOUT
                        if _parent_gone(read_fd):
                            _terminate_group(child.pid)
                            return PARENT_GONE
                        if time.monotonic() >= deadline:
                            _terminate_group(child.pid)
                            return GUARDIAN_TIMEOUT
                        time.sleep(0.05)
                    child.wait()
                    # A Codex descendant may outlive the direct process.  The
                    # process group remains owned until it has disappeared.
                    _terminate_group(child.pid)
                    code = child.returncode if child.returncode is not None else GUARDIAN_ERROR
                    return GUARDIAN_ERROR if code in _GUARDIAN_CODES else code
    except (OSError, ValueError):
        if child is not None:
            _terminate_group(child.pid)
        return GUARDIAN_ERROR
    finally:
        try:
            os.close(read_fd)
        except OSError:
            pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agentbus-v2-codex-guardian")
    parser.add_argument("--cwd", type=Path, required=True)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--liveness-fd", type=int, required=True)
    parser.add_argument("--worktree-lock", type=Path, required=True)
    parser.add_argument("--account-lock", type=Path, required=True)
    parser.add_argument("--timeout", type=float, required=True)
    parser.add_argument("--expected-head")
    parser.add_argument("--expected-branch")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser


def _main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        return GUARDIAN_ERROR
    return _guarded_main(
        command,
        args.cwd,
        args.log,
        args.liveness_fd,
        args.worktree_lock,
        args.account_lock,
        args.timeout,
        args.expected_head,
        args.expected_branch,
    )


def run_guardian(
    command: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
    timeout: float,
    worktree_lock: Path,
    account_lock: Path,
    input_text: str | None = None,
    expected_head: str | None = None,
    expected_branch: str | None = None,
) -> GuardianResult:
    """Run an owned Codex guardian while retaining parent-liveness signaling."""

    read_fd, write_fd = os.pipe()
    os.set_inheritable(read_fd, True)
    guardian_command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--cwd", str(cwd),
        "--log", str(log_path),
        "--liveness-fd", str(read_fd),
        "--worktree-lock", str(worktree_lock),
        "--account-lock", str(account_lock),
        "--timeout", str(timeout),
    ]
    if expected_head is not None:
        guardian_command.extend(("--expected-head", expected_head))
    if expected_branch is not None:
        guardian_command.extend(("--expected-branch", expected_branch))
    guardian_command.extend(("--", *command))
    process: subprocess.Popen[bytes] | None = None
    read_closed = False
    try:
        process = subprocess.Popen(
            guardian_command,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            pass_fds=(read_fd,),
        )
        os.close(read_fd)
        read_closed = True
        if process.stdin is not None:
            try:
                process.stdin.write((input_text or "").encode("utf-8"))
                process.stdin.close()
            except (BrokenPipeError, OSError, ValueError):
                try:
                    process.stdin.close()
                except (OSError, ValueError):
                    pass
        try:
            returncode = process.wait(timeout=timeout + 5.0)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5.0)
            return GuardianResult(GUARDIAN_TIMEOUT, timed_out=True)
        return GuardianResult(
            returncode,
            parent_lost=returncode == PARENT_GONE,
            timed_out=returncode == GUARDIAN_TIMEOUT,
            worktree_busy=returncode == WORKTREE_BUSY,
            account_busy=returncode == ACCOUNT_BUSY,
            identity_drift=returncode == IDENTITY_DRIFT,
        )
    finally:
        if not read_closed:
            try:
                os.close(read_fd)
            except OSError:
                pass
        try:
            os.close(write_fd)
        except OSError:
            pass
        if process is not None and process.poll() is None:
            process.terminate()


if __name__ == "__main__":
    sys.exit(_main())
