from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _ignored(path: str) -> bool:
    if shutil.which("git") is None:
        pytest.skip("git is not available")
    proc = subprocess.run(
        ["git", "-c", f"core.excludesFile={os.devnull}", "check-ignore", "-q", "--no-index", path],
        cwd=ROOT,
        capture_output=True,
    )
    assert proc.returncode in (0, 1), proc.stderr
    return proc.returncode == 0


def test_root_local_directory_is_ignored() -> None:
    assert _ignored("local/mods/x/mod.json")


def test_nested_local_directory_is_not_ignored() -> None:
    assert not _ignored("mods/x/claude/local/rules.ts")


def test_ignore_checks_skip_the_global_excludes_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    excludes = tmp_path / "excludes"
    excludes.write_text("local/\n")
    config = tmp_path / "gitconfig"
    config.write_text(f"[core]\n\texcludesFile = {excludes}\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(config))
    assert not _ignored("mods/x/claude/local/rules.ts")


def test_git_reads_no_global_or_system_config() -> None:
    assert os.environ["GIT_CONFIG_GLOBAL"] == os.devnull
    assert os.environ["GIT_CONFIG_SYSTEM"] == os.devnull
