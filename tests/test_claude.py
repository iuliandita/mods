from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from conftest import calls
from modslib import claude


def _known(fake_claude: Path, entry: dict) -> None:
    (fake_claude / "marketplaces.json").write_text(json.dumps([entry]))


def _adds(fake_claude: Path) -> list[str]:
    return [c for c in calls(fake_claude) if c.startswith("plugin marketplace add")]


def test_missing_binary_raises(no_claude: None) -> None:
    with pytest.raises(claude.ClaudeError, match="not on PATH"):
        claude.version()


@pytest.mark.parametrize(
    ("func", "stdout"),
    [
        (claude.marketplace_entries, "not json"),
        (claude.marketplace_entries, json.dumps([{"name": ["x"]}])),
        (claude.installed, json.dumps([{"id": 1}])),
        (claude.installed, json.dumps({"id": "demo@m"})),
        (lambda: claude.install("demo@m", "user"), ""),
        (lambda: claude.uninstall("demo@m", "user"), "banner\n[1]"),
    ],
)
def test_unexpected_output_is_a_claude_error(
    monkeypatch: pytest.MonkeyPatch, func, stdout: str
) -> None:
    def fake(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args=(), returncode=0, stdout=stdout, stderr="")

    monkeypatch.setattr(claude, "run", fake)
    with pytest.raises(claude.ClaudeError, match="unexpected output"):
        func()


def test_ensure_marketplace_adds_an_unknown_one_and_accepts_the_same_source(
    fake_claude: Path, tmp_path: Path
) -> None:
    assert claude.ensure_marketplace("m", str(tmp_path)) is True
    assert len(_adds(fake_claude)) == 1
    _known(fake_claude, {"name": "m", "source": "directory", "path": str(tmp_path)})
    assert claude.ensure_marketplace("m", str(tmp_path)) is False
    assert len(_adds(fake_claude)) == 1


@pytest.mark.parametrize(
    ("entry", "source"),
    [
        ({"name": "m", "source": "git", "url": "git@host:o/r.git"}, "git@host:o/r.git"),
        ({"name": "m", "source": "git", "url": "https://host/o/r.git"}, "https://host/o/r.git"),
        ({"name": "m", "source": "directory", "path": "REL"}, "REL"),
    ],
)
def test_ensure_marketplace_does_not_re_add_a_git_url_or_relative_path(
    fake_claude: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entry: dict, source: str
) -> None:
    if source == "REL":
        monkeypatch.chdir(tmp_path)
        (tmp_path / "clone").mkdir()
        entry["path"], source = str(tmp_path / "clone"), "clone"
    _known(fake_claude, entry)
    assert claude.ensure_marketplace("m", source) is False
    assert not _adds(fake_claude)


@pytest.mark.parametrize(
    ("entry", "source", "shown"),
    [
        ({"name": "m", "source": "github", "repo": "owner/repo"}, "CLONE", "owner/repo"),
        ({"name": "m", "source": "github", "repo": "owner/repo"}, "someone/fork", "owner/repo"),
    ],
)
def test_ensure_marketplace_refuses_a_different_source(
    fake_claude: Path, tmp_path: Path, entry: dict, source: str, shown: str
) -> None:
    _known(fake_claude, entry)
    with pytest.raises(claude.ClaudeError, match=shown) as err:
        claude.ensure_marketplace("m", str(tmp_path) if source == "CLONE" else source)
    assert "claude plugin marketplace remove m" in str(err.value)
    assert not _adds(fake_claude)


@pytest.mark.parametrize(
    ("exc", "match"),
    [
        (PermissionError("nope"), "could not run"),
        (subprocess.TimeoutExpired(cmd="claude", timeout=5), "timed out after 300s"),
    ],
)
def test_run_turns_oserror_and_timeout_into_claude_error(
    fake_claude: Path, monkeypatch: pytest.MonkeyPatch, exc: Exception, match: str
) -> None:
    def raiser(*args: object, **kwargs: object) -> None:
        raise exc

    monkeypatch.setattr("modslib.claude.subprocess.run", raiser)
    with pytest.raises(claude.ClaudeError, match=match):
        claude.version()


@pytest.mark.parametrize("source", ["--scope", "-x/y"])
def test_ensure_marketplace_rejects_a_source_that_looks_like_a_flag(
    fake_claude: Path, source: str
) -> None:
    with pytest.raises(claude.ClaudeError, match="must not start with"):
        claude.ensure_marketplace("m", source)
    assert not calls(fake_claude)
