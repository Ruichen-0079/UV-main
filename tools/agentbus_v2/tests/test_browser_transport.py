from __future__ import annotations

import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from tools.agentbus_v2.browser_transport import (
    BrowserAdapter,
    BrowserBridge,
    BrowserTransportError,
)
from tools.agentbus_v2.core import Action, ActionKind, GPT_PACKET_SCHEMA, Snapshot
from tools.agentbus_v2.facts import PPaths
from tools.agentbus_v2.gpt_transport import GPTTransport


SHA = "1" * 40
TOKEN = "test-browser-token"
CONVERSATIONS = {
    "plan": "https://chatgpt.com/c/plan-lane",
    "judge": "https://chatgpt.com/c/judge-lane",
}


def setup_p(root: Path, p_id: str) -> PPaths:
    paths = PPaths(root / "state" / p_id)
    paths.create_dirs()
    (paths.root / "charter.md").write_text("test charter\n", encoding="utf-8")
    worktree = root / f"worktree-{p_id}"
    worktree.mkdir()
    (paths.root / "config.json").write_text(
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
    return paths


def write_config(root: Path) -> Path:
    path = root / "state" / "gpt_lanes.json"
    path.write_text(
        json.dumps(
            {
                "bridge_token": TOKEN,
                "plan": {
                    "enabled": True,
                    "transport": "browser",
                    "conversation_url": CONVERSATIONS["plan"],
                },
                "judge": {
                    "enabled": True,
                    "transport": "browser",
                    "conversation_url": CONVERSATIONS["judge"],
                },
            }
        ),
        encoding="utf-8",
    )
    return path


def write_packet(paths: PPaths, job_id: str, operation: str) -> None:
    packet = {
        "packet_schema": GPT_PACKET_SCHEMA,
        "job_id": job_id,
        "operation": operation,
        "semantic_input": {"job_id": job_id, "operation": operation},
    }
    (paths.root / "gpt" / "outbox" / f"{job_id}.md").write_text(
        "# packet\n## SEMANTIC INPUTS\n```json\n"
        + json.dumps(packet, sort_keys=True)
        + "\n```\n",
        encoding="utf-8",
    )


def response(job_id: str, operation: str, decision: str) -> str:
    return json.dumps(
        {
            "job_id": job_id,
            "operation": operation,
            "decision": decision,
            "body": "bounded browser response",
        }
    )


def snapshot_for(p_id: str) -> Snapshot:
    return Snapshot(
        p_id=p_id,
        charter_digest="c" * 64,
        expected_repository="github.com/test/repo",
        expected_branch=f"agentbus/{p_id.lower()}",
        base_ref="main",
        head=SHA,
        base=SHA,
    )


def wait_bridge(adapter: BrowserAdapter, timeout: float = 2.0) -> BrowserBridge:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        bridge = adapter.bridge
        if bridge is not None and bridge.server is not None:
            return bridge
        time.sleep(0.005)
    raise AssertionError("browser bridge did not start")


def request_json(
    bridge: BrowserBridge,
    path: str,
    *,
    method: str = "GET",
    body: object | None = None,
    token: str = TOKEN,
    origin: str | None = None,
) -> tuple[int, object]:
    headers = {"X-AgentBus-Token": token}
    encoded = None
    if body is not None:
        encoded = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if origin is not None:
        headers["Origin"] = origin
    connection = http.client.HTTPConnection("127.0.0.1", bridge.port, timeout=3)
    connection.request(method, path, body=encoded, headers=headers)
    result = connection.getresponse()
    payload = result.read()
    connection.close()
    if not payload:
        return result.status, None
    return result.status, json.loads(payload.decode("utf-8"))


class BrowserTransportTests(unittest.TestCase):
    def start_send(
        self,
        adapter: BrowserAdapter,
        lane: str,
        job_id: str,
        operation: str,
        packet: str,
    ) -> tuple[threading.Thread, list[object]]:
        result: list[object] = []

        def run() -> None:
            try:
                result.append(adapter.send(lane, job_id, operation, packet))
            except BaseException as error:
                result.append(error)

        thread = threading.Thread(target=run)
        thread.start()
        return thread, result

    def wait_pending(self, bridge: BrowserBridge, lane: str, timeout: float = 2.0) -> dict[str, str]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pending = bridge.state.pull(lane)
            if pending is not None:
                return pending
            time.sleep(0.005)
        raise AssertionError(f"no pending {lane} browser request")

    def test_plan_and_judge_http_roundtrip_through_existing_ingestion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan_paths, judge_paths = setup_p(root, "P1"), setup_p(root, "P2")
            config_path = write_config(root)
            plan_job = "plan-" + "a" * 24
            judge_job = "judge-" + "b" * 24
            write_packet(plan_paths, plan_job, "PLAN_GPT")
            write_packet(judge_paths, judge_job, "JUDGE_GPT")
            adapter = BrowserAdapter(root / "state", config_path=config_path, port=0, timeout=3)
            transport = GPTTransport(root / "state", adapters={"browser": adapter}, max_workers=2)
            actions = {
                "P1": Action(ActionKind.PLAN, effect_id=plan_job),
                "P2": Action(ActionKind.JUDGE, effect_id=judge_job),
            }
            try:
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    side_effect=lambda paths, allow_merge=False: snapshot_for(paths.root.name),
                ), patch(
                    "tools.agentbus_v2.gpt_transport.decide",
                    side_effect=lambda snapshot: actions[snapshot.p_id],
                ):
                    self.assertTrue(transport.try_dispatch("P1", actions["P1"]).accepted)
                    self.assertTrue(transport.try_dispatch("P2", actions["P2"]).accepted)
                    bridge = wait_bridge(adapter)
                    plan = self.wait_pending(bridge, "plan")
                    judge = self.wait_pending(bridge, "judge")
                    self.assertEqual(plan_job, plan["job_id"])
                    self.assertEqual("PLAN_GPT", plan["operation"])
                    self.assertEqual(judge_job, judge["job_id"])
                    self.assertEqual("JUDGE_GPT", judge["operation"])
                    self.assertEqual("# packet\n## SEMANTIC INPUTS\n```json\n" + json.dumps(
                        {
                            "packet_schema": GPT_PACKET_SCHEMA,
                            "job_id": plan_job,
                            "operation": "PLAN_GPT",
                            "semantic_input": {"job_id": plan_job, "operation": "PLAN_GPT"},
                        }, sort_keys=True
                    ) + "\n```\n", plan["packet"])
                    status, _ = request_json(
                        bridge,
                        "/bridge/result",
                        method="POST",
                        body={"lane": "plan", "job_id": plan_job, "raw_response": response(plan_job, "PLAN_GPT", "SPEC")},
                    )
                    self.assertEqual(200, status)
                    status, _ = request_json(
                        bridge,
                        "/bridge/result",
                        method="POST",
                        body={"lane": "judge", "job_id": judge_job, "raw_response": response(judge_job, "JUDGE_GPT", "RETURN_WORK")},
                    )
                    self.assertEqual(200, status)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline and not (
                        (plan_paths.root / "gpt" / "results" / f"{plan_job}.json").exists()
                        and (judge_paths.root / "gpt" / "results" / f"{judge_job}.json").exists()
                    ):
                        time.sleep(0.01)
                    self.assertTrue((plan_paths.root / "gpt" / "results" / f"{plan_job}.json").exists())
                    self.assertTrue((judge_paths.root / "gpt" / "results" / f"{judge_job}.json").exists())
            finally:
                transport.close()

    def test_default_gpt_transport_lazily_owns_one_browser_bridge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_config(root)
            job = "plan-" + "9" * 24
            write_packet(paths, job, "PLAN_GPT")
            action = Action(ActionKind.PLAN, effect_id=job)
            transport = GPTTransport(root / "state", max_workers=1)
            try:
                with patch("tools.agentbus_v2.gpt_transport.read_snapshot", return_value=snapshot_for("P1")), \
                        patch("tools.agentbus_v2.gpt_transport.decide", return_value=action):
                    self.assertTrue(transport.try_dispatch("P1", action).accepted)
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline and transport._browser_adapter is None:
                        time.sleep(0.005)
                    self.assertIsNotNone(transport._browser_adapter)
                    adapter = transport._browser_adapter
                    assert isinstance(adapter, BrowserAdapter)
                    bridge = wait_bridge(adapter)
                    pending = self.wait_pending(bridge, "plan")
                    status, _ = request_json(
                        bridge,
                        "/bridge/result",
                        method="POST",
                        body={"lane": "plan", "job_id": job, "raw_response": response(job, "PLAN_GPT", "WAIT")},
                    )
                    self.assertEqual(200, status)
                    self.assertEqual(job, pending["job_id"])
                    result_path = paths.root / "gpt" / "results" / f"{job}.json"
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline and not result_path.exists():
                        time.sleep(0.005)
                    self.assertTrue(result_path.exists())
            finally:
                transport.close()

    def test_lane_and_job_mismatch_cannot_consume_pending_request(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            setup_p(root, "P1")
            config_path = write_config(root)
            adapter = BrowserAdapter(root / "state", config_path=config_path, port=0, timeout=2)
            thread, result = self.start_send(adapter, "plan", "plan-" + "c" * 24, "PLAN_GPT", "packet")
            bridge = wait_bridge(adapter)
            pending = self.wait_pending(bridge, "plan")
            self.assertEqual(204, request_json(bridge, "/bridge/pull?lane=judge")[0])
            status, payload = request_json(
                bridge,
                "/bridge/result",
                method="POST",
                body={"lane": "judge", "job_id": pending["job_id"], "raw_response": "wrong lane"},
            )
            self.assertEqual(409, status)
            self.assertIn("pending", payload["error"])
            status, payload = request_json(
                bridge,
                "/bridge/result",
                method="POST",
                body={"lane": "plan", "job_id": "plan-" + "d" * 24, "raw_response": "wrong job"},
            )
            self.assertEqual(409, status)
            self.assertIn("job_id", payload["error"])
            self.assertEqual(pending["job_id"], self.wait_pending(bridge, "plan")["job_id"])
            request_json(
                bridge,
                "/bridge/result",
                method="POST",
                body={"lane": "plan", "job_id": pending["job_id"], "raw_response": "raw answer"},
            )
            thread.join(timeout=2)
            self.assertEqual(["raw answer"], result)
            adapter.close()

    def test_same_lane_double_use_and_plan_judge_concurrency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            setup_p(root, "P1")
            config_path = write_config(root)
            adapter = BrowserAdapter(root / "state", config_path=config_path, port=0, timeout=2)
            first, first_result = self.start_send(adapter, "plan", "plan-" + "e" * 24, "PLAN_GPT", "one")
            bridge = wait_bridge(adapter)
            self.wait_pending(bridge, "plan")
            second, second_result = self.start_send(adapter, "plan", "plan-" + "f" * 24, "PLAN_GPT", "two")
            second.join(timeout=2)
            self.assertIsInstance(second_result[0], BrowserTransportError)
            judge, judge_result = self.start_send(adapter, "judge", "judge-" + "1" * 24, "JUDGE_GPT", "three")
            judge_pending = self.wait_pending(bridge, "judge")
            self.assertIsNotNone(judge_pending)
            plan_pending = self.wait_pending(bridge, "plan")
            request_json(bridge, "/bridge/result", method="POST", body={"lane": "plan", "job_id": plan_pending["job_id"], "raw_response": "plan"})
            request_json(bridge, "/bridge/result", method="POST", body={"lane": "judge", "job_id": judge_pending["job_id"], "raw_response": "judge"})
            first.join(timeout=2)
            judge.join(timeout=2)
            self.assertEqual(["plan"], first_result)
            self.assertEqual(["judge"], judge_result)
            adapter.close()

    def test_disconnect_restart_and_security_are_operational_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            setup_p(root, "P1")
            config_path = write_config(root)
            adapter = BrowserAdapter(root / "state", config_path=config_path, port=0, timeout=0.15)
            thread, result = self.start_send(adapter, "plan", "plan-" + "2" * 24, "PLAN_GPT", "packet")
            bridge = wait_bridge(adapter)
            thread.join(timeout=2)
            self.assertIsInstance(result[0], BrowserTransportError)
            self.assertEqual([], list((root / "state" / "P1" / "gpt" / "results").glob("*.json")))
            status, payload = request_json(bridge, "/bridge/pull?lane=plan", token="bad")
            self.assertEqual(403, status)
            self.assertIn("token", payload["error"])
            status, payload = request_json(
                bridge,
                "/bridge/pull?lane=plan",
                origin="https://evil.example",
            )
            self.assertEqual(403, status)
            self.assertIn("origin", payload["error"])
            adapter.close()

            restarted = BrowserAdapter(root / "state", config_path=config_path, port=0, timeout=2)
            thread, result = self.start_send(restarted, "plan", "plan-" + "2" * 24, "PLAN_GPT", "packet")
            bridge = wait_bridge(restarted)
            pending = self.wait_pending(bridge, "plan")
            request_json(bridge, "/bridge/result", method="POST", body={"lane": "plan", "job_id": pending["job_id"], "raw_response": "retry"})
            thread.join(timeout=2)
            self.assertEqual(["retry"], result)
            restarted.close()

    def test_heartbeat_requires_the_exact_configured_conversation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            setup_p(root, "P1")
            config_path = write_config(root)
            adapter = BrowserAdapter(root / "state", config_path=config_path, port=0, timeout=2)
            thread, result = self.start_send(adapter, "plan", "plan-" + "3" * 24, "PLAN_GPT", "packet")
            bridge = wait_bridge(adapter)
            self.wait_pending(bridge, "plan")
            status, payload = request_json(
                bridge,
                "/bridge/heartbeat",
                method="POST",
                body={"lane": "plan", "conversation_url": "https://chatgpt.com/c/other"},
            )
            self.assertEqual(409, status)
            self.assertIn("conversation", payload["error"])
            request_json(
                bridge,
                "/bridge/heartbeat",
                method="POST",
                body={"lane": "plan", "conversation_url": CONVERSATIONS["plan"] + "#view"},
            )
            pending = self.wait_pending(bridge, "plan")
            request_json(bridge, "/bridge/result", method="POST", body={"lane": "plan", "job_id": pending["job_id"], "raw_response": "ok"})
            thread.join(timeout=2)
            self.assertEqual(["ok"], result)
            adapter.close()

    def test_preflight_config_and_heartbeat_are_ephemeral_binding_diagnostics(self) -> None:
        bridge = BrowserBridge(
            TOKEN,
            port=0,
            conversation_urls=CONVERSATIONS,
        )
        bridge.start()
        try:
            status, payload = request_json(bridge, "/bridge/config?lane=plan")
            self.assertEqual(200, status)
            self.assertEqual("plan", payload["lane"])
            self.assertEqual(CONVERSATIONS["plan"], payload["conversation_url"])
            status, _ = request_json(
                bridge,
                "/bridge/heartbeat",
                method="POST",
                body={"lane": "plan", "conversation_url": CONVERSATIONS["plan"]},
            )
            self.assertEqual(200, status)
            self.assertTrue(bridge.lane_status("plan")["bridge_connected"])
        finally:
            bridge.close()


if __name__ == "__main__":
    unittest.main()
