from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import calls, write_mod
from modslib.cli import main
from modslib.generate import generate


def run(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, str, str]:
    code = main(list(argv))
    out = capsys.readouterr()
    return code, out.out, out.err


def test_json_flag_accepted_before_and_after_the_subcommand(
    fake_claude: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "mods").mkdir()
    root = str(tmp_path)
    for argv in (["--root", root, "list", "--json"], ["list", "--root", root, "--json"], ["--json", "--root", root, "doctor"]):
        code = main(argv)
        out = capsys.readouterr().out
        assert code == 0, argv
        assert out.count("\n") == 1 and json.loads(out)["ok"] is True, argv


def _bad_catalog(root: Path, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    write_mod(root, "alpha", kind="widget")
    return ["--root", str(root), "generate"]


def _oserror(root: Path, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    (root / "mods").mkdir()

    def raiser(*args: object, **kwargs: object) -> None:
        raise PermissionError("read-only")

    monkeypatch.setattr("modslib.cli.generate", raiser)
    return ["--root", str(root), "generate"]


def _usage(root: Path, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    return ["install"]


@pytest.mark.parametrize("setup", [_bad_catalog, _oserror, _usage])
def test_every_failure_is_exit_1_with_one_json_object(
    setup, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = setup(tmp_path, monkeypatch)
    code = main(["--json", *argv])
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert code == 1 and payload["ok"] is False and payload["errors"]
    assert captured.out.count("\n") == 1
    assert "Traceback" not in captured.err


def test_install_passes_scope_and_names(
    fake_claude: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_mod(tmp_path, "alpha")
    run(capsys, "--root", str(tmp_path), "generate")
    code, _, _ = run(capsys, "--root", str(tmp_path), "install", "alpha", "--scope", "project")
    assert code == 0
    assert "plugin install alpha@iuliandita-mods --scope project --json" in calls(fake_claude)


SHAPES = [
    (["list"], False, 0, {"claude", "mods"}),
    (["list"], True, 1, {"claude", "mods"}),
    (["doctor"], False, 0, {"claude", "mods", "notes", "source"}),
    (["doctor"], True, 1, {"claude", "mods", "notes", "source"}),
    (["validate", "--no-claude"], False, 0, {"problems"}),
    (["validate", "--no-claude"], True, 1, {"problems"}),
    (["install", "alpha"], False, 0, {"installed"}),
    (["install", "alpha"], True, 1, {"installed"}),
    (["uninstall", "alpha"], False, 0, {"uninstalled"}),
    (["uninstall", "alpha"], True, 1, {"uninstalled"}),
    (["generate", "--check"], False, 0, {"stale"}),
    (["generate", "--check"], True, 1, set()),
]


@pytest.mark.parametrize(("argv", "broken", "code", "detail"), SHAPES)
def test_every_command_shares_one_json_shape(
    fake_claude: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    argv: list[str],
    broken: bool,
    code: int,
    detail: set[str],
) -> None:
    root = tmp_path / "repo"
    write_mod(root, "alpha")
    generate(root)
    if broken:
        write_mod(root, "bad", kind="widget")
    got, out, _ = run(capsys, "--json", "--root", str(root), *argv)
    payload = json.loads(out)
    assert got == code and set(payload) == {"ok", "errors"} | detail
    assert payload["ok"] is (code == 0)
    assert isinstance(payload["errors"], list) and bool(payload["errors"]) is broken
    if "claude" in payload:
        assert set(payload["claude"]) == {"found", "version"}
        assert isinstance(payload["claude"]["found"], bool)


@pytest.mark.parametrize("argv", [["--js", "list"], ["list", "--js"]])
def test_abbreviated_json_flag_is_a_json_error_not_accepted(
    argv: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    code, out, _ = run(capsys, *argv)
    payload = json.loads(out)
    assert code == 1 and payload["ok"] is False and "--js" in payload["errors"][0]


@pytest.mark.parametrize("command", ["list", "generate"])
@pytest.mark.parametrize("kind", ["empty", "missing"])
def test_root_that_is_not_a_mods_repo_is_rejected_and_left_alone(
    command: str, kind: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = tmp_path / "root"
    if kind == "empty":
        root.mkdir()
    code, out, _ = run(capsys, "--json", "--root", str(root), command)
    payload = json.loads(out)
    assert code == 1 and payload["ok"] is False and "not a mods repo" in payload["errors"][0]
    assert list(root.iterdir()) == [] if kind == "empty" else not root.exists()


def test_local_with_source_is_rejected_before_anything_runs(
    fake_claude: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_mod(tmp_path, "alpha")
    generate(tmp_path)
    code, out, _ = run(
        capsys, "--json", "--root", str(tmp_path), "install", "alpha", "--local", "--source", "o/r"
    )
    payload = json.loads(out)
    assert code == 1 and payload["ok"] is False and "--source" in payload["errors"][0]
    assert calls(fake_claude) == [] and not (tmp_path / "local").exists()


@pytest.mark.parametrize("kind", ["file", "missing"])
def test_an_unusable_root_is_one_json_failure(
    kind: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = tmp_path / "root"
    if kind == "file":
        root.write_text("x")
    code = main(["--json", "--root", str(root), "list"])
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert code == 1 and payload["ok"] is False and payload["errors"]
    assert captured.out.count("\n") == 1 and "Traceback" not in captured.err


@pytest.mark.parametrize(
    "argv",
    [["install", "nope"], ["uninstall", "nope"], ["generate", "--check"]],
)
def test_human_failures_go_to_stderr_with_prefix(
    argv: list[str], fake_claude: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_mod(tmp_path, "alpha")
    code, out, err = run(capsys, "--root", str(tmp_path), *argv)
    assert code == 1 and out == ""
    lines = err.splitlines()
    assert lines and all(line.startswith("error: ") for line in lines), err
