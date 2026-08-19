from __future__ import annotations

import json
import os
import re
from typing import Any, Callable
from urllib.parse import quote

import fcntl

from agentbus.paths import AgentbusError, origin_url
from agentbus.store import StreamStore
from agentbus.util import run_cmd, utc_now


DEFAULT_SYNC_INTERVAL = 20.0


def _continuation_already_consumed(state: dict[str, Any], envelope: Any, comment_id: str, ctx: Any) -> bool:
    from agentbus.campaign import infer_campaign_id, load_campaign
    from agentbus.store import StreamStore

    next_id = (envelope.get("NEXT_STREAM") or "").strip().lower()
    if next_id and ctx is not None:
        try:
            if StreamStore(ctx, next_id).exists():
                return True
        except Exception:  # noqa: BLE001
            pass
    campaign_id = infer_campaign_id(state, envelope)
    campaign = load_campaign(ctx, campaign_id) if ctx is not None else None
    for item in (campaign or {}).get("queue") or []:
        if item.get("status") != "consumed":
            continue
        if str(item.get("source_comment_id") or "") == str(comment_id):
            return True
        if next_id and item.get("next_stream") == next_id:
            return True
    rec = (state.get("envelopes") or {}).get("GPT_CONTINUATION") or {}
    if rec.get("source_id") == str(comment_id) and rec.get("consumed_stream"):
        return True
    return False


GhFn = Callable[..., Any]


def gh_binary(env: dict[str, str] | None = None) -> str:
    environ = env or os.environ
    return environ.get("YUVI_AGENTBUS_GH") or "gh"


def run_gh(
    args: list[str],
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    timeout: float = 30,
    input_text: str | None = None,
) -> tuple[int, str, str]:
    result = run_cmd(
        [gh_binary(env), *args],
        cwd=cwd,
        env=env,
        timeout=timeout,
        input_text=input_text,
    )
    return result.returncode, result.stdout, result.stderr


def gh_auth_ok(cwd: str | None = None, env: dict[str, str] | None = None) -> tuple[bool, str]:
    code, out, err = run_gh(["auth", "status"], cwd=cwd, env=env, timeout=15)
    text = (out + "\n" + err).strip()
    return code == 0, text


def parse_owner_repo(origin: str) -> tuple[str, str] | None:
    match = re.search(r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/.]+)", origin)
    if not match:
        return None
    return match.group("owner"), match.group("repo")


def pr_web_url(origin: str, number: int | str | None) -> str | None:
    if not number:
        return None
    parsed = parse_owner_repo(origin)
    if not parsed:
        return None
    owner, repo = parsed
    return f"https://github.com/{owner}/{repo}/pull/{int(number)}"


def resolve_live_base_head(
    cwd: str,
    base_ref_name: str,
    *,
    origin: str | None = None,
    env: dict[str, str] | None = None,
) -> str:
    """Resolve the current remote tip of a PR base branch.

    GitHub's PR ``baseRefOid``/REST ``base.sha`` fields are historical PR
    snapshots.  Merge and review fencing need the branch tip now, so resolve
    the named ref through the branches API and keep the historical PR values
    available to callers as lineage diagnostics.
    """

    parsed = parse_owner_repo(origin or origin_url(cwd))
    if not parsed:
        raise AgentbusError("origin is not a GitHub repository; cannot resolve live PR base")
    owner, repo = parsed
    ref = str(base_ref_name or "").strip()
    if not ref:
        raise AgentbusError("PR base ref name is missing; cannot resolve live base")
    code, out, err = run_gh(
        [
            "api",
            f"repos/{owner}/{repo}/branches/{quote(ref, safe='')}",
        ],
        cwd=cwd,
        env=env,
        timeout=30,
    )
    if code != 0:
        raise AgentbusError(err.strip() or out.strip() or f"could not resolve remote base branch {ref}")
    try:
        payload = json.loads(out or "{}")
    except json.JSONDecodeError as exc:
        raise AgentbusError(f"remote base branch {ref} returned invalid JSON") from exc
    sha = str(((payload.get("commit") or {}).get("sha")) or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
        raise AgentbusError(f"remote base branch {ref} returned no exact commit SHA")
    return sha


def pr_view(cwd: str, number: int, env: dict[str, str] | None = None) -> dict[str, Any]:
    code, out, err = run_gh(
        [
            "pr",
            "view",
            str(number),
            "--json",
            "number,title,headRefName,headRefOid,baseRefName,baseRefOid,state,isDraft,url,statusCheckRollup,mergeCommit,mergeable,mergeStateStatus",
        ],
        cwd=cwd,
        env=env,
        timeout=30,
    )
    if code != 0:
        raise AgentbusError(err.strip() or out.strip() or f"gh pr view {number} failed")
    payload = json.loads(out)
    if not isinstance(payload, dict):
        raise AgentbusError(f"gh pr view {number} returned an invalid object")
    historical = str(payload.get("baseRefOid") or "").strip()
    base_ref = str(payload.get("baseRefName") or "").strip()
    live = resolve_live_base_head(cwd, base_ref, origin=(env or {}).get("YUVI_AGENTBUS_ORIGIN"), env=env)
    payload["graphqlBaseRefOid"] = historical or None
    payload["historicalBaseRefOid"] = historical or None
    payload["liveBaseRefOid"] = live
    # Existing decision/review/merge callers consume baseRefOid.  Normalize
    # that one field to the current branch tip while preserving the PR
    # snapshot above for diagnostics and lineage.
    payload["baseRefOid"] = live
    return payload


def mark_pr_ready(cwd: str, number: int, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Mark one already-fenced PR ready without changing its ref or base."""
    code, out, err = run_gh(
        ["pr", "ready", str(int(number))],
        cwd=cwd,
        env=env,
        timeout=45,
    )
    if code != 0:
        raise AgentbusError(err.strip() or out.strip() or f"gh pr ready {number} failed")
    return {"ok": True, "stdout": (out or "").strip()}


def list_issue_comments(
    cwd: str,
    origin: str,
    number: int,
    env: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    parsed = parse_owner_repo(origin)
    if not parsed:
        raise AgentbusError("origin is not a GitHub repository; cannot sync PR comments")
    owner, repo = parsed
    code, out, err = run_gh(
        ["api", f"repos/{owner}/{repo}/issues/{number}/comments", "--paginate"],
        cwd=cwd,
        env=env,
        timeout=45,
    )
    if code != 0:
        raise AgentbusError(err.strip() or "gh api comments failed")
    data = json.loads(out or "[]")
    if isinstance(data, dict):
        data = [data]
    return data


def create_draft_pr(
    cwd: str,
    *,
    title: str,
    body: str,
    head: str,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Create a draft PR. Never merges. Does not write global Codex config."""
    code, out, err = run_gh(
        ["pr", "create", "--draft", "--title", title, "--body", body, "--head", head, "--base", "main"],
        cwd=cwd,
        env=env,
        timeout=45,
    )
    if code != 0:
        raise AgentbusError(err.strip() or out.strip() or "gh pr create failed")
    text = (out or "").strip()
    match = re.search(r"/pull/(\d+)", text)
    number = int(match.group(1)) if match else None
    if number is None:
        digits = re.search(r"\b(\d+)\b", text)
        number = int(digits.group(1)) if digits else None
    return {"number": number, "url": text, "draft": True}


def post_pr_comment(
    cwd: str,
    number: int,
    body: str,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    parsed = parse_owner_repo((env or os.environ).get("YUVI_AGENTBUS_ORIGIN") or "")
    if parsed is None:
        from agentbus.paths import origin_url

        parsed = parse_owner_repo(origin_url(cwd))
    if parsed:
        owner, repo = parsed
        payload = json.dumps({"body": body})
        code, out, err = run_gh(
            ["api", "--method", "POST", f"repos/{owner}/{repo}/issues/{number}/comments", "--input", "-"],
            cwd=cwd,
            env=env,
            timeout=45,
            input_text=payload,
        )
        if code == 0:
            try:
                data = json.loads(out or "{}")
            except json.JSONDecodeError:
                data = {}
            if isinstance(data, dict) and data.get("id"):
                return {"id": str(data["id"]), "url": data.get("html_url")}
    code, out, err = run_gh(
        ["pr", "comment", str(number), "--body", body],
        cwd=cwd,
        env=env,
        timeout=45,
    )
    if code != 0:
        raise AgentbusError(err.strip() or out.strip() or "gh pr comment failed")
    return {"id": None, "url": (out or "").strip()}


def merge_pr(
    cwd: str,
    number: int,
    *,
    head_sha: str | None,
    method: str = "merge",
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Merge using a merge commit after AgentBus exact-head authorization."""
    if method != "merge":
        raise AgentbusError(f"unsupported merge method {method}")
    args = ["pr", "merge", str(int(number)), "--merge"]
    if head_sha:
        args.extend(["--match-head-commit", head_sha])
    code, out, err = run_gh(args, cwd=cwd, env=env, timeout=60)
    if code != 0:
        raise AgentbusError(err.strip() or out.strip() or f"merge request for PR {number} failed")
    return {"ok": True, "stdout": (out or "").strip(), "method": "merge"}


def mark_github_error(state: dict[str, Any], message: str, *, unauthenticated: bool = False) -> None:
    info = state.setdefault("github", {})
    info["unavailable"] = True
    info["unauthenticated"] = unauthenticated
    info["last_error"] = message
    info["last_sync_at"] = utc_now()


def mark_github_ok(state: dict[str, Any]) -> None:
    info = state.setdefault("github", {})
    info["unavailable"] = False
    info["unauthenticated"] = False
    info["last_error"] = None
    info["last_sync_at"] = utc_now()


def fetch_pr_payload(
    repo_root: str,
    origin: str,
    number: int,
    env: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    comments = list_issue_comments(repo_root, origin, number, env=env)
    try:
        view = pr_view(repo_root, number, env=env)
    except (AgentbusError, json.JSONDecodeError, OSError) as exc:
        view = {"number": number, "_view_error": str(exc)[:400]}
    return comments, view


def rejected_ids(state: dict[str, Any]) -> set[str]:
    return {str(item) for item in (state.get("rejected_comment_ids") or [])}


def record_rejected_comment(
    store: StreamStore,
    state: dict[str, Any],
    *,
    comment_id: str,
    reason: str,
    envelope_kind: str | None,
    source_stream: str | None,
    expected_stream: str | None,
    retryable: bool = False,
    pr: int | str | None = None,
) -> None:
    rejected = state.setdefault("rejected_comments", [])
    ids = state.setdefault("rejected_comment_ids", [])
    record = {
        "comment_id": comment_id,
        "reason": reason,
        "envelope": envelope_kind,
        "source_stream": source_stream,
        "expected_stream": expected_stream,
        "retryable": bool(retryable),
        "pr": pr or state.get("pr"),
        "ts": utc_now(),
        "status": "rejected",
    }
    rejected.append(record)
    if len(rejected) > 200:
        del rejected[:-200]
    if comment_id not in ids:
        ids.append(comment_id)
    store.append_event(
        "github_envelope_rejected",
        {
            "comment_id": comment_id,
            "reason": reason,
            "source_stream": source_stream,
            "expected_stream": expected_stream,
            "retryable": bool(retryable),
            "envelope": envelope_kind,
        },
    )


def unreject_comment(state: dict[str, Any], comment_id: str | None = None) -> list[str]:
    if comment_id:
        wanted = {str(comment_id)}
    else:
        wanted = set(rejected_ids(state))
    state["rejected_comment_ids"] = [
        item for item in (state.get("rejected_comment_ids") or []) if str(item) not in wanted
    ]
    remaining = []
    cleared: list[str] = []
    for item in state.get("rejected_comments") or []:
        cid = str(item.get("comment_id") or "")
        if cid in wanted:
            item["status"] = "recovered"
            item["recovered_at"] = utc_now()
            remaining.append(item)
            cleared.append(cid)
            continue
        remaining.append(item)
    state["rejected_comments"] = remaining
    seen = state.get("seen_comment_ids") or []
    state["seen_comment_ids"] = [item for item in seen if str(item) not in wanted]
    return cleared


def apply_fetched_comments(
    store: StreamStore,
    state: dict[str, Any],
    *,
    comments: list[dict[str, Any]],
    view: dict[str, Any],
    repo_root: str,
    current_head: str | None,
    ctx: Any = None,
    reprocess_ids: set[str] | None = None,
) -> list[str]:
    from agentbus.apply import ingest_text, mark_pr_merged, touch_seen_comment
    from agentbus.protocol import parse_comment_envelope
    from agentbus.streamid import claimed_ids, classify_envelope_stream, ensure_stream_aliases

    notes: list[str] = []
    if ctx is not None:
        notes.extend(ensure_stream_aliases(ctx, state))
    else:
        notes.extend(ensure_stream_aliases(None, state))
    if view.get("_view_error"):
        notes.append(f"PR view degraded: {view['_view_error']}")
    mark_github_ok(state)
    # Cache the last read-only PR projection so every decision surface sees
    # the same HEAD/base/CI generation between GitHub polls. This cache never
    # replaces GitHub as authority and is refreshed by the normal sync lease.
    if not view.get("_view_error"):
        state.setdefault("github", {})["pr"] = dict(view)
    if view.get("headRefName") and not state.get("branch"):
        state["branch"] = view["headRefName"]
    if view.get("title") and not state.get("goal"):
        state["goal"] = view["title"]
    seen = set(state.get("seen_comment_ids") or [])
    rejected = rejected_ids(state)
    reprocess = {str(item) for item in (reprocess_ids or set())}
    others = claimed_ids(ctx, except_stream=state.get("stream_id")) if ctx is not None else set()
    stale_merge_ids = {
        str(item.get("source_id"))
        for item in (state.get("stale_merge_reviews") or [])
        if isinstance(item, dict) and str(item.get("source_id") or "").strip()
    }

    def stale_merge_review_is_current(envelope: Any) -> bool:
        fields = envelope.fields if isinstance(getattr(envelope, "fields", None), dict) else {}
        expected_head = str(current_head or "").strip()
        reviewed_head = str(fields.get("REVIEWED_HEAD") or envelope.head or "").strip()
        if expected_head and reviewed_head != expected_head:
            return False
        reviewed_pr = str(fields.get("PR") or "").strip().lstrip("#")
        if state.get("pr") and reviewed_pr != str(state.get("pr")):
            return False
        current_base = str(view.get("baseRefOid") or "").strip()
        reviewed_base = str(fields.get("REVIEWED_BASE") or "").strip()
        if current_base and reviewed_base != current_base:
            return False
        job_id = str(fields.get("JOB_ID") or "").strip()
        if not job_id:
            return True
        from agentbus.campaign import infer_campaign_id, load_campaign
        from agentbus.decision import FINAL_GPT, FINAL_REVIEW, browser_job_id

        campaign = load_campaign(ctx, infer_campaign_id(state)) if ctx is not None else None
        expected_job = browser_job_id(state, campaign, view, role=FINAL_GPT, task=FINAL_REVIEW)
        return job_id == expected_job

    merged_now = view.get("state") == "MERGED"
    merge_sha = None
    if merged_now:
        merge_commit = view.get("mergeCommit")
        if isinstance(merge_commit, dict):
            merge_sha = merge_commit.get("oid")
        elif isinstance(merge_commit, str):
            merge_sha = merge_commit
        if merge_sha:
            state.setdefault("heads", {})["merged"] = merge_sha
        if state.get("phase") != "MERGED":
            mark_pr_merged(state, store, merge_sha=merge_sha)
    for comment in comments:
        cid = str(comment.get("id") or "")
        body = comment.get("body") or ""
        if not cid:
            continue
        if cid in reprocess:
            unreject_comment(state, cid)
            rejected.discard(cid)
            seen.discard(cid)
        if cid in seen or cid in rejected:
            preview = parse_comment_envelope(body)
            if (
                preview
                and preview.kind == "GPT_CONTINUATION"
                and not _continuation_already_consumed(state, preview, cid, ctx)
            ):
                seen.discard(cid)
                rejected.discard(cid)
                unreject_comment(state, cid)
            elif preview and preview.kind == "GPT_MERGE_REVIEW" and cid in stale_merge_ids and stale_merge_review_is_current(preview):
                # A review can be observed before the PR/base projection has
                # converged.  Revisit only an exact current head/PR/base/job;
                # wrong-generation history remains ignored.
                seen.discard(cid)
                rejected.discard(cid)
            else:
                continue
        if "[" not in body:
            touch_seen_comment(state, cid)
            continue
        try:
            first = parse_comment_envelope(body)
            envelopes = [first] if first else []
            if not envelopes:
                touch_seen_comment(state, cid)
                continue
            own: list[Any] = []
            ignored = 0
            for envelope in envelopes:
                relation = classify_envelope_stream(
                    envelope.stream,
                    state,
                    claimed=others,
                    envelope=envelope,
                )
                if relation == "self":
                    own.append(envelope)
                    continue
                if relation == "foreign":
                    ignored += 1
                    continue
                if relation == "missing":
                    record_rejected_comment(
                        store,
                        state,
                        comment_id=cid,
                        reason="missing STREAM",
                        envelope_kind=envelope.kind,
                        source_stream=None,
                        expected_stream=state.get("stream_id"),
                        retryable=False,
                        pr=state.get("pr"),
                    )
                    notes.append(f"rejected comment {cid}: missing STREAM")
                    own = []
                    break
                record_rejected_comment(
                    store,
                    state,
                    comment_id=cid,
                    reason=f"stream mismatch: envelope={envelope.stream} expected={state.get('stream_id')}",
                    envelope_kind=envelope.kind,
                    source_stream=envelope.stream,
                    expected_stream=state.get("stream_id"),
                    retryable=False,
                    pr=state.get("pr"),
                )
                notes.append(f"rejected comment {cid}: unknown stream {envelope.stream}")
                own = []
                break
            else:
                if not own:
                    touch_seen_comment(state, cid)
                    if ignored:
                        notes.append(f"ignored foreign envelope in comment {cid}")
                    continue
                text = "\n\n".join(item.raw or "" for item in own)
                applied = ingest_text(
                    store,
                    state,
                    text,
                    repo=state.get("impl_worktree") or repo_root,
                    current_head=current_head,
                    source="github",
                    source_id=cid,
                )
                touch_seen_comment(state, cid)
                if applied:
                    notes.append(
                        "ingested " + ", ".join(item.kind for item in applied) + f" from comment {cid}"
                    )
        except Exception as exc:  # noqa: BLE001 — one comment must not abort sync
            record_rejected_comment(
                store,
                state,
                comment_id=cid,
                reason=str(exc)[:400],
                envelope_kind=None,
                source_stream=None,
                expected_stream=state.get("stream_id"),
                retryable=False,
                pr=state.get("pr"),
            )
            notes.append(f"rejected comment {cid}: {exc}")
    if merged_now:
        mark_pr_merged(state, store, merge_sha=merge_sha or (state.get("heads") or {}).get("merged"))
        notes.append("PR is merged")
    return notes


def sync_stream(
    store: StreamStore,
    state: dict[str, Any],
    *,
    repo_root: str,
    origin: str,
    current_head: str | None,
    env: dict[str, str] | None = None,
    ctx: Any = None,
    reprocess_ids: set[str] | None = None,
) -> list[str]:
    notes: list[str] = []
    pr = state.get("pr")
    if not pr:
        return notes
    ok, auth_text = gh_auth_ok(repo_root, env)
    if not ok:
        unauth = "not logged" in auth_text.lower() or "authentication" in auth_text.lower()
        mark_github_error(state, auth_text or "gh auth status failed", unauthenticated=unauth)
        notes.append("GitHub auth failed; using local inbox only")
        return notes
    try:
        comments, view = fetch_pr_payload(repo_root, origin, int(pr), env=env)
    except (AgentbusError, json.JSONDecodeError, OSError) as exc:
        mark_github_error(state, str(exc)[:400])
        notes.append(f"GitHub unavailable: {exc}")
        return notes
    notes.extend(
        apply_fetched_comments(
            store,
            state,
            comments=comments,
            view=view,
            repo_root=repo_root,
            current_head=current_head,
            ctx=ctx,
            reprocess_ids=reprocess_ids,
        )
    )
    return notes


def sync_interval(env: dict[str, str] | None = None) -> float:
    raw = (env or os.environ).get("YUVI_AGENTBUS_SYNC_INTERVAL")
    if not raw:
        return DEFAULT_SYNC_INTERVAL
    try:
        return max(1.0, float(raw))
    except ValueError:
        return DEFAULT_SYNC_INTERVAL


def sync_with_lease(
    store: StreamStore,
    state: dict[str, Any],
    *,
    repo_root: str,
    origin: str,
    current_head: str | None,
    env: dict[str, str] | None = None,
    force: bool = False,
    ctx: Any = None,
    reprocess_ids: set[str] | None = None,
) -> list[str]:
    """Exactly-once-ish GitHub sync. Fetch happens without the stream lock."""
    if not state.get("pr"):
        return []
    interval = sync_interval(env)
    runtime = store.load_runtime()
    last = runtime.get("last_github_sync")
    if not force and last:
        try:
            from datetime import datetime, timezone

            then = datetime.strptime(str(last), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            if (datetime.now(timezone.utc) - then).total_seconds() < interval:
                return []
        except ValueError:
            pass
    lock_path = os.path.join(store.path, "sync.lock")
    os.makedirs(store.path, exist_ok=True)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return []
        ok, auth_text = gh_auth_ok(repo_root, env)
        if not ok:
            unauth = "not logged" in auth_text.lower() or "authentication" in auth_text.lower()
            mark_github_error(state, auth_text or "gh auth status failed", unauthenticated=unauth)
            return ["GitHub auth failed; using local inbox only"]
        try:
            comments, view = fetch_pr_payload(repo_root, origin, int(state["pr"]), env=env)
        except (AgentbusError, json.JSONDecodeError, OSError) as exc:
            mark_github_error(state, str(exc)[:400])
            return [f"GitHub unavailable: {exc}"]
        notes = apply_fetched_comments(
            store,
            state,
            comments=comments,
            view=view,
            repo_root=repo_root,
            current_head=current_head,
            ctx=ctx,
            reprocess_ids=reprocess_ids,
        )
        runtime = store.load_runtime()
        runtime["last_github_sync"] = utc_now()
        store.save_runtime(runtime)
        return notes
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def publish_body(
    state: dict[str, Any],
    body: str,
    *,
    repo_root: str,
    env: dict[str, str] | None = None,
) -> bool:
    pr = state.get("pr")
    if not pr:
        return False
    try:
        post_pr_comment(repo_root, int(pr), body, env=env)
    except (AgentbusError, OSError) as exc:
        mark_github_error(state, str(exc))
        unpublished = state.setdefault("unpublished", [])
        unpublished.append({"ts": utc_now(), "error": str(exc), "preview": body[:80]})
        return False
    return True
