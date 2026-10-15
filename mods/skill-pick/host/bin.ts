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
  process.exitCode = await main(process.argv.slice(2), {
    stdin: readStdin,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s.endsWith('\n') ? s : s + '\n'),
    bundle: fileURLToPath(import.meta.url),
  })
} catch (e) {
  process.stderr.write(`skill-pick: failed: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 0
}
