import { describe, expect, it } from 'vitest'
import {
  parseRangeHeader,
  resolveRange,
  forwardRangeHeader,
  formatContentRange,
  contentRangeForUnsatisfiable
} from '../src/utils/range'

describe('parseRangeHeader', () => {
  it('absent when no header', () => {
    expect(parseRangeHeader(undefined)).toEqual({ kind: 'absent' })
    expect(parseRangeHeader(null)).toEqual({ kind: 'absent' })
    expect(parseRangeHeader('')).toEqual({ kind: 'absent' })
  })

  it('parses bytes=START- (open ended)', () => {
    expect(parseRangeHeader('bytes=0-')).toMatchObject({ kind: 'valid', spec: { type: 'from', start: 0 } })
    expect(parseRangeHeader('bytes=100-')).toMatchObject({ kind: 'valid', spec: { type: 'from', start: 100 } })
  })

  it('parses bytes=START-END (inclusive)', () => {
    expect(parseRangeHeader('bytes=0-0')).toMatchObject({ kind: 'valid', spec: { type: 'interval', start: 0, end: 0 } })
    expect(parseRangeHeader('bytes=100-200')).toMatchObject({ kind: 'valid', spec: { type: 'interval', start: 100, end: 200 } })
  })

  it('parses suffix bytes=-N correctly (never becomes bytes=N)', () => {
    const parsed = parseRangeHeader('bytes=-500')
    expect(parsed.kind).toBe('valid')
    if (parsed.kind === 'valid') {
      expect(parsed.spec).toEqual({ type: 'suffix', suffixLength: 500 })
    }
  })

  it('tolerates whitespace/case around the unit boundary where valid', () => {
    expect(parseRangeHeader('  bytes = 0-100  ')).toMatchObject({ kind: 'valid', spec: { type: 'interval', start: 0, end: 100 } })
    expect(parseRangeHeader('BYTES=0-100')).toMatchObject({ kind: 'valid' })
    expect(parseRangeHeader('Bytes=10-20 ')).toMatchObject({ kind: 'valid', spec: { type: 'interval', start: 10, end: 20 } })
  })

  it('rejects interior whitespace (the byte-range grammar is rigid)', () => {
    expect(parseRangeHeader('bytes=0 - 100')).toMatchObject({ kind: 'invalid' })
    expect(parseRangeHeader('bytes= 10 - 20')).toMatchObject({ kind: 'invalid' })
  })

  it('rejects malformed / unsupported ranges (never a full download)', () => {
    expect(parseRangeHeader('bytes=abc')).toMatchObject({ kind: 'invalid' })
    expect(parseRangeHeader('items=0-100')).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('unit') })
    expect(parseRangeHeader('bytes=abc-def')).toMatchObject({ kind: 'invalid' })
    expect(parseRangeHeader('bytes=-')).toMatchObject({ kind: 'invalid' })
    expect(parseRangeHeader('bytes=-0')).toMatchObject({ kind: 'invalid' })
    expect(parseRangeHeader('bytes=')).toMatchObject({ kind: 'invalid' })
    expect(parseRangeHeader('bytes=1.5-2')).toMatchObject({ kind: 'invalid' })
  })

  it('rejects end before start', () => {
    expect(parseRangeHeader('bytes=200-100')).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('end') })
  })

  it('explicitly rejects multi-range requests', () => {
    const parsed = parseRangeHeader('bytes=0-1,4-5')
    expect(parsed.kind).toBe('invalid')
    if (parsed.kind === 'invalid') {
      expect(parsed.reason.toLowerCase()).toContain('multiple')
    }
  })

  it('rejects unsafe integers', () => {
    expect(parseRangeHeader('bytes=99999999999999999999999999-')).toMatchObject({ kind: 'invalid' })
    expect(parseRangeHeader(`bytes=${Number.MAX_SAFE_INTEGER + 2}-`)).toMatchObject({ kind: 'invalid' })
    expect(parseRangeHeader('bytes=0-99999999999999999999999999')).toMatchObject({ kind: 'invalid' })
    // Leading zeros + overflow beyond 16 digits are invalid too.
    expect(parseRangeHeader('bytes=00000000000000000001-')).toMatchObject({ kind: 'invalid' })
  })
})

describe('resolveRange', () => {
  it('resolves open ranges against a known total', () => {
    expect(resolveRange({ type: 'from', start: 100 }, 1000)).toEqual({ kind: 'satisfiable', start: 100, end: 999 })
    expect(resolveRange({ type: 'from', start: 0 }, 1000)).toEqual({ kind: 'satisfiable', start: 0, end: 999 })
    expect(resolveRange({ type: 'interval', start: 100, end: 200 }, 1000)).toEqual({ kind: 'satisfiable', start: 100, end: 200 })
    // end beyond EOF clamps to the last byte
    expect(resolveRange({ type: 'interval', start: 900, end: 5000 }, 1000)).toEqual({ kind: 'satisfiable', start: 900, end: 999 })
  })

  it('resolves suffix ranges against a known total', () => {
    expect(resolveRange({ type: 'suffix', suffixLength: 500 }, 1000)).toEqual({ kind: 'satisfiable', start: 500, end: 999 })
    // suffix longer than the file yields the whole file
    expect(resolveRange({ type: 'suffix', suffixLength: 5000 }, 1000)).toEqual({ kind: 'satisfiable', start: 0, end: 999 })
    // zero-length file
    expect(resolveRange({ type: 'suffix', suffixLength: 10 }, 0)).toEqual({ kind: 'unsatisfiable' })
  })

  it('detects unsatisfiable ranges', () => {
    expect(resolveRange({ type: 'interval', start: 1000, end: 2000 }, 1000)).toEqual({ kind: 'unsatisfiable' })
    expect(resolveRange({ type: 'from', start: 1000 }, 1000)).toEqual({ kind: 'unsatisfiable' })
    expect(resolveRange({ type: 'interval', start: 0, end: 0 }, 0)).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('forwardRangeHeader', () => {
  it('returns undefined for absent and invalid', () => {
    expect(forwardRangeHeader({ kind: 'absent' })).toBeUndefined()
    expect(forwardRangeHeader({ kind: 'invalid', reason: 'x' })).toBeUndefined()
  })

  it('forwards exact forms', () => {
    expect(forwardRangeHeader(parseRangeHeader('bytes=0-'))).toBe('bytes=0-')
    expect(forwardRangeHeader(parseRangeHeader('bytes=100-200'))).toBe('bytes=100-200')
    expect(forwardRangeHeader(parseRangeHeader('bytes=0-0'))).toBe('bytes=0-0')
  })

  it('forwards suffix ranges as suffix ranges (the historical bug)', () => {
    expect(forwardRangeHeader(parseRangeHeader('bytes=-500'))).toBe('bytes=-500')
    // With a known total the suffix is normalized to the concrete span.
    expect(forwardRangeHeader(parseRangeHeader('bytes=-500'), 1000)).toBe('bytes=500-999')
  })

  it('keeps open-ended ranges open when total is unknown', () => {
    expect(forwardRangeHeader(parseRangeHeader('bytes=500-'))).toBe('bytes=500-')
  })
})

describe('Content-Range formatting', () => {
  it('formats satisfied and unsatisfiable responses', () => {
    expect(formatContentRange(0, 999, 1000)).toBe('bytes 0-999/1000')
    expect(formatContentRange(0, 99)).toBe('bytes 0-99/*')
    expect(contentRangeForUnsatisfiable(1000)).toBe('bytes */1000')
    expect(contentRangeForUnsatisfiable()).toBe('bytes */*')
  })
})
