from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

from agentbus.autopilot import tick_stream
from agentbus.browser import _final_prompt
from agentbus.ci import (
    CIAdapter,
    cleanup_ci_branch,
    ci_branch_name,
    current_base_ci_matches,
    current_base_ci_required,
    reconcile_current_base_ci,
    synthetic_generation,
    verify_synthetic_merge,
)
from agentbus.decision import (
    FINAL_GPT,
    FINAL_REVIEW,
    WAIT,
    browser_job_id,
    current_base_ci_evidence,
    derive_next_action,
    deterministic_merge_fences,
    review_generation,
)
from agentbus.models import empty_state
from agentbus.tests.harness import AgentbusTest


class FakeCIAdapter(CIAdapter):
    def __init__(self, live: dict, *, merge: str = "c" * 40, live_base: str | None = None) -> None:
        self.live = dict(live)
        self.merge = merge
        self.live_base_sha = live_base or str(live.get("baseRefOid") or "")
        self.remote: dict[str, str] = {}
        self.pushes: list[tuple[str, str]] = []
        self.deletes: list[str] = []

    def pr_view(self, cwd: str, number: int, env=None) -> dict:
        return dict(self.live)

    def live_base(self, cwd: str, ref: str, env=None) -> str:
        return self.live_base_sha

    def git(self, args, *, cwd, env=None, timeout=60, input_text=None, extra_env=None):
        if args[:2] == ["ls-remote", "--heads"]:
            branch = args[-1].removeprefix("refs/heads/")
            sha = self.remote.get(branch)
            return (0, f"{sha}\trefs/heads/{branch}\n" if sha else "", "")
        if args[:1] == ["push"] and "--delete" in args:
            branch = args[-1]
            self.deletes.append(branch)
            self.remote.pop(branch, None)
            return 0, "", ""
        if args[:1] == ["push"]:
            spec = args[-1]
            merge, ref = spec.split(":refs/heads/", 1)
            self.remote[ref] = merge
            self.pushes.append((ref, merge))
            return 0, "", ""
        return 0, "", ""


class CurrentBaseCITests(AgentbusTest):
    def fixture(self) -> tuple[dict, dict, str, str, str]:
        self.create_stream("ci-s1")
        store = self.store("ci-s1")
        state = store.load()
        head = "a" * 40
        old_base = "b" * 40
        new_base = "d" * 40
        state.update({"pr": 45, "branch": "agentbus/ci-s1", "phase": "FINAL_GATE"})
        state["heads"].update({"current": head, "implemented": head, "last_seen": head, "spec_base": old_base})
        state["transport"] = {
            "owned": True,
            "materialized_by": "AGENTBUS",
            "status": "pr_ready",
            "pr": 45,
            "base_sha": old_base,
            "continuation_comment_id": "5330000001",
        }
        state["publication"] = {
            "status": "pushed",
            "pushed": True,
            "commit": head,
            "remote_sha": head,
            "history": [{"generation": 1, "commit": head, "parent": old_base}],
            "files": [],
        }

        def rec(kind: str, source_id: str, status: str, fields: dict) -> dict:
            all_fields = {"STATUS": status, "STREAM": "ci-s1", **fields}
            return {
                "kind": kind,
                "status": status,
                "head": head,
                "source": "github",
                "source_id": source_id,
                "fields": all_fields,
                "raw": json.dumps(all_fields, sort_keys=True),
            }

        state["envelopes"] = {
            "GPT_SPEC": rec(
                "GPT_SPEC",
                "5330000001",
                "ACTIONABLE",
                {"BASE_HEAD": old_base, "MATERIALIZED_BY": "AGENTBUS", "SOURCE_CONTINUATION_COMMENT_ID": "5330000001"},
            ),
            "CODEX_REPORT": rec("CODEX_REPORT", "5330000002", "READY_FOR_AUDIT", {"IMPLEMENTED_HEAD": head}),
            "CODEX_AUDIT": rec("CODEX_AUDIT", "5330000003", "PASS", {"AUDITED_HEAD": head}),
            "GPT_REVIEW": rec("GPT_REVIEW", "5330000004", "ACCEPT", {"REVIEWED_HEAD": head}),
        }
        live = {
            "number": 45,
            "headRefName": "agentbus/ci-s1",
            "headRefOid": head,
            "baseRefName": "main",
            "baseRefOid": new_base,
            "state": "OPEN",
            "isDraft": False,
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [],
        }
        state["github"]["pr"] = dict(live)
        store.save(state)
        return state, live, head, old_base, new_base

    def test_exact_current_merge_fence_rejects_stale_parent_or_head(self) -> None:
        base = "b" * 40
        head = "c" * 40
        tree = "d" * 40
        ok, _ = verify_synthetic_merge(
            parents=[base, head], merge_tree=tree, expected_tree=tree, base=base, head=head
        )
        self.assertTrue(ok)
        self.assertFalse(
            verify_synthetic_merge(
                parents=["1" * 40, head], merge_tree="e" * 40, expected_tree=tree, base=base, head=head
            )[0]
        )
        self.assertFalse(
            verify_synthetic_merge(
                parents=[base, "2" * 40], merge_tree="e" * 40, expected_tree=tree, base=base, head=head
            )[0]
        )

    def test_current_base_ci_pushes_once_and_running_is_wait(self) -> None:
        state, live, head, _, base = self.fixture()
        store = self.store("ci-s1")
        merge = "c" * 40
        adapter = FakeCIAdapter(live, merge=merge)
        with patch(
            "agentbus.ci.resolve_synthetic_merge",
            return_value={"ok": True, "synthetic_merge": merge, "source": "github_pull_merge"},
        ), patch("agentbus.ci._observe_run", return_value={"status": "RUNNING", "run_id": "7001"}):
            first = reconcile_current_base_ci(self.ctx, store, state, live, adapter=adapter)
            second = reconcile_current_base_ci(self.ctx, store, state, live, adapter=adapter)
        self.assertEqual(first["status"], "RUNNING")
        self.assertEqual(second["status"], "RUNNING")
        self.assertEqual(len(adapter.pushes), 1)
        self.assertTrue(current_base_ci_matches(state["current_base_ci"], pr=45, head=head, base=base))
        self.assertEqual(derive_next_action(state, live=live).action, WAIT)

    def test_draft_blocked_pr_still_materializes_exact_current_base_ci(self) -> None:
        state, live, head, _, base = self.fixture()
        store = self.store("ci-s1")
        blocked = dict(live)
        blocked.update({"isDraft": True, "mergeable": "CONFLICTING", "mergeStateStatus": "BLOCKED"})
        adapter = FakeCIAdapter(blocked, merge="e" * 40)
        with patch(
            "agentbus.ci.resolve_synthetic_merge",
            return_value={"ok": True, "synthetic_merge": "e" * 40, "source": "github_pull_merge"},
        ), patch("agentbus.ci._observe_run", return_value={"status": "RUNNING", "run_id": "7003"}):
            self.assertTrue(current_base_ci_required(state, blocked))
            result = reconcile_current_base_ci(self.ctx, store, state, blocked, adapter=adapter)
        self.assertEqual(result["status"], "RUNNING")
        self.assertEqual(len(adapter.pushes), 1)
        self.assertEqual(state["current_base_ci"]["head"], head)
        self.assertEqual(state["current_base_ci"]["base"], base)

    def test_legacy_spec_without_redundant_transport_marker_keeps_strong_ownership(self) -> None:
        state, live, _, _, _ = self.fixture()
        state["envelopes"]["GPT_SPEC"]["fields"].pop("MATERIALIZED_BY", None)
        self.assertTrue(current_base_ci_required(state, live))

    def test_git_merge_conflict_fails_closed_without_ci_push(self) -> None:
        state, live, _, _, _ = self.fixture()
        store = self.store("ci-s1")
        adapter = FakeCIAdapter(live)
        with patch(
            "agentbus.ci.resolve_synthetic_merge",
            return_value={"ok": False, "reason": "current base and PR HEAD cannot be merged cleanly"},
        ):
            result = reconcile_current_base_ci(self.ctx, store, state, live, adapter=adapter)
        self.assertEqual(result["status"], "WAIT")
        self.assertIn("cannot be merged cleanly", result["reason"])
        self.assertEqual(adapter.pushes, [])
        self.assertIsNone(state.get("current_base_ci"))

    def test_head_drift_during_fence_refuses_push(self) -> None:
        state, live, head, _, _ = self.fixture()
        store = self.store("ci-s1")
        fresh = dict(live)
        fresh["headRefOid"] = "f" * 40
        adapter = FakeCIAdapter(fresh)
        with patch("agentbus.ci.resolve_synthetic_merge") as resolve:
            result = reconcile_current_base_ci(self.ctx, store, state, live, adapter=adapter)
        self.assertEqual(result["status"], "WAIT")
        self.assertIn("HEAD/base/state drifted", result["reason"])
        resolve.assert_not_called()
        self.assertEqual(adapter.pushes, [])
        self.assertEqual(head, state["heads"]["implemented"])

    def test_base_advance_during_fence_refuses_stale_push(self) -> None:
        state, live, _, _, base = self.fixture()
        store = self.store("ci-s1")
        adapter = FakeCIAdapter(live, live_base="f" * 40)
        with patch("agentbus.ci.resolve_synthetic_merge") as resolve:
            result = reconcile_current_base_ci(self.ctx, store, state, live, adapter=adapter)
        self.assertEqual(result["status"], "WAIT")
        self.assertIn("remote base advanced", result["reason"])
        resolve.assert_not_called()
        self.assertEqual(adapter.pushes, [])
        self.assertNotEqual(base, adapter.live_base_sha)

    def test_historical_base_ci_pass_does_not_satisfy_current_base(self) -> None:
        state, live, head, historical, base = self.fixture()
        old_merge = "e" * 40
        state["current_base_ci"] = {
            "status": "PASS",
            "pr": 45,
            "head": head,
            "base": historical,
            "synthetic_merge": old_merge,
            "generation": synthetic_generation(pr=45, head=head, base=historical, synthetic_merge=old_merge),
            "workflow": "Check",
            "workflow_file": ".github/workflows/check.yml",
        }
        self.assertEqual(current_base_ci_evidence(state, live), {})
        self.assertEqual(derive_next_action(state, live=live).action, WAIT)
        self.assertFalse(deterministic_merge_fences(state, live=live)["ok"])
        self.assertNotEqual(historical, base)

    def test_duplicate_ticks_coalesce_one_synthetic_generation(self) -> None:
        state, live, _, _, _ = self.fixture()
        store = self.store("ci-s1")
        adapter = FakeCIAdapter(live, merge="e" * 40)
        with patch(
            "agentbus.ci.resolve_synthetic_merge",
            return_value={"ok": True, "synthetic_merge": "e" * 40, "source": "github_pull_merge"},
        ), patch("agentbus.ci._observe_run", return_value={"status": "RUNNING", "run_id": "7004"}):
            first = reconcile_current_base_ci(self.ctx, store, state, live, adapter=adapter)
            second = reconcile_current_base_ci(self.ctx, store, state, live, adapter=adapter)
        self.assertEqual(first["status"], "RUNNING")
        self.assertEqual(second["status"], "RUNNING")
        self.assertEqual(len(adapter.pushes), 1)
        self.assertEqual(first["record"]["generation"], second["record"]["generation"])

    def test_tick_reconciles_current_ci_before_ready_transition(self) -> None:
        state, live, _, _, _ = self.fixture()
        store = self.store("ci-s1")
        order: list[str] = []
        decision = SimpleNamespace(
            action=WAIT,
            task=None,
            reason="current-base CI is running",
            evidence={},
            as_dict=lambda: {"action": WAIT, "reason": "current-base CI is running"},
        )

        def fake_ci(*args, **kwargs):
            order.append("ci")
            return {"ok": True, "status": "RUNNING"}

        def fake_ready(*args, **kwargs):
            order.append("ready")
            return {"ok": True, "status": "not-eligible"}

        with patch("agentbus.runner.refresh_stream", return_value=[]), patch(
            "agentbus.autopilot.reconcile_durable", return_value=[]
        ), patch("agentbus.ci.reconcile_current_base_ci", side_effect=fake_ci), patch(
            "agentbus.autopilot.ensure_pr_reviewable", side_effect=fake_ready
        ), patch("agentbus.autopilot.maybe_gpt_handoff", return_value=None), patch(
            "agentbus.autopilot.ensure_executor_surface", return_value={"ok": True, "notes": []}
        ), patch("agentbus.decision.decision_for_stream", return_value=decision):
            tick_stream(self.ctx, store, sync_github=False, locked=True)
        self.assertEqual(order, ["ci", "ready"])

    def test_exact_pass_invalidates_old_final_generation_and_builds_new_prompt(self) -> None:
        state, live, head, _, base = self.fixture()
        old_job = browser_job_id(state, None, live, role=FINAL_GPT, task=FINAL_REVIEW)
        state["envelopes"]["GPT_MERGE_REVIEW"] = {
            "kind": "GPT_MERGE_REVIEW",
            "status": "WAIT",
            "head": head,
            "source": "github",
            "source_id": "5330000005",
            "fields": {
                "STATUS": "WAIT",
                "STREAM": "ci-s1",
                "PR": "45",
                "JOB_ID": old_job,
                "REVIEWED_HEAD": head,
                "REVIEWED_BASE": base,
            },
        }
        merge = "c" * 40
        generation = synthetic_generation(pr=45, head=head, base=base, synthetic_merge=merge)
        state["current_base_ci"] = {
            "status": "PASS",
            "result": "success",
            "pr": 45,
            "stream": "ci-s1",
            "head": head,
            "base": base,
            "synthetic_merge": merge,
            "source": "github_pull_merge",
            "generation": generation,
            "workflow": "Check",
            "workflow_file": ".github/workflows/check.yml",
            "branch": ci_branch_name("ci-s1", generation),
            "run_id": "7002",
            "checks": [],
        }
        self.assertNotEqual(review_generation(state, None, live, role=FINAL_GPT, task=FINAL_REVIEW), old_job.split(":")[-1])
        self.assertEqual(derive_next_action(state, live=live).action, FINAL_GPT)
        prompt = _final_prompt(
            {
                "job_id": "new-job",
                "role": FINAL_GPT,
                "task": FINAL_REVIEW,
                "campaign": "ci",
                "stream": "ci-s1",
                "pr": 45,
                "expected_head": head,
                "expected_base": base,
            },
            state,
        )
        self.assertIn(merge, prompt)
        self.assertIn("CURRENT_BASE_CI", prompt)

    def test_cleanup_never_deletes_arbitrary_user_branch(self) -> None:
        state, live, _, _, _ = self.fixture()
        adapter = FakeCIAdapter(live)
        result = cleanup_ci_branch(
            adapter,
            self.repo,
            {
                "branch": "user/important",
                "synthetic_merge": "c" * 40,
                "stream": state["stream_id"],
                "pr": state["pr"],
            },
            stream=state["stream_id"],
            pr=state["pr"],
        )
        self.assertFalse(result["ok"])
        self.assertEqual(adapter.deletes, [])

    def test_exact_completed_required_jobs_are_pass(self) -> None:
        live = {"baseRefOid": "b" * 40}
        adapter = FakeCIAdapter(live)
        adapter.gh = lambda args, **kwargs: (
            0,
            json.dumps(
                [
                    {
                        "databaseId": 7010,
                        "headSha": "c" * 40,
                        "headBranch": "agentbus/ci/s/abc",
                        "status": "completed",
                        "conclusion": "success",
                        "workflowName": "Check",
                        "event": "push",
                    }
                ]
                if args[1] == "list"
                else {
                    "databaseId": 7010,
                    "headSha": "c" * 40,
                    "headBranch": "agentbus/ci/s/abc",
                    "status": "completed",
                    "conclusion": "success",
                    "workflowName": "Check",
                    "event": "push",
                    "jobs": [
                        {"name": "validate (ubuntu-latest)", "status": "completed", "conclusion": "success"},
                        {"name": "validate (windows-latest)", "status": "completed", "conclusion": "success"},
                        {"name": "desktop-windows-package", "status": "completed", "conclusion": "success"},
                    ],
                }
            ),
            "",
        )
        from agentbus.ci import _observe_run

        result = _observe_run(
            adapter,
            self.repo,
            {
                "branch": "agentbus/ci/s/abc",
                "synthetic_merge": "c" * 40,
            },
            env=None,
        )
        self.assertEqual(result["status"], "PASS")
