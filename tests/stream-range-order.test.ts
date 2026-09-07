// Range-rejection ordering tests for the stream proxy.
//
// The audit concern: a malformed/unsupported Range header must be answered
// locally with 416 BEFORE any cache lookup or yt-dlp extraction work — junk
// requests must never burn a YouTube extraction. proxyVideoStream calls
// rejectMalformedRangeEarly() before resolveStreamSource(); these tests pin
// the pure decision function's contract.
import { describe, expect, it } from 'vitest'
import { rejectMalformedRangeEarly } from '../src/services/youtube/streamProxy'

describe('rejectMalformedRangeEarly', () => {
  it('absent and valid ranges pass through untouched', () => {
    expect(rejectMalformedRangeEarly(undefined)).toBeNull()
    expect(rejectMalformedRangeEarly(null)).toBeNull()
    expect(rejectMalformedRangeEarly('')).toBeNull()
    expect(rejectMalformedRangeEarly('bytes=0-1023')).toBeNull()
    expect(rejectMalformedRangeEarly('bytes=1024-')).toBeNull()
    expect(rejectMalformedRangeEarly('bytes=-500')).toBeNull()
  })

  it('malformed ranges are rejected with 416 and no total (no fetch needed)', () => {
    const result = rejectMalformedRangeEarly('bytes=abc')
    expect(result).not.toBeNull()
    expect(result!.status).toBe(416)
    expect(result!.contentRange).toBe('bytes */*')

    expect(rejectMalformedRangeEarly('chunks=0-1')).not.toBeNull()
    expect(rejectMalformedRangeEarly('bytes=')).not.toBeNull()
    expect(rejectMalformedRangeEarly('bytes=-')).not.toBeNull()
    expect(rejectMalformedRangeEarly('bytes=0-1,4-5')).not.toBeNull()
    // End before start.
    expect(rejectMalformedRangeEarly('bytes=100-50')).not.toBeNull()
    // Junk/overflowing digits.
    expect(rejectMalformedRangeEarly('bytes=99999999999999999999-')).not.toBeNull()
  })

  it('includes a known cached total in the Content-Range payload when available', () => {
    const result = rejectMalformedRangeEarly('bytes=abc', 123456)
    expect(result).not.toBeNull()
    expect(result!.contentRange).toBe('bytes */123456')
  })

  it('never reports an invalid range as satisfiable just because a total is known', () => {
    // The early decision is total-agnostic for malformed input: it is a
    // 416 either way, and it must never fall through to an upstream fetch.
    expect(rejectMalformedRangeEarly('bytes=abc', 0)).not.toBeNull()
    expect(rejectMalformedRangeEarly('bytes=abc', -1)).not.toBeNull()
  })
})
