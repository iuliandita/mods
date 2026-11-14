from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
REQUIRE_CI = ROOT / ".github" / "scripts" / "require-green-ci.sh"
TYPECHECK_TOOL = ROOT / ".github" / "tools" / "typecheck"
SHA = "0123456789abcdef0123456789abcdef01234567"

# prints response file N on call N, and the last one on every later call
FAKE_GH = r"""#!/bin/sh
n=$(cat "$FAKE_GH_DIR/count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FAKE_GH_DIR/count"
echo "$@" >> "$FAKE_GH_DIR/calls.log"
while [ ! -f "$FAKE_GH_DIR/resp.$n" ] && [ "$n" -gt 1 ]; do n=$((n - 1)); done
cat "$FAKE_GH_DIR/resp.$n"
"""


def _run(status: str, conclusion: str = "none") -> str:
    return f"{status}\t{conclusion}\thttps://example.invalid/run\n"


@pytest.mark.parametrize(
    ("responses", "wait", "code", "calls", "says"),
    [
        ([_run("completed", "success")], "0", 0, 1, "CI succeeded"),
        ([_run("completed", "failure")], "60", 1, 1, "concluded failure"),
        ([_run("completed", "cancelled")], "60", 1, 1, "concluded cancelled"),
        ([_run("completed", "success") + _run("completed", "failure")], "60", 1, 1, "concluded failure"),
        ([""], "0", 1, 1, "no CI run found"),
        ([_run("in_progress")], "0", 1, 1, "still running"),
        (["", _run("queued"), _run("in_progress"), _run("completed", "success")], "60", 0, 4, "CI succeeded"),
        (["", _run("in_progress"), _run("completed", "failure")], "60", 1, 3, "concluded failure"),
    ],
)
def test_release_gate_requires_a_green_ci_run(
    tmp_path: Path, responses: list[str], wait: str, code: int, calls: int, says: str
) -> None:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    gh = bindir / "gh"
    gh.write_text(FAKE_GH)
    gh.chmod(0o755)
    for i, body in enumerate(responses, start=1):
        (tmp_path / f"resp.{i}").write_text(body)
    env = {
        **os.environ,
        "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
        "FAKE_GH_DIR": str(tmp_path),
        "GH_REPO": "owner/repo",
        "CI_WAIT_SECONDS": wait,
        "CI_POLL_SECONDS": "0",
    }
    proc = subprocess.run(["bash", str(REQUIRE_CI), SHA], env=env, capture_output=True, text=True)
    assert proc.returncode == code, proc.stdout + proc.stderr
    assert says in proc.stdout + proc.stderr
    log = (tmp_path / "calls.log").read_text().splitlines()
    assert len(log) == calls
    assert f"head_sha={SHA}" in log[0] and "event=push" in log[0] and "workflows/ci.yml/runs" in log[0]


def test_release_gate_rejects_a_bad_sha(tmp_path: Path) -> None:
    proc = subprocess.run(
        ["bash", str(REQUIRE_CI), "main; echo hi"], env={**os.environ, "GH_REPO": "owner/repo"}, capture_output=True
    )
    assert proc.returncode == 2


@pytest.mark.parametrize(
    ("workflow", "wanted", "unwanted"),
    [
        ("ci.yml", "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true"),
        ("security.yml", "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true"),
        ("ci.yml", "if: matrix.python-version == '3.12'\n        run: bun test mods/*/host", "- run: bun test"),
        ("ci.yml", "pip install --require-hashes -r requirements-dev.txt", "pip install -r requirements-dev.txt"),
        ("stack-sync.yml", 'gh issue close "$number" --comment', None),
        ("release.yml", "actions: read", None),
    ],
)
def test_workflow_text(workflow: str, wanted: str, unwanted: str | None) -> None:
    text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
    assert wanted in text
    assert unwanted is None or unwanted not in text


def test_release_checks_ci_before_publishing() -> None:
    text = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    assert 0 < text.find('require-green-ci.sh "$GITHUB_SHA"') < text.find("gh release create")


def test_dev_requirements_are_hashed() -> None:
    text = (ROOT / "requirements-dev.txt").read_text(encoding="utf-8").replace("\\\n", " ")
    reqs = [line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    assert any(line.startswith("pytest==") for line in reqs)
    assert all("==" in line and "--hash=sha256:" in line for line in reqs), reqs


def test_pytest_is_strict(pytestconfig: pytest.Config) -> None:
    assert "--strict-markers" in pytestconfig.getini("addopts")
    assert pytestconfig.getini("xfail_strict") is True


def test_gitleaks_allowlist_names_no_whole_file() -> None:
    text = (ROOT / ".gitleaks.toml").read_text(encoding="utf-8")
    assert not re.search(r"^\s*paths\s*=", text, flags=re.M)


def test_host_typecheck_installs_from_a_committed_lockfile() -> None:
    manifest = json.loads((TYPECHECK_TOOL / "package.json").read_text(encoding="utf-8"))
    assert set(manifest["devDependencies"]) == {"typescript", "@types/node", "@types/bun"}
    assert all(re.fullmatch(r"\d+\.\d+\.\d+", v) for v in manifest["devDependencies"].values())
    lock = (TYPECHECK_TOOL / "bun.lock").read_text(encoding="utf-8")
    assert all(f'"{name}@{version}"' in lock for name, version in manifest["devDependencies"].items())
    script = (ROOT / "scripts" / "typecheck").read_text(encoding="utf-8")
    assert "bun install --frozen-lockfile" in script and "bun add" not in script


def test_renovate_tracks_the_typecheck_tools_and_the_zizmor_pin() -> None:
    config = json.loads((ROOT / "renovate.json").read_text(encoding="utf-8"))
    assert any(rule.get("matchFileNames") == [".github/tools/typecheck/**"] for rule in config["packageRules"])
    (manager,) = config["customManagers"]
    assert manager["depNameTemplate"] == "zizmorcore/zizmor"
    security = (WORKFLOWS / "security.yml").read_text(encoding="utf-8")
    (pattern,) = manager["matchStrings"]
    found = re.search(pattern.replace("(?<", "(?P<"), security)
    assert found and re.fullmatch(r"\d+\.\d+\.\d+", found["currentValue"])


def _typecheck_clone(tmp_path: Path, tools: list[str]) -> tuple[Path, dict[str, str]]:
    """Copy scripts/typecheck into a bare tree with a PATH holding only the named tools."""
    (tmp_path / "scripts").mkdir()
    shutil.copy(ROOT / "scripts" / "typecheck", tmp_path / "scripts" / "typecheck")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for tool in tools:
        found = shutil.which(tool)
        assert found, tool
        (bindir / tool).symlink_to(found)
    return bindir, {"PATH": str(bindir), "HOME": str(tmp_path)}


def _local_mod(root: Path) -> None:
    plugin = root / "local" / "mods" / "priv" / "claude"
    (plugin / "hooks").mkdir(parents=True)
    (plugin / ".claude-plugin" / "types" / "claude-code").mkdir(parents=True)


def test_typecheck_finds_a_local_mod(tmp_path: Path) -> None:
    bindir, env = _typecheck_clone(tmp_path, ["dirname", "basename", "mktemp", "cat", "rm"])
    _local_mod(tmp_path)
    tsc = bindir / "tsc"
    tsc.write_text("#!/bin/sh\nexit 0\n")
    tsc.chmod(0o755)
    bash = shutil.which("bash")
    assert bash
    proc = subprocess.run([bash, "scripts/typecheck", "priv"], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "typecheck: priv ok" in proc.stdout


@pytest.mark.parametrize(("args", "says"), [(["--hosts"], "needs bun"), (["priv"], "no TypeScript compiler")])
def test_typecheck_exits_3_for_a_missing_tool(tmp_path: Path, args: list[str], says: str) -> None:
    _bindir, env = _typecheck_clone(tmp_path, ["dirname"])
    _local_mod(tmp_path)
    bash = shutil.which("bash")
    assert bash
    proc = subprocess.run([bash, "scripts/typecheck", *args], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert proc.returncode == 3, proc.stderr
    assert says in proc.stderr
