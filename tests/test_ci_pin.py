from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_ci_claude_code_version_is_pinned() -> None:
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    match = re.search(r'^\s*CLAUDE_CODE_VERSION:\s*"?([^"\s]+)"?\s*$', ci, re.M)
    assert match, "ci.yml has no CLAUDE_CODE_VERSION env entry"
    pinned = match.group(1)
    assert re.fullmatch(r"\d+\.\d+\.\d+", pinned), f"ci.yml must pin an exact claude-code version, got {pinned!r}"
