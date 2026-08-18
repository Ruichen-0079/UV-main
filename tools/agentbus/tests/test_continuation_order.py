from __future__ import annotations

import json
import os

from agentbus.actions import delete_stream
from agentbus.apply import apply_envelope, mark_pr_merged
from agentbus.autopilot import campaign_tick, tick_stream
from agentbus.campaign import load_campaign
from agentbus.github import apply_fetched_comments
from agentbus.machine import IMPLEMENTING, MERGED
from agentbus.protocol import parse_one
from agentbus.store import StreamStore
from agentbus.tests.harness import AgentbusTest
from agentbus.tests.test_campaign import continuation_text


class ContinuationOrderTests(AgentbusTest):
    def _cont(self, campaign: str, after: str, nxt: str, scope: str = "README.md") -> str:
        return continuation_text(campaign=campaign, after=after, nxt=nxt, scope=scope)

    def _merge(self, store, sha: str) -> None:
        state = store.load()
        if state["phase"] != MERGED:
            state["phase"] = "FINAL_GATE"
            store.save(state)
            state = store.load()
        mark_pr_merged(state, store, merge_sha=sha)
        store.save(state)

    def _ingest_comment(self, store, cid: str, body: str, *, merged: bool = False) -> None:
        state = store.load()
        apply_fetched_comments(
            store,
            state,
            comments=[{"id": cid, "body": body}],
            view={"number": state.get("pr") or 1, "state": "MERGED" if merged else "OPEN"},
            repo_root=self.repo,
            current_head=self.git("rev-parse", "HEAD"),
            ctx=self.ctx,
        )
        store.save(state)

    def test_continuation_before_merge_creates_successor(self) -> None:
        self.create_stream("pre-a")
        store = self.store("pre-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "pre"
        state["pr"] = 11
        store.save(state)
        self._ingest_comment(store, "c-before", self._cont("pre", "pre-a", "pre-b"))
        self._merge(store, sha)
        self.assertTrue(StreamStore(self.ctx, "pre-b").exists())
        self.assertEqual(self.store("pre-b").load()["phase"], IMPLEMENTING)

    def test_continuation_after_merge_creates_successor(self) -> None:
        self.create_stream("late-a")
        store = self.store("late-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "late"
        state["pr"] = 12
        store.save(state)
        self._merge(store, sha)
        self.assertFalse(StreamStore(self.ctx, "late-b").exists())
        self._ingest_comment(store, "c-late", self._cont("late", "late-a", "late-b"), merged=True)
        self.assertTrue(StreamStore(self.ctx, "late-b").exists())
        self.assertEqual(self.store("late-b").load()["phase"], IMPLEMENTING)

    def test_same_sync_merge_and_continuation(self) -> None:
        self.create_stream("same-a")
        store = self.store("same-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "same"
        state["pr"] = 13
        store.save(state)
        state = store.load()
        apply_fetched_comments(
            store,
            state,
            comments=[{"id": "c-same", "body": self._cont("same", "same-a", "same-b")}],
            view={"number": 13, "state": "MERGED", "mergeCommit": {"oid": sha}},
            repo_root=self.repo,
            current_head=sha,
            ctx=self.ctx,
        )
        store.save(state)
        self.assertTrue(StreamStore(self.ctx, "same-b").exists())
        self.assertEqual(self.store("same-b").load()["phase"], IMPLEMENTING)

    def test_merged_comments_scanned_for_continuation(self) -> None:
        self.create_stream("scan-a")
        store = self.store("scan-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "scan"
        state["pr"] = 14
        store.save(state)
        self._merge(store, sha)
        body = self._cont("scan", "scan-a", "scan-b")
        self._ingest_comment(store, "c-scan", body, merged=True)
        self.assertIn("GPT_CONTINUATION", store.load().get("envelopes") or {})
        self.assertTrue(self.store("scan-b").exists())

    def test_merged_ignores_late_gpt_spec(self) -> None:
        self.create_stream("spec-a")
        store = self.store("spec-a")
        sha = self.git("rev-parse", "HEAD")
        self._merge(store, sha)
        spec = f"""[GPT_SPEC]
STATUS: ACTIONABLE
STREAM: spec-a
BASE_HEAD: {sha}
SCOPE: x
ACCEPTANCE_CRITERIA: y
NEXT_ACTION: IMPLEMENT
"""
        apply_envelope(store, store.load(), parse_one(spec), repo=self.repo, current_head=sha)
        store.save(store.load())
        self.assertEqual(store.load()["phase"], MERGED)

    def test_waiting_for_plan_rescan_and_tick(self) -> None:
        self.create_stream("res-a")
        store = self.store("res-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "res"
        state["pr"] = 15
        store.save(state)
        self._merge(store, sha)
        self.assertEqual(load_campaign(self.ctx, "res")["status"], "WAITING_FOR_PLAN")
        # Pretend comment was seen as non-envelope (the live bug).
        state = store.load()
        body = self._cont("res", "res-a", "res-b")
        state.setdefault("seen_comment_ids", []).append("c-res")
        store.save(state)
        apply_fetched_comments(
            store,
            store.load(),
            comments=[{"id": "c-res", "body": body}],
            view={"number": 15, "state": "MERGED", "mergeCommit": {"oid": sha}},
            repo_root=self.repo,
            current_head=sha,
            ctx=self.ctx,
        )
        store.save(store.load())
        self.assertTrue(StreamStore(self.ctx, "res-b").exists())

    def test_tick_discovers_late_continuation_without_named_sync(self) -> None:
        self.create_stream("tick-a", "--pr", "16")
        store = self.store("tick-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "tickc"
        store.save(state)
        self._merge(store, sha)
        comments = os.path.join(self.root, "tick-comments.json")
        with open(comments, "w", encoding="utf-8") as handle:
            json.dump([{"id": 99, "body": self._cont("tickc", "tick-a", "tick-b")}], handle)
        os.environ["FAKE_GH_COMMENTS"] = comments
        os.environ["FAKE_GH_MODE"] = "ok"
        tick_stream(self.ctx, store, sync_github=True, force_sync=True, surface="webui")
        self.assertTrue(StreamStore(self.ctx, "tick-b").exists())

    def test_exact_once_repeated_tick_and_sync(self) -> None:
        self.create_stream("once-a")
        store = self.store("once-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "once"
        state["pr"] = 17
        store.save(state)
        self._merge(store, sha)
        self._ingest_comment(store, "c-once", self._cont("once", "once-a", "once-b"), merged=True)
        self._ingest_comment(store, "c-once", self._cont("once", "once-a", "once-b"), merged=True)
        campaign_tick(self.ctx, stream_id="once-a", force_sync=False)
        campaign_tick(self.ctx, stream_id="once-a", force_sync=False)
        self.assertTrue(self.store("once-b").exists())
        ids = [name for name in os.listdir(self.ctx.repo_state) if name.startswith("once-")]
        self.assertEqual(sorted(set(ids)), ["once-a", "once-b"])
        campaign = load_campaign(self.ctx, "once")
        self.assertEqual(campaign["status"], "ACTIVE")
        self.assertEqual(campaign.get("active_stream"), "once-b")

    def test_main_advanced_non_overlap_uses_current_main(self) -> None:
        from agentbus.campaign import resolve_base_anchor

        self.create_stream("ov-a")
        store = self.store("ov-a")
        merge = self.git("rev-parse", "HEAD")
        self._merge(store, merge)
        self.commit_file("unrelated.txt", "x\n", "advance main")
        main = self.git("rev-parse", "HEAD")
        state = store.load()
        state["heads"]["merged"] = merge
        store.save(state)
        resolved = resolve_base_anchor(
            self.repo, store.load(), {"base_anchor": "PREVIOUS_MERGE", "scope": "docs/only.md"}
        )
        self.assertTrue(resolved["ok"], resolved)
        self.assertEqual(resolved["base"], main)
        self.assertEqual(resolved["mode"], "reconciled_current_main")

    def test_main_overlap_does_not_create(self) -> None:
        from agentbus.campaign import resolve_base_anchor

        self.create_stream("ovp-a")
        store = self.store("ovp-a")
        merge = self.git("rev-parse", "HEAD")
        self._merge(store, merge)
        self.commit_file("src/app.py", "x\n", "overlap")
        resolved = resolve_base_anchor(
            self.repo,
            {**store.load(), "heads": {**store.load()["heads"], "merged": merge}},
            {"base_anchor": "PREVIOUS_MERGE", "scope": "src/app.py"},
        )
        self.assertFalse(resolved["ok"])
        self.assertTrue(resolved["human_required"])

    def test_after_stream_completed_lookup(self) -> None:
        self.create_stream("lk-a")
        store = self.store("lk-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "lk"
        store.save(state)
        self._merge(store, sha)
        apply_envelope(
            store,
            store.load(),
            parse_one(self._cont("lk", "lk-a", "lk-b")),
            repo=self.repo,
            current_head=sha,
        )
        store.save(store.load())
        self.assertTrue(self.store("lk-b").exists())

    def test_archive_preserves_continuation_anchor(self) -> None:
        self.create_stream("arc-a", "--pr", "18")
        store = self.store("arc-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "arc"
        store.save(state)
        self._merge(store, sha)
        result = delete_stream(self.ctx, store, delete_worktrees=True)
        self.assertTrue(result.get("archived"))
        self.assertTrue(store.exists())
        archived = store.load()
        self.assertTrue(archived.get("archived"))
        self.assertEqual(archived.get("pr"), 18)
        self.assertEqual((archived.get("heads") or {}).get("merged"), sha)
        self._ingest_comment(store, "c-arc", self._cont("arc", "arc-a", "arc-b"), merged=True)
        self.assertTrue(StreamStore(self.ctx, "arc-b").exists())

    def test_review_policy_carries(self) -> None:
        self.create_stream("pol-a")
        store = self.store("pol-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "pol"
        store.save(state)
        self._merge(store, sha)
        text = self._cont("pol", "pol-a", "pol-b")
        text = text.replace("REVIEW_POLICY: AUDIT_SUFFICIENT", "REVIEW_POLICY: GPT_REQUIRED")
        apply_envelope(store, store.load(), parse_one(text), repo=self.repo, current_head=sha)
        store.save(store.load())
        nxt = self.store("pol-b").load()
        self.assertEqual(nxt.get("review_policy"), "GPT_REQUIRED")
        spec = (nxt.get("envelopes") or {}).get("GPT_SPEC") or {}
        self.assertEqual((spec.get("fields") or {}).get("REVIEW_POLICY"), "GPT_REQUIRED")
        self.assertEqual(store.load()["phase"], MERGED)
        self.assertEqual(store.load().get("pr"), None)

    def test_no_fake_spec_on_old_stream_envelopes(self) -> None:
        self.create_stream("nf-a")
        store = self.store("nf-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "nf"
        state["pr"] = 19
        store.save(state)
        self._merge(store, sha)
        apply_envelope(
            store,
            store.load(),
            parse_one(self._cont("nf", "nf-a", "nf-b")),
            repo=self.repo,
            current_head=sha,
        )
        store.save(store.load())
        old = store.load()
        self.assertNotEqual((old.get("envelopes") or {}).get("GPT_SPEC", {}).get("fields", {}).get("STREAM"), "nf-b")
        self.assertEqual(old["phase"], MERGED)

    def test_prefers_origin_main_over_stale_local_main(self) -> None:
        from agentbus.campaign import resolve_base_anchor

        self.create_stream("om-a")
        store = self.store("om-a")
        merge = self.git("rev-parse", "HEAD")
        self._merge(store, merge)
        self.commit_file("unrelated.txt", "github main\n", "github main advance")
        github_main = self.git("rev-parse", "HEAD")
        self.git("update-ref", "refs/remotes/origin/main", github_main)
        self.git("checkout", "-B", "agentbus-local", merge)
        self.git("branch", "-f", "main", merge)
        resolved = resolve_base_anchor(
            self.repo,
            {**store.load(), "heads": {**store.load()["heads"], "merged": merge}},
            {"base_anchor": "PREVIOUS_MERGE", "scope": "docs/only.md"},
        )
        self.assertTrue(resolved["ok"], resolved)
        self.assertEqual(resolved["base"], github_main)
        self.assertEqual(resolved["reconciliation"], "main_advanced_non_overlapping")

    def test_main_equals_previous_merge(self) -> None:
        from agentbus.campaign import resolve_base_anchor

        self.create_stream("eq-a")
        store = self.store("eq-a")
        merge = self.git("rev-parse", "HEAD")
        self._merge(store, merge)
        resolved = resolve_base_anchor(
            self.repo, store.load(), {"base_anchor": "PREVIOUS_MERGE", "scope": "README.md"}
        )
        self.assertTrue(resolved["ok"], resolved)
        self.assertEqual(resolved["base"], merge)
        self.assertEqual(resolved["mode"], "previous_merge")

    def test_continuation_then_merge_exactly_once(self) -> None:
        self.create_stream("ord-a")
        store = self.store("ord-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "ord"
        state["pr"] = 21
        store.save(state)
        self._ingest_comment(store, "c-ord", self._cont("ord", "ord-a", "ord-b"))
        self._merge(store, sha)
        self._merge(store, sha)
        campaign_tick(self.ctx, stream_id="ord-a", force_sync=False)
        ids = [name for name in os.listdir(self.ctx.repo_state) if name.startswith("ord-")]
        self.assertEqual(sorted(set(ids)), ["ord-a", "ord-b"])

    def test_merge_sha_from_view_used_when_heads_merged_missing(self) -> None:
        self.create_stream("sha-a")
        store = self.store("sha-a")
        implemented = self.git("rev-parse", "HEAD")
        self.commit_file("later.txt", "merge\n", "merge commit")
        merge = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "sha"
        state["pr"] = 22
        state["phase"] = MERGED
        state["heads"]["current"] = implemented
        state["heads"].pop("merged", None)
        store.save(state)
        state = store.load()
        apply_fetched_comments(
            store,
            state,
            comments=[{"id": "c-sha", "body": self._cont("sha", "sha-a", "sha-b")}],
            view={"number": 22, "state": "MERGED", "mergeCommit": {"oid": merge}},
            repo_root=self.repo,
            current_head=implemented,
            ctx=self.ctx,
        )
        store.save(state)
        self.assertTrue(StreamStore(self.ctx, "sha-b").exists())
        self.assertEqual(store.load()["heads"]["merged"], merge)
        nxt = self.store("sha-b").load()
        self.assertEqual(((nxt.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields", {}).get("BASE_HEAD"), merge)

    def test_waiting_for_plan_tick_rescans_without_force_flag(self) -> None:
        from agentbus.util import utc_now

        self.create_stream("rs-a", "--pr", "23")
        store = self.store("rs-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "rs"
        store.save(state)
        self._merge(store, sha)
        self.assertEqual(load_campaign(self.ctx, "rs")["status"], "WAITING_FOR_PLAN")
        state = store.load()
        state.setdefault("seen_comment_ids", []).append("c-rs2")
        store.save(state)
        runtime = store.load_runtime()
        runtime["last_github_sync"] = utc_now()
        store.save_runtime(runtime)
        comments = os.path.join(self.root, "rs-comments.json")
        with open(comments, "w", encoding="utf-8") as handle:
            json.dump([{"id": "c-rs2", "body": self._cont("rs", "rs-a", "rs-b")}], handle)
        os.environ["FAKE_GH_COMMENTS"] = comments
        os.environ["FAKE_GH_MODE"] = "ok"
        tick_stream(self.ctx, store, sync_github=True, force_sync=False, surface="webui")
        self.assertTrue(StreamStore(self.ctx, "rs-b").exists())

    def test_runner_tick_discovers_late_continuation(self) -> None:
        self.create_stream("rn-a", "--pr", "24")
        store = self.store("rn-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "rn"
        store.save(state)
        self._merge(store, sha)
        comments = os.path.join(self.root, "rn-comments.json")
        with open(comments, "w", encoding="utf-8") as handle:
            json.dump([{"id": 241, "body": self._cont("rn", "rn-a", "rn-b")}], handle)
        os.environ["FAKE_GH_COMMENTS"] = comments
        os.environ["FAKE_GH_MODE"] = "ok"
        campaign_tick(self.ctx, stream_id="rn-a", force_sync=False, surface="runner")
        self.assertTrue(StreamStore(self.ctx, "rn-b").exists())

    def test_cli_sync_sufficient_not_required(self) -> None:
        self.create_stream("cli-a", "--pr", "25")
        store = self.store("cli-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "clic"
        store.save(state)
        self._merge(store, sha)
        comments = os.path.join(self.root, "cli-comments.json")
        with open(comments, "w", encoding="utf-8") as handle:
            json.dump([{"id": 251, "body": self._cont("clic", "cli-a", "cli-b")}], handle)
        os.environ["FAKE_GH_COMMENTS"] = comments
        result = campaign_tick(self.ctx, stream_id="cli-a", force_sync=True, surface="cli")
        self.assertTrue(self.store("cli-b").exists())
        self.assertEqual(result["surface"], "cli")

    def test_delete_visible_task_keeps_campaign_history(self) -> None:
        self.create_stream("hist-a", "--pr", "26")
        store = self.store("hist-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "hist"
        store.save(state)
        self._merge(store, sha)
        delete_stream(self.ctx, store, delete_worktrees=True)
        campaign = load_campaign(self.ctx, "hist")
        self.assertTrue(campaign)
        units = [unit for unit in (campaign.get("units") or []) if unit.get("stream_id") == "hist-a"]
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0].get("pr"), 26)
        self.assertEqual(units[0].get("merge_sha"), sha)
        self.assertTrue(store.exists())
        self.assertTrue(store.load().get("archived"))

    def test_repeated_github_sync_does_not_duplicate(self) -> None:
        self.create_stream("gs-a", "--pr", "27")
        store = self.store("gs-a")
        sha = self.git("rev-parse", "HEAD")
        state = store.load()
        state["campaign_id"] = "gs"
        store.save(state)
        self._merge(store, sha)
        body = self._cont("gs", "gs-a", "gs-b")
        for _ in range(3):
            self._ingest_comment(store, "c-gs", body, merged=True)
        ids = [name for name in os.listdir(self.ctx.repo_state) if name.startswith("gs-")]
        self.assertEqual(sorted(set(ids)), ["gs-a", "gs-b"])
