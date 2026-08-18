"""Repository-wide, non-secret AgentBus settings and GPT binding migration."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from agentbus.lock import StreamLock
from agentbus.paths import AgentbusError, RepoContext
from agentbus.util import atomic_write_json, read_json, utc_now


SETTINGS_VERSION = 1
BRIDGE_ONLINE_SECONDS = 45


def empty_binding() -> dict[str, Any]:
    return {"display_name": None, "url": None, "note": None, "bound_at": None}


def is_chatgpt_conversation_url(url: str | None) -> bool:
    parsed = urlparse(str(url or "").strip())
    return parsed.scheme == "https" and parsed.hostname == "chatgpt.com" and bool(parsed.path.strip("/"))


def extension_dir() -> str:
    return os.path.join(os.path.dirname(__file__), "browser_extension")


def settings_path(ctx: RepoContext) -> str:
    return os.path.join(ctx.repo_state, "settings.json")


def settings_lock(ctx: RepoContext) -> StreamLock:
    os.makedirs(ctx.repo_state, exist_ok=True)
    return StreamLock(os.path.join(ctx.repo_state, "settings.lock"))


def default_settings() -> dict[str, Any]:
    return {
        "schema_version": SETTINGS_VERSION,
        "product_gpt": empty_binding(),
        "final_gpt": empty_binding(),
        "autonomous_merge": {"enabled": True, "activated_at": None},
        "browser_bridge": {
            "extension_dir": extension_dir(),
            "activated_at": None,
            "last_seen_at": None,
        },
        "migration": {"binding_ambiguities": [], "last_run_at": None},
    }


def apply_settings_defaults(settings: dict[str, Any]) -> dict[str, Any]:
    defaults = default_settings()
    settings.setdefault("schema_version", SETTINGS_VERSION)
    for key in ("product_gpt", "final_gpt"):
        binding = settings.setdefault(key, empty_binding())
        if not isinstance(binding, dict):
            settings[key] = empty_binding()
            binding = settings[key]
        for field, value in empty_binding().items():
            binding.setdefault(field, value)
    auto = settings.setdefault("autonomous_merge", {})
    auto.setdefault("enabled", True)
    auto.setdefault("activated_at", None)
    bridge = settings.setdefault("browser_bridge", {})
    bridge.setdefault("extension_dir", defaults["browser_bridge"]["extension_dir"])
    bridge.setdefault("activated_at", None)
    bridge.setdefault("last_seen_at", None)
    migration = settings.setdefault("migration", {})
    migration.setdefault("binding_ambiguities", [])
    migration.setdefault("last_run_at", None)
    return settings


def load_settings(ctx: RepoContext) -> dict[str, Any]:
    raw = read_json(settings_path(ctx), default=None)
    if not isinstance(raw, dict):
        raw = default_settings()
    return apply_settings_defaults(raw)


def save_settings(ctx: RepoContext, settings: dict[str, Any]) -> dict[str, Any]:
    os.makedirs(ctx.repo_state, exist_ok=True)
    apply_settings_defaults(settings)
    settings["updated_at"] = utc_now()
    atomic_write_json(settings_path(ctx), settings)
    return settings


def _binding(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return empty_binding()
    result = empty_binding()
    result.update({key: raw.get(key) for key in result})
    return result


def _resolved(raw: Any, source: str) -> dict[str, Any] | None:
    binding = _binding(raw)
    if not (binding.get("url") or binding.get("display_name")):
        return None
    binding["source"] = source
    binding["configured"] = bool(binding.get("url"))
    binding["bound"] = bool(binding.get("url") or binding.get("display_name"))
    binding["convenience_only"] = True
    binding["authority"] = "GitHub PR comments and PR state"
    return binding


def resolve_product_gpt_binding(
    state: dict[str, Any],
    campaign: dict[str, Any] | None,
    settings: dict[str, Any] | None,
) -> dict[str, Any]:
    """stream override → campaign binding → repository-global default."""
    for raw, source in (
        (state.get("browser_gpt"), "stream"),
        ((campaign or {}).get("product_gpt"), "campaign"),
        ((settings or {}).get("product_gpt"), "global"),
    ):
        resolved = _resolved(raw, source)
        if resolved:
            return resolved
    result = empty_binding()
    result.update({"source": None, "configured": False, "bound": False})
    return result


def resolve_final_gpt_binding(
    state: dict[str, Any],
    settings: dict[str, Any] | None,
) -> dict[str, Any]:
    """explicit stream Final GPT override → one global Final GPT binding."""
    for raw, source in (
        (state.get("final_gpt"), "stream"),
        ((settings or {}).get("final_gpt"), "global"),
    ):
        resolved = _resolved(raw, source)
        if resolved:
            return resolved
    result = empty_binding()
    result.update({"source": None, "configured": False, "bound": False})
    return result


def set_global_binding(
    ctx: RepoContext,
    role: str,
    *,
    display_name: str | None = None,
    url: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    from agentbus.actions import validate_browser_url

    normalized = role.strip().upper()
    if normalized not in {"PRODUCT_GPT", "FINAL_GPT"}:
        raise AgentbusError(f"unknown global GPT role {role!r}")
    key = "product_gpt" if normalized == "PRODUCT_GPT" else "final_gpt"
    with settings_lock(ctx):
        settings = load_settings(ctx)
        binding = settings.setdefault(key, empty_binding())
        if display_name is not None:
            binding["display_name"] = display_name.strip() or None
        if url is not None:
            binding["url"] = validate_browser_url(url) if url.strip() else None
            if binding["url"] and not is_chatgpt_conversation_url(binding["url"]):
                raise AgentbusError("global Browser GPT URL must be an https://chatgpt.com/... conversation")
        if note is not None:
            binding["note"] = note.strip() or None
        binding["bound_at"] = utc_now()
        save_settings(ctx, settings)
    return settings


def _url_records(states: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for state in states:
        binding = _binding(state.get(key))
        url = str(binding.get("url") or "").strip()
        if url:
            found.setdefault(url, binding)
    return found


def migrate_gpt_bindings(ctx: RepoContext) -> dict[str, Any]:
    """Conservatively promote unambiguous legacy bindings through normal stores."""
    from agentbus.campaign import (
        apply_campaign_defaults,
        campaign_lock,
        infer_campaign_id,
        list_campaigns,
        save_campaign,
    )
    from agentbus.store import iter_stores

    states: list[dict[str, Any]] = []
    for store in iter_stores(ctx):
        try:
            states.append(store.load())
        except Exception:  # noqa: BLE001 - one corrupt legacy unit cannot make us guess
            continue
    notes: list[str] = []
    ambiguities: list[dict[str, Any]] = []
    with campaign_lock(ctx):
        campaigns = {item.get("campaign_id"): apply_campaign_defaults(item) for item in list_campaigns(ctx)}
        for campaign_id, campaign in campaigns.items():
            current = _binding(campaign.get("product_gpt"))
            if current.get("url"):
                continue
            members = [state for state in states if infer_campaign_id(state) == campaign_id]
            urls = _url_records(members, "browser_gpt")
            valid_urls = {url: binding for url, binding in urls.items() if is_chatgpt_conversation_url(url)}
            if len(urls) == 1 and len(valid_urls) == 1:
                promoted = dict(next(iter(valid_urls.values())))
                promoted["migrated_at"] = utc_now()
                campaign["product_gpt"] = promoted
                save_campaign(ctx, campaign)
                notes.append(f"{campaign_id}: promoted legacy Product GPT binding to campaign")
            elif urls:
                ambiguity = {"kind": "PRODUCT_GPT", "campaign": campaign_id, "urls": sorted(urls)}
                ambiguities.append(ambiguity)
                notes.append(f"{campaign_id}: ambiguous or non-ChatGPT Product GPT bindings preserved")

    with settings_lock(ctx):
        settings = load_settings(ctx)
        final_binding = _binding(settings.get("final_gpt"))
        if not final_binding.get("url"):
            legacy: dict[str, dict[str, Any]] = _url_records(states, "merge_gpt")
            for campaign in campaigns.values():
                binding = _binding(campaign.get("merge_gpt"))
                url = str(binding.get("url") or "").strip()
                if url:
                    legacy.setdefault(url, binding)
            valid_legacy = {url: binding for url, binding in legacy.items() if is_chatgpt_conversation_url(url)}
            if len(legacy) == 1 and len(valid_legacy) == 1:
                promoted = dict(next(iter(valid_legacy.values())))
                promoted["migrated_at"] = utc_now()
                settings["final_gpt"] = promoted
                notes.append("promoted the unique legacy Merge GPT binding to global Final GPT")
            elif legacy:
                ambiguities.append({"kind": "FINAL_GPT", "scope": "global", "urls": sorted(legacy)})
                notes.append("ambiguous or non-ChatGPT legacy Merge GPT bindings preserved; global Final GPT unset")
        migration = settings.setdefault("migration", {})
        migration["binding_ambiguities"] = ambiguities
        migration["last_run_at"] = utc_now()
        save_settings(ctx, settings)
    return {"settings": settings, "notes": notes, "ambiguities": ambiguities}


def note_browser_poll(ctx: RepoContext) -> dict[str, Any]:
    """Record bridge liveness only; this never acknowledges or authorizes a job."""
    with settings_lock(ctx):
        settings = load_settings(ctx)
        bridge = settings.setdefault("browser_bridge", {})
        age = _age_seconds(bridge.get("last_seen_at"))
        if age is not None and age < 15:
            return settings
        now = utc_now()
        bridge["last_seen_at"] = now
        if not bridge.get("activated_at"):
            bridge["activated_at"] = now
        auto = settings.setdefault("autonomous_merge", {})
        if auto.get("enabled") and not auto.get("activated_at") and (settings.get("final_gpt") or {}).get("url"):
            auto["activated_at"] = now
        save_settings(ctx, settings)
    return settings


def _age_seconds(raw: str | None) -> float | None:
    if not raw:
        return None
    try:
        then = datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return max(0.0, (datetime.now(timezone.utc) - then).total_seconds())


def browser_bridge_status(ctx: RepoContext) -> dict[str, Any]:
    settings = load_settings(ctx)
    bridge = settings.get("browser_bridge") or {}
    age = _age_seconds(bridge.get("last_seen_at"))
    online = age is not None and age <= BRIDGE_ONLINE_SECONDS
    return {
        "status": "ONLINE" if online else "OFFLINE",
        "online": online,
        "last_seen_at": bridge.get("last_seen_at"),
        "extension_dir": bridge.get("extension_dir") or extension_dir(),
        "activation_status": "ACTIVE" if bridge.get("activated_at") else "SETUP_REQUIRED",
    }


def autonomous_merge_ready(ctx: RepoContext, env: dict[str, str] | None = None) -> bool:
    environ = env or os.environ
    if environ.get("YUVI_AGENTBUS_AUTONOMOUS_MERGE") == "0":
        return False
    if environ.get("YUVI_AGENTBUS_AUTONOMOUS_MERGE") == "1":
        return True
    settings = load_settings(ctx)
    auto = settings.get("autonomous_merge") or {}
    return bool(
        auto.get("enabled")
        and auto.get("activated_at")
        and is_chatgpt_conversation_url((settings.get("final_gpt") or {}).get("url"))
    )
