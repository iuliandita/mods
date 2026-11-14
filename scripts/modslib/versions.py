from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from modslib.catalog import CatalogError, HOST_VERSION_FILE, load_mods


def _git(root: Path, *args: str) -> str:
    proc = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if proc.returncode:
        raise CatalogError(f"git {' '.join(args[:1])} failed: {proc.stderr.strip() or f'exit status {proc.returncode}'}")
    return proc.stdout.strip()


# Highest version tag in the repo, not the nearest ancestor: release tags sit on merge commits of the
# release branch, which the development branch never reaches.
def _baseline(root: Path) -> str:
    tags = [t for t in _git(root, "tag", "--list", "v[0-9]*").splitlines() if re.fullmatch(r"v\d+\.\d+\.\d+", t)]
    if not tags:
        raise CatalogError("no v<major>.<minor>.<patch> tag found")
    return max(tags, key=lambda t: tuple(map(int, t[1:].split("."))))


def check_versions(root: Path) -> list[str]:
    tag = _baseline(root)
    problems: list[str] = []
    for mod in load_mods(root):
        manifests = ["claude/.claude-plugin/plugin.json", *[HOST_VERSION_FILE[h] for h in mod.hosts]]
        paths = [f"mods/{mod.name}/{h}" for h in ("claude", "codex", "opencode")]
        changed = _git(root, "diff", "--name-only", tag, "--", *paths)
        untracked = _git(root, "ls-files", "--others", "--exclude-standard", "--", *paths)
        if not changed and not untracked:
            continue
        for manifest in manifests:
            rel = f"mods/{mod.name}/{manifest}"
            version = json.loads((root / rel).read_text()).get("version")
            if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
                problems.append(f"{mod.name}: error: invalid plugin version in {manifest}; use a numeric major.minor.patch version")
                continue
            if not _git(root, "ls-tree", tag, "--", rel):
                continue
            try:
                data = json.loads(_git(root, "show", f"{tag}:{rel}"))
            except ValueError as exc:
                raise CatalogError(f"{tag}:{rel} is not valid JSON ({exc})") from exc
            old = data.get("version") if isinstance(data, dict) else None
            if not isinstance(old, str) or not re.fullmatch(r"\d+\.\d+\.\d+", old):
                raise CatalogError(f"invalid version in {tag}:{rel}")
            if tuple(map(int, version.split('.'))) <= tuple(map(int, old.split('.'))):
                problems.append(f"{mod.name}: error: shipped files changed since {tag} but {manifest} version did not increase; bump every host manifest and regenerate")
    return problems
