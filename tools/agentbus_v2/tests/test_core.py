from __future__ import annotations

from dataclasses import replace
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import (
    ActionKind,
    GptResult,
    Observation,
    ProofFact,
    Snapshot,
    SpecFact,
    WorkFact,
    decide,
    judge_job_id,
    merge_fence_failures,
    plan_facts_digest,
    plan_job_id,
    proof_id,
    semantic_judge_job_id,
    spec_id,
    work_effect_id,
)
from tools.agentbus_v2.github import GitHubFacts
from tools.agentbus_v2.effects import execute_merge
from tools.agentbus_v2.facts import PPaths
from pathlib import Path
import tempfile


H0 = "0" * 40
H1 = "1" * 40
H2 = "2" * 40
B1 = "a" * 40
B2 = "b" * 40


def blank(**changes: object) -> Snapshot:
    value = Snapshot(
        p_id="P-TEST",
        charter_digest="charter-digest",
        expected_repository="github.com/example/repo",
        expected_branch="agentbus/p-test",
        base_ref="main",
        head=H0,
        base=B1,
        expected_owner_token="owner-token",
    )
    return replace(value, **changes)


def with_spec(snapshot: Snapshot, text: str = "Implement the change") -> tuple[Snapshot, SpecFact]:
    job = plan_job_id(snapshot)
    planning = plan_facts_digest(snapshot)
    spec = SpecFact(
        spec_id(snapshot.charter_digest, planning, text),
        text,
    )
    result = GptResult(job, "PLAN_GPT", "SPEC", text)
    return replace(snapshot, specs=(spec,), gpt_results=(result,)), spec


def work_pass(snapshot: Snapshot, spec: SpecFact, input_head: str = H0) -> WorkFact:
    at_input = replace(snapshot, head=input_head)
    return WorkFact(
        effect_id=work_effect_id(at_input, spec),
        spec_id=spec.spec_id,
        input_head=input_head,
        status=Observation.PASS,
        output_head=snapshot.head,
        evidence_digest=f"work-{snapshot.head}",
    )


def proof_pass(snapshot: Snapshot, spec: SpecFact) -> ProofFact:
    return ProofFact(
        proof_id=proof_id(snapshot, spec),
        spec_id=spec.spec_id,
        head=snapshot.head,
        base=snapshot.base,
        status=Observation.PASS,
        evidence_digest=f"proof-{snapshot.head}-{snapshot.base}",
    )


def merge_facts(snapshot: Snapshot, spec: SpecFact) -> GitHubFacts:
    return GitHubFacts(
        pr_number=123,
        state="OPEN",
        draft=False,
        mergeable=True,
        head_sha=snapshot.head,
        live_base=snapshot.base,
        pr_base_sha=snapshot.base,
        head_branch=snapshot.expected_branch,
        base_branch=snapshot.base_ref,
        p_id=snapshot.p_id,
        spec_id=spec.spec_id,
        owner_token=snapshot.expected_owner_token,
    )


class KernelTableTests(unittest.TestCase):
    def test_a_no_spec_requests_plan(self) -> None:
        action = decide(blank())
        self.assertEqual(ActionKind.PLAN, action.kind)
        self.assertEqual(plan_job_id(blank()), action.effect_id)

    def test_b_plan_result_absent_is_idle(self) -> None:
        snapshot = blank()
        requested = plan_job_id(snapshot)
        action = decide(replace(snapshot, gpt_pending=frozenset({requested})))
        self.assertEqual(ActionKind.IDLE, action.kind)

    def test_late_plan_response_from_old_head_is_stale_without_work(self) -> None:
        original, old_spec = with_spec(blank())
        moved = replace(original, head=H2, specs=())
        action = decide(moved)
        self.assertEqual(ActionKind.PLAN, action.kind)
        self.assertNotEqual(plan_job_id(original), action.effect_id)

    def test_base_drift_alone_does_not_invalidate_current_spec(self) -> None:
        snapshot, spec = with_spec(blank())
        action = decide(replace(snapshot, base=B2))
        self.assertEqual(ActionKind.WORK, action.kind)
        self.assertEqual(spec.spec_id, action.payload["spec_id"])

    def test_gpt_wait_stops_for_manual_handling_without_wait_state(self) -> None:
        snapshot = blank()
        job = plan_job_id(snapshot)
        result = GptResult(job, "PLAN_GPT", "WAIT", "not before tomorrow")
        action = decide(replace(snapshot, gpt_results=(result,)))
        self.assertEqual(ActionKind.HUMAN, action.kind)
        self.assertIn("WAIT", action.reason)

    def test_c_spec_requests_work(self) -> None:
        snapshot, spec = with_spec(blank())
        action = decide(snapshot)
        self.assertEqual(ActionKind.WORK, action.kind)
        self.assertEqual(spec.spec_id, action.payload["spec_id"])

    def test_e_confirmed_work_failure_requests_judge(self) -> None:
        snapshot, spec = with_spec(blank())
        effect = work_effect_id(snapshot, spec)
        failure = WorkFact(
            effect,
            spec.spec_id,
            snapshot.head,
            Observation.FAIL,
            "durable-work-failure",
        )
        action = decide(replace(snapshot, work_facts=(failure,)))
        self.assertEqual(ActionKind.JUDGE, action.kind)
        self.assertEqual("WORK", action.payload["failed_step"])

    def test_f_return_work_keys_a_new_work_effect_from_judge(self) -> None:
        snapshot, spec = with_spec(blank())
        first_effect = work_effect_id(snapshot, spec)
        failure = WorkFact(
            first_effect,
            spec.spec_id,
            snapshot.head,
            Observation.FAIL,
            "durable-work-failure",
        )
        judge = judge_job_id(
            snapshot,
            spec,
            failed_step="WORK",
            evidence_id=first_effect,
            evidence_digest=failure.evidence_digest,
        )
        result = GptResult(judge, "JUDGE_GPT", "RETURN_WORK", "Try the bounded fix again")
        action = decide(
            replace(
                snapshot,
                work_facts=(failure,),
                gpt_results=snapshot.gpt_results + (result,),
            )
        )
        self.assertEqual(ActionKind.WORK, action.kind)
        self.assertNotEqual(first_effect, action.effect_id)
        self.assertEqual(judge, action.payload["trigger_judge_id"])

    def test_g_new_head_makes_old_proof_stale_by_identity(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work1 = work_pass(snapshot, spec)
        old_proof = proof_pass(snapshot, spec)
        moved = replace(snapshot, head=H2)
        work2 = work_pass(moved, spec, input_head=H1)
        action = decide(replace(moved, work_facts=(work1, work2), proof_facts=(old_proof,)))
        self.assertEqual(ActionKind.PROVE, action.kind)
        self.assertEqual(H2, action.payload["head"])
        self.assertNotEqual(old_proof.proof_id, action.effect_id)

    def test_h_return_plan_selects_new_spec_and_old_evidence_is_stale(self) -> None:
        snapshot, first = with_spec(blank(), "First plan")
        first_work_id = work_effect_id(snapshot, first)
        failure = WorkFact(
            first_work_id,
            first.spec_id,
            H0,
            Observation.FAIL,
            "work-failed",
        )
        judge = judge_job_id(
            snapshot,
            first,
            failed_step="WORK",
            evidence_id=first_work_id,
            evidence_digest=failure.evidence_digest,
        )
        return_plan = GptResult(judge, "JUDGE_GPT", "RETURN_PLAN", "Plan assumption was wrong")
        awaiting = replace(
            snapshot,
            work_facts=(failure,),
            gpt_results=snapshot.gpt_results + (return_plan,),
        )
        plan_action = decide(awaiting)
        self.assertEqual(ActionKind.PLAN, plan_action.kind)

        second_text = "Second plan"
        second_planning = plan_facts_digest(awaiting)
        second = SpecFact(
            spec_id(awaiting.charter_digest, second_planning, second_text),
            second_text,
            parent_spec_id=first.spec_id,
            trigger_judge_id=judge,
        )
        second_plan_result = GptResult(
            plan_action.effect_id or "", "PLAN_GPT", "SPEC", second_text
        )
        old_proof = ProofFact(
            "old-proof",
            first.spec_id,
            H0,
            B1,
            Observation.PASS,
            "old-proof-digest",
        )
        action = decide(
            replace(
                awaiting,
                specs=(first, second),
                gpt_results=awaiting.gpt_results + (second_plan_result,),
                proof_facts=(old_proof,),
            )
        )
        self.assertEqual(ActionKind.WORK, action.kind)
        self.assertEqual(second.spec_id, action.payload["spec_id"])

    def test_j_mechanical_prove_failure_requests_judge(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work = work_pass(snapshot, spec)
        proof = ProofFact(
            proof_id(snapshot, spec),
            spec.spec_id,
            H1,
            B1,
            Observation.FAIL,
            "tests-failed",
        )
        action = decide(replace(snapshot, work_facts=(work,), proof_facts=(proof,)))
        self.assertEqual(ActionKind.JUDGE, action.kind)
        self.assertEqual("PROVE_MECHANICAL", action.payload["failed_step"])

    def test_stale_judge_response_cannot_satisfy_new_evidence_identity(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work = work_pass(snapshot, spec, input_head=H0)
        first_proof = ProofFact(
            proof_id(snapshot, spec),
            spec.spec_id,
            H1,
            B1,
            Observation.FAIL,
            "first-failure",
        )
        first = decide(replace(snapshot, work_facts=(work,), proof_facts=(first_proof,)))
        self.assertEqual(ActionKind.JUDGE, first.kind)
        stale = GptResult(
            first.effect_id or "",
            "JUDGE_GPT",
            "RETURN_PROVE",
            "rerun proof",
        )
        changed_proof = replace(first_proof, evidence_digest="new-failure")
        current = decide(
            replace(
                snapshot,
                work_facts=(work,),
                proof_facts=(changed_proof,),
                gpt_results=snapshot.gpt_results + (stale,),
            )
        )
        self.assertEqual(ActionKind.JUDGE, current.kind)
        self.assertNotEqual(first.effect_id, current.effect_id)

    def test_return_prove_rekeys_proof_without_repair_state(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work = work_pass(snapshot, spec)
        failed = ProofFact(
            proof_id(snapshot, spec),
            spec.spec_id,
            H1,
            B1,
            Observation.FAIL,
            "proof-failure",
        )
        judge = judge_job_id(
            snapshot,
            spec,
            failed_step="PROVE_MECHANICAL",
            evidence_id=failed.proof_id,
            evidence_digest=failed.evidence_digest,
        )
        result = GptResult(judge, "JUDGE_GPT", "RETURN_PROVE", "Rerun external proof")
        action = decide(
            replace(
                snapshot,
                work_facts=(work,),
                proof_facts=(failed,),
                gpt_results=snapshot.gpt_results + (result,),
            )
        )
        self.assertEqual(ActionKind.PROVE, action.kind)
        self.assertNotEqual(failed.proof_id, action.effect_id)
        self.assertEqual(judge, action.payload["trigger_judge_id"])

    def test_prove_failure_can_return_to_work_without_repair_state(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work = work_pass(snapshot, spec)
        failed = ProofFact(
            proof_id(snapshot, spec),
            spec.spec_id,
            H1,
            B1,
            Observation.FAIL,
            "proof-failure",
        )
        judge = judge_job_id(
            snapshot,
            spec,
            failed_step="PROVE_MECHANICAL",
            evidence_id=failed.proof_id,
            evidence_digest=failed.evidence_digest,
        )
        result = GptResult(judge, "JUDGE_GPT", "RETURN_WORK", "Correct the implementation")
        action = decide(
            replace(
                snapshot,
                work_facts=(work,),
                proof_facts=(failed,),
                gpt_results=snapshot.gpt_results + (result,),
            )
        )
        self.assertEqual(ActionKind.WORK, action.kind)
        self.assertEqual(judge, action.payload["trigger_judge_id"])

    def test_k_mechanical_and_semantic_pass_make_prove_pass(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work = work_pass(snapshot, spec)
        proof = proof_pass(snapshot, spec)
        semantic = GptResult(
            semantic_judge_job_id(snapshot, spec, proof),
            "JUDGE_GPT",
            "PASS",
            "The implementation satisfies the charter and spec.",
        )
        ready = replace(
            snapshot,
            work_facts=(work,),
            proof_facts=(proof,),
            gpt_results=snapshot.gpt_results + (semantic,),
            merge=merge_facts(snapshot, spec),
        )
        self.assertEqual(ActionKind.MERGE_READY, decide(ready).kind)

    def test_l_base_drift_invalidates_old_integration_proof(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work = work_pass(snapshot, spec)
        old_proof = proof_pass(snapshot, spec)
        drifted = replace(snapshot, base=B2, work_facts=(work,), proof_facts=(old_proof,))
        action = decide(drifted)
        self.assertEqual(ActionKind.PROVE, action.kind)
        self.assertEqual(B2, action.payload["base"])

    def test_m_merge_permission_false_reports_ready_without_merge(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work = work_pass(snapshot, spec)
        proof = proof_pass(snapshot, spec)
        semantic = GptResult(
            semantic_judge_job_id(snapshot, spec, proof),
            "JUDGE_GPT",
            "PASS",
            "Pass",
        )
        action = decide(
            replace(
                snapshot,
                work_facts=(work,),
                proof_facts=(proof,),
                gpt_results=snapshot.gpt_results + (semantic,),
                merge=merge_facts(snapshot, spec),
                allow_merge=False,
            )
        )
        self.assertEqual(ActionKind.MERGE_READY, action.kind)
        self.assertNotEqual(ActionKind.MERGE, action.kind)

    def test_pr_base_drift_blocks_merge_even_when_live_base_matches(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work = work_pass(snapshot, spec)
        proof = proof_pass(snapshot, spec)
        semantic = GptResult(
            semantic_judge_job_id(snapshot, spec, proof),
            "JUDGE_GPT",
            "PASS",
            "Pass",
        )
        action = decide(
            replace(
                snapshot,
                work_facts=(work,),
                proof_facts=(proof,),
                gpt_results=snapshot.gpt_results + (semantic,),
            merge=replace(merge_facts(snapshot, spec), pr_base_sha=B2),
            )
        )
        self.assertEqual(ActionKind.IDLE, action.kind)
        self.assertIn("PR BASE drift", action.payload["failures"])

    def test_merge_fences_reject_foreign_draft_and_nonmergeable_prs(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        cases = (
            ("foreign", replace(merge_facts(snapshot, spec), owner_token="foreign"),
             "resource ownership mismatch"),
            ("draft", replace(merge_facts(snapshot, spec), draft=True), "PR is draft or unknown"),
            ("nonmergeable", replace(merge_facts(snapshot, spec), mergeable=False),
             "PR is not confirmed mergeable"),
        )
        for name, facts, expected in cases:
            with self.subTest(name=name):
                self.assertIn(expected, merge_fence_failures(
                    replace(snapshot, merge=facts), spec
                ))

    def test_n_merge_fence_drift_never_calls_merge(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1, allow_merge=True))
        work = work_pass(snapshot, spec)
        proof = proof_pass(snapshot, spec)
        semantic = GptResult(
            semantic_judge_job_id(snapshot, spec, proof),
            "JUDGE_GPT",
            "PASS",
            "Pass",
        )
        ready = replace(
            snapshot,
            work_facts=(work,),
            proof_facts=(proof,),
            gpt_results=snapshot.gpt_results + (semantic,),
            merge=merge_facts(snapshot, spec),
        )
        merge_action = decide(ready)
        self.assertEqual(ActionKind.MERGE, merge_action.kind)
        drifted = replace(ready, base=B2)
        called = False

        def reader(_paths: PPaths, *, allow_merge: bool) -> Snapshot:
            self.assertTrue(allow_merge)
            return drifted

        def runner(*_args: object, **_kwargs: object):
            nonlocal called
            called = True
            raise AssertionError("merge command must not run after drift")

        with tempfile.TemporaryDirectory() as directory, \
                patch("tools.agentbus_v2.effects.read_snapshot", side_effect=reader), \
                patch("tools.agentbus_v2.effects.merge_pr", side_effect=runner):
            result = execute_merge(PPaths(Path(directory)), merge_action)
        self.assertFalse(result.changed)
        self.assertFalse(called)

    def test_o_restart_same_facts_gives_same_effect(self) -> None:
        snapshot, _ = with_spec(blank())
        self.assertEqual(decide(snapshot), decide(snapshot))

    def test_merge_response_loss_recovers_done_from_remote_facts(self) -> None:
        snapshot, spec = with_spec(replace(blank(), head=H1))
        work = work_pass(snapshot, spec)
        proof = proof_pass(snapshot, spec)
        semantic = GptResult(
            semantic_judge_job_id(snapshot, spec, proof),
            "JUDGE_GPT",
            "PASS",
            "Pass",
        )
        merged = replace(
            merge_facts(snapshot, spec),
            state="MERGED",
            mergeable=None,
            merge_commit_sha="c" * 40,
            merge_parents=(B1, H1),
        )
        after_merge = replace(
            snapshot,
            base=B2,
            work_facts=(work,),
            proof_facts=(proof,),
            gpt_results=snapshot.gpt_results + (semantic,),
            merge=merged,
        )
        self.assertEqual(ActionKind.DONE, decide(after_merge).kind)


if __name__ == "__main__":
    unittest.main()
