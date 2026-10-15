import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { main } from './cli'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// The Python helper sits next to this bundle in the plugin's bin directory.
const helper = join(dirname(fileURLToPath(import.meta.url)), 'secret-box')

try {
  process.exitCode = await main(process.argv.slice(2), {
    stdin: readStdin,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s.endsWith('\n') ? s : s + '\n'),
    helper,
  })
} catch (e) {
  process.stderr.write(`secret-box: failed: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
}
