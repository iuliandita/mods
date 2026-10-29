import { expect, test } from 'claude-code/testing'

import { evaluate, parseConfig, type Env } from './rules'

type Opts = { dir?: string; context?: string; workspace?: string; files?: Record<string, string> }

function env({ dir = '/h/personal/repo', context = 'dev-1', workspace = 'default', files = {} }: Opts = {}): Env {
  return {
    cwd: dir,
    home: '/h',
    git: async () => ({ ok: false, out: '' }),
    run: async (_dir, argv) => {
      const key = argv.join(' ')
      if (key === 'kubectl config current-context') return { ok: true, out: context }
      if (key.endsWith(' workspace show')) return { ok: true, out: workspace }
      return { ok: false, out: '' }
    },
    contexts: async () => ({}),
    read: async (path) => files[path] ?? null,
  }
}

const cfg = () => parseConfig({})
const KUBE = '/h/.kube/config'
const denied = async (command: string, e: Env) => (await evaluate(command, cfg(), e)).enforced

test('context: switch state follows the first existing kubeconfig and aliases the default file', async () => {
  const files = { [KUBE]: 'current-context: dev-1\n', '/w/other': 'current-context: dev-1\n' }
  for (const command of [
    'KUBECONFIG=/h/.kube/config:/dev/null kubectl config use-context prod && kubectl apply -f x',
    'KUBECONFIG=/missing:/h/.kube/config kubectl config use-context prod && kubectl apply -f x',
    'KUBECONFIG=/missing:/w/other kubectl config use-context prod && kubectl --kubeconfig /w/other apply -f x',
    'KUBECONFIG=/missing:/w/new kubectl config use-context prod && kubectl --kubeconfig /w/new apply -f x',
  ]) expect(await denied(command, env({ files })), command).toHaveLength(1)
  expect(await denied('KUBECONFIG=/h/.kube/config:/dev/null kubectl config use-context dev-1 && kubectl apply -f x', env({ context: 'prod', files }))).toEqual([])
})

test('context: an explicit kubeconfig containing a colon is one file, including writer tracking', async () => {
  const files = { '/h/personal/repo/dev.yaml': 'current-context: dev-1\n', '/h/personal/repo/dev.yaml:x': 'current-context: prod\n' }
  for (const command of [
    'kubectl --kubeconfig dev.yaml:x apply -f x',
    'helm --kubeconfig dev.yaml:x upgrade x ./c',
    'cp prod.yaml dev.yaml:x && kubectl --kubeconfig dev.yaml:x apply -f x',
    'kubectl --kubeconfig dev.yaml:x config use-context prod && kubectl --kubeconfig ./dev.yaml:x apply -f x',
  ]) expect(await denied(command, env({ files })), command).not.toEqual([])
  expect(await denied('KUBECONFIG=dev.yaml:x kubectl apply -f x', env({ files }))).toEqual([])
})

test('context: a kubeconfig current-context is read like kubectl reads it, and anything else is not classified', async () => {
  const apply = 'kubectl --kubeconfig /h/.kube/config apply -f x'
  const kubeconfig = (body: string) => env({ files: { [KUBE]: body } })
  // Ordinary files still pass, comment and quote styles included.
  for (const body of [
    'apiVersion: v1\ncurrent-context: dev-1\nkind: Config\n',
    'current-context: dev-1 # my cluster\n',
    'current-context: "dev-1"\n',
    "current-context: 'dev-1'  # note\n",
    'clusters: []\ncurrent-context: dev-1\r\nusers: []\r\n',
  ]) {
    expect(await denied(apply, kubeconfig(body)), body).toEqual([])
  }
  // The decoded or root value differs from what the text shows, so the guard cannot classify it.
  for (const body of [
    'current-context: "dev\\x2dprod"\n',
    'current-context: "dev-prod\\"\n',
    'current-context: &a dev-1\n',
    'current-context: !!str dev-1\n',
    'current-context: *a\n',
    'current-context: |\n  dev-1\n',
    'current-context: >\n  dev-1\n',
    'current-context: [dev-1]\n',
    'current-context: {a: dev-1}\n',
    'current-context: dev-1\n  more\n',
    'current-context:\n  dev-1\n',
    'current-context:\n- dev-1\n',
    'current-context: "dev-1\n  continued"\n',
    'current-context: dev-1\ncurrent-context: prod-eu\n',
    'current-context: dev-1: x\n',
    '{current-context: dev-1}\n',
  ]) {
    const v = await denied(apply, kubeconfig(body))
    expect(v, body).toHaveLength(1)
    expect(v[0]?.rule, body).toBe('context')
  }
})

test('context: a nested current-context is not the root one', async () => {
  const body = 'clusters:\n- name: prod\n  cluster:\n    extensions:\n    - extension:\n        current-context: dev\ncurrent-context: prod-eu\n'
  const v = await denied('kubectl --kubeconfig /h/.kube/config apply -f x', env({ files: { [KUBE]: body } }))
  expect(v).toHaveLength(1)
  expect(v[0]?.message).toContain('"prod-eu"')
  expect(await denied('kubectl --kubeconfig /h/.kube/config apply -f x', env({ files: { [KUBE]: 'extensions:\n  current-context: prod-eu\ncurrent-context: dev-1\n' } }))).toEqual([])
})

test('context: a terraform workspace the guard cannot tell is not classified, whatever the directory is called', async () => {
  const dev = (workspace = 'default') => env({ dir: '/w/envs/dev', workspace })
  for (const command of [
    'W=prod && TF_WORKSPACE="$W" terraform apply -auto-approve',
    'TF_WORKSPACE=$(cat /tmp/ws) terraform apply',
    'terraform workspace select "$W" && terraform apply',
    'terraform workspace new $(cat ws) && terraform apply',
    'export TF_WORKSPACE="${W:-prod}"; tofu destroy',
  ]) {
    const v = await denied(command, dev())
    expect(v, command).toHaveLength(1)
    expect(v[0]?.message, command).toContain('not classified')
  }
})

test('context: a dynamic kubectl context or kubeconfig is never relaxed by its look', async () => {
  for (const command of [
    'kubectl --context "$C" apply -f x',
    'KUBECONFIG="$K" kubectl apply -f x',
    'export KUBECONFIG=$(mktemp); kubectl apply -f x',
    'helm upgrade --kube-context "$C" r c',
  ]) {
    expect(await denied(command, env({ dir: '/w/envs/dev', context: 'dev-1' })), command).not.toEqual([])
  }
})

test('context: a literal workspace still combines with the directory, and an ordinary kubeconfig still passes', async () => {
  const dev = env({ dir: '/w/envs/dev' })
  expect(await denied('TF_WORKSPACE=dev terraform apply', dev)).toEqual([])
  expect(await denied('terraform workspace select dev && terraform apply', dev)).toEqual([])
  expect(await denied('terraform apply', dev)).toEqual([])
  expect(await denied('TF_WORKSPACE=prod terraform apply', dev)).toHaveLength(1)
  expect(await denied('kubectl apply -f x', env({ files: { [KUBE]: 'current-context: dev-1\n' }, context: 'dev-1' }))).toEqual([])
})
