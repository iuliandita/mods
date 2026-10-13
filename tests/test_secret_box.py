import importlib.machinery
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

BIN = Path(__file__).resolve().parent.parent / "mods/secret-box/claude/bin/secret-box"


def load_module():
    loader = importlib.machinery.SourceFileLoader("secret_box", str(BIN))
    spec = importlib.util.spec_from_loader("secret_box", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def run(tmp_path, *args, secrets=None):
    store = tmp_path / "store.json"
    if secrets is not None:
        store.write_text(json.dumps(secrets))
    env = dict(os.environ, SECRET_BOX_TEST="1", SECRET_BOX_BACKEND=f"file:{store}")
    return subprocess.run(
        [sys.executable, str(BIN), *args], env=env, capture_output=True, text=True
    )


def test_rewrite_placeholders():
    sb = load_module()
    script, order = sb.rewrite(
        "a {{secret:one}} b {{secret:two.x-y_z}} c {{secret:one}} "
        "{{secret:bad name}} {{secret:}} {{secret:ok"
    )
    assert order == ["one", "two.x-y_z"]
    assert script == (
        "a ${SECRET_BOX_0} b ${SECRET_BOX_1} c ${SECRET_BOX_0} "
        "{{secret:bad name}} {{secret:}} {{secret:ok"
    )


def test_exec_value_in_env_not_argv(tmp_path):
    value = "s3cr3t-value-xyz"
    script = "tr '\\0' ' ' </proc/$$/cmdline; echo; printf '%s\\n' {{secret:tok}}"
    p = run(tmp_path, "exec", "--", script, secrets={"tok": value})
    assert p.returncode == 0, p.stderr
    cmdline, printed = p.stdout.splitlines()
    assert value not in cmdline
    assert "SECRET_BOX_0" in cmdline
    assert printed == value


def test_exec_passes_exit_code(tmp_path):
    p = run(tmp_path, "exec", "--", "exit 7")
    assert p.returncode == 7


def test_exec_missing_secret_exits_3_and_runs_nothing(tmp_path):
    marker = tmp_path / "ran"
    p = run(
        tmp_path, "exec", "--", f"touch {marker}; echo {{{{secret:nope}}}}", secrets={}
    )
    assert p.returncode == 3
    assert "secret-box: secret nope is not set; run `secret-box set nope`" in p.stderr
    assert not marker.exists()


def test_exec_placeholder_in_single_quotes_exits_4_and_runs_nothing(tmp_path):
    marker = tmp_path / "ran"
    p = run(
        tmp_path, "exec", "--", f"touch {marker}; echo '{{{{secret:tok}}}}'", secrets={"tok": "v"}
    )
    assert p.returncode == 4
    assert p.stderr == (
        "secret-box: placeholder {{secret:tok}} is inside single quotes "
        "and would not expand; use double quotes\n"
    )
    assert not marker.exists()
    ok = run(tmp_path, "exec", "--", "echo \"it's {{secret:tok}}\" # don't", secrets={"tok": "v"})
    assert (ok.returncode, ok.stdout) == (0, "it's v\n")


def test_exec_placeholder_in_single_quotes_inside_a_substitution_exits_4(tmp_path):
    marker = tmp_path / "ran"
    p = run(
        tmp_path, "exec", "--", f"touch {marker}; echo \"$(echo '{{{{secret:tok}}}}')\"", secrets={"tok": "v"}
    )
    assert p.returncode == 4
    assert not marker.exists()
    ok = run(tmp_path, "exec", "--", "echo \"$(echo {{secret:tok}})\"", secrets={"tok": "v"})
    assert (ok.returncode, ok.stdout) == (0, "v\n")


def test_values_and_names_json(tmp_path):
    data = {"b": "two-two-two", "a": "one-one-one"}
    v = run(tmp_path, "values", secrets=data)
    assert json.loads(v.stdout) == data
    n = run(tmp_path, "names", "--json")
    assert json.loads(n.stdout) == ["a", "b"]
    assert "one-one-one" not in n.stdout


def test_parse_names_reads_attribute_lines_from_either_stream():
    sb = load_module()
    out = "[/1]\nlabel = t\nattribute.service = s\nattribute.name = b-two\n\n[/2]\nattribute.name = a-one\n"
    assert sb.parse_names(out) == ["a-one", "b-two"]


@pytest.mark.parametrize(
    "code, err, outcome",
    [(1, "", None), (1, "boom", "error"), (2, "", "error")],
)
def test_libsecret_lookup_return_codes(tmp_path, monkeypatch, code, err, outcome):
    exe = tmp_path / "bin" / "secret-tool"
    exe.parent.mkdir()
    exe.write_text(f"#!/bin/sh\nprintf '%s' '{err}' >&2\nexit {code}\n")
    exe.chmod(0o755)
    monkeypatch.setenv("PATH", f"{exe.parent}{os.pathsep}{os.environ['PATH']}")
    sb = load_module()
    if outcome is None:
        assert sb.LibsecretBackend().get("x") is None
    else:
        with pytest.raises(sb.SecretBoxError):
            sb.LibsecretBackend().get("x")


def test_helper_keeps_its_executable_bit():
    assert os.access(BIN, os.X_OK)


def test_min_safe_len_matches_min_len_in_scrub_ts():
    ts = (BIN.parent.parent / "hooks/scrub.ts").read_text()
    py = re.search(r"^MIN_SAFE_LEN = (\d+)$", BIN.read_text(), re.M)
    assert py and int(py[1]) == int(re.search(r"^export const MIN_LEN = (\d+)$", ts, re.M)[1])


def test_libsecret_values_returns_every_name_in_order(tmp_path, monkeypatch):
    names = [f"n{i:02d}" for i in range(20)]
    search = "".join(f"[/{i}]\\nattribute.name = {n}\\n" for i, n in enumerate(names))
    exe = tmp_path / "bin" / "secret-tool"
    exe.parent.mkdir()
    exe.write_text(
        f"#!/bin/sh\nif [ \"$1\" = search ]; then printf '{search}'; exit 0; fi\n"
        'printf "v-%s" "$5"\n'
    )
    exe.chmod(0o755)
    monkeypatch.setenv("PATH", f"{exe.parent}{os.pathsep}{os.environ['PATH']}")
    p = subprocess.run([sys.executable, str(BIN), "values"], capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    assert list(json.loads(p.stdout).items()) == [(n, f"v-{n}") for n in names]


def test_set_refuses_a_non_tty_stdin(tmp_path):
    p = run(tmp_path, "set", "tok")
    assert p.returncode != 0
    assert "set needs a terminal" in p.stderr
    assert not (tmp_path / "store.json").exists()
