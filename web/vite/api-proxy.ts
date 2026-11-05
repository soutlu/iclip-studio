import type { ProxyOptions } from 'vite'

const API_PREFIX = /^\/api/

export const createSameOriginApiProxy = (
  backendProxyTarget: string,
): Record<string, ProxyOptions> => ({
  '/api': {
    // 保留原始 Host 请求头，使 WebSocket 握手的 Origin 与 Host 通过后端同源校验。
    changeOrigin: false,
    rewrite: (requestPath: string) => requestPath.replace(API_PREFIX, ''),
    target: backendProxyTarget,
    ws: true,
  },
})
