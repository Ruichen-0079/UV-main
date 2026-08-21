"""v2-owned transport compatibility for the signed AgentBus v1 browser client.

The legacy extension only sends prompts.  This module projects fresh v2 GPT
pending facts into its wire format and treats one configured GitHub issue as an
operational response mailbox.  GitHub comments never enter :class:`Snapshot`;
only the existing strict ``submit_gpt_response`` path creates durable semantic
facts.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Iterable, Mapping

from .effects import submit_gpt_response
from .facts import (
    FactError,
    PPaths,
    _run,
    canonical_repository,
    load_config,
    load_gpt_packet,
    paths_for,
    read_snapshot,
    sha256_text,
)
from .scheduler import ProjectEntry, load_registry


CONFIG_FILE = "legacy_v1_browser_compat.json"
TRANSPORT_MODE = "SIGNED_V1_EXTENSION_COMPAT"
ONLINE_WINDOW_SECONDS = 35.0
MAX_MAILBOX_COMMENTS = 100
MAX_COMMENT_BYTES = 1_000_000
ENVELOPE_START = "[AGENTBUS_V2_GPT_TRANSPORT]"
ENVELOPE_END = "[/AGENTBUS_V2_GPT_TRANSPORT]"
ROLE_TASK = {
    "PLAN_GPT": ("PRODUCT_GPT", "PLAN_SPEC"),
    "JUDGE_GPT": ("FINAL_GPT", "FINAL_REVIEW"),
}
_JOB_HEADER_RE = re.compile(r"(?m)^JOB_ID: ([A-Za-z0-9_.:-]+)$")


class LegacyCompatError(RuntimeError):
    """An operational compatibility failure, never a semantic decision."""


@dataclass(frozen=True)
class LegacyCompatConfig:
    enabled: bool
    conversations: Mapping[str, str]
    mailboxes: Mapping[str, int]


@dataclass(frozen=True)
class MailboxComment:
    comment_id: str
    body: str


@dataclass(frozen=True)
class TransportEnvelope:
    job_id: str
    operation: str
    packet_sha256: str
    raw_response_json: str


@dataclass(frozen=True)
class CurrentJob:
    p_id: str
    allow_merge: bool
    paths: PPaths
    repository: str
    job_id: str
    operation: str
    packet_text: str
    packet_sha256: str
    conversation_url: str
    head: str
    base: str
    mailbox_issue: int

    def wire_dict(self) -> dict[str, object]:
        role, task = ROLE_TASK[self.operation]
        return {
            "job_id": self.job_id,
            "role": role,
            "task": task,
            "conversation_url": self.conversation_url,
            # Harmless v1 compatibility fields.  They are transport labels,
            # never imported into the v2 core or durable facts.
            "campaign": "agentbus-v2",
            "stream": self.p_id,
            "pr": None,
            "expected_head": self.head,
            "expected_base": self.base,
            "generation": self.job_id,
            "prompt": render_transport_prompt(self),
        }


@dataclass(frozen=True)
class IngestionOutcome:
    p_id: str
    job_id: str
    changed: bool
    detail: str


CommentReader = Callable[[str, int, int], tuple[MailboxComment, ...]]


def config_path(state_root: Path) -> Path:
    return Path(state_root).resolve() / CONFIG_FILE


def _conversation_url(value: object, name: str) -> str:
    if type(value) is not str or not value.strip():
        raise TypeError(f"{name} conversation URL must be a non-empty string")
    from .browser_transport import canonical_conversation_url

    try:
        return canonical_conversation_url(value)
    except RuntimeError as error:
        raise TypeError(str(error)) from error


def load_compat_config(state_root: Path, path: Path | None = None) -> LegacyCompatConfig:
    source = Path(path).resolve() if path is not None else config_path(state_root)
    if not source.exists():
        return LegacyCompatConfig(False, {}, {})
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or set(value) != {"enabled", "conversations", "mailboxes"}:
            raise TypeError("keys must be exactly enabled, conversations, mailboxes")
        if type(value["enabled"]) is not bool:
            raise TypeError("enabled must be boolean")
        raw_conversations = value["conversations"]
        if not isinstance(raw_conversations, dict) or set(raw_conversations) != {"plan", "judge"}:
            raise TypeError("conversations must contain exactly plan and judge")
        conversations = {
            name: _conversation_url(raw_conversations[name], name)
            for name in ("plan", "judge")
        }
        if len(set(conversations.values())) != 2:
            raise TypeError("PLAN and JUDGE conversations must be distinct")
        raw_mailboxes = value["mailboxes"]
        if not isinstance(raw_mailboxes, dict) or not raw_mailboxes:
            raise TypeError("mailboxes must be a non-empty repository-to-issue object")
        mailboxes: dict[str, int] = {}
        for repository, issue in raw_mailboxes.items():
            canonical = canonical_repository(str(repository))
            if not canonical.startswith("github.com/") or canonical.count("/") != 2:
                raise TypeError(f"mailbox repository must be GitHub: {repository!r}")
            if type(issue) is not int or issue <= 0:
                raise TypeError(f"mailbox issue must be a positive integer: {repository!r}")
            if canonical in mailboxes:
                raise TypeError(f"duplicate canonical mailbox repository: {canonical}")
            mailboxes[canonical] = issue
        return LegacyCompatConfig(value["enabled"], conversations, mailboxes)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise FactError(f"invalid legacy browser compatibility config {source}: {error}") from error


def render_transport_prompt(job: CurrentJob) -> str:
    slug = job.repository.removeprefix("github.com/")
    mailbox_url = f"https://github.com/{slug}/issues/{job.mailbox_issue}"
    return (
        job.packet_text.rstrip()
        + "\n\n## SIGNED V1 EXTENSION TRANSPORT WRAPPER (OPERATIONAL ONLY)\n\n"
        + "After making the decision required by the packet, publish exactly one "
        + f"comment on {mailbox_url}. Do not publish anywhere else. The comment must "
        + "contain exactly one envelope in this form:\n\n"
        + f"{ENVELOPE_START}\n"
        + f"JOB_ID: {job.job_id}\n"
        + f"OPERATION: {job.operation}\n"
        + f"PACKET_SHA256: {job.packet_sha256}\n"
        + "RAW_RESPONSE_JSON:\n"
        + '{"job_id":"'
        + job.job_id
        + '","operation":"'
        + job.operation
        + '","decision":"<one packet-allowed decision>","body":"<complete JSON-escaped body>"}\n'
        + f"{ENVELOPE_END}\n\n"
        + "RAW_RESPONSE_JSON must be one valid JSON object matching the packet's strict "
        + "response schema, with no Markdown, prose, repair, or transformation. Repeat "
        + "JOB_ID, OPERATION, and PACKET_SHA256 verbatim. A chat reply alone does not "
        + "complete transport. Do not modify code and do not merge.\n"
    )


def parse_transport_envelope(body: str) -> TransportEnvelope | None:
    if not isinstance(body, str):
        return None
    if len(body.encode("utf-8")) > MAX_COMMENT_BYTES:
        raise LegacyCompatError("mailbox comment exceeds the bounded transport size")
    starts = body.count(ENVELOPE_START)
    ends = body.count(ENVELOPE_END)
    if starts == 0 and ends == 0:
        return None
    if starts != 1 or ends != 1:
        raise LegacyCompatError("mailbox comment must contain exactly one transport envelope")
    prefix, remainder = body.split(ENVELOPE_START, 1)
    block, suffix = remainder.split(ENVELOPE_END, 1)
    if prefix.strip() or suffix.strip():
        raise LegacyCompatError("transport envelope comment contains out-of-envelope text")
    if not block.startswith("\n"):
        raise LegacyCompatError("transport envelope must begin on its own line")
    block = block[1:]
    marker = "\nRAW_RESPONSE_JSON:"
    if marker not in block:
        raise LegacyCompatError("transport envelope lacks RAW_RESPONSE_JSON boundary")
    header_text, framed_raw = block.split(marker, 1)
    header_lines = header_text.splitlines()
    if len(header_lines) != 3:
        raise LegacyCompatError("transport envelope must contain exactly three identity headers")
    expected = ("JOB_ID: ", "OPERATION: ", "PACKET_SHA256: ")
    values: list[str] = []
    for line, prefix_text in zip(header_lines, expected, strict=True):
        if not line.startswith(prefix_text) or not line.removeprefix(prefix_text):
            raise LegacyCompatError("transport envelope identity headers are malformed")
        values.append(line.removeprefix(prefix_text))
    # GitHub transport has produced both exact machine-readable framings in
    # practice: a JSON value on the next line, and one ASCII space followed by
    # the JSON value on the header line.  Selecting either delimiter does not
    # parse, repair, normalize, or rewrite the raw response itself.
    if framed_raw.startswith("\n"):
        raw = framed_raw[1:]
    elif framed_raw.startswith(" ") and not framed_raw.startswith("  "):
        raw = framed_raw[1:]
    else:
        raise LegacyCompatError("RAW_RESPONSE_JSON requires one exact transport delimiter")
    if not raw.endswith("\n"):
        raise LegacyCompatError("RAW_RESPONSE_JSON must end before the closing marker")
    raw = raw[:-1]
    if not raw or "\x00" in raw:
        raise LegacyCompatError("RAW_RESPONSE_JSON is empty or invalid")
    return TransportEnvelope(values[0], values[1], values[2], raw)


def _comment_mentions_job(body: str, job_id: str) -> bool:
    return any(match.group(1) == job_id for match in _JOB_HEADER_RE.finditer(body))


def _github_comments(repository: str, issue: int, limit: int) -> tuple[MailboxComment, ...]:
    slug = repository.removeprefix("github.com/")
    owner, name = slug.split("/", 1)
    query = (
        "query($owner:String!,$name:String!,$number:Int!,$last:Int!){"
        "repository(owner:$owner,name:$name){issue(number:$number){comments(last:$last){"
        "nodes{databaseId body}}}}}"
    )
    completed = _run(
        (
            "gh", "api", "graphql", "-f", f"query={query}",
            "-F", f"owner={owner}", "-F", f"name={name}",
            "-F", f"number={issue}", "-F", f"last={limit}",
        ),
        check=False,
        timeout=60,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or "GitHub mailbox query failed"
        raise LegacyCompatError(detail[:300])
    try:
        value = json.loads(completed.stdout)
        nodes = value["data"]["repository"]["issue"]["comments"]["nodes"]
        if not isinstance(nodes, list):
            raise TypeError
        comments = tuple(
            MailboxComment(str(item["databaseId"]), str(item["body"]))
            for item in nodes
            if isinstance(item, dict) and item.get("databaseId") is not None
            and isinstance(item.get("body"), str)
        )
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise LegacyCompatError("GitHub mailbox returned an invalid response") from error
    return comments


class LegacyV1BrowserCompat:
    """Memoryless semantic projection with memory-only operational telemetry."""

    def __init__(
        self,
        state_root: Path,
        *,
        registry_path: Path | None = None,
        config_file: Path | None = None,
        comment_reader: CommentReader | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.state_root = Path(state_root).resolve()
        self.registry_file = (
            Path(registry_path).resolve()
            if registry_path is not None
            else self.state_root / "projects.json"
        )
        self.config_file = Path(config_file).resolve() if config_file else None
        self.comment_reader = comment_reader or _github_comments
        self.clock = clock
        self._poll_lock = threading.Lock()
        self._telemetry_lock = threading.Lock()
        self._last_poll: float | None = None
        self._last_error: str | None = None
        self._mailbox_available: bool | None = None
        self._served_jobs: set[str] = set()
        self._outcomes: tuple[IngestionOutcome, ...] = ()

    def _config(self) -> LegacyCompatConfig:
        return load_compat_config(self.state_root, self.config_file)

    def _entries(self) -> tuple[ProjectEntry, ...]:
        return load_registry(self.state_root, self.registry_file).enabled

    def _current_job(self, entry: ProjectEntry, config: LegacyCompatConfig) -> CurrentJob | None:
        paths = paths_for(self.state_root, entry.p_id)
        p_config = load_config(paths)
        snapshot = read_snapshot(paths, allow_merge=entry.allow_merge)
        if len(snapshot.gpt_pending) != 1:
            return None
        job_id = next(iter(snapshot.gpt_pending))
        result = paths.root / "gpt" / "results" / f"{job_id}.json"
        if result.exists():
            return None
        packet_path = paths.root / "gpt" / "outbox" / f"{job_id}.md"
        packet_text = packet_path.read_text(encoding="utf-8")
        packet = load_gpt_packet(paths, job_id)
        operation = str(packet["operation"])
        if operation not in ROLE_TASK:
            raise FactError(f"unsupported current GPT operation: {operation!r}")
        lane = "plan" if operation == "PLAN_GPT" else "judge"
        issue = config.mailboxes.get(p_config.repository)
        if issue is None:
            raise LegacyCompatError(f"mailbox is not configured for {p_config.repository}")
        return CurrentJob(
            entry.p_id,
            entry.allow_merge,
            paths,
            p_config.repository,
            job_id,
            operation,
            packet_text,
            sha256_text(packet_text),
            config.conversations[lane],
            snapshot.head,
            snapshot.base,
            issue,
        )

    def current_jobs(self) -> tuple[CurrentJob, ...]:
        config = self._config()
        if not config.enabled:
            return ()
        jobs: list[CurrentJob] = []
        errors: list[str] = []
        for entry in self._entries():
            try:
                job = self._current_job(entry, config)
                if job is not None:
                    jobs.append(job)
            except (FactError, LegacyCompatError, OSError) as error:
                errors.append(f"{entry.p_id}: {error}")
        if errors:
            with self._telemetry_lock:
                self._last_error = "; ".join(errors)[:1000]
        return tuple(sorted(jobs, key=lambda item: (item.operation, item.p_id, item.job_id)))

    @staticmethod
    def _matching_envelopes(
        job: CurrentJob, comments: Iterable[MailboxComment]
    ) -> tuple[tuple[MailboxComment, TransportEnvelope], ...]:
        matches: list[tuple[MailboxComment, TransportEnvelope]] = []
        for comment in comments:
            if not _comment_mentions_job(comment.body, job.job_id):
                continue
            envelope = parse_transport_envelope(comment.body)
            if envelope is None:
                continue
            if (
                envelope.job_id == job.job_id
                and envelope.operation == job.operation
                and envelope.packet_sha256 == job.packet_sha256
            ):
                matches.append((comment, envelope))
        return tuple(matches)

    def _still_current(self, job: CurrentJob, config: LegacyCompatConfig) -> bool:
        entry = next((item for item in self._entries() if item.p_id == job.p_id), None)
        if entry is None or entry.allow_merge != job.allow_merge:
            return False
        current = self._current_job(entry, config)
        return bool(
            current is not None
            and current.job_id == job.job_id
            and current.operation == job.operation
            and current.packet_sha256 == job.packet_sha256
            and current.repository == job.repository
            and current.mailbox_issue == job.mailbox_issue
        )

    def _ingest(self, job: CurrentJob, envelope: TransportEnvelope) -> IngestionOutcome:
        lock_path = job.paths.root / "tick.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+") as handle:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return IngestionOutcome(job.p_id, job.job_id, False, "P tick lock is busy")
            config = self._config()
            if not config.enabled or not self._still_current(job, config):
                return IngestionOutcome(job.p_id, job.job_id, False, "GPT job is no longer exact current pending")
            fd, name = tempfile.mkstemp(
                prefix=".legacy-mailbox-", suffix=".json", dir=job.paths.root
            )
            temporary = Path(name)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    stream.write(envelope.raw_response_json)
                    stream.flush()
                result = submit_gpt_response(job.paths, temporary)
            finally:
                temporary.unlink(missing_ok=True)
            return IngestionOutcome(job.p_id, job.job_id, result.changed, result.detail)

    def _poll_mailboxes(self, jobs: tuple[CurrentJob, ...]) -> tuple[IngestionOutcome, ...]:
        grouped: dict[tuple[str, int], list[CurrentJob]] = {}
        for job in jobs:
            grouped.setdefault((job.repository, job.mailbox_issue), []).append(job)
        outcomes: list[IngestionOutcome] = []
        any_available = False
        for (repository, issue), mailbox_jobs in grouped.items():
            comments = self.comment_reader(repository, issue, MAX_MAILBOX_COMMENTS)
            any_available = True
            for job in mailbox_jobs:
                matches = self._matching_envelopes(job, comments)
                if len(matches) > 1:
                    raise LegacyCompatError(f"ambiguous duplicate mailbox results for {job.job_id}")
                if len(matches) == 1:
                    outcomes.append(self._ingest(job, matches[0][1]))
        if grouped:
            with self._telemetry_lock:
                self._mailbox_available = any_available
        return tuple(outcomes)

    def poll_and_project(self) -> dict[str, object]:
        """Handle one extension poll, serializing mailbox ingestion in-process."""
        with self._poll_lock:
            timestamp = self.clock()
            with self._telemetry_lock:
                self._last_poll = timestamp
                self._last_error = None
            jobs: tuple[CurrentJob, ...] = ()
            try:
                jobs = self.current_jobs()
                outcomes = self._poll_mailboxes(jobs)
                # A strict result may have appeared; only a fresh durable reread
                # decides which jobs remain visible to the extension.
                jobs = self.current_jobs()
                with self._telemetry_lock:
                    self._outcomes = outcomes
                    current_ids = {item.job_id for item in jobs}
                    self._served_jobs.intersection_update(current_ids)
                    self._served_jobs.update(item.job_id for item in jobs)
            except (FactError, LegacyCompatError, OSError) as error:
                with self._telemetry_lock:
                    self._last_error = str(error)[:1000]
                    self._mailbox_available = False
            return {
                "jobs": [job.wire_dict() for job in jobs],
                "bridge": self.status(),
            }

    def status(self) -> dict[str, object]:
        try:
            config = self._config()
            configured = config.enabled and bool(config.mailboxes)
            jobs = self.current_jobs() if config.enabled else ()
            config_error = None
        except (FactError, LegacyCompatError, OSError) as error:
            config = LegacyCompatConfig(False, {}, {})
            configured = False
            jobs = ()
            config_error = str(error)
        with self._telemetry_lock:
            last_poll = self._last_poll
            last_error = config_error or self._last_error
            mailbox_available = self._mailbox_available
            served = set(self._served_jobs)
            outcomes = self._outcomes
        online = bool(last_poll is not None and self.clock() - last_poll <= ONLINE_WINDOW_SECONDS)
        lane_rows: dict[str, dict[str, object]] = {}
        for lane, operation in (("plan", "PLAN_GPT"), ("judge", "JUDGE_GPT")):
            lane_jobs = [job for job in jobs if job.operation == operation]
            state = "idle"
            if lane_jobs:
                state = (
                    "waiting-mailbox"
                    if any(job.job_id in served for job in lane_jobs)
                    else "pending"
                )
            lane_rows[lane] = {"state": state, "pending": len(lane_jobs)}
        return {
            "legacy_v1_extension": "ONLINE" if online else "OFFLINE",
            "last_poll": (
                datetime.fromtimestamp(last_poll, timezone.utc).isoformat()
                if last_poll is not None
                else None
            ),
            "transport_mode": TRANSPORT_MODE,
            "configured": configured,
            "mailbox": (
                "available" if mailbox_available is True
                else "unavailable" if mailbox_available is False
                else "configured" if configured
                else "unconfigured"
            ),
            "plan": lane_rows["plan"],
            "judge": lane_rows["judge"],
            "last_error": last_error,
            "recent_ingestion": [
                {
                    "p_id": item.p_id,
                    "job_id": item.job_id,
                    "changed": item.changed,
                    "detail": item.detail,
                }
                for item in outcomes
            ],
        }
