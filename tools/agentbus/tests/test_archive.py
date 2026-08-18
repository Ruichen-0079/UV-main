from __future__ import annotations

import os

from agentbus.actions import archive_stream, delete_stream, purge_stream, unarchive_stream
from agentbus.apply import apply_envelope, mark_pr_merged
from agentbus.attention import classify_attention
from agentbus.campaign import load_campaign, mark_obsolete
from agentbus.machine import IMPLEMENTING, MERGED
from agentbus.protocol import parse_one
from agentbus.store import StreamStore
from agentbus.tests.harness import AgentbusTest
from agentbus.tests.test_campaign import continuation_text
from agentbus.views import overview, stream_view


class ArchiveTests(AgentbusTest):
    def _merged_campaign(self, stream: str, campaign: str, pr: int = 18) -> StreamStore:
        self.create_stream(stream, "--pr", str(pr))
        store = self.store(stream)
        state = store.load()
        state["campaign_id"] = campaign
        state["phase"] = "FINAL_GATE"
        sha = self.git("rev-parse", "HEAD")
        state["heads"]["merged"] = sha
        store.save(state)
        mark_pr_merged(state, store, merge_sha=sha)
        store.save(state)
        return store

    def test_merged_archive_preserves_anchor(self) -> None:
        store = self._merged_campaign("arc-m", "arcc")
        result = archive_stream(self.ctx, store)
        self.assertTrue(result["archived"])
        state = store.load()
        self.assertTrue(state["archived"])
        tomb = state.get("archive") or {}
        self.assertEqual(tomb.get("pr_number") or tomb.get("pr"), 18)
        self.assertEqual(tomb.get("merge_commit"), state["heads"]["merged"])
        self.assertEqual(tomb.get("campaign_id"), "arcc")

    def test_archived_predecessor_still_resolves_continuation(self) -> None:
        store = self._merged_campaign("arc-c", "arcc2")
        archive_stream(self.ctx, store)
        sha = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="arcc2", after="arc-c", nxt="arc-next", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        self.assertTrue(StreamStore(self.ctx, "arc-next").exists())
        self.assertEqual(self.store("arc-next").load()["phase"], IMPLEMENTING)

    def test_archived_excluded_from_attention_and_unarchive(self) -> None:
        store = self._merged_campaign("arc-v", "arcv")
        archive_stream(self.ctx, store)
        ov = overview(self.ctx)
        self.assertFalse(any(item["stream_id"] == "arc-v" for item in ov["streams"]))
        self.assertEqual(classify_attention(store.load())["attention_owner"], "NONE")
        unarchive_stream(self.ctx, store)
        self.assertFalse(store.load().get("archived"))
        ov = overview(self.ctx, include_archived=False)
        self.assertTrue(any(item["stream_id"] == "arc-v" for item in ov["streams"]))

    def test_obsolete_archives_safely(self) -> None:
        self.create_stream("old-x")
        store = self.store("old-x")
        state = store.load()
        mark_obsolete(state, superseded_by="new-x", reason="test")
        store.save(state)
        result = archive_stream(self.ctx, store)
        self.assertTrue(result["archived"])
        self.assertTrue(store.exists())

    def test_purge_rejected_for_campaign_and_pr(self) -> None:
        store = self._merged_campaign("no-purge", "npc")
        with self.assertRaises(Exception) as exc:
            purge_stream(self.ctx, store)
        self.assertIn("PURGE_NOT_ALLOWED", str(exc.exception))
        self.create_stream("pr-unit", "--pr", "9")
        with self.assertRaises(Exception):
            purge_stream(self.ctx, self.store("pr-unit"))

    def test_purge_allowed_abandoned_local_draft(self) -> None:
        self.create_stream("draft-x")
        store = self.store("draft-x")
        state = store.load()
        state["control"] = "paused"
        store.save(state)
        result = purge_stream(self.ctx, store)
        self.assertTrue(result.get("purged"))
        self.assertFalse(store.exists())

    def test_legacy_delete_maps_to_archive(self) -> None:
        store = self._merged_campaign("leg-a", "legc")
        result = delete_stream(self.ctx, store)
        self.assertTrue(result.get("archived"))
        self.assertTrue(store.exists())
        self.assertTrue(store.load().get("archived"))

    def test_webui_archive_and_purge_flags(self) -> None:
        store = self._merged_campaign("ui-m", "uic")
        view = stream_view(self.ctx, store)
        self.assertTrue(view["archivable"])
        self.assertFalse(view["purgeable"])
        self.create_stream("ui-d")
        draft = self.store("ui-d")
        state = draft.load()
        state["control"] = "paused"
        draft.save(state)
        dview = stream_view(self.ctx, draft)
        self.assertTrue(dview["purgeable"])
        self.assertFalse(dview["archivable"])
