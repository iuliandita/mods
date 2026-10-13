from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _ignored(path: str) -> bool:
    if shutil.which("git") is None:
        pytest.skip("git is not available")
    proc = subprocess.run(
        ["git", "check-ignore", "-q", "--no-index", path], cwd=ROOT, capture_output=True
    )
    assert proc.returncode in (0, 1), proc.stderr
    return proc.returncode == 0


def test_root_local_directory_is_ignored() -> None:
    assert _ignored("local/mods/x/mod.json")


def test_nested_local_directory_is_not_ignored() -> None:
    assert not _ignored("mods/x/claude/local/rules.ts")
