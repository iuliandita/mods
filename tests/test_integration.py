from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from conftest import write_mod
from modslib import claude
from modslib.checks import validate
from modslib.generate import generate
from modslib.install import install_mods, uninstall_mods

pytestmark = pytest.mark.integration

NO_CATCH = (
    "import type { Register } from 'claude-code'\n\n"
    "export const register: Register = on => {\n"
    "  on('tool.call', { tool: 'Bash' }, ($, e, next) => next(e))\n"
    "}\n"
)
WITH_CATCH = (
    "import type { Register } from 'claude-code'\n\n"
    "export const register: Register = on => {\n"
    "  on('tool.call', { tool: 'Bash' }, ($, e, next) => next(e)).catch(($, e, next) =>\n"
    "    next.called ? next(e) : { deny: 'guard failed' },\n"
    "  )\n"
    "}\n"
)


@pytest.fixture(autouse=True)
def real_claude(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    if shutil.which("claude") is None:
        if os.environ.get("MODS_REQUIRE_CLAUDE"):
            pytest.fail("the claude CLI is required but not installed")
        pytest.skip("claude CLI not installed")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cfg"))


def test_install_roundtrip_against_a_throwaway_config(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    write_mod(root, "demo", register_source=WITH_CATCH)
    generate(root)
    code, payload = install_mods(root, ["demo"], scope="user", include_local=False, source=None)
    assert code == 0, payload
    assert "demo@iuliandita-mods" in claude.installed()
    code, payload = uninstall_mods(root, ["demo"], scope="user")
    assert code == 0, payload
    assert claude.installed() == {}


def test_validate_passes_for_a_guard_with_catch(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    write_mod(root, "demo", register_source=WITH_CATCH)
    generate(root)
    assert validate(root) == []


def test_validate_fails_a_guard_without_catch(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    write_mod(root, "demo", register_source=NO_CATCH)
    generate(root)
    problems = validate(root)
    assert any("no .catch" in p for p in problems), problems


def test_validate_fails_a_guard_with_no_gating_hooks(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    write_mod(root, "demo")
    generate(root)
    assert any("no gating hooks" in p for p in validate(root))


def test_validate_does_not_require_catch_for_non_guards(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    write_mod(root, "demo", kind="rewrite", register_source=NO_CATCH)
    generate(root)
    assert validate(root) == []


def test_install_refuses_a_marketplace_added_from_another_folder(tmp_path: Path) -> None:
    old = tmp_path / "old"
    new = tmp_path / "new"
    for r in (old, new):
        write_mod(r, "demo", register_source=WITH_CATCH)
        generate(r)
    code, _ = install_mods(old, ["demo"], scope="user", include_local=False, source=None)
    assert code == 0
    code, payload = install_mods(new, ["demo"], scope="user", include_local=False, source=None)
    assert code == 1 and str(old) in payload["errors"][0]


def test_private_mod_roundtrip_stays_out_of_the_public_catalog(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    write_mod(root, "pub", register_source=WITH_CATCH)
    write_mod(root, "priv", local=True, register_source=WITH_CATCH)
    generate(root)
    code, payload = install_mods(root, ["priv"], scope="user", include_local=True, source=None)
    assert code == 0, payload
    assert "priv@iuliandita-mods-local" in claude.installed()
    where = claude.marketplace_entries()["iuliandita-mods-local"]["path"]
    assert os.path.realpath(where) == os.path.realpath(root / "local")
    for public in (root / ".claude-plugin" / "marketplace.json", root / "mods.json"):
        assert "priv" not in public.read_text()
    code, payload = uninstall_mods(root, ["priv"], scope="user")
    assert code == 0, payload
    assert claude.installed() == {}
