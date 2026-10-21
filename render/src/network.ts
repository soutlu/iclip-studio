/**
 * 渲染服务进程里的 fetch 只许访问允许的素材主机。
 *
 * producer 编译合成页时，会给页面里没有内联 @font-face 的字体去 Google Fonts 下载字形并插到所有样式表
 * 之后（@hyperframes/core 的 injectDeterministicFontFaces，本地渲染没有开关）。我们的字体都由组件目录
 * 本地提供（链接的 CSS），去 Google 下载既是外部请求、国内也取不到，下载成功还会盖掉本地字体、
 * 让导出与预览不一致。拦下之后 producer 视为取不到，页面照常用本地字体。被拦的主机记一次日志。
 */
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
