from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import write_mod
from modslib import claude
from modslib.checks import scan_private, validate
from modslib.generate import generate

HOME_PATH = "/ho" + "me/alice/project"
PRIVATE_IP = "10." + "1.2.3"
EMPTY = {"errors": [], "warnings": [], "gatingHooks": []}


def hook(has_catch: bool) -> dict:
    return {
        "module": "./register.ts",
        "pattern": "tool.call",
        "hook": "tool.call{tool=Bash}",
        "hasCatch": has_catch,
    }


def stub_claude(monkeypatch: pytest.MonkeyPatch, report: dict) -> None:
    def fake_run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        text = json.dumps(report) if "validate" in args and "--json" in args else ""
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=text, stderr="")

    monkeypatch.setattr(claude, "run", fake_run)


def test_scan_flags_home_paths_and_private_ips_without_echoing_them(tmp_path: Path) -> None:
    (tmp_path / "notes.md").write_text(f"see {HOME_PATH}\nhost {PRIVATE_IP}\nfine line\n")
    found = scan_private(tmp_path)
    assert len(found) == 2
    assert all("notes.md" in f for f in found)
    assert not any("alice" in f or PRIVATE_IP in f for f in found)


@pytest.mark.parametrize(
    ("line", "hit"),
    [
        ("cd /Us" + "ers/alice/code", True),
        ("ls /ro" + "ot/.ssh", True),
        ("src/ro" + "ot/index.ts and ~/.claude/settings.json and ~/proj/", False),
        ("the /Us" + "ers folder", False),
    ],
)
def test_scan_covers_other_machine_paths_but_not_tilde_or_nested_names(
    tmp_path: Path, line: str, hit: bool
) -> None:
    (tmp_path / "notes.md").write_text(line + "\n")
    assert bool(scan_private(tmp_path)) is hit


@pytest.mark.parametrize("mode", ["git", "walk"])
def test_skip_rules_are_root_anchored_and_identical_in_both_modes(
    mode: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    if mode == "git":
        if shutil.which("git") is None:
            pytest.skip("git is not available")
        subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    else:

        def no_git(*args: object, **kwargs: object) -> None:
            raise FileNotFoundError("git")

        monkeypatch.setattr("modslib.checks.subprocess.run", no_git)
    skipped = ["private-patterns.example.txt", "local/a.md", "node_modules/b.md"]
    flagged = ["docs/private-patterns.txt", "src/local/c.md", "src/node_modules/d.md"]
    for rel in skipped + flagged:
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"see {HOME_PATH}\n")
    assert sorted(f.split(":")[0] for f in scan_private(tmp_path)) == sorted(flagged)


def test_scan_still_reads_a_stray_non_utf8_byte_and_a_symlink_target(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_bytes(b"caf\xe9\nsee " + HOME_PATH.encode() + b"\n")
    (tmp_path / "link").symlink_to(HOME_PATH + "/missing")
    found = sorted(scan_private(tmp_path))
    assert [f.split(": ")[0] for f in found] == ["link:1", "notes.txt:2"]
    assert not any("alice" in f for f in found)


def test_invalid_custom_regex_is_reported_not_raised(tmp_path: Path) -> None:
    (tmp_path / "private-patterns.txt").write_text("# comment\n[\nacme-internal\n")
    (tmp_path / "doc.md").write_text("talks about acme-internal things\n")
    found = scan_private(tmp_path)
    assert len(found) == 2
    bad = next(f for f in found if "private-patterns.txt:2: invalid regex" in f)
    assert "acme-internal" not in bad
    assert any("doc.md:1: matches private pattern line 3" in f for f in found)
    assert not any("acme-internal" in f for f in found)


def test_validate_flags_a_stale_catalog_and_passes_on_zero_mods(tmp_path: Path) -> None:
    generate(tmp_path)
    assert validate(tmp_path, run_claude=False) == []
    write_mod(tmp_path, "alpha")
    generate(tmp_path)
    (tmp_path / "mods.json").write_text("{}\n")
    assert validate(tmp_path, run_claude=False) == ["generated file is stale: mods.json (run scripts/mods generate)"]


def test_guard_gating_hook_without_catch_is_flagged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_mod(tmp_path, "alpha")
    generate(tmp_path)
    contents = [{"file": "hooks/hooks.json", "errors": [], "warnings": [], "gatingHooks": [hook(False)]}]
    stub_claude(monkeypatch, {"success": True, "manifest": EMPTY, "contents": contents})
    assert any("no .catch" in p for p in validate(tmp_path))


def test_guard_with_no_gating_hooks_is_flagged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_mod(tmp_path, "alpha")
    generate(tmp_path)
    stub_claude(monkeypatch, {"success": True, "manifest": EMPTY, "contents": []})
    problems = validate(tmp_path)
    assert len(problems) == 1
    assert "alpha" in problems[0] and "no gating hooks" in problems[0]


def test_strict_failure_reports_content_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_mod(tmp_path, "alpha")
    generate(tmp_path)
    contents = [{"file": "hooks/hooks.json", "errors": ["bad module path"], "warnings": [], "gatingHooks": [hook(True)]}]
    stub_claude(monkeypatch, {"success": False, "manifest": EMPTY, "contents": contents})
    problems = validate(tmp_path)
    assert len(problems) == 1
    assert "alpha" in problems[0] and "hooks/hooks.json" in problems[0]
    assert "bad module path" in problems[0]


@pytest.mark.parametrize("output", ["[]", "3", '"ok"'])
def test_validate_output_that_is_not_an_object_is_a_problem(
    output: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_mod(tmp_path, "alpha")
    generate(tmp_path)

    def fake_run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        text = output if "--json" in args else ""
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=text, stderr="")

    monkeypatch.setattr(claude, "run", fake_run)
    problems = validate(tmp_path)
    assert len(problems) == 1 and "not an object" in problems[0]


@pytest.mark.parametrize("encoding", ["utf-16", "utf-16-le", "utf-32", "utf-32-le", "utf-32-be", "latin-1"])
def test_scan_reads_files_with_nul_bytes(tmp_path: Path, encoding: str) -> None:
    (tmp_path / "doc.txt").write_bytes(f"see {HOME_PATH}\n".encode(encoding) + (b"\0" if encoding == "latin-1" else b""))
    assert [f.split(": ")[0] for f in scan_private(tmp_path)] == ["doc.txt:1"]


@pytest.mark.parametrize(
    ("email", "hit"),
    [
        ("alice@corp" + ".io", True),
        ("me@example.com." + "evil.io", True),
        ("iulian.dita@gmail" + ".com", False),
        ("me@example.com, you@work.example", False),
        ("noreply@users.noreply.github.com", False),
        ("claude-code@2.1.296 and demo@iuliandita-mods", False),
    ],
)
def test_scan_flags_emails_except_the_public_identifier_and_placeholders(
    tmp_path: Path, email: str, hit: bool
) -> None:
    (tmp_path / "notes.md").write_text(f"contact {email}\n")
    assert bool(scan_private(tmp_path)) is hit
