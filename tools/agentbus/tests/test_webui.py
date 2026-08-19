from __future__ import annotations

import json
import multiprocessing
import os
import stat
import threading
import urllib.error
import urllib.request
from unittest.mock import patch

from agentbus.actions import bind_browser_gpt, unbind_browser_gpt
from agentbus.launcher import existing_url, probe
from agentbus.lock import StreamLock
from agentbus.machine import WAITING_FOR_SPEC
from agentbus.tests.harness import AgentbusTest
from agentbus.web import DEFAULT_HOST, make_server


def _hold_stream_lock(
    path: str,
    ready: multiprocessing.synchronize.Event,
    release: multiprocessing.synchronize.Event,
) -> None:
    lock = StreamLock(path)
    if not lock.try_acquire():
        raise RuntimeError(f"could not acquire test stream lock {path}")
    try:
        ready.set()
        release.wait(10)
    finally:
        lock.release()


class WebUITests(AgentbusTest):
    def setUp(self) -> None:
        super().setUp()
        self._write_fake_konsole()
        self.httpd = make_server(self.ctx, DEFAULT_HOST, 0, env=dict(os.environ))
        self.host, self.port = self.httpd.server_address
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def _write_fake_konsole(self) -> None:
        path = os.path.join(self.bin, "konsole")
        body = """#!/usr/bin/env python3
import json, os, sys
log = os.environ.get("FAKE_KONSOLE_LOG")
if log:
    open(log, "a").write(json.dumps(sys.argv[1:]) + "\\n")
"""
        from agentbus.util import atomic_write_text

        atomic_write_text(path, body)
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
        os.environ["YUVI_AGENTBUS_KONSOLE"] = path
        os.environ["FAKE_KONSOLE_LOG"] = os.path.join(self.root, "konsole.log")

    def _locked_stream(self, stream_id: str) -> tuple[multiprocessing.Process, multiprocessing.synchronize.Event]:
        context = multiprocessing.get_context("fork")
        ready = context.Event()
        release = context.Event()
        process = context.Process(
            target=_hold_stream_lock,
            args=(self.store(stream_id).lock_path, ready, release),
        )
        process.start()
        self.assertTrue(ready.wait(3), "test stream lock holder did not become ready")
        return process, release

    def _stop_locked_stream(
        self,
        process: multiprocessing.Process,
        release: multiprocessing.synchronize.Event,
    ) -> None:
        release.set()
        process.join(3)
        if process.is_alive():
            process.terminate()
            process.join(3)
        self.assertFalse(process.is_alive())

    def http(self, path: str, payload: dict | None = None, method: str | None = None) -> tuple[int, dict | str]:
        url = f"http://{self.host}:{self.port}{path}"
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
            method = method or "POST"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                raw = response.read().decode("utf-8")
                code = response.status
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8")
            code = exc.code
        try:
            return code, json.loads(raw)
        except json.JSONDecodeError:
            return code, raw

    def test_binds_localhost_only(self) -> None:
        self.assertEqual(self.host, "127.0.0.1")

    def test_health_and_index(self) -> None:
        code, data = self.http("/api/health")
        self.assertEqual(code, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["service"], "yuvi-agentbus")
        code, html = self.http("/")
        self.assertEqual(code, 200)
        self.assertIn("Yuvi AgentBus", html)

    def test_browser_jobs_are_get_only_and_global_settings_are_nonsecret(self) -> None:
        self.create_stream("browser-api")
        code, configured = self.http(
            "/api/settings/gpt",
            {"role": "PRODUCT_GPT", "url": "https://chatgpt.com/c/product-global"},
        )
        self.assertEqual(code, 200, configured)
        self.assertEqual(configured["settings"]["product_gpt"]["url"], "https://chatgpt.com/c/product-global")

        code, first = self.http("/api/browser/jobs")
        self.assertEqual(code, 200, first)
        self.assertEqual(first["authority"], "GitHub PR comments and PR state")
        self.assertEqual(first["bridge"]["status"], "ONLINE")
        jobs = [item for item in first["jobs"] if item["stream"] == "browser-api"]
        self.assertEqual(len(jobs), 1)
        self.assertEqual((jobs[0]["role"], jobs[0]["task"]), ("PRODUCT_GPT", "PLAN_SPEC"))
        job_id = jobs[0]["job_id"]

        code, second = self.http("/api/browser/jobs")
        self.assertEqual(code, 200, second)
        self.assertIn(job_id, {item["job_id"] for item in second["jobs"]})
        self.assertNotIn("GPT_SPEC", self.store("browser-api").load()["envelopes"])

        code, _ = self.http("/api/browser/jobs", {}, method="POST")
        self.assertIn(code, {400, 404})
        self.assertNotIn("GPT_SPEC", self.store("browser-api").load()["envelopes"])

    def test_ui_is_simplified_chinese_without_changing_api(self) -> None:
        code, html = self.http("/")
        self.assertEqual(code, 200)
        self.assertIn('lang="zh-CN"', html)
        self.assertIn("需要你处理", html)
        self.assertIn("新建任务", html)
        self.assertIn("任务列表", html)
        self.assertIn("显示已归档", html)
        js_path = os.path.join(os.path.dirname(__file__), "..", "webui", "app.js")
        with open(js_path, encoding="utf-8") as handle:
            js = handle.read()
        self.assertIn("归档任务", js)
        self.assertIn("彻底删除", js)
        self.assertIn("I18N_ZH_CN", js)
        self.assertIn("PHASE_LABELS_ZH", js)
        self.assertIn("WAITING_FOR_SPEC", js)
        self.assertIn("同步进行中", js)
        self.assertIn("sync_in_progress", js)
        self.create_stream("s1", "--goal", "zh check")
        _, view = self.http("/api/streams/s1")
        self.assertEqual(view["phase"], WAITING_FOR_SPEC)
        self.assertEqual(view["visible_phase"], WAITING_FOR_SPEC)
        self.assertIn(view["attention"], {"needs_gpt", "waiting"})
        self.assertIn("impl", view)
        self.assertEqual(view["impl"]["sandbox"], "workspace-write")
        self.assertEqual(view["audit"]["sandbox"], "read-only")

    def test_relaunch_reuses_server(self) -> None:
        first = probe(self.host, self.port)
        second = probe(self.host, self.port)
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        url = existing_url(self.ctx, self.host, self.port)
        self.assertEqual(url, f"http://{self.host}:{self.port}/")

    def test_create_and_list_and_needs_you(self) -> None:
        code, created = self.http(
            "/api/streams",
            {
                "stream": "p7-9a",
                "goal": "web create",
                "create_worktree": True,
                "impl_model": "gpt-5.6-terra",
                "impl_effort": "high",
                "audit_model": "gpt-5.6-sol",
                "audit_effort": "xhigh",
            },
        )
        self.assertEqual(code, 201, created)
        self.assertEqual(created["stream"]["impl"]["model"], "gpt-5.6-terra")
        self.assertEqual(created["stream"]["audit"]["model"], "gpt-5.6-sol")
        self.assertEqual(created["stream"]["impl"]["effort"], "high")
        self.assertEqual(created["stream"]["audit"]["effort"], "xhigh")
        code, overview = self.http("/api/overview")
        self.assertEqual(code, 200)
        self.assertEqual(overview["counts"]["total"], 1)
        self.assertEqual(len(overview["needs_you"]), 0)
        self.assertEqual(len(overview["needs_gpt"]), 0)
        created_view = next(item for item in overview["streams"] if item["stream_id"] == "p7-9a")
        self.assertEqual(created_view["attention_category"], "AUTO_WAIT")
        self.assertEqual(created_view["next_action"], "WAIT")

    def test_pause_resume_and_models_isolated(self) -> None:
        self.http("/api/streams", {"stream": "a1", "goal": "A", "create_worktree": True})
        self.http("/api/streams", {"stream": "b1", "goal": "B", "create_worktree": True})
        self.http("/api/streams/a1/model", {"role": "impl", "model": "gpt-5.6-terra", "effort": "high"})
        self.http("/api/streams/a1/model", {"role": "audit", "model": "gpt-5.6-sol", "effort": "high"})
        self.http("/api/streams/b1/model", {"role": "impl", "model": "gpt-5.6-luna", "effort": "max"})
        self.http("/api/streams/a1/pause", {})
        _, a = self.http("/api/streams/a1")
        _, b = self.http("/api/streams/b1")
        self.assertEqual(a["control"], "paused")
        self.assertEqual(a["impl"]["model"], "gpt-5.6-terra")
        self.assertEqual(a["audit"]["model"], "gpt-5.6-sol")
        self.assertEqual(b["control"], "running")
        self.assertEqual(b["impl"]["model"], "gpt-5.6-luna")
        self.http("/api/streams/a1/resume", {})
        _, a = self.http("/api/streams/a1")
        self.assertEqual(a["control"], "running")

    def test_browser_bind_rebind_clear_does_not_change_phase(self) -> None:
        self.create_stream("s1", "--goal", "gpt bind")
        store = self.store("s1")
        phase = store.load()["phase"]
        self.assertEqual(phase, WAITING_FOR_SPEC)
        code, data = self.http(
            "/api/streams/s1/bind-gpt",
            {"display_name": "Planning A", "url": "https://chatgpt.com/c/aaa", "note": "first"},
        )
        self.assertEqual(code, 200)
        self.assertEqual(data["stream"]["browser_gpt"]["display_name"], "Planning A")
        self.assertEqual(store.load()["phase"], phase)
        self.http(
            "/api/streams/s1/bind-gpt",
            {"display_name": "Planning B", "url": "https://chatgpt.com/c/bbb", "note": "rebind"},
        )
        self.assertEqual(store.load()["browser_gpt"]["display_name"], "Planning B")
        self.assertEqual(store.load()["phase"], phase)
        self.http("/api/streams/s1/unbind-gpt", {})
        state = store.load()
        self.assertEqual(state["phase"], phase)
        self.assertIsNone(state["browser_gpt"]["url"])
        # CLI still works with WebUI up
        out = self.ok("status")
        self.assertIn("s1", out)

    def test_open_pr_url_and_workspace_terminals(self) -> None:
        self.http("/api/streams", {"stream": "s1", "pr": 24, "create_worktree": True})
        _, view = self.http("/api/streams/s1")
        self.assertEqual(view["pr_url"], "https://github.com/example/yuvi-test/pull/24")
        code, data = self.http("/api/streams/s1/workspace", {})
        self.assertEqual(code, 200, data)
        created = set(data.get("opened") or []) | set(data.get("reused") or [])
        self.assertIn("impl", created)
        self.assertIn("audit", created)
        code2, data2 = self.http("/api/streams/s1/workspace", {})
        self.assertEqual(code2, 200, data2)
        self.assertIn("impl", set(data2.get("reused") or []) | set(data2.get("opened") or []))
        runtime = self.store("s1").load_runtime()
        self.assertEqual((runtime.get("konsole") or {}).get("impl", {}).get("title"), "S1 | IMPL")
        self.assertEqual((runtime.get("konsole") or {}).get("audit", {}).get("title"), "S1 | AUDIT")
        self.http("/api/streams/s1/open-terminal", {"role": "impl"})
        self.assertEqual(self.store("s1").load()["phase"], WAITING_FOR_SPEC)

    def test_get_cannot_mutate(self) -> None:
        self.create_stream("s1")
        code, _ = self.http("/api/streams/s1/pause", method="GET")
        self.assertIn(code, {400, 404})
        self.assertEqual(self.store("s1").load()["control"], "running")

    def test_webui_restart_keeps_durable_state(self) -> None:
        self.http(
            "/api/streams",
            {
                "stream": "persist",
                "goal": "keep me",
                "browser_name": "Planning A",
                "browser_url": "https://chatgpt.com/c/zzz",
            },
        )
        self.httpd.shutdown()
        self.httpd.server_close()
        self.httpd = make_server(self.ctx, DEFAULT_HOST, 0, env=dict(os.environ))
        self.host, self.port = self.httpd.server_address
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        _, view = self.http("/api/streams/persist")
        self.assertEqual(view["goal"], "keep me")
        self.assertEqual(view["browser_gpt"]["display_name"], "Planning A")
        # CLI without WebUI
        self.httpd.shutdown()
        out = self.ok("plan", "persist")
        self.assertIn("keep me", out)
        bind_browser_gpt(self.store("persist"), display_name="B", url="https://example.com/x", note=None)
        unbind_browser_gpt(self.store("persist"))
        self.assertEqual(self.store("persist").load()["phase"], WAITING_FOR_SPEC)

    def test_sync_returns_json_not_empty_reply(self) -> None:
        self.create_stream("s1", "--pr", "24")
        os.environ["FAKE_GH_MODE"] = "down"
        code, data = self.http("/api/streams/s1/sync", {})
        self.assertIn(code, {200, 502})
        self.assertIsInstance(data, dict)
        self.assertIn("ok" in data or "error" in data or "notes" in data, {True})

    def test_top_sync_all_streams(self) -> None:
        self.create_stream("a1")
        self.create_stream("b1")
        code, data = self.http("/api/sync", {})
        self.assertEqual(code, 200, data)
        self.assertTrue(data.get("ok"))
        synced = data.get("synced") or []
        self.assertIn("a1", synced)
        self.assertIn("b1", synced)

    def test_sync_busy_is_successful_and_non_error(self) -> None:
        self.create_stream("s1")
        busy = {
            "ok": True,
            "surface": "webui",
            "busy": True,
            "coalesced": True,
            "reason": "campaign tick already in progress",
            "results": [],
            "synced": [],
        }
        with patch("agentbus.autopilot.campaign_tick", return_value=busy):
            code, data = self.http("/api/streams/s1/sync", {})
        self.assertEqual(code, 200, data)
        self.assertTrue(data["ok"])
        self.assertTrue(data["sync_in_progress"])
        self.assertTrue(data["coalesced"])
        self.assertEqual(data["stream"]["stream_id"], "s1")
        self.assertNotIn("Sync failed", data)

    def test_stream_sync_busy_result_is_successful_and_non_error(self) -> None:
        self.create_stream("s1")
        busy = {
            "ok": True,
            "surface": "webui",
            "results": [
                {
                    "ok": True,
                    "stream_id": "s1",
                    "busy": True,
                    "coalesced": True,
                    "reason": "stream reconciliation already in progress",
                    "notes": [],
                }
            ],
            "synced": ["s1"],
        }
        with patch("agentbus.autopilot.campaign_tick", return_value=busy):
            code, data = self.http("/api/streams/s1/sync", {})
        self.assertEqual(code, 200, data)
        self.assertTrue(data["ok"])
        self.assertTrue(data["sync_in_progress"])
        self.assertTrue(data["coalesced"])
        self.assertTrue(data["busy"])
        self.assertEqual(data["stream"]["stream_id"], "s1")
        self.assertNotIn("Sync failed", data)

    def test_stream_view_uses_durable_snapshot_while_busy(self) -> None:
        self.create_stream("s1", "--goal", "persisted while busy")
        process, release = self._locked_stream("s1")
        try:
            code, data = self.http("/api/streams/s1")
            self.assertEqual(code, 200, data)
            self.assertTrue(data["stream_busy"])
            self.assertEqual(data["goal"], "persisted while busy")
        finally:
            self._stop_locked_stream(process, release)

    def test_sync_internal_error_remains_502(self) -> None:
        self.create_stream("s1")
        with patch(
            "agentbus.autopilot.campaign_tick",
            side_effect=RuntimeError("real scheduler failure"),
        ):
            code, data = self.http("/api/sync", {})
        self.assertEqual(code, 502)
        self.assertEqual(data["error"], "Sync failed")
        self.assertIn("real scheduler failure", data["detail"])

    def test_delete_completed_and_refuse_active(self) -> None:
        from agentbus.machine import MERGED, READY_FOR_GPT

        self.create_stream("done-1")
        store = self.store("done-1")
        state = store.load()
        state["phase"] = MERGED
        store.save(state)
        code, view = self.http("/api/streams/done-1")
        self.assertEqual(code, 200)
        self.assertTrue(view["deletable"])
        self.assertTrue(view["archivable"])
        code, data = self.http("/api/streams/done-1/delete", {"delete_worktrees": True})
        self.assertEqual(code, 200, data)
        self.assertTrue(self.store("done-1").exists())
        self.assertTrue(self.store("done-1").load().get("archived"))
        self.create_stream("live-1")
        store = self.store("live-1")
        state = store.load()
        state["phase"] = READY_FOR_GPT
        store.save(state)
        code, data = self.http("/api/streams/live-1/delete", {})
        self.assertEqual(code, 400)
        self.assertTrue(self.store("live-1").exists())

    def test_effort_controls_via_api(self) -> None:
        self.create_stream("s1")
        self.http("/api/streams/s1/model", {"role": "impl", "effort": "max", "inherit_effort": False})
        self.http("/api/streams/s1/model", {"role": "audit", "effort": "none", "inherit_effort": False})
        code, bad = self.http("/api/streams/s1/model", {"role": "audit", "effort": "ultra", "inherit_effort": False})
        self.assertEqual(code, 400)
        self.assertIn("ultra", (bad.get("error") or "").lower())
        _, view = self.http("/api/streams/s1")
        self.assertEqual(view["impl"]["effort"], "max")
        self.assertEqual(view["audit"]["effort"], "none")

    def test_reject_bad_gpt_url(self) -> None:
        self.create_stream("s1")
        code, data = self.http("/api/streams/s1/bind-gpt", {"url": "javascript:alert(1)"})
        self.assertEqual(code, 400)
        self.assertIn("http", data["error"])

    def test_publication_is_visible_and_recoverable(self) -> None:
        from agentbus.util import atomic_write_text

        code, html = self.http("/")
        self.assertEqual(code, 200)
        with open(os.path.join(os.path.dirname(__file__), "..", "webui", "app.js"), encoding="utf-8") as handle:
            js = handle.read()
        self.assertIn("recover-pub", js)
        self.assertIn("尚未达到可审计状态", js)
        self.create_stream("s1", "--worktree", self.repo, "--branch", "main")
        store = self.store("s1")
        atomic_write_text(os.path.join(self.repo, "web-pub.txt"), "from-ui\n")
        os.environ["YUVI_AGENTBUS_PUSH"] = "0"
        code, data = self.http("/api/streams/s1/publish", {"recover": True})
        self.assertEqual(code, 200, data)
        self.assertTrue(data.get("commit"))
        _, view = self.http("/api/streams/s1")
        self.assertEqual(view["publication"]["status"] in {"committed", "pushed"}, True)
        self.assertEqual(view["heads"]["implemented"], data["commit"])
