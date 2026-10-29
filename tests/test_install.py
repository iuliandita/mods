from __future__ import annotations

import json
from pathlib import Path
import pytest

from conftest import calls, write_mod
from modslib import claude
from modslib.catalog import load_mods
from modslib.generate import generate
from modslib.install import doctor, install_mods, list_mods, uninstall_mods


def _repo(tmp_path: Path) -> Path:
    write_mod(tmp_path, "alpha")
    write_mod(tmp_path, "beta")
    generate(tmp_path)
    return tmp_path


def test_install_adds_marketplace_then_each_mod(fake_claude: Path, tmp_path: Path) -> None:
    root = _repo(tmp_path)
    code, payload = install_mods(root, ["alpha", "beta"], scope="user", include_local=False, source=None)
    assert code == 0 and payload["ok"] is True
    assert payload["installed"] == ["alpha@iuliandita-mods", "beta@iuliandita-mods"]
    log = calls(fake_claude)
    assert log[0] == "plugin marketplace list --json"
    assert f"plugin marketplace add {root}" in log
    assert "plugin install alpha@iuliandita-mods --scope user --json" in log


def test_unknown_name_lists_known_ones(fake_claude: Path, tmp_path: Path) -> None:
    root = _repo(tmp_path)
    code, payload = install_mods(root, ["nope"], scope="user", include_local=False, source=None)
    assert code == 1 and payload["ok"] is False
    assert "nope" in payload["errors"][0] and "alpha, beta" in payload["errors"][0]
    assert not any("plugin install" in c for c in calls(fake_claude))


def test_stale_generated_files_block_install(fake_claude: Path, tmp_path: Path) -> None:
    root = _repo(tmp_path)
    (root / "mods.json").write_text("{}\n")
    code, payload = install_mods(root, ["alpha"], scope="user", include_local=False, source=None)
    assert code == 1 and "scripts/mods generate" in payload["errors"][0]


def test_uninstall_uses_the_right_marketplace(fake_claude: Path, tmp_path: Path) -> None:
    root = _repo(tmp_path)
    write_mod(root, "secret", local=True)
    code, payload = uninstall_mods(root, ["alpha", "secret"], scope="user")
    assert code == 0
    assert payload["uninstalled"] == ["alpha@iuliandita-mods", "secret@iuliandita-mods-local"]
    assert "installed" not in payload


def test_partial_install_keeps_what_succeeded(
    fake_claude: Path, tmp_path: Path, monkeypatch
) -> None:
    root = _repo(tmp_path)

    def fake(plugin_id: str, scope: str) -> dict:
        if plugin_id.startswith("beta"):
            raise claude.ClaudeError("boom")
        return {"outcome": "ok", "message": "ok"}

    monkeypatch.setattr("modslib.claude.install", fake)
    code, payload = install_mods(root, ["alpha", "beta"], scope="user", include_local=False, source=None)
    assert code == 1 and payload["ok"] is False
    assert payload["installed"] == ["alpha@iuliandita-mods"]
    assert "boom" in payload["errors"][0]


def test_list_and_doctor_survive_a_claude_that_cannot_run(
    fake_claude: Path, tmp_path: Path, monkeypatch
) -> None:
    root = _repo(tmp_path)

    def raiser(*args: object, **kwargs: object) -> None:
        raise PermissionError("nope")

    monkeypatch.setattr("modslib.claude.subprocess.run", raiser)
    code, payload = list_mods(root)
    assert code == 0 and payload["claude"] == {"found": False, "version": None}
    code, payload = doctor(root)
    assert code == 3 and payload["claude"]["found"] is False


@pytest.mark.parametrize("platform,backend", [("linux", "secret-tool"), ("darwin", "security")])
def test_doctor_uses_platform_requirements(tmp_path: Path, monkeypatch, platform, backend) -> None:
    write_mod(tmp_path, "alpha", requires=["python3"], requires_by_platform={"linux": ["secret-tool"], "darwin": ["security"]})
    monkeypatch.setattr("modslib.install.sys.platform", platform)
    monkeypatch.setattr("modslib.install.claude.version", lambda: "1.0.0")
    monkeypatch.setattr("modslib.install.shutil.which", lambda name: "/bin/" + name)
    code, payload = doctor(tmp_path)
    assert code == 0
    assert payload["mods"][0]["requires"] == [{"bin": b, "found": True} for b in ("python3", backend)]
    (mod,) = load_mods(tmp_path)
    assert mod.as_dict()["requires_by_platform"] == {"linux": ["secret-tool"], "darwin": ["security"]}


def test_uninstall_public_mod_ignores_a_broken_local_mod(fake_claude: Path, tmp_path: Path) -> None:
    root = _repo(tmp_path)
    write_mod(root, "alpha", local=True)
    (root / "local" / "mods" / "bad").mkdir()
    code, payload = uninstall_mods(root, ["beta"], scope="user")
    assert code == 0 and payload["uninstalled"] == ["beta@iuliandita-mods"]
    code, payload = uninstall_mods(root, ["gone"], scope="user")
    assert code == 1 and "bad" in payload["errors"][0]


def test_uninstall_resolves_a_name_in_both_sets_to_the_public_mod(
    fake_claude: Path, tmp_path: Path
) -> None:
    root = _repo(tmp_path)
    write_mod(root, "alpha", local=True)
    write_mod(root, "secret", local=True)
    code, payload = uninstall_mods(root, ["alpha", "secret"], scope="user")
    assert code == 0
    assert payload["uninstalled"] == ["alpha@iuliandita-mods", "secret@iuliandita-mods-local"]


def test_list_reports_a_failed_inventory_read_as_an_error(fake_claude: Path, tmp_path: Path) -> None:
    root = _repo(tmp_path)
    (fake_claude / "installed.json").write_text("{}")
    code, payload = list_mods(root)
    assert code == 1 and payload["ok"] is False and "installed plugins" in payload["errors"][0]
    assert {m["installed"] for m in payload["mods"]} == {None}


def test_list_scope_filters_entries_that_carry_a_scope(fake_claude: Path, tmp_path: Path) -> None:
    root = _repo(tmp_path)
    entries = [
        {"id": "alpha@iuliandita-mods", "scope": "project"},
        {"id": "beta@iuliandita-mods", "scope": "user"},
    ]
    (fake_claude / "installed.json").write_text(json.dumps(entries))
    _, payload = list_mods(root, scope="user")
    assert {m["name"]: m["installed"] for m in payload["mods"]} == {"alpha": False, "beta": True}
    _, payload = list_mods(root)
    assert {m["installed"] for m in payload["mods"]} == {True}


def test_uninstall_removes_a_retired_mod_and_lists_the_manual_steps(
    fake_claude: Path, tmp_path: Path
) -> None:
    root = _repo(tmp_path)
    code, payload = uninstall_mods(root, ["prompt-gate", "skill-pick", "alpha"], scope="project")
    assert code == 0
    assert payload["uninstalled"] == [
        "prompt-gate@iuliandita-mods",
        "skill-pick@iuliandita-mods",
        "alpha@iuliandita-mods",
    ]
    assert "plugin uninstall prompt-gate@iuliandita-mods --scope project --json" in calls(fake_claude)
    manual = "\n".join(payload["manual"])
    assert "codex plugin remove skill-pick@iuliandita-mods" in manual
    assert "mods/prompt-gate/opencode" in manual
    assert not any(line.startswith("alpha") for line in payload["manual"])


def test_retired_uninstall_failure_is_reported(fake_claude: Path, tmp_path: Path, monkeypatch) -> None:
    root = _repo(tmp_path)
    monkeypatch.setattr(
        "modslib.claude.uninstall", lambda pid, scope: {"outcome": "error", "message": "not installed"}
    )
    code, payload = uninstall_mods(root, ["prompt-gate"], scope="user")
    assert code == 1 and payload["uninstalled"] == [] and "not installed" in payload["errors"][0]


def test_list_shows_a_retired_mod_only_when_installed(fake_claude: Path, tmp_path: Path) -> None:
    root = _repo(tmp_path)
    _, payload = list_mods(root)
    assert {m["name"] for m in payload["mods"]} == {"alpha", "beta"}
    (fake_claude / "installed.json").write_text(json.dumps([{"id": "skill-pick@iuliandita-mods"}]))
    _, payload = list_mods(root)
    row = next(m for m in payload["mods"] if m["name"] == "skill-pick")
    assert row["kind"] == "retired" and row["installed"] is True
    assert {m["name"] for m in payload["mods"]} == {"alpha", "beta", "skill-pick"}
