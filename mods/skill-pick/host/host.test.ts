import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Complete } from '../../../host-lib/engine'
import type { PromptInput } from '../../../host-lib/prompt'
import { codexSkillDirs, parseSkill, scanSkills } from '../../../host-lib/skills'
import { main, type Io } from './cli'
import { setup } from './opencode'

let root: string
let options: string
let skills: string
let store: string
let counter = 0
let reply = '{"skills":["deploy-helm"]}'
let prompts: string[] = []
const savedKey = process.env.TYPESAFE_API_KEY

const skill = (dir: string, name: string, front: string) => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\n${front}\n---\n\nbody\n`)
}

beforeAll(() => {
  delete process.env.TYPESAFE_API_KEY
  root = mkdtempSync(join(tmpdir(), 'skill-pick-host-'))
  options = join(root, 'skill-pick.json')
  skills = join(root, 'skills')
  skill(skills, 'deploy-helm', 'name: deploy-helm\ndescription: Deploy a chart with helm and verify the rollout')
  skill(skills, 'write-docs', 'name: "write-docs"\ndescription: >\n  Write and edit\n  project documentation')
  skill(skills, 'broken', 'description: no name here')
})

afterAll(() => {
  if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  store = join(root, `store-${counter++}.json`)
  reply = '{"skills":["deploy-helm"]}'
  prompts = []
})

const setOptions = (o: Record<string, string>) => writeFileSync(options, JSON.stringify(o))

const complete: Complete = async (req) => {
  prompts.push(typeof req.prompt === 'string' ? req.prompt : req.prompt.map((b) => b.text).join('\n'))
  if (reply === 'throw') throw new Error('boom')
  return { isAnswered: true, text: reply, usage: { input_tokens: 10, output_tokens: 5 } }
}

const submit = (prompt: string) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: root })

function io(stdin: string, over: Partial<Io> = {}): Io & { stdout: string; measured: PromptInput[] } {
  const o: Io & { stdout: string; measured: PromptInput[] } = {
    stdout: '',
    measured: [],
    stdin: async () => stdin,
    out: (s) => void (o.stdout += s),
    err: () => {},
    bundle: 'unused',
    options,
    store,
    complete,
    measure: (p) => void o.measured.push(p),
    extra: { skillDirs: [skills] },
    ...over,
  }
  return o
}

async function hook(prompt: string, over: Partial<Io> = {}) {
  const i = io(submit(prompt), over)
  const code = await main(['hook'], i)
  return { code, out: i.stdout ? JSON.parse(i.stdout) : null, measured: i.measured }
}

const ASK = 'roll out the new chart to the staging cluster and check it'

test('skills are read from front matter: plain, quoted and folded values; a file without a name is skipped', () => {
  expect(scanSkills([skills]).map((s) => s.name)).toEqual(['deploy-helm', 'write-docs'])
  expect(scanSkills([skills]).find((s) => s.name === 'write-docs')?.description).toBe('Write and edit project documentation')
  expect(parseSkill('no front matter')).toBeNull()
  expect(scanSkills([skills, skills])).toHaveLength(2)
})

test('codex: mode on adds the picked skills as context, without naming a Skill tool', async () => {
  setOptions({ mode: 'on' })
  const r = await hook(ASK)
  expect(r.code).toBe(0)
  expect(r.out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
  const context: string = r.out.hookSpecificOutput.additionalContext
  expect(context).toContain('deploy-helm')
  expect(context).not.toContain('Skill tool')
  expect(prompts[0]).toContain('- deploy-helm: Deploy a chart with helm')
})

test('codex: a name outside the catalog, a failing model, off and short prompts add nothing', async () => {
  setOptions({ mode: 'on' })
  reply = '{"skills":["not-installed"]}'
  expect((await hook(ASK)).out).toBeNull()
  reply = 'throw'
  expect((await hook(ASK)).out).toBeNull()
  expect((await hook('hi')).out).toBeNull()
  setOptions({ mode: 'off' })
  expect((await hook(ASK)).out).toBeNull()
  expect((await main(['hook'], io('not json'))) === 0).toBe(true)
})

test('codex: with no skills installed the model is not called', async () => {
  setOptions({ mode: 'on' })
  expect((await hook(ASK, { extra: { skillDirs: [join(root, 'none')] } })).out).toBeNull()
  expect(prompts).toEqual([])
})

test('codex: dry mode releases the prompt at once; the detached measurement logs a record', async () => {
  setOptions({ mode: 'dry' })
  const r = await hook(ASK)
  expect(r.out).toBeNull()
  expect(r.measured).toEqual([{ prompt: ASK, cwd: root }])
  expect(prompts).toEqual([])
  await main(['measure'], io(JSON.stringify({ prompt: ASK, cwd: root })))
  await Bun.sleep(200)
  const s = io('')
  await main(['summary'], s)
  expect(s.stdout).toContain('skill-pick')
  const last = io('')
  await main(['last'], last)
  expect(last.stdout).toContain('deploy-helm')
  await main(['clear'], io(''))
  const after = io('')
  await main(['last'], after)
  expect(after.stdout).toContain('no records')
})

test('codex: with a Jev key the first dry-mode prompt carries the privacy notice, once', async () => {
  setOptions({ mode: 'dry' })
  process.env.TYPESAFE_API_KEY = 'test-key'
  try {
    expect((await hook(ASK)).out.systemMessage).toContain('api.typesafe.ai')
    expect((await hook(ASK)).out).toBeNull()
  } finally {
    delete process.env.TYPESAFE_API_KEY
  }
})

test('opencode: the host skill list becomes the catalog and the pick is appended to the prompt', async () => {
  setOptions({ mode: 'on' })
  let run: (e: { prompt: { text: string } }) => Promise<void> | void = () => {}
  await setup(
    {
      location: { directory: root },
      generate: {
        text: async ({ prompt }) => {
          prompts.push(prompt)
          return { text: reply }
        },
      },
      skill: { list: async () => ({ data: [{ name: 'deploy-helm', description: 'Deploy a chart with helm' }, { name: 'write-docs' }] }) },
      session: { hook: async (_name, cb) => void (run = cb) },
    },
    { options, store },
  )
  const e = { prompt: { text: ASK } }
  await run(e)
  expect(e.prompt.text.startsWith(ASK)).toBe(true)
  expect(e.prompt.text).toContain('deploy-helm')
  expect(prompts[0]).toContain('<catalog>')

  reply = 'throw'
  const failed = { prompt: { text: ASK } }
  await run(failed)
  expect(failed.prompt.text).toBe(ASK)
})

test('skill folders: user and system ones win over the repository, the repository share is capped, the walk stops at the repo root', () => {
  const repo = join(root, 'proj')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const mine = join(root, 'mine')
  skill(mine, 'deploy-helm', 'name: deploy-helm\ndescription: the real one')
  skill(join(repo, '.agents', 'skills'), 'deploy-helm', 'name: deploy-helm\ndescription: shadowing attempt')
  for (let i = 0; i < 150; i++) skill(join(repo, '.agents', 'skills'), `r${i}`, `name: r${i}\ndescription: d`)
  const found = scanSkills({ user: [mine], repo: [join(repo, '.agents', 'skills')] })
  expect(found.find((s) => s.name === 'deploy-helm')?.description).toBe('the real one')
  expect(found.length).toBe(1 + 100)
  const dirs = codexSkillDirs(join(repo, 'a', 'b'), { codexHome: join(root, 'none') })
  expect(dirs.repo.map((d) => d.replace(root, ''))).toEqual(['/proj/a/b/.agents/skills', '/proj/a/.agents/skills', '/proj/.agents/skills'])
  expect(codexSkillDirs(join(root, 'plain'), { codexHome: join(root, 'none') }).repo).toHaveLength(1)
})

test('the built Codex bundle runs under node and exits after answering', () => {
  const bundle = join(import.meta.dir, '..', 'codex', 'bin', 'skill-pick.mjs')
  const r = spawnSync('node', [bundle, 'hook'], { input: submit(ASK), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 20_000 })
  expect(r.status).toBe(0)
  expect(r.signal).toBeNull()
})
