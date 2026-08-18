from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

from agentbus.util import sha256_text, utc_now


KINDS = (
    "GPT_SPEC",
    "GPT_REVIEW",
    "GPT_MERGE_REVIEW",
    "GPT_CONTINUATION",
    "CODEX_REPORT",
    "CODEX_AUDIT",
    "BLOCKER",
    "FINAL_GATE",
    "HUMAN_NOTE",
)

KIND_ALIASES = {
    "SPEC": "GPT_SPEC",
    "REVIEW": "GPT_REVIEW",
    "MERGE_REVIEW": "GPT_MERGE_REVIEW",
    "CONTINUATION": "GPT_CONTINUATION",
    "REPORT": "CODEX_REPORT",
    "AUDIT": "CODEX_AUDIT",
    "NOTE": "HUMAN_NOTE",
    "GATE": "FINAL_GATE",
}

FIELD_ORDER = {
    "GPT_SPEC": (
        "STATUS",
        "STREAM",
        "JOB_ID",
        "GOAL",
        "TARGET",
        "BASE_HEAD",
        "SCOPE",
        "OUT_OF_SCOPE",
        "ACCEPTANCE_CRITERIA",
        "ARCHITECTURAL_CONSTRAINTS",
        "REQUIRED_VALIDATION",
        "REVIEW_POLICY",
        "PATH_SCOPE",
        "NEXT_ACTION",
    ),
    "GPT_CONTINUATION": (
        "STATUS",
        "CAMPAIGN",
        "JOB_ID",
        "AFTER_STREAM",
        "TRIGGER",
        "NEXT_STREAM",
        "TARGET",
        "BASE_ANCHOR",
        "SCOPE",
        "OUT_OF_SCOPE",
        "ACCEPTANCE_CRITERIA",
        "REVIEW_POLICY",
        "PATH_SCOPE",
        "NEXT_ACTION",
    ),
    "GPT_REVIEW": (
        "STATUS",
        "STREAM",
        "JOB_ID",
        "REVIEWED_HEAD",
        "FINDINGS",
        "ACCEPTANCE",
        "NEXT_ACTION",
    ),
    "GPT_MERGE_REVIEW": (
        "STATUS",
        "STREAM",
        "PR",
        "JOB_ID",
        "REVIEWED_HEAD",
        "REVIEWED_BASE",
        "SUMMARY",
        "EVIDENCE",
        "FINDINGS",
        "RECOMMENDATION",
        "NEXT_ACTION",
    ),
    "CODEX_REPORT": (
        "STATUS",
        "STREAM",
        "IMPLEMENTED_HEAD",
        "CHANGED_FILES",
        "VALIDATION",
        "DEVIATIONS",
        "KNOWN_RISKS",
        "SOURCE_CONTINUATION_COMMENT_ID",
        "NEXT_ACTION",
    ),
    "CODEX_AUDIT": (
        "STATUS",
        "STREAM",
        "AUDITED_HEAD",
        "FINDINGS",
        "RESIDUAL_RISKS",
        "NEXT_ACTION",
    ),
    "BLOCKER": (
        "STATUS",
        "STREAM",
        "HEAD",
        "REASON",
        "EVIDENCE",
        "NEXT_ACTION",
    ),
    "FINAL_GATE": (
        "STATUS",
        "STREAM",
        "REVIEWED_HEAD",
        "FINAL_HEAD",
        "AUTHORIZED_BY",
        "MODE",
        "SOURCE_COMMENT_ID",
        "DECISION",
        "NEXT_ACTION",
    ),
    "HUMAN_NOTE": (
        "STATUS",
        "STREAM",
        "HEAD",
        "COMMAND",
        "REASON",
        "NEXT_ACTION",
    ),
}

HEAD_FIELDS = {
    "GPT_SPEC": "BASE_HEAD",
    "GPT_REVIEW": "REVIEWED_HEAD",
    "GPT_MERGE_REVIEW": "REVIEWED_HEAD",
    "CODEX_REPORT": "IMPLEMENTED_HEAD",
    "CODEX_AUDIT": "AUDITED_HEAD",
    "BLOCKER": "HEAD",
    "FINAL_GATE": "REVIEWED_HEAD",
    "HUMAN_NOTE": "HEAD",
}

KIND_HEADER_RE = re.compile(r"^\[([A-Z][A-Z0-9_]*)\]\s*$")
CLOSING_KIND_HEADER_RE = re.compile(r"^\[/([A-Z][A-Z0-9_]*)\]\s*$")
FIELD_RE = re.compile(r"^([A-Z][A-Z0-9_]*):\s*(.*)$")


@dataclass
class Envelope:
    kind: str
    fields: dict[str, str] = field(default_factory=dict)
    raw: str = ""
    source: str = "local"
    source_id: str = ""
    created_at: str = field(default_factory=utc_now)

    @property
    def status(self) -> str:
        return (self.fields.get("STATUS") or "").strip().upper()

    @property
    def stream(self) -> str:
        return (self.fields.get("STREAM") or "").strip().lower()

    @property
    def next_action(self) -> str:
        return (self.fields.get("NEXT_ACTION") or "").strip().upper()

    @property
    def head(self) -> str | None:
        key = HEAD_FIELDS.get(self.kind)
        if key:
            value = (self.fields.get(key) or "").strip()
            if value:
                return value
        if self.kind == "FINAL_GATE":
            value = (self.fields.get("FINAL_HEAD") or "").strip()
            if value:
                return value
        return None

    @property
    def digest(self) -> str:
        return sha256_text(self.raw or render_envelope(self))

    def get(self, key: str, default: str = "") -> str:
        return self.fields.get(key, default)

    def as_record(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "status": self.status,
            "stream": self.stream,
            "head": self.head,
            "next_action": self.next_action,
            "fields": dict(self.fields),
            "raw": self.raw,
            "source": self.source,
            "source_id": self.source_id,
            "created_at": self.created_at,
            "digest": self.digest,
        }


def normalize_kind(value: str) -> str:
    kind = value.strip().upper().replace("-", "_")
    kind = KIND_ALIASES.get(kind, kind)
    if kind not in KINDS:
        raise ValueError(f"unknown envelope kind: {value}")
    return kind


def _normalize_lines(text: str) -> list[str]:
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _header_kind(line: str) -> str | None:
    match = KIND_HEADER_RE.fullmatch(line.strip())
    if not match:
        return None
    try:
        return normalize_kind(match.group(1))
    except ValueError:
        return None


def _parse_fields_to_eof(lines: list[str], start: int) -> tuple[dict[str, str], int]:
    """Parse fields until EOF or this envelope's optional closing marker.

    A later ordinary ``[KIND]`` line remains body text: GPT discussion often
    quotes other envelopes.  The exact matching ``[/KIND]`` marker is the one
    unambiguous delimiter we accept, so a closing marker cannot become part of
    the preceding field value.
    """
    index = start + 1
    fields: dict[str, str] = {}
    current: str | None = None
    chunks: list[str] = []
    in_fence = False
    kind = _header_kind(lines[start])
    while index < len(lines):
        raw_line = lines[index]
        if raw_line.strip().startswith("```"):
            in_fence = not in_fence
            if current is not None:
                chunks.append(raw_line)
            index += 1
            continue
        if in_fence:
            if current is not None:
                chunks.append(raw_line)
            index += 1
            continue
        closing = CLOSING_KIND_HEADER_RE.fullmatch(raw_line.strip())
        if closing and kind and closing.group(1) == kind:
            index += 1
            break
        field_match = FIELD_RE.match(raw_line)
        if field_match:
            if current is not None:
                fields[current] = _join_field(chunks)
            current = field_match.group(1)
            first = field_match.group(2)
            chunks = [first] if first != "" else []
        elif current is not None:
            chunks.append(raw_line)
        index += 1
    if current is not None:
        fields[current] = _join_field(chunks)
    return fields, index


def _envelope_at(lines: list[str], start: int) -> Envelope:
    kind = _header_kind(lines[start])
    if not kind:
        raise ValueError("not an envelope header")
    fields, end = _parse_fields_to_eof(lines, start)
    raw = "\n".join(lines[start:end]).strip() + "\n"
    return Envelope(kind=kind, fields=fields, raw=raw)


def parse_envelopes(text: str, *, leading_header: bool = False) -> list[Envelope]:
    """Parse at most one envelope.

    Classification uses a header line only. After that header, later
    ``[GPT_REVIEW]`` / ``[CODEX_AUDIT]`` markers in prose are body text.

    If ``leading_header`` is true (GitHub comments), the first non-empty
    line must be the header. Otherwise the first recognized header is used
    so Codex last-message preambles still work.
    """
    lines = _normalize_lines(text)
    if leading_header:
        index = 0
        while index < len(lines) and not lines[index].strip():
            index += 1
        if index >= len(lines) or _header_kind(lines[index]) is None:
            return []
        return [_envelope_at(lines, index)]
    for index, line in enumerate(lines):
        if _header_kind(line) is not None:
            return [_envelope_at(lines, index)]
    return []


def parse_comment_envelope(text: str) -> Envelope | None:
    found = parse_envelopes(text, leading_header=True)
    return found[0] if found else None


def parse_one(text: str) -> Envelope:
    envelopes = parse_envelopes(text)
    if not envelopes:
        raise ValueError("no recognized [KIND] envelope found")
    return envelopes[0]


def _join_field(chunks: Iterable[str]) -> str:
    return "\n".join(chunks).strip()


def render_envelope(envelope: Envelope) -> str:
    lines = [f"[{envelope.kind}]", ""]
    seen: set[str] = set()
    for key in FIELD_ORDER.get(envelope.kind, ()):
        if key in envelope.fields:
            lines.extend(_render_field(key, envelope.fields[key]))
            seen.add(key)
    for key, value in envelope.fields.items():
        if key not in seen:
            lines.extend(_render_field(key, value))
    text = "\n".join(lines).rstrip() + "\n"
    return text


def _render_field(key: str, value: str) -> list[str]:
    value = (value or "").strip()
    if "\n" in value:
        return [f"{key}:", value, ""]
    return [f"{key}: {value}", ""]


def required_fields(kind: str) -> tuple[str, ...]:
    if kind == "GPT_SPEC":
        return ("STATUS", "STREAM", "BASE_HEAD", "SCOPE", "ACCEPTANCE_CRITERIA")
    if kind == "GPT_CONTINUATION":
        return ("STATUS", "CAMPAIGN", "AFTER_STREAM", "NEXT_STREAM", "TRIGGER")
    if kind == "GPT_REVIEW":
        return ("STATUS", "STREAM", "REVIEWED_HEAD")
    if kind == "GPT_MERGE_REVIEW":
        return (
            "STATUS",
            "STREAM",
            "PR",
            "REVIEWED_HEAD",
            "REVIEWED_BASE",
            "SUMMARY",
            "FINDINGS",
        )
    if kind == "CODEX_REPORT":
        return ("STATUS", "STREAM", "IMPLEMENTED_HEAD")
    if kind == "CODEX_AUDIT":
        return ("STATUS", "STREAM", "AUDITED_HEAD", "STATUS")
    if kind == "BLOCKER":
        return ("STATUS", "STREAM", "REASON")
    if kind == "FINAL_GATE":
        return ("STATUS", "STREAM")
    if kind == "HUMAN_NOTE":
        return ("STATUS", "STREAM")
    return ("STATUS", "STREAM")


def validate_envelope(
    envelope: Envelope,
    *,
    expected_stream: str | None = None,
    aliases: list[str] | None = None,
) -> list[str]:
    errors: list[str] = []
    for key in required_fields(envelope.kind):
        if not (envelope.fields.get(key) or "").strip():
            errors.append(f"missing {key}")
    if envelope.kind == "GPT_MERGE_REVIEW":
        status = envelope.status
        preferred = {"PASS", "REPAIR", "WAIT", "HUMAN"}
        legacy = {"HOLD", "HUMAN_DECISION"}
        if status not in preferred | legacy:
            errors.append(
                "GPT_MERGE_REVIEW STATUS must be PASS, REPAIR, WAIT, HUMAN "
                "(legacy HOLD/HUMAN_DECISION accepted)"
            )
        if not (envelope.fields.get("REVIEWED_HEAD") or "").strip():
            errors.append("missing REVIEWED_HEAD")
        recommendation = (envelope.fields.get("RECOMMENDATION") or "").strip().upper()
        next_action = (envelope.fields.get("NEXT_ACTION") or "").strip().upper()
        # Compatibility: validate the redundant old combination only when an
        # old producer actually emits those fields. New jobs omit both.
        if status == "PASS" and (recommendation or next_action):
            if recommendation != "MERGE":
                errors.append("GPT_MERGE_REVIEW PASS requires RECOMMENDATION: MERGE")
            if next_action != "HUMAN_MERGE":
                errors.append("GPT_MERGE_REVIEW PASS requires NEXT_ACTION: HUMAN_MERGE")
        elif status == "HOLD" and recommendation != "DO_NOT_MERGE":
            errors.append("GPT_MERGE_REVIEW HOLD requires RECOMMENDATION: DO_NOT_MERGE")
    if envelope.kind == "FINAL_GATE":
        if not (envelope.fields.get("REVIEWED_HEAD") or envelope.fields.get("FINAL_HEAD") or "").strip():
            errors.append("missing REVIEWED_HEAD or FINAL_HEAD")
    if envelope.kind == "GPT_CONTINUATION" and envelope.status == "ACTIONABLE":
        for key in ("TARGET", "SCOPE", "ACCEPTANCE_CRITERIA"):
            if not (envelope.fields.get(key) or "").strip():
                errors.append(f"missing {key}")
    if expected_stream and envelope.stream:
        from agentbus.streamid import accepted_ids

        allowed = accepted_ids({"stream_id": expected_stream, "aliases": list(aliases or [])})
        if envelope.stream not in allowed:
            errors.append(f"stream mismatch: envelope={envelope.stream} expected={expected_stream}")
    return errors


def extract_first_envelope(text: str, kinds: tuple[str, ...] | None = None) -> Envelope | None:
    for envelope in parse_envelopes(text):
        if kinds is None or envelope.kind in kinds:
            return envelope
    return None
