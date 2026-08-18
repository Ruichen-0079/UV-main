from __future__ import annotations

import unittest

from agentbus.protocol import (
    parse_comment_envelope,
    parse_envelopes,
    parse_one,
    render_envelope,
    validate_envelope,
)


class ProtocolTests(unittest.TestCase):
    def test_parse_spec(self) -> None:
        text = """intro

[GPT_SPEC]

STATUS: ACTIONABLE

STREAM:
p7-9a

BASE_HEAD:
abc123

SCOPE:
- one
- two

ACCEPTANCE_CRITERIA:
- done

NEXT_ACTION:
IMPL
"""
        env = parse_one(text)
        self.assertEqual(env.kind, "GPT_SPEC")
        self.assertEqual(env.status, "ACTIONABLE")
        self.assertEqual(env.stream, "p7-9a")
        self.assertEqual(env.head, "abc123")
        self.assertIn("- one", env.get("SCOPE"))
        self.assertEqual(validate_envelope(env), [])

    def test_body_markers_do_not_split_envelope(self) -> None:
        text = """[CODEX_REPORT]
STATUS: READY_FOR_AUDIT
STREAM: a
IMPLEMENTED_HEAD: def

[CODEX_AUDIT]
STATUS: PASS
STREAM: a
AUDITED_HEAD: def
"""
        found = parse_envelopes(text)
        self.assertEqual([item.kind for item in found], ["CODEX_REPORT"])
        self.assertIn("[CODEX_AUDIT]", found[0].raw)

    def test_final_gate_not_misclassified_from_prose_markers(self) -> None:
        text = """[FINAL_GATE]

STATUS: PASS

STREAM: p7-8b-canary

FINAL_HEAD: 2d51d8bf5fa0cb14a4518f959c98740750d1e97c

GATES:
- Browser GPT review is ACCEPT.
- Independent Codex audit is PASS.
- Earlier comments included [GPT_REVIEW] and [CODEX_AUDIT].

```text
[GPT_REVIEW]
STATUS: ACCEPT
```

NEXT_ACTION: MERGE
"""
        env = parse_comment_envelope(text)
        self.assertIsNotNone(env)
        assert env is not None
        self.assertEqual(env.kind, "FINAL_GATE")
        self.assertEqual(env.status, "PASS")
        self.assertEqual(env.head, "2d51d8bf5fa0cb14a4518f959c98740750d1e97c")
        self.assertEqual(validate_envelope(env, expected_stream="p7-8b-canary"), [])
        self.assertEqual(len(parse_envelopes(text, leading_header=True)), 1)

    def test_comment_requires_leading_header(self) -> None:
        text = """Please review this.

[GPT_REVIEW]
STATUS: ACCEPT
STREAM: p7-8b-canary
REVIEWED_HEAD: abc
"""
        self.assertIsNone(parse_comment_envelope(text))
        scanned = parse_envelopes(text)
        self.assertEqual(scanned[0].kind, "GPT_REVIEW")

    def test_inline_and_quoted_markers_are_not_headers(self) -> None:
        text = """[FINAL_GATE]
STATUS: PASS
STREAM: p7-8b-canary
FINAL_HEAD: abc
NOTES:
Audit saw [GPT_REVIEW] earlier.
\"\"\"
[GPT_REVIEW]
\"\"\"
"""
        env = parse_comment_envelope(text)
        self.assertEqual(env.kind, "FINAL_GATE")
        self.assertEqual(env.head, "abc")

    def test_parse_continuation(self) -> None:
        text = """[GPT_CONTINUATION]

STATUS: ACTIONABLE

CAMPAIGN: p7

AFTER_STREAM: p7-8b-canary

TRIGGER: MERGED

NEXT_STREAM: p7-8c

TARGET: next unit

BASE_ANCHOR: PREVIOUS_MERGE

SCOPE:
src/a.py

ACCEPTANCE_CRITERIA:
done

REVIEW_POLICY: AUDIT_SUFFICIENT

NEXT_ACTION: CREATE_AND_IMPLEMENT
"""
        env = parse_one(text)
        self.assertEqual(env.kind, "GPT_CONTINUATION")
        self.assertEqual(env.get("NEXT_STREAM").strip(), "p7-8c")
        self.assertEqual(validate_envelope(env), [])

    def test_roundtrip(self) -> None:
        env = parse_one("[HUMAN_NOTE]\nSTATUS: INFO\nSTREAM: x\nREASON: hello\n")
        again = parse_one(render_envelope(env))
        self.assertEqual(again.status, "INFO")
        self.assertEqual(again.get("REASON"), "hello")
