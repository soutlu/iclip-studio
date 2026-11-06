import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LogLevel } from './log'
import { parseAllowedHosts } from './request'

export interface RenderConfig {
  port: number
  allowedHosts: Set<string>
  registryRoot: string
  workDir: string
  timeoutMs: number
  logLevel: LogLevel
}

export class ConfigError extends Error {}

const LEVELS = new Set<string>(['debug', 'info', 'warn', 'error'])

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ConfigError(`${name} 必须是正整数`)
  return parsed
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RenderConfig {
  const allowedHosts = parseAllowedHosts(env['RENDER_ALLOWED_MEDIA_HOSTS'])
  if (allowedHosts.size === 0) throw new ConfigError('RENDER_ALLOWED_MEDIA_HOSTS 未设置')
  const registryRoot = env['RENDER_REGISTRY_ROOT']
  if (!registryRoot) throw new ConfigError('RENDER_REGISTRY_ROOT 未设置')
  const logLevel = env['LOG_LEVEL'] ?? 'info'
  if (!LEVELS.has(logLevel)) throw new ConfigError('LOG_LEVEL 只能是 debug、info、warn、error')
  return {
    port: positiveInteger('PORT', env['PORT'], 8080),
    allowedHosts,
    registryRoot: resolve(registryRoot),
    workDir: resolve(env['RENDER_WORK_DIR'] || join(tmpdir(), 'iclip-render')),
    timeoutMs: positiveInteger('RENDER_TIMEOUT_MS', env['RENDER_TIMEOUT_MS'], 30 * 60 * 1000),
    logLevel: logLevel as LogLevel,
  }
}
