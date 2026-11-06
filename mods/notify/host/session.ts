import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

import type { Config, Env } from '../claude/hooks/notify'
import { home } from './run'

// A rollout's first record is enough; never scan assistant messages or a previous turn.
export function codexChild(path: unknown): boolean {
  if (typeof path !== 'string') return false
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) return false
    const chunk = Buffer.alloc(4096)
    let text = ''
    for (let size = 0; size < 65_536; size += chunk.length) {
      const length = readSync(fd, chunk, 0, chunk.length, null)
      text += chunk.toString('utf8', 0, length)
      const end = text.indexOf('\n')
      if (end < 0 && length === chunk.length) continue
      const record = JSON.parse(end < 0 ? text : text.slice(0, end))
      if (record?.type !== 'session_meta') return false
      const meta = record.payload
      return meta?.source === 'exec' || meta?.originator === 'codex_exec' || meta?.thread_source === 'subagent'
        || typeof meta?.source?.subagent?.thread_spawn?.parent_thread_id === 'string'
    }
  } catch {
    // Missing, malformed, too large, or unreadable means unknown, so notify.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return false
}

type Statement = { get(...values: string[]): unknown }
type Database = { exec(sql: string): unknown; prepare(sql: string): Statement; close(): void }
type OpenOptions = { readOnly?: boolean; readonly?: boolean; create?: boolean }
type Driver = {
  DatabaseSync?: new (path: string, options: OpenOptions) => Database
  Database: new (path: string, options: OpenOptions) => Database
}

export function t3Path(env: Env, userHome: string | null): string | null {
  const base = env.T3CODE_HOME || (userHome ? join(userHome, '.t3') : null)
  return base ? join(base, 'userdata', 'statev2.sqlite') : null
}

// Both runtimes expose prepare/get/close. The dynamic specifier keeps Bun's driver out of Node bundles.
export async function t3Child(session: unknown, cfg: Pick<Config, 't3'>, env: Env = process.env, userHome = home()): Promise<boolean> {
  if (cfg.t3 === 'off' || typeof session !== 'string' || session === '') return false
  const path = t3Path(env, userHome)
  if (!path || !existsSync(path)) return false
  let db: Database | undefined
  try {
    const bun = Boolean(process.versions.bun)
    const module = bun ? 'bun:sqlite' : 'node:sqlite'
    const driver = await import(module) as Driver
    const Constructor = bun ? driver.Database : (driver.DatabaseSync ?? driver.Database)
    db = new Constructor(path, bun ? { readonly: true, create: false } : { readOnly: true })
    db.exec('PRAGMA busy_timeout = 20; PRAGMA query_only = ON')
    const row = db.prepare(`
      SELECT 1 AS child
      FROM orchestration_v2_projection_provider_threads AS p
      LEFT JOIN orchestration_v2_projection_threads AS t ON t.thread_id = p.thread_id
      WHERE json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ?
        AND (instr(p.thread_id, 'thread:delegated-task:') = 1
          OR json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL)
      LIMIT 1
    `).get(session)
    return row !== null && typeof row === 'object' && 'child' in row
  } catch {
    // Old runtimes, unknown schemas, busy databases and missing mappings all fail open.
    return false
  } finally {
    try { db?.close() } catch { /* notification delivery must still proceed */ }
  }
}
