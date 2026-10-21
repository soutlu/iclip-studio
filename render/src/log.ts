/**
 * 结构化日志：每行一个 JSON，`event` 是固定的中文短句，变量放在字段里（与后端日志约定一致）。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
  /** 带上固定字段（如 exportId）的子记录器。 */
  child(fields: LogFields): Logger
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const errorFields = (value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message } : value

export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  base: LogFields = {},
): Logger {
  const emit = (at: LogLevel, event: string, fields: LogFields = {}) => {
    if (ORDER[at] < ORDER[level]) return
    const entries = Object.entries({ ...base, ...fields }).map(([key, value]) => [
      key,
      errorFields(value),
    ])
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        level: at,
        event,
        ...Object.fromEntries(entries),
      }),
    )
  }
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (fields) => createLogger(level, write, { ...base, ...fields }),
  }
}

/** producer 的日志转进本服务的日志：事件名固定，原文放在 message 字段。 */
export function producerLogger(logger: Logger) {
  const forward =
    (at: LogLevel) =>
    (message: string, meta?: Record<string, unknown>): void =>
      logger[at]('渲染器日志', { message, ...meta })
  return {
    error: forward('error'),
    warn: forward('warn'),
    info: forward('debug'),
    debug: forward('debug'),
  }
}
