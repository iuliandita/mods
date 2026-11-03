from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import write_mod
from modslib.catalog import CatalogError
from modslib.versions import check_versions


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


@pytest.fixture
def tagged(tmp_path: Path) -> Path:
    write_mod(tmp_path, "alpha")
    git(tmp_path, "init", "-q")
    git(tmp_path, "add", ".")
    git(tmp_path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial")
    git(tmp_path, "tag", "v0.1.0")
    return tmp_path


@pytest.mark.parametrize("change", ["edit", "add", "delete", "mode", "readme", "new-plugin"])
def test_shipped_changes_require_a_bump(tagged: Path, change: str) -> None:
    source = tagged / "mods/alpha/claude/hooks/register.ts"
    if change == "edit":
        source.write_text("changed\n")
    elif change == "add":
        source.with_name("new.ts").write_text("new\n")
    elif change == "delete":
        source.unlink()
    elif change == "mode":
        source.chmod(0o755)
    elif change == "readme":
        (tagged / "mods/alpha/README.md").write_text("docs\n")
    else:
        write_mod(tagged, "beta")
    problems = check_versions(tagged)
    assert bool(problems) is (change not in ("readme", "new-plugin"))
    if problems:
        assert "version did not increase" in problems[0]


def test_bump_passes_and_latest_tag_resets_baseline(tagged: Path) -> None:
    manifest = tagged / "mods/alpha/claude/.claude-plugin/plugin.json"
    data = json.loads(manifest.read_text())
    data["version"] = "0.1.1"
    manifest.write_text(json.dumps(data))
    assert check_versions(tagged) == []
    git(tagged, "add", ".")
    git(tagged, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "bump")
    git(tagged, "tag", "v0.2.0")
    (manifest.parent.parent / "hooks/register.ts").write_text("changed again\n")
    assert "v0.2.0" in check_versions(tagged)[0]


def test_missing_history_fails(tmp_path: Path) -> None:
    git(tmp_path, "init", "-q")
    with pytest.raises(CatalogError):
        check_versions(tmp_path)
