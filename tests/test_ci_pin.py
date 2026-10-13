from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_ci_claude_code_pin_matches_every_verified_on() -> None:
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    match = re.search(r'^\s*CLAUDE_CODE_VERSION:\s*"?([^"\s]+)"?\s*$', ci, re.M)
    assert match, "ci.yml has no CLAUDE_CODE_VERSION env entry"
    pinned = match.group(1)
    seen = {
        path.parent.name: json.loads(path.read_text(encoding="utf-8")).get("verified_on")
        for path in sorted((ROOT / "mods").glob("*/mod.json"))
    }
    wrong = {name: v for name, v in seen.items() if v is not None and v != pinned}
    assert not wrong, f"ci.yml pins claude-code {pinned} but mod.json verified_on differs: {wrong}"
