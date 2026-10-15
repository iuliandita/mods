from __future__ import annotations

import codecs
import json
import os
import re
import subprocess
from pathlib import Path

from modslib import claude
from modslib.catalog import CatalogError, Mod, load_all
from modslib.generate import generate

BUILTIN_PATTERNS = (
    r"/home/[a-z][a-z0-9_-]*/",
    r"\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b",
    r"(?<![\w./-])/Users/\w[\w.-]*/",
    r"(?<![\w./-])/ro[o]t/",
    # any email except the public identifier and placeholders (example.com/org/net, *.example)
    r"(?<![\w.%+-])(?!(?:iulian\.dita@gmail\.com|noreply@users\.noreply\.github\.com"
    r"|[\w.%+-]+@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|example))(?![\w-]|\.\w))"
    r"[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b",
)
SKIP_NAMES = {"private-patterns.txt", "private-patterns.example.txt"}
SKIP_DIRS = {".git", "local", "node_modules", "__pycache__", ".pytest_cache", ".venv"}


def _files(root: Path) -> list[Path]:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            capture_output=True,
            check=True,
        ).stdout.decode()
        return [root / p for p in out.split("\0") if p]
    except (OSError, subprocess.CalledProcessError):
        return [p for p in root.rglob("*") if p.is_symlink() or p.is_file()]


def _skipped(rel: Path) -> bool:
    return rel.parts[0] in SKIP_DIRS or (len(rel.parts) == 1 and rel.name in SKIP_NAMES)


def _texts(data: bytes) -> list[str]:
    if b"\0" not in data:
        return [data.decode("utf-8", errors="replace")]
    for bom, codec in ((codecs.BOM_UTF32_LE, "utf-32"), (codecs.BOM_UTF32_BE, "utf-32"),
                       (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16")):
        if data.startswith(bom):
            return [data.decode(codec, errors="replace")]
    texts = []
    for codec in ("utf-32-le", "utf-32-be", "utf-16-le", "utf-16-be"):
        try:
            texts.append(data.decode(codec))
        except UnicodeDecodeError:
            pass
    return texts + [data.decode("latin-1")]


def scan_private(root: Path) -> list[str]:
    compiled = [(f"built-in pattern {p}", re.compile(p)) for p in BUILTIN_PATTERNS]
    problems: list[str] = []
    extra = root / "private-patterns.txt"
    if extra.is_file():
        for number, line in enumerate(extra.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            try:
                compiled.append((f"private pattern line {number}", re.compile(line.strip())))
            except re.error:
                problems.append(f"private-patterns.txt:{number}: invalid regex")
    for path in sorted(_files(root)):
        rel = path.relative_to(root)
        if _skipped(rel):
            continue
        try:
            if path.is_symlink():
                texts = [os.readlink(path)]
            else:
                data = path.read_bytes()
                texts = _texts(data)
        except OSError:
            problems.append(f"{rel}: could not be read for the private scan")
            continue
        for text in texts:
            for number, line in enumerate(text.splitlines(), start=1):
                for label, rx in compiled:
                    found = f"{rel}:{number}: matches {label}"
                    if rx.search(line) and found not in problems:
                        problems.append(found)
    return problems


def _gating_hooks(report: dict) -> list[dict]:
    hooks = list(report.get("manifest", {}).get("gatingHooks", []))
    for item in report.get("contents", []):
        hooks += item.get("gatingHooks", [])
    return hooks


MAX_DETAIL = 800


def _strict_detail(report: dict) -> str:
    items: list[tuple[str, dict]] = []
    manifest = report.get("manifest")
    items.append(("manifest", manifest if isinstance(manifest, dict) else {}))
    contents = report.get("contents")
    if isinstance(contents, list):
        items += [
            (str(item.get("file") or "manifest"), item) for item in contents if isinstance(item, dict)
        ]
    segments = [
        f"{label}: errors={json.dumps(item.get('errors') or [])} "
        f"warnings={json.dumps(item.get('warnings') or [])}"
        for label, item in items
        if item.get("errors") or item.get("warnings")
    ]
    return ("; ".join(segments) or "no details reported")[:MAX_DETAIL]


def _check_mod_with_claude(mod: Mod) -> list[str]:
    proc = claude.run("plugin", "validate", "--json", "--strict", str(mod.plugin_dir), check=False)
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return [f"{mod.name}: claude plugin validate gave no JSON: {proc.stderr.strip()}"]
    if not isinstance(report, dict):
        return [f"{mod.name}: claude plugin validate gave JSON that is not an object"]
    errs: list[str] = []
    if not report.get("success"):
        errs.append(
            f"{mod.name}: claude plugin validate --strict failed: {_strict_detail(report)}"
        )
    if mod.kind == "guard":
        hooks = _gating_hooks(report)
        if not hooks:
            errs.append(
                f"{mod.name}: guard mod reports no gating hooks "
                "(a guard must gate something the validator can see)"
            )
        for hook in hooks:
            if not hook.get("hasCatch"):
                errs.append(
                    f"{mod.name}: gating hook {hook.get('hook')} has no .catch "
                    "(guard mods must fail closed)"
                )
    if not any(mod.plugin_dir.rglob("*.test.ts*")):
        errs.append(f"{mod.name}: no *.test.ts found (every mod ships a test)")
    else:
        tested = claude.run("plugin", "test", str(mod.plugin_dir), check=False)
        if tested.returncode != 0:
            errs.append(f"{mod.name}: claude plugin test failed:\n{tested.stdout}{tested.stderr}")
    return errs


def validate(root: Path, *, run_claude: bool = True) -> list[str]:
    try:
        mods = load_all(root, include_local=True)
    except CatalogError as exc:
        return [str(exc)]
    try:
        stale = generate(root, check=True)
    except CatalogError as exc:
        return [str(exc)]
    problems = [
        f"generated file is stale: {p.relative_to(root)} (run scripts/mods generate)" for p in stale
    ]
    problems += scan_private(root)
    if run_claude:
        for mod in mods:
            problems += _check_mod_with_claude(mod)
        if any(not m.is_local for m in mods):
            proc = claude.run("plugin", "validate", "--strict", str(root), check=False)
            if proc.returncode != 0:
                problems.append(f"marketplace: claude plugin validate --strict failed:\n{proc.stdout}")
    return problems
