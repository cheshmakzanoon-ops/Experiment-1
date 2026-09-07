/**
 * Process-level shutdown state shared between the entrypoint (src/index.ts)
 * and the public readiness endpoint. Readiness must immediately answer 503
 * SHUTTING_DOWN once the first signal arrives — before consulting any
 * cached healthy result.
 */

let shuttingDown = false

export function markShuttingDown(): void {
  shuttingDown = true
}

export function isShuttingDown(): boolean {
  return shuttingDown
}
