from __future__ import annotations

import json
import os

from agentbus.apply import apply_envelope
from agentbus.decision import (
    AUDIT,
    DONE,
    FINAL_GPT,
    FINAL_REVIEW,
    HUMAN,
    IMPL,
    MERGE,
    NEXT,
    PLAN_SPEC,
    PRODUCT_GPT,
    WAIT,
    browser_job_id,
    derive_next_action,
    final_review_for_current,
    normalize_final_status,
)
from agentbus.machine import BLOCKED_FOR_REVIEW, FINAL_GATE, IMPLEMENTING, MERGED, MERGE_PENDING, READY_FOR_GPT
from agentbus.mergegate import MODE_AUTONOMOUS, autonomous_merge
from agentbus.models import empty_state
from agentbus.protocol import Envelope, parse_comment_envelope, render_envelope
from agentbus.tests.harness import AgentbusTest


class SolTargetDecisionTests(AgentbusTest):
    def ready_state(self, stream: str = "sol-a", pr: int = 44) -> tuple[dict, dict, str]:
        head = "a" * 40
        base = "b" * 40
        state = empty_state(stream)
        state["pr"] = pr
        state["phase"] = FINAL_GATE
        state["impl_worktree"] = self.repo
        state["review_policy"] = "GPT_REQUIRED"
        state["heads"].update({"current": head, "implemented": head, "audited": head, "reviewed": head})
        state["publication"].update({"status": "pushed", "commit": head, "files": [], "report_comment_id": "101"})
        state["envelopes"]["CODEX_REPORT"] = {
            "kind": "CODEX_REPORT",
            "status": "READY_FOR_AUDIT",
            "head": head,
            "source": "github",
            "source_id": "101",
            "digest": "report-current",
            "raw": f"[CODEX_REPORT]\nSTATUS: READY_FOR_AUDIT\nSTREAM: {stream}\nIMPLEMENTED_HEAD: {head}\n",
            "fields": {"STATUS": "READY_FOR_AUDIT", "STREAM": stream, "IMPLEMENTED_HEAD": head},
        }
        state["envelopes"]["CODEX_AUDIT"] = {
            "kind": "CODEX_AUDIT",
            "status": "PASS",
            "head": head,
            "source": "github",
            "source_id": "102",
            "digest": "audit-current",
            "raw": f"[CODEX_AUDIT]\nSTATUS: PASS\nSTREAM: {stream}\nAUDITED_HEAD: {head}\nFINDINGS: none\n",
            "fields": {"STATUS": "PASS", "STREAM": stream, "AUDITED_HEAD": head, "FINDINGS": "none"},
        }
        state["envelopes"]["GPT_REVIEW"] = {
            "kind": "GPT_REVIEW",
            "status": "ACCEPT",
            "head": head,
            "source": "github",
            "source_id": "103",
            "digest": "product-current",
            "raw": f"[GPT_REVIEW]\nSTATUS: ACCEPT\nSTREAM: {stream}\nREVIEWED_HEAD: {head}\n",
            "fields": {"STATUS": "ACCEPT", "STREAM": stream, "REVIEWED_HEAD": head},
        }
        live = {
            "number": pr,
            "headRefOid": head,
            "baseRefOid": base,
            "state": "OPEN",
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [],
        }
        state["github"]["pr"] = dict(live)
        return state, live, head

    def final_envelope(
        self,
        state: dict,
        live: dict,
        status: str,
        *,
        source: str = "github",
        source_id: str = "900",
    ) -> Envelope:
        job_id = browser_job_id(state, None, live, role=FINAL_GPT, task=FINAL_REVIEW)
        envelope = Envelope(
            kind="GPT_MERGE_REVIEW",
            fields={
                "STATUS": status,
                "STREAM": state["stream_id"],
                "PR": str(state["pr"]),
                "JOB_ID": job_id,
                "REVIEWED_HEAD": state["heads"]["implemented"],
                "REVIEWED_BASE": live["baseRefOid"],
                "SUMMARY": f"{status} exact current revision",
                "FINDINGS": "- none" if status == "PASS" else "- concrete result",
            },
            source=source,
            source_id=source_id,
        )
        envelope.raw = render_envelope(envelope)
        return envelope

    def install_final(self, state: dict, live: dict, status: str, **kwargs) -> Envelope:
        envelope = self.final_envelope(state, live, status, **kwargs)
        state["envelopes"]["GPT_MERGE_REVIEW"] = envelope.as_record()
        return envelope

    def spec_envelope(self, state: dict, *, source_id: str) -> Envelope:
        head = state["heads"]["current"]
        envelope = Envelope(
            kind="GPT_SPEC",
            fields={
                "STATUS": "ACTIONABLE",
                "STREAM": state["stream_id"],
                "GOAL": "focused repair",
                "TARGET": "README.md",
                "BASE_HEAD": head,
                "SCOPE": "README.md",
                "OUT_OF_SCOPE": "all other paths",
                "ACCEPTANCE_CRITERIA": "focused repair is validated",
                "REQUIRED_VALIDATION": "python3 -m unittest",
                "PATH_SCOPE": "README.md",
                "NEXT_ACTION": "IMPL",
            },
            source="github",
            source_id=source_id,
        )
        envelope.raw = render_envelope(envelope)
        return envelope

    def report_envelope(self, state: dict, *, source_id: str = "report-new") -> Envelope:
        head = state["heads"]["current"]
        envelope = Envelope(
            kind="CODEX_REPORT",
            fields={
                "STATUS": "READY_FOR_AUDIT",
                "STREAM": state["stream_id"],
                "IMPLEMENTED_HEAD": head,
                "CHANGED_FILES": "README.md",
                "VALIDATION": "python3 -m unittest",
                "NEXT_ACTION": "AUDIT",
            },
            source="github",
            source_id=source_id,
        )
        envelope.raw = render_envelope(envelope)
        return envelope

    def audit_envelope(self, state: dict, *, source_id: str = "audit-new") -> Envelope:
        head = state["heads"]["current"]
        envelope = Envelope(
            kind="CODEX_AUDIT",
            fields={
                "STATUS": "PASS",
                "STREAM": state["stream_id"],
                "AUDITED_HEAD": head,
                "FINDINGS": "none",
                "NEXT_ACTION": "GPT_REVIEW",
            },
            source="github",
            source_id=source_id,
        )
        envelope.raw = render_envelope(envelope)
        return envelope

    def test_one_derive_function_covers_every_canonical_action(self) -> None:
        actions = set()

        state = empty_state("need-spec")
        actions.add(derive_next_action(state).action)

        state = empty_state("impl")
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "status": "ACTIONABLE",
            "head": "a" * 40,
            "fields": {"STATUS": "ACTIONABLE", "BASE_HEAD": "a" * 40},
        }
        actions.add(derive_next_action(state).action)

        state, live, head = self.ready_state("audit")
        state["envelopes"].pop("CODEX_AUDIT")
        state["envelopes"].pop("GPT_REVIEW")
        actions.add(derive_next_action(state, live=live).action)

        state, live, _ = self.ready_state("product")
        state["envelopes"].pop("GPT_REVIEW")
        actions.add(derive_next_action(state, live=live).action)

        state, live, _ = self.ready_state("final")
        actions.add(derive_next_action(state, live=live).action)

        state, live, _ = self.ready_state("merge")
        self.install_final(state, live, "PASS")
        actions.add(derive_next_action(state, live=live).action)

        state = empty_state("next")
        state["phase"] = MERGED
        state["heads"]["merged"] = head
        state["continuation"] = {"created_stream": "next-b"}
        actions.add(derive_next_action(state).action)

        state, live, _ = self.ready_state("ci-wait")
        live["statusCheckRollup"] = [{"name": "required", "status": "IN_PROGRESS", "conclusion": ""}]
        state["github"]["pr"] = live
        actions.add(derive_next_action(state, live=live).action)

        state = empty_state("human")
        state["phase"] = BLOCKED_FOR_REVIEW
        actions.add(derive_next_action(state).action)

        state = empty_state("done")
        state["archived"] = True
        actions.add(derive_next_action(state).action)

        self.assertEqual(actions, {PRODUCT_GPT, IMPL, AUDIT, FINAL_GPT, MERGE, NEXT, WAIT, HUMAN, DONE})

    def test_stale_sha_and_compatibility_phase_cannot_advance(self) -> None:
        state, live, _ = self.ready_state("stale")
        state["phase"] = FINAL_GATE
        state["envelopes"]["CODEX_REPORT"]["head"] = "c" * 40
        state["envelopes"]["CODEX_REPORT"]["fields"]["IMPLEMENTED_HEAD"] = "c" * 40
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "status": "ACTIONABLE",
            "head": "a" * 40,
            "fields": {"STATUS": "ACTIONABLE", "BASE_HEAD": "a" * 40},
        }
        self.assertEqual(derive_next_action(state, live=live).action, IMPL)

        state, live, head = self.ready_state("durable-repair")
        state["phase"] = READY_FOR_GPT
        state["envelopes"]["GPT_REVIEW"].update(status="CHANGES_REQUIRED")
        state["envelopes"]["GPT_REVIEW"]["fields"].update(
            {"STATUS": "CHANGES_REQUIRED", "REVIEWED_HEAD": head}
        )
        self.assertEqual(derive_next_action(state, live=live).action, IMPL)

    def test_scope_insufficient_blocked_report_requests_same_unit_replan(self) -> None:
        state, live, head = self.ready_state("scope-replan")
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "status": "ACTIONABLE",
            "head": "b" * 40,
            "source": "github",
            "source_id": "100",
            "fields": {"STATUS": "ACTIONABLE", "BASE_HEAD": "b" * 40},
        }
        state["envelopes"]["CODEX_AUDIT"].update(
            status="CHANGES_REQUIRED",
            fields={
                "STATUS": "CHANGES_REQUIRED",
                "STREAM": state["stream_id"],
                "AUDITED_HEAD": head,
                "FINDINGS": "- exact-head finding",
            },
        )
        state["envelopes"]["CODEX_REPORT"].update(
            fields={
                "STATUS": "READY_FOR_AUDIT",
                "STREAM": state["stream_id"],
                "IMPLEMENTED_HEAD": head,
                "BASE_HEAD": "b" * 40,
                "VERDICT": "BLOCKED",
                "BLOCKER": "approved scope is insufficient for the required primitive",
            }
        )
        self.assertEqual(derive_next_action(state, live=live).action, PRODUCT_GPT)
        decision = derive_next_action(state, live=live)
        self.assertEqual(decision.task, PLAN_SPEC)
        self.assertTrue(decision.evidence["scope_blocked"])

    def test_ordinary_audit_changes_required_stays_impl(self) -> None:
        state, live, head = self.ready_state("ordinary-audit-repair")
        state["envelopes"]["CODEX_AUDIT"].update(
            status="CHANGES_REQUIRED",
            fields={
                "STATUS": "CHANGES_REQUIRED",
                "STREAM": state["stream_id"],
                "AUDITED_HEAD": head,
                "FINDINGS": "- implementable in-scope finding",
            },
        )
        self.assertEqual(derive_next_action(state, live=live).action, IMPL)

    def test_blocked_report_does_not_override_capacity_wait(self) -> None:
        state, live, head = self.ready_state("blocked-capacity")
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "status": "ACTIONABLE",
            "head": "b" * 40,
            "source": "github",
            "source_id": "100",
            "fields": {"STATUS": "ACTIONABLE", "BASE_HEAD": "b" * 40},
        }
        state["envelopes"]["CODEX_REPORT"]["fields"].update(
            {"BASE_HEAD": "b" * 40, "VERDICT": "BLOCKED", "BLOCKER": "scope is insufficient"}
        )
        state["wait"] = {"kind": "CODEX_CAPACITY", "reason": "quota exhausted"}
        self.assertEqual(derive_next_action(state, live=live).action, WAIT)

    def test_stale_blocked_report_does_not_replan_new_spec(self) -> None:
        state, live, head = self.ready_state("stale-blocked")
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "status": "ACTIONABLE",
            "head": "b" * 40,
            "source": "github",
            "source_id": "100",
            "fields": {"STATUS": "ACTIONABLE", "BASE_HEAD": "b" * 40},
        }
        state["envelopes"]["CODEX_REPORT"]["fields"].update(
            {"BASE_HEAD": "b" * 40, "VERDICT": "BLOCKED", "BLOCKER": "scope is insufficient"}
        )
        state["envelopes"]["GPT_SPEC"]["head"] = "c" * 40
        state["envelopes"]["GPT_SPEC"]["fields"]["BASE_HEAD"] = "c" * 40
        self.assertNotEqual(derive_next_action(state, live=live).action, PRODUCT_GPT)

        state, live, head = self.ready_state("stale-blocked-generation")
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "status": "ACTIONABLE",
            "head": "b" * 40,
            "source": "github",
            "source_id": "200",
            "fields": {"STATUS": "ACTIONABLE", "BASE_HEAD": "b" * 40},
        }
        state["envelopes"]["CODEX_REPORT"]["source_id"] = "100"
        state["envelopes"]["CODEX_REPORT"]["fields"].update(
            {"BASE_HEAD": "b" * 40, "VERDICT": "BLOCKED", "BLOCKER": "scope is insufficient"}
        )
        self.assertNotEqual(derive_next_action(state, live=live).action, PRODUCT_GPT)

    def test_replan_browser_job_is_stable_and_self_identifies_revision(self) -> None:
        state, live, head = self.ready_state("replan-job")
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "status": "ACTIONABLE",
            "head": "b" * 40,
            "source": "github",
            "source_id": "100",
            "fields": {"STATUS": "ACTIONABLE", "BASE_HEAD": "b" * 40},
        }
        state["envelopes"]["CODEX_AUDIT"].update(status="CHANGES_REQUIRED")
        state["envelopes"]["CODEX_AUDIT"]["fields"].update(
            {"STATUS": "CHANGES_REQUIRED", "AUDITED_HEAD": head}
        )
        state["envelopes"]["CODEX_REPORT"]["fields"].update(
            {"BASE_HEAD": "b" * 40, "VERDICT": "BLOCKED", "BLOCKER": "scope is insufficient"}
        )
        state["browser_gpt"] = {"url": "https://chatgpt.com/c/replan-job"}
        from agentbus.browser import job_for_state

        first = job_for_state(self.ctx, state)
        second = job_for_state(self.ctx, state)
        self.assertIsNotNone(first)
        self.assertEqual(first.job_id, second.job_id)
        self.assertIn("revision of the current blocked GPT_SPEC", first.prompt)
        self.assertIn("same stream and PR", first.prompt)
        self.assertIn("independent Final GPT findings", first.prompt)

    def test_final_statuses_and_legacy_normalization(self) -> None:
        expected = {"PASS": MERGE, "REPAIR": IMPL, "WAIT": WAIT, "HUMAN": HUMAN}
        for status, action in expected.items():
            state, live, _ = self.ready_state(f"final-{status.lower()}")
            self.install_final(state, live, status)
            self.assertEqual(derive_next_action(state, live=live).action, action, status)
        self.assertEqual(
            normalize_final_status(
                {"status": "HOLD", "fields": {"RECOMMENDATION": "DO_NOT_MERGE", "NEXT_ACTION": "IMPL"}}
            ),
            "REPAIR",
        )
        self.assertEqual(normalize_final_status({"status": "HUMAN_DECISION", "fields": {}}), HUMAN)

    def test_wrong_final_fences_and_local_source_are_rejected(self) -> None:
        mutations = (
            ("stream", lambda rec: rec["fields"].__setitem__("STREAM", "wrong")),
            ("pr", lambda rec: rec["fields"].__setitem__("PR", "99")),
            ("head", lambda rec: rec["fields"].__setitem__("REVIEWED_HEAD", "c" * 40)),
            ("base", lambda rec: rec["fields"].__setitem__("REVIEWED_BASE", "d" * 40)),
        )
        for label, mutate in mutations:
            state, live, _ = self.ready_state(f"wrong-{label}")
            self.install_final(state, live, "PASS")
            mutate(state["envelopes"]["GPT_MERGE_REVIEW"])
            if label == "head":
                state["envelopes"]["GPT_MERGE_REVIEW"]["head"] = "c" * 40
            self.assertIsNone(final_review_for_current(state, None, live), label)
            self.assertEqual(derive_next_action(state, live=live).action, FINAL_GPT, label)
        state, live, _ = self.ready_state("local-final")
        self.install_final(state, live, "PASS", source="local", source_id="")
        self.assertIsNone(final_review_for_current(state, None, live))
        self.assertEqual(derive_next_action(state, live=live).action, FINAL_GPT)

    def test_final_repair_reuses_pipeline_exactly_once_and_stales_on_new_head(self) -> None:
        self.create_stream("repair-final", "--pr", "44")
        store = self.store("repair-final")
        state, live, _ = self.ready_state("repair-final")
        envelope = self.final_envelope(state, live, "REPAIR", source_id="repair-1")
        apply_envelope(store, state, envelope, repo=self.repo, current_head=state["heads"]["current"])
        store.save(state)
        self.assertEqual(state["phase"], IMPLEMENTING)
        self.assertEqual(state["repair_cycles"], 1)
        self.assertEqual(derive_next_action(state, live=live).action, IMPL)

        apply_envelope(store, state, envelope, repo=self.repo, current_head=state["heads"]["current"])
        self.assertEqual(state["repair_cycles"], 1)

        new_head = "e" * 40
        state["heads"].update({"current": new_head, "implemented": new_head, "audited": new_head, "reviewed": new_head})
        state["publication"]["commit"] = new_head
        for kind, field in (("CODEX_REPORT", "IMPLEMENTED_HEAD"), ("CODEX_AUDIT", "AUDITED_HEAD"), ("GPT_REVIEW", "REVIEWED_HEAD")):
            state["envelopes"][kind]["head"] = new_head
            state["envelopes"][kind]["fields"][field] = new_head
        live = dict(live, headRefOid=new_head)
        state["github"]["pr"] = live
        self.assertIsNone(final_review_for_current(state, None, live))
        self.assertEqual(derive_next_action(state, live=live).action, FINAL_GPT)

    def test_final_repair_budget_exhaustion_requests_product_replan(self) -> None:
        self.create_stream("repair-max", "--pr", "44")
        store = self.store("repair-max")
        state, live, _ = self.ready_state("repair-max")
        state["repair_cycles"] = state["max_repair_cycles"]
        envelope = self.final_envelope(state, live, "REPAIR", source_id="repair-max")
        apply_envelope(store, state, envelope, repo=self.repo, current_head=state["heads"]["current"])
        self.assertEqual(state["phase"], BLOCKED_FOR_REVIEW)
        self.assertEqual(state["repair_cycles"], state["max_repair_cycles"])
        decision = derive_next_action(state, live=live)
        self.assertEqual(decision.action, PRODUCT_GPT)
        self.assertEqual(decision.task, PLAN_SPEC)
        self.assertEqual(decision.reason, "REPAIR_EPOCH_EXHAUSTED_REPLAN")

    def test_repair_budget_is_epoch_scoped_and_history_survives_reports_and_specs(self) -> None:
        self.create_stream("repair-epochs", "--pr", "44")
        store = self.store("repair-epochs")
        state, live, head = self.ready_state("repair-epochs")

        first_spec = self.spec_envelope(state, source_id="spec-1")
        apply_envelope(store, state, first_spec, repo=self.repo, current_head=head, allow_stale=True)
        state["repair_cycles"] = 1
        state["spec_epoch_pending_implementation"] = False
        epoch_one = state["repair_epoch_id"]

        # Replaying the same durable authority is idempotent.
        apply_envelope(store, state, first_spec, repo=self.repo, current_head=head, allow_stale=True)
        self.assertEqual(state["repair_cycles"], 1)

        # New Codex evidence is not a repair-epoch boundary.
        apply_envelope(
            store,
            state,
            self.report_envelope(state),
            repo=self.repo,
            current_head=head,
            allow_stale=True,
        )
        self.assertEqual(state["repair_cycles"], 1)
        apply_envelope(
            store,
            state,
            self.audit_envelope(state),
            repo=self.repo,
            current_head=head,
            allow_stale=True,
        )
        self.assertEqual(state["repair_cycles"], 1)

        # A new exact Product GPT authority starts the next bounded epoch and
        # retains the completed epoch as durable diagnostics.
        second_spec = self.spec_envelope(state, source_id="spec-2")
        apply_envelope(store, state, second_spec, repo=self.repo, current_head=head, allow_stale=True)
        self.assertNotEqual(state["repair_epoch_id"], epoch_one)
        self.assertEqual(state["repair_cycles"], 0)
        self.assertEqual(state["repair_epochs"][-1]["repair_count"], 1)
        self.assertTrue(any(item["id"] == epoch_one for item in state["repair_epochs"]))
        self.assertTrue(state["spec_epoch_pending_implementation"])

    def test_exhausted_repair_replans_once_then_human_after_second_epoch(self) -> None:
        self.create_stream("repair-replan-limit", "--pr", "44")
        store = self.store("repair-replan-limit")
        state, live, head = self.ready_state("repair-replan-limit")
        apply_envelope(
            store,
            state,
            self.spec_envelope(state, source_id="spec-first"),
            repo=self.repo,
            current_head=head,
            allow_stale=True,
        )
        state["spec_epoch_pending_implementation"] = False
        state["repair_cycles"] = state["max_repair_cycles"]
        exhausted = self.final_envelope(state, live, "REPAIR", source_id="final-first")
        apply_envelope(store, state, exhausted, repo=self.repo, current_head=head)
        self.assertEqual(derive_next_action(state, live=live).action, PRODUCT_GPT)
        self.assertEqual(state["repair_replan"]["pending"], True)

        from agentbus.browser import job_for_state, list_browser_jobs
        from agentbus.settings import note_browser_poll, set_global_binding

        set_global_binding(self.ctx, "PRODUCT_GPT", url="https://chatgpt.com/c/product")
        job = job_for_state(self.ctx, state)
        self.assertIsNotNone(job)
        self.assertEqual((job.role, job.task), (PRODUCT_GPT, PLAN_SPEC))
        self.assertIn("Final GPT REPAIR authority", job.prompt)
        self.assertIn("Current GPT_SPEC", job.prompt)
        self.assertIn("Remaining mandatory Final GPT findings", job.prompt)
        self.assertIn("Repair history", job.prompt)
        state_store = self.store("repair-replan-limit")
        state_store.save(state)
        jobs = [item for item in list_browser_jobs(self.ctx) if item["stream"] == "repair-replan-limit"]
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["task"], PLAN_SPEC)
        note_browser_poll(self.ctx)
        from agentbus.views import stream_view

        view = stream_view(self.ctx, store, env=dict(os.environ))
        self.assertEqual(view["attention_category"], "AUTO_WAIT")
        self.assertFalse(view["needs_you"])
        self.assertEqual(view["next_action"], PRODUCT_GPT)
        self.assertEqual(view["next_detail"], "REPAIR_EPOCH_EXHAUSTED_REPLAN")

        # The exact replacement authority starts epoch two. Its first repair
        # is again an implementation action, not an immediate human stop.
        apply_envelope(
            store,
            state,
            self.spec_envelope(state, source_id="spec-second"),
            repo=self.repo,
            current_head=head,
            allow_stale=True,
        )
        self.assertEqual(state["repair_replan_count"], 1)
        self.assertEqual(state["repair_cycles"], 0)
        first_repair = self.final_envelope(state, live, "REPAIR", source_id="final-second")
        apply_envelope(store, state, first_repair, repo=self.repo, current_head=head)
        self.assertEqual(state["repair_cycles"], 1)
        self.assertEqual(derive_next_action(state, live=live).action, IMPL)

        # A second exhaustion on the same bounded replan lineage is the real
        # circuit breaker and may escalate to a human.
        state["repair_cycles"] = state["max_repair_cycles"]
        second_exhaustion = self.final_envelope(state, live, "REPAIR", source_id="final-second-exhausted")
        apply_envelope(store, state, second_exhaustion, repo=self.repo, current_head=head)
        self.assertEqual(derive_next_action(state, live=live).action, HUMAN)
        self.assertEqual(derive_next_action(state, live=live).reason, "REPAIR_REPLAN_LIMIT_EXHAUSTED")
        store.save(state)
        view = stream_view(self.ctx, store, env=dict(os.environ))
        self.assertEqual(view["attention_category"], "NEEDS_YOU")

    def test_exhausted_ambiguous_repair_and_explicit_final_human_escalate_immediately(self) -> None:
        for suffix, marker in (("ambiguous", "SECURITY_AMBIGUITY"), ("explicit", "HUMAN")):
            state, live, head = self.ready_state(f"repair-{suffix}")
            state["repair_cycles"] = state["max_repair_cycles"]
            envelope = self.final_envelope(state, live, "REPAIR", source_id=f"final-{suffix}")
            envelope.fields["ACTIONABILITY"] = marker
            envelope.raw = render_envelope(envelope)
            state["envelopes"]["GPT_MERGE_REVIEW"] = envelope.as_record()
            decision = derive_next_action(state, live=live)
            self.assertEqual(decision.action, HUMAN)

    def _autonomous_fixture(self, stream: str, pr: int) -> tuple:
        self.create_stream(stream, "--pr", str(pr))
        store = self.store(stream)
        state, live, head = self.ready_state(stream, pr)
        envelope = self.final_envelope(state, live, "PASS", source_id=f"review-{pr}")
        apply_envelope(store, state, envelope, repo=self.repo, current_head=head)
        store.save(state)
        comments = os.path.join(self.root, f"{stream}-comments.json")
        prstate = os.path.join(self.root, f"{stream}-pr.json")
        merge_count = os.path.join(self.root, f"{stream}-merge-count.txt")
        with open(comments, "w", encoding="utf-8") as handle:
            json.dump([{"id": envelope.source_id, "body": envelope.raw}], handle)
        with open(prstate, "w", encoding="utf-8") as handle:
            json.dump(live, handle)
        with open(merge_count, "w", encoding="utf-8") as handle:
            handle.write("0")
        os.environ.update(
            {
                "YUVI_AGENTBUS_AUTONOMOUS_MERGE": "1",
                "FAKE_GH_COMMENTS": comments,
                "FAKE_GH_PR_STATE": prstate,
                "FAKE_GH_ALLOW_MERGE": "1",
                "FAKE_GH_REQUIRE_FINAL_GATE": "1",
                "FAKE_GH_MERGE_COUNT": merge_count,
                "FAKE_GH_HEAD": head,
            }
        )
        return store, state, envelope, comments, prstate, merge_count

    def test_autonomous_merge_publishes_truthful_gate_once_before_merge(self) -> None:
        store, _, envelope, comments, _, merge_count = self._autonomous_fixture("auto-pass", 71)
        first = autonomous_merge(self.ctx, store)
        self.assertTrue(first.get("merged"), first)
        self.assertEqual(store.load()["phase"], MERGED)
        with open(comments, encoding="utf-8") as handle:
            rows = json.load(handle)
        gates = [row for row in rows if "[FINAL_GATE]" in (row.get("body") or "")]
        self.assertEqual(len(gates), 1)
        gate = parse_comment_envelope(gates[0]["body"])
        self.assertIsNotNone(gate)
        self.assertEqual(gate.get("AUTHORIZED_BY"), "GPT_MERGE_REVIEW")
        self.assertEqual(gate.get("MODE"), MODE_AUTONOMOUS)
        self.assertEqual(gate.get("SOURCE_COMMENT_ID"), envelope.source_id)
        self.assertNotEqual(gate.get("AUTHORIZED_BY"), "HUMAN")
        with open(merge_count, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "1")

        second = autonomous_merge(self.ctx, store)
        self.assertTrue(second.get("already") or second.get("merged"), second)
        with open(merge_count, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "1")
        with open(comments, encoding="utf-8") as handle:
            rows = json.load(handle)
        self.assertEqual(sum("[FINAL_GATE]" in (row.get("body") or "") for row in rows), 1)

    def test_autonomous_merge_response_loss_adopts_remote_merged_result(self) -> None:
        store, _, _, _, _, merge_count = self._autonomous_fixture("auto-lost", 72)
        os.environ["FAKE_GH_MERGE_FAIL"] = "timeout_after_merge"
        result = autonomous_merge(self.ctx, store)
        self.assertTrue(result.get("merged"), result)
        self.assertEqual(store.load()["phase"], MERGED)
        with open(merge_count, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "1")

    def test_autonomous_crash_recovery_fetches_remote_before_retry(self) -> None:
        store, state, _, _, prstate, merge_count = self._autonomous_fixture("auto-recover", 74)
        state["phase"] = MERGE_PENDING
        state["merge_txn"] = {
            "autonomous_authorized": True,
            "human_authorized": False,
            "authorization_mode": MODE_AUTONOMOUS,
            "authorized_head": state["heads"]["implemented"],
            "status": "merging",
        }
        store.save(state)
        with open(prstate, "r", encoding="utf-8") as handle:
            live = json.load(handle)
        live["state"] = "MERGED"
        live["mergeCommit"] = {"oid": "d" * 40}
        with open(prstate, "w", encoding="utf-8") as handle:
            json.dump(live, handle)
        result = autonomous_merge(self.ctx, store)
        self.assertTrue(result.get("merged"), result)
        self.assertEqual(store.load()["phase"], MERGED)
        with open(merge_count, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "0")

    def test_autonomous_merge_requires_remote_final_review_comment(self) -> None:
        store, _, _, comments, _, merge_count = self._autonomous_fixture("auto-source", 73)
        with open(comments, "w", encoding="utf-8") as handle:
            json.dump([], handle)
        result = autonomous_merge(self.ctx, store)
        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("code"), "FINAL_REVIEW_UNVERIFIED")
        with open(merge_count, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "0")

    def test_wait_conditions_are_not_human(self) -> None:
        for kind in ("CODEX_CAPACITY", "BROWSER_CAPACITY", "BROWSER_OFFLINE", "GITHUB_TRANSIENT"):
            state = empty_state(f"wait-{kind.lower()}")
            state["wait"] = {"kind": kind, "reason": kind}
            decision = derive_next_action(state)
            self.assertEqual(decision.action, WAIT, kind)
            self.assertNotEqual(decision.action, HUMAN, kind)

    def test_failed_and_pending_ci_cannot_merge(self) -> None:
        for conclusion, status in (("FAILURE", "COMPLETED"), ("", "IN_PROGRESS")):
            state, live, _ = self.ready_state(f"ci-{status.lower()}")
            live["statusCheckRollup"] = [
                {"name": "required", "status": status, "conclusion": conclusion}
            ]
            state["github"]["pr"] = live
            if status == "COMPLETED":
                self.install_final(state, live, "PASS")
            decision = derive_next_action(state, live=live)
            self.assertEqual(decision.action, WAIT)
            self.assertNotEqual(decision.action, MERGE)
