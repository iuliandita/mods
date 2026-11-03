from __future__ import annotations

from pathlib import Path

import pytest

from conftest import write_mod
from modslib.catalog import CatalogError, load_all, load_mods


def test_loads_a_valid_mod(tmp_path: Path) -> None:
    write_mod(tmp_path, "alpha")
    (mod,) = load_mods(tmp_path)
    assert mod.name == "alpha"
    assert mod.kind == "guard"
    assert mod.default_mode == "on"
    assert mod.plugin_dir == tmp_path / "mods" / "alpha" / "claude"
    assert mod.is_local is False


@pytest.mark.parametrize("requirements", [None, [], {"win32": ["security"]}, {"darwin": "security"}, {"linux": [False]}])
def test_invalid_platform_requirements_are_rejected(tmp_path: Path, requirements) -> None:
    write_mod(tmp_path, "alpha", requires_by_platform=requirements)
    with pytest.raises(CatalogError, match="requires_by_platform"):
        load_mods(tmp_path)


def test_name_must_match_folder_and_plugin_json(tmp_path: Path) -> None:
    write_mod(tmp_path, "alpha", plugin_name="other")
    with pytest.raises(CatalogError, match="plugin.json name 'other'"):
        load_mods(tmp_path)
    folder = tmp_path / "mods" / "beta"
    (tmp_path / "mods" / "alpha").rename(folder)
    with pytest.raises(CatalogError, match="does not match its folder"):
        load_mods(tmp_path)


def test_local_mod_cannot_shadow_a_public_one(tmp_path: Path) -> None:
    write_mod(tmp_path, "alpha")
    write_mod(tmp_path, "alpha", local=True)
    with pytest.raises(CatalogError, match="shadow"):
        load_all(tmp_path, include_local=True)
    assert [m.name for m in load_all(tmp_path, include_local=False)] == ["alpha"]


def test_unreadable_mod_json_is_a_catalog_error(tmp_path: Path) -> None:
    write_mod(tmp_path, "beta")
    broken = write_mod(tmp_path, "alpha")
    (broken / "mod.json").write_bytes(b"\xff\xfe\x00")
    with pytest.raises(CatalogError, match="alpha: mod.json could not be read"):
        load_mods(tmp_path)


@pytest.mark.parametrize(
    ("over", "match"),
    [
        ({"kind": "widget"}, "alpha: kind"),
        ({"egress": ["none", "anthropic"]}, "egress"),
        ({"modes": ["off", "dry"], "default_mode": "on"}, "default_mode"),
        ({"verified_on": None}, "verified_on"),
    ],
)
def test_invalid_fields_are_rejected(tmp_path: Path, over: dict, match: str) -> None:
    write_mod(tmp_path, "alpha", **over)
    with pytest.raises(CatalogError, match=match):
        load_mods(tmp_path)


def test_unknown_shared_file_is_rejected(tmp_path: Path) -> None:
    (tmp_path / "shared").mkdir()
    (tmp_path / "shared" / "clock.ts").write_text("")
    write_mod(tmp_path, "alpha", shared=["clock.ts", "nope.ts"])
    with pytest.raises(CatalogError, match="alpha: shared file.*nope.ts"):
        load_mods(tmp_path)


@pytest.mark.parametrize(
    ("inject", "source", "match"),
    [
        (["blk.inject.ts"], "export const register = 1\n", "lacks one ordered begin/end marker pair for: blk.inject.ts"),
        (["nope.inject.ts"], "", "inject file.*nope.inject.ts"),
        (["blk.ts"], "", "inject must list"),
    ],
)
def test_inject_needs_a_known_template_and_its_markers(
    tmp_path: Path, inject: list[str], source: str, match: str
) -> None:
    (tmp_path / "shared").mkdir()
    (tmp_path / "shared" / "blk.inject.ts").write_text("")
    write_mod(tmp_path, "alpha", inject=inject, register_source=source or None)
    with pytest.raises(CatalogError, match=match):
        load_mods(tmp_path)
