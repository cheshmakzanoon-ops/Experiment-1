import { Hono } from 'hono'
import { videoRoutes } from './videoRoutes.js'
import { searchRoutes } from './searchRoutes.js'
import { streamRoutes } from './streamRoutes.js'
import { feedRoutes } from './feedRoutes.js'
import { healthRoutes } from './healthRoutes.js'
import { diagnosticRoutes } from './diagnosticRoutes.js'

/**
 * Aggregated API router.
 *
 * src/index.ts mounts each sub-router individually (mirroring the
 * original spec); this router exists as a single handle for tooling,
 * tests, or future route groups that want to mount the whole API at once:
 *
 *   app.route('/api', apiRoutes)
 */
export const apiRoutes = new Hono()
  .route('/', videoRoutes)
  .route('/', searchRoutes)
  .route('/', streamRoutes)
  .route('/', feedRoutes)
  .route('/', healthRoutes)
  .route('/', diagnosticRoutes)

export { videoRoutes, searchRoutes, streamRoutes, feedRoutes, healthRoutes, diagnosticRoutes }
