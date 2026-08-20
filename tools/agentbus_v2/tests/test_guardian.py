from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from tools.agentbus_v2.codex_guardian import GUARDIAN_TIMEOUT, run_guardian
from tools.agentbus_v2.executor_pool import (
    ExecutorAccount,
    account_lock,
    account_lock_path,
    worktree_execution_lock,
    worktree_lock_path,
)


def wait_for(path: Path, timeout: float = 5.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return path.read_text(encoding="utf-8")
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {path}")


def process_alive(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as stream:
            state = stream.read().split()[2]
        return state != "Z"
    except FileNotFoundError:
        return False
    except (OSError, IndexError):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True


def kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def write_mutator(path: Path) -> None:
    path.write_text(
        """
import os
from pathlib import Path
import subprocess
import sys
import time

marker = Path(sys.argv[1])
grandchild_marker = Path(sys.argv[2])
grandchild = subprocess.Popen([
    sys.executable, '-c',
    'from pathlib import Path; import os,sys,time; '
    'Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)',
    str(grandchild_marker),
])
marker.write_text(str(os.getpid()) + '\\n')
while True:
    with marker.open('a', encoding='utf-8') as handle:
        handle.write(f'{time.monotonic()}\\n')
    time.sleep(0.02)
""",
        encoding="utf-8",
    )


class GuardianTests(unittest.TestCase):
    def _locks(self, root: Path):
        account = ExecutorAccount("test", root / "codex-home")
        worktree = root / "worktree"
        worktree.mkdir()
        return account, worktree

    def _guardian_kwargs(self, root: Path, state: Path, account: ExecutorAccount, worktree: Path):
        return {
            "cwd": worktree,
            "env": os.environ.copy(),
            "log_path": root / "guardian.log",
            "timeout": 3,
            "worktree_lock": worktree_lock_path(state, worktree),
            "account_lock": account_lock_path(state, account),
        }

    def test_normal_completion_releases_both_locks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            account, worktree = self._locks(root)
            state = root / "state"
            result = run_guardian(
                [sys.executable, "-c", "import sys; print(sys.stdin.read())"],
                input_text="normal",
                **self._guardian_kwargs(root, state, account, worktree),
            )
            self.assertEqual(0, result.returncode)
            self.assertFalse(result.parent_lost)
            self.assertIn("normal", (root / "guardian.log").read_text(encoding="utf-8"))
            with worktree_execution_lock(state, worktree) as work_acquired:
                self.assertTrue(work_acquired)
            with account_lock(state, account) as account_acquired:
                self.assertTrue(account_acquired)

    def test_timeout_terminates_descendant_process_group_before_unlock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            account, worktree = self._locks(root)
            script = root / "mutator.py"
            marker = root / "child.pid"
            grandchild_marker = root / "grandchild.pid"
            write_mutator(script)
            state = root / "state"
            kwargs = self._guardian_kwargs(root, state, account, worktree)
            kwargs["timeout"] = 0.25
            result = run_guardian(
                [sys.executable, str(script), str(marker), str(grandchild_marker)],
                **kwargs,
            )
            self.assertEqual(GUARDIAN_TIMEOUT, result.returncode)
            child_pid = int(wait_for(marker).splitlines()[0])
            grandchild_pid = int(wait_for(grandchild_marker))
            self.assertFalse(process_alive(child_pid))
            self.assertFalse(process_alive(grandchild_pid))
            with worktree_execution_lock(state, worktree) as acquired:
                self.assertTrue(acquired)
            with account_lock(state, account) as acquired:
                self.assertTrue(acquired)

    def test_parent_sigkill_cleans_child_and_grandchild_before_restart_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            account, worktree = self._locks(root)
            state = root / "state"
            script = root / "mutator.py"
            parent_script = root / "parent.py"
            marker = root / "child.pid"
            grandchild_marker = root / "grandchild.pid"
            ready = root / "ready"
            write_mutator(script)
            parent_script.write_text(
                """
import os, sys
from pathlib import Path
from tools.agentbus_v2.codex_guardian import run_guardian
from tools.agentbus_v2.executor_pool import ExecutorAccount, account_lock_path, worktree_lock_path

state, worktree, account_name, account_home, child, grandchild, ready, log, script = map(Path, sys.argv[1:])
account = ExecutorAccount(account_name, account_home)
ready.write_text('ready')
run_guardian(
    [sys.executable, str(script), str(child), str(grandchild)],
    cwd=worktree,
    env=os.environ.copy(),
    log_path=log,
    timeout=30,
    worktree_lock=worktree_lock_path(state, worktree),
    account_lock=account_lock_path(state, account),
)
""",
                encoding="utf-8",
            )
            env = os.environ.copy()
            repo_root = str(Path(__file__).resolve().parents[3])
            env["PYTHONPATH"] = repo_root + os.pathsep + env.get("PYTHONPATH", "")
            parent = subprocess.Popen(
                [
                    sys.executable,
                    str(parent_script),
                    str(state),
                    str(worktree),
                    account.name,
                    str(account.codex_home),
                    str(marker),
                    str(grandchild_marker),
                    str(ready),
                    str(root / "parent.log"),
                    str(script),
                ],
                cwd=repo_root,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            child_pid: int | None = None
            grandchild_pid: int | None = None
            try:
                wait_for(ready)
                child_pid = int(wait_for(marker).splitlines()[0])
                grandchild_pid = int(wait_for(grandchild_marker))
                os.kill(parent.pid, signal.SIGKILL)
                parent.wait(timeout=5)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    with worktree_execution_lock(state, worktree) as work_ok:
                        with account_lock(state, account) as account_ok:
                            if work_ok and account_ok:
                                self.assertFalse(process_alive(child_pid))
                                self.assertFalse(process_alive(grandchild_pid))
                                break
                    time.sleep(0.02)
                else:
                    self.fail("restart could not acquire cleaned execution locks")
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait(timeout=5)
                if child_pid is not None and process_alive(child_pid):
                    kill_group(child_pid)
                if grandchild_pid is not None and process_alive(grandchild_pid):
                    try:
                        os.kill(grandchild_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_guardian_death_leaves_direct_codex_holding_execution_locks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            account, worktree = self._locks(root)
            script = root / "mutator.py"
            marker = root / "child.pid"
            grandchild_marker = root / "grandchild.pid"
            write_mutator(script)
            state = root / "state"
            read_fd, write_fd = os.pipe()
            os.set_inheritable(read_fd, True)
            command = [
                sys.executable,
                str(Path(__file__).resolve().parents[1] / "codex_guardian.py"),
                "--cwd", str(worktree),
                "--log", str(root / "guardian.log"),
                "--liveness-fd", str(read_fd),
                "--worktree-lock", str(worktree_lock_path(state, worktree)),
                "--account-lock", str(account_lock_path(state, account)),
                "--timeout", "30", "--", sys.executable, str(script),
                str(marker), str(grandchild_marker),
            ]
            guardian = subprocess.Popen(
                command,
                cwd=worktree,
                env=os.environ.copy(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                pass_fds=(read_fd,),
            )
            os.close(read_fd)
            child_pid: int | None = None
            try:
                child_pid = int(wait_for(marker).splitlines()[0])
                os.kill(guardian.pid, signal.SIGKILL)
                guardian.wait(timeout=5)
                self.assertTrue(process_alive(child_pid))
                with worktree_execution_lock(state, worktree) as blocked:
                    self.assertFalse(blocked)
                with account_lock(state, account) as blocked:
                    self.assertFalse(blocked)
            finally:
                os.close(write_fd)
                if guardian.poll() is None:
                    guardian.kill()
                    guardian.wait(timeout=5)
                if child_pid is not None and process_alive(child_pid):
                    kill_group(child_pid)
            deadline = time.monotonic() + 5
            while child_pid is not None and process_alive(child_pid) and time.monotonic() < deadline:
                time.sleep(0.02)
            with worktree_execution_lock(state, worktree) as acquired:
                self.assertTrue(acquired)


if __name__ == "__main__":
    unittest.main()
