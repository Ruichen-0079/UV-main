from __future__ import annotations

import os
from typing import Any

from agentbus.config import discover_models, discover_profiles, read_global_codex
from agentbus.gitutil import find_worktree_by_path, is_dirty, worktree_list
from agentbus.github import gh_auth_ok, gh_binary
from agentbus.paths import RepoContext
from agentbus.recover import recover_stream, role_process_healthy
from agentbus.store import StreamStore, iter_stores
from agentbus.util import run_cmd, which


def doctor(ctx: RepoContext, env: dict[str, str] | None = None) -> tuple[int, str]:
    lines: list[str] = ["YUVI AGENT BUS DOCTOR", ""]
    failed = 0

    def check(ok: bool, label: str, detail: str = "") -> None:
        nonlocal failed
        mark = "OK  " if ok else "FAIL"
        if not ok:
            failed += 1
        suffix = f" — {detail}" if detail else ""
        lines.append(f"[{mark}] {label}{suffix}")

    check(os.path.isdir(ctx.repo_root), "repository detected", ctx.repo_root)
    git = which("git", env)
    check(bool(git), "git available", git or "missing")
    gh = which(os.path.basename(gh_binary(env)), env) or which("gh", env)
    if os.path.isabs(gh_binary(env)) and os.path.isfile(gh_binary(env)):
        gh = gh_binary(env)
    check(bool(gh), "gh available", gh or "missing")
    if gh:
        ok, text = gh_auth_ok(ctx.repo_root, env)
        check(ok, "GitHub authentication", text.splitlines()[0] if text else "")
    else:
        check(False, "GitHub authentication", "gh missing")

    codex = os.environ.get("YUVI_AGENTBUS_CODEX") if env is None else env.get("YUVI_AGENTBUS_CODEX")
    if not codex:
        codex = which("codex", env)
    check(bool(codex), "codex available", codex or "missing")
    if codex:
        result = run_cmd([codex, "--version"], cwd=ctx.repo_root, env=env, timeout=10)
        check(result.returncode == 0, "codex version", (result.stdout or result.stderr).strip())
    global_cfg = read_global_codex(env)
    check(True, "codex global config (read-only)", global_cfg.get("path"))
    if global_cfg.get("model"):
        lines.append(f"      inherit default: {global_cfg.get('model')} {global_cfg.get('effort') or ''}".rstrip())
    models = discover_models(env)
    profiles = discover_profiles(env)
    lines.append(f"      discovered models: {', '.join(item['slug'] for item in models) or '-'}")
    lines.append(f"      discovered profiles: {', '.join(profiles) or '(none — use model/effort per stream)'}")

    konsole = which("konsole", env)
    check(True, "konsole", konsole or "not found (manual terminals still work)")

    os.makedirs(ctx.repo_state, exist_ok=True)
    writable = os.access(ctx.repo_state, os.W_OK)
    check(writable, "runtime state directory", ctx.repo_state)

    managed: set[str] = set()
    streams = list(iter_stores(ctx))
    check(True, "streams", str(len(streams)))
    for store in streams:
        try:
            state = store.load()
        except Exception as exc:  # noqa: BLE001
            check(False, f"stream {store.stream_id}", str(exc))
            continue
        notes = recover_stream(store, state)
        store.save(state)
        impl = state.get("impl_worktree")
        if impl:
            managed.add(os.path.abspath(impl))
            exists = os.path.isdir(impl)
            check(exists, f"{store.stream_id} impl worktree", impl)
            if exists and find_worktree_by_path(ctx.repo_root, impl) is None:
                check(False, f"{store.stream_id} impl worktree is not in git worktree list", impl)
            if exists and is_dirty(impl):
                lines.append(f"      note: {store.stream_id} impl worktree is dirty")
        audit = state.get("audit_worktree")
        if audit:
            managed.add(os.path.abspath(audit))
        runtime = store.load_runtime()
        for role in ("impl", "audit"):
            slot = runtime.get(role) or {}
            if slot.get("pid") and not role_process_healthy(slot):
                check(True, f"{store.stream_id} {role} stale pid cleared", str(slot.get("pid")))
        if notes:
            for note in notes:
                lines.append(f"      recover: {note}")
        roles = state.get("roles") or {}
        if (roles.get("impl") or {}) == (roles.get("audit") or {}):
            lines.append(f"      note: {store.stream_id} impl/audit settings currently match (allowed)")

    extras = [entry for entry in worktree_list(ctx.repo_root) if os.path.abspath(entry.get("path") or "") not in managed]
    check(True, "unmanaged existing worktrees (left untouched)", str(len(extras)))
    if extras:
        lines.append("      agentbus will not modify these unless a stream is explicitly bound to them")

    lines.append("")
    if failed:
        lines.append(f"Doctor found {failed} problem(s). No host startup files were modified.")
    else:
        lines.append("Doctor passed. No host startup files were modified.")
    return (1 if failed else 0, "\n".join(lines) + "\n")
