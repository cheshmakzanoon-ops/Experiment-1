import type { ErrorHandler, NotFoundHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { logger } from '../utils/logger.js'
import { YtDlpError } from '../utils/ytDlp.js'

/**
 * Reusable Hono error handler. Maps known error types to proper status
 * codes and hides internal details from the client.
 *
 * The main app in src/index.ts registers an equivalent handler globally;
 * this one is exported for route groups that need isolated handling.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof YtDlpError) {
    logger.warn('yt-dlp error', { code: err.code, message: err.message })
    return c.json({ error: err.message }, err.code as ContentfulStatusCode)
  }

  logger.error('Unhandled error', err)
  return c.json({ error: 'Internal server error' }, 500)
}

/** Reusable not-found handler for API route groups. */
export const notFoundHandler: NotFoundHandler = (c) => {
  return c.json({ error: 'Endpoint not found' }, 404)
}
