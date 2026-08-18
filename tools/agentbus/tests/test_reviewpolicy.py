from __future__ import annotations

from agentbus.apply import apply_envelope
from agentbus.machine import FINAL_GATE, IMPLEMENTING, READY_FOR_GPT
from agentbus.protocol import parse_one
from agentbus.reviewpolicy import review_policy_of
from agentbus.tests.harness import AgentbusTest


class ReviewPolicyTests(AgentbusTest):
    def _spec(self, stream: str, head: str, policy: str | None) -> str:
        extra = f"\nREVIEW_POLICY: {policy}\n" if policy else "\n"
        return f"""[GPT_SPEC]

STATUS: ACTIONABLE

STREAM: {stream}

BASE_HEAD: {head}

SCOPE:
README.md

ACCEPTANCE_CRITERIA:
done
{extra}NEXT_ACTION: IMPLEMENT
"""

    def _report(self, stream: str, head: str, files: str = "README.md", deviations: str = "None") -> str:
        return f"""[CODEX_REPORT]

STATUS: READY_FOR_AUDIT

STREAM: {stream}

IMPLEMENTED_HEAD: {head}

CHANGED_FILES: {files}

VALIDATION: ok

DEVIATIONS: {deviations}

KNOWN_RISKS: None

NEXT_ACTION: AUDIT
"""

    def _audit(self, stream: str, head: str, status: str = "PASS", findings: str = "None blocking.") -> str:
        return f"""[CODEX_AUDIT]

STATUS: {status}

STREAM: {stream}

AUDITED_HEAD: {head}

FINDINGS: {findings}

RESIDUAL_RISKS: None

NEXT_ACTION: READY_FOR_GPT
"""

    def _apply(self, store, text: str, head: str) -> None:
        state = store.load()
        apply_envelope(store, state, parse_one(text), repo=self.repo, current_head=head)
        store.save(state)

    def _publish_head(self, store, head: str) -> None:
        state = store.load()
        state.setdefault("publication", {})["commit"] = head
        state["publication"]["status"] = "committed"
        store.save(state)

    def test_missing_review_policy_defaults_gpt_required(self) -> None:
        self.create_stream("s1")
        self.assertEqual(review_policy_of(self.store("s1").load()), "GPT_REQUIRED")
        head = self.git("rev-parse", "HEAD")
        store = self.store("s1")
        self._apply(store, self._spec("s1", head, None), head)
        self.assertEqual(review_policy_of(store.load()), "GPT_REQUIRED")

    def test_audit_sufficient_exact_sha_pass_auto_advances(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        self._apply(store, self._spec("s1", head, "AUDIT_SUFFICIENT"), head)
        self._publish_head(store, head)
        self._apply(store, self._report("s1", head), head)
        self._apply(store, self._audit("s1", head), head)
        state = store.load()
        self.assertEqual(state["phase"], FINAL_GATE)
        self.assertEqual(state.get("review_authority"), "delegated_by_gpt_spec")
        self.assertNotIn("GPT_REVIEW", state.get("envelopes") or {})
        self.assertTrue(state.get("delegated_reviews"))

    def test_high_finding_cannot_auto_advance(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        self._apply(store, self._spec("s1", head, "AUDIT_SUFFICIENT"), head)
        self._publish_head(store, head)
        self._apply(store, self._report("s1", head), head)
        self._apply(store, self._audit("s1", head, findings="HIGH: secret leak"), head)
        self.assertEqual(store.load()["phase"], READY_FOR_GPT)

    def test_medium_finding_cannot_auto_advance(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        self._apply(store, self._spec("s1", head, "AUDIT_SUFFICIENT"), head)
        self._publish_head(store, head)
        self._apply(store, self._report("s1", head), head)
        self._apply(store, self._audit("s1", head, findings="MEDIUM: missing tests"), head)
        self.assertEqual(store.load()["phase"], READY_FOR_GPT)

    def test_scope_deviation_cannot_auto_advance(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        self._apply(store, self._spec("s1", head, "AUDIT_SUFFICIENT"), head)
        self._publish_head(store, head)
        self._apply(store, self._report("s1", head, files="secret/key.py"), head)
        self._apply(store, self._audit("s1", head), head)
        self.assertEqual(store.load()["phase"], READY_FOR_GPT)

    def test_head_drift_cannot_auto_advance(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        self._apply(store, self._spec("s1", head, "AUDIT_SUFFICIENT"), head)
        self._publish_head(store, head)
        self._apply(store, self._report("s1", head), head)
        drifted = self.commit_file("other.md", "drift\n", "drift")
        self._apply(store, self._audit("s1", head), drifted)
        self.assertNotEqual(store.load()["phase"], FINAL_GATE)

    def test_repair_within_scope_retains_delegation(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        self._apply(store, self._spec("s1", head, "AUDIT_SUFFICIENT"), head)
        self._publish_head(store, head)
        self._apply(store, self._report("s1", head), head)
        h2 = self.commit_file("README.md", "repair\n", "repair in scope")
        state = store.load()
        state["repair_cycles"] = 1
        state["heads"]["implemented"] = h2
        state["heads"]["current"] = h2
        state["publication"]["commit"] = h2
        state["envelopes"]["CODEX_REPORT"]["fields"]["IMPLEMENTED_HEAD"] = h2
        state["envelopes"]["CODEX_REPORT"]["fields"]["CHANGED_FILES"] = "README.md"
        state["envelopes"]["CODEX_REPORT"]["fields"]["DEVIATIONS"] = "None"
        state["phase"] = IMPLEMENTING
        store.save(state)
        self._apply(store, self._audit("s1", h2), h2)
        self.assertEqual(store.load()["phase"], FINAL_GATE)

    def test_architecture_expanding_repair_requires_gpt(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        head = self.git("rev-parse", "HEAD")
        self._apply(store, self._spec("s1", head, "AUDIT_SUFFICIENT"), head)
        self._publish_head(store, head)
        self._apply(store, self._report("s1", head), head)
        h2 = self.commit_file("README.md", "arch\n", "architecture repair")
        state = store.load()
        state["repair_cycles"] = 1
        state["heads"]["implemented"] = h2
        state["heads"]["current"] = h2
        state["publication"]["commit"] = h2
        state["envelopes"]["CODEX_REPORT"]["fields"]["IMPLEMENTED_HEAD"] = h2
        state["envelopes"]["CODEX_REPORT"]["fields"]["DEVIATIONS"] = "rewrote architecture"
        state["phase"] = IMPLEMENTING
        store.save(state)
        self._apply(store, self._audit("s1", h2), h2)
        self.assertEqual(store.load()["phase"], READY_FOR_GPT)
