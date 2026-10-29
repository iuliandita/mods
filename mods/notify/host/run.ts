import { execFile } from 'node:child_process'

import { loadOptions } from '../../../host-lib/options'
import { parseConfig, type Config, type Runner } from '../claude/hooks/notify'

// Starts the notifier without a shell and waits for it. A program that is not there rejects (ENOENT); one that
// runs and fails resolves with its exit code.
export const nodeRunner: Runner = (argv) =>
  new Promise((resolve, reject) => {
    execFile(argv[0] as string, argv.slice(1), { timeout: 5_000, windowsHide: true }, (error) => {
      if (!error) return resolve({ exitCode: 0 })
      const code = (error as NodeJS.ErrnoException).code
      if (typeof code === 'number') return resolve({ exitCode: code })
      if (code === 'ENOENT') return reject(error)
      resolve({ exitCode: 1 })
    })
  })

// Options come from the user-level file only, never from a repository. A file that cannot be read gives the
// defaults and a warning line for the caller.
export function readConfig(path?: string): { config: Config; warning?: string } {
  const loaded = loadOptions('notify', path)
  return {
    config: parseConfig(loaded.error ? null : loaded.options),
    ...(loaded.error ? { warning: `notify: warning: options ignored: ${loaded.error}; fix notify.json` } : {}),
  }
}
