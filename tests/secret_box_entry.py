#!/usr/bin/env python3
"""Test-only entry for the secret-box helper: the shipped code with a JSON-file backend injected.

SECRET_BOX_TEST_STORE names the file. A value written as a list is answered one item per lookup
(the last item repeats), so a test can make the store answer differently on a later read.
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
from pathlib import Path

HELPER = Path(__file__).resolve().parent.parent / "mods/secret-box/claude/bin/secret-box"


def load_helper():
    sys.dont_write_bytecode = True
    loader = importlib.machinery.SourceFileLoader("secret_box", str(HELPER))
    spec = importlib.util.spec_from_loader("secret_box", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class FileBackend:
    def __init__(self, path):
        self.path = path
        self.lookups = {}

    def _load(self):
        try:
            with open(self.path) as f:
                return json.load(f)
        except FileNotFoundError:
            return {}

    def _save(self, data):
        with open(self.path, "w") as f:
            json.dump(data, f)

    def get(self, name):
        value = self._load().get(name)
        if isinstance(value, list):
            n = self.lookups.get(name, 0)
            self.lookups[name] = n + 1
            return value[min(n, len(value) - 1)]
        return value

    def set(self, name, value):
        data = self._load()
        data[name] = value
        self._save(data)

    def remove(self, name):
        data = self._load()
        data.pop(name, None)
        self._save(data)

    def names(self):
        return sorted(self._load())


def main(argv):
    sb = load_helper()

    def backend():
        path = os.environ.get("SECRET_BOX_TEST_STORE")
        if not path:
            raise sb.SecretBoxError("SECRET_BOX_TEST_STORE is not set")
        return FileBackend(path)

    sb.get_backend = backend
    return sb.main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
