import { config } from '../config.js'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

function isEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[config.logLevel]
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (!isEnabled(level)) return
  const line = {
    time: new Date().toISOString(),
    level,
    message,
    ...(meta !== undefined ? { meta } : {})
  }
  const output = JSON.stringify(line)
  if (level === 'error') {
    console.error(output)
  } else if (level === 'warn') {
    console.warn(output)
  } else {
    console.log(output)
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta)
}

export default logger
