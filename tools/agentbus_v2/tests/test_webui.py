from __future__ import annotations

from dataclasses import replace
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import (
    Action,
    ActionKind,
    GptResult,
    Snapshot,
    GPT_PACKET_SCHEMA,
)
from tools.agentbus_v2.effects import EffectResult
from tools.agentbus_v2.facts import FactError
from tools.agentbus_v2 import webui
from tools.agentbus_v2.scheduler import ProjectEntry


SHA = "1" * 40


def make_config(state: Path, p_id: str, worktree: Path) -> None:
    root = state / p_id
    root.mkdir(parents=True, exist_ok=True)
    (root / "config.json").write_text(
        json.dumps(
            {
                "p_id": p_id,
                "worktree": str(worktree),
                "repository": "github.com/test/repo",
                "remote": "origin",
                "branch": f"agentbus/{p_id.lower()}",
                "base_ref": "main",
                "seed_head": SHA,
                "charter_digest": "c" * 64,
                "proof_commands": [],
                "required_ci_checks": [],
            }
        ),
        encoding="utf-8",
    )


def write_registry(path: Path, entries: list[dict[str, object]]) -> None:
    path.write_text(json.dumps({"projects": entries}), encoding="utf-8")


class HTTPHarness:
    def __init__(self, state: webui.WebUIState) -> None:
        self.server = webui.make_server(state, host="127.0.0.1", port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host, self.port = self.server.server_address[:2]

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: object | None = None,
        token: str | None = None,
    ) -> tuple[int, dict[str, object] | str]:
        connection = http.client.HTTPConnection(self.host, self.port, timeout=3)
        headers = {"Accept": "application/json"}
        encoded: bytes | None = None
        if body is not None:
            encoded = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token is not None:
            headers["X-AgentBus-Token"] = token
        connection.request(method, path, body=encoded, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        try:
            return response.status, json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError:
            return response.status, payload.decode("utf-8")

    def close(self, state: webui.WebUIState) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        state.stop_scheduler()


class WebUITests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.state_root = root / "state"
        self.state_root.mkdir()
        self.worktree = root / "worktree"
        self.worktree.mkdir()
        make_config(self.state_root, "P1", self.worktree)
        self.registry_file = self.state_root / "projects.json"
        write_registry(self.registry_file, [{
            "p_id": "P1", "enabled": True, "global_plan_fallback": True,
        }])
        self.state = webui.WebUIState(self.state_root)
        self.snapshot = Snapshot(
            p_id="P1",
            charter_digest="c" * 64,
            expected_repository="github.com/test/repo",
            expected_branch="agentbus/p1",
            base_ref="main",
            head=SHA,
            base=SHA,
        )
        self.action = Action(ActionKind.PLAN, effect_id="plan-" + "a" * 24, reason="need GPT")
        self.server = HTTPHarness(self.state)

    def tearDown(self) -> None:
        self.server.close(self.state)
        self.temp.cleanup()

    def post(self, path: str, body: object, *, token: str | None = None):
        return self.server.request(path, method="POST", body=body, token=token or self.state.token)

    def _write_packet(self, job_id: str, operation: str = "PLAN_GPT") -> None:
        packet = self.state_root / "P1" / "gpt" / "outbox" / f"{job_id}.md"
        packet.parent.mkdir(parents=True, exist_ok=True)
        packet.write_text(
            "# packet\n## SEMANTIC INPUTS\n```json\n"
            + json.dumps(
                {
                    "packet_schema": GPT_PACKET_SCHEMA,
                    "job_id": job_id,
                    "operation": operation,
                    "semantic_input": {"job_id": job_id, "operation": operation},
                }
            )
            + "\n```\n",
            encoding="utf-8",
        )

    @staticmethod
    def _compat_status(
        *,
        plan_state: str = "waiting-browser",
        judge_state: str = "idle",
        plan_pending: int = 1,
        judge_pending: int = 0,
        extension: str = "ONLINE",
        mailbox: str = "available",
        last_error: str | None = None,
        served_jobs: tuple[str, ...] = (),
    ) -> dict[str, object]:
        plan_job_id = "plan-" + "a" * 24
        jobs = []
        if plan_pending:
            jobs.append({
                "job_id": plan_job_id,
                "operation": "PLAN_GPT",
                "p_id": "P1",
                "conversation_url": "https://chatgpt.com/c/plan-test",
                "served_to_extension": plan_job_id in served_jobs,
                "first_server_serve": "2026-01-01T00:00:00+00:00" if plan_job_id in served_jobs else None,
                "last_server_serve": "2026-01-01T00:00:00+00:00" if plan_job_id in served_jobs else None,
            })
        if judge_pending:
            jobs.append({
                "job_id": "judge-" + "b" * 24,
                "operation": "JUDGE_GPT",
                "p_id": "P1",
                "conversation_url": "https://chatgpt.com/c/judge-test",
                "served_to_extension": ("judge-" + "b" * 24) in served_jobs,
                "first_server_serve": "2026-01-01T00:00:00+00:00" if ("judge-" + "b" * 24) in served_jobs else None,
                "last_server_serve": "2026-01-01T00:00:00+00:00" if ("judge-" + "b" * 24) in served_jobs else None,
            })
        return {
            "configured": True,
            "transport_mode": "SIGNED_V1_EXTENSION_COMPAT",
            "legacy_v1_extension": extension,
            "last_poll": "2026-01-01T00:00:00+00:00",
            "mailbox": mailbox,
            "last_error": last_error,
            "plan": {"state": plan_state, "pending": plan_pending},
            "judge": {"state": judge_state, "pending": judge_pending},
            "jobs": jobs,
            "recent_ingestion": [],
        }

    def test_root_and_status_are_live_projection(self) -> None:
        packet = self.state_root / "P1" / "gpt" / "outbox" / f"{self.action.effect_id}.md"
        packet.parent.mkdir(parents=True)
        packet.write_text("manual packet", encoding="utf-8")
        with patch.object(webui, "read_snapshot", return_value=self.snapshot) as read, \
                patch.object(webui, "decide", return_value=self.action) as decide, \
                patch.object(self.state.scheduler.gpt_transport, "try_dispatch") as dispatch:
            status, html = self.server.request("/")
            self.assertEqual(200, status)
            self.assertIn("AgentBus v2", str(html))
            status, payload = self.server.request("/api/status")
        self.assertEqual(200, status)
        assert isinstance(payload, dict)
        self.assertEqual("PLAN", payload["projects"][0]["action"])
        self.assertEqual(SHA[:8], payload["projects"][0]["head"])
        self.assertEqual(self.action.effect_id, payload["projects"][0]["manual_gpt"]["job_id"])
        self.assertEqual("PLAN_GPT", payload["projects"][0]["manual_gpt"]["operation"])
        self.assertEqual({"plan", "judge"}, {item["name"] for item in payload["gpt_lanes"]})
        self.assertEqual(
            "SIGNED_V1_EXTENSION_COMPAT",
            payload["browser_transport"]["transport_mode"],
        )
        self.assertGreater(read.call_count, 0)
        self.assertGreater(decide.call_count, 0)
        dispatch.assert_not_called()
        self.assertEqual([], payload["events"])

    def test_legacy_browser_jobs_endpoint_is_v2_owned_and_read_only(self) -> None:
        projected = {
            "jobs": [{"job_id": self.action.effect_id, "role": "PRODUCT_GPT"}],
            "bridge": {"transport_mode": "SIGNED_V1_EXTENSION_COMPAT"},
        }
        with patch.object(
            self.state.legacy_browser_compat,
            "poll_and_project",
            return_value=projected,
        ) as poll:
            status, payload = self.server.request("/api/browser/jobs")
        self.assertEqual(200, status)
        self.assertEqual(projected, payload)
        poll.assert_called_once_with()

    def test_status_keeps_exact_retained_gpt_packet_deliverable_when_core_is_idle(self) -> None:
        job_id = self.action.effect_id
        packet_path = self.state_root / "P1" / "gpt" / "outbox" / f"{job_id}.md"
        packet_path.parent.mkdir(parents=True)
        packet_path.write_text(
            "# packet\n## SEMANTIC INPUTS\n```json\n"
            + json.dumps({
                "packet_schema": GPT_PACKET_SCHEMA,
                "job_id": job_id,
                "operation": "PLAN_GPT",
                "semantic_input": {"job_id": job_id, "operation": "PLAN_GPT"},
            })
            + "\n```\n",
            encoding="utf-8",
        )
        pending = replace(self.snapshot, gpt_pending=frozenset({job_id}))
        idle = Action(ActionKind.IDLE, reason="GPT result is absent")
        with patch.object(webui, "read_snapshot", return_value=pending), patch.object(
            webui, "decide", return_value=idle
        ):
            status, payload = self.server.request("/api/status")
        self.assertEqual(200, status)
        self.assertEqual("IDLE", payload["projects"][0]["action"])
        self.assertEqual(job_id, payload["projects"][0]["manual_gpt"]["job_id"])
        self.assertEqual("PLAN_GPT", payload["projects"][0]["manual_gpt"]["operation"])

    def test_pending_plan_is_auto_signed_v1_and_manual_fallback_is_advanced(self) -> None:
        job_id = self.action.effect_id
        self._write_packet(job_id)
        pending = replace(self.snapshot, gpt_pending=frozenset({job_id}))
        with patch.object(webui, "read_snapshot", return_value=pending), patch.object(
            webui, "decide", return_value=Action(ActionKind.IDLE, reason="GPT result is absent")
        ), patch.object(
            self.state.legacy_browser_compat,
            "status",
            return_value=self._compat_status(),
        ):
            status, payload = self.server.request("/api/status")
            root_status, html = self.server.request("/")
        self.assertEqual(200, status)
        self.assertEqual(200, root_status)
        gpt = payload["projects"][0]["gpt_transport"]
        self.assertEqual("PLAN_GPT", gpt["operation"])
        self.assertEqual("AUTO", gpt["mode"])
        self.assertEqual("SIGNED_V1_EXTENSION_COMPAT", gpt["transport"])
        self.assertEqual("WAITING_FOR_BROWSER", gpt["state"])
        self.assertTrue(gpt["served_to_extension"] is False)
        self.assertEqual(job_id, gpt["job_id"])
        self.assertEqual("ONLINE", gpt["extension"])
        self.assertEqual("available", gpt["mailbox"])
        self.assertIn("Automatic signed-extension transport is active", gpt["warning"])
        self.assertEqual("IDLE", payload["projects"][0]["action"])
        self.assertIn('details class="manual-fallback"', html)
        self.assertNotIn('details class="manual-fallback" open', html)
        self.assertIn("Advanced manual GPT fallback", html)

    def test_served_job_stays_waiting_for_browser_without_submission_evidence(self) -> None:
        job_id = self.action.effect_id
        self._write_packet(job_id)
        pending = replace(self.snapshot, gpt_pending=frozenset({job_id}))
        with patch.object(webui, "read_snapshot", return_value=pending), patch.object(
            webui, "decide", return_value=Action(ActionKind.IDLE, reason="GPT result is absent")
        ), patch.object(
            self.state.legacy_browser_compat,
            "status",
            return_value=self._compat_status(served_jobs=(job_id,)),
        ):
            _, payload = self.server.request("/api/status")
        gpt = payload["projects"][0]["gpt_transport"]
        self.assertEqual("WAITING_FOR_BROWSER", gpt["state"])
        self.assertTrue(gpt["served_to_extension"])
        self.assertNotIn("submitted", str(gpt).lower())

    def test_pending_judge_uses_auto_signed_v1_lane(self) -> None:
        job_id = "judge-" + "b" * 24
        self._write_packet(job_id, "JUDGE_GPT")
        pending = replace(self.snapshot, gpt_pending=frozenset({job_id}))
        with patch.object(webui, "read_snapshot", return_value=pending), patch.object(
            webui, "decide", return_value=Action(ActionKind.IDLE, reason="GPT result is absent")
        ), patch.object(
            self.state.legacy_browser_compat,
            "status",
            return_value=self._compat_status(
                plan_state="idle", plan_pending=0, judge_state="pending", judge_pending=1
            ),
        ):
            status, payload = self.server.request("/api/status")
        self.assertEqual(200, status)
        gpt = payload["projects"][0]["gpt_transport"]
        self.assertEqual("JUDGE_GPT", gpt["operation"])
        self.assertEqual("AUTO", gpt["mode"])
        self.assertEqual("WAITING_FOR_BROWSER", gpt["state"])
        self.assertEqual(job_id, gpt["job_id"])

    def test_auto_transport_offline_and_mailbox_errors_are_operational_only(self) -> None:
        projection = webui.WebUIState._gpt_transport_projection(
            self._compat_status(extension="OFFLINE"),
            "PLAN_GPT",
            self.action.effect_id,
            None,
        )
        self.assertEqual("TRANSPORT_OFFLINE", projection["state"])
        projection = webui.WebUIState._gpt_transport_projection(
            self._compat_status(mailbox="unavailable", last_error="mailbox unavailable"),
            "PLAN_GPT",
            self.action.effect_id,
            None,
        )
        self.assertEqual("TRANSPORT_ERROR", projection["state"])
        self.assertEqual("mailbox unavailable", projection["last_error"])

    def test_durable_result_is_reported_as_result_received_without_manual_fallback(self) -> None:
        result = GptResult(self.action.effect_id, "PLAN_GPT", "SPEC", "bounded spec")
        snapshot = replace(self.snapshot, gpt_results=(result,))
        with patch.object(webui, "read_snapshot", return_value=snapshot), patch.object(
            webui, "decide", return_value=Action(ActionKind.WORK, reason="SPEC accepted")
        ), patch.object(
            self.state.legacy_browser_compat,
            "status",
            return_value=self._compat_status(plan_state="idle", plan_pending=0),
        ):
            status, payload = self.server.request("/api/status")
        self.assertEqual(200, status)
        self.assertEqual("WORK", payload["projects"][0]["action"])
        gpt = payload["projects"][0]["gpt_transport"]
        self.assertEqual("RESULT_RECEIVED", gpt["state"])
        self.assertEqual(self.action.effect_id, gpt["job_id"])
        self.assertEqual("SPEC", gpt["decision"])
        self.assertIsNone(payload["projects"][0]["manual_gpt"])

    def test_manual_only_fallback_remains_available_when_compat_is_unconfigured(self) -> None:
        job_id = self.action.effect_id
        self._write_packet(job_id)
        pending = replace(self.snapshot, gpt_pending=frozenset({job_id}))
        manual_status = {
            "configured": False,
            "transport_mode": "SIGNED_V1_EXTENSION_COMPAT",
            "legacy_v1_extension": "OFFLINE",
            "last_poll": None,
            "mailbox": "unconfigured",
            "last_error": None,
            "plan": {"state": "idle", "pending": 0},
            "judge": {"state": "idle", "pending": 0},
            "recent_ingestion": [],
        }
        with patch.object(webui, "read_snapshot", return_value=pending), patch.object(
            webui, "decide", return_value=Action(ActionKind.IDLE, reason="GPT result is absent")
        ), patch.object(
            self.state.legacy_browser_compat, "status", return_value=manual_status
        ):
            status, payload = self.server.request("/api/status")
        self.assertEqual(200, status)
        gpt = payload["projects"][0]["gpt_transport"]
        self.assertEqual("MANUAL", gpt["mode"])
        self.assertEqual("MANUAL_FALLBACK", gpt["state"])
        self.assertIsNotNone(gpt["manual_fallback"])

    def test_mutations_change_registry_only_and_unknown_is_rejected(self) -> None:
        status, payload = self.post("/api/project/P1/enabled", {"enabled": False})
        self.assertEqual(200, status)
        self.assertEqual(False, payload["enabled"])
        status, payload = self.post("/api/project/P1/allow-merge", {"allow_merge": True})
        self.assertEqual(200, status)
        self.assertEqual(True, payload["allow_merge"])
        registry = json.loads(self.registry_file.read_text(encoding="utf-8"))
        self.assertEqual(
            {
                "p_id": "P1", "enabled": False, "allow_merge": True,
                "global_plan_fallback": True,
            },
            registry["projects"][0],
        )
        status, payload = self.post("/api/project/UNKNOWN/enabled", {"enabled": True})
        self.assertEqual(404, status)
        self.assertIn("unknown", payload["error"])

    def test_mutations_require_exact_json_and_loopback_token(self) -> None:
        with self.assertRaisesRegex(ValueError, "loopback"):
            webui.make_server(self.state, host="0.0.0.0", port=0)
        status, payload = self.server.request(
            "/api/project/P1/enabled", method="POST", body={"enabled": False}
        )
        self.assertEqual(403, status)
        self.assertIn("token", payload["error"])
        status, payload = self.post(
            "/api/project/P1/tick", {"command": "rm -rf /", "path": "/"}
        )
        self.assertEqual(400, status)
        self.assertIn("exactly", payload["error"])

    def test_tick_uses_scheduler_boundary_and_reports_busy(self) -> None:
        with patch.object(self.state, "tick_now", return_value={"accepted": True}) as tick:
            status, _ = self.post("/api/project/P1/tick", {})
        self.assertEqual(202, status)
        tick.assert_called_once_with("P1")
        with patch.object(
            self.state,
            "tick_now",
            side_effect=webui.WebUIError(409, "P is already in flight: P1"),
        ):
            status, payload = self.post("/api/project/P1/tick", {})
        self.assertEqual(409, status)
        self.assertIn("in flight", payload["error"])

    def test_allow_merge_does_not_call_merge(self) -> None:
        with patch.object(webui, "execute_merge", create=True) as merge, patch.object(
            webui, "update_project", wraps=webui.update_project
        ) as update:
            status, _ = self.post("/api/project/P1/allow-merge", {"allow_merge": True})
        self.assertEqual(200, status)
        update.assert_called_once()
        merge.assert_not_called()

    def test_gpt_submit_delegates_to_existing_strict_ingestion(self) -> None:
        job_id = self.action.effect_id
        packet_path = self.state_root / "P1" / "gpt" / "outbox" / f"{job_id}.md"
        packet_path.parent.mkdir(parents=True)
        packet_path.write_text(
            "# packet\n## SEMANTIC INPUTS\n```json\n"
            + json.dumps(
                {
                    "packet_schema": GPT_PACKET_SCHEMA,
                    "job_id": job_id,
                    "operation": "PLAN_GPT",
                    "semantic_input": {"job_id": job_id, "operation": "PLAN_GPT"},
                }
            )
            + "\n```\n",
            encoding="utf-8",
        )
        response = {
            "job_id": job_id,
            "operation": "PLAN_GPT",
            "decision": "WAIT",
            "body": "await facts",
        }
        with patch.object(self.state, "tick_now", return_value={"accepted": True}), patch(
            "tools.agentbus_v2.webui.submit_gpt_response",
            wraps=webui.submit_gpt_response,
        ) as submit:
            status, payload = self.post(f"/api/project/P1/gpt-submit", response)
        self.assertEqual(200, status)
        self.assertTrue(payload["stored"])
        submit.assert_called_once()
        self.assertTrue((self.state_root / "P1" / "gpt" / "results" / f"{job_id}.json").exists())

        status, payload = self.post(
            "/api/project/P1/gpt-submit",
            {**response, "job_id": "plan-" + "b" * 24},
        )
        self.assertEqual(422, status)
        self.assertIn("absent", payload["error"])

    def test_malformed_gpt_body_is_rejected_without_execution(self) -> None:
        connection = http.client.HTTPConnection(self.server.host, self.server.port, timeout=3)
        connection.request(
            "POST",
            "/api/project/P1/gpt-submit",
            body=b"not-json",
            headers={
                "Content-Type": "application/json",
                "X-AgentBus-Token": self.state.token,
            },
        )
        response = connection.getresponse()
        self.assertEqual(400, response.status)
        self.assertIn("malformed", response.read().decode("utf-8"))
        connection.close()

    def test_plan_binding_and_operator_directive_controls_use_control_plane(self) -> None:
        with patch.object(webui, "read_snapshot", return_value=self.snapshot), patch.object(
            webui, "decide", return_value=self.action
        ):
            status, payload = self.post(
                "/api/project/P1/plan-binding",
                {"conversation_url": "https://chatgpt.com/c/p1-plan"},
            )
        self.assertEqual(200, status)
        self.assertEqual("https://chatgpt.com/c/p1-plan", payload["plan_conversation_url"])
        with patch.object(webui, "read_snapshot", return_value=self.snapshot), patch.object(
            webui, "decide", return_value=self.action
        ):
            status, payload = self.post(
                "/api/project/P1/plan-directive",
                {"directive": "Only fix the bounded defect.", "request_replan": False},
            )
        self.assertEqual(200, status)
        self.assertTrue(payload["changed"])
        status, payload = self.server.request("/api/status")
        self.assertEqual(200, status)
        project = payload["projects"][0]
        self.assertTrue(project["plan_binding"]["bound"])
        self.assertEqual("Only fix the bounded defect.", project["operator_directive"]["text"])
        status, html = self.server.request("/")
        self.assertEqual(200, status)
        self.assertIn("PLAN 会话", html)
        self.assertIn("人工 PLAN 约束", html)

    def test_global_judge_binding_route_and_conversation_overview(self) -> None:
        source = self.state_root / "legacy_v1_browser_compat.json"
        source.write_text(json.dumps({
            "enabled": True,
            "conversations": {
                "plan": "https://chatgpt.com/c/global-plan",
                "judge": "https://chatgpt.com/c/global-judge",
            },
            "mailboxes": {"github.com/test/repo": 51},
        }), encoding="utf-8")
        before = json.loads(source.read_text(encoding="utf-8"))
        with patch.object(self.state, "tick_now") as tick:
            status, payload = self.post(
                "/api/gpt-conversations/judge",
                {"conversation_url": "https://chatgpt.com/c/judge-new"},
            )
        self.assertEqual(200, status)
        self.assertEqual("https://chatgpt.com/c/judge-new", payload["conversation_url"])
        tick.assert_not_called()
        after = json.loads(source.read_text(encoding="utf-8"))
        self.assertEqual(before["enabled"], after["enabled"])
        self.assertEqual(before["conversations"]["plan"], after["conversations"]["plan"])
        self.assertEqual(before["mailboxes"], after["mailboxes"])
        self.assertEqual("https://chatgpt.com/c/judge-new", after["conversations"]["judge"])
        status, html = self.server.request("/")
        self.assertEqual(200, status)
        self.assertIn("GPT 会话", html)
        self.assertIn("toggleJudgeEditor", html)
        self.assertIn("/api/gpt-conversations/judge", html)
        self.assertIn("toggleBlockEditor", html)
        self.assertIn("P 专用 PLAN", html)
        self.assertNotIn("prompt(", html)

    def test_conversation_overview_filters_archived_projects(self) -> None:
        self.post(
            "/api/project/P1/plan-binding",
            {"conversation_url": "https://chatgpt.com/c/p1-plan"},
        )
        registry = type(
            "Registry",
            (),
            {
                "entries": (
                    ProjectEntry("P1", enabled=True, plan_conversation_url="https://chatgpt.com/c/p1-plan"),
                    ProjectEntry("ARCHIVED", enabled=False, archived=True,
                                 plan_conversation_url="https://chatgpt.com/c/old-plan"),
                )
            },
        )()
        projection = self.state._gpt_conversation_projection(registry)
        self.assertEqual(
            [{"p_id": "P1", "bound": True, "conversation_url": "https://chatgpt.com/c/p1-plan"}],
            projection["per_p_plan"],
        )
        self.assertIn("judge", projection)
        self.assertIn("block", projection)

    def test_existing_spec_replan_requires_disabled_project(self) -> None:
        spec = type("Spec", (), {"spec_id": "spec-" + "a" * 24})()
        snapshot = replace(self.snapshot, specs=(spec,))
        with patch.object(webui, "read_snapshot", return_value=snapshot):
            status, payload = self.post(
                "/api/project/P1/plan-directive",
                {"directive": "Replan narrowly.", "request_replan": True},
            )
        self.assertEqual(409, status)
        self.assertIn("暂停", payload["error"])
        self.post("/api/project/P1/enabled", {"enabled": False})
        with patch.object(webui, "read_snapshot", return_value=snapshot):
            status, payload = self.post(
                "/api/project/P1/plan-directive",
                {"directive": "Replan narrowly.", "request_replan": True},
            )
        self.assertEqual(200, status)
        self.assertTrue(payload["changed"])

    def test_unbound_production_plan_is_presentationally_awaiting_binding(self) -> None:
        registry = json.loads(self.registry_file.read_text(encoding="utf-8"))
        registry["projects"][0].pop("global_plan_fallback", None)
        self.registry_file.write_text(json.dumps(registry), encoding="utf-8")
        pending = replace(self.snapshot, gpt_pending=frozenset({self.action.effect_id}))
        self._write_packet(self.action.effect_id)
        with patch.object(webui, "read_snapshot", return_value=pending), patch.object(
            webui, "decide", return_value=Action(ActionKind.IDLE, reason="GPT result is absent")
        ), patch.object(self.state.legacy_browser_compat, "status", return_value=self._compat_status()):
            status, payload = self.server.request("/api/status")
        self.assertEqual(200, status)
        gpt = payload["projects"][0]["gpt_transport"]
        self.assertEqual("AWAITING_PLAN_BINDING", gpt["state"])
        self.assertEqual("WAITING", gpt["mode"])
        self.assertEqual("PER_P_PLAN_BINDING", gpt["transport"])

    def test_scheduler_start_stop_is_single_instance(self) -> None:
        self.post("/api/project/P1/enabled", {"enabled": False})
        status, payload = self.post("/api/scheduler/start", {})
        self.assertEqual(200, status)
        self.assertTrue(payload["started"])
        deadline = time.monotonic() + 2
        while not self.state.scheduler_status()["running"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.state.scheduler_status()["running"])
        status, payload = self.post("/api/scheduler/start", {})
        self.assertEqual(200, status)
        self.assertFalse(payload["started"])
        status, payload = self.post("/api/scheduler/stop", {})
        self.assertEqual(200, status)
        self.assertTrue(payload["stopped"])
        self.assertFalse(self.state.scheduler_status()["running"])


if __name__ == "__main__":
    unittest.main()
