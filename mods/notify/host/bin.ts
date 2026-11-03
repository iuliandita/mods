import { main } from './cli'
import { codexRunner } from './run'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

try {
  process.exitCode = await main(process.argv.slice(2), {
    stdin: readStdin,
    err: (s) => void process.stderr.write(s.endsWith('\n') ? s : s + '\n'),
    run: codexRunner,
    platform: process.platform,
  })
} catch (e) {
  process.stderr.write(`notify: warning: failed: ${e instanceof Error ? e.message : String(e)}\n`)
}
