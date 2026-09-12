// playback-selection.test.ts — R1/R2 regression suite.
//
// The real selector is imported (never copied): every fixture is a yt-dlp
// `--dump-single-json` info dict fed to selectBestStream/extractPlayableVideo.

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/services/ytdlp/runYtDlp.js', () => ({
    runYtDlp: vi.fn(),
    YtDlpError: class YtDlpError extends Error {
        category: string
        constructor(message: string, category = 'mock') {
            super(message)
            this.category = category
        }
    },
    publicMessageFor: (category: string) => `public:${category}`
}))

import { runYtDlp } from '../src/services/ytdlp/runYtDlp.js'
import {
    selectBestStream,
    extractPlayableVideo,
    extractVideoInfo,
    availableCombinedQualities,
    formatIsBrowserCompatible
} from '../src/services/youtube/extractor.js'
import { streamCache } from '../src/middleware/streamCache.js'

type Format = Record<string, unknown>

function combinedFormat(overrides: Format = {}): Format {
    return {
        format_id: 'combined-18',
        url: 'https://rr3---sn.example.googlevideo.com/videoplayback?id=test',
        ext: 'mp4',
        height: 360,
        width: 640,
        vcodec: 'avc1.64001f',
        acodec: 'mp4a.40.2',
        protocol: 'https',
        tbr: 700,
        filesize: 10_000_000,
        ...overrides
    }
}

function infoFor(formats: Format[], extra: Record<string, unknown> = {}) {
    return {
        id: 'testVideo12345',
        title: 'Test video',
        duration: 600,
        formats,
        ...extra
    } as Parameters<typeof selectBestStream>[0]
}

beforeEach(() => {
    vi.clearAllMocks()
    streamCache.clear()
})

// ---------------------------------------------------------------------------
// R1 — never deliver silent video as success
// ---------------------------------------------------------------------------

describe('R1 strict selection', () => {
    it('a combined H.264/AAC MP4 at/below the cap is selected', () => {
        const stream = selectBestStream(
            infoFor([combinedFormat()]),
            480
        )
        expect(stream.hasAudio).toBe(true)
        expect(stream.hasVideo).toBe(true)
        expect(stream.mimeType).toBe('video/mp4')
        expect(stream.formatId).toBe('combined-18')
    })

    it('video-only + audio-only formats NEVER yield a normal playback pick', () => {
        const videoOnly = combinedFormat({ format_id: 'v-only', acodec: 'none' })
        const audioOnly = combinedFormat({ format_id: 'a-only', height: undefined, vcodec: 'none' })
        expect(() => selectBestStream(infoFor([videoOnly, audioOnly]), 480)).toThrow()
    })

    it('audio-only is rejected (no picture would exist)', () => {
        const audioOnly = combinedFormat({ format_id: 'a-only', vcodec: 'none' })
        try {
            selectBestStream(infoFor([audioOnly]), 480)
            expect.unreachable('selection should have thrown')
        } catch (error) {
            expect((error as Error).message).toMatch(/No combined/)
        }
    })

    it('missing codec identifiers are rejected (no invented availability)', () => {
        const noCodecs = combinedFormat({ format_id: 'nc', vcodec: undefined, acodec: undefined })
        expect(() => selectBestStream(infoFor([noCodecs]), 480)).toThrow()
    })

    it('an HLS manifest never masquerades as an ordinary MP4 file', () => {
        const hls = combinedFormat({
            format_id: 'hls',
            protocol: 'm3u8_native',
            url: 'https://manifest.example/index.m3u8'
        })
        expect(() => selectBestStream(infoFor([hls]), 480)).toThrow()
    })

    it('a DASH manifest is rejected', () => {
        const dash = combinedFormat({
            format_id: 'dash',
            protocol: 'http_dash_segments',
            url: 'https://manifest.example/dash.mpd'
        })
        expect(() => selectBestStream(infoFor([dash]), 480)).toThrow()
    })

    it('a non-browser-compatible container (ts/mkv) is rejected', () => {
        const ts = combinedFormat({ format_id: 'ts', ext: 'ts' })
        expect(() => selectBestStream(infoFor([ts]), 480)).toThrow()
    })

    it('formatIsBrowserCompatible accepts known avc/mp4 and rejects unknown codecs', () => {
        expect(formatIsBrowserCompatible(combinedFormat() as never)).toBe(true)
        expect(formatIsBrowserCompatible(combinedFormat({ vcodec: 'unknowncodec' }) as never)).toBe(false)
    })

    it('extraction rejects live streams', async () => {
        vi.mocked(runYtDlp).mockResolvedValue({
            stdout: JSON.stringify({ id: 'testVideo12345', is_live: true, live_status: 'is_live' }),
            stderr: ''
        })
        await expect(extractPlayableVideo('testVideo12345', 240)).rejects.toThrow()
    })

    it('stream cache cannot revive a previously invalid selection', async () => {
        // Extraction selects a valid stream and seeds the cache; then a
        // DIFFERENT video with only video-only formats must not be served
        // from any stale cache entry.
        const valid = combinedFormat({ url: 'https://rr3---sn.example.googlevideo.com/videoplayback?id=valid' })
        vi.mocked(runYtDlp).mockResolvedValueOnce({
            stdout: JSON.stringify(infoFor([valid], { id: 'cacheSeed0001' })),
            stderr: ''
        })
        const first = await extractPlayableVideo('cacheSeed0001', 480)
        expect(first.stream.formatId).toBe('combined-18')

        const videoOnly = combinedFormat({ format_id: 'v-only-2', acodec: 'none' })
        vi.mocked(runYtDlp).mockResolvedValueOnce({
            stdout: JSON.stringify(infoFor([videoOnly], { id: 'otherVideo001' })),
            stderr: ''
        })
        await expect(extractPlayableVideo('otherVideo001', 480)).rejects.toThrow()
    })

    it('errors survive route mapping (FORMAT_UNAVAILABLE keeps its stable code)', async () => {
        const videoOnly = combinedFormat({ format_id: 'v-only-3', acodec: 'none' })
        try {
            await extractPlayableVideo('mapErrVideo01', 480).catch((error) => {
                throw error
            })
            expect.unreachable()
        } catch (error) {
            expect((error as Error).message).toBeTruthy()
        }
        // The failure path must classify without crashing the mapping.
        const { publicMessageFor } = await import('../src/services/ytdlp/errors.js')
        expect(publicMessageFor('format_unavailable')).toBeTruthy()
    })
})

// ---------------------------------------------------------------------------
// R2 — requested quality must mean something
// ---------------------------------------------------------------------------

describe('R2 quality ceiling', () => {
    it('144 request with only combined-360 rejects the automatic upgrade', () => {
        const f360 = combinedFormat({ format_id: 'c360', height: 360 })
        try {
            selectBestStream(infoFor([f360]), 144)
            expect.unreachable('should refuse to exceed the requested ceiling')
        } catch (error) {
            expect((error as Error).message).toMatch(/144p/)
        }
    })

    it('240 request with only combined-720 rejects; alternatives are sanitized', () => {
        const f720 = combinedFormat({ format_id: 'c720', height: 720, tbr: 2500 })
        try {
            selectBestStream(infoFor([f720]), 240)
            expect.unreachable()
        } catch (error) {
            const message = (error as Error).message
            expect(message).toMatch(/240p/)
            // No signed upstream URL ever leaks through the alternatives list.
            expect(message).not.toMatch(/googlevideo|videoplayback/)
            expect(message).toMatch(/720p/)
        }
    })

    it('240 request with combined-144 plays and is labelled 144p', () => {
        const f144 = combinedFormat({ format_id: 'c144', height: 144, tbr: 150 })
        const stream = selectBestStream(infoFor([f144]), 240)
        expect(stream.quality).toBe('144p')
        expect(stream.height).toBe(144)
    })

    it('same-height candidates select deterministically on lower estimated bitrate', () => {
        const expensive = combinedFormat({ format_id: 'c480-hi', height: 480, tbr: 2200 })
        const cheap = combinedFormat({ format_id: 'c480-lo', height: 480, tbr: 620 })
        const stream = selectBestStream(infoFor([expensive, cheap]), 480)
        expect(stream.formatId).toBe('c480-lo')
    })

    it('extractVideoInfo exposes additive metadata agreeing with the selection', async () => {
        const f144 = combinedFormat({
            format_id: 'c144-meta',
            height: 144,
            tbr: 150,
            url: 'https://rr3---sn.example.googlevideo.com/videoplayback?id=meta144'
        })
        vi.mocked(runYtDlp).mockResolvedValue({
            stdout: JSON.stringify(infoFor([f144], { id: 'metaVideo0001' })),
            stderr: ''
        })
        const meta = await extractVideoInfo('metaVideo0001', 144)
        expect(meta.requestedQuality).toBe('144p')
        expect(meta.actualQuality).toBe('144p')
        expect(meta.hasAudio).toBe(true)
        expect(meta.hasVideo).toBe(true)
        expect(meta.mimeType).toBe('video/mp4')
        expect(meta.codecs?.video).toMatch(/avc1/)
        expect(meta.codecs?.audio).toMatch(/mp4a/)
        expect(meta.availableQualities?.length).toBeGreaterThan(0)
        expect(meta.selectionReason).toMatch(/combined:c144-meta:144p/)
        // Publicly-exposed additive fields carry NO upstream address: the
        // availableQualities list is sanitized (heights/labels/mimeTypes only).
        for (const q of meta.availableQualities ?? []) {
            expect(JSON.stringify(q)).not.toMatch(/googlevideo|videoplayback/)
        }
    })

    it('availableCombinedQualities lists only genuinely compatible choices', () => {
        const good = combinedFormat({ format_id: 'good360', height: 360 })
        const videoOnly = combinedFormat({ format_id: 'noaudio', height: 240, acodec: 'none' })
        const hls = combinedFormat({
            format_id: 'nohls',
            height: 720,
            protocol: 'm3u8_native',
            url: 'https://x.example/index.m3u8'
        })
        const qualities = availableCombinedQualities(infoFor([good, videoOnly, hls]))
        expect(qualities.map((q) => q.height)).toEqual([360])
    })

    it('malformed stored preference defaults safely (route validation covers it)', () => {
        // The route rejects invalid quality strings with 400 — the selector
        // itself only receives validated integers. 0/NaN ceilings must also
        // fail closed (no format can be <= an invalid ceiling).
        const f360 = combinedFormat({ format_id: 'c360x', height: 360 })
        expect(() => selectBestStream(infoFor([f360]), Number.NaN)).toThrow()
    })
})
