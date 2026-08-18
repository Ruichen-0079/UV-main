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

    def test_final_repair_budget_exhaustion_is_human(self) -> None:
        self.create_stream("repair-max", "--pr", "44")
        store = self.store("repair-max")
        state, live, _ = self.ready_state("repair-max")
        state["repair_cycles"] = state["max_repair_cycles"]
        envelope = self.final_envelope(state, live, "REPAIR", source_id="repair-max")
        apply_envelope(store, state, envelope, repo=self.repo, current_head=state["heads"]["current"])
        self.assertEqual(state["phase"], BLOCKED_FOR_REVIEW)
        self.assertEqual(state["repair_cycles"], state["max_repair_cycles"])
        self.assertEqual(derive_next_action(state, live=live).action, HUMAN)

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
