from __future__ import annotations

import fcntl
import os
import time
from types import TracebackType


class StreamLock:
    def __init__(self, lock_path: str, *, exclusive: bool = True, wait: float = 3.0) -> None:
        self.lock_path = lock_path
        self.exclusive = exclusive
        self.wait = wait
        self._fd: int | None = None

    def _open(self) -> int:
        directory = os.path.dirname(self.lock_path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        return os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o644)

    def try_acquire(self) -> bool:
        """Acquire once, returning False when another process owns the lock.

        This is intentionally separate from ``__enter__``.  Stream and
        durable-authority locks retain their existing bounded wait semantics;
        the campaign scheduler is the one caller that treats contention as a
        normal coalescing outcome.
        """

        if self._fd is not None:
            return True
        fd = self._open()
        flag = fcntl.LOCK_EX if self.exclusive else fcntl.LOCK_SH
        try:
            fcntl.flock(fd, flag | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            return False
        self._fd = fd
        return True

    def __enter__(self) -> StreamLock:
        self._fd = self._open()
        flag = fcntl.LOCK_EX if self.exclusive else fcntl.LOCK_SH
        deadline = time.time() + self.wait
        while True:
            try:
                fcntl.flock(self._fd, flag | fcntl.LOCK_NB)
                return self
            except BlockingIOError as exc:
                if time.time() >= deadline:
                    os.close(self._fd)
                    self._fd = None
                    raise TimeoutError(f"stream is locked: {self.lock_path}") from exc
                time.sleep(0.05)

    def release(self) -> None:
        if self._fd is not None:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            finally:
                os.close(self._fd)
                self._fd = None

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.release()
