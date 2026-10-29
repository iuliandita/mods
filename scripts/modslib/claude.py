from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from typing import Any


class ClaudeError(Exception):
    """The claude CLI is missing or a call to it failed."""


class ClaudeMissing(ClaudeError):
    """The claude CLI is not on PATH (exit code 3)."""


def binary() -> str:
    path = shutil.which("claude")
    if path is None:
        raise ClaudeMissing("claude CLI not found: it is not on PATH; install Claude Code and retry")
    return path


def run(*args: str, check: bool = True, timeout: float = 300.0) -> subprocess.CompletedProcess[str]:
    argv = [binary(), *args]
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=timeout
        )
    except subprocess.TimeoutExpired as exc:
        raise ClaudeError(f"claude {' '.join(args)} timed out after {timeout:g}s") from exc
    except (OSError, UnicodeDecodeError) as exc:
        raise ClaudeError(f"claude {' '.join(args)} could not run: {exc}") from exc
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise ClaudeError(f"claude {' '.join(args)} failed ({proc.returncode}): {detail}")
    return proc


def version() -> str:
    return run("--version").stdout.strip()


def _unexpected(args: tuple[str, ...], text: str, why: str) -> ClaudeError:
    return ClaudeError(
        f"claude {' '.join(args)} gave unexpected output ({why}): {text.strip()[:200]!r}"
    )


def _parse(args: tuple[str, ...], text: str, kind: type) -> Any:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        raise _unexpected(args, text, "not JSON") from None
    if not isinstance(value, kind):
        raise _unexpected(args, text, f"expected a JSON {kind.__name__}")
    return value


def _entries(args: tuple[str, ...], text: str, key: str) -> list[dict]:
    data = _parse(args, text if text.strip() else "[]", list)
    if not all(isinstance(entry, dict) and isinstance(entry.get(key), str) and entry[key]
        for entry in data):
        raise _unexpected(args, text, f"every entry needs a non-empty string {key!r} field")
    return data


def marketplace_entries() -> dict[str, dict]:
    args = ("plugin", "marketplace", "list", "--json")
    data = _entries(args, run(*args).stdout, "name")
    return {m["name"]: m for m in data}


_REPO = re.compile(r"[A-Za-z0-9][\w.-]*/[\w.-]+")
_GIT_URL = re.compile(r"[A-Za-z][\w+.-]*://\S+|[\w.-]+@[\w.-]+:\S+")


def _kind(entry: dict) -> tuple[str, str]:
    if isinstance(entry.get("path"), str) and entry["path"]:
        return "directory", entry["path"]
    if entry.get("source") == "github" and isinstance(entry.get("repo"), str) and entry["repo"]:
        return "github", entry["repo"]
    if isinstance(entry.get("url"), str) and entry["url"]:
        return "git", entry["url"]
    return str(entry.get("source") or "unknown"), ""


def ensure_marketplace(name: str, source: str) -> bool:
    if source.startswith("-"):
        raise ClaudeError(f"invalid marketplace source {source!r}: it must not start with '-'")
    entry = marketplace_entries().get(name)
    if entry is None:
        run("plugin", "marketplace", "add", source)
        return True
    kind, found = _kind(entry)
    fix = f"run `claude plugin marketplace remove {name}` and retry"
    if _GIT_URL.fullmatch(source):
        wanted = "git"
        same = kind == "git" and found == source
    elif os.path.isabs(source) or source.startswith(".") or os.path.isdir(source):
        # a relative path is compared by where it points from the current directory
        wanted = "directory"
        same = kind == "directory" and os.path.realpath(found) == os.path.realpath(source)
    elif _REPO.fullmatch(source):
        wanted = "github"
        same = kind == "github" and found == source
    else:
        wanted, same = "", False
    if wanted and found and kind in ("directory", "github", "git"):
        if same:
            return False
        shown = {"github": "github repo", "git": "git url"}.get(kind, "directory") + f" {found}"
        raise ClaudeError(
            f"marketplace '{name}' is already added from {shown}, expected {source}; {fix}"
        )
    shown = f"{kind} source {found}" if found else f"{kind} source"
    raise ClaudeError(
        f"marketplace '{name}' is already added from a {shown} that could not be compared "
        f"with {source}; {fix}"
    )


def installed_entries() -> list[dict]:
    args = ("plugin", "list", "--json")
    return _entries(args, run(*args).stdout, "id")


def installed() -> dict[str, dict]:
    return {p["id"]: p for p in installed_entries()}


def _last_json(args: tuple[str, ...], text: str) -> dict:
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise _unexpected(args, text, "empty output")
    return _parse(args, lines[-1], dict)


def install(plugin_id: str, scope: str) -> dict:
    args = ("plugin", "install", plugin_id, "--scope", scope, "--json")
    return _last_json(args, run(*args).stdout)


def uninstall(plugin_id: str, scope: str) -> dict:
    args = ("plugin", "uninstall", plugin_id, "--scope", scope, "--json")
    # claude exits 1 with a JSON verdict (failureCode) on stdout for a plugin that is not installed
    proc = run(*args, check=False)
    try:
        return _last_json(args, proc.stdout)
    except ClaudeError:
        if proc.returncode == 0:
            raise
        detail = (proc.stderr or proc.stdout).strip()
        raise ClaudeError(f"claude {' '.join(args)} failed ({proc.returncode}): {detail}") from None
