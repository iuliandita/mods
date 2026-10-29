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

test('context: Terraform injected arguments and cloud overrides cannot reuse relaxed names', async () => {
  for (const command of [
    'TF_CLI_ARGS=-migrate-state terraform init',
    'TF_CLI_ARGS_init=-reconfigure terraform init',
    'export TF_CLI_ARGS_init=-force-copy && terraform init',
    'TF_CLI_ARGS_plan=-destroy terraform plan',
    'export TF_CLI_ARGS=-refresh=false && tofu plan',
    'TF_CLI_ARGS_apply=-auto-approve terraform plan',
    'TF_CLI_ARGS= terraform plan',
    'TF_CLI_ARGS_plan=-destroy && terraform plan',
    'TF_CLOUD_PROJECT=other && terraform apply',
    'TF_CLOUD_ORGANIZATION=other terraform apply',
    'export TF_CLOUD_HOSTNAME=cloud.example && terraform apply',
    'TF_CLOUD_PROJECT=other tofu apply',
    'unset TF_CLOUD_PROJECT && terraform apply',
    'env -u TF_CLI_ARGS terraform apply',
    'HOME=/srv/ops terraform apply',
    'HOME=/srv/ops kubectl config use-context dev && kubectl apply -f x',
    'sudo kubectl config use-context dev && kubectl apply -f x',
    'env -u KUBECONFIG kubectl config use-context dev && kubectl apply -f x',
    'TF_DATA_DIR=/other terraform workspace select dev && terraform apply',
    'TF_CLOUD_PROJECT=other terraform workspace select dev && terraform apply',
  ]) {
    const v = await denied(command, env({ dir: '/w/dev', workspace: 'dev' }))
    expect(v.some((f) => f.rule === 'context' && f.message.includes('(custom target)')), command).toBe(true)
  }
  for (const command of [
    'terraform plan',
    'terraform init',
    'TF_CLOUD_PROJECT=other terraform plan',
    'declare +x TF_CLI_ARGS_plan=-destroy && terraform plan',
    'TF_VAR_project=other terraform apply',
  ]) expect(await denied(command, env({ dir: '/w/dev', workspace: 'dev' })), command).toEqual([])
})

test('context: secret placeholders are unknown in direct targets and followed switches', async () => {
  for (const command of [
    'kubectl --context {{secret:dev_context}} apply -f x',
    'helm --kube-context {{secret:dev_context}} upgrade x ./c',
    'HELM_KUBECONTEXT={{secret:dev_context}} helm upgrade x ./c',
    'TF_WORKSPACE={{secret:dev_workspace}} terraform apply',
    'export TF_WORKSPACE={{secret:dev_workspace}} && tofu apply',
    'terraform workspace select {{secret:dev_workspace}} && terraform apply',
    'tofu workspace new {{secret:dev_workspace}} && tofu apply',
    'kubectl config use-context {{secret:dev_context}} && kubectl apply -f x',
    'kubectl config set current-context {{secret:dev_context}} && helm upgrade x ./c',
    'kubectl --kubeconfig {{secret:dev_config}} apply -f x',
  ]) {
    const v = await denied(command, env({ dir: '/w/dev', workspace: 'dev' }))
    expect(v.some((f) => f.rule === 'context' && f.message.includes('(custom target)')), command).toBe(true)
  }
  expect(await denied('kubectl --context dev_context apply -f x', env())).toEqual([])
  expect(await denied('TF_WORKSPACE=dev_workspace terraform apply', env())).toEqual([])
})

test('context: removed, cleared and empty target variables never reuse inherited relaxed lookups', async () => {
  for (const command of [
    'unset KUBECONFIG && kubectl apply -f x',
    'env -u KUBECONFIG kubectl apply -f x',
    'export -n KUBECONFIG && kubectl apply -f x',
    'KUBECONFIG= kubectl apply -f x',
    'env -i kubectl apply -f x',
    'env -u KUBECONFIG bash -c "kubectl apply -f x"',
    'unset HELM_KUBECONTEXT && helm upgrade x ./c',
    'HELM_KUBECONTEXT= helm upgrade x ./c',
    'env -u TF_WORKSPACE terraform apply',
    'TF_WORKSPACE= tofu apply',
    'env -i terraform apply',
    'HOME=/srv/ops kubectl apply -f x',
    'export HOME=/srv/ops && terraform apply',
    'sudo kubectl apply -f x',
    '/usr/bin/sudo -E helm upgrade x ./c',
    'env -S "sudo kubectl apply -f x"',
    'sudo bash -c "kubectl apply -f x"',
    'sudo -s "kubectl apply -f x"',
    'doas tofu apply',
  ]) {
    const v = await denied(command, env({ dir: '/w/dev', workspace: 'dev' }))
    expect(v.some((f) => f.rule === 'context' && f.message.includes('(custom target)')), command).toBe(true)
  }
  for (const command of [
    'env -u OTHER kubectl apply -f x',
    'HOME=/h kubectl apply -f x',
    'sudo kubectl get pods',
    'env -u TF_WORKSPACE terraform plan',
    'kubectl --context sudo get pods',
  ]) expect(await denied(command, env({ dir: '/w/dev', workspace: 'dev' })), command).toEqual([])
})

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

test('context: a current-context mention outside the recognized root line is unknown', async () => {
  const body = 'clusters:\n- name: prod\n  cluster:\n    extensions:\n    - extension:\n        current-context: dev\ncurrent-context: prod-eu\n'
  const v = await denied('kubectl --kubeconfig /h/.kube/config apply -f x', env({ files: { [KUBE]: body } }))
  expect(v).toHaveLength(1)
  expect(v[0]?.message).toContain('(custom target)')
  expect(await denied('kubectl --kubeconfig /h/.kube/config apply -f x', env({ files: { [KUBE]: 'extensions:\n  current-context: prod-eu\ncurrent-context: dev-1\n' } }))).toHaveLength(1)
})

test('context: ambiguous first-file keys never fall through to a relaxed second kubeconfig', async () => {
  for (const body of [
    '? current-context\n: prod\n',
    '  current-context: prod\n',
    '"current\\u002dcontext": prod\n',
    '"\\x63urrent-context": prod\n',
    '&key current-context: prod\n',
    '!!str current-context: prod\n',
    '--- {current-context: prod}\n',
    'apiVersion: v1\rcurrent-context: prod\r',
    'apiVersion: v1\u0085current-context: prod\u0085',
    'apiVersion: v1\u2028current-context: prod\u2028',
    'apiVersion: v1\u2029current-context: prod\u2029',
    '# current-context is stored elsewhere\n',
  ]) {
    const files = { '/w/dev/first.yaml': body, '/w/dev/dev.yaml': 'current-context: dev\n' }
    const v = await denied('KUBECONFIG=first.yaml:dev.yaml kubectl apply -f x', env({ dir: '/w/dev', files }))
    expect(v, body).toHaveLength(1)
    expect(v[0]?.message, body).toContain('(custom target)')
  }
  const files = { '/w/dev/first.yaml': 'clusters: []\n', '/w/dev/dev.yaml': 'current-context: dev\n' }
  expect(await denied('KUBECONFIG=first.yaml:dev.yaml kubectl apply -f x', env({ dir: '/w/dev', files }))).toEqual([])
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
