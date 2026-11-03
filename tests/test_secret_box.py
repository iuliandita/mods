import importlib.machinery
import importlib.util
import json
import os
import re
import shlex
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


def run(tmp_path, *args, secrets=None, stdin=None):
    store = tmp_path / "store.json"
    if secrets is not None:
        store.write_text(json.dumps(secrets))
    env = dict(os.environ, SECRET_BOX_TEST="1", SECRET_BOX_BACKEND=f"file:{store}")
    return subprocess.run(
        [sys.executable, str(BIN), *args], input=stdin, env=env, capture_output=True, text=True
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
    assert printed == "{{secret:tok}}"


@pytest.mark.parametrize("flag", [[], ["--scrub"]])
def test_exec_always_scrubs_its_output(tmp_path, flag):
    value = "s3cr3t-value-xyz"
    script = "printf '%s' {{secret:tok}}; printf '%s' \"$SECRET_BOX_0\" >&2"
    p = run(tmp_path, "exec", *flag, "--", script, secrets={"tok": value})
    assert p.returncode == 0, p.stderr
    assert p.stdout == "{{secret:tok}}" and p.stderr == "{{secret:tok}}"


def test_exec_rejects_other_options(tmp_path):
    p = run(tmp_path, "exec", "--noscrub", "--", "echo hi", secrets={})
    assert p.returncode == 1 and "usage: secret-box exec [--scrub] -- SCRIPT" in p.stderr


def test_scrub_reply_is_raw_utf8_with_lone_surrogates_escaped(tmp_path):
    store = tmp_path / "store.json"
    store.write_text(json.dumps({"tok": "s3cr3t-value-xyz"}))
    env = dict(os.environ, SECRET_BOX_TEST="1", SECRET_BOX_BACKEND=f"file:{store}")
    texts = ["汉字 s3cr3t-value-xyz", "lone \ud800 surrogate"]
    p = subprocess.run(
        [sys.executable, str(BIN), "scrub"], input=json.dumps(texts).encode(), env=env, capture_output=True
    )
    assert p.returncode == 0, p.stderr
    assert "汉字".encode() in p.stdout
    assert b"\\ud800" in p.stdout
    reply = json.loads(p.stdout)
    assert [r["text"] for r in reply["results"]] == ["汉字 {{secret:tok}}", "lone \ud800 surrogate"]
    big = "汉" * 700_000
    p = subprocess.run(
        [sys.executable, str(BIN), "scrub"], input=json.dumps([big]).encode(), env=env, capture_output=True
    )
    assert p.returncode == 0 and len(p.stdout) < 4 * 1024 * 1024 // 1.5


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


def test_removed_values_and_names_json(tmp_path):
    data = {"b": "two-two-two", "a": "one-one-one"}
    v = run(tmp_path, "values", secrets=data)
    assert v.returncode == 2
    assert v.stdout == ""
    assert "one-one-one" not in v.stderr
    n = run(tmp_path, "names", "--json")
    assert json.loads(n.stdout) == ["a", "b"]
    assert "one-one-one" not in n.stdout


def test_parse_names_reads_attribute_lines_from_either_stream():
    sb = load_module()
    out = "[/1]\nlabel = t\nattribute.service = s\nattribute.name = b-two\n\n[/2]\nattribute.name = a-one\n"
    assert sb.parse_names(out) == ["a-one", "b-two"]


@pytest.mark.parametrize("value", ["printable-secret", 'quotes " and \\ and $()', "unicode-\u00fc-\U0001f600\t\n", "deadbeef", ""])
def test_keychain_roundtrip_uses_stdin_and_lists_only_its_prefix(monkeypatch, value):
    sb = load_module()
    store = {}
    seen = []

    def security(argv, *, input=None, capture_output, text):
        assert argv[0] == "/usr/bin/security"
        seen.append((argv, input))
        args = shlex.split(input) if argv[1:] == ["-i"] else argv[1:]
        command = args[0]
        if command == "dump-keychain":
            attrs = [f'    "svce"<blob>="{s}"' for s in [*store, "other-service:private", sb.KeychainBackend.PREFIX + "bad name"]]
            return subprocess.CompletedProcess(argv, 0, "\n".join(attrs), "")
        service = args[args.index("-s") + 1]
        assert args[args.index("-a") + 1] == "api.token"
        if command == "add-generic-password":
            assert "-U" in args
            assert argv == ["/usr/bin/security", "-i"]
            store[service] = args[args.index("-w") + 1]
            return subprocess.CompletedProcess(argv, 0, "", "")
        if command == "find-generic-password":
            assert "-w" in args
            return subprocess.CompletedProcess(argv, 0 if service in store else 44, store.get(service, "") + "\n", "")
        assert command == "delete-generic-password"
        del store[service]
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(sb.subprocess, "run", security)
    backend = sb.KeychainBackend()
    assert backend.get("api.token") is None
    backend.set("api.token", "old-value")
    backend.set("api.token", value)
    assert backend.get("api.token") == value
    assert backend.names() == ["api.token"]
    backend.remove("api.token")
    assert backend.names() == []
    assert all(argv == ["/usr/bin/security", "-i"] for argv, stdin in seen if stdin is not None)


@pytest.mark.parametrize("operation", ["get", "set", "remove", "names"])
def test_keychain_errors_do_not_echo_backend_output(monkeypatch, operation):
    sb = load_module()
    backend = sb.KeychainBackend()
    monkeypatch.setattr(backend, "_run", lambda *a, **kw: subprocess.CompletedProcess([], 36, "private-value", "private-value"))
    args = {"get": ["x"], "set": ["x", "private-value"], "remove": ["x"], "names": []}
    with pytest.raises(sb.SecretBoxError) as error:
        getattr(backend, operation)(*args[operation])
    assert "private-value" not in str(error.value)
    assert "exited 36" in str(error.value)


def test_keychain_rejects_bad_format_and_overlong_input(monkeypatch):
    sb = load_module()
    backend = sb.KeychainBackend()
    monkeypatch.setattr(backend, "_run", lambda *a, **kw: subprocess.CompletedProcess([], 0, "unversioned-value\n", ""))
    with pytest.raises(sb.SecretBoxError, match="invalid format"):
        backend.get("x")
    with pytest.raises(sb.SecretBoxError, match="too long"):
        backend.set("x", "x" * 4096)


@pytest.mark.parametrize("platform,expected", [("linux", "LibsecretBackend"), ("darwin", "KeychainBackend"), ("win32", None)])
def test_backend_platform_selection_and_test_override(monkeypatch, tmp_path, platform, expected):
    sb = load_module()
    monkeypatch.delenv("SECRET_BOX_BACKEND", raising=False)
    monkeypatch.setattr(sb.sys, "platform", platform)
    if expected is None:
        with pytest.raises(sb.SecretBoxError, match="unsupported platform"):
            sb.get_backend()
    else:
        assert type(sb.get_backend()).__name__ == expected
    monkeypatch.setenv("SECRET_BOX_BACKEND", f"file:{tmp_path / 'store.json'}")
    monkeypatch.delenv("SECRET_BOX_TEST", raising=False)
    with pytest.raises(sb.SecretBoxError, match="test-only"):
        sb.get_backend()
    monkeypatch.setenv("SECRET_BOX_TEST", "1")
    assert isinstance(sb.get_backend(), sb.FileBackend)


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


def test_libsecret_scrub_returns_name_metadata_in_order(tmp_path, monkeypatch):
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
    p = subprocess.run([sys.executable, str(BIN), "scrub"], input="[]", capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout) == {"results": [], "names": names, "short": names}


def test_set_refuses_a_non_tty_stdin(tmp_path):
    p = run(tmp_path, "set", "tok")
    assert p.returncode != 0
    assert "set needs a terminal" in p.stderr
    assert not (tmp_path / "store.json").exists()


@pytest.mark.parametrize("command", [
    "secret-box values",
    "echo `secret-box values`",
    "{ secret-box values; }",
    "if secret-box values; then echo leaked; fi",
    "! secret-box values",
    "time secret-box values",
    "timeout 5 secret-box values",
    "nohup secret-box values",
    "env -i HELPER values",
    "xargs secret-box <<< values",
    "</dev/null secret-box values",
    "python3 HELPER values",
    'sh -c -- "secret-box values"',
    "secret-box $'values'",
    'secret-box val"ues"',
    "secret-box 'val'ues",
    '"HELPER" values',
    'bash -c "secret-box values"',
    "secret-box exec -- 'secret-box values'",
    "secret-box exec --scrub -- 'secret-box values'",
])
def test_issue_95_commands_cannot_print_values(tmp_path, command):
    store = tmp_path / "store.json"
    values = {"long": "stored-value-just-added", "short": "xY9"}
    store.write_text(json.dumps(values))
    helper = tmp_path / "secret-box"
    helper.symlink_to(BIN)
    env = dict(os.environ, SECRET_BOX_TEST="1", SECRET_BOX_BACKEND=f"file:{store}",
               PATH=f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    # env -i deliberately clears the backend settings; dispatch still rejects values before access.
    command = command.replace("HELPER", str(helper))
    p = subprocess.run(["bash", "-c", command], env=env, capture_output=True, text=True)
    assert "unknown command" in p.stderr
    assert all(v not in p.stdout + p.stderr for v in values.values())


def test_scrub_protocol_filters_batches_and_rejects_bad_input(tmp_path):
    values = {"a": "new-secret-value", "short": "abc"}
    p = run(tmp_path, "scrub", secrets=values, stdin=json.dumps(["new-secret-value", "plain", "abc"]))
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout) == {
        "results": [{"text": "{{secret:a}}", "names": ["a"]}, {"text": "plain", "names": []},
                    {"text": "abc", "names": []}],
        "names": ["a", "short"], "short": ["short"],
    }
    for stdin in ['{}', '[null]', 'not-json']:
        bad = run(tmp_path, "scrub", stdin=stdin)
        assert bad.returncode == 1 and bad.stdout == ""
        assert "new-secret-value" not in bad.stderr
