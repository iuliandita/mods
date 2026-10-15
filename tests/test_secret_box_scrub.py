import base64
import importlib.machinery
import importlib.util
import json
import os
import random
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

import pytest

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "mods/secret-box/claude/bin/secret-box"
SCRUB_TS = ROOT / "mods/secret-box/claude/hooks/scrub.ts"

SAMPLES = [
    "tok_AbC123xyz",
    "pass phrase with \"quotes\" and 'single'",
    "user:p@ss!w0rd*(x)~'#%&=+/?",
    "pässwörd-ü☃",
    "emoji-\U0001f600-token",
    "  padded-secret-value \t\n",
    "dGhpcyBpcyBhIGZha2Uga2V5IHRoYXQgaXMgNDA=",
    "short",
    " nbsp　wide-trim﻿",
]


def load_module():
    loader = importlib.machinery.SourceFileLoader("secret_box", str(BIN))
    spec = importlib.util.spec_from_loader("secret_box", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def run(tmp_path, *args, secrets=None, backend=None):
    store = tmp_path / "store.json"
    if secrets is not None:
        store.write_text(json.dumps(secrets))
    env = dict(os.environ, SECRET_BOX_TEST="1", SECRET_BOX_BACKEND=backend or f"file:{store}")
    return subprocess.run([sys.executable, str(BIN), *args], env=env, capture_output=True)


def test_forms_match_typescript(tmp_path):
    bun = shutil.which("bun")
    if bun is None:
        if os.environ.get("MODS_REQUIRE_BUN") == "1":
            pytest.fail("bun is required (MODS_REQUIRE_BUN=1) but not found")
        pytest.skip("bun not installed")
    (tmp_path / "samples.json").write_text(json.dumps(SAMPLES))
    (tmp_path / "forms.ts").write_text(
        f"import {{ forms }} from {json.dumps(str(SCRUB_TS))}\n"
        "const v: string[] = JSON.parse(await Bun.file(process.argv[2]!).text())\n"
        "console.log(JSON.stringify(Object.fromEntries(v.map((s) => [s, forms(s).sort()]))))\n"
    )
    p = subprocess.run(
        [bun, str(tmp_path / "forms.ts"), str(tmp_path / "samples.json")],
        capture_output=True,
        text=True,
    )
    assert p.returncode == 0, p.stderr
    ts = json.loads(p.stdout)
    sb = load_module()
    for value in SAMPLES:
        assert set(sb.forms(value)) == set(ts[value]), value[:3]


def test_short_value_has_no_forms():
    assert load_module().forms("short") == []


SCRUB_PAIRS = [("alpha", "tok_AbC123xyz"), ("beta", "pässwörd-ü☃"), ("gamma", "user:p@ss w0rd")]
STREAM = (
    b"x tok_AbC123xyz y " + base64.b64encode(b"tok_AbC123xyz") + b" "
    + quote("user:p@ss w0rd").encode() + b" p\xc3\xa4ssw\xc3\xb6rd-\xc3\xbc\xe2\x98\x83 "
    + b"user:p@ss w0rd tok_AbC12 end tok_AbC123xyztok_AbC123xyz"
)


def test_stream_equals_whole_sub_for_every_split_and_random_chunks():
    sb = load_module()
    whole = sb.Scrubber(SCRUB_PAIRS)
    expect = whole.re.sub(lambda m: whole.repl[m.group()], STREAM)
    assert b"tok_AbC123xyz" not in expect and b"{{secret:alpha}}" in expect

    def stream(chunks):
        s = whole.clone()
        return b"".join([s.feed(c) for c in chunks] + [s.flush()])

    for i in range(len(STREAM) + 1):
        assert stream([STREAM[:i], STREAM[i:]]) == expect, i
    rng = random.Random(1)
    for _ in range(200):
        cuts = sorted(rng.sample(range(len(STREAM)), rng.randint(1, 12)))
        parts = [STREAM[a:b] for a, b in zip([0] + cuts, cuts + [len(STREAM)])]
        assert stream(parts) == expect, cuts


def test_shared_form_goes_to_first_name_sorted():
    sb = load_module()
    s = sb.Scrubber([("zeta", "same-value-1"), ("alpha", "same-value-1")])
    assert s.feed(b"same-value-1") + s.flush() == b"{{secret:alpha}}"


VALUE = "tok_AbC/12+xyz=Q"


def exec_scrub(tmp_path, script, secrets=None, **kw):
    return run(tmp_path, "exec", "--scrub", "--", script, secrets={"tok": VALUE} if secrets is None else secrets, **kw)


def test_scrub_stdout_and_stderr_all_forms(tmp_path):
    forms = [VALUE, base64.b64encode(VALUE.encode()).decode(), quote(VALUE, safe="")]
    script = "".join(f"printf 'a %s b\\n' {shlex.quote(f)}; printf '%s\\n' {shlex.quote(f)} >&2\n" for f in forms)
    p = exec_scrub(tmp_path, script)
    assert p.returncode == 0
    for out in (p.stdout, p.stderr):
        assert out.count(b"{{secret:tok}}") == 3 and VALUE.encode() not in out


def test_scrub_value_split_across_writes(tmp_path):
    a, b = VALUE[:7], VALUE[7:]
    script = f"printf %s {a}; sleep 0.3; printf '%s\\n' {shlex.quote(b)}; printf %s {a} >&2; sleep 0.3; printf '%s\\n' {shlex.quote(b)} >&2"
    p = exec_scrub(tmp_path, script)
    assert p.stdout == b"{{secret:tok}}\n" and p.stderr == b"{{secret:tok}}\n"


def test_scrub_passes_exit_code_and_runs_placeholder(tmp_path):
    assert exec_scrub(tmp_path, "exit 7").returncode == 7
    p = exec_scrub(tmp_path, "printf '%s\\n' {{secret:tok}}")
    assert p.stdout == b"{{secret:tok}}\n"


def test_scrub_signal_death_is_128_plus_signal(tmp_path):
    assert exec_scrub(tmp_path, "kill -TERM $$").returncode == 128 + 15


def test_scrub_missing_secret_exits_3(tmp_path):
    marker = tmp_path / "ran"
    p = exec_scrub(tmp_path, f"touch {marker}; echo {{{{secret:nope}}}}")
    assert p.returncode == 3 and not marker.exists()


def test_scrub_fails_closed_when_backend_cannot_load(tmp_path):
    marker = tmp_path / "ran"
    p = run(tmp_path, "exec", "--scrub", "--", f"touch {marker}", backend=f"file:{tmp_path}")
    assert p.returncode == 5 and not marker.exists()
    assert b"(fail closed)" in p.stderr


def test_short_value_is_not_scrubbed(tmp_path):
    p = exec_scrub(tmp_path, "echo abc12", secrets={"tok": "abc12"})
    assert p.stdout == b"abc12\n"


def test_exec_without_scrub_still_works(tmp_path):
    p = run(tmp_path, "exec", "--", "printf '%s\\n' {{secret:tok}}", secrets={"tok": VALUE})
    assert p.returncode == 0 and p.stdout == VALUE.encode() + b"\n"
    assert run(tmp_path, "exec", "--scrub", "x").returncode == 1
