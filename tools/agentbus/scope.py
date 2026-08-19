"""Deterministic path-scope fence for successor materialization.

Natural-language SCOPE remains the intent.
PATH_SCOPE / normalized explicit paths + conservative companions are the fence.
"""

from __future__ import annotations

import fnmatch
import re
from typing import Any

from agentbus.util import utc_now


BACKTICK_PATH = re.compile(r"`((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+)`")
NEW_PATH = re.compile(
    r"\bNEW\s+`?((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+)`?",
    re.IGNORECASE,
)
BARE_BULLET_PATH = re.compile(
    r"^[-*]\s+((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]*)\b",
    re.MULTILINE,
)
TEST_MENTION = re.compile(r"\btests?\b|focused test", re.IGNORECASE)
DOC_MENTION = re.compile(r"\bdocumentation\b|\breadme\b|\bdocs/", re.IGNORECASE)
BROAD_PATTERNS = {
    "apps/**",
    "packages/**",
    "docs/**",
    "**",
    "*/*",
    "apps/**/**",
    "packages/**/**",
}


def looks_like_repo_path(value: str) -> bool:
    item = (value or "").strip().strip("`").lstrip("./")
    if not item or " " in item or item.startswith("http"):
        return False
    if not re.match(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$", item):
        return False
    return bool(re.search(r"\.[A-Za-z][A-Za-z0-9]+$", item))


def extract_explicit_paths(text: str | None) -> list[str]:
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for regex in (BACKTICK_PATH, NEW_PATH, BARE_BULLET_PATH):
        for match in regex.finditer(str(text)):
            token = match.group(1).strip().lstrip("./")
            if looks_like_repo_path(token) and token not in seen:
                seen.add(token)
                found.append(token)
    for line in str(text).splitlines():
        token = line.strip().lstrip("-*").strip().strip("`'\"")
        token = token.split()[0] if token else token
        token = token.strip("`'\"")
        if "`" in token or not looks_like_repo_path(token) or token in seen:
            continue
        seen.add(token)
        found.append(token)
    return found


def parse_path_scope_field(raw: str | None) -> dict[str, list[str]]:
    exact: list[str] = []
    patterns: list[str] = []
    if not raw or not str(raw).strip():
        return {"exact": exact, "patterns": patterns}
    section = None
    for line in str(raw).splitlines():
        item = line.strip()
        if not item:
            continue
        key = item.rstrip(":").upper()
        if key in {"EXACT", "PATHS", "FILES"}:
            section = "exact"
            continue
        if key in {"PATTERNS", "GLOB", "GLOBS"}:
            section = "patterns"
            continue
        token = item.lstrip("-*").strip().strip("`")
        token = re.sub(r"^\d+[.)]\s*", "", token).strip().strip("`")
        if not token:
            continue
        if section == "patterns" or any(ch in token for ch in "*?[]"):
            if token not in patterns:
                patterns.append(token)
        elif looks_like_repo_path(token) and token not in exact:
            exact.append(token)
    return {"exact": exact, "patterns": patterns}


def _too_broad(pattern: str) -> bool:
    value = (pattern or "").strip()
    if value in BROAD_PATTERNS:
        return True
    if value in {"apps/*", "packages/*", "docs/*"}:
        return True
    if value.endswith("/**") and value.count("/") <= 1:
        return True
    return False


def derive_companion_patterns(explicit: list[str], raw_scope: str | None) -> list[str]:
    text = raw_scope or ""
    patterns: list[str] = []
    seen: set[str] = set()

    def add(item: str) -> None:
        if item and item not in seen and not _too_broad(item):
            seen.add(item)
            patterns.append(item)

    for path in explicit:
        if re.search(r"\.(test|spec)\.[A-Za-z]+$", path):
            continue
        match = re.match(r"^(.+)\.(tsx?|jsx?)$", path)
        if match:
            add(f"{match.group(1)}.test.{match.group(2)}")
            add(f"{match.group(1)}.spec.{match.group(2)}")

    mentions_tests = bool(TEST_MENTION.search(text))
    mentions_docs = bool(DOC_MENTION.search(text))
    families: set[str] = set()
    for path in explicit:
        if path.startswith("apps/server/"):
            families.add("server")
        elif path.startswith("packages/providers/"):
            families.add("providers")
        elif path.startswith("apps/web/"):
            families.add("web")
    if mentions_tests:
        if "server" in families:
            add("apps/server/src/*.test.ts")
            add("apps/server/src/**/*.test.ts")
        if "providers" in families:
            add("packages/providers/src/*.test.ts")
            add("packages/providers/src/**/*.test.ts")
        if "web" in families:
            add("apps/web/src/*.test.ts")
            add("apps/web/src/**/*.test.ts")
    if mentions_docs and "providers" in families:
        add("docs/providers*.md")
    return patterns


def materialize_path_scope(
    *,
    raw_scope: str | None,
    path_scope_field: str | None = None,
    source: str | None = None,
) -> dict[str, Any]:
    declared = parse_path_scope_field(path_scope_field)
    explicit = list(declared["exact"])
    for path in extract_explicit_paths(raw_scope):
        if path not in explicit:
            explicit.append(path)
    patterns = list(declared["patterns"])
    for item in derive_companion_patterns(explicit, raw_scope):
        if item not in patterns:
            patterns.append(item)
    return {
        "raw": raw_scope or "",
        "explicit_paths": explicit,
        "allowed_patterns": patterns,
        "source": source or "spec",
        "materialized_at": utc_now(),
    }


def attach_scope(state: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    state["scope"] = scope
    spec = ((state.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields")
    if isinstance(spec, dict) and scope.get("explicit_paths"):
        rendered = ["EXACT:"]
        rendered.extend(f"- {path}" for path in scope["explicit_paths"])
        if scope.get("allowed_patterns"):
            rendered.append("PATTERNS:")
            rendered.extend(f"- {item}" for item in scope["allowed_patterns"])
        spec["PATH_SCOPE"] = "\n".join(rendered)
    return scope


def scope_of(state: dict[str, Any]) -> dict[str, Any] | None:
    spec_record = ((state.get("envelopes") or {}).get("GPT_SPEC") or {})
    spec = spec_record.get("fields") or {}
    if not isinstance(spec, dict):
        existing = state.get("scope")
        return existing if isinstance(existing, dict) else None
    raw_scope = spec.get("SCOPE")
    raw_path_scope = spec.get("PATH_SCOPE")
    raw_envelope = spec_record.get("raw")
    if raw_envelope:
        try:
            from agentbus.protocol import parse_one

            parsed = parse_one(str(raw_envelope))
            if parsed.kind == "GPT_SPEC":
                raw_scope = parsed.fields.get("SCOPE", raw_scope)
                raw_path_scope = parsed.fields.get("PATH_SCOPE", raw_path_scope)
        except (ValueError, TypeError):
            pass
    source = spec.get("SOURCE_CONTINUATION_COMMENT_ID") or spec.get("CONTINUATION_OF")
    if source and str(source).isdigit():
        source = f"continuation:{source}"
    elif spec.get("SOURCE_CONTINUATION_COMMENT_ID"):
        source = f"continuation:{spec.get('SOURCE_CONTINUATION_COMMENT_ID')}"
    elif source:
        source = f"continuation:{source}"
    else:
        source = "spec"
    scope = materialize_path_scope(
        raw_scope=raw_scope,
        path_scope_field=raw_path_scope,
        source=source,
    )
    existing = state.get("scope")
    if isinstance(existing, dict) and all(
        existing.get(key) == scope.get(key)
        for key in ("raw", "source", "explicit_paths", "allowed_patterns")
    ):
        return existing
    attach_scope(state, scope)
    return scope


def path_allowed(path: str, scope: dict[str, Any] | None) -> bool:
    if not scope:
        return False
    value = (path or "").lstrip("./")
    for exact in scope.get("explicit_paths") or []:
        if value == exact.lstrip("./"):
            return True
    for pattern in scope.get("allowed_patterns") or []:
        if fnmatch.fnmatch(value, pattern):
            return True
    return False


def validate_files_against_scope(paths: list[str], scope: dict[str, Any] | None, *, raw_scope: str | None = None) -> dict[str, Any]:
    raw = (scope or {}).get("raw") if scope else raw_scope
    explicit = list((scope or {}).get("explicit_paths") or [])
    patterns = list((scope or {}).get("allowed_patterns") or [])
    if (raw or "").strip() and not explicit and not patterns:
        source = (scope or {}).get("source") or ""
        if str(source).startswith("continuation:"):
            return {
                "ok": False,
                "error": "SCOPE_MATERIALIZATION_ERROR",
                "reason": "SCOPE_MATERIALIZATION_ERROR: SCOPE text exists but no explicit paths or patterns were materialized",
                "unexpected": list(paths),
                "authorized_exact": [],
                "authorized_patterns": [],
                "source": source,
            }
        return {
            "ok": True,
            "unexpected": [],
            "authorized_exact": [],
            "authorized_patterns": [],
            "source": source,
        }
    if not (raw or "").strip() and not explicit and not patterns:
        return {
            "ok": True,
            "unexpected": [],
            "authorized_exact": [],
            "authorized_patterns": [],
            "source": (scope or {}).get("source"),
        }
    unexpected = [path for path in paths if not path_allowed(path, scope)]
    result = {
        "ok": not unexpected,
        "unexpected": unexpected,
        "authorized_exact": explicit,
        "authorized_patterns": patterns,
        "source": (scope or {}).get("source"),
    }
    if unexpected:
        src = result["source"] or "unknown"
        result["reason"] = (
            "scope fence rejected files\n"
            f"unexpected:\n- " + "\n- ".join(unexpected) + "\n"
            f"authorized_exact:\n- " + ("\n- ".join(explicit) or "(none)") + "\n"
            f"authorized_patterns:\n- " + ("\n- ".join(patterns) or "(none)") + "\n"
            f"source: {src}"
        )
    return result
