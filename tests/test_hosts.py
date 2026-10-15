from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import write_mod
from modslib import generate as generate_module
from modslib.catalog import CatalogError, load_mods
from modslib.generate import build_catalog, build_codex_marketplace, generate


def add_hosts(mod: Path, *hosts: str, version: str = "0.1.0") -> None:
    for host in hosts:
        (mod / "host").mkdir(exist_ok=True)
        if host == "codex":
            (mod / "host" / "bin.ts").write_text("")
            (mod / "codex" / ".codex-plugin").mkdir(parents=True)
            (mod / "codex" / "hooks").mkdir()
            (mod / "codex" / ".codex-plugin" / "plugin.json").write_text(json.dumps({"name": mod.name, "version": version}))
            (mod / "codex" / "hooks" / "hooks.json").write_text(json.dumps({"command": f"node $PLUGIN_ROOT/bin/{mod.name}.mjs"}))
        else:
            (mod / "host" / "opencode.ts").write_text("")
            (mod / "opencode").mkdir()
            (mod / "opencode" / "package.json").write_text(json.dumps({"name": mod.name, "version": version, "exports": {"./server": "./server.js"}}))


def test_a_mod_with_complete_host_packages_loads(tmp_path: Path) -> None:
    add_hosts(write_mod(tmp_path, "alpha", hosts=["codex", "opencode"]), "codex", "opencode")
    (mod,) = load_mods(tmp_path)
    assert mod.hosts == ("codex", "opencode")
    assert mod.as_dict()["hosts"] == ["codex", "opencode"]


@pytest.mark.parametrize(
    ("hosts", "present", "version", "match"),
    [
        (["claude"], (), "0.1.0", "hosts must list distinct names"),
        (["codex", "codex"], (), "0.1.0", "hosts must list distinct names"),
        (["codex"], (), "0.1.0", "host codex lacks"),
        (["opencode"], ("codex",), "0.1.0", "host opencode lacks"),
        (["codex"], ("codex",), "0.2.0", "must equal the Claude plugin's"),
    ],
)
def test_invalid_hosts_are_rejected(tmp_path: Path, hosts: list[str], present: tuple[str, ...], version: str, match: str) -> None:
    add_hosts(write_mod(tmp_path, "alpha", hosts=hosts), *present, version=version)
    with pytest.raises(CatalogError, match=match):
        load_mods(tmp_path)


@pytest.mark.parametrize(("which", "stdout", "match"), [(None, "", "not found"), ("/x/bun", "1.0.0\n", "found 1.0.0")])
def test_bundles_need_the_pinned_bun_to_write_or_when_required(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, which: str | None, stdout: str, match: str
) -> None:
    add_hosts(write_mod(tmp_path, "alpha", hosts=["codex", "opencode"]), "codex", "opencode")
    (tmp_path / ".bun-version").write_text("1.4.3\n")
    monkeypatch.setattr(generate_module.shutil, "which", lambda name: which)
    monkeypatch.setattr(generate_module.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout, ""))
    monkeypatch.delenv("MODS_REQUIRE_BUN", raising=False)
    with pytest.raises(CatalogError, match=match):
        generate(tmp_path)
    generate(tmp_path, bundles=False)
    assert generate(tmp_path, check=True) == []
    monkeypatch.setenv("MODS_REQUIRE_BUN", "1")
    with pytest.raises(CatalogError, match=match):
        generate(tmp_path, check=True)


def test_only_mods_with_a_codex_host_reach_the_codex_marketplace_and_the_catalog(tmp_path: Path) -> None:
    add_hosts(write_mod(tmp_path, "alpha", hosts=["codex", "opencode"]), "codex", "opencode")
    write_mod(tmp_path, "beta")
    mods = load_mods(tmp_path)
    assert [p["name"] for p in build_codex_marketplace(mods)["plugins"]] == ["alpha"]
    by_name = {m["name"]: m for m in build_catalog(mods)["mods"]}
    assert "codex plugin add alpha@iuliandita-mods" in by_name["alpha"]["hosts"]["codex"]["install"]
    assert "opencode" in by_name["alpha"]["hosts"]
    assert "hosts" not in by_name["beta"]


def test_host_files_are_copied_with_their_mode_and_checked(tmp_path: Path) -> None:
    mod = write_mod(tmp_path, "alpha", hosts=["codex", "opencode"], host_files=["bin/tool"])
    add_hosts(mod, "codex", "opencode")
    source = mod / "claude" / "bin" / "tool"
    source.parent.mkdir()
    source.write_text("#!/bin/sh\necho hi\n")
    source.chmod(0o755)
    generate(tmp_path, bundles=False)
    for host in ("codex", "opencode"):
        copy = mod / host / "bin" / "tool"
        assert copy.read_text() == source.read_text()
        assert copy.stat().st_mode & 0o111
    assert generate(tmp_path, check=True, bundles=False) == []
    (mod / "codex" / "bin" / "tool").chmod(0o644)
    assert generate(tmp_path, check=True, bundles=False) == [mod / "codex" / "bin" / "tool"]
    source.write_text("changed\n")
    assert len(generate(tmp_path, check=True, bundles=False)) == 2


@pytest.mark.parametrize(("files", "match"), [(["bin/none"], "not found under claude/"), (["../x/y"], "host_files must list"), (["tool"], "host_files must list")])
def test_invalid_host_files_are_rejected(tmp_path: Path, files: list[str], match: str) -> None:
    add_hosts(write_mod(tmp_path, "alpha", hosts=["codex"], host_files=files), "codex")
    with pytest.raises(CatalogError, match=match):
        load_mods(tmp_path)


def test_host_files_cannot_overwrite_a_host_package_file(tmp_path: Path) -> None:
    mod = write_mod(tmp_path, "alpha", hosts=["codex"], host_files=["hooks/hooks.json"])
    add_hosts(mod, "codex")
    (mod / "claude" / "hooks").mkdir(exist_ok=True)
    (mod / "claude" / "hooks" / "hooks.json").write_text("{}")
    with pytest.raises(CatalogError, match="would overwrite"):
        load_mods(tmp_path)


def test_an_opencode_package_may_ship_only_a_terminal_ui_entry(tmp_path: Path) -> None:
    mod = write_mod(tmp_path, "alpha", hosts=["opencode"])
    add_hosts(mod, "opencode")
    (mod / "host" / "opencode.ts").rename(mod / "host" / "tui.ts")
    with pytest.raises(CatalogError, match="exports"):
        load_mods(tmp_path)
    (mod / "opencode" / "package.json").write_text(json.dumps({"name": "alpha", "version": "0.1.0", "exports": {"./tui": "./tui.js"}}))
    (loaded,) = load_mods(tmp_path)
    assert generate_module.bundle_kinds(loaded) == ["opencode-tui"]
    assert generate_module.bundle_path(loaded, "opencode-tui") == mod / "opencode" / "tui.js"
    assert "cli.json" in generate_module.host_install(loaded)["opencode"]["install"]
    (mod / "host" / "tui.ts").unlink()
    with pytest.raises(CatalogError, match="lacks host/opencode.ts or host/tui.ts"):
        load_mods(tmp_path)
