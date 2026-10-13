from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import write_mod
from modslib.catalog import CatalogError
from modslib.generate import generate


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


def _shared(root: Path, name: str, text: str) -> None:
    (root / "shared").mkdir(exist_ok=True)
    (root / "shared" / name).write_text(text)


def test_generate_copies_listed_shared_files_with_a_header(tmp_path: Path) -> None:
    _shared(tmp_path, "clock.ts", "export const x = 1\n")
    mod = write_mod(tmp_path, "alpha", shared=["clock.ts"])
    generate(tmp_path)
    copy = (mod / "claude" / "hooks" / "shared" / "clock.ts").read_text()
    first, rest = copy.split("\n", 1)
    assert first.startswith("// Generated from shared/clock.ts") and "Do not edit" in first
    assert rest == "export const x = 1\n"
    assert generate(tmp_path, check=True) == []


def test_check_flags_drifted_missing_and_unlisted_shared_copies(tmp_path: Path) -> None:
    _shared(tmp_path, "a.ts", "a\n")
    _shared(tmp_path, "b.ts", "b\n")
    mod = write_mod(tmp_path, "alpha", shared=["a.ts", "b.ts"])
    generate(tmp_path)
    copies = mod / "claude" / "hooks" / "shared"
    (copies / "a.ts").write_text("edited by hand\n")
    (copies / "b.ts").unlink()
    (copies / "old.ts").write_text("// Generated from shared/old.ts by scripts/mods generate.\nold\n")
    stale = generate(tmp_path, check=True)
    assert sorted(p.name for p in stale) == ["a.ts", "b.ts", "old.ts"]
    assert not (copies / "b.ts").exists()
    generate(tmp_path)
    assert sorted(p.name for p in copies.iterdir()) == ["a.ts", "b.ts"]
    assert generate(tmp_path, check=True) == []


def test_generate_never_deletes_an_unlisted_file_without_the_generated_header(tmp_path: Path) -> None:
    mod = write_mod(tmp_path, "alpha")
    generate(tmp_path)
    stray = mod / "claude" / "hooks" / "shared" / "mine.ts"
    stray.parent.mkdir(parents=True, exist_ok=True)
    stray.write_text("hand written\n")
    for check in (True, False):
        with pytest.raises(CatalogError, match="mine.ts"):
            generate(tmp_path, check=check)
    assert stray.read_text() == "hand written\n"


BEGIN = "// @inject blk begin (generated from shared/blk.inject.ts; do not edit)\n"
END = "// @inject blk end\n"


def test_generate_injects_the_block_and_check_flags_drift(tmp_path: Path) -> None:
    _shared(tmp_path, "blk.inject.ts", "const a = 1\n")
    source = f"import x from 'y'\n{BEGIN}old\n{END}export const register = 1\n"
    mod = write_mod(tmp_path, "alpha", inject=["blk.inject.ts"], register_source=source)
    register = mod / "claude" / "hooks" / "register.ts"
    generate(tmp_path)
    assert register.read_text() == f"import x from 'y'\n{BEGIN}const a = 1\n{END}export const register = 1\n"
    assert generate(tmp_path, check=True) == []
    register.write_text(register.read_text().replace("const a = 1", "const a = 2"))
    assert generate(tmp_path, check=True) == [register]
    assert "const a = 2" in register.read_text()
