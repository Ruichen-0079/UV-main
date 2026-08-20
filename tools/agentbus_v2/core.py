from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum
import hashlib
import json
from typing import Any, Mapping

from .github import GitHubFacts


class Observation(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    ABSENT = "ABSENT"


class ActionKind(str, Enum):
    PLAN = "PLAN"
    WORK = "WORK"
    PROVE = "PROVE"
    JUDGE = "JUDGE"
    MERGE = "MERGE"
    MERGE_READY = "MERGE_READY"
    IDLE = "IDLE"
    HUMAN = "HUMAN"
    DONE = "DONE"


PLAN_RESULTS = frozenset({"SPEC", "WAIT", "HUMAN"})
JUDGE_RESULTS = frozenset(
    {"PASS", "RETURN_PLAN", "RETURN_WORK", "RETURN_PROVE", "WAIT", "HUMAN"}
)
IDENTITY_SCHEMA = "agentbus-v2/schema-v1"
GPT_PACKET_SCHEMA = "agentbus-v2/manual-packet-v2"
PROOF_SCHEMA = "agentbus-v2/proof-v2"


def stable_id(prefix: str, payload: Mapping[str, Any]) -> str:
    value = json.dumps(
        {"schema": IDENTITY_SCHEMA, "value": payload},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    return f"{prefix}-{hashlib.sha256(value).hexdigest()[:24]}"


@dataclass(frozen=True)
class SpecFact:
    spec_id: str
    text: str
    parent_spec_id: str | None = None
    trigger_judge_id: str | None = None
    plan_job_id: str | None = None


@dataclass(frozen=True)
class GptResult:
    job_id: str
    operation: str
    decision: str
    body: str


@dataclass(frozen=True)
class WorkFact:
    effect_id: str
    spec_id: str
    input_head: str
    status: Observation
    evidence_digest: str
    output_head: str | None = None
    trigger_judge_id: str | None = None
    plan_job_id: str | None = None


@dataclass(frozen=True)
class ProofFact:
    proof_id: str
    spec_id: str
    head: str
    base: str
    status: Observation
    evidence_digest: str
    trigger_judge_id: str | None = None
    summary: str = ""


@dataclass(frozen=True)
class Snapshot:
    p_id: str
    charter_digest: str
    expected_repository: str
    expected_branch: str
    base_ref: str
    head: str
    base: str
    repository_available: bool = True
    specs: tuple[SpecFact, ...] = ()
    gpt_results: tuple[GptResult, ...] = ()
    gpt_pending: frozenset[str] = frozenset()
    work_facts: tuple[WorkFact, ...] = ()
    proof_facts: tuple[ProofFact, ...] = ()
    merge: GitHubFacts = field(default_factory=GitHubFacts)
    expected_owner_token: str = ""
    proof_contract_digest: str = ""
    allow_merge: bool = False


@dataclass(frozen=True)
class Action:
    kind: ActionKind
    effect_id: str | None = None
    reason: str = ""
    payload: Mapping[str, Any] = field(default_factory=dict)


def gpt_job_id(
    s: Snapshot,
    operation: str,
    *,
    spec: SpecFact | None = None,
    failed_step: str | None = None,
    evidence_id: str | None = None,
    evidence_digest: str | None = None,
    parent_spec_id: str | None = None,
    trigger_judge_id: str | None = None,
) -> str:
    common = {"p_id": s.p_id, "operation": operation,
              "packet_schema": GPT_PACKET_SCHEMA, "charter": s.charter_digest}
    if operation == "PLAN_GPT":
        return stable_id("plan", {
            **common, "repository": s.expected_repository, "planning_facts": plan_facts_digest(s),
            "parent_spec": parent_spec_id,
            "previous_judge": trigger_judge_id,
        })
    if operation != "JUDGE_GPT" or spec is None:
        raise ValueError("GPT operation requires a PLAN or JUDGE semantic input")
    if failed_step is None or evidence_id is None or evidence_digest is None:
        raise ValueError("JUDGE_GPT identity lacks failure/evidence inputs")
    return stable_id("judge", {**common, "spec": spec.spec_id,
        "spec_content": stable_id("spec-text", {"text": spec.text}),
        "head": s.head, "base": s.base, "failed_step": failed_step,
        "evidence_id": evidence_id, "evidence_digest": evidence_digest,
        "trigger_judge": trigger_judge_id if trigger_judge_id is not None else spec.trigger_judge_id})


def plan_job_id(s: Snapshot, *, parent_spec_id: str | None = None,
                trigger_judge_id: str | None = None) -> str:
    return gpt_job_id(s, "PLAN_GPT", parent_spec_id=parent_spec_id,
                      trigger_judge_id=trigger_judge_id)


def plan_facts_digest(s: Snapshot) -> str:
    return stable_id("planfacts", {
        "repository": s.expected_repository,
        "branch": s.expected_branch,
        "base_ref": s.base_ref,
        "head": s.head,
        "base": s.base,
    })


def spec_id(charter_digest: str, planning_digest: str, text: str) -> str:
    normalized = "\n".join(
        line.rstrip() for line in text.replace("\r\n", "\n").strip().split("\n")
    )
    return stable_id("spec", {
        "charter": charter_digest,
        "planning_facts": planning_digest,
        "text": normalized,
    })


def work_effect_id(
    s: Snapshot, spec: SpecFact, *, trigger_judge_id: str | None = None
) -> str:
    return work_identity_id(s.p_id, spec.spec_id, s.head, trigger_judge_id)


def work_identity_id(
    p_id: str, spec_id_value: str, input_head: str, trigger_judge_id: str | None = None
) -> str:
    return stable_id("work", {
        "p_id": p_id,
        "spec": spec_id_value,
        "input_head": input_head,
        "trigger_judge": trigger_judge_id,
    })


def proof_id(
    s: Snapshot, spec: SpecFact, *, trigger_judge_id: str | None = None
) -> str:
    return stable_id("prove", {
        "proof_schema": PROOF_SCHEMA,
        "p_id": s.p_id,
        "spec": spec.spec_id,
        "head": s.head,
        "base": s.base,
        "trigger_judge": trigger_judge_id,
        "proof_contract": s.proof_contract_digest,
    })


def judge_job_id(
    s: Snapshot,
    spec: SpecFact,
    *,
    failed_step: str,
    evidence_id: str,
    evidence_digest: str,
    trigger_judge_id: str | None = None,
) -> str:
    return gpt_job_id(s, "JUDGE_GPT", spec=spec, failed_step=failed_step,
                      evidence_id=evidence_id, evidence_digest=evidence_digest,
                      trigger_judge_id=trigger_judge_id)


def semantic_judge_job_id(s: Snapshot, spec: SpecFact, proof: ProofFact) -> str:
    return judge_job_id(
        s, spec, failed_step="PROVE_SEMANTIC",
        evidence_id=proof.proof_id, evidence_digest=proof.evidence_digest,
        trigger_judge_id=proof.trigger_judge_id,
    )


def _action(
    kind: ActionKind,
    effect_id: str | None = None,
    reason: str = "",
    **payload: Any,
) -> Action:
    return Action(kind, effect_id, reason, payload)


def _request(s: Snapshot, kind: ActionKind, effect_id: str, **payload: Any) -> Action:
    if effect_id in s.gpt_pending:
        return _action(ActionKind.IDLE, reason="GPT result is absent", job_id=effect_id)
    return _action(kind, effect_id, **payload)


def _checked_result(
    result: GptResult | None, operation: str, allowed: frozenset[str]
) -> Action | GptResult | None:
    if result is None:
        return None
    if result.operation != operation or result.decision not in allowed:
        return _action(ActionKind.HUMAN, reason=f"invalid {operation} result", job_id=result.job_id)
    if result.decision in {"WAIT", "HUMAN"}:
        label = (
            "manual WAIT handling required"
            if result.decision == "WAIT"
            else "GPT requested human input"
        )
        return _action(ActionKind.HUMAN, reason=label, job_id=result.job_id, detail=result.body)
    return result


def _plan(
    s: Snapshot,
    results: Mapping[str, GptResult],
    parent: SpecFact | None = None,
    trigger: str | None = None,
) -> Action:
    job = plan_job_id(
        s,
        parent_spec_id=parent.spec_id if parent else None,
        trigger_judge_id=trigger,
    )
    checked = _checked_result(results.get(job), "PLAN_GPT", PLAN_RESULTS)
    if isinstance(checked, Action):
        return checked
    if isinstance(checked, GptResult):
        return _action(
            ActionKind.IDLE,
            reason="SPEC response awaits fact materialization",
            job_id=job,
        )
    return _request(
        s,
        ActionKind.PLAN,
        job,
        parent_spec_id=parent.spec_id if parent else None,
        trigger_judge_id=trigger,
    )


def _judge(
    s: Snapshot,
    results: Mapping[str, GptResult],
    spec: SpecFact,
    step: str,
    evidence_id: str,
    digest: str,
    trigger: str | None = None,
) -> Action | GptResult:
    job = judge_job_id(
        s, spec, failed_step=step, evidence_id=evidence_id, evidence_digest=digest,
        trigger_judge_id=trigger,
    )
    checked = _checked_result(results.get(job), "JUDGE_GPT", JUDGE_RESULTS)
    if checked is not None:
        return checked
    return _request(
        s,
        ActionKind.JUDGE,
        job,
        spec_id=spec.spec_id,
        failed_step=step,
        evidence_id=evidence_id,
        evidence_digest=digest,
        trigger_judge_id=trigger,
    )


def _route(
    s: Snapshot,
    results: Mapping[str, GptResult],
    spec: SpecFact,
    result: GptResult,
    pass_action: Action,
) -> Action:
    routes = {
        "PASS": lambda: pass_action,
        "RETURN_PLAN": lambda: _plan(s, results, spec, result.job_id),
        "RETURN_WORK": lambda: _work(s, results, spec, result.job_id),
        "RETURN_PROVE": lambda: _prove(s, results, spec, result.job_id),
    }
    return routes[result.decision]()


def _work(
    s: Snapshot, results: Mapping[str, GptResult], spec: SpecFact, trigger: str | None
) -> Action:
    if trigger is None:
        current = next(
            (
                item
                for item in s.work_facts
                if item.spec_id == spec.spec_id
                and item.input_head == s.head
                and work_effect_id(s, spec, trigger_judge_id=item.trigger_judge_id)
                == item.effect_id
            ),
            None,
        )
        if current is not None:
            trigger = current.trigger_judge_id
    effect = work_effect_id(s, spec, trigger_judge_id=trigger)
    work = next((item for item in s.work_facts if item.effect_id == effect), None)
    if work is None:
        return _request(
            s,
            ActionKind.WORK,
            effect,
            spec_id=spec.spec_id,
            input_head=s.head,
            trigger_judge_id=trigger,
        )
    if work.status is Observation.PASS:
        if not work.output_head or work.output_head == work.input_head:
            return _action(ActionKind.HUMAN, reason="WORK PASS produced no new HEAD", effect_id=effect)
        return (
            _prove(s, results, spec, None)
            if work.output_head == s.head
            else _action(ActionKind.IDLE, reason="WORK HEAD has not converged", effect_id=effect)
        )
    judged = _judge(
        s, results, spec, "WORK", work.effect_id, work.evidence_digest,
        work.trigger_judge_id,
    )
    if isinstance(judged, Action):
        return judged
    return _route(
        s,
        results,
        spec,
        judged,
        _action(
            ActionKind.HUMAN,
            reason="PASS cannot replace required WORK PASS",
            job_id=judged.job_id,
        ),
    )


def _prove(
    s: Snapshot, results: Mapping[str, GptResult], spec: SpecFact, trigger: str | None
) -> Action:
    if trigger is None:
        current = next(
            (
                item
                for item in s.proof_facts
                if item.spec_id == spec.spec_id
                and item.head == s.head
                and item.base == s.base
                and proof_id(s, spec, trigger_judge_id=item.trigger_judge_id)
                == item.proof_id
            ),
            None,
        )
        if current is not None:
            trigger = current.trigger_judge_id
    effect = proof_id(s, spec, trigger_judge_id=trigger)
    proof = next((item for item in s.proof_facts if item.proof_id == effect), None)
    if proof is None:
        return _request(
            s,
            ActionKind.PROVE,
            effect,
            spec_id=spec.spec_id,
            head=s.head,
            base=s.base,
            trigger_judge_id=trigger,
        )
    if proof.status is Observation.FAIL:
        judged = _judge(
            s, results, spec, "PROVE_MECHANICAL", proof.proof_id,
            proof.evidence_digest, proof.trigger_judge_id,
        )
        if isinstance(judged, Action):
            return judged
        return _route(
            s,
            results,
            spec,
            judged,
            _action(
                ActionKind.HUMAN,
                reason="PASS cannot replace required mechanical PASS",
                job_id=judged.job_id,
            ),
        )
    judged = _judge(
        s, results, spec, "PROVE_SEMANTIC", proof.proof_id,
        proof.evidence_digest, proof.trigger_judge_id,
    )
    if isinstance(judged, Action):
        return judged
    return _route(s, results, spec, judged, _merge(s, spec, proof))


def _work_pass(s: Snapshot, spec: SpecFact) -> WorkFact | None:
    return next((
        item for item in s.work_facts
        if item.spec_id == spec.spec_id
        and item.status is Observation.PASS
        and item.output_head == s.head
    ), None)


def merge_fence_failures(s: Snapshot, spec: SpecFact) -> tuple[str, ...]:
    m = s.merge
    checks = (
        (m.available, "github facts unavailable"),
        (m.pr_number is not None, "PR absent"),
        (m.state == "OPEN", "PR not open"),
        (m.draft is False, "PR is draft or unknown"),
        (m.mergeable is True, "PR is not confirmed mergeable"),
        (m.head_sha == s.head, "PR HEAD drift"),
        (m.live_base == s.base, "live BASE drift"),
        (m.pr_base_sha == s.base, "PR BASE drift"),
        (m.head_branch == s.expected_branch, "PR head branch mismatch"),
        (m.base_branch == s.base_ref, "PR base branch mismatch"),
        (m.p_id == s.p_id, "PR P identity mismatch"),
        (m.spec_id == spec.spec_id, "PR SPEC identity mismatch"),
        (m.owner_token == s.expected_owner_token, "resource ownership mismatch"),
    )
    return tuple(message for passed, message in checks if not passed)


def _merge(s: Snapshot, spec: SpecFact, proof: ProofFact) -> Action:
    if _work_pass(s, spec) is None:
        return _action(ActionKind.HUMAN, reason="MERGE requires current WORK PASS")
    failures = merge_fence_failures(s, spec)
    if failures:
        return _action(ActionKind.IDLE, reason="merge fences are not satisfied", failures=failures)
    effect = stable_id("merge", {
        "p_id": s.p_id,
        "spec": spec.spec_id,
        "head": s.head,
        "base": s.base,
        "proof": proof.evidence_digest,
        "pr": s.merge.pr_number,
    })
    payload = {
        "p_id": s.p_id,
        "spec_id": spec.spec_id,
        "head": s.head,
        "base": s.base,
        "proof_effect_id": proof.proof_id,
        "proof_evidence_digest": proof.evidence_digest,
        "pr_number": s.merge.pr_number,
    }
    if not s.allow_merge:
        return Action(
            ActionKind.MERGE_READY,
            effect,
            "all fences pass; process merge permission is false",
            payload,
        )
    return _request(s, ActionKind.MERGE, effect, **payload)


def _done(
    s: Snapshot, results: Mapping[str, GptResult], spec: SpecFact
) -> Action | None:
    m = s.merge
    if m.state != "MERGED":
        return None
    identity_ok = (
        m.available
        and m.head_sha == s.head
        and m.live_base == s.base
        and m.head_branch == s.expected_branch
        and m.base_branch == s.base_ref
        and m.p_id == s.p_id
        and m.spec_id == spec.spec_id
        and m.owner_token == s.expected_owner_token
        and bool(m.merge_commit_sha)
        and len(m.merge_parents) == 2
        and m.pr_base_sha == m.merge_parents[0]
        and m.merge_parents[1] == s.head
        and bool(m.merge_parents[0])
    )
    if not identity_ok or _work_pass(s, spec) is None:
        return _action(ActionKind.HUMAN, reason="merged PR identities/evidence do not match")
    prior = replace(s, base=m.merge_parents[0])
    for proof in s.proof_facts:
        if (
            proof.spec_id == spec.spec_id
            and proof.head == s.head
            and proof.base == m.merge_parents[0]
            and proof.status is Observation.PASS
        ):
            result = results.get(semantic_judge_job_id(prior, spec, proof))
            if result and result.operation == "JUDGE_GPT" and result.decision == "PASS":
                return _action(ActionKind.DONE, reason="owned PR is durably merged")
    return _action(ActionKind.HUMAN, reason="merged PR lacks exact PROVE/JUDGE PASS")


def decide(s: Snapshot) -> Action:
    if not s.repository_available:
        return _action(ActionKind.IDLE, reason="repository facts are absent")
    results = {item.job_id: item for item in s.gpt_results}
    spec = s.specs[-1] if s.specs else None
    if spec is None:
        return _plan(s, results)
    if (done := _done(s, results, spec)) is not None:
        return done
    return (
        _prove(s, results, spec, None)
        if _work_pass(s, spec)
        else _work(s, results, spec, None)
    )
