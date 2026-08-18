"""Display-only normalization for repository paths.

Durable envelopes keep their original paths.  Projection surfaces call this
module so an AgentBus worktree location never becomes part of the user-facing
finding text.
"""

from __future__ import annotations

import os
import re
from typing import Any, Iterable


_REPO_TOP_LEVEL = (
    "apps",
    "packages",
    "tools",
    "scripts",
    "docs",
    "infra",
)
_TOP = "|".join(_REPO_TOP_LEVEL)
_ABSOLUTE_REPO_PATH = re.compile(
    rf"(?<![:/])(?:[A-Za-z]:)?/(?:[^/\s)\]|`]+/)+(?P<repo>(?:{_TOP})/[^\s)\]|`]+)"
)
_AUDIT_WORKTREE_PATH = re.compile(
    rf"(?<![:/])(?:[A-Za-z]:)?(?:/[^\s)\]|`]+)+/audit-worktree/(?P<repo>[^\s)\]|`]+)"
)
_WEB_URL = re.compile(r"https?://[^\s)\]]+")


def display_repo_path(path: str | None, *, roots: Iterable[str] = ()) -> str:
    """Return a stable repo-relative path when ``path`` is displayable as one."""
    if not path:
        return ""
    value = str(path)
    for raw_root in roots:
        root = os.path.abspath(str(raw_root or "")) if raw_root else ""
        if not root:
            continue
        absolute = os.path.abspath(value)
        if absolute == root:
            return os.path.basename(root)
        if absolute.startswith(root + os.sep):
            return os.path.relpath(absolute, root).replace(os.sep, "/")
    match = re.search(rf"(?:^|/)((?:{_TOP})/.*)$", value.replace("\\", "/"))
    return match.group(1) if match else value


def sanitize_display_text(text: str | None, *, roots: Iterable[str] = ()) -> str:
    """Strip host/worktree prefixes while preserving line numbers and Markdown."""
    if not text:
        return ""
    value = str(text).replace("\\", "/")
    normalized_roots = sorted(
        {
            os.path.abspath(str(root)).replace("\\", "/").rstrip("/")
            for root in roots
            if root
        },
        key=len,
        reverse=True,
    )

    def sanitize_segment(segment: str) -> str:
        for root in normalized_roots:
            with_suffix = re.compile(re.escape(root) + r"/(?P<relative>[^\s)\]|`]+)")
            segment = with_suffix.sub(lambda match: match.group("relative"), segment)
            exact = re.compile(r"(?<![A-Za-z0-9_/])" + re.escape(root) + r"(?=$|[\s)\],:`])")
            segment = exact.sub(os.path.basename(root), segment)
        segment = _AUDIT_WORKTREE_PATH.sub(lambda match: match.group("repo"), segment)
        return _ABSOLUTE_REPO_PATH.sub(lambda match: match.group("repo"), segment)

    parts: list[str] = []
    cursor = 0
    for match in _WEB_URL.finditer(value):
        parts.append(sanitize_segment(value[cursor : match.start()]))
        parts.append(match.group(0))
        cursor = match.end()
    parts.append(sanitize_segment(value[cursor:]))
    return "".join(parts)


def sanitize_display_value(value: Any, *, roots: Iterable[str] = ()) -> Any:
    """Recursively sanitize a JSON projection without mutating durable state."""
    if isinstance(value, str):
        return sanitize_display_text(value, roots=roots)
    if isinstance(value, list):
        return [sanitize_display_value(item, roots=roots) for item in value]
    if isinstance(value, tuple):
        return tuple(sanitize_display_value(item, roots=roots) for item in value)
    if isinstance(value, dict):
        return {key: sanitize_display_value(item, roots=roots) for key, item in value.items()}
    return value
