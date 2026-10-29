from __future__ import annotations

import shutil
import sys
from pathlib import Path

from modslib import claude
from modslib.codex import RETRUST, hook_trust
from modslib.catalog import CatalogError, Mod, ToolMissing, load_all, load_mods
from modslib.generate import (
    GITHUB_SOURCE,
    LOCAL_MARKETPLACE_NAME,
    MARKETPLACE_NAME,
    generate,
)
from modslib.retired import RETIRED

NOTES = (
    "Install from a terminal at user scope. The /plugin command is unavailable in the "
    "Desktop Code tab, but a terminal install loads in Desktop sessions too.",
    "Mods run unsandboxed with your permissions; read a mod and its declared egress "
    "before installing it.",
)


def _marketplace(mod: Mod) -> str:
    return LOCAL_MARKETPLACE_NAME if mod.is_local else MARKETPLACE_NAME


def exit_code(exc: Exception) -> int:
    """3 when a required tool (claude, bun) is missing, otherwise 1."""
    return 3 if isinstance(exc, (claude.ClaudeMissing, ToolMissing)) else 1


def _fail(
    *errors: str,
    done: list[str] | None = None,
    key: str = "installed",
    code: int = 1,
    manual: list[str] | None = None,
) -> tuple[int, dict]:
    payload: dict = {"ok": False, "errors": list(errors), key: list(done or [])}
    if manual:
        payload["manual"] = manual
    return code, payload


def _not_installed(result: dict) -> bool:
    message = str(result.get("message", "")).lower()
    return result.get("failureCode") == "not_installed" or "not installed" in message


def _claude_status() -> dict:
    try:
        return {"found": True, "version": claude.version()}
    except claude.ClaudeError:
        return {"found": False, "version": None}


def install_mods(
    root: Path,
    names: list[str],
    *,
    scope: str,
    include_local: bool,
    source: str | None,
) -> tuple[int, dict]:
    if include_local and source is not None:
        return _fail("--local cannot be combined with --source: local mods always install from this clone; drop one of them")
    done: list[str] = []
    manual: list[str] = []
    try:
        mods = {m.name: m for m in load_all(root, include_local=include_local)}
        unknown = [n for n in names if n not in mods]
        if unknown:
            known = ", ".join(sorted(mods)) or "none"
            return _fail(f"unknown mod(s): {', '.join(unknown)}; known: {known} (see scripts/mods list)")
        if source is None and generate(root, check=True, bundles=False):
            return _fail("generated files are stale: they differ from the sources; run scripts/mods generate")
        if include_local:
            generate(root, include_local=True, bundles=False)
        for name in names:
            mod = mods[name]
            market = _marketplace(mod)
            where = str(root / "local") if mod.is_local else (source or str(root))
            claude.ensure_marketplace(market, where)
            result = claude.install(f"{name}@{market}", scope)
            if result.get("outcome") != "ok":
                return _fail(f"{name}: {result.get('message', 'install failed')}", done=done, manual=manual)
            done.append(f"{name}@{market}")
            if "codex" in mod.hosts and RETRUST not in manual:
                manual.append(RETRUST)
    except (CatalogError, claude.ClaudeError, OSError) as exc:
        return _fail(str(exc), done=done, code=exit_code(exc), manual=manual)
    return 0, {"ok": True, "errors": [], "installed": done, **({"manual": manual} if manual else {})}


def uninstall_mods(root: Path, names: list[str], *, scope: str) -> tuple[int, dict]:
    done: list[str] = []
    skipped: list[str] = []
    manual: list[str] = []
    try:
        mods = {m.name: m for m in load_mods(root)}
        unknown = [n for n in names if n not in mods and n not in RETIRED]
        if unknown:
            for m in load_mods(root, local=True):
                mods.setdefault(m.name, m)
            unknown = [n for n in names if n not in mods and n not in RETIRED]
        if unknown:
            return _fail(f"unknown mod(s): {', '.join(unknown)}; see scripts/mods list", key="uninstalled")
        for name in names:
            if name not in mods:
                manual += [f"{name}: {step}" for step in RETIRED[name].manual_steps()]
    except (CatalogError, OSError) as exc:
        return _fail(str(exc), key="uninstalled", code=exit_code(exc))
    fail = {"done": done, "key": "uninstalled", "manual": manual}
    try:
        for name in names:
            retired = name not in mods
            plugin_id = RETIRED[name].plugin_id if retired else f"{name}@{_marketplace(mods[name])}"
            try:
                result = claude.uninstall(plugin_id, scope)
            except claude.ClaudeMissing:
                if not retired:
                    raise
                skipped.append(f"{name}: claude CLI not found, skipped the Claude uninstall")
                continue
            if result.get("outcome") == "ok":
                done.append(plugin_id)
            elif retired and _not_installed(result):
                skipped.append(f"{name}: not installed in Claude Code, nothing to uninstall there")
            else:
                return _fail(f"{name}: {result.get('message', 'uninstall failed')}", **fail)
    except (claude.ClaudeError, OSError) as exc:
        return _fail(str(exc), code=exit_code(exc), **fail)
    payload: dict = {"ok": True, "errors": [], "uninstalled": done}
    if skipped:
        payload["skipped"] = skipped
    if manual:
        payload["manual"] = manual
    return 0, payload


def list_mods(root: Path, *, scope: str | None = None) -> tuple[int, dict]:
    found = _claude_status()
    try:
        mods = load_all(root, include_local=True)
    except CatalogError as exc:
        return 1, {"ok": False, "errors": [str(exc)], "claude": found, "mods": []}
    present: set[str] | None = None
    errors: list[str] = []
    if found["found"]:
        try:
            # an entry without a scope field cannot be told apart: it counts at any scope
            present = {
                e["id"]
                for e in claude.installed_entries()
                if scope is None or e.get("scope", scope) == scope
            }
        except claude.ClaudeError as exc:
            errors.append(f"could not read the installed plugins: {exc}; run claude plugin list")
    rows = [
        {
            "name": m.name,
            "summary": m.summary,
            "kind": m.kind,
            "egress": list(m.egress),
            "default_mode": m.default_mode,
            "local": m.is_local,
            "installed": None if present is None else f"{m.name}@{_marketplace(m)}" in present,
        }
        for m in mods
    ]
    if present is not None:
        rows += [
            {
                "name": r.name,
                "summary": "retired: no longer in the catalog; uninstall it with scripts/mods uninstall",
                "kind": "retired",
                "egress": [],
                "default_mode": None,
                "local": False,
                "installed": True,
            }
            for r in RETIRED.values()
            if r.plugin_id in present
        ]
    return (1 if errors else 0), {"ok": not errors, "errors": errors, "claude": found, "mods": rows}


def doctor(root: Path) -> tuple[int, dict]:
    found = _claude_status()
    errors = [] if found["found"] else ["claude CLI not found: it is missing or did not run; install Claude Code and retry"]
    try:
        mods = load_all(root, include_local=True)
    except CatalogError as exc:
        errors.append(str(exc))
        mods = []
    rows = [
        {
            "name": m.name,
            "requires": [{"bin": b, "found": shutil.which(b) is not None} for b in (*m.requires, *m.requires_by_platform.get(sys.platform, []))],
        }
        for m in mods
    ]
    codex_hooks: list[dict] = []
    trust_failed = False
    try:
        codex_hooks, trust_errors = hook_trust(root)
        errors += trust_errors
        trust_failed = bool(trust_errors)
    except CatalogError as exc:
        errors.append(str(exc))
        trust_failed = True
    return (0 if not errors else (3 if not found["found"] and not trust_failed else 1)), {
        "ok": not errors,
        "errors": errors,
        "claude": found,
        "mods": rows,
        "codex_hooks": codex_hooks,
        "notes": list(NOTES),
        "source": GITHUB_SOURCE,
    }
