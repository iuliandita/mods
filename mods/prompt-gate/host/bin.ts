import { fileURLToPath } from 'node:url'

import { main } from './cli'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// A measurement that hangs must not outlive the hook by long.
setTimeout(() => process.exit(0), 60_000).unref()

try {
  const code = await main(process.argv.slice(2), {
    stdin: readStdin,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s.endsWith('\n') ? s : s + '\n'),
    bundle: fileURLToPath(import.meta.url),
  })
  process.exitCode = code
  // A hook is done once it has answered, even if a stalled request is still open; `measure` runs until its work ends.
  if (process.argv[2] === 'hook') process.stdout.write('', () => process.exit(code))
} catch (e) {
  process.stderr.write(`prompt-gate: failed: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 0
}
