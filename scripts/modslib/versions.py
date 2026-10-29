from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from modslib.catalog import CatalogError, HOST_VERSION_FILE, load_mods


def _git(root: Path, *args: str) -> str:
    proc = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if proc.returncode:
        raise CatalogError(f"git {' '.join(args[:1])} failed")
    return proc.stdout.strip()


def check_versions(root: Path) -> list[str]:
    tag = _git(root, "describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", "HEAD")
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
            old = json.loads(_git(root, "show", f"{tag}:{rel}")).get("version")
            if not isinstance(old, str) or not re.fullmatch(r"\d+\.\d+\.\d+", old):
                raise CatalogError(f"invalid version in {tag}:{rel}")
            if tuple(map(int, version.split('.'))) <= tuple(map(int, old.split('.'))):
                problems.append(f"{mod.name}: error: shipped files changed since {tag} but {manifest} version did not increase; bump every host manifest and regenerate")
    return problems
