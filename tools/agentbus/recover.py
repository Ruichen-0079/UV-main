from __future__ import annotations

from typing import Any

from agentbus import machine
from agentbus.apply import refresh_next, set_phase
from agentbus.gitutil import head_sha, is_dirty
from agentbus.store import StreamStore
from agentbus.util import pid_is_alive, pid_start_token


def role_process_healthy(runtime_role: dict[str, Any]) -> bool:
    pid = runtime_role.get("pid")
    if not pid:
        return False
    if not pid_is_alive(int(pid)):
        return False
    expected = runtime_role.get("start_token")
    if not expected:
        return True
    actual = pid_start_token(int(pid))
    return actual == expected


def clear_dead_role(runtime: dict[str, Any], role: str) -> bool:
    slot = runtime.setdefault(role, {})
    if not slot.get("pid"):
        return False
    if role_process_healthy(slot):
        return True
    slot["last_exit"] = slot.get("last_exit")
    slot["pid"] = None
    slot["start_token"] = None
    slot["cmd"] = []
    return False


def recover_stream(store: StreamStore, state: dict[str, Any]) -> list[str]:
    notes: list[str] = []
    runtime = store.load_runtime()
    for role in ("impl", "audit"):
        slot = runtime.get(role) or {}
        if not slot.get("pid"):
            continue
        if role_process_healthy(slot):
            state["status"][role] = "RUNNING"
            continue
        notes.append(f"{role} pid {slot.get('pid')} is stale")
        clear_dead_role(runtime, role)
        if state.get("control") == "paused":
            continue
        if role == "impl" and state["phase"] in {machine.IMPLEMENTING, machine.VALIDATING}:
            state["status"]["impl"] = "CRASHED"
            set_phase(state, machine.RECOVERY_REQUIRED, reason="impl process died")
            notes.append("phase set to RECOVERY_REQUIRED after impl crash")
        if role == "audit" and state["phase"] == machine.AUDITING:
            state["status"]["audit"] = "CRASHED"
            set_phase(state, machine.RECOVERY_REQUIRED, reason="audit process died")
            notes.append("phase set to RECOVERY_REQUIRED after audit crash")
    store.save_runtime(runtime)

    impl = state.get("impl_worktree")
    if impl:
        current = head_sha(impl)
        if current:
            last = (state.get("heads") or {}).get("last_seen")
            if last and current != last and state["phase"] in {
                machine.READY_FOR_AUDIT,
                machine.AUDITING,
                machine.READY_FOR_GPT,
                machine.GPT_REVIEW,
                machine.FINAL_GATE,
            }:
                implemented = (state.get("heads") or {}).get("implemented")
                from agentbus.generation import is_owned_head, lease_matches

                if is_owned_head(state, current) or lease_matches(state, current):
                    state["heads"]["last_seen"] = current
                    notes.append(f"accepted owned publication HEAD {current[:12]}")
                elif implemented and current != implemented:
                    state["status"]["blocker"] = (
                        f"external HEAD change {last[:7]} -> {current[:7]}"
                    )
                    set_phase(state, machine.RE_REVIEW_REQUIRED, reason="external HEAD change")
                    notes.append(state["status"]["blocker"])
            state["heads"]["current"] = current
            if state["phase"] in {machine.IMPLEMENTING, machine.VALIDATING}:
                state["heads"]["last_seen"] = current
            from agentbus.generation import reconcile_owned_repair

            notes.extend(reconcile_owned_repair(state))
        if is_dirty(impl) and state["phase"] == machine.WAITING_FOR_SPEC:
            notes.append("implementation worktree is dirty")
    refresh_next(state)
    return notes
