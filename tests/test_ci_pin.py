from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CI_DIR = ROOT / ".github" / "ci" / "claude-code"
PACKAGE = "@anthropic-ai/claude-code"


def test_ci_claude_code_version_is_pinned_and_locked() -> None:
    manifest = json.loads((CI_DIR / "package.json").read_text(encoding="utf-8"))
    pinned = manifest["dependencies"][PACKAGE]
    assert re.fullmatch(r"\d+\.\d+\.\d+", pinned), f"package.json must pin an exact claude-code version, got {pinned!r}"
    lock = json.loads((CI_DIR / "package-lock.json").read_text(encoding="utf-8"))
    assert lock["packages"][""]["dependencies"][PACKAGE] == pinned
    locked = lock["packages"][f"node_modules/{PACKAGE}"]
    assert locked["version"] == pinned and locked["integrity"].startswith("sha512-")
    assert all("integrity" in entry for path, entry in lock["packages"].items() if path)


def test_ci_installs_from_the_lockfile_only() -> None:
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "npm ci --ignore-scripts --prefix .github/ci/claude-code" in ci
    assert "npm install" not in ci and "CLAUDE_CODE_VERSION" not in ci
