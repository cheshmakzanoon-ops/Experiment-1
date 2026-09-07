/**
 * Egress IP/org lookup (protected diagnostics only).
 *
 * Answers the operator question "what IP is Freebuff egressing from and is
 * it a datacenter?" — the information needed to decide whether a YouTube
 * block is an IP problem. Result is cached for 30 minutes and never leaks
 * into logs or ordinary responses.
 */

import { fetchExternal } from '../utils/net.js'

export interface EgressInfo {
  ip?: string
  hostname?: string
  org?: string
  city?: string
  region?: string
  country?: string
  isLikelyDatacenter?: boolean
  error?: string
  fetchedAt: number
}

const DATACENTER_KEYWORDS = [
  'amazon',
  'aws',
  'google',
  'oracle',
  'microsoft',
  'azure',
  'digitalocean',
  'linode',
  'vultr',
  'hetzner',
  'ovh',
  'scaleway',
  'cloudflare'
]

const CACHE_TTL_MS = 30 * 60 * 1000

let cached: EgressInfo | null = null

export async function getEgressInfo(force = false): Promise<EgressInfo> {
  const now = Date.now()
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached
  }

  const result: EgressInfo = { fetchedAt: now }
  try {
    const response = await fetchExternal('https://ipinfo.io/json', {
      timeoutMs: 10_000,
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`ipinfo HTTP ${response.status}`)
    const data = (await response.json()) as {
      ip?: string
      hostname?: string
      org?: string
      city?: string
      region?: string
      country?: string
    }
    result.ip = data.ip
    result.hostname = data.hostname
    result.org = data.org
    result.city = data.city
    result.region = data.region
    result.country = data.country

    const org = (data.org || '').toLowerCase()
    result.isLikelyDatacenter = DATACENTER_KEYWORDS.some((k) => org.includes(k))
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }

  cached = result
  return result
}

export function getCachedEgressInfo(): EgressInfo | null {
  return cached
}
