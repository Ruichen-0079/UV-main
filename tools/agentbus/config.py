from __future__ import annotations

import glob
import json
import os
import re
from typing import Any

from agentbus.models import role_label
from agentbus.paths import AgentbusError
from agentbus.util import read_json, run_cmd


# model_reasoning_effort enum. Ultra is NOT a member.
MODEL_REASONING_EFFORTS = ("none", "low", "medium", "high", "xhigh", "max")
GPT56_DOCUMENTED_EFFORTS = MODEL_REASONING_EFFORTS
CODEX_EXECUTION_MODES = ("standard", "ultra")
INVALID_LEGACY_EFFORTS = ("ultra",)
# Back-compat alias used by older tests/imports. Never include ultra.
KNOWN_EFFORTS = MODEL_REASONING_EFFORTS
KNOWN_SANDBOXES = ("read-only", "workspace-write", "danger-full-access")
INHERIT_TOKENS = ("", "-", "inherit")

MODEL_ALIASES = {
    "sol": "gpt-5.6-sol",
    "terra": "gpt-5.6-terra",
    "luna": "gpt-5.6-luna",
    "gpt-5.6-sol": "gpt-5.6-sol",
    "gpt-5.6-terra": "gpt-5.6-terra",
    "gpt-5.6-luna": "gpt-5.6-luna",
    "gpt-5.5": "gpt-5.5",
    "gpt-5.4": "gpt-5.4",
    "gpt-5.4-mini": "gpt-5.4-mini",
}


def codex_home(env: dict[str, str] | None = None) -> str:
    environ = env or os.environ
    return environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")


def read_global_codex(env: dict[str, str] | None = None) -> dict[str, Any]:
    path = os.path.join(codex_home(env), "config.toml")
    info: dict[str, Any] = {
        "path": path,
        "exists": os.path.isfile(path),
        "model": None,
        "effort": None,
        "profiles": [],
    }
    if not info["exists"]:
        return info
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return info
    model = re.search(r'(?m)^model\s*=\s*"([^"]+)"', text)
    effort = re.search(r'(?m)^model_reasoning_effort\s*=\s*"([^"]+)"', text)
    if model:
        info["model"] = model.group(1)
    if effort:
        info["effort"] = effort.group(1)
    info["profiles"] = discover_profiles(env)
    return info


def discover_profiles(env: dict[str, str] | None = None) -> list[str]:
    home = codex_home(env)
    names: set[str] = set()
    for path in glob.glob(os.path.join(home, "*.config.toml")):
        base = os.path.basename(path)
        name = base[: -len(".config.toml")]
        if name and name != "config":
            names.add(name)
    config_path = os.path.join(home, "config.toml")
    if os.path.isfile(config_path):
        try:
            with open(config_path, encoding="utf-8") as handle:
                text = handle.read()
        except OSError:
            text = ""
        for match in re.finditer(r"(?m)^\[profiles\.([^\]]+)\]", text):
            names.add(match.group(1).strip().strip('"'))
    return sorted(names)


def discover_models(env: dict[str, str] | None = None) -> list[dict[str, Any]]:
    cache = os.path.join(codex_home(env), "models_cache.json")
    data = read_json(cache, default={})
    models = data.get("models") if isinstance(data, dict) else None
    found: list[dict[str, Any]] = []
    if isinstance(models, list):
        for item in models:
            if not isinstance(item, dict):
                continue
            slug = item.get("slug")
            if not slug or item.get("visibility") == "hide":
                continue
            catalog_efforts = []
            catalog_ultra = False
            for level in item.get("supported_reasoning_levels") or []:
                effort = level.get("effort") if isinstance(level, dict) else level
                if not effort:
                    continue
                if str(effort).lower() == "ultra":
                    catalog_ultra = True
                    continue
                catalog_efforts.append(str(effort).lower())
            found.append(
                {
                    "slug": slug,
                    "display_name": item.get("display_name") or slug,
                    "efforts": efforts_for_model(str(slug), catalog_efforts),
                    "catalog_lists_ultra": catalog_ultra,
                }
            )
    if not found:
        found = [
            {
                "slug": slug,
                "display_name": slug,
                "efforts": list(GPT56_DOCUMENTED_EFFORTS),
                "catalog_lists_ultra": False,
            }
            for slug in ("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna")
        ]
    return found


def efforts_for_model(slug: str | None, catalog_efforts: list[str] | None = None) -> list[str]:
    cleaned = [item.lower() for item in (catalog_efforts or []) if item and item.lower() != "ultra"]
    if slug and str(slug).startswith("gpt-5.6"):
        ordered: list[str] = []
        for item in GPT56_DOCUMENTED_EFFORTS:
            if item not in ordered:
                ordered.append(item)
        for item in cleaned:
            if item not in ordered:
                ordered.append(item)
        return ordered
    return cleaned


def normalize_model(raw: str, env: dict[str, str] | None = None) -> str:
    value = raw.strip()
    if not value:
        raise AgentbusError("model is empty")
    lowered = value.lower()
    if lowered in MODEL_ALIASES:
        return MODEL_ALIASES[lowered]
    known = {item["slug"] for item in discover_models(env)}
    if value in known or lowered in known:
        return value if value in known else lowered
    return value


class UnsupportedExecutionMode(AgentbusError):
    def __init__(self, message: str = "当前 Codex CLI 不支持 Ultra 执行模式。") -> None:
        super().__init__(message, code="UNSUPPORTED_EXECUTION_MODE")


def normalize_effort(raw: str) -> str:
    value = raw.strip().lower()
    if value in INVALID_LEGACY_EFFORTS:
        raise AgentbusError(
            "ultra is not a model_reasoning_effort value. Ultra is a Codex execution "
            "mode and is unavailable on this CLI.",
            code="INVALID_MODEL_REASONING_EFFORT",
        )
    if value not in MODEL_REASONING_EFFORTS:
        raise AgentbusError(
            f"unknown reasoning effort {raw!r}; expected one of {', '.join(MODEL_REASONING_EFFORTS)}"
        )
    return value


def normalize_execution_mode(raw: str, env: dict[str, str] | None = None) -> str:
    return parse_execution_mode(raw, env)


def parse_execution_mode(raw: str, env: dict[str, str] | None = None) -> str:
    """Refuse Ultra unless local CLI capability discovery exposes an exec mode."""
    value = raw.strip().lower()
    if value in {"", "-", "inherit", "standard", "default"}:
        return "standard"
    if value != "ultra":
        raise AgentbusError(f"unknown Codex execution mode {raw!r}; expected standard or ultra")
    if not ultra_supported(env):
        raise UnsupportedExecutionMode()
    return "ultra"


def migrate_role_config(cfg: dict[str, Any], env: dict[str, str] | None = None) -> dict[str, Any]:
    legacy = dict(cfg.get("legacy") or {})
    if (cfg.get("effort") or "").strip().lower() == "ultra":
        legacy.update(
            {
                "effort": "ultra",
                "invalid_invocation": "model_reasoning_effort=ultra",
                "reason": "ultra is not a valid model_reasoning_effort",
                "normalized": True,
            }
        )
        cfg["effort"] = None
        cfg["effort_warning"] = "legacy effort=ultra cleared; not executed"
    mode = (cfg.get("execution_mode") or "").strip().lower()
    if mode == "ultra" and not ultra_supported(env):
        legacy.update(
            {
                "execution_mode": "ultra",
                "reason": "Ultra is not exposed by the local Codex CLI",
                "normalized": True,
                "invalid_invocation": legacy.get("invalid_invocation") or "execution_mode=ultra",
            }
        )
        cfg["execution_mode"] = None
        cfg["requested_execution_mode"] = None
        cfg["ultra_capability"] = "unavailable"
    elif mode in {"", "inherit", "default"}:
        cfg["execution_mode"] = None
        cfg["requested_execution_mode"] = None
    else:
        cfg["requested_execution_mode"] = mode
    if legacy:
        cfg["legacy"] = legacy
    return cfg


def effort_allowed_for_model(model: str | None, effort: str | None, env: dict[str, str] | None = None) -> bool:
    if not effort:
        return True
    if effort == "ultra":
        return False
    if model and str(model).startswith("gpt-5.6"):
        return effort in GPT56_DOCUMENTED_EFFORTS
    catalog = {item["slug"]: item.get("efforts") or [] for item in discover_models(env)}
    if model and model in catalog and catalog[model]:
        return effort in catalog[model]
    if model and (str(model).startswith("gpt-5.5") or str(model).startswith("gpt-5.4")):
        return effort in {"low", "medium", "high", "xhigh"}
    return effort in MODEL_REASONING_EFFORTS


def normalize_sandbox(raw: str) -> str:
    value = raw.strip().lower()
    if value not in KNOWN_SANDBOXES:
        raise AgentbusError(f"unknown sandbox {raw!r}; expected one of {', '.join(KNOWN_SANDBOXES)}")
    return value


def parse_model_spec(raw: str, env: dict[str, str] | None = None) -> dict[str, str | None]:
    """Accept 'gpt-5.6-terra', 'terra', 'terra:high', 'gpt-5.6-sol:xhigh'."""
    text = raw.strip()
    effort = None
    if ":" in text and not text.startswith("http"):
        model_part, effort_part = text.rsplit(":", 1)
        token = effort_part.strip().lower()
        if token == "ultra":
            raise AgentbusError(
                "ultra is not a model_reasoning_effort value; set Codex execution mode separately"
            )
        if token in MODEL_REASONING_EFFORTS:
            text = model_part
            effort = normalize_effort(effort_part)
    return {"model": normalize_model(text, env), "effort": effort}


def inherited_label(env: dict[str, str] | None = None) -> str:
    info = read_global_codex(env)
    model = info.get("model") or "codex-default"
    effort = info.get("effort")
    return f"{model} {effort}".strip() if effort else str(model)


def effective_role_label(role_cfg: dict[str, Any], env: dict[str, str] | None = None) -> str:
    return role_label(role_cfg, inherited=inherited_label(env))


def effective_role_config(role_cfg: dict[str, Any], env: dict[str, str] | None = None) -> dict[str, Any]:
    cfg = migrate_role_config(dict(role_cfg or {}))
    global_cfg = read_global_codex(env)
    model = cfg.get("model")
    effort = cfg.get("effort")
    profile = cfg.get("profile")
    warning = cfg.get("effort_warning")
    resolved_model = model or global_cfg.get("model")
    resolved_effort = effort or global_cfg.get("effort")
    if resolved_effort and str(resolved_effort).lower() == "ultra":
        resolved_effort = None
        warning = "ignored invalid global model_reasoning_effort=ultra"
    if resolved_effort and not effort_allowed_for_model(resolved_model, resolved_effort, env):
        warning = (
            f"effort {resolved_effort} is not supported for {resolved_model or 'this model'}; "
            "falling back to inherit"
        )
        resolved_effort = None
    capable = ultra_supported(env)
    stored_mode = (cfg.get("execution_mode") or "").strip().lower()
    requested = None if stored_mode in {"", "standard"} else stored_mode
    if requested == "ultra" and not capable:
        requested = None
    effective_mode = "ultra" if requested == "ultra" and capable else "standard"
    invocation = describe_invocation(
        model=model,
        effort=resolved_effort if effort else None,
        profile=profile,
        sandbox=cfg.get("sandbox"),
        execution_mode=effective_mode if capable else "standard",
        env=env,
    )
    return {
        "model": resolved_model,
        "model_source": "stream override" if model else "global default",
        "effort": resolved_effort if effort else (None if warning else (global_cfg.get("effort") if global_cfg.get("effort") != "ultra" else None)),
        "effort_source": "stream override" if effort else "global default",
        "requested_execution_mode": requested,
        "effective_execution_mode": effective_mode,
        "execution_mode": effective_mode,
        "execution_mode_source": "stream override" if stored_mode else "inherit",
        "execution_mode_supported": capable if effective_mode == "ultra" else True,
        "ultra_capability": "available" if capable else "unavailable",
        "profile": profile,
        "profile_source": "stream override" if profile else "inherit",
        "sandbox": cfg.get("sandbox"),
        "label": effective_role_label(cfg, env),
        "applies": "next invocation",
        "invocation": invocation,
        "warning": warning,
        "legacy": cfg.get("legacy"),
    }


def describe_invocation(
    *,
    model: str | None,
    effort: str | None,
    profile: str | None,
    sandbox: str | None,
    execution_mode: str | None,
    env: dict[str, str] | None = None,
) -> list[str]:
    argv: list[str] = ["codex", "exec"]
    if profile:
        argv.extend(["--profile", str(profile)])
    if model:
        argv.extend(["-m", str(model)])
    if effort and effort != "ultra":
        argv.extend(["-c", f"model_reasoning_effort={effort}"])
    if sandbox:
        argv.extend(["-s", str(sandbox)])
    if execution_mode == "ultra" and ultra_supported(env):
        extra = ultra_invocation(env)
        if extra:
            argv.extend(extra)
    return argv


def build_codex_argv(
    *,
    role_cfg: dict[str, Any],
    workdir: str,
    prompt: str,
    last_message_path: str,
    extra: list[str] | None = None,
    env: dict[str, str] | None = None,
) -> list[str]:
    cfg = migrate_role_config(dict(role_cfg or {}))
    argv = ["codex", "exec", "--cd", workdir, "--color", "never", "-o", last_message_path]
    profile = cfg.get("profile")
    if profile:
        argv.extend(["--profile", str(profile)])
    model = cfg.get("model")
    if model:
        argv.extend(["-m", str(model)])
    effort = cfg.get("effort")
    if effort and str(effort).lower() == "ultra":
        effort = None
    if effort and not effort_allowed_for_model(model, effort, env):
        effort = None
    if effort:
        argv.extend(["-c", f"model_reasoning_effort={effort}"])
    sandbox = cfg.get("sandbox")
    if sandbox:
        argv.extend(["-s", str(sandbox)])
    if (cfg.get("execution_mode") or "standard") == "ultra" and ultra_supported(env):
        extra_ultra = ultra_invocation(env)
        if extra_ultra:
            argv.extend(extra_ultra)
    for item in cfg.get("extra_args") or []:
        argv.append(str(item))
    if extra:
        argv.extend(extra)
    argv.append(prompt)
    if any("model_reasoning_effort=ultra" in str(part) for part in argv):
        raise AgentbusError("refusing to emit model_reasoning_effort=ultra")
    return argv


_CAP_CACHE: dict[str, Any] | None = None
_CAP_CACHE_KEY: tuple[str, str] | None = None


def reset_capability_cache() -> None:
    global _CAP_CACHE, _CAP_CACHE_KEY
    _CAP_CACHE = None
    _CAP_CACHE_KEY = None


def _codex_bin(env: dict[str, str] | None = None) -> str:
    environ = env or os.environ
    return environ.get("YUVI_AGENTBUS_CODEX") or "codex"


def discover_codex_version(env: dict[str, str] | None = None) -> str:
    result = run_cmd([_codex_bin(env), "--version"], timeout=8)
    if result.returncode != 0:
        return "unknown"
    return (result.stdout or result.stderr or "unknown").strip().splitlines()[0]


def _exec_help_text(env: dict[str, str] | None = None) -> str:
    result = run_cmd([_codex_bin(env), "exec", "--help"], timeout=8)
    return (result.stdout or "") + "\n" + (result.stderr or "")


def _features_text(env: dict[str, str] | None = None) -> str:
    result = run_cmd([_codex_bin(env), "features", "list"], timeout=8)
    return (result.stdout or "") + "\n" + (result.stderr or "")


def ultra_supported(env: dict[str, str] | None = None) -> bool:
    caps = discover_codex_capabilities(env)
    return bool((caps.get("ultra") or {}).get("exposed_as_exec_mode"))


def ultra_invocation(env: dict[str, str] | None = None) -> list[str]:
    caps = discover_codex_capabilities(env)
    inv = (caps.get("ultra") or {}).get("invocation")
    return list(inv) if inv else []


def discover_codex_capabilities(env: dict[str, str] | None = None) -> dict[str, Any]:
    """Static/CLI introspection only. Never writes ~/.codex/config.toml. Never spends model credits."""
    global _CAP_CACHE, _CAP_CACHE_KEY
    environ = env or os.environ
    cache_key = (
        str(environ.get("YUVI_AGENTBUS_ULTRA_CAPABLE") or ""),
        str(environ.get("YUVI_AGENTBUS_ULTRA_INVOCATION") or ""),
    )
    if _CAP_CACHE is not None and env is None and _CAP_CACHE_KEY == cache_key:
        return _CAP_CACHE
    version = discover_codex_version(env)
    help_text = _exec_help_text(env).lower()
    features = _features_text(env)
    models = discover_models(env)
    catalog_ultra = [item["slug"] for item in models if item.get("catalog_lists_ultra")]
    # Ultra is a higher-level Codex execution/collaboration choice, not model_reasoning_effort.
    # Do not guess invocation syntax. A test fixture may inject capability.
    exposed = False
    invocation: list[str] | None = None
    if environ.get("YUVI_AGENTBUS_ULTRA_CAPABLE") == "1":
        exposed = True
        raw_inv = (environ.get("YUVI_AGENTBUS_ULTRA_INVOCATION") or "--ultra").strip()
        invocation = raw_inv.split()
    elif re.search(r"--ultra\b", help_text):
        exposed = True
        invocation = ["--ultra"]
    elif re.search(r"--execution-mode\b.*ultra|ultra.*--execution-mode\b", help_text):
        exposed = True
        invocation = ["--execution-mode", "ultra"]
    collab_removed = bool(re.search(r"collaboration_modes\s+removed", features, re.I))
    multi_agent = bool(re.search(r"multi_agent\s+stable\s+true", features, re.I))
    ultra = {
        "supported": exposed,
        "exposed_as_exec_mode": exposed,
        "catalog_reasoning_level_models": catalog_ultra,
        "feature_collaboration_modes": "removed" if collab_removed else "unknown",
        "feature_multi_agent": multi_agent,
        "meaning": (
            "Codex Ultra is a higher-level execution choice (maximum reasoning plus "
            "automatic task delegation for eligible users). It is not a GPT-5.6 "
            "model_reasoning_effort value."
        ),
        "invocation": invocation,
        "reason": (
            None
            if exposed
            else (
                "local Codex CLI does not expose an Ultra execution mode for `codex exec`; "
                "catalog may list ultra as a reasoning level, but AgentBus will not emit "
                "model_reasoning_effort=ultra"
            )
        ),
    }
    caps = {
        "version": version,
        "model_reasoning_efforts": list(MODEL_REASONING_EFFORTS),
        "gpt56_efforts": list(GPT56_DOCUMENTED_EFFORTS),
        "execution_modes": ["standard"] + (["ultra"] if exposed else []),
        "ultra": ultra,
        "models": models,
        "writes_global_config": False,
    }
    if env is None:
        _CAP_CACHE = caps
        _CAP_CACHE_KEY = cache_key
    return caps
