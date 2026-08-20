from __future__ import annotations

from dataclasses import asdict, replace
import json
from pathlib import Path
import tempfile
import threading
import unittest

from tools.agentbus_v2.core import (
    ActionKind,
    GptResult,
    Observation,
    SpecFact,
    decide,
    plan_facts_digest,
    plan_job_id,
    spec_id,
)
from tools.agentbus_v2.effects import EffectResult
from tools.agentbus_v2.executor_pool import (
    ExecutorAccount,
    ExecutorPool,
    account_lock,
    list_executor_accounts,
    load_accounts,
)
from tools.agentbus_v2.facts import FactError, PPaths

from tools.agentbus_v2.tests.test_facts_effects import (
    RepoFixture,
    config_for,
    run,
    snapshot_for,
)


def fixture(root: Path, p_id: str = "P-TEST"):
    repo_root = root / p_id.lower()
    repo_root.mkdir(parents=True, exist_ok=True)
    repo = RepoFixture(repo_root)
    charter = f"P_ID: {p_id}\nGOAL: executor pool test\n"
    config = replace(config_for(repo, charter), p_id=p_id)
    paths = PPaths(root / "state" / p_id)
    paths.create_dirs()
    (paths.root / "charter.md").write_text(charter, encoding="utf-8")
    (paths.root / "config.json").write_text(
        json.dumps(asdict(config)), encoding="utf-8"
    )
    head = run(Path(config.worktree), "git", "rev-parse", "HEAD")
    snapshot = snapshot_for(config)
    planning = plan_facts_digest(snapshot)
    job_id = plan_job_id(snapshot)
    text = "Implement the bounded executor-pool test change."
    spec = SpecFact(spec_id(snapshot.charter_digest, planning, text), text, plan_job_id=job_id)
    snapshot = replace(
        snapshot,
        head=head,
        specs=(spec,),
        gpt_results=(GptResult(job_id, "PLAN_GPT", "SPEC", text),),
    )
    action = decide(snapshot)
    if action.kind is not ActionKind.WORK:
        raise AssertionError(f"fixture did not derive WORK: {action}")
    return repo, config, paths, snapshot, spec, action


def config_file(state_root: Path, accounts: list[dict[str, object]]) -> None:
    state_root.mkdir(parents=True, exist_ok=True)
    (state_root / "executors.json").write_text(
        json.dumps({"accounts": accounts}), encoding="utf-8"
    )


class ExecutorPoolTests(unittest.TestCase):
    def test_config_and_default_accounts_are_operational_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            defaults = load_accounts(state)
            self.assertEqual(("primary", "secondary"), tuple(item.name for item in defaults))
            config_file(
                state,
                [
                    {"name": "one", "codex_home": "~/.one", "enabled": True},
                    {"name": "two", "codex_home": "~/.two", "enabled": False},
                ],
            )
            self.assertEqual(("one", "two"), tuple(item.name for item in load_accounts(state)))
            self.assertEqual(
                ({"name": "one", "enabled": True}, {"name": "two", "enabled": False}),
                list_executor_accounts(state),
            )

    def test_duplicate_codex_home_cannot_bypass_account_capacity_fence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            shared = Path(directory) / "account"
            config_file(
                state,
                [
                    {"name": "one", "codex_home": str(shared), "enabled": True},
                    {
                        "name": "two",
                        "codex_home": str(shared / ".." / "account"),
                        "enabled": True,
                    },
                ],
            )
            with self.assertRaisesRegex(FactError, "share one CODEX_HOME"):
                load_accounts(state)
            with self.assertRaisesRegex(FactError, "share one CODEX_HOME"):
                ExecutorPool(
                    state,
                    (
                        ExecutorAccount("one", shared),
                        ExecutorAccount("two", shared),
                    ),
                )

    def test_free_account_is_selected_once_and_account_is_not_in_work_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, _, action = fixture(root)
            accounts = (ExecutorAccount("primary", root / "primary"),)
            calls: list[Path] = []

            def fake(*args: object) -> EffectResult:
                calls.append(args[-1])
                return EffectResult(True, "semantic result")

            result = ExecutorPool(root / "state", accounts).run(
                paths, config, snapshot, action, executor=fake
            )
            self.assertTrue(result.changed)
            self.assertEqual([root / "primary"], calls)
            self.assertNotIn("primary", action.effect_id or "")

    def test_primary_lock_routes_to_secondary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, _, action = fixture(root)
            accounts = (
                ExecutorAccount("primary", root / "primary"),
                ExecutorAccount("secondary", root / "secondary"),
            )
            calls: list[str] = []
            with account_lock(root / "state", accounts[0]) as acquired:
                self.assertTrue(acquired)

                def fake(*args: object) -> EffectResult:
                    calls.append(Path(args[-1]).name)
                    return EffectResult(True, "semantic result")

                result = ExecutorPool(root / "state", accounts).run(
                    paths, config, snapshot, action, executor=fake
                )
            self.assertTrue(result.changed)
            self.assertEqual(["secondary"], calls)

    def test_all_accounts_locked_launches_nothing_and_work_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, _, action = fixture(root)
            accounts = (
                ExecutorAccount("primary", root / "primary"),
                ExecutorAccount("secondary", root / "secondary"),
            )
            calls: list[str] = []
            with account_lock(root / "state", accounts[0]), account_lock(
                root / "state", accounts[1]
            ):
                result = ExecutorPool(root / "state", accounts).run(
                    paths,
                    config,
                    snapshot,
                    action,
                    executor=lambda *args: calls.append("launched") or EffectResult(True, "bad"),
                )
            self.assertFalse(result.changed)
            self.assertEqual([], calls)

    def test_operational_failure_retries_secondary_on_clean_tree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, _, action = fixture(root)
            accounts = (
                ExecutorAccount("primary", root / "primary"),
                ExecutorAccount("secondary", root / "secondary"),
            )
            calls: list[str] = []

            def fake(*args: object) -> EffectResult:
                name = Path(args[-1]).name
                calls.append(name)
                return EffectResult(name == "secondary", "quota" if name == "primary" else "PASS")

            result = ExecutorPool(root / "state", accounts).run(
                paths, config, snapshot, action, executor=fake
            )
            self.assertTrue(result.changed)
            self.assertEqual(["primary", "secondary"], calls)

    def test_stale_work_action_does_not_fail_over_to_another_account(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, _, action = fixture(root)
            accounts = (
                ExecutorAccount("primary", root / "primary"),
                ExecutorAccount("secondary", root / "secondary"),
            )
            calls: list[str] = []

            def fake(*args: object) -> EffectResult:
                calls.append(Path(args[-1]).name)
                return EffectResult(False, "WORK identities drifted before Codex")

            result = ExecutorPool(root / "state", accounts).run(
                paths, config, snapshot, action, executor=fake
            )
            self.assertFalse(result.changed)
            self.assertEqual(["primary"], calls)

    def test_dirty_tree_blocks_failover_without_semantic_fail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, _, action = fixture(root)
            accounts = (
                ExecutorAccount("primary", root / "primary"),
                ExecutorAccount("secondary", root / "secondary"),
            )
            calls: list[str] = []

            def fake(*args: object) -> EffectResult:
                name = Path(args[-1]).name
                calls.append(name)
                (Path(config.worktree) / "ambiguous.txt").write_text("left behind\n")
                return EffectResult(False, "executor crashed")

            result = ExecutorPool(root / "state", accounts).run(
                paths, config, snapshot, action, executor=fake
            )
            self.assertFalse(result.changed)
            self.assertEqual(["primary"], calls)

    def test_semantic_fail_stops_without_failover(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, spec, action = fixture(root)
            accounts = (
                ExecutorAccount("primary", root / "primary"),
                ExecutorAccount("secondary", root / "secondary"),
            )
            calls: list[str] = []

            def fake(*args: object) -> EffectResult:
                calls.append(Path(args[-1]).name)
                result = {
                    "effect_id": action.effect_id,
                    "spec_id": spec.spec_id,
                    "input_head": snapshot.head,
                    "status": Observation.FAIL.value,
                    "trigger_judge_id": None,
                    "evidence_digest": "e" * 64,
                }
                (paths.root / "work" / "results" / f"{action.effect_id}.json").write_text(
                    json.dumps(result), encoding="utf-8"
                )
                return EffectResult(True, "confirmed semantic FAIL")

            result = ExecutorPool(root / "state", accounts).run(
                paths, config, snapshot, action, executor=fake
            )
            self.assertTrue(result.changed)
            self.assertEqual(["primary"], calls)

    def test_crash_after_valid_commit_recovers_pass_without_secondary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, snapshot, spec, action = fixture(root)
            accounts = (
                ExecutorAccount("primary", root / "primary"),
                ExecutorAccount("secondary", root / "secondary"),
            )
            calls: list[str] = []

            def fake(*args: object) -> EffectResult:
                calls.append(Path(args[-1]).name)
                (repo.work / "README.md").write_text("implemented\n", encoding="utf-8")
                run(repo.work, "git", "add", "README.md")
                message = (
                    "implementation\n\n"
                    f"AgentBus-V2-P: {config.p_id}\n"
                    f"AgentBus-V2-Spec: {spec.spec_id}\n"
                    f"AgentBus-V2-Work: {action.effect_id}\n"
                    f"AgentBus-V2-Input-Head: {snapshot.head}\n"
                    f"AgentBus-V2-Plan: {spec.plan_job_id}\n"
                )
                run(repo.work, "git", "commit", "-m", message)
                raise RuntimeError("Codex died after commit")

            result = ExecutorPool(root / "state", accounts).run(
                paths, config, snapshot, action, executor=fake
            )
            self.assertFalse(result.changed)
            self.assertIn("recovered WORK PASS", result.detail)
            self.assertEqual(["primary"], calls)

    def test_executor_crash_before_commit_retries_and_leaves_work_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, _, action = fixture(root)
            accounts = (
                ExecutorAccount("primary", root / "primary"),
                ExecutorAccount("secondary", root / "secondary"),
            )
            calls: list[str] = []

            def fake(*args: object) -> EffectResult:
                calls.append(Path(args[-1]).name)
                raise RuntimeError("Codex process crashed")

            result = ExecutorPool(root / "state", accounts).run(
                paths, config, snapshot, action, executor=fake
            )
            self.assertFalse(result.changed)
            self.assertEqual(["primary", "secondary"], calls)
            self.assertFalse((paths.root / "work" / "results" / f"{action.effect_id}.json").exists())

    def test_two_p_jobs_hold_distinct_accounts_concurrently(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = fixture(root, "P-ONE")
            second = fixture(root, "P-TWO")
            accounts = (
                ExecutorAccount("primary", root / "primary"),
                ExecutorAccount("secondary", root / "secondary"),
            )
            entered = []
            entered_lock = threading.Lock()
            barrier = threading.Barrier(2)

            def fake(*args: object) -> EffectResult:
                with entered_lock:
                    entered.append(Path(args[-1]).name)
                barrier.wait(timeout=5)
                return EffectResult(True, "PASS")

            errors: list[BaseException] = []

            def invoke(values: tuple[object, ...]) -> None:
                try:
                    repo, config, paths, snapshot, spec, action = values
                    ExecutorPool(root / "state", accounts).run(
                        paths, config, snapshot, action, executor=fake
                    )
                except BaseException as error:
                    errors.append(error)

            threads = [
                threading.Thread(target=invoke, args=(first,)),
                threading.Thread(target=invoke, args=(second,)),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
            self.assertEqual([], errors)
            self.assertEqual({"primary", "secondary"}, set(entered))

    def test_one_account_cannot_be_used_twice_and_locks_release(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, _, action = fixture(root)
            account = ExecutorAccount("only", root / "only")
            entered = threading.Event()
            release = threading.Event()
            calls: list[str] = []

            def blocking(*args: object) -> EffectResult:
                calls.append("first")
                entered.set()
                release.wait(timeout=5)
                return EffectResult(True, "PASS")

            result_holder: list[EffectResult] = []
            thread = threading.Thread(
                target=lambda: result_holder.append(
                    ExecutorPool(root / "state", (account,)).run(
                        paths, config, snapshot, action, executor=blocking
                    )
                )
            )
            thread.start()
            self.assertTrue(entered.wait(timeout=5))
            second = ExecutorPool(root / "state", (account,)).run(
                paths, config, snapshot, action, executor=blocking
            )
            self.assertFalse(second.changed)
            self.assertEqual(["first"], calls)
            release.set()
            thread.join(timeout=5)
            self.assertEqual(1, len(result_holder))
            with account_lock(root / "state", account) as acquired:
                self.assertTrue(acquired)

    def test_account_lock_releases_after_executor_exception(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, config, paths, snapshot, _, action = fixture(root)
            account = ExecutorAccount("only", root / "only")

            def crashing(*args: object) -> EffectResult:
                raise RuntimeError("Codex startup failed")

            result = ExecutorPool(root / "state", (account,)).run(
                paths, config, snapshot, action, executor=crashing
            )
            self.assertFalse(result.changed)
            with account_lock(root / "state", account) as acquired:
                self.assertTrue(acquired)


if __name__ == "__main__":
    unittest.main()
