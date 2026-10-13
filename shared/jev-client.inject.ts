async function nowMs($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// The key is read once per session and only ever goes into the Authorization header.
function loadKey($: Engine, s: State): Promise<string | undefined> {
  s.key ??= (async () => {
    try {
      return (await $.env.get('TYPESAFE_API_KEY')) || undefined
    } catch {
      return undefined
    }
  })()
  return s.key
}

// The notice shows once per install (the store remembers it), and at most once per activation.
const NOTICE_KEY = 'jevNotice'
const announced = new WeakSet<State>()

// Fire and forget: the toast and the store write never block, delay or fail a prompt. JEV_NOTICE comes from the mod.
function announceJev($: Engine, s: State): void {
  if (announced.has(s)) return
  announced.add(s)
  void (async () => {
    try {
      let seen = false
      try {
        seen = (await $.store.get(NOTICE_KEY)) === true
      } catch {
        // unreadable: shown once for this activation
      }
      if (seen) return
      const scope = s.jevPaths.trim() || 'every directory'
      $.ui.toast(`${JEV_NOTICE.mod}: ${JEV_NOTICE.what} are sent to api.typesafe.ai (Jev) from ${scope}. Restrict with the jevPaths option, or set ${JEV_NOTICE.off}. See the README Privacy section.`, { timeoutMs: 15000 })
      await $.store.set(NOTICE_KEY, true)
    } catch {
      // a notice must never matter
    }
  })()
}

// Jev is a third party: only with a key and a working directory the path gate allows.
async function jevKey($: Engine, s: State): Promise<string | undefined> {
  try {
    if (s.jevPaths.trim()) {
      const home = await $.env.get('HOME')
      if (!pathAllowed(await $.session.cwd(), s.jevPaths, home)) return undefined
    }
  } catch {
    return undefined
  }
  const key = await loadKey($, s)
  if (key) announceJev($, s)
  return key
}

// Rejects on any failure and after JEV_MS.
async function postJev($: Engine, key: string, body: string): ReturnType<Engine['http']['fetch']> {
  const ac = new AbortController()
  try {
    const req = $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    })
    req.catch(() => {}) // an abandoned request must not surface later
    const late = $.clock.sleep(JEV_MS, { signal: ac.signal }).then(() => {
      throw new Error('timeout')
    })
    late.catch(() => {}) // the losing side of the race must not surface later
    return await Promise.race([req, late])
  } finally {
    ac.abort()
  }
}

// A store call that hangs must not hold the records queued behind it, or a clear, forever.
const WRITE_MS = 5000

// Writes of one activation run one after another; a record from another session can still be lost.
let writes: Promise<void> = Promise.resolve()

// Past WRITE_MS a step is given up on (it may still land later) and the chain moves on.
function enqueue($: Engine, step: () => Promise<void>): Promise<void> {
  writes = writes.then(async () => {
    const ac = new AbortController()
    try {
      const work = step()
      work.catch(() => {})
      let late: Promise<void> = new Promise(() => {}) // no timer: unbounded, as before
      try {
        late = $.clock.sleep(WRITE_MS, { signal: ac.signal })
        late.catch(() => {})
      } catch {
        // no timer
      }
      await Promise.race([work, late])
    } catch {
      // the log is a measurement; losing a record must not touch the prompt
    } finally {
      ac.abort()
    }
  })
  return writes
}

function record($: Engine, rec: Rec): Promise<void> {
  return enqueue($, async () => {
    const old = await $.store.get(LOG_KEY)
    const log = Array.isArray(old) ? (old as Rec[]) : []
    await $.store.set(LOG_KEY, [...log, rec].slice(-LOG_MAX))
  })
}

function clearLog($: Engine): Promise<void> {
  return enqueue($, () => $.store.set(LOG_KEY, []))
}
