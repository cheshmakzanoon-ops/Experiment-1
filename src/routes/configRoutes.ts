import { Hono } from 'hono'

const configRoutes = new Hono()

/**
 * GET /api/config — bootstrap config for the frontend.
 *
 * This is a public endpoint (see PUBLIC_PATHS in src/middleware/auth.ts)
 * because it hands the frontend the API key it needs to authenticate with
 * every other endpoint. That is fine for a private, single-household app
 * where the frontend is already a trusted client, but it means whoever can
 * reach this server can also read the key — if that ever becomes a problem,
 * gate this behind a one-time setup token instead of serving it freely.
 *
 * Returns a 500 (CONFIG_MISSING) while no API_KEY is configured, which the
 * frontend treats as "dev mode — auth disabled" and skips the key prompt.
 */
configRoutes.get('/config', (c) => {
  const apiKey = process.env.API_KEY

  if (!apiKey) {
    return c.json(
      {
        error: 'API key not configured on server',
        code: 'CONFIG_MISSING'
      },
      500
    )
  }

  return c.json({
    apiKey,
    version: process.env.npm_package_version || '1.0.0',
    buildTime: process.env.BUILD_TIME || new Date().toISOString(),
    authRequired: true
  })
})

export { configRoutes }
