from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import (
    Action,
    ActionKind,
    GPT_PACKET_SCHEMA,
    Snapshot,
    SpecFact,
    decide,
    plan_job_id,
)
from tools.agentbus_v2.facts import (
    FactError,
    PPaths,
    add_operator_directive,
    load_operator_directive,
    paths_for,
)
from tools.agentbus_v2.legacy_v1_browser_compat import (
    LegacyV1BrowserCompat,
    load_compat_config,
    set_global_judge_conversation,
)
from tools.agentbus_v2.block_diagnosis import set_block_config
from tools.agentbus_v2.scheduler import (
    load_registry,
    set_plan_conversation_binding,
)


SHA = "1" * 40
REPOSITORY = "github.com/test/repo"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class PlanBindingDirectiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        for p_id in ("P4", "P7"):
            write_json(
                self.state / p_id / "config.json",
                {
                    "p_id": p_id,
                    "worktree": str(self.root / p_id / "worktree"),
                    "repository": REPOSITORY,
                    "remote": "origin",
                    "branch": f"agentbus/{p_id.lower()}",
                    "base_ref": "main",
                    "seed_head": SHA,
                    "charter_digest": "c" * 64,
                    "proof_commands": [],
                    "required_ci_checks": [],
                },
            )
        write_json(
            self.state / "projects.json",
            {"projects": [
                {"p_id": "P4", "enabled": True, "allow_merge": False},
                {"p_id": "P7", "enabled": True, "allow_merge": False},
            ]},
        )
        write_json(
            self.state / "legacy_v1_browser_compat.json",
            {
                "enabled": True,
                "conversations": {
                    "plan": "https://chatgpt.com/c/global-plan",
                    "judge": "https://chatgpt.com/c/global-judge",
                },
                "mailboxes": {REPOSITORY: 51},
            },
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def snapshot(self, p_id: str = "P4", *, spec: SpecFact | None = None) -> Snapshot:
        return Snapshot(
            p_id=p_id,
            charter_digest="c" * 64,
            expected_repository=REPOSITORY,
            expected_branch=f"agentbus/{p_id.lower()}",
            base_ref="main",
            head=SHA,
            base=SHA,
            specs=(spec,) if spec is not None else (),
        )

    def test_distinct_bindings_and_validation_fences(self) -> None:
        first = set_plan_conversation_binding(
            self.state, "P4", "https://chatgpt.com/c/p4-plan"
        )
        self.assertEqual(
            "https://chatgpt.com/c/p4-plan",
            next(item for item in first.entries if item.p_id == "P4").plan_conversation_url,
        )
        set_plan_conversation_binding(self.state, "P7", "https://chatgpt.com/c/p7-plan")
        with self.assertRaises(FactError):
            set_plan_conversation_binding(self.state, "P7", "https://chatgpt.com/c/p4-plan")
        with self.assertRaises(FactError):
            set_plan_conversation_binding(self.state, "P7", "https://chatgpt.com/c/global-judge")
        set_block_config(
            self.state, conversation_url="https://chatgpt.com/c/block", update_url=True
        )
        with self.assertRaises(FactError):
            set_plan_conversation_binding(self.state, "P7", "https://chatgpt.com/c/block")
        with self.assertRaises(FactError):
            set_plan_conversation_binding(self.state, "P7", "http://chatgpt.com/c/not-https")

    def test_global_judge_binding_preserves_compat_config_and_rejects_collisions(self) -> None:
        source = self.state / "legacy_v1_browser_compat.json"
        before = json.loads(source.read_text(encoding="utf-8"))
        updated = set_global_judge_conversation(
            self.state, "https://chatgpt.com/c/new-judge"
        )
        after = json.loads(source.read_text(encoding="utf-8"))
        self.assertEqual("https://chatgpt.com/c/new-judge", updated.conversations["judge"])
        self.assertEqual(before["enabled"], after["enabled"])
        self.assertEqual(before["conversations"]["plan"], after["conversations"]["plan"])
        self.assertEqual(before["mailboxes"], after["mailboxes"])
        self.assertEqual("https://chatgpt.com/c/new-judge", after["conversations"]["judge"])
        set_plan_conversation_binding(self.state, "P4", "https://chatgpt.com/c/p4-plan")
        with self.assertRaises(FactError):
            set_global_judge_conversation(self.state, "https://chatgpt.com/c/p4-plan")
        with self.assertRaises(FactError):
            set_global_judge_conversation(self.state, "https://chatgpt.com/c/global-plan")
        set_block_config(
            self.state, conversation_url="https://chatgpt.com/c/block", update_url=True
        )
        with self.assertRaises(FactError):
            set_global_judge_conversation(self.state, "https://chatgpt.com/c/block")
        with self.assertRaises(FactError):
            set_global_judge_conversation(self.state, "http://chatgpt.com/c/not-https")

    def test_global_judge_binding_fails_closed_on_malformed_config(self) -> None:
        source = self.state / "legacy_v1_browser_compat.json"
        original = source.read_bytes()
        source.write_text('{"enabled": true, "conversations": {}}', encoding="utf-8")
        malformed = source.read_bytes()
        with self.assertRaises(FactError):
            set_global_judge_conversation(self.state, "https://chatgpt.com/c/new-judge")
        self.assertEqual(malformed, source.read_bytes())
        self.assertNotEqual(original, malformed)

    def test_global_judge_binding_is_operational_only(self) -> None:
        before = load_compat_config(self.state)
        old_job = plan_job_id(self.snapshot())
        set_global_judge_conversation(self.state, "https://chatgpt.com/c/new-judge")
        self.assertEqual(old_job, plan_job_id(self.snapshot()))
        self.assertEqual(before.enabled, load_compat_config(self.state).enabled)
        self.assertEqual(
            before.conversations["plan"],
            load_compat_config(self.state).conversations["plan"],
        )
        self.assertFalse((self.state / "P4" / "gpt" / "results").exists())

    def test_url_is_operational_only_and_unbound_does_not_use_global_plan(self) -> None:
        before = plan_job_id(self.snapshot())
        set_plan_conversation_binding(self.state, "P4", "https://chatgpt.com/c/p4-plan")
        self.assertEqual(before, plan_job_id(self.snapshot()))

        paths = paths_for(self.state, "P7")
        job = plan_job_id(self.snapshot("P7"))
        packet = paths.root / "gpt" / "outbox" / f"{job}.md"
        packet.parent.mkdir(parents=True, exist_ok=True)
        packet.write_text(
            "# packet\n## SEMANTIC INPUTS\n```json\n"
            + json.dumps({
                "packet_schema": GPT_PACKET_SCHEMA,
                "job_id": job,
                "operation": "PLAN_GPT",
                "semantic_input": {"job_id": job, "operation": "PLAN_GPT"},
            })
            + "\n```\n",
            encoding="utf-8",
        )
        # The compatibility projection is explicitly global-fallback-free for
        # an unbound production P, even though a global PLAN URL is configured.
        with patch(
            "tools.agentbus_v2.legacy_v1_browser_compat.read_snapshot",
            return_value=replace(self.snapshot("P7"), gpt_pending=frozenset({job})),
        ):
            compat = LegacyV1BrowserCompat(self.state)
            self.assertEqual((), compat.current_jobs())

    def test_directive_is_immutable_idempotent_and_changes_plan_identity(self) -> None:
        paths = paths_for(self.state, "P4")
        base = self.snapshot()
        old_job = plan_job_id(base)
        directive, changed = add_operator_directive(
            paths, base, "Only repair migrationsDir/path."
        )
        self.assertTrue(changed)
        same, changed_again = add_operator_directive(
            paths, replace(base, operator_directive=directive),
            "Only repair migrationsDir/path.",
        )
        self.assertFalse(changed_again)
        self.assertEqual(directive, same)
        with self.assertRaises(FactError):
            add_operator_directive(
                paths, replace(base, operator_directive=directive), "Redesign packaging."
            )
        loaded = load_operator_directive(paths)
        assert loaded is not None
        current = replace(base, operator_directive=loaded)
        self.assertNotEqual(old_job, plan_job_id(current))
        action = decide(current)
        self.assertEqual(ActionKind.PLAN, action.kind)
        self.assertEqual(plan_job_id(current), action.effect_id)
        self.assertEqual(
            directive.directive_id,
            current.operator_directive.directive_id if current.operator_directive else None,
        )

    def test_directive_packet_identity_and_exact_text(self) -> None:
        paths = paths_for(self.state, "P4")
        base = self.snapshot()
        directive, _ = add_operator_directive(paths, base, "Do not expand into D3/D4.")
        current = replace(base, operator_directive=directive)
        action = decide(current)
        self.assertEqual(ActionKind.PLAN, action.kind)
        from tools.agentbus_v2 import effects

        config = type("Config", (), {
            "p_id": "P4", "repository": REPOSITORY, "branch": "agentbus/p4",
            "base_ref": "main",
            "charter_digest": "c" * 64, "worktree": str(self.root / "P4" / "worktree"),
        })()
        with patch.object(effects, "load_charter", return_value="bounded charter\n"), \
                patch.object(effects, "git", return_value=""):
            packet = effects.render_gpt_prompt(paths, config, current, action)
        self.assertIn("## OPERATOR_DIRECTIVE (binding human planning authority)", packet)
        self.assertIn("Do not expand into D3/D4.", packet)
        self.assertIn(directive.directive_id, packet)

    def test_existing_spec_replan_is_lineage_without_new_workflow_state(self) -> None:
        spec = SpecFact("spec-" + "a" * 24, "old bounded spec", plan_job_id="plan-" + "b" * 24)
        paths = paths_for(self.state, "P4")
        base = self.snapshot(spec=spec)
        directive, _ = add_operator_directive(paths, base, "Keep the repair minimal.", parent_spec_id=spec.spec_id)
        current = replace(base, operator_directive=directive)
        action = decide(current)
        self.assertEqual(ActionKind.PLAN, action.kind)
        self.assertEqual(spec.spec_id, action.payload["parent_spec_id"])
        self.assertNotEqual(spec.plan_job_id, action.effect_id)
        self.assertFalse((paths.root / "operator" / "replan_state.json").exists())

    def test_old_pending_identity_is_superseded_without_deleting_outbox(self) -> None:
        paths = paths_for(self.state, "P4")
        base = self.snapshot()
        old_job = plan_job_id(base)
        old_packet = paths.root / "gpt" / "outbox" / f"{old_job}.md"
        old_packet.parent.mkdir(parents=True, exist_ok=True)
        old_packet.write_text("old packet", encoding="utf-8")
        directive, _ = add_operator_directive(paths, base, "Only fix the named defect.")
        current = replace(base, operator_directive=directive)
        self.assertNotEqual(old_job, plan_job_id(current))
        self.assertTrue(old_packet.exists())
        self.assertEqual(ActionKind.PLAN, decide(current).kind)

    def test_unbound_tick_does_not_create_or_dispatch_global_plan(self) -> None:
        from tools.agentbus_v2 import cli

        action = Action(ActionKind.PLAN, effect_id=plan_job_id(self.snapshot()))
        with patch.object(cli, "read_snapshot", return_value=self.snapshot()), \
                patch.object(cli, "decide", return_value=action), \
                patch.object(cli, "dispatch_manual_gpt") as dispatch:
            result_action, result = cli.tick_once(self.state, "P4", allow_merge=False)
        self.assertEqual(ActionKind.IDLE, result_action.kind)
        self.assertEqual("AWAITING_PLAN_BINDING", result_action.reason)
        self.assertIsNone(result)
        dispatch.assert_not_called()
