#!/usr/bin/env python3
from pathlib import Path

from modslib.catalog import CatalogError
from modslib.versions import check_versions


if __name__ == "__main__":
    try:
        problems = check_versions(Path(__file__).resolve().parents[1])
    except (CatalogError, OSError) as exc:
        problems = [f"mods: error: plugin version check failed: {exc}; fetch tags and full history, then retry"]
    for problem in problems:
        print(problem)
    raise SystemExit(bool(problems))
