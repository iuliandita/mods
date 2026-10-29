from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from conftest import write_mod
from modslib import codex
from modslib.catalog import CatalogError
from modslib.cli import _text_for
from modslib.generate import generate
from modslib.install import doctor, install_mods
from test_hosts import add_hosts


@pytest.mark.parametrize("status,enabled,expected", [("trusted", True, 0), ("modified", True, 1), ("untrusted", True, 1), ("trusted", False, 1)])
def test_doctor_reports_guard_trust_from_an_isolated_snapshot(tmp_path: Path, monkeypatch, status, enabled, expected) -> None:
    home = Path(os.environ["CODEX_HOME"])
    bundle = home / "plugins/cache/iuliandita-mods/guard-rules/0.1.0"
    bundle.mkdir(parents=True)
    (bundle / "test.txt").write_text("original")
    config = home / "config.toml"
    config.write_text('[hooks.state."guard-rules@iuliandita-mods:hooks/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:fixture"\n')
    monkeypatch.setattr("modslib.install.claude.version", lambda: "test")

    def inventory(cwd: Path, snapshot: Path) -> dict:
        assert snapshot != home
        assert (snapshot / "config.toml").read_text() == config.read_text()
        assert (snapshot / "config.toml").stat().st_mode & 0o077 == 0
        (snapshot / "plugins/cache/iuliandita-mods/guard-rules/0.1.0/test.txt").write_text("copy")
        return {"data": [{"hooks": [
            {"pluginId": "guard-rules@iuliandita-mods", "eventName": "preToolUse", "trustStatus": status, "enabled": enabled},
            {"pluginId": "notify@iuliandita-mods", "eventName": "stop", "trustStatus": "untrusted", "enabled": True},
            {"pluginId": "other@elsewhere", "eventName": "stop", "trustStatus": "untrusted", "enabled": True},
        ], "warnings": [], "errors": []}]}

    monkeypatch.setattr(codex, "_list_hooks", inventory)
    write_mod(tmp_path, "alpha")
    code, payload = doctor(tmp_path)
    assert code == expected and payload["ok"] is (expected == 0)
    assert len(payload["codex_hooks"]) == 2
    assert payload["codex_hooks"][0]["status"] == status
    assert f"codex guard-rules preToolUse: {status}" in _text_for(payload)
    assert all("/hooks" in error and "error:" not in error for error in payload["errors"])
    assert (bundle / "test.txt").read_text() == "original"


def test_inventory_failure_is_not_a_clean_doctor_result(tmp_path: Path, monkeypatch) -> None:
    (Path(os.environ["CODEX_HOME"]) / "plugins/cache/iuliandita-mods").mkdir(parents=True)
    monkeypatch.setattr(codex, "_list_hooks", lambda *args: {"data": []})
    with pytest.raises(CatalogError, match="/hooks"):
        codex.hook_trust(tmp_path)


def test_app_server_transport_lists_only_and_ignores_notifications(tmp_path: Path, monkeypatch) -> None:
    binary = tmp_path / "codex"
    binary.write_text('''#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    assert method in ("initialize", "initialized", "hooks/list")
    if "id" in request:
        print(json.dumps({"method": "notice"}), flush=True)
        print(json.dumps({"id": request["id"], "result": {"data": []}}), flush=True)
''')
    binary.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    assert codex._list_hooks(tmp_path, tmp_path) == {"data": []}


def test_install_reminds_codex_users_to_trust_again(fake_claude: Path, tmp_path: Path) -> None:
    mod = write_mod(tmp_path, "alpha", hosts=["codex"])
    add_hosts(mod, "codex")
    generate(tmp_path, bundles=False)
    code, payload = install_mods(tmp_path, ["alpha"], scope="user", include_local=False, source=None)
    assert code == 0 and payload["manual"] == [codex.RETRUST]


def test_doctor_ignores_leftover_trust_state_of_uninstalled_plugins(tmp_path: Path, monkeypatch) -> None:
    home = Path(os.environ["CODEX_HOME"])
    (home / "plugins/cache/iuliandita-mods/guard-rules/0.1.0").mkdir(parents=True)
    (home / "config.toml").write_text(
        '[hooks.state."prompt-gate@iuliandita-mods:hooks/hooks.json:user_prompt_submit:0:0"]\n'
        'trusted_hash = "sha256:stale"\n'
    )
    seen: list[list[str]] = []

    def inventory(cwd: Path, snapshot: Path) -> dict:
        seen.append(sorted(p.name for p in (snapshot / "plugins/cache/iuliandita-mods").iterdir()))
        return {"data": [{"hooks": [
            {"pluginId": "guard-rules@iuliandita-mods", "eventName": "preToolUse", "trustStatus": "trusted", "enabled": True},
        ], "warnings": [], "errors": []}]}

    monkeypatch.setattr(codex, "_list_hooks", inventory)
    rows, errors = codex.hook_trust(tmp_path)
    assert seen == [["guard-rules"]]
    assert [row["mod"] for row in rows] == ["guard-rules"] and errors == []
