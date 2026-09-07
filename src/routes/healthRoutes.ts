import { Hono } from 'hono'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const healthRoutes = new Hono()

// GET /api/health
healthRoutes.get('/health', (c) => {
  const memoryUsage = process.memoryUsage()
  
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      rss: Math.round(memoryUsage.rss / 1024 / 1024)
    },
    node_version: process.version
  })
})

// GET /api/health/ready
healthRoutes.get('/health/ready', async (c) => {
  try {
    // Check if yt-dlp is installed and working
    const { stdout } = await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 })
    
    return c.json({
      status: 'ready',
      ytDlp: {
        installed: true,
        version: (stdout as string).trim()
      }
    })
  } catch (error) {
    return c.json({
      status: 'not_ready',
      ytDlp: {
        installed: false,
        error: 'yt-dlp is not installed or not working'
      }
    }, 503)
  }
})

export { healthRoutes }
