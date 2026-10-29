from __future__ import annotations

import hashlib
import json
import os
import selectors
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from modslib.catalog import CatalogError

MARKET = "iuliandita-mods"
RETRUST = "After every Codex plugin install or update, open /hooks in Codex and review and trust each changed hook; guards fail open until trusted again."


def _list_hooks(cwd: Path, snapshot: Path) -> dict:
    env = dict(os.environ)
    env["CODEX_HOME"] = str(snapshot)
    deadline = time.monotonic() + 10
    with tempfile.TemporaryFile() as stderr, subprocess.Popen(
        ["codex", "app-server", "--listen", "stdio://"], cwd=cwd, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
    ) as proc:
        assert proc.stdin is not None and proc.stdout is not None
        pending = b""
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)

            def request(message: dict, wanted: int) -> dict:
                nonlocal pending
                proc.stdin.write((json.dumps(message) + "\n").encode())
                proc.stdin.flush()
                while True:
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        response = json.loads(line)
                        if not isinstance(response, dict):
                            raise ValueError("Codex returned an invalid response")
                        if response.get("id") == wanted:
                            if "error" in response:
                                raise ValueError("Codex rejected hooks/list")
                            result = response["result"]
                            if not isinstance(result, dict):
                                raise ValueError("Codex returned an invalid result")
                            return result
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise TimeoutError("Codex hook inventory timed out")
                    data = os.read(proc.stdout.fileno(), 65536)
                    if not data:
                        raise ValueError("Codex closed the hook inventory")
                    pending += data
                    if len(pending) > 8 * 1024 * 1024:
                        raise ValueError("Codex hook inventory is too large")

            try:
                request({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "mods-doctor", "version": "1"}}}, 1)
                proc.stdin.write(b'{"method":"initialized"}\n')
                return request({"id": 2, "method": "hooks/list", "params": {"cwds": [str(cwd)]}}, 2)
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


def hook_trust(cwd: Path) -> tuple[list[dict], list[str]]:
    home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    cache = home / "plugins/cache" / MARKET
    if not cache.is_dir():
        return [], []
    try:
        # Codex may migrate trust while listing. Copy, never symlink, all inputs so
        # even that migration and app-server startup cannot write live user state.
        with tempfile.TemporaryDirectory(prefix="mods-doctor-") as directory:
            snapshot = Path(directory)
            for name in ("config.toml", "hooks.json"):
                source = home / name
                if source.is_file():
                    shutil.copyfile(source, snapshot / name)
                    (snapshot / name).chmod(0o600)
            for plugin in cache.iterdir():
                plugin_id = f"{plugin.name}@{MARKET}"
                def legacy_path(base: Path) -> Path:
                    digest = hashlib.sha256()
                    for part in (os.fsencode(base / "config.toml"), plugin_id.encode()):
                        digest.update(len(part).to_bytes(8, "little"))
                        digest.update(part)
                    return base / ".hook-trust" / digest.hexdigest()
                original = legacy_path(home.resolve())
                if original.is_file():
                    target = legacy_path(snapshot)
                    target.parent.mkdir(exist_ok=True)
                    shutil.copyfile(original, target)
            shutil.copytree(cache, snapshot / "plugins/cache" / MARKET, symlinks=True)
            result = _list_hooks(cwd, snapshot)
        rows: list[dict] = []
        errors: list[str] = []
        entries = result["data"]
        if not isinstance(entries, list) or not entries:
            raise ValueError("Codex returned no hook inventory")
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Codex returned an invalid inventory entry")
            if entry.get("errors") or entry.get("warnings"):
                raise ValueError("Codex reported hook discovery diagnostics")
            for hook in entry["hooks"]:
                if not isinstance(hook, dict):
                    raise ValueError("Codex returned an invalid hook")
                plugin = hook.get("pluginId")
                if not isinstance(plugin, str) or not plugin.endswith("@" + MARKET):
                    continue
                status = hook["trustStatus"]
                if status not in ("trusted", "modified", "untrusted") or not isinstance(hook["enabled"], bool):
                    raise ValueError("Codex returned an unknown hook trust state")
                mod = plugin.split("@", 1)[0]
                rows.append({"mod": mod, "event": hook["eventName"], "status": status, "enabled": hook["enabled"]})
                if mod in ("guard-rules", "secret-box") and (status != "trusted" or not hook["enabled"]):
                    errors.append(f"{mod}: error: Codex {hook['eventName']} hook is {status}" + (" and disabled" if not hook["enabled"] else "") + "; open /hooks in Codex and enable and trust it again")
        return rows, errors
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise CatalogError("mods: error: Codex hook trust could not be checked: inventory unavailable or invalid; run codex, inspect /hooks, and retry doctor") from exc
