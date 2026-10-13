import { expect, test } from 'claude-code/testing'

import { base64, makeScrubber, placeholderNames, rewriteCommand, scrubToolAnswer, withhold, type Scrubber } from './scrub'

test('the longest known form wins and a replacement is never scanned again', () => {
  const scrub = makeScrubber(new Map([['short', 'hunter2hunter2'], ['long', 'hunter2hunter2-extra'], ['tiny', 'abc']]))
  expect(scrub?.('x hunter2hunter2-extra y hunter2hunter2 z abc')).toEqual({
    text: 'x {{secret:long}} y {{secret:short}} z abc',
    names: ['long', 'short'],
  })
  expect(makeScrubber(new Map([['tiny', 'abc']]))).toBeNull()
})

test('a value inside Basic-auth base64 (user:<value>) is scrubbed', () => {
  const scrub = makeScrubber(new Map([['tok', 'hunter2hunter2']]))
  expect(scrub?.(`Authorization: Basic ${base64('user:hunter2hunter2')}`)).toEqual({
    text: 'Authorization: Basic dXNlcjp{{secret:tok}}g==',
    names: ['tok'],
  })
})

test('base64 matches the standard encoding for multi-byte text and padding', () => {
  expect(base64('a')).toBe('YQ==')
  expect(base64('ab')).toBe('YWI=')
  expect(base64('abc')).toBe('YWJj')
  expect(base64('é€')).toBe('w6nigqw=')
})

// What python json.dumps (ensure_ascii) prints: every non-ASCII UTF-16 unit as \uXXXX.
const ESCAPED: [string, string, string, string][] = [
  ['a BMP value', 'pässwörd123', 'p\\u00e4ssw\\u00f6rd123', 'p\\u00E4ssw\\u00F6rd123'],
  ['a non-BMP value (surrogate pair)', 'tok\u{1F511}value1', 'tok\\ud83d\\udd11value1', 'tok\\uD83D\\uDD11value1'],
]
for (const [label, value, lower, upper] of ESCAPED) {
  test(`${label} is scrubbed in its ASCII-escaped JSON form`, () => {
    const scrub = makeScrubber(new Map([['tok', value]])) as Scrubber
    const text = `{"a": "${lower}", "b": "${upper}", "c": ${JSON.stringify(value)}, "d": "${value}"}`
    expect(scrub(text)).toEqual({
      text: '{"a": "{{secret:tok}}", "b": "{{secret:tok}}", "c": "{{secret:tok}}", "d": "{{secret:tok}}"}',
      names: ['tok'],
    })
  })
}

test('an all-ASCII value gets no extra \\u escape form', () => {
  const scrub = makeScrubber(new Map([['tok', 'hunter2hunter2']])) as Scrubber
  expect(scrub('\\u0068unter2hunter2')).toEqual({ text: '\\u0068unter2hunter2', names: [] })
})

test('placeholders need a valid name and the command is quoted for POSIX sh', () => {
  expect(placeholderNames('a {{secret:x.y-1}} {{secret:x.y-1}} {{secret:b c}} {{secret:}}')).toEqual(['x.y-1'])
  expect(rewriteCommand('/p q/secret-box', "echo '{{secret:x}}'")).toBe("'/p q/secret-box' exec -- 'echo '\\''{{secret:x}}'\\'''")
})

test('a Bash result record has hints and structuredContent scrubbed; the path fields stay as they are', () => {
  const scrub = makeScrubber(new Map([['tok', 'hunter2hunter2']])) as Scrubber
  const rec = {
    stdout: 'out hunter2hunter2',
    returnCodeInterpretation: 'saw hunter2hunter2',
    persistedOutputPath: '/o/hunter2hunter2.txt',
    rawOutputPath: '/o/raw-hunter2hunter2.txt',
    persistedOutputSize: 12,
    structuredContent: [{ type: 'text', text: 'a hunter2hunter2', n: 1, deep: { list: ['hunter2hunter2'] } }],
  }
  const out = scrubToolAnswer({ result: rec, text: 'hunter2hunter2' }, scrub)
  expect(out).toEqual({
    result: {
      stdout: 'out {{secret:tok}}',
      returnCodeInterpretation: 'saw {{secret:tok}}',
      persistedOutputPath: '/o/hunter2hunter2.txt',
      rawOutputPath: '/o/raw-hunter2hunter2.txt',
      persistedOutputSize: 12,
      structuredContent: [{ type: 'text', text: 'a {{secret:tok}}', n: 1, deep: { list: ['{{secret:tok}}'] } }],
    },
    text: '{{secret:tok}}',
  })
  const broken = scrubToolAnswer({ result: rec }, () => {
    throw new Error('x')
  })
  expect(JSON.stringify(broken)).not.toContain('saw hunter2')
  expect((broken.result as { persistedOutputPath: string }).persistedOutputPath).toBe('/o/hunter2hunter2.txt')
})

test('an errored call (string result) and nested fields are scrubbed; too deep is withheld; ids and paths survive a failure', () => {
  const scrub = makeScrubber(new Map([['tok', 'hunter2hunter2']])) as Scrubber
  expect(scrubToolAnswer({ result: 'Error: hunter2hunter2', text: 'x' }, scrub)).toEqual({ result: 'Error: {{secret:tok}}', text: 'x' })

  let deep: unknown = 'hunter2hunter2'
  for (let i = 0; i < 14; i++) deep = { next: deep }
  const rec = {
    backgroundTaskId: 'bg1',
    persistedOutputPath: '/o/tool-results/x.txt',
    bashEditDiff: { hunks: [{ lines: [' ctx hunter2hunter2', '+new'] }] },
    context: ['c hunter2hunter2'],
    deep,
  }
  const out = scrubToolAnswer({ result: rec }, scrub).result as typeof rec
  expect(out.bashEditDiff).toEqual({ hunks: [{ lines: [' ctx {{secret:tok}}', '+new'] }] })
  expect(out.context).toEqual(['c {{secret:tok}}'])
  expect(JSON.stringify(out.deep)).toContain('withheld')
  expect(JSON.stringify(out.deep)).not.toContain('hunter2')
  expect(out.persistedOutputPath).toBe('/o/tool-results/x.txt')

  const cyc: Record<string, unknown> = { type: 'text', text: 'hunter2hunter2' }
  cyc.self = cyc
  const failed = scrubToolAnswer({ result: { ...rec, deep: undefined, cyc } }, () => {
    throw new Error('x')
  }).result as Record<string, unknown>
  expect(failed.backgroundTaskId).toBe('bg1')
  expect(failed.persistedOutputPath).toBe('/o/tool-results/x.txt')
  expect(JSON.stringify(failed)).not.toContain('hunter2')
  expect(JSON.stringify(failed)).toContain('"type":"text"')
})

test('a known value in an object key is replaced and a key it then collides with is kept', () => {
  const scrub = makeScrubber(new Map([['tok', 'hunter2hunter2']])) as Scrubber
  const out = scrubToolAnswer({ result: { structuredContent: { hunter2hunter2: 'a', '{{secret:tok}}': 'b' } } }, scrub)
  const sc = (out.result as { structuredContent: Record<string, string> }).structuredContent
  expect(JSON.stringify(out)).not.toContain('hunter2')
  expect(Object.values(sc)).toEqual(['a', 'b'])
})

test('a record field named like a known value keeps its name and its value is scrubbed; user-data keys are still scrubbed', () => {
  const scrub = makeScrubber(new Map([['tok', 'hunter2hunter2']])) as Scrubber
  const out = scrubToolAnswer({ hunter2hunter2: 'x hunter2hunter2', result: { hunter2hunter2: 'y hunter2hunter2', data: { 'k-hunter2hunter2': 1 } } }, scrub)
  expect(out).toEqual({ hunter2hunter2: 'x {{secret:tok}}', result: { hunter2hunter2: 'y {{secret:tok}}', data: { 'k-{{secret:tok}}': 1 } } })
})

test('withhold keeps the row shape and drops the words', () => {
  const out = withhold([{ type: 'text', text: 'secret' }, { type: 'tool_use', id: 't' }, { type: 'tool_result', tool_use_id: 't', content: 'secret' }])
  expect(JSON.stringify(out)).not.toContain('"secret"')
  expect(out[1]).toEqual({ type: 'tool_use', id: 't' })
})
