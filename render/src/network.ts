import type { Logger } from './log'

export function restrictFetch(allowedHosts: Set<string>, logger: Logger): void {
  const original = globalThis.fetch
  const reported = new Set<string>()
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (allowedHosts.has(url.host.toLowerCase())) return original(input, init)
    if (!reported.has(url.host)) {
      reported.add(url.host)
      logger.warn('拦截了外部请求', { host: url.host })
    }
    return Promise.reject(new TypeError(`渲染服务不访问 ${url.host}`))
  }
}
