from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

SURFACE_DEFAULTS = {
    "terminal": "verified",
    "desktop": "untested",
    "vscode": "untested",
    "headless": "untested",
}

DEFAULT_REGISTER = (
    "import type { Register } from 'claude-code'\n\n"
    "export const register: Register = () => {}\n"
)

DEFAULT_TEST = (
    "import { expect, test } from 'claude-code/testing'\n\n"
    "test('loads', () => {\n  expect(1).toBe(1)\n})\n"
)

FAKE_CLAUDE = r"""#!/bin/sh
echo "$@" >> "$FAKE_CLAUDE_DIR/calls.log"
if [ -n "$FAKE_CLAUDE_FAIL" ]; then echo "boom" >&2; exit 1; fi
case "$1 $2 $3" in
  "plugin marketplace list") cat "$FAKE_CLAUDE_DIR/marketplaces.json" ;;
  "plugin marketplace add") echo added ;;
  "plugin list --json") cat "$FAKE_CLAUDE_DIR/installed.json" ;;
  "plugin install "*) printf '{"command":"install","outcome":"ok","pluginId":"%s","scope":"user","message":"ok"}\n' "$3" ;;
  "plugin uninstall "*) printf '{"command":"uninstall","outcome":"ok","pluginId":"%s","scope":"user","message":"ok"}\n' "$3" ;;
  *) echo "2.1.296 (Claude Code)" ;;
esac
"""


def manifest(name: str, **over: object) -> dict:
    base: dict = {
        "name": name,
        "summary": f"{name} test mod",
        "kind": "guard",
        "egress": ["none"],
        "modes": ["off", "on"],
        "default_mode": "on",
        "requires": [],
        "surfaces": dict(SURFACE_DEFAULTS),
        "verified_on": "2.1.296",
    }
    base.update(over)
    return base


def write_mod(
    root: Path,
    name: str,
    *,
    local: bool = False,
    plugin_name: str | None = None,
    register_source: str | None = None,
    **over: object,
) -> Path:
    base = root / "local" / "mods" if local else root / "mods"
    mod = base / name
    plugin = mod / "claude"
    (plugin / ".claude-plugin").mkdir(parents=True)
    (plugin / "hooks").mkdir()
    (mod / "mod.json").write_text(json.dumps(manifest(name, **over), indent=2) + "\n")
    (plugin / ".claude-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": plugin_name or name,
                "version": "0.1.0",
                "description": f"{name} test mod",
                "author": {"name": "iuliandita"},
            },
            indent=2,
        )
        + "\n"
    )
    (plugin / "hooks" / "hooks.json").write_text('{ "modules": ["./register.ts"] }\n')
    (plugin / "hooks" / "register.ts").write_text(register_source or DEFAULT_REGISTER)
    (plugin / "hooks" / "register.test.ts").write_text(DEFAULT_TEST)
    return mod


@pytest.fixture
def fake_claude(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    bindir = tmp_path / "fakebin"
    state = tmp_path / "fakestate"
    bindir.mkdir()
    state.mkdir()
    script = bindir / "claude"
    script.write_text(FAKE_CLAUDE)
    script.chmod(0o755)
    (state / "marketplaces.json").write_text("[]")
    (state / "installed.json").write_text("[]")
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_CLAUDE_DIR", str(state))
    monkeypatch.delenv("FAKE_CLAUDE_FAIL", raising=False)
    return state


@pytest.fixture
def no_claude(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    empty = tmp_path / "emptybin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))


def calls(state: Path) -> list[str]:
    log = state / "calls.log"
    return log.read_text().splitlines() if log.exists() else []
