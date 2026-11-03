from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration
ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    ('mode', 'permission_mode'),
    [('on', None), ('dry', None), ('off', None), ('ask', None)]
    + [('ask', mode) for mode in ('acceptEdits', 'plan', 'dontAsk', 'bypassPermissions')],
)
def test_unparsed_permission_on_real_headless_host(
    tmp_path: Path, mode: str, permission_mode: str | None,
) -> None:
    if shutil.which('claude') is None:
        if os.environ.get('MODS_REQUIRE_CLAUDE'):
            pytest.fail('the claude CLI is required but not installed')
        pytest.skip('claude CLI not installed')
    driver = tmp_path / 'driver'
    (driver / '.claude-plugin').mkdir(parents=True)
    (driver / 'hooks').mkdir()
    (driver / '.claude-plugin/plugin.json').write_text(json.dumps({
        'name': 'permission-driver', 'version': '0.0.1', 'description': 'Permission integration test.',
    }))
    (driver / 'hooks/hooks.json').write_text('{"modules":["./register.ts"]}')
    result_file = tmp_path / 'result.json'
    decision_file = tmp_path / 'decision.json'
    # Drop the prompt before a model request. Only this harmless tool call reaches the real permission path.
    (driver / 'hooks/register.ts').write_text(
        "import type { Register } from 'claude-code'\n"
        "export const register: Register = on => {\n"
        "  on('classic.PreToolUse', {tool:'Bash'}, async ($, e, next) => {\n"
        "    const decision = await next(e)\n"
        f"    await $.fs.write({json.dumps(str(decision_file))}, JSON.stringify(decision))\n"
        "    return decision\n"
        "  })\n"
        "  on('prompt.submit', async ($) => {\n"
        "    const r = await $.tool.call({tool:'Bash',command:'f() { :; }; git status'})\n"
        f"    await $.fs.write({json.dumps(str(result_file))}, JSON.stringify(r))\n"
        "    return {drop:'permission probe complete'}\n"
        "  }).catch(() => ({drop:'permission probe failed'}))\n"
        "}\n"
    )
    settings = tmp_path / 'settings.json'
    settings.write_text(json.dumps({'pluginConfigs': {'guard-rules': {'options': {'modeUnparsed': mode}}}}))
    subprocess.run(['git', 'init', '-q', '-b', 'feature/test', str(tmp_path)], check=True)
    command = [
        'claude', '-p', 'permission probe', '--plugin-dir', str(driver),
        '--plugin-dir', str(ROOT / 'mods/guard-rules/claude'), '--settings', str(settings), '--setting-sources', '',
        '--strict-mcp-config', '--allowedTools', 'Bash', '--no-session-persistence',
        '--max-budget-usd', '0.01',
    ]
    if permission_mode:
        command.extend(['--permission-mode', permission_mode])
    run = subprocess.run(
        command, cwd=tmp_path, env={**os.environ, 'CLAUDE_CONFIG_DIR': str(tmp_path / 'config')},
        capture_output=True, text=True, timeout=30,
    )
    assert run.returncode == 0, run.stdout + run.stderr
    assert 'permission probe complete' in run.stdout, run.stdout + run.stderr
    result = json.loads(result_file.read_text())
    if mode in ('on', 'ask'):
        assert 'deny' in result, result
        assert 'guard-rules: unparsed:' in result['deny'], result
        if mode == 'ask':
            assert decision_file.exists(), result
            assert 'ask' in json.loads(decision_file.read_text()), decision_file.read_text()
    else:
        assert 'deny' not in result, result
        assert 'result' in result, result
