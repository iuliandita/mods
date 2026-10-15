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
            (mod / "opencode" / "package.json").write_text(json.dumps({"name": mod.name, "version": version}))


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
