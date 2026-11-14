from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import write_mod
from modslib import generate as generate_module
from modslib.catalog import CatalogError
from modslib.generate import generate
from test_hosts import add_hosts


def test_generate_writes_then_check_is_clean(tmp_path: Path) -> None:
    write_mod(tmp_path, "alpha")
    written = generate(tmp_path)
    assert {p.name for p in written} == {"marketplace.json", "mods.json"}
    assert generate(tmp_path, check=True) == []
    market = json.loads((tmp_path / ".claude-plugin" / "marketplace.json").read_text())
    assert market["plugins"][0]["name"] == "alpha"


def test_check_reports_stale_and_missing_without_writing(tmp_path: Path) -> None:
    write_mod(tmp_path, "alpha")
    assert len(generate(tmp_path, check=True)) == 2
    assert not (tmp_path / "mods.json").exists()
    generate(tmp_path)
    (tmp_path / "mods.json").write_text("{}\n")
    stale = generate(tmp_path, check=True)
    assert [p.name for p in stale] == ["mods.json"]


def test_zero_mods_still_generates_valid_files(tmp_path: Path) -> None:
    generate(tmp_path)
    market = json.loads((tmp_path / ".claude-plugin" / "marketplace.json").read_text())
    catalog = json.loads((tmp_path / "mods.json").read_text())
    assert market["plugins"] == []
    assert catalog["mods"] == []


def test_local_mods_never_reach_tracked_files(tmp_path: Path) -> None:
    write_mod(tmp_path, "pub")
    write_mod(tmp_path, "priv", local=True)
    generate(tmp_path, include_local=True)
    assert "priv" not in (tmp_path / "mods.json").read_text()
    assert "priv" not in (tmp_path / ".claude-plugin" / "marketplace.json").read_text()
    local = json.loads((tmp_path / "local" / ".claude-plugin" / "marketplace.json").read_text())
    assert [p["name"] for p in local["plugins"]] == ["priv"]
    assert local["plugins"][0]["source"] == "./mods/priv/claude"


def test_generate_refuses_a_local_mod_that_shadows_a_public_one(tmp_path: Path) -> None:
    write_mod(tmp_path, "x")
    write_mod(tmp_path, "x", local=True)
    with pytest.raises(CatalogError, match="shadow"):
        generate(tmp_path, include_local=True)
    assert not (tmp_path / "mods.json").exists()
    assert not (tmp_path / ".claude-plugin" / "marketplace.json").exists()
    assert not (tmp_path / "local" / ".claude-plugin" / "marketplace.json").exists()


def test_check_reports_the_skipped_bundle_check_unless_bun_is_required(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_hosts(write_mod(tmp_path, "alpha", hosts=["codex"]), "codex")
    (tmp_path / ".bun-version").write_text("1.4.3\n")
    generate(tmp_path, bundles=False)
    monkeypatch.setattr(generate_module.shutil, "which", lambda name: None)
    monkeypatch.delenv("MODS_REQUIRE_BUN", raising=False)
    skipped: list[str] = []
    assert generate(tmp_path, check=True, skipped=skipped) == []
    assert len(skipped) == 1 and "host bundle check skipped" in skipped[0] and "bun 1.4.3" in skipped[0]
    skipped.clear()
    assert generate(tmp_path, check=True, bundles=False, skipped=skipped) == [] and skipped == []
