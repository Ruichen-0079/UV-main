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

    def __enter__(self) -> StreamLock:
        os.makedirs(os.path.dirname(self.lock_path), exist_ok=True)
        self._fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o644)
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

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._fd is not None:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            finally:
                os.close(self._fd)
                self._fd = None
