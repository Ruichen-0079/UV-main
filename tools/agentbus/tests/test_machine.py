from __future__ import annotations

import unittest

from agentbus.machine import (
    AUDITING,
    BLOCKED_FOR_REVIEW,
    IMPLEMENTING,
    READY_FOR_GPT,
    TransitionError,
    WAITING_FOR_SPEC,
    can_transition,
    repair_limit_reached,
    transition,
)


class MachineTests(unittest.TestCase):
    def test_legal_happy_path(self) -> None:
        phase = WAITING_FOR_SPEC
        for dest in (IMPLEMENTING, "VALIDATING", "READY_FOR_AUDIT", AUDITING, READY_FOR_GPT):
            phase = transition(phase, dest)

    def test_illegal(self) -> None:
        with self.assertRaises(TransitionError):
            transition(WAITING_FOR_SPEC, READY_FOR_GPT)

    def test_same_phase_ok(self) -> None:
        self.assertTrue(can_transition(IMPLEMENTING, IMPLEMENTING))

    def test_repair_limit(self) -> None:
        self.assertFalse(repair_limit_reached(1, 2))
        self.assertTrue(repair_limit_reached(2, 2))
        self.assertNotEqual(BLOCKED_FOR_REVIEW, READY_FOR_GPT)
