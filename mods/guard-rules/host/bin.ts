import { main } from './cli'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const argv = process.argv.slice(2)

// Codex lets a hook that fails (any exit other than 2) through, so an unexpected error in the hook is a 2.
try {
  process.exitCode = await main(argv, {
    stdin: readStdin,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s.endsWith('\n') ? s : s + '\n'),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  })
} catch (e) {
  process.stderr.write(`guard-rules: ${argv[0] === 'hook' ? 'the hook failed, so the call was blocked (fail closed)' : 'failed'}: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = argv[0] === 'hook' ? 2 : 1
}
