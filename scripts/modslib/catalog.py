from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

KINDS = ("guard", "band", "pane", "rewrite", "statusline", "notify")
HOSTS = ("codex", "opencode")
MODES = ("off", "dry", "flag", "on")
SURFACES = ("terminal", "desktop", "vscode", "headless")
SURFACE_STATES = ("verified", "untested", "unsupported")
NAME_RE = re.compile(r"^[a-z][a-z0-9-]*$")
EGRESS_RE = re.compile(r"^(none|anthropic|third-party:[a-z][a-z0-9-]*)$")
REQUIRED = (
    "name", "summary", "kind", "egress", "modes", "default_mode",
    "requires", "surfaces", "verified_on",
)
OPTIONAL = ("shared", "inject", "hosts", "host_files", "requires_by_platform")
SHARED_RE = re.compile(r"^[a-z][a-z0-9-]*\.ts$")
INJECT_RE = re.compile(r"^([a-z][a-z0-9-]*)\.inject\.ts$")
HOST_FILE_RE = re.compile(r"^[a-z][a-z0-9-]*(/[a-z][a-z0-9._-]*)+$")


def inject_markers(file: str) -> tuple[str, str]:
    """Begin and end marker lines (with newline) of a block injected into a mod's register.ts."""
    m = INJECT_RE.match(file)
    assert m, file
    name = m.group(1)
    return (
        f"// @inject {name} begin (generated from shared/{file}; do not edit)\n",
        f"// @inject {name} end\n",
    )


def inject_span(text: str, file: str) -> tuple[int, int] | None:
    """Start and end offsets of the text between a block's markers, or None unless each occurs once, in order."""
    begin, end = inject_markers(file)
    if text.count(begin) != 1 or text.count(end) != 1:
        return None
    start = text.index(begin) + len(begin)
    stop = text.index(end)
    return (start, stop) if stop >= start else None


class CatalogError(Exception):
    """One or more mods are invalid; the message lists every problem."""


class ToolMissing(CatalogError):
    """A tool the command needs is not installed (exit code 3)."""


@dataclass(frozen=True)
class Mod:
    name: str
    summary: str
    kind: str
    egress: tuple[str, ...]
    modes: tuple[str, ...]
    default_mode: str
    requires: tuple[str, ...]
    surfaces: dict[str, str]
    verified_on: str | None
    path: Path
    is_local: bool
    shared: tuple[str, ...] = ()
    inject: tuple[str, ...] = ()
    hosts: tuple[str, ...] = ()
    host_files: tuple[str, ...] = ()
    requires_by_platform: dict[str, list[str]] = field(default_factory=dict)

    @property
    def plugin_dir(self) -> Path:
        return self.path / "claude"

    def host_dir(self, host: str) -> Path:
        return self.path / host

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "summary": self.summary,
            "kind": self.kind,
            "egress": list(self.egress),
            "modes": list(self.modes),
            "default_mode": self.default_mode,
            "requires": list(self.requires),
            **({"requires_by_platform": self.requires_by_platform} if self.requires_by_platform else {}),
            "surfaces": dict(self.surfaces),
            "verified_on": self.verified_on,
            **({"hosts": list(self.hosts)} if self.hosts else {}),
        }


def mods_dir(root: Path, *, local: bool) -> Path:
    return root / "local" / "mods" if local else root / "mods"


def shared_dir(root: Path) -> Path:
    return root / "shared"


def _problems(path: Path, data: object, shared: Path) -> list[str]:
    where = path.name
    if not isinstance(data, dict):
        return [f"{where}: mod.json must be an object"]
    missing = [k for k in REQUIRED if k not in data]
    if missing:
        return [f"{where}: mod.json is missing {', '.join(missing)}"]
    errs: list[str] = []
    unknown = sorted(set(data) - set(REQUIRED) - set(OPTIONAL))
    if unknown:
        errs.append(f"{where}: unknown field(s) {', '.join(unknown)}")
    name = data["name"]
    if not isinstance(name, str) or not NAME_RE.match(name):
        errs.append(f"{where}: name must match {NAME_RE.pattern}")
    elif name != where:
        errs.append(f"{where}: name '{name}' does not match its folder")
    if not isinstance(data["summary"], str) or not data["summary"].strip():
        errs.append(f"{where}: summary must be a non-empty string")
    if data["kind"] not in KINDS:
        errs.append(f"{where}: kind must be one of {', '.join(KINDS)}")
    egress = data["egress"]
    if not (
        isinstance(egress, list)
        and egress
        and all(isinstance(e, str) and EGRESS_RE.match(e) for e in egress)
    ):
        errs.append(f"{where}: egress must list none, anthropic, or third-party:<name>")
    elif "none" in egress and len(egress) > 1:
        errs.append(f"{where}: egress 'none' cannot be combined with other values")
    modes = data["modes"]
    if not (isinstance(modes, list) and modes and all(m in MODES for m in modes)):
        errs.append(f"{where}: modes must be a non-empty subset of {', '.join(MODES)}")
    elif data["default_mode"] not in modes:
        errs.append(f"{where}: default_mode must be one of modes")
    requires = data["requires"]
    if not (isinstance(requires, list) and all(isinstance(r, str) for r in requires)):
        errs.append(f"{where}: requires must be a list of binary names")
    platform_requires = data.get("requires_by_platform", {})
    if not (
        isinstance(platform_requires, dict)
        and all(
            key in ("linux", "darwin")
            and isinstance(bins, list)
            and all(isinstance(b, str) and b and "/" not in b for b in bins)
            for key, bins in platform_requires.items()
        )
    ):
        errs.append(f"{where}: invalid requires_by_platform: expected linux or darwin mapped to lists of binary names; fix mod.json")
    surfaces = data["surfaces"]
    if not (
        isinstance(surfaces, dict)
        and set(surfaces) == set(SURFACES)
        and all(v in SURFACE_STATES for v in surfaces.values())
    ):
        errs.append(
            f"{where}: surfaces must give each of {', '.join(SURFACES)} one of "
            f"{', '.join(SURFACE_STATES)}"
        )
    verified_on = data["verified_on"]
    if verified_on is not None and not isinstance(verified_on, str):
        errs.append(f"{where}: verified_on must be a version string or null")
    elif isinstance(surfaces, dict) and "verified" in surfaces.values() and not verified_on:
        errs.append(f"{where}: verified_on is required when a surface is verified")
    files = data.get("shared", [])
    if not (
        isinstance(files, list)
        and all(isinstance(f, str) and SHARED_RE.match(f) for f in files)
        and len(set(files)) == len(files)
    ):
        errs.append(f"{where}: shared must list distinct file names under shared/ (name.ts)")
    else:
        missing = [f for f in files if not (shared / f).is_file()]
        if missing:
            errs.append(f"{where}: shared file(s) not found in shared/: {', '.join(missing)}")
    blocks = data.get("inject", [])
    if not (
        isinstance(blocks, list)
        and all(isinstance(f, str) and INJECT_RE.match(f) for f in blocks)
        and len(set(blocks)) == len(blocks)
    ):
        errs.append(f"{where}: inject must list distinct file names under shared/ (name.inject.ts)")
    else:
        missing = [f for f in blocks if not (shared / f).is_file()]
        if missing:
            errs.append(f"{where}: inject file(s) not found in shared/: {', '.join(missing)}")
        register = path / "claude" / "hooks" / "register.ts"
        try:
            source = register.read_text()
        except OSError:
            source = ""
        unmarked = [f for f in blocks if inject_span(source, f) is None]
        if unmarked:
            errs.append(
                f"{where}: claude/hooks/register.ts lacks one ordered begin/end marker pair for: "
                + ", ".join(unmarked)
            )
    hosts = data.get("hosts", [])
    if not (
        isinstance(hosts, list)
        and all(h in HOSTS for h in hosts)
        and len(set(hosts)) == len(hosts)
    ):
        errs.append(f"{where}: hosts must list distinct names from {', '.join(HOSTS)}")
    else:
        errs += _host_problems(path, hosts)
    copies = data.get("host_files", [])
    if not (
        isinstance(copies, list)
        and all(isinstance(f, str) and HOST_FILE_RE.match(f) and ".." not in f for f in copies)
        and len(set(copies)) == len(copies)
    ):
        errs.append(f"{where}: host_files must list distinct paths under claude/ (dir/file)")
    else:
        missing = [f for f in copies if not (path / "claude" / f).is_file()]
        if missing:
            errs.append(f"{where}: host_files not found under claude/: {', '.join(missing)}")
        if copies and not data.get("hosts"):
            errs.append(f"{where}: host_files needs hosts")
        owned = {"hooks/hooks.json", "package.json", "server.js", "tui.js", f"bin/{where}.mjs"}
        clash = sorted(set(copies) & owned)
        if clash:
            errs.append(f"{where}: host_files would overwrite a host package file: {', '.join(clash)}")
    return errs


# Files each host package must ship, and the manifest whose version must match the Claude plugin's.
HOST_FILES = {
    "codex": ("host/bin.ts", "codex/.codex-plugin/plugin.json", "codex/hooks/hooks.json"),
    "opencode": ("opencode/package.json",),
}
HOST_VERSION_FILE = {"codex": "codex/.codex-plugin/plugin.json", "opencode": "opencode/package.json"}


def _field(manifest: Path, key: str) -> object:
    try:
        data = json.loads(manifest.read_text())
    except (OSError, ValueError):
        return None
    return data.get(key) if isinstance(data, dict) else None


def _host_problems(path: Path, hosts: list[str]) -> list[str]:
    errs: list[str] = []
    claude_version = _field(path / "claude" / ".claude-plugin" / "plugin.json", "version")
    for host in hosts:
        missing = [f for f in HOST_FILES[host] if not (path / f).is_file()]
        if missing:
            errs.append(f"{path.name}: host {host} lacks {', '.join(missing)}")
            continue
        if host == "opencode" and not any((path / f).is_file() for f in ("host/opencode.ts", "host/tui.ts")):
            errs.append(f"{path.name}: host opencode lacks host/opencode.ts or host/tui.ts")
            continue
        if host == "opencode":
            exports = _field(path / "opencode" / "package.json", "exports")
            have = set(exports) if isinstance(exports, dict) else set()
            want = {k for k, f in (("./server", "host/opencode.ts"), ("./tui", "host/tui.ts")) if (path / f).is_file()}
            if have != want:
                errs.append(f"{path.name}: opencode/package.json exports {sorted(have)} must be {sorted(want)} to match host/")
        manifest = path / HOST_VERSION_FILE[host]
        if _field(manifest, "name") != path.name:
            errs.append(f"{path.name}: {HOST_VERSION_FILE[host]} name must be '{path.name}'")
        if host == "codex" and f"bin/{path.name}.mjs" not in (path / "codex" / "hooks" / "hooks.json").read_text():
            errs.append(f"{path.name}: codex/hooks/hooks.json must run bin/{path.name}.mjs")
        version = _field(manifest, "version")
        if version != claude_version:
            errs.append(f"{path.name}: {HOST_VERSION_FILE[host]} version {version!r} must equal the Claude plugin's {claude_version!r}")
    return errs


def _plugin_problems(path: Path, name: str) -> list[str]:
    manifest = path / "claude" / ".claude-plugin" / "plugin.json"
    if not manifest.is_file():
        return [f"{path.name}: claude/.claude-plugin/plugin.json is missing"]
    try:
        data = json.loads(manifest.read_text())
    except (OSError, ValueError) as exc:
        return [f"{path.name}: plugin.json could not be read ({exc})"]
    if not isinstance(data, dict) or data.get("name") != name:
        found = data.get("name") if isinstance(data, dict) else None
        return [f"{path.name}: plugin.json name '{found}' does not match '{name}'"]
    return []


def parse_mod(path: Path, *, is_local: bool, shared: Path) -> Mod:
    manifest = path / "mod.json"
    if not manifest.is_file():
        raise CatalogError(f"{path.name}: mod.json is missing")
    try:
        data = json.loads(manifest.read_text())
    except (OSError, ValueError) as exc:
        raise CatalogError(f"{path.name}: mod.json could not be read ({exc})") from exc
    errs = _problems(path, data, shared)
    if not errs:
        errs = _plugin_problems(path, data["name"])
    if errs:
        raise CatalogError("\n".join(errs))
    return Mod(
        name=data["name"],
        summary=data["summary"],
        kind=data["kind"],
        egress=tuple(data["egress"]),
        modes=tuple(data["modes"]),
        default_mode=data["default_mode"],
        requires=tuple(data["requires"]),
        requires_by_platform=dict(data.get("requires_by_platform", {})),
        surfaces=dict(data["surfaces"]),
        verified_on=data["verified_on"],
        path=path,
        is_local=is_local,
        shared=tuple(data.get("shared", [])),
        inject=tuple(data.get("inject", [])),
        hosts=tuple(data.get("hosts", [])),
        host_files=tuple(data.get("host_files", [])),
    )


def load_mods(root: Path, *, local: bool = False) -> list[Mod]:
    base = mods_dir(root, local=local)
    if not base.is_dir():
        return []
    mods: list[Mod] = []
    errs: list[str] = []
    for path in sorted(p for p in base.iterdir() if p.is_dir()):
        try:
            mods.append(parse_mod(path, is_local=local, shared=shared_dir(root)))
        except CatalogError as exc:
            errs.append(str(exc))
    if errs:
        raise CatalogError("\n".join(errs))
    return mods


def load_all(root: Path, *, include_local: bool) -> list[Mod]:
    public = load_mods(root)
    if not include_local:
        return public
    private = load_mods(root, local=True)
    clash = sorted({m.name for m in public} & {m.name for m in private})
    if clash:
        raise CatalogError(f"local mod(s) shadow public mod(s): {', '.join(clash)}")
    return sorted(public + private, key=lambda m: m.name)
