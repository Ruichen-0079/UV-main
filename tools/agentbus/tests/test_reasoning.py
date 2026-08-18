from __future__ import annotations

import os

from agentbus.actions import set_role_model
from agentbus.config import (
    MODEL_REASONING_EFFORTS,
    UnsupportedExecutionMode,
    build_codex_argv,
    discover_codex_capabilities,
    migrate_role_config,
    normalize_effort,
    parse_execution_mode,
    reset_capability_cache,
)
from agentbus.paths import AgentbusError
from agentbus.tests.harness import AgentbusTest
from agentbus.views import catalog, stream_view


class ReasoningConfigTests(AgentbusTest):
    def test_model_reasoning_effort_never_accepts_ultra(self) -> None:
        with self.assertRaises(AgentbusError):
            normalize_effort("ultra")
        self.create_stream("s1")
        with self.assertRaises(AgentbusError):
            set_role_model(self.store("s1"), "impl", effort="ultra")

    def test_gpt56_none_accepted(self) -> None:
        self.assertEqual(normalize_effort("none"), "none")
        self.assertIn("none", MODEL_REASONING_EFFORTS)
        self.create_stream("s1")
        set_role_model(self.store("s1"), "impl", model="gpt-5.6-luna", effort="none")
        argv = build_codex_argv(
            role_cfg=self.store("s1").load()["roles"]["impl"],
            workdir=self.repo,
            prompt="hi",
            last_message_path="/tmp/out.txt",
        )
        self.assertIn("model_reasoning_effort=none", argv)

    def test_gpt56_max_accepted(self) -> None:
        self.create_stream("s1")
        set_role_model(self.store("s1"), "impl", model="gpt-5.6-terra", effort="max")
        argv = build_codex_argv(
            role_cfg=self.store("s1").load()["roles"]["impl"],
            workdir=self.repo,
            prompt="hi",
            last_message_path="/tmp/out.txt",
        )
        self.assertIn("model_reasoning_effort=max", argv)

    def test_unsupported_model_effort_rejected_or_inherited(self) -> None:
        self.create_stream("s1")
        set_role_model(self.store("s1"), "impl", model="gpt-5.5", effort="high")
        with self.assertRaises(AgentbusError):
            set_role_model(self.store("s1"), "impl", effort="max")
        set_role_model(self.store("s1"), "impl", model="gpt-5.5")
        # existing max would have been rejected; setting model with leftover high is ok
        state = self.store("s1").load()
        if state["roles"]["impl"].get("effort") == "max":
            self.fail("unsupported effort should not remain executable")

    def test_ultra_cannot_be_active_when_unavailable(self) -> None:
        self.create_stream("s1")
        with self.assertRaises(UnsupportedExecutionMode) as caught:
            set_role_model(self.store("s1"), "impl", execution_mode="ultra")
        self.assertEqual(caught.exception.code, "UNSUPPORTED_EXECUTION_MODE")
        cfg = self.store("s1").load()["roles"]["impl"]
        self.assertNotEqual(cfg.get("execution_mode"), "ultra")
        result = self.agentctl("set-execution-mode", "s1", "impl", "ultra")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("UNSUPPORTED_EXECUTION_MODE", result.stdout + result.stderr)

    def test_standard_mode_leaves_ultra_off(self) -> None:
        self.create_stream("s1")
        set_role_model(self.store("s1"), "impl", execution_mode="standard")
        argv = build_codex_argv(
            role_cfg=self.store("s1").load()["roles"]["impl"],
            workdir=self.repo,
            prompt="hi",
            last_message_path="/tmp/out.txt",
        )
        self.assertNotIn("ultra", " ".join(argv).lower())
        self.assertEqual(parse_execution_mode("standard"), "standard")

    def test_legacy_effort_ultra_migration_safe(self) -> None:
        cfg = {"model": "gpt-5.6-sol", "effort": "ultra", "sandbox": "workspace-write"}
        migrated = migrate_role_config(cfg)
        self.assertIsNone(migrated["effort"])
        self.assertEqual(migrated.get("legacy", {}).get("effort"), "ultra")
        argv = build_codex_argv(role_cfg=cfg, workdir=self.repo, prompt="hi", last_message_path="/tmp/x")
        self.assertNotIn("model_reasoning_effort=ultra", argv)

    def test_effective_invocation_never_contains_ultra_effort(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["roles"]["impl"]["effort"] = "ultra"
        store.save(state)
        view = stream_view(self.ctx, store)
        inv = " ".join(view["impl"]["effective"].get("invocation") or [])
        self.assertNotIn("model_reasoning_effort=ultra", inv)
        argv = build_codex_argv(
            role_cfg=store.load()["roles"]["impl"],
            workdir=self.repo,
            prompt="x",
            last_message_path="/tmp/x",
        )
        self.assertNotIn("model_reasoning_effort=ultra", argv)

    def test_model_effort_role_independence(self) -> None:
        self.create_stream("s1")
        set_role_model(self.store("s1"), "impl", model="gpt-5.6-luna", effort="xhigh")
        set_role_model(self.store("s1"), "audit", model="gpt-5.6-sol", effort="none")
        state = self.store("s1").load()
        self.assertEqual(state["roles"]["impl"]["model"], "gpt-5.6-luna")
        self.assertEqual(state["roles"]["audit"]["model"], "gpt-5.6-sol")
        self.assertEqual(state["roles"]["impl"]["effort"], "xhigh")
        self.assertEqual(state["roles"]["audit"]["effort"], "none")

    def test_impl_audit_execution_modes_independent(self) -> None:
        os.environ["YUVI_AGENTBUS_ULTRA_CAPABLE"] = "1"
        os.environ["YUVI_AGENTBUS_ULTRA_INVOCATION"] = "--ultra"
        reset_capability_cache()
        self.create_stream("s1")
        set_role_model(self.store("s1"), "impl", execution_mode="ultra")
        set_role_model(self.store("s1"), "audit", execution_mode="standard")
        state = self.store("s1").load()
        self.assertEqual(state["roles"]["impl"]["execution_mode"], "ultra")
        self.assertEqual(state["roles"]["audit"]["execution_mode"] or "standard", "standard")

    def test_no_global_codex_config_writes(self) -> None:
        import os

        path = os.path.join(self.home, ".codex", "config.toml")
        self.create_stream("s1")
        set_role_model(self.store("s1"), "impl", model="gpt-5.6-luna", effort="max", execution_mode="standard")
        build_codex_argv(
            role_cfg=self.store("s1").load()["roles"]["impl"],
            workdir=self.repo,
            prompt="hi",
            last_message_path="/tmp/out.txt",
        )
        discover_codex_capabilities()
        catalog()
        self.assertFalse(os.path.isfile(path))

    def test_catalog_excludes_ultra_effort(self) -> None:
        reset_capability_cache()
        data = catalog()
        self.assertNotIn("ultra", data["efforts"])
        self.assertIn("none", data["efforts"])
        self.assertIn("max", data["efforts"])
        self.assertFalse(data["ultra"]["supported"])
        self.assertEqual(data["execution_modes"], ["standard"])

    def test_requested_effective_cannot_lie(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["roles"]["impl"]["execution_mode"] = "ultra"
        store.save(state)
        view = stream_view(self.ctx, store)
        self.assertEqual(view["impl"]["effective"]["effective_execution_mode"], "standard")
        self.assertIsNone(view["impl"]["effective"]["requested_execution_mode"])
        self.assertEqual(view["impl"]["effective"]["ultra_capability"], "unavailable")
        inv = " ".join(view["impl"]["effective"].get("invocation") or [])
        self.assertNotIn("ultra", inv.lower())

    def test_future_capability_fixture_enables_ultra(self) -> None:
        os.environ["YUVI_AGENTBUS_ULTRA_CAPABLE"] = "1"
        os.environ["YUVI_AGENTBUS_ULTRA_INVOCATION"] = "--ultra"
        reset_capability_cache()
        self.create_stream("s1")
        set_role_model(self.store("s1"), "impl", execution_mode="ultra")
        argv = build_codex_argv(
            role_cfg=self.store("s1").load()["roles"]["impl"],
            workdir=self.repo,
            prompt="hi",
            last_message_path="/tmp/out.txt",
        )
        self.assertIn("--ultra", argv)
        self.assertNotIn("model_reasoning_effort=ultra", argv)
