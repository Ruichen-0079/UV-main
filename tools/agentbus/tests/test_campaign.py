from __future__ import annotations

import os

from agentbus.apply import apply_envelope, mark_pr_merged
from agentbus.campaign import after_unit_merged, load_campaign, resolve_base_anchor
from agentbus.machine import FINAL_GATE, IMPLEMENTING, MERGED
from agentbus.protocol import parse_one
from agentbus.store import StreamStore
from agentbus.tests.harness import AgentbusTest


def continuation_text(
    *,
    campaign: str,
    after: str,
    nxt: str,
    scope: str,
    target: str = "next bounded unit",
) -> str:
    return f"""[GPT_CONTINUATION]

STATUS: ACTIONABLE

CAMPAIGN: {campaign}

AFTER_STREAM: {after}

TRIGGER: MERGED

NEXT_STREAM: {nxt}

TARGET: {target}

BASE_ANCHOR: PREVIOUS_MERGE

SCOPE:
{scope}

OUT_OF_SCOPE:
unrelated

ACCEPTANCE_CRITERIA:
bounded next unit

REVIEW_POLICY: AUDIT_SUFFICIENT

NEXT_ACTION: CREATE_AND_IMPLEMENT
"""


class CampaignTests(AgentbusTest):
    def _merged_unit(self, stream: str, campaign: str, merge_sha: str | None = None) -> StreamStore:
        self.create_stream(stream, "--goal", campaign)
        store = self.store(stream)
        state = store.load()
        state["campaign_id"] = campaign
        state["phase"] = FINAL_GATE
        state["pr"] = 40
        sha = merge_sha or self.git("rev-parse", "HEAD")
        state["heads"]["current"] = sha
        state["heads"]["merged"] = sha
        store.save(state)
        mark_pr_merged(state, store, merge_sha=sha)
        store.save(state)
        return store

    def test_non_merged_current_unit_is_not_waiting_for_plan(self) -> None:
        self.create_stream("live-a", "--pr", "44")
        store = self.store("live-a")
        state = store.load()
        state["campaign_id"] = "livecamp"
        state["phase"] = FINAL_GATE
        store.save(state)
        from agentbus.campaign import bind_explicit_campaign, campaign_view, load_campaign

        bind_explicit_campaign(self.ctx, state, "livecamp")
        camp = load_campaign(self.ctx, "livecamp")
        view = campaign_view(camp, self.ctx)
        self.assertEqual(view["status"], "ACTIVE")
        self.assertEqual(view["current_unit"], "live-a")
        self.assertFalse(view["unit_completed"])
        self.assertNotEqual(view["status"], "WAITING_FOR_PLAN")

    def test_ready_for_gpt_campaign_is_active(self) -> None:
        self.create_stream("gpt-a", "--pr", "43")
        store = self.store("gpt-a")
        state = store.load()
        state["campaign_id"] = "gptcamp"
        state["phase"] = "READY_FOR_GPT"
        store.save(state)
        from agentbus.campaign import bind_explicit_campaign, campaign_view, load_campaign

        bind_explicit_campaign(self.ctx, state, "gptcamp")
        view = campaign_view(load_campaign(self.ctx, "gptcamp"), self.ctx)
        self.assertEqual(view["status"], "ACTIVE")
        self.assertEqual(view["current_phase"], "READY_FOR_GPT")

    def test_merged_without_continuation_waiting_for_plan(self) -> None:
        store = self._merged_unit("p7-8b-canary", "p7")
        state = store.load()
        mark_pr_merged(state, store, merge_sha=state["heads"]["merged"])
        store.save(state)
        self.assertEqual(store.load()["phase"], MERGED)
        campaign = load_campaign(self.ctx, "p7")
        self.assertIsNotNone(campaign)
        self.assertEqual(campaign["status"], "WAITING_FOR_PLAN")
        self.assertEqual(campaign["current_stream"], "p7-8b-canary")
        from agentbus.campaign import campaign_view

        self.assertEqual(campaign_view(campaign, self.ctx)["current_unit"], "p7-8b-canary")
        self.assertEqual(campaign.get("queue") or [], [])
        self.assertFalse(campaign.get("human_required"))

    def test_merged_with_valid_continuation_creates_next_unit(self) -> None:
        store = self._merged_unit("unit-a", "camp-a")
        sha = store.load()["heads"]["merged"]
        env = parse_one(continuation_text(campaign="camp-a", after="unit-a", nxt="unit-b", scope="README.md"))
        apply_envelope(store, store.load(), env, repo=self.repo, current_head=sha)
        state = store.load()
        self.assertEqual(state["phase"], MERGED)
        nxt = StreamStore(self.ctx, "unit-b")
        self.assertTrue(nxt.exists())
        next_state = nxt.load()
        self.assertEqual(next_state["phase"], IMPLEMENTING)
        self.assertNotEqual(next_state.get("impl_worktree"), store.load().get("impl_worktree"))
        self.assertTrue(next_state.get("created_worktrees", {}).get("impl"))
        self.assertEqual(next_state.get("review_policy"), "AUDIT_SUFFICIENT")
        self.assertNotEqual(next_state.get("pr"), 40)

    def test_merge_does_not_terminate_campaign(self) -> None:
        store = self._merged_unit("keep-a", "keep")
        sha = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="keep", after="keep-a", nxt="keep-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        campaign = load_campaign(self.ctx, "keep")
        self.assertNotEqual(campaign["status"], "COMPLETE")
        self.assertEqual(store.load()["phase"], MERGED)

    def test_continuation_uses_previous_merge_sha(self) -> None:
        store = self._merged_unit("anc-a", "anc")
        merge = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="anc", after="anc-a", nxt="anc-b", scope="README.md")),
            repo=self.repo,
            current_head=merge,
        )
        next_state = self.store("anc-b").load()
        spec = (next_state.get("envelopes") or {}).get("GPT_SPEC") or {}
        self.assertEqual((spec.get("fields") or {}).get("BASE_HEAD"), merge)
        head = self.git("rev-parse", "HEAD", cwd=next_state["impl_worktree"])
        self.assertEqual(self.git("rev-parse", f"{head}^{{tree}}", cwd=next_state["impl_worktree"]), self.git("rev-parse", f"{merge}^{{tree}}"))
        self.assertNotEqual(head, merge)

    def test_current_main_non_overlap_reconciliation(self) -> None:
        store = self._merged_unit("ov-a", "ov")
        merge = store.load()["heads"]["merged"]
        self.commit_file("unrelated.txt", "later\n", "main advanced unrelated")
        main = self.git("rev-parse", "HEAD")
        self.assertNotEqual(main, merge)
        item = {
            "base_anchor": "PREVIOUS_MERGE",
            "scope": "docs/only.md",
        }
        resolved = resolve_base_anchor(self.repo, store.load(), item)
        self.assertTrue(resolved["ok"], resolved)
        self.assertEqual(resolved["mode"], "reconciled_current_main")
        self.assertEqual(resolved["base"], main)

    def test_current_main_overlap_requires_human(self) -> None:
        store = self._merged_unit("ov2-a", "ov2")
        self.commit_file("src/app.py", "overlap\n", "main advanced overlapping")
        item = {"base_anchor": "PREVIOUS_MERGE", "scope": "src/app.py"}
        resolved = resolve_base_anchor(self.repo, store.load(), item)
        self.assertFalse(resolved["ok"])
        self.assertTrue(resolved["human_required"])

    def test_duplicate_continuation_idempotent(self) -> None:
        store = self._merged_unit("dup-a", "dup")
        sha = store.load()["heads"]["merged"]
        text = continuation_text(campaign="dup", after="dup-a", nxt="dup-b", scope="README.md")
        apply_envelope(store, store.load(), parse_one(text), repo=self.repo, current_head=sha)
        apply_envelope(store, store.load(), parse_one(text), repo=self.repo, current_head=sha)
        campaign = load_campaign(self.ctx, "dup")
        queued_or_consumed = [item for item in campaign["queue"] if item["next_stream"] == "dup-b"]
        self.assertEqual(len(queued_or_consumed), 1)
        self.assertTrue(StreamStore(self.ctx, "dup-b").exists())

    def test_conflicting_continuation_human_required(self) -> None:
        store = self._merged_unit("cf-a", "cf")
        sha = store.load()["heads"]["merged"]
        state = store.load()
        apply_envelope(
            store,
            state,
            parse_one(continuation_text(campaign="cf", after="cf-a", nxt="cf-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        # Second conflicting next-stream against the same after unit.
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="cf", after="cf-a", nxt="cf-other", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        campaign = load_campaign(self.ctx, "cf")
        from agentbus.campaign import campaign_view
        from agentbus.decision import HUMAN, derive_next_action

        # The live successor remains visibly ACTIVE; the conflicting durable
        # plan is a canonical HUMAN decision, not a competing campaign phase.
        view = campaign_view(campaign, self.ctx)
        self.assertEqual(view["status"], "ACTIVE")
        successor = self.store("cf-b").load()
        self.assertEqual(derive_next_action(successor, campaign).action, HUMAN)
        self.assertFalse(StreamStore(self.ctx, "cf-other").exists())

    def test_bounded_queue(self) -> None:
        os.environ["YUVI_AGENTBUS_MAX_CONTINUATIONS"] = "2"
        self.create_stream("q-a")
        store = self.store("q-a")
        state = store.load()
        state["campaign_id"] = "q"
        store.save(state)
        head = self.git("rev-parse", "HEAD")
        pairs = (("q-a", "q-b"), ("q-b", "q-c"), ("q-c", "q-d"))
        for after, nxt in pairs:
            apply_envelope(
                store,
                store.load(),
                parse_one(continuation_text(campaign="q", after=after, nxt=nxt, scope="README.md")),
                repo=self.repo,
                current_head=head,
            )
        campaign = load_campaign(self.ctx, "q")
        pending = [item for item in campaign["queue"] if item["status"] == "queued"]
        ignored = [item for item in campaign["queue"] if item["status"] == "ignored"]
        self.assertLessEqual(len(pending), 2)
        self.assertTrue(ignored)

    def test_continuation_cannot_auto_merge(self) -> None:
        store = self._merged_unit("nm-a", "nm")
        sha = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="nm", after="nm-a", nxt="nm-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        self.assertEqual(self.store("nm-b").load()["phase"], IMPLEMENTING)
        self.assertNotEqual(self.store("nm-b").load()["phase"], MERGED)

    def test_previous_merged_pr_never_mutated(self) -> None:
        store = self._merged_unit("old-a", "old")
        sha = store.load()["heads"]["merged"]
        before = dict(store.load())
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="old", after="old-a", nxt="old-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        after = store.load()
        self.assertEqual(after["pr"], 40)
        self.assertEqual(after["phase"], MERGED)
        self.assertEqual(after["heads"]["merged"], before["heads"]["merged"])

    def test_new_worktree_ownership_safe(self) -> None:
        store = self._merged_unit("own-a", "own")
        sha = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="own", after="own-a", nxt="own-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        nxt = self.store("own-b").load()
        self.assertTrue(nxt["created_worktrees"]["impl"])
        self.assertNotEqual(nxt["impl_worktree"], store.load()["impl_worktree"])
        self.assertTrue(os.path.isdir(nxt["impl_worktree"]))

    def test_p7_fixture_no_invented_continuation(self) -> None:
        store = self._merged_unit("p7-8b-canary", "p7")
        state = store.load()
        after_unit_merged(store, state)
        store.save(state)
        campaign = load_campaign(self.ctx, "p7")
        self.assertEqual(store.load()["phase"], MERGED)
        self.assertEqual(campaign["status"], "WAITING_FOR_PLAN")
        self.assertEqual([item for item in campaign["queue"] if item.get("status") == "queued"], [])
        live = os.path.expanduser(
            "~/.local/state/yuvi-agent-bus/github.com_Ruichen-0079_UV-main/p7-8b-canary/state.json"
        )
        if os.path.isfile(live):
            import json

            with open(live, encoding="utf-8") as handle:
                data = json.load(handle)
            self.assertEqual(data.get("phase"), "MERGED")
            self.assertEqual(data.get("pr"), 40)
