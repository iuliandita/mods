from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from modslib import claude
from modslib.catalog import CatalogError
from modslib.checks import validate
from modslib.generate import generate
from modslib.install import doctor, exit_code, install_mods, list_mods, uninstall_mods

DEFAULT_ROOT = Path(__file__).resolve().parents[2]


class _JsonArgumentParser(argparse.ArgumentParser):
    json_mode = False

    def error(self, message: str) -> None:
        if _JsonArgumentParser.json_mode:
            print(json.dumps({"ok": False, "errors": [message]}))
            sys.exit(2)
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: {message}\n")


EPILOG = """\
Environment:
  MODS_REQUIRE_BUN=1  make generate --check and validate fail when the pinned bun is missing
                      or has another version, instead of skipping the host bundle check
  PATH                where the claude and bun commands are found
  CLAUDE_CONFIG_DIR   read by the claude command that install, uninstall, list, doctor and
                      validate run; it selects the Claude Code config root

Exit codes:
  0  done
  1  failed (generate --check: files are stale; validate: a problem was found)
  2  usage error
  3  a required tool is missing (claude, or the pinned bun)
"""


def _wants_json(argv: list[str]) -> bool:
    flags = argv[: argv.index("--")] if "--" in argv else argv
    return any(len(a) > 2 and "--json".startswith(a) for a in flags)


def _parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", type=Path, default=argparse.SUPPRESS, help="repo root")
    common.add_argument(
        "--json", action="store_true", default=argparse.SUPPRESS, help="machine-readable output"
    )

    p = _JsonArgumentParser(
        prog="mods",
        description="Manage and install Claude Code mods.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    p.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="repo root")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    sub = p.add_subparsers(dest="cmd", required=True, parser_class=_JsonArgumentParser)

    def add(name: str, **kw: object) -> argparse.ArgumentParser:
        return sub.add_parser(
            name,
            parents=[common],
            epilog=EPILOG,
            formatter_class=argparse.RawDescriptionHelpFormatter,
            allow_abbrev=False,
            **kw,
        )

    g = add(
        "generate", help="write marketplace.json, mods.json and the shared-code copies"
    )
    g.add_argument("--check", action="store_true", help="write nothing; exit 1 if stale")
    g.add_argument("--local", action="store_true", help="also write the local marketplace")

    ls = add(
        "list",
        help="list mods and their install state (installed means installed at any scope unless "
        "--scope is given and claude reports a scope)",
    )
    ls.add_argument("--scope", choices=("user", "project", "local"), default=None)

    i = add("install", help="install mods")
    i.add_argument("names", nargs="+")
    i.add_argument("--scope", choices=("user", "project", "local"), default="user")
    i.add_argument("--local", action="store_true", help="include mods from local/ (not with --source)")
    i.add_argument(
        "--source",
        help="marketplace source (owner/repo, git URL or path) instead of this clone; names are still "
        "checked against this clone's catalog (not with --local)",
    )

    u = add("uninstall", help="uninstall mods")
    u.add_argument("names", nargs="+")
    u.add_argument("--scope", choices=("user", "project", "local"), default="user")

    add("doctor", help="check the environment")

    v = add("validate", help="run the CI gates")
    v.add_argument("--no-claude", action="store_true", help="skip checks that need the claude CLI")
    return p


def _emit(args: argparse.Namespace, payload: dict, text: str) -> None:
    if args.json:
        print(json.dumps(payload))
        return
    if text:
        print(text)
    for note in payload.get("notes", []):
        print(f"note: {note}", file=sys.stderr)
    for step in payload.get("manual", []):
        print(f"manual: {step}", file=sys.stderr)
    for err in payload.get("errors", []):
        print(f"error: {err}", file=sys.stderr)


def _text_for(payload: dict) -> str:
    if "notes" in payload:
        c = payload["claude"]
        lines = [f"claude: {c['version'] if c['found'] else 'NOT FOUND'}"]
        for m in payload["mods"]:
            missing = [r["bin"] for r in m["requires"] if not r["found"]]
            lines.append(f"{m['name']}: " + (f"missing {', '.join(missing)}" if missing else "ok"))
        return "\n".join(lines)
    if payload.get("errors"):
        return ""
    if "installed" in payload or "uninstalled" in payload:
        return "\n".join(payload.get("installed") or payload.get("uninstalled") or []) or "nothing to do"
    if "mods" in payload:
        rows = [
            f"{m['name']:<20} {m['kind']:<10} {'local ' if m['local'] else ''}"
            f"{'' if m['installed'] is None else ('installed' if m['installed'] else '-')}  {m['summary']}"
            for m in payload["mods"]
        ]
        return "\n".join(rows) or "no mods"
    return json.dumps(payload)


def _fail(args: argparse.Namespace, msg: str, code: int = 1) -> int:
    if args.json:
        print(json.dumps({"ok": False, "errors": [msg]}))
    else:
        print(f"error: {msg}", file=sys.stderr)
    return code


def _bad_root(root: Path) -> str | None:
    if root.is_dir() and ((root / "mods").is_dir() or (root / "local" / "mods").is_dir()):
        return None
    return f"{root}: not a mods repo: it has no mods/ or local/mods/ directory; pass --root DIR"


def _run(args: argparse.Namespace) -> int:
    root = args.root.resolve()
    if args.cmd == "generate":
        changed = [str(p.relative_to(root)) for p in generate(root, check=args.check, include_local=args.local)]
        if args.check:
            _emit(args, {"ok": not changed,
                         "errors": [f"generated file is stale: {c}; run scripts/mods generate" for c in changed],
                         "stale": changed},
                  "up to date" if not changed else "")
            return 1 if changed else 0
        _emit(args, {"ok": True, "errors": [], "written": changed},
              "wrote: " + (", ".join(changed) or "nothing"))
        return 0
    if args.cmd == "validate":
        problems = validate(root, run_claude=not args.no_claude)
        _emit(args, {"ok": not problems, "errors": problems, "problems": problems},
              "ok" if not problems else "")
        return 1 if problems else 0
    if args.cmd == "list":
        code, payload = list_mods(root, scope=args.scope)
    elif args.cmd == "install":
        code, payload = install_mods(root, args.names, scope=args.scope,
                                     include_local=args.local, source=args.source)
    elif args.cmd == "uninstall":
        code, payload = uninstall_mods(root, args.names, scope=args.scope)
    else:
        code, payload = doctor(root)
    _emit(args, payload, _text_for(payload))
    return code


def main(argv: list[str] | None = None) -> int:
    _JsonArgumentParser.json_mode = _wants_json(argv if argv is not None else sys.argv[1:])
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        if exc.code == 0:
            raise
        return exc.code if isinstance(exc.code, int) else 2
    try:
        bad = _bad_root(args.root.resolve())
        if bad:
            return _fail(args, bad)
        return _run(args)
    except (CatalogError, claude.ClaudeError, OSError, RuntimeError, UnicodeDecodeError) as exc:
        return _fail(args, str(exc), exit_code(exc))
