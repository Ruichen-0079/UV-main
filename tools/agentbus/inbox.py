from __future__ import annotations

import os
import shutil
from typing import Any

from agentbus.apply import ingest_text
from agentbus.store import StreamStore
from agentbus.util import utc_now


def list_inbox_files(store: StreamStore) -> list[str]:
    if not os.path.isdir(store.inbox_dir):
        return []
    names = []
    for name in sorted(os.listdir(store.inbox_dir)):
        path = os.path.join(store.inbox_dir, name)
        if os.path.isfile(path) and not name.startswith("."):
            names.append(path)
    return names


def process_inbox(
    store: StreamStore,
    state: dict[str, Any],
    *,
    repo: str,
    current_head: str | None,
) -> list[str]:
    notes: list[str] = []
    os.makedirs(store.processed_dir, exist_ok=True)
    for path in list_inbox_files(store):
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        applied = ingest_text(
            store,
            state,
            text,
            repo=repo,
            current_head=current_head,
            source="inbox",
            source_id=os.path.basename(path),
        )
        dest = os.path.join(store.processed_dir, f"{utc_now().replace(':', '')}-{os.path.basename(path)}")
        shutil.move(path, dest)
        if applied:
            notes.append(
                f"inbox {os.path.basename(path)} -> " + ", ".join(item.kind for item in applied)
            )
        else:
            notes.append(f"inbox {os.path.basename(path)} had no envelope")
    return notes


def write_inbox(store: StreamStore, filename: str, content: str) -> str:
    os.makedirs(store.inbox_dir, exist_ok=True)
    path = os.path.join(store.inbox_dir, filename)
    from agentbus.util import atomic_write_text

    atomic_write_text(path, content if content.endswith("\n") else content + "\n")
    return path
