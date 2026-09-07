import { describe, expect, it } from 'vitest'
import { parseParam, strictInt } from '../src/utils/params'

describe('parseParam (page/limit/max style validation)', () => {
  it('uses the fallback when the parameter is missing', () => {
    expect(parseParam(undefined, 10, 1, 50)).toEqual({ error: false, value: 10 })
    expect(parseParam(null, 10, 1, 50)).toEqual({ error: false, value: 10 })
    expect(parseParam('', 10, 1, 50)).toEqual({ error: false, value: 10 })
    expect(parseParam('   ', 10, 1, 50)).toEqual({ error: false, value: 10 })
  })

  it('accepts canonical integers within bounds', () => {
    expect(parseParam('1', 10, 1, 50)).toEqual({ error: false, value: 1 })
    expect(parseParam('50', 10, 1, 50)).toEqual({ error: false, value: 50 })
    expect(parseParam('7', 10, 1, 50)).toEqual({ error: false, value: 7 })
  })

  it('rejects non-numeric garbage (NaN is never accepted)', () => {
    for (const junk of ['abc', '12abc', '1.5', '-1', '+1', '1e3', '0x10', 'Infinity', 'NaN', '١٢', '12,5', '--1']) {
      expect(parseParam(junk, 10, 1, 50).error, junk).toBe(true)
    }
  })

  it('rejects out-of-range values', () => {
    expect(parseParam('0', 10, 1, 50)).toMatchObject({ error: true }) // zero
    expect(parseParam('51', 10, 1, 50)).toMatchObject({ error: true }) // oversized
    expect(parseParam('-3', 10, 1, 50)).toMatchObject({ error: true }) // negative
  })

  it('rejects unsafe integers', () => {
    expect(parseParam('99999999999999999999', 10, 1, 50)).toMatchObject({ error: true })
  })
})

describe('strictInt', () => {
  it('parses valid numbers and rejects garbage', () => {
    expect(strictInt('0')).toBe(0)
    expect(strictInt('42')).toBe(42)
    expect(strictInt(null)).toBeNull()
    expect(strictInt(undefined)).toBeNull()
    expect(strictInt('')).toBeNull()
    expect(strictInt('abc')).toBeNull()
    expect(strictInt('4.5')).toBeNull()
    expect(strictInt('4x')).toBeNull()
    expect(strictInt('-1')).toBeNull()
  })
})
