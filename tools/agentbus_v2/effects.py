from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Sequence

from .core import (
    Action,
    ActionKind,
    GPT_PACKET_SCHEMA,
    PROOF_SCHEMA,
    Observation,
    Snapshot,
    SpecFact,
    decide,
    plan_facts_digest,
    stable_id,
)
from .facts import (
    FactError,
    GPT_JOB_RE,
    PConfig,
    PPaths,
    _load_json,
    _run,
    _work_from_head,
    git,
    load_charter,
    load_gpt_packet,
    load_config,
    parse_gpt_response,
    _proof_commands,
    read_snapshot,
    sha256_text,
    write_json_once,
    write_text_once,
)
from .codex_guardian import GUARDIAN_ERROR, run_guardian
from .github import (
    ensure_owned_pr,
    merge_pr,
    observe_required_checks,
    read_github_facts,
)


@dataclass(frozen=True)
class EffectResult:
    changed: bool
    detail: str


# This is the hard byte budget for the complete prompt sent through a GPT
# transport adapter, including the signed-v1 operational wrapper.  The
# renderer reserves a small deterministic amount for that wrapper.
GPT_PACKET_BUDGET_BYTES = 120 * 1024
GPT_TRANSPORT_WRAPPER_RESERVE_BYTES = 4096
GPT_RENDER_BUDGET_BYTES = GPT_PACKET_BUDGET_BYTES - GPT_TRANSPORT_WRAPPER_RESERVE_BYTES
GPT_PACKET_OVERSIZE = "GPT_PACKET_OVERSIZE"
_MAX_CHANGED_FILE_MANIFEST_BYTES = 12_000
_MAX_DIFF_EVIDENCE_BYTES = 64_000
_EVIDENCE_START = "## BOUNDED CURRENT EVIDENCE"
_EVIDENCE_END = "## REPOSITORY RE-READ REQUIREMENT"


class GPTPacketOversizeError(FactError):
    """A GPT packet is not eligible for browser transport."""

    def __init__(
        self,
        message: str,
        *,
        job_id: str | None = None,
        operation: str | None = None,
        rendered_bytes: int | None = None,
        budget_bytes: int = GPT_PACKET_BUDGET_BYTES,
        evidence_bytes: int | None = None,
        evidence_truncated: bool | None = None,
    ) -> None:
        super().__init__(f"{GPT_PACKET_OVERSIZE}: {message}")
        self.job_id = job_id
        self.operation = operation
        self.rendered_bytes = rendered_bytes
        self.budget_bytes = budget_bytes
        self.evidence_bytes = evidence_bytes
        self.evidence_truncated = evidence_truncated


def packet_telemetry(packet_text: str) -> dict[str, object]:
    """Return bounded operational size facts for an already-rendered packet."""
    rendered = len(packet_text.encode("utf-8"))
    evidence_bytes = 0
    start = packet_text.find(_EVIDENCE_START)
    end = packet_text.find(_EVIDENCE_END, start + len(_EVIDENCE_START)) if start >= 0 else -1
    if start >= 0:
        evidence = packet_text[start:end if end >= 0 else len(packet_text)]
        evidence_bytes = len(evidence.encode("utf-8"))
    return {
        "rendered_packet_bytes": rendered,
        "packet_budget_bytes": GPT_PACKET_BUDGET_BYTES,
        "evidence_bytes": evidence_bytes,
        "evidence_truncated": "EVIDENCE_TRUNCATED: true" in packet_text,
    }


def assert_gpt_packet_budget(
    packet_text: str,
    *,
    job_id: str | None = None,
    operation: str | None = None,
    budget_bytes: int = GPT_PACKET_BUDGET_BYTES,
) -> dict[str, object]:
    telemetry = packet_telemetry(packet_text)
    rendered = int(telemetry["rendered_packet_bytes"])
    if rendered > budget_bytes:
        raise GPTPacketOversizeError(
            f"rendered packet is {rendered} bytes; budget is {budget_bytes} bytes",
            job_id=job_id,
            operation=operation,
            rendered_bytes=rendered,
            budget_bytes=budget_bytes,
            evidence_bytes=int(telemetry["evidence_bytes"]),
            evidence_truncated=bool(telemetry["evidence_truncated"]),
        )
    return telemetry


def _spec(snapshot: Snapshot, spec_id: str | None) -> SpecFact | None:
    return next((item for item in snapshot.specs if item.spec_id == spec_id), None)


def _evidence_text(paths: PPaths, evidence_id: str) -> str:
    candidates = [
        paths.root / "work" / "results" / f"{evidence_id}.json",
        paths.root / "prove" / "results" / f"{evidence_id}.json",
        paths.root / "work" / "logs" / f"{evidence_id}.response.json",
        paths.root / "work" / "logs" / f"{evidence_id}.codex.log",
    ]
    pieces: list[str] = []
    for path in candidates:
        if not path.exists():
            continue
        value = path.read_text(encoding="utf-8", errors="replace")
        marker = f"\n[full SHA-256 {sha256_text(value)}]" if len(value) > 65536 else ""
        pieces.append(f"FILE: {path.name}\n{value[-65536:].rstrip()}{marker}")
    return "\n\n".join(pieces) or "No additional evidence payload was found."


_TOKEN_STOPWORDS = frozenset({
    "agentbus", "current", "exact", "must", "only", "preserve", "return",
    "this", "that", "with", "from", "when", "into", "should", "have",
    "will", "then", "also", "before", "after", "under", "without",
})


def _evidence_keywords(*values: str) -> tuple[str, ...]:
    tokens: set[str] = set()
    for value in values:
        for token in re.findall(r"[A-Za-z][A-Za-z0-9_./-]{3,}", value or ""):
            lowered = token.lower().strip("./-")
            if lowered and lowered not in _TOKEN_STOPWORDS:
                tokens.add(lowered)
    return tuple(sorted(tokens))


def _bounded_lines(text: str, budget_bytes: int) -> tuple[str, bool]:
    """Keep complete UTF-8 lines and add an explicit deterministic marker."""
    marker = "... [EVIDENCE_TRUNCATED]\n"
    if budget_bytes <= 0:
        return marker.rstrip(), True
    lines = text.splitlines()
    if not lines:
        return "", False
    selected: list[str] = []
    used = 0
    for line in lines:
        encoded = (line + "\n").encode("utf-8")
        marker_bytes = marker.encode("utf-8")
        if used + len(encoded) + len(marker_bytes) > budget_bytes:
            return "".join(selected) + marker.rstrip(), True
        selected.append(line + "\n")
        used += len(encoded)
    return "".join(selected).rstrip(), False


def _changed_file_manifest(worktree: Path, base: str, head: str) -> tuple[str, int, bool]:
    raw = git(worktree, "diff", "--no-ext-diff", "--no-color", "--name-only", f"{base}...{head}")
    files = sorted({line.strip() for line in raw.splitlines() if line.strip()})
    total = len(files)
    lines = [f"total_changed_files: {total}"]
    if not files:
        lines.append("- (none)")
        return "\n".join(lines), total, False
    candidate = [f"- {item}" for item in files]
    rendered = "\n".join(lines + candidate)
    if len(rendered.encode("utf-8")) <= _MAX_CHANGED_FILE_MANIFEST_BYTES:
        return rendered, total, False
    # Preserve a deterministic first/last window and never cut a path.  The
    # final line-boundary guard handles unusually long repository paths.
    keep_each = max(1, (_MAX_CHANGED_FILE_MANIFEST_BYTES // 2) // 80)
    window = candidate[:keep_each] + [f"- ... manifest truncated ({total} files) ..."]
    window.extend(candidate[-keep_each:])
    bounded, _ = _bounded_lines(
        "\n".join(lines + window), _MAX_CHANGED_FILE_MANIFEST_BYTES
    )
    return bounded, total, True


def _bounded_repository_evidence(
    worktree: Path,
    base: str,
    head: str,
    keywords: tuple[str, ...],
    budget_bytes: int,
    supplemental: str = "",
) -> tuple[str, bool, int, str, int, bool]:
    """Render deterministic changed-file and keyword-selected diff evidence."""
    manifest, file_count, manifest_truncated = _changed_file_manifest(worktree, base, head)
    diffstat = git(
        worktree, "diff", "--no-ext-diff", "--no-color", "--stat", f"{base}...{head}"
    ).strip() or "(no diffstat)"
    diffstat, diffstat_truncated = _bounded_lines(diffstat, 6000)
    raw_diff = git(worktree, "diff", "--no-ext-diff", "--no-color", f"{base}...{head}")
    chunks = raw_diff.split("\ndiff --git ") if raw_diff else []
    if raw_diff.startswith("diff --git "):
        chunks = [chunks[0]] + ["diff --git " + item for item in chunks[1:]] if chunks else []
    selected: list[str] = []
    if supplemental:
        selected.append(f"# bounded_runtime_evidence\n{supplemental.strip()}")
    for index, chunk in enumerate(chunks):
        lowered = chunk.lower()
        path_match = any(keyword in lowered.split("\n", 1)[0] for keyword in keywords)
        content_match = any(keyword in lowered for keyword in keywords)
        if path_match or content_match:
            selected.append(f"# selected_hunk: {index}\n{chunk.strip()}")
    if not selected:
        selected = ["No keyword-matching diff hunk was selected; re-read the exact repository state."]
    selected_text = "\n\n".join(selected)
    selected_text, evidence_truncated = _bounded_lines(
        selected_text, min(max(0, budget_bytes), _MAX_DIFF_EVIDENCE_BYTES)
    )
    evidence_truncated = evidence_truncated or manifest_truncated or diffstat_truncated
    metadata = (
        f"changed_file_count: {file_count}\n"
        f"manifest_truncated: {str(manifest_truncated).lower()}\n"
        f"evidence_keywords: {', '.join(keywords) if keywords else '(none)'}\n"
        f"diffstat:\n{diffstat}\n"
        f"changed_files:\n{manifest}\n"
        f"evidence_truncated: {str(evidence_truncated).lower()}\n"
        f"selected_hunks:\n{selected_text}"
    )
    metadata, metadata_truncated = _bounded_lines(metadata, max(0, budget_bytes))
    evidence_truncated = evidence_truncated or metadata_truncated
    return metadata, evidence_truncated, len(metadata.encode("utf-8")), diffstat, file_count, manifest_truncated


def _render_gpt_packet(
    *,
    action: Action,
    operation: str,
    config: PConfig,
    semantic: dict[str, Any],
    charter: str,
    directive_block: str,
    spec_block: str,
    prior: str,
    repository_evidence: str,
    evidence_truncated: bool,
) -> str:
    allowed = " | ".join(sorted(
        {"SPEC", "WAIT", "HUMAN"} if operation == "PLAN_GPT"
        else {"PASS", "RETURN_PLAN", "RETURN_WORK", "RETURN_PROVE", "WAIT", "HUMAN"}
    ))
    schema = (f'{{"job_id":"{action.effect_id}","operation":"{operation}",'
              f'"decision":"{allowed}","body":"string"}}')
    return f"""# AGENTBUS V2 SELF-CONTAINED GPT PACKET

JOB_ID: {action.effect_id}
OPERATION: {operation}
P_ID: {config.p_id}

## SEMANTIC INPUTS
```json
{json.dumps({"packet_schema": GPT_PACKET_SCHEMA, "job_id": action.effect_id, "operation": operation, "semantic_input": semantic}, sort_keys=True, separators=(",", ":"))}
```

## P_CHARTER (immutable)

{charter.rstrip()}

## OPERATOR_DIRECTIVE (binding human planning authority)

{directive_block}

If an operator directive is present, respect it unless it conflicts with the
immutable P_CHARTER or repository facts. If the bounded strategy cannot be
implemented correctly, return HUMAN rather than silently expanding scope.

## CURRENT_SPEC

{spec_block}

## REPOSITORY SNAPSHOT

repository: {config.repository}
branch: {config.branch}
base_ref: {config.base_ref}
BASE: {semantic["base"]}
HEAD: {semantic["head"]}

## BOUNDED CURRENT EVIDENCE

{repository_evidence}

Repository evidence in this prompt is bounded transport evidence, not a claim
that omitted diff is irrelevant.

## REPOSITORY RE-READ REQUIREMENT

Before deciding, re-read the exact current
PR/HEAD and relevant repository files using GitHub tools when available.
If required evidence cannot be accessed and this packet is insufficient for a
safe plan or judgment, return WAIT or HUMAN according to the role contract.

EVIDENCE_TRUNCATED: {str(evidence_truncated).lower()}

## PREVIOUS RELEVANT JUDGE RESULT

```json
{prior}
```

## SEMANTIC RULES

Only PLAN, WORK, PROVE, and MERGE exist. ABSENT is not a judgment. Corrections
are RETURN_PLAN, RETURN_WORK, or RETURN_PROVE; GPT cannot bypass proof or merge
fences. Base the decision only on this packet and the exact repository facts
you re-read; previous conversation history is not authority.

## STRICT RESPONSE SCHEMA

Return exactly this JSON shape (with no Markdown):
{schema}
Repeat JOB_ID verbatim and put the complete bounded plan or judgment in body.
"""


def render_gpt_prompt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> str:
    if action.kind not in {ActionKind.PLAN, ActionKind.JUDGE} or not action.effect_id:
        raise FactError("not a GPT effect")
    operation = "PLAN_GPT" if action.kind is ActionKind.PLAN else "JUDGE_GPT"
    charter = load_charter(paths, config)
    parent = _spec(snapshot, action.payload.get("parent_spec_id"))
    current = _spec(snapshot, action.payload.get("spec_id")) or parent
    planning_digest = plan_facts_digest(snapshot)
    semantic: dict[str, Any] = {
        "packet_schema": GPT_PACKET_SCHEMA, "job_id": action.effect_id,
        "p_id": config.p_id, "operation": operation,
        "charter_digest": config.charter_digest, "repository": config.repository,
        "branch": config.branch, "base_ref": config.base_ref,
        "head": snapshot.head, "base": snapshot.base,
        "parent_spec_id": parent.spec_id if parent else None,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "planning_facts_digest": planning_digest,
    }
    if snapshot.operator_directive is not None:
        semantic["operator_directive"] = {
            "directive_id": snapshot.operator_directive.directive_id,
            "text_digest": snapshot.operator_directive.text_digest,
            "authority_plan_job_id": snapshot.operator_directive.authority_plan_job_id,
            "parent_spec_id": snapshot.operator_directive.parent_spec_id,
        }
    if operation == "JUDGE_GPT":
        semantic.update({
            "spec_id": action.payload["spec_id"],
            "spec_content_digest": stable_id("spec-text", {"text": current.text if current else ""}),
            "failed_step": action.payload["failed_step"],
            "evidence_id": action.payload["evidence_id"],
            "evidence_digest": action.payload["evidence_digest"],
            "trigger_judge_id": action.payload.get("trigger_judge_id")
            if action.payload.get("trigger_judge_id") is not None
            else current.trigger_judge_id if current else None,
        })
    prior = "NONE"
    trigger = semantic.get("trigger_judge_id")
    if trigger:
        matches = [item for item in snapshot.gpt_results if item.job_id == trigger]
        if len(matches) == 1:
            prior = json.dumps(asdict(matches[0]), indent=2, ensure_ascii=False)
    spec_block = current.text if current else "NONE (PLAN_GPT must create CURRENT_SPEC)"
    directive_block = (
        "NONE"
        if snapshot.operator_directive is None
        else snapshot.operator_directive.text
    )
    directive_and_spec = "\n".join((directive_block, spec_block))
    keywords = _evidence_keywords(
        charter, directive_and_spec, str(action.payload.get("failed_step", "")),
        str(action.payload.get("evidence_id", "")),
    )
    worktree = Path(config.worktree)
    # Render once without repository evidence to establish the mandatory
    # authority footprint.  If it cannot fit, fail closed rather than dropping
    # charter, directive, SPEC, identity, or response schema.
    empty_packet = _render_gpt_packet(
        action=action, operation=operation, config=config, semantic=semantic,
        charter=charter, directive_block=directive_block, spec_block=spec_block,
        prior=prior, repository_evidence="(bounded evidence omitted)",
        evidence_truncated=True,
    )
    mandatory_bytes = len(empty_packet.encode("utf-8"))
    if mandatory_bytes > GPT_RENDER_BUDGET_BYTES:
        raise GPTPacketOversizeError(
            f"mandatory authority is {mandatory_bytes} bytes; render budget is {GPT_RENDER_BUDGET_BYTES} bytes",
            job_id=action.effect_id, operation=operation,
            rendered_bytes=mandatory_bytes, budget_bytes=GPT_PACKET_BUDGET_BYTES,
            evidence_bytes=0, evidence_truncated=True,
        )
    evidence_budget = GPT_RENDER_BUDGET_BYTES - mandatory_bytes
    evidence, evidence_truncated, _, _, _, _ = _bounded_repository_evidence(
        worktree, snapshot.base, snapshot.head, keywords, evidence_budget,
        _evidence_text(paths, str(semantic["evidence_id"]))
        if operation == "JUDGE_GPT" else "",
    )
    packet = _render_gpt_packet(
        action=action, operation=operation, config=config, semantic=semantic,
        charter=charter, directive_block=directive_block, spec_block=spec_block,
        prior=prior, repository_evidence=evidence,
        evidence_truncated=evidence_truncated,
    )
    # Final guard is on UTF-8 bytes, never Python character count.  The
    # transport wrapper has a deterministic reserve and is guarded separately
    # before /api/browser/jobs projects this packet.
    telemetry = assert_gpt_packet_budget(
        packet, job_id=action.effect_id, operation=operation,
        budget_bytes=GPT_RENDER_BUDGET_BYTES,
    )
    if int(telemetry["rendered_packet_bytes"]) > GPT_RENDER_BUDGET_BYTES:
        raise GPTPacketOversizeError(
            "bounded evidence did not fit the render budget",
            job_id=action.effect_id, operation=operation,
            rendered_bytes=int(telemetry["rendered_packet_bytes"]),
            budget_bytes=GPT_PACKET_BUDGET_BYTES,
            evidence_bytes=int(telemetry["evidence_bytes"]),
            evidence_truncated=evidence_truncated,
        )
    return packet


def dispatch_manual_gpt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> EffectResult:
    packet = render_gpt_prompt(paths, config, snapshot, action)
    prompt_path = paths.root / "gpt" / "outbox" / f"{action.effect_id}.md"
    result_path = paths.root / "gpt" / "results" / f"{action.effect_id}.json"
    if result_path.exists():
        return EffectResult(
            False,
            detail=f"GPT result already exists; packet was not replaced: {result_path}",
        )
    created = False
    if prompt_path.exists():
        # A pre-budget packet may already exist for the same unaccepted
        # semantic job.  Replace only after proving its immutable semantic
        # identity is exactly equal; the atomic replacement changes transport
        # bytes/digest, never the job identity or result authority.
        existing = load_gpt_packet(paths, action.effect_id)
        candidate = _packet_json(packet)
        if existing != candidate:
            raise FactError(
                f"existing GPT packet semantic identity differs: {action.effect_id}"
            )
        previous = prompt_path.read_text(encoding="utf-8")
        if previous != packet:
            prompt_path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{prompt_path.name}.", suffix=".tmp", dir=prompt_path.parent
            )
            temporary = Path(temporary_name)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(packet)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, prompt_path)
            finally:
                temporary.unlink(missing_ok=True)
            created = True
    else:
        created = write_text_once(prompt_path, packet)
    telemetry = packet_telemetry(packet)
    return EffectResult(
        created,
        detail=(
            f"JOB_ID={action.effect_id} PACKET={prompt_path} SHA256={sha256_text(packet)} "
            f"rendered_packet_bytes={telemetry['rendered_packet_bytes']} "
            f"packet_budget_bytes={telemetry['packet_budget_bytes']} "
            f"evidence_bytes={telemetry['evidence_bytes']} "
            f"evidence_truncated={telemetry['evidence_truncated']}"
        ),
    )


def _packet_json(packet_text: str) -> dict[str, Any]:
    marker = "## SEMANTIC INPUTS\n```json\n"
    try:
        encoded = packet_text.split(marker, 1)[1].split("\n```", 1)[0]
        value = json.loads(encoded)
    except (IndexError, json.JSONDecodeError) as error:
        raise FactError("GPT packet semantic inputs are malformed") from error
    if not isinstance(value, dict):
        raise FactError("GPT packet semantic inputs must be an object")
    return value


def submit_gpt_response(paths: PPaths, response_path: Path) -> EffectResult:
    value = _load_json(response_path)
    job_id = value.get("job_id")
    if type(job_id) is not str or not GPT_JOB_RE.fullmatch(job_id):
        raise FactError("GPT response does not contain a valid generated JOB_ID")
    packet = load_gpt_packet(paths, job_id)
    result = parse_gpt_response(job_id, str(packet["operation"]), value)
    destination = paths.root / "gpt" / "results" / f"{result.job_id}.json"
    created = write_json_once(destination, asdict(result))
    return EffectResult(created, f"stored {destination}")


def _work_prompt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action, spec: SpecFact
) -> str:
    trigger = action.payload.get("trigger_judge_id")
    direction = "NONE"
    if trigger:
        matches = [item for item in snapshot.gpt_results if item.job_id == trigger]
        if len(matches) == 1:
            direction = matches[0].body
    trigger_trailer = f"\nAgentBus-V2-Trigger: {trigger}" if trigger else ""
    if not spec.plan_job_id:
        raise FactError("CURRENT_SPEC lacks its causal PLAN job identity")
    trailers = f"""AgentBus-V2-P: {config.p_id}
AgentBus-V2-Spec: {spec.spec_id}
AgentBus-V2-Work: {action.effect_id}
AgentBus-V2-Input-Head: {snapshot.head}
AgentBus-V2-Plan: {spec.plan_job_id}{trigger_trailer}"""
    return f"""Implement this AgentBus v2 WORK job.

P_CHARTER:
{load_charter(paths, config).rstrip()}

CURRENT_SPEC:
{spec.text}

RETURN_WORK direction, if any:
{direction}

Exact identities:
- P: {config.p_id}
- repository: {config.repository}
- branch: {config.branch}
- input HEAD: {snapshot.head}
- live BASE: {snapshot.base}
- WORK effect: {action.effect_id}

Implement only the approved scope, validate proportionally, do not merge, and
finish with a clean worktree and a commit descended from input HEAD. Its
message must contain these exact trailers:

{trailers}

Return only the supplied JSON schema. PASS requires a complete commit; otherwise
return FAIL with the exact blocker. An executor/process crash is not FAIL.
"""


CODEX_OUTPUT_SCHEMA = (
    '{"type":"object","additionalProperties":false,"properties":'
    '{"status":{"enum":["PASS","FAIL"]},"summary":{"type":"string"},'
    '"head":{"type":"string"},"evidence":{"type":"array","items":{"type":"string"}}},'
    '"required":["status","summary","head","evidence"]}\n'
)

CODEX_WORK_MODEL = "gpt-5.6-luna"
CODEX_WORK_REASONING_EFFORT = "max"


def _codex_work_command(
    config: PConfig,
    common_git: Path,
    schema_path: Path,
    response_path: Path,
) -> tuple[str, ...]:
    # Executor selection is operational only. Keep it explicit here without
    # adding the model or account to any durable semantic identity.
    return (
        "codex", "exec", "--ephemeral", "--approve-for-me",
        "--model", CODEX_WORK_MODEL,
        "--config", f'model_reasoning_effort="{CODEX_WORK_REASONING_EFFORT}"',
        "-C", config.worktree, "--add-dir", str(common_git),
        "--output-schema", str(schema_path),
        "--output-last-message", str(response_path), "-",
    )


def _local_branch_refs(worktree: Path) -> dict[str, str]:
    lines = git(worktree, "for-each-ref", "--format=%(refname) %(objectname)",
                "refs/heads").splitlines()
    return dict(line.split(" ", 1) for line in lines if " " in line)


def run_codex_work(
    paths: PPaths,
    config: PConfig,
    snapshot: Snapshot,
    action: Action,
    codex_home: Path | None = None,
    *,
    worktree_lock_path: Path | None = None,
    account_lock_path: Path | None = None,
) -> EffectResult:
    if action.kind is not ActionKind.WORK or not action.effect_id:
        raise FactError("not a WORK effect")
    spec = _spec(snapshot, str(action.payload.get("spec_id")))
    if spec is None:
        raise FactError("WORK effect references an absent SPEC")
    prompt = _work_prompt(paths, config, snapshot, action, spec)
    fresh = read_snapshot(paths)
    recalculated = decide(fresh)
    if (
        recalculated.kind is not ActionKind.WORK
        or recalculated.effect_id != action.effect_id
        or dict(recalculated.payload) != dict(action.payload)
    ):
        return EffectResult(False, "WORK identities drifted before Codex")
    if git(Path(config.worktree), "status", "--porcelain=v1"):
        raise FactError("refusing to launch Codex in a dirty WORK worktree")
    worktree = Path(config.worktree)
    protected_refs = _local_branch_refs(worktree)
    common_git = Path(git(worktree, "rev-parse", "--git-common-dir"))
    if not common_git.is_absolute():
        common_git = (worktree / common_git).resolve()
    response_path = paths.root / "work" / "logs" / f"{action.effect_id}.response.json"
    log_path = paths.root / "work" / "logs" / f"{action.effect_id}.codex.log"
    response_path.unlink(missing_ok=True)
    schema = tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False)
    schema_path = Path(schema.name)
    try:
        schema.write(CODEX_OUTPUT_SCHEMA)
        schema.close()
        command = _codex_work_command(config, common_git, schema_path, response_path)
        environment = os.environ.copy()
        if codex_home is not None:
            environment["CODEX_HOME"] = str(codex_home)
        if worktree_lock_path is None or account_lock_path is None:
            return EffectResult(False, "Codex ownership locks were not supplied")
        guarded = run_guardian(
            command,
            cwd=worktree,
            env=environment,
            log_path=log_path,
            timeout=7200.0,
            worktree_lock=worktree_lock_path,
            account_lock=account_lock_path,
            input_text=prompt,
            expected_head=snapshot.head,
            expected_branch=config.branch,
        )
    finally:
        schema.close()
        schema_path.unlink(missing_ok=True)
    try:
        completed_output = log_path.read_text(encoding="utf-8", errors="replace")[-262144:]
    except OSError:
        completed_output = ""
    if guarded.timed_out:
        return EffectResult(False, "Codex exceeded the executor timeout")
    if guarded.parent_lost:
        return EffectResult(False, "Codex guardian cleaned up after AgentBus parent loss")
    if guarded.worktree_busy:
        return EffectResult(False, "worktree execution lock is unavailable")
    if guarded.account_busy:
        return EffectResult(False, "Codex account lock is unavailable")
    if guarded.identity_drift:
        return EffectResult(False, "WORK identities drifted before Codex")
    if guarded.returncode == GUARDIAN_ERROR:
        return EffectResult(False, "Codex guardian could not start or own the executor")
    if guarded.returncode != 0 or not response_path.exists():
        return EffectResult(False, "Codex exited without a durable result")
    try:
        response = _load_json(response_path)
        if set(response) != {"status", "summary", "head", "evidence"}:
            raise FactError("Codex response has unexpected fields")
        if (
            type(response["status"]) is not str
            or type(response["summary"]) is not str
            or type(response["head"]) is not str
            or not isinstance(response["evidence"], list)
            or any(type(item) is not str for item in response["evidence"])
            or not response["summary"].strip()
        ):
            raise FactError("Codex response fields have invalid types or are empty")
        status = Observation(response["status"])
    except (FactError, ValueError) as error:
        return EffectResult(False, f"invalid Codex result: {error}")
    live_head = git(worktree, "rev-parse", "HEAD")
    summary = response["summary"]
    current_refs = _local_branch_refs(worktree)
    changed_refs = {
        name
        for name in set(protected_refs) | set(current_refs)
        if protected_refs.get(name) != current_refs.get(name)
    }
    allowed_ref = f"refs/heads/{config.branch}"
    if changed_refs - {allowed_ref}:
        raise FactError(
            "Codex altered protected local refs: "
            + ", ".join(sorted(changed_refs - {allowed_ref}))
        )
    if git(worktree, "status", "--porcelain=v1"):
        raise FactError("Codex completed with a dirty WORK worktree")
    if status is Observation.PASS:
        recovered = _work_from_head(config, live_head)
        if (
            recovered is None
            or recovered.effect_id != action.effect_id
            or recovered.spec_id != spec.spec_id
            or recovered.input_head != snapshot.head
            or response["head"] != live_head
        ):
            raise FactError(
                "Codex claimed PASS without the exact committed WORK identity trailers"
            )
        return EffectResult(True, summary)
    if live_head != snapshot.head or changed_refs or response["head"] != live_head:
        raise FactError("Codex returned FAIL after changing repository HEAD")
    evidence = {
        "codex_response": response,
        "codex_log_sha256": sha256_text(completed_output),
        "live_head": live_head,
    }
    result = {
        "effect_id": action.effect_id,
        "spec_id": spec.spec_id,
        "input_head": snapshot.head,
        "status": Observation.FAIL.value,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "evidence_digest": sha256_text(json.dumps(evidence, sort_keys=True)),
    }
    destination = paths.root / "work" / "results" / f"{action.effect_id}.json"
    write_json_once(destination, result)
    return EffectResult(True, f"{summary}; stored {destination}")


def _command_evidence(
    config: PConfig, snapshot: Snapshot
) -> tuple[dict[str, Any] | None, Observation | None]:
    worktree = Path(config.worktree)
    commands = _proof_commands(config, snapshot.base, snapshot.head)
    def record(argv: Sequence[str], output: str, exit_code: int) -> dict[str, Any]:
        return {"argv": list(argv), "exit_code": exit_code,
                "output": output[-65536:], "output_digest": sha256_text(output)}
    try:
        status_text = git(worktree, "status", "--porcelain=v1")
    except FactError:
        return None, None
    records = [record(("git", "status", "--porcelain=v1"), status_text, 1 if status_text else 0)]
    if status_text:
        return {"commands": records}, Observation.FAIL
    for argv in commands[1:-1]:
        try:
            completed = _run(argv, cwd=worktree, check=False, timeout=1800)
        except FactError:
            return None, None
        log = completed.stdout + ("\nSTDERR:\n" + completed.stderr if completed.stderr else "")
        records.append(record(argv, log, completed.returncode))
        if completed.returncode != 0:
            return {"commands": records}, Observation.FAIL
    try:
        after = git(worktree, "status", "--porcelain=v1")
    except FactError:
        return None, None
    records.append(record(("git", "status", "--porcelain=v1"), after, 1 if after else 0))
    return {"commands": records}, Observation.PASS if not after else Observation.FAIL


def run_prove(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> EffectResult:
    if action.kind is not ActionKind.PROVE or not action.effect_id:
        raise FactError("not a PROVE effect")
    spec = _spec(snapshot, str(action.payload.get("spec_id")))
    if spec is None:
        raise FactError("PROVE effect references an absent SPEC")
    worktree = Path(config.worktree)
    fetched = _run(
        ("git", "fetch", config.remote, config.base_ref),
        cwd=worktree,
        check=False,
        timeout=120,
    )
    if fetched.returncode != 0:
        return EffectResult(False, "base fetch unavailable")
    fresh = read_snapshot(paths)
    recalculated = decide(fresh)
    if (
        recalculated.kind is not ActionKind.PROVE
        or recalculated.effect_id != action.effect_id
        or dict(recalculated.payload) != dict(action.payload)
    ):
        return EffectResult(False, "PROVE identities drifted before proof")
    mechanical, local_status = _command_evidence(config, snapshot)
    if mechanical is None or local_status is None:
        return EffectResult(False, "mechanical proof was interrupted")
    if local_status is Observation.FAIL:
        status = local_status
        checks: list[dict[str, Any]] = []
        failed_logs: dict[str, str] = {}
        require_pr_fence = False
    else:
        require_pr_fence = True
        if not ensure_owned_pr(config, spec):
            return EffectResult(False, "push or PR transport unavailable")
        merge = read_github_facts(config)
        if (
            merge.pr_number is None
            or merge.head_sha != snapshot.head
            or merge.live_base != snapshot.base
            or merge.pr_base_sha != snapshot.base
            or merge.head_branch != config.branch
            or merge.base_branch != config.base_ref
            or merge.p_id != config.p_id
            or merge.spec_id != spec.spec_id
            or merge.owner_token != config.owner_token
        ):
            return EffectResult(False, "PR identities have not converged")
        if config.required_ci_checks:
            merge = observe_required_checks(config, merge, snapshot.head, snapshot.base)
            checks = [asdict(item) for item in merge.checks]
            failed_logs = dict(merge.failed_ci_logs)
            ci_status = merge.check_status
        else:
            ci_status, checks, failed_logs = "PASS", [], {}
        if ci_status in {"MISSING", "RUNNING"}:
            return EffectResult(False, "GitHub CI is queued/running/absent")
        status = Observation(ci_status)
    evidence = {
        "local_commands": mechanical["commands"],
        "github_checks": checks,
        "failed_ci_logs": failed_logs,
    }
    final = read_snapshot(paths)
    # Before the first durable PASS proof exists, the normal semantic snapshot
    # deliberately omits GitHub facts unless merge permission was requested.
    # PROVE still needs a fresh final PR identity fence; read that operational
    # fact directly instead of smuggling merge permission into recomputation.
    final_merge = read_github_facts(config) if require_pr_fence else final.merge
    if require_pr_fence and config.required_ci_checks and status is Observation.PASS:
        final_merge = observe_required_checks(config, final_merge, snapshot.head, snapshot.base)
        if final_merge.check_status != "PASS":
            return EffectResult(False, "CI drifted before proof result")
        checks = [asdict(item) for item in final_merge.checks]
        failed_logs = dict(final_merge.failed_ci_logs)
    final_action = decide(final)
    if (
        final.head != snapshot.head
        or final.base != snapshot.base
        or final_action.kind is not ActionKind.PROVE
        or final_action.effect_id != action.effect_id
        or dict(final_action.payload) != dict(action.payload)
        or (
            require_pr_fence
            and (
                final_merge.head_sha != snapshot.head
                or final_merge.live_base != snapshot.base
                or final_merge.pr_base_sha != snapshot.base
                or final_merge.head_branch != config.branch
                or final_merge.base_branch != config.base_ref
                or final_merge.p_id != config.p_id
                or final_merge.spec_id != spec.spec_id
                or final_merge.owner_token != config.owner_token
            )
        )
    ):
        return EffectResult(False, "HEAD, BASE, or PR drifted before proof result")
    result = {
        "schema": PROOF_SCHEMA,
        "proof_id": action.effect_id,
        "spec_id": spec.spec_id,
        "head": snapshot.head,
        "base": snapshot.base,
        "status": status.value,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "contract_digest": snapshot.proof_contract_digest,
        "summary": "required mechanical and CI evidence passed"
        if status is Observation.PASS
        else "required mechanical or CI evidence failed",
        "evidence_digest": sha256_text(json.dumps(evidence, sort_keys=True)),
        "local_commands": evidence["local_commands"],
        "github_checks": evidence["github_checks"],
        "failed_ci_logs": evidence["failed_ci_logs"],
    }
    destination = paths.root / "prove" / "results" / f"{action.effect_id}.json"
    write_json_once(destination, result)
    return EffectResult(True, f"{result['summary']}; stored {destination}")


def execute_merge(
    paths: PPaths,
    expected: Action,
) -> EffectResult:
    if expected.kind is not ActionKind.MERGE or not expected.effect_id:
        raise FactError("not a permitted MERGE effect")
    fresh = read_snapshot(paths, allow_merge=True)
    recalculated = decide(fresh)
    if recalculated.kind is not ActionKind.MERGE or recalculated.effect_id != expected.effect_id:
        return EffectResult(False, recalculated.reason)
    if dict(recalculated.payload) != dict(expected.payload):
        return EffectResult(False, "merge payload drifted")
    config = load_config(paths)
    worktree = Path(config.worktree)
    if git(worktree, "status", "--porcelain"):
        return EffectResult(False, "worktree is not clean")
    completed = merge_pr(
        config,
        int(recalculated.payload["pr_number"]),
        str(recalculated.payload["head"]),
    )
    if completed.returncode != 0:
        return EffectResult(False, completed.stderr.strip())
    return EffectResult(True, "next tick must derive DONE from GitHub")
