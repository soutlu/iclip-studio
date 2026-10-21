/**
 * 渲染服务的配置，全部来自环境变量：
 *   PORT                         监听端口，默认 8080（后端 WHOLE_FILM_RENDER_URL 指向它）
 *   RENDER_ALLOWED_MEDIA_HOSTS   允许的素材主机（逗号分隔，可带端口），必填
 *   RENDER_REGISTRY_ROOT         同步好的组件库的上一级目录（下面是 <HyperFrames 版本>/），必填
 *   RENDER_WORK_DIR              临时项目目录，默认系统临时目录下的 iclip-render
 *   RENDER_TIMEOUT_MS            单个导出从开始渲染到上传完成的上限，默认 30 分钟
 *   LOG_LEVEL                    debug / info / warn / error，默认 info
 */
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
    // 绝对路径：临时项目目录里链接组件库时，相对路径会按链接所在目录解析。
    registryRoot: resolve(registryRoot),
    workDir: resolve(env['RENDER_WORK_DIR'] || join(tmpdir(), 'iclip-render')),
    timeoutMs: positiveInteger('RENDER_TIMEOUT_MS', env['RENDER_TIMEOUT_MS'], 30 * 60 * 1000),
    logLevel: logLevel as LogLevel,
  }
}
