import { expect, test } from 'claude-code/testing'

import { evaluate, parseConfig, type Env } from './rules'

// ~/.kube/config has dev and prod with `context` current; ./dev.yaml has current-context dev; `workspace` is what
// `terraform workspace show` reports; git commits as work@corp.example unless the probe's environment says otherwise.
type World = { cwd?: string; context?: string; workspace?: string }

function fakeEnv({ cwd = '/w/x', context = 'prod', workspace = 'default' }: World = {}): Env {
  const files: Record<string, string> = { '/h/.kube/config': `current-context: ${context}\n`, [`${cwd}/dev.yaml`]: 'current-context: dev\n' }
  return {
    cwd,
    home: '/h',
    contexts: async () => ({}),
    read: async (path) => files[path] ?? null,
    run: async (_dir, argv) => {
      const key = argv.join(' ')
      if (key === 'kubectl config current-context') return { ok: true, out: context }
      if (key.endsWith(' workspace show')) return { ok: true, out: workspace }
      return { ok: false, out: '' }
    },
    git: async (_dir, args, env) => {
      const key = args.join(' ')
      if (key.startsWith('symbolic-ref')) return { ok: true, out: 'feature/x' }
      if (key.startsWith('rev-parse --show-toplevel')) return { ok: true, out: '/h/personal/repo' }
      if (key.startsWith('rev-parse --verify')) return { ok: true, out: '' }
      const ident = /var GIT_(AUTHOR|COMMITTER)_IDENT$/.exec(key)
      if (ident) return { ok: true, out: `Me <${env?.[`GIT_${ident[1]}_EMAIL`] ?? 'work@corp.example'}> 1700000000 +0000` }
      return { ok: false, out: '' }
    },
  }
}

const IDENTITY = { identityRules: JSON.stringify([{ prefix: '~/personal/', email: 'me@ok.example' }]) }
const rules = async (command: string, world: World = {}, options: Record<string, string> = {}) =>
  (await evaluate(command, parseConfig(options), fakeEnv(world))).enforced.map((v) => v.rule)

test('state: an unexported shell variable is not environment, and export -n or +x removes it', async () => {
  for (const command of [
    'KUBECONFIG=dev.yaml && kubectl delete ns payments',
    'declare TF_WORKSPACE=dev && terraform apply',
    'readonly HELM_KUBECONTEXT=dev && helm upgrade x ./c',
    'export -n KUBECONFIG=dev.yaml && kubectl apply -f m.yaml',
    'declare +x KUBECONFIG=dev.yaml && kubectl apply -f m.yaml',
    'export KUBECONFIG=dev.yaml && export -n KUBECONFIG && kubectl apply -f m.yaml',
  ]) {
    expect(await rules(command, { workspace: 'prod' }), command).toEqual(['context'])
  }
})

test('state: an exported value, set -a, or an earlier export of the name still reaches the next call', async () => {
  for (const command of [
    'export KUBECONFIG=dev.yaml && kubectl apply -f m.yaml',
    'declare -x TF_WORKSPACE=dev && terraform apply',
    'set -a && TF_WORKSPACE=dev && terraform apply',
    'TF_WORKSPACE=dev && export TF_WORKSPACE && terraform apply',
    'export TF_WORKSPACE=x && TF_WORKSPACE=dev && terraform apply',
    'KUBECONFIG=dev.yaml kubectl apply -f m.yaml',
  ]) {
    expect(await rules(command, { workspace: 'prod' }), command).toEqual([])
  }
  expect(await rules('set -a && set +a && TF_WORKSPACE=dev && terraform apply', { workspace: 'prod' })).toEqual(['context'])
})

test('state: an unexported identity variable does not change the identity a commit uses', async () => {
  expect(await rules('GIT_AUTHOR_EMAIL=me@ok.example GIT_COMMITTER_EMAIL=me@ok.example && git commit -m x', {}, IDENTITY)).toContain('identity')
  expect(await rules('export GIT_AUTHOR_EMAIL=me@ok.example GIT_COMMITTER_EMAIL=me@ok.example && git commit -m x', {}, IDENTITY)).toEqual([])
  expect(await rules('GIT_AUTHOR_EMAIL=me@ok.example GIT_COMMITTER_EMAIL=me@ok.example git commit -m x', {}, IDENTITY)).toEqual([])
})

test('state: many unexported variables the guard does not read do not make a command unparsed', async () => {
  expect(await rules('A=1; B=2; C=3; D=4; E=5; F=6 && git commit -m x', {}, IDENTITY)).toEqual(['identity'])
  expect(await rules('A=1; B=2; C=3; D=4; E=5; F=6 && export GIT_AUTHOR_EMAIL=me@ok.example GIT_COMMITTER_EMAIL=me@ok.example && git commit -m x', {}, IDENTITY)).toEqual([])
})

test('context: kubectl config use is a switch, and every config verb outside the reads is a writer', async () => {
  const dev = { context: 'dev' }
  expect(await rules('kubectl config use prod && kubectl delete ns payments', dev)).toEqual(['context'])
  expect(await rules('kubectl config use dev && kubectl delete ns payments')).toEqual([])
  for (const command of [
    'kubectl config set-cluster dev-cluster --server=https://prod-api:6443 && kubectl apply -f m.yaml',
    'kubectl config set-credentials dev --token=t && kubectl apply -f m.yaml',
    'kubectl config delete-cluster old && kubectl apply -f m.yaml',
    'kubectl config use "$C" && kubectl apply -f m.yaml',
  ]) {
    expect(await rules(command, dev), command).toEqual(['context'])
  }
  for (const command of ['kubectl config view && kubectl apply -f m.yaml', 'kubectl config get-contexts && kubectl apply -f m.yaml']) {
    expect(await rules(command, dev), command).toEqual([])
  }
})

test('context: a krew plugin that switches context makes later mutating calls unclassified; listing does not', async () => {
  const dev = { context: 'dev' }
  for (const command of [
    'kubectl ctx prod && kubectl delete ns payments',
    'kubectl ctx - && kubectl apply -f m.yaml',
    'kubectl kubectx prod && kubectl apply -f m.yaml',
    'kubectl-ctx prod && kubectl apply -f m.yaml',
  ]) {
    expect(await rules(command, dev), command).toEqual(['context'])
  }
  for (const command of ['kubectl ctx && kubectl get pods', 'kubectl ctx -c && kubectl apply -f m.yaml']) {
    expect(await rules(command, dev), command).toEqual([])
  }
})

test('context: a command that switches the context or workspace without naming a guarded tool makes later targets unknown', async () => {
  for (const command of [
    'kubectx prod && kubectl apply -f m.yaml',
    'aws eks update-kubeconfig --name prod && kubectl apply -f m.yaml',
    'gcloud container clusters get-credentials prod && kubectl apply -f m.yaml',
    'az aks get-credentials -n prod -g g && helm upgrade x ./c',
    'oc login https://prod:6443 && kubectl apply -f m.yaml',
    'kind export kubeconfig --name prod && kubectl apply -f m.yaml',
    'kubectx prod || true; kubectl --context dev apply -f m.yaml',
  ]) {
    expect(await rules(command, { context: 'dev' }), command).toEqual(['context'])
  }
})

test('context: a write to a kubeconfig or .terraform/environment makes later targets unknown', async () => {
  for (const command of [
    'cp prod.yaml ~/.kube/config && kubectl apply -f m.yaml',
    'kubectl config view --raw > ~/.kube/config && kubectl apply -f m.yaml',
    'sed -i s/dev/prod/ ~/.kube/config && kubectl apply -f m.yaml',
    'cat prod.yaml | tee dev.yaml && KUBECONFIG=dev.yaml kubectl apply -f m.yaml',
  ]) {
    expect(await rules(command, { context: 'dev' }), command).toEqual(['context'])
  }
  for (const command of ['echo prod > .terraform/environment && terraform apply', 'cp ../prod/.terraform/environment .terraform/ && terraform apply']) {
    expect(await rules(command, { workspace: 'dev' }), command).toEqual(['context'])
  }
})

test('context: reads stay allowed after a switch, and reading the kube state is not a switch', async () => {
  for (const command of [
    'kubectx prod && kubectl get pods',
    'echo prod > .terraform/environment && terraform plan',
    'kubectx -c && kubectl apply -f m.yaml',
    'cat ~/.kube/config && kubectl apply -f m.yaml',
    'sed -n 1p ~/.kube/config && kubectl apply -f m.yaml',
    'oc config view && kubectl apply -f m.yaml',
  ]) {
    expect(await rules(command, { context: 'dev', workspace: 'dev' }), command).toEqual([])
  }
})

test('state: popd follows -n, +N and -N, and moves only when it removes the current directory', async () => {
  const dev = { cwd: '/r/dev' }
  for (const command of [
    'pushd ../prod && popd -n && terraform apply',
    'pushd ../prod && popd +1 && terraform apply',
    'pushd ../prod && popd -0 && terraform apply',
    'pushd ../prod && popd -n +0 && terraform apply',
    'pushd ../prod && popd "$N" && terraform apply',
  ]) {
    expect(await rules(command, dev), command).toEqual(['context'])
  }
  for (const command of [
    'pushd ../prod && popd && terraform apply',
    'pushd ../prod && popd +0 && terraform apply',
    'pushd ../prod && popd -1 && terraform apply',
    'pushd ../prod && pushd ../dev && popd -n +1 && terraform apply',
  ]) {
    expect(await rules(command, dev), command).toEqual([])
  }
})

test('state: popd outside the stack fails and leaves the directory alone', async () => {
  expect(await rules('popd -n; terraform apply', { cwd: '/r/dev' })).toEqual([])
  expect(await rules('pushd ../prod && popd +5; terraform apply', { cwd: '/r/dev' })).toEqual(['context'])
})
