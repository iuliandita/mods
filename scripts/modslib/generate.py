from __future__ import annotations

import json
from pathlib import Path

from modslib.catalog import CatalogError, Mod, inject_span, load_all, load_mods, shared_dir

MARKETPLACE_NAME = "iuliandita-mods"
LOCAL_MARKETPLACE_NAME = "iuliandita-mods-local"
GITHUB_SOURCE = "iuliandita/mods"
OWNER = {"name": "iuliandita"}


def build_marketplace(mods: list[Mod], *, local: bool = False) -> dict:
    return {
        "name": LOCAL_MARKETPLACE_NAME if local else MARKETPLACE_NAME,
        "description": (
            "Private Claude Code mods, local only."
            if local
            else "Claude Code mods you can install one at a time."
        ),
        "owner": OWNER,
        "plugins": [
            {
                "name": m.name,
                "source": f"./mods/{m.name}/claude",
                "description": m.summary,
            }
            for m in sorted(mods, key=lambda m: m.name)
        ],
    }


def build_catalog(mods: list[Mod]) -> dict:
    return {
        "schema": 1,
        "marketplace": MARKETPLACE_NAME,
        "source": GITHUB_SOURCE,
        "mods": [
            {
                **m.as_dict(),
                "install": (
                    f"claude plugin marketplace add {GITHUB_SOURCE} && "
                    f"claude plugin install {m.name}@{MARKETPLACE_NAME}"
                ),
            }
            for m in sorted(mods, key=lambda m: m.name)
        ],
    }


def render(obj: dict) -> str:
    return json.dumps(obj, indent=2) + "\n"


def shared_copy_dir(mod: Mod) -> Path:
    return mod.plugin_dir / "hooks" / "shared"


HEADER_PREFIX = "// Generated from shared/"


def shared_copy(root: Path, name: str) -> str:
    header = f"{HEADER_PREFIX}{name} by scripts/mods generate. Do not edit by hand.\n"
    return header + (shared_dir(root) / name).read_text()


def register_path(mod: Mod) -> Path:
    return mod.plugin_dir / "hooks" / "register.ts"


# The mod's register.ts with each listed block rewritten between its markers (checked by the catalog).
def injected(root: Path, mod: Mod) -> str:
    text = register_path(mod).read_text()
    for name in mod.inject:
        span = inject_span(text, name)
        if span is None:
            raise CatalogError(f"{mod.name}: inject markers for {name} are missing")
        block = (shared_dir(root) / name).read_text()
        if block and not block.endswith("\n"):
            block += "\n"
        text = text[: span[0]] + block + text[span[1] :]
    return text


def targets(root: Path, *, include_local: bool) -> dict[Path, str]:
    mods = load_all(root, include_local=include_local)
    public = load_mods(root)
    out = {
        shared_copy_dir(m) / name: shared_copy(root, name) for m in mods for name in m.shared
    }
    out |= {register_path(m): injected(root, m) for m in mods if m.inject}
    out |= {
        root / ".claude-plugin" / "marketplace.json": render(build_marketplace(public)),
        root / "mods.json": render(build_catalog(public)),
    }
    if include_local:
        private = load_mods(root, local=True)
        out[root / "local" / ".claude-plugin" / "marketplace.json"] = render(
            build_marketplace(private, local=True)
        )
    return out


# Copies in a mod's hooks/shared/ that its mod.json no longer lists.
def extra_copies(root: Path, *, include_local: bool) -> list[Path]:
    return [
        p
        for m in load_all(root, include_local=include_local)
        if shared_copy_dir(m).is_dir()
        for p in sorted(shared_copy_dir(m).iterdir())
        if p.is_file() and p.name not in m.shared
    ]


def generate(root: Path, *, check: bool = False, include_local: bool = False) -> list[Path]:
    changed: list[Path] = []
    extras = extra_copies(root, include_local=include_local)
    foreign = [p for p in extras if not p.read_text().startswith(HEADER_PREFIX)]
    if foreign:
        raise CatalogError(
            "not a generated copy (no generated header), move or delete it by hand: "
            + ", ".join(str(p.relative_to(root)) for p in foreign)
        )
    for path in extras:
        changed.append(path)
        if not check:
            path.unlink()
    for path, text in targets(root, include_local=include_local).items():
        if not path.is_file() or path.read_text() != text:
            changed.append(path)
            if not check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
    return changed
