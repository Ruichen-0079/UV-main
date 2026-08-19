from __future__ import annotations

import json
from unittest.mock import patch

from agentbus.browser import _final_prompt
from agentbus.ci import (
    CIAdapter,
    cleanup_ci_branch,
    ci_branch_name,
    current_base_ci_matches,
    reconcile_current_base_ci,
    synthetic_generation,
    verify_synthetic_merge,
)
from agentbus.decision import FINAL_GPT, FINAL_REVIEW, WAIT, browser_job_id, derive_next_action, review_generation
from agentbus.models import empty_state
from agentbus.tests.harness import AgentbusTest


class FakeCIAdapter(CIAdapter):
    def __init__(self, live: dict, *, merge: str = "c" * 40) -> None:
        self.live = dict(live)
        self.merge = merge
        self.remote: dict[str, str] = {}
        self.pushes: list[tuple[str, str]] = []
        self.deletes: list[str] = []

    def pr_view(self, cwd: str, number: int, env=None) -> dict:
        return dict(self.live)

    def live_base(self, cwd: str, ref: str, env=None) -> str:
        return str(self.live["baseRefOid"])

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
