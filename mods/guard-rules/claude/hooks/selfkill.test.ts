import { expect, test } from 'claude-code/testing'

import { evaluate, parseConfig, type Env } from './rules'

const env: Env = {
  cwd: '/h/repo',
  home: '/h',
  git: async () => ({ ok: false, out: '', failed: true }),
  run: async () => ({ ok: false, out: '', failed: true }),
  contexts: async () => ({}),
  read: async () => null,
}

const rules = async (command: string, options: Record<string, string> = {}) => (await evaluate(command, parseConfig(options), env)).enforced.map((v) => v.rule)

test('selfkill: a pkill -f pattern that matches the shell running the command is denied', async () => {
  const denied = [
    `pkill -f 'vite --host 127.0.0.1'`,
    `cd /x && pkill -f "wrangler dev"; echo done`,
    `pkill -9 -f 'port-forward -n app'`,
    `pkill -USR1 -f 'garret.AppImage'`,
    `pkill -u 1000 -f 'wrangler dev'`,
    `pkill -fi 'vite'`,
    `rtk pkill --full 'preview --port 4329'`,
    `sudo pkill -f 'astro preview'`,
    `bash -c "pkill -f 'bun run --hot src/index.ts'"`,
    // Another command in the line spells out what a bracket class would hide.
    `pkill -f '[v]ite'; vite build`,
  ]
  for (const command of denied) expect(await rules(command), command).toEqual(['selfkill'])
})

test('selfkill: exact, anchored, bracketed, dynamic and non-pkill forms pass', async () => {
  const allowed = [
    'pkill -x handy',
    `pkill -f '^bun run dev$'`,
    `pkill -f '[v]ite --host 127.0.0.1'`,
    `pkill -fx 'bun run dev'`,
    'pkill hypridle',
    'pkill -f "$PATTERN"',
    'echo pkill -f vite',
    `pgrep -f 'vite --host'`,
    'pkill -P 123',
  ]
  for (const command of allowed) expect(await rules(command), command).toEqual([])
})

test('selfkill: a pattern that could backtrack badly is denied without being run', async () => {
  const hostile = [
    `pkill -f '(a+)+$'`,
    `pkill -f '(a|aa)+$'`,
    `pkill -f '(.*)x\\1'`,
    `pkill -f 'a*a*b'`,
    `pkill -f 'x{2,}'`,
    `pkill -f '(?=a)'`,
    `pkill -f '[]a*]'`,
    `pkill -f '\\bvite'`,
    `pkill -f '${'a'.repeat(300)}'`,
    `pkill -f '^x'; echo ${'y'.repeat(9000)}`,
  ]
  for (const command of hostile) {
    const t0 = Date.now()
    const v = (await evaluate(command, parseConfig({}), env)).enforced
    expect(v.map((x) => x.rule), command.slice(0, 40)).toEqual(['selfkill'])
    expect(v[0]!.message).toContain('too complex')
    expect(Date.now() - t0).toBeLessThan(500)
  }
  for (const command of [`pkill -f '^(bun|node) run dev$'`, `pkill -f '^vite.*host$'`]) expect(await rules(command), command).toEqual([])
})

test('selfkill: the deny names the safe forms, dry reports without denying, off is silent', async () => {
  const command = `pkill -f 'vite --host'`
  const v = (await evaluate(command, parseConfig({}), env)).enforced[0]!
  expect(v.message).toContain('pkill -x')
  expect(v.message).toContain('exit 144')
  const dry = await evaluate(command, parseConfig({ modeSelfKill: 'dry' }), env)
  expect([dry.enforced.length, dry.dry.length]).toEqual([0, 1])
  expect(await rules(command, { modeSelfKill: 'off' })).toEqual([])
})
