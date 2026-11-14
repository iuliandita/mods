from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import write_mod
from modslib.catalog import CatalogError
from modslib.versions import check_versions
from test_hosts import add_hosts


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


def commit(root: Path, message: str) -> None:
    git(root, "add", ".")
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message)


def set_version(manifest: Path, version: str) -> None:
    data = json.loads(manifest.read_text())
    data["version"] = version
    manifest.write_text(json.dumps(data))


def test_baseline_is_the_highest_tag_even_when_not_an_ancestor(tagged: Path) -> None:
    manifest = tagged / "mods/alpha/claude/.claude-plugin/plugin.json"
    git(tagged, "checkout", "-q", "-b", "release")
    for tag in ("v0.9.0", "v0.10.0"):
        set_version(manifest, tag[1:])
        commit(tagged, tag)
        git(tagged, "tag", tag)
    git(tagged, "checkout", "-q", "-")
    set_version(manifest, "0.9.5")
    problems = check_versions(tagged)
    assert len(problems) == 1 and "since v0.10.0" in problems[0]
    set_version(manifest, "0.10.1")
    assert check_versions(tagged) == []


@pytest.mark.parametrize(
    ("bumped", "outcome"),
    [
        ((), "version did not increase"),
        (("claude/.claude-plugin/plugin.json",), "must equal the Claude plugin's"),
        (("codex/.codex-plugin/plugin.json",), "must equal the Claude plugin's"),
        (("claude/.claude-plugin/plugin.json", "codex/.codex-plugin/plugin.json"), "must equal the Claude plugin's"),
        (("claude/.claude-plugin/plugin.json", "codex/.codex-plugin/plugin.json", "opencode/package.json"), None),
    ],
)
def test_a_changed_mod_with_hosts_needs_every_manifest_bumped(tmp_path: Path, bumped: tuple[str, ...], outcome: str | None) -> None:
    mod = write_mod(tmp_path, "alpha", hosts=["codex", "opencode"])
    add_hosts(mod, "codex", "opencode")
    git(tmp_path, "init", "-q")
    commit(tmp_path, "initial")
    git(tmp_path, "tag", "v0.1.0")
    (mod / "codex/hooks/extra.json").write_text("{}\n")
    for manifest in bumped:
        set_version(mod / manifest, "0.1.1")
    if outcome is None:
        assert check_versions(tmp_path) == []
    elif bumped:
        with pytest.raises(CatalogError, match=outcome):
            check_versions(tmp_path)
    else:
        problems = check_versions(tmp_path)
        assert len(problems) == 3 and all(outcome in p for p in problems)


def test_git_failure_reports_stderr(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LC_ALL", "C")
    with pytest.raises(CatalogError, match="not a git repository"):
        check_versions(tmp_path)


@pytest.mark.parametrize("content", ["not json\n", "[]\n"])
def test_unreadable_manifest_in_the_tag_is_a_clean_error(tagged: Path, content: str) -> None:
    manifest = tagged / "mods/alpha/claude/.claude-plugin/plugin.json"
    good = manifest.read_text()
    manifest.write_text(content)
    commit(tagged, "broken manifest")
    git(tagged, "tag", "v0.2.0")
    manifest.write_text(good)
    with pytest.raises(CatalogError, match="v0.2.0:mods/alpha/claude/.claude-plugin/plugin.json"):
        check_versions(tagged)
