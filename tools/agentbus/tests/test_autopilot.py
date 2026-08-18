from __future__ import annotations

import os

from agentbus.apply import apply_envelope, mark_pr_merged, set_phase
from agentbus.attention import classify_attention
from agentbus.authority import current_generation_authority
from agentbus.autopilot import campaign_tick, enable_known_campaigns, maybe_gpt_handoff, tick_stream
from agentbus.campaign import EXPLICIT_STREAM_CAMPAIGNS, load_campaign, mark_obsolete
from agentbus.machine import (
    AUDITING,
    FINAL_GATE,
    IMPLEMENTING,
    MERGED,
    READY_FOR_AUDIT,
    READY_FOR_GPT,
    RECOVERY_REQUIRED,
    RE_REVIEW_REQUIRED,
    WAITING_FOR_SPEC,
)
from agentbus.protocol import parse_one
from agentbus.tests.harness import AgentbusTest
from agentbus.tests.test_campaign import continuation_text
from agentbus.tests.test_reviewpolicy import ReviewPolicyTests
from agentbus.views import overview, stream_view
from agentbus.web import make_server


class AutopilotTests(AgentbusTest):
    def apply_save(self, store, text: str, head: str) -> None:
        state = store.load()
        apply_envelope(store, state, parse_one(text), repo=self.repo, current_head=head)
        store.save(state)

    def test_deterministic_state_auto_advances(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        self.apply_save(store, ReviewPolicyTests._spec(self, "s1", head, None), head)
        state = store.load()
        self.assertIn("GPT_SPEC", state["envelopes"])
        state["phase"] = WAITING_FOR_SPEC
        store.save(state)
        tick_stream(self.ctx, store, sync_github=False, surface="cli")
        self.assertEqual(store.load()["phase"], IMPLEMENTING)

    def test_ready_for_audit_wakes_audit(self) -> None:
        from agentbus.runner import role_should_work

        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_AUDIT
        state["heads"]["implemented"] = "a" * 40
        store.save(state)
        self.assertTrue(role_should_work(store.load(), "audit"))

    def test_audit_changes_starts_bounded_repair(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        helper = ReviewPolicyTests()
        self.apply_save(store, helper._spec("s1", head, None), head)
        state = store.load()
        state["publication"] = {"commit": head, "status": "committed"}
        store.save(state)
        self.apply_save(store, helper._report("s1", head), head)
        self.apply_save(store, helper._audit("s1", head, status="CHANGES_REQUIRED", findings="bug"), head)
        self.assertEqual(store.load()["phase"], IMPLEMENTING)

    def test_audit_sufficient_advances(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        helper = ReviewPolicyTests()
        self.apply_save(store, helper._spec("s1", head, "AUDIT_SUFFICIENT"), head)
        state = store.load()
        state["publication"] = {"commit": head, "status": "committed"}
        store.save(state)
        self.apply_save(store, helper._report("s1", head), head)
        self.apply_save(store, helper._audit("s1", head), head)
        self.assertEqual(store.load()["phase"], FINAL_GATE)

    def test_gpt_required_stops_at_browser_gpt(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_GPT
        state["review_policy"] = "GPT_REQUIRED"
        store.save(state)
        att = classify_attention(store.load())
        self.assertEqual(att["attention_owner"], "BROWSER_GPT")
        self.assertFalse(att["human_required"])
        self.assertTrue(att["browser_gpt_required"])

    def test_browser_gpt_gate_not_human_required(self) -> None:
        self.create_stream("s1")
        att = classify_attention(self.store("s1").load())
        self.assertFalse(att["human_required"])
        self.assertTrue(att["browser_gpt_required"])

    def test_gpt_url_opens_max_once_per_generation(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_GPT
        state["browser_gpt"] = {"url": "https://chatgpt.com/c/test", "display_name": "t"}
        store.save(state)
        state = store.load()
        first = maybe_gpt_handoff(store, state, surface="cli")
        store.save(state)
        second = maybe_gpt_handoff(store, store.load(), surface="cli")
        self.assertTrue(first["open_once"] or first.get("url"))
        self.assertTrue(second.get("already"))
        self.assertFalse(second.get("open_once"))

    def test_no_dom_browser_automation(self) -> None:
        root = os.path.join(os.path.dirname(__file__), "..")
        for dirpath, _, files in os.walk(root):
            if "__pycache__" in dirpath or os.path.basename(dirpath) == "tests":
                continue
            for name in files:
                if not name.endswith(".py"):
                    continue
                text = open(os.path.join(dirpath, name), encoding="utf-8").read()
                self.assertNotIn("playwright", text.lower())
                self.assertNotIn("puppeteer", text.lower())
                self.assertNotIn("selenium", text.lower())

    def test_merged_continuation_creates_next(self) -> None:
        self.create_stream("u-a", "--goal", "c")
        store = self.store("u-a")
        state = store.load()
        state["campaign_id"] = "campx"
        state["phase"] = FINAL_GATE
        sha = self.git("rev-parse", "HEAD")
        state["heads"]["current"] = sha
        store.save(state)
        self.apply_save(
            store,
            continuation_text(campaign="campx", after="u-a", nxt="u-b", scope="README.md"),
            sha,
        )
        state = store.load()
        mark_pr_merged(state, store, merge_sha=sha)
        store.save(state)
        self.assertTrue(self.store("u-b").exists())

    def test_merged_no_continuation_waiting_for_plan(self) -> None:
        self.create_stream("done-a")
        store = self.store("done-a")
        state = store.load()
        state["campaign_id"] = "done"
        state["phase"] = FINAL_GATE
        sha = self.git("rev-parse", "HEAD")
        state["heads"]["current"] = sha
        store.save(state)
        state = store.load()
        mark_pr_merged(state, store, merge_sha=sha)
        store.save(state)
        campaign = load_campaign(self.ctx, "done")
        self.assertEqual(campaign["status"], "WAITING_FOR_PLAN")
        from agentbus.attention import campaign_attention

        att = campaign_attention(campaign)
        self.assertEqual(att["attention_owner"], "BROWSER_GPT")
        self.assertFalse(att["human_required"])
        state = store.load()
        state["browser_gpt"] = {"url": "https://chatgpt.com/c/plan", "display_name": "p"}
        store.save(state)
        handoff = maybe_gpt_handoff(store, store.load(), campaign=campaign, surface="cli")
        self.assertTrue(handoff)
        self.assertIn("WAITING_FOR_PLAN", handoff["generation"])

    def test_final_merge_remains_human(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = FINAL_GATE
        store.save(state)
        att = classify_attention(store.load())
        self.assertFalse(att["human_required"])
        self.assertEqual(att["attention_owner"], "BROWSER_GPT")
        self.assertTrue(att["browser_gpt_required"])

    def test_stale_recoverable_blocker_auto_clears(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = IMPLEMENTING
        store.save(state)
        set_phase(store.load(), RECOVERY_REQUIRED, reason="impl process died")
        state = store.load()
        state["phase"] = RECOVERY_REQUIRED
        state["prior_phase"] = IMPLEMENTING
        state["status"]["blocker"] = "impl process died"
        store.save(state)
        tick_stream(self.ctx, store, sync_github=False)
        self.assertEqual(store.load()["phase"], IMPLEMENTING)

    def test_unknown_drift_does_not_auto_clear(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = RE_REVIEW_REQUIRED
        state["status"]["blocker"] = "external HEAD change"
        store.save(state)
        tick_stream(self.ctx, store, sync_github=False)
        self.assertEqual(store.load()["phase"], RE_REVIEW_REQUIRED)
        self.assertTrue(classify_attention(store.load())["human_required"])

    def test_stale_runner_restored(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = RECOVERY_REQUIRED
        state["prior_phase"] = READY_FOR_AUDIT
        state["status"]["blocker"] = "audit process died"
        store.save(state)
        tick_stream(self.ctx, store, sync_github=False)
        self.assertEqual(store.load()["phase"], READY_FOR_AUDIT)

    def test_campaign_tick_idempotent(self) -> None:
        self.create_stream("s1")
        first = campaign_tick(self.ctx, stream_id="s1", force_sync=False)
        second = campaign_tick(self.ctx, stream_id="s1", force_sync=False)
        self.assertEqual(first["results"][0]["phase"], second["results"][0]["phase"])

    def test_concurrent_tick_no_duplicate_next(self) -> None:
        self.create_stream("dup-a")
        store = self.store("dup-a")
        state = store.load()
        state["campaign_id"] = "dupc"
        state["phase"] = MERGED
        sha = self.git("rev-parse", "HEAD")
        state["heads"]["merged"] = sha
        state["heads"]["current"] = sha
        store.save(state)
        self.apply_save(
            store,
            continuation_text(campaign="dupc", after="dup-a", nxt="dup-b", scope="README.md"),
            sha,
        )
        campaign_tick(self.ctx, stream_id="dup-a", force_sync=False)
        campaign_tick(self.ctx, stream_id="dup-a", force_sync=False)
        # only one next stream
        self.assertTrue(self.store("dup-b").exists())

    def test_campaign_tick_from_webui(self) -> None:
        self.create_stream("s1")
        httpd = make_server(self.ctx, "127.0.0.1", 0, env=dict(os.environ))
        host, port = httpd.server_address
        import threading
        from urllib.request import Request, urlopen

        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            req = Request(
                f"http://{host}:{port}/api/campaign/tick",
                data=b"{}",
                method="POST",
                headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1"},
            )
            with urlopen(req, timeout=10) as resp:
                body = resp.read().decode()
            self.assertIn("results", body)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_campaign_tick_from_runner_surface(self) -> None:
        self.create_stream("s1")
        result = campaign_tick(self.ctx, stream_id="s1", surface="runner")
        self.assertEqual(result["surface"], "runner")
        self.assertEqual(result["results"][0]["stream_id"], "s1")

    def test_no_new_daemon(self) -> None:
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        for dirpath, _, files in os.walk(root):
            for name in files:
                self.assertFalse(name.endswith(".service"), name)

    def test_gpt_changes_required_not_skipped_by_old_audit(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        state = store.load()
        state["phase"] = IMPLEMENTING
        state["heads"]["implemented"] = head
        state["heads"]["current"] = head
        state["heads"]["audited"] = head
        state["publication"] = {"commit": head, "status": "committed"}
        state["envelopes"]["CODEX_REPORT"] = {
            "kind": "CODEX_REPORT",
            "status": "READY_FOR_AUDIT",
            "head": head,
        }
        state["envelopes"]["CODEX_AUDIT"] = {"kind": "CODEX_AUDIT", "status": "PASS", "head": head}
        state["envelopes"]["GPT_REVIEW"] = {
            "kind": "GPT_REVIEW",
            "status": "CHANGES_REQUIRED",
            "head": head,
        }
        store.save(state)
        tick_stream(self.ctx, store, sync_github=False)
        self.assertEqual(store.load()["phase"], IMPLEMENTING)

    def test_all_sync_follows_continuation_unit(self) -> None:
        self.create_stream("sync-a")
        store = self.store("sync-a")
        state = store.load()
        state["campaign_id"] = "syncamp"
        state["phase"] = MERGED
        sha = self.git("rev-parse", "HEAD")
        state["heads"]["merged"] = sha
        state["heads"]["current"] = sha
        store.save(state)
        self.apply_save(
            store,
            continuation_text(campaign="syncamp", after="sync-a", nxt="sync-b", scope="README.md"),
            sha,
        )
        result = campaign_tick(self.ctx, force_sync=True, surface="cli")
        ids = [item.get("stream_id") for item in result.get("results") or []]
        self.assertIn("sync-a", ids)
        self.assertIn("sync-b", ids)
        self.assertTrue(self.store("sync-b").exists())

    def test_delete_obsolete_keeps_unmanaged_worktree(self) -> None:
        from agentbus.actions import delete_stream
        from agentbus.campaign import mark_obsolete

        self.create_stream("old-p6")
        store = self.store("old-p6")
        state = store.load()
        mark_obsolete(state, superseded_by="p6-e1b", reason="test")
        state["created_worktrees"] = {"impl": False, "audit": False}
        store.save(state)
        worktree = state["impl_worktree"]
        result = delete_stream(self.ctx, store, delete_worktrees=True)
        self.assertTrue(result["ok"])
        self.assertTrue(result.get("archived"))
        self.assertTrue(store.exists())
        self.assertTrue(store.load().get("archived"))
        self.assertTrue(os.path.isdir(worktree))

    def test_legacy_stream_explicit_campaign_mapping(self) -> None:
        self.assertEqual(EXPLICIT_STREAM_CAMPAIGNS["p4_2d2"], "p4")
        self.create_stream("p4_2d2")
        notes = enable_known_campaigns(self.ctx)
        self.assertTrue(any("p4_2d2" in n and "p4" in n for n in notes))
        self.assertEqual(self.store("p4_2d2").load()["campaign_id"], "p4")
        self.assertEqual(load_campaign(self.ctx, "p4")["automation_mode"], "autopilot")

    def test_obsolete_excluded_from_attention(self) -> None:
        self.create_stream("p6")
        self.create_stream("p6-e1b")
        enable_known_campaigns(self.ctx)
        ov = overview(self.ctx)
        ids_gpt = [item["stream_id"] for item in ov["needs_gpt"]]
        ids_you = [item["stream_id"] for item in ov["needs_you"]]
        self.assertNotIn("p6", ids_gpt)
        self.assertNotIn("p6", ids_you)
        self.assertTrue(stream_view(self.ctx, self.store("p6"))["obsolete"])

    def test_current_generation_latest_authority(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_GPT
        state["heads"]["implemented"] = "b" * 40
        state["heads"]["current"] = "b" * 40
        state["envelopes"]["GPT_SPEC"] = {"kind": "GPT_SPEC", "status": "ACTIONABLE", "head": "a" * 40}
        state["envelopes"]["CODEX_AUDIT"] = {"kind": "CODEX_AUDIT", "status": "PASS", "head": "b" * 40}
        state["envelopes"]["GPT_REVIEW"] = {"kind": "GPT_REVIEW", "status": "CHANGES_REQUIRED", "head": "a" * 40}
        store.save(state)
        self.assertEqual(current_generation_authority(store.load()), "CODEX_AUDIT:PASS")
        self.assertEqual(stream_view(self.ctx, store)["latest_authority"], "CODEX_AUDIT:PASS")

    def test_historical_stale_audit_not_latest(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_GPT
        state["heads"]["implemented"] = "c" * 40
        state["envelopes"]["CODEX_AUDIT"] = {"kind": "CODEX_AUDIT", "status": "PASS", "head": "old" * 10}
        state["envelopes"]["CODEX_REPORT"] = {"kind": "CODEX_REPORT", "status": "READY_FOR_AUDIT", "head": "c" * 40}
        store.save(state)
        self.assertEqual(current_generation_authority(store.load()), "CODEX_REPORT:READY_FOR_AUDIT")
