// mock 模式的成片预览令牌：直接写着发令牌时的应用来源。浏览器里的 MSW 用它发令牌，
// mock 模式的开发服务器（vite/mock-preview-host.ts）在预览页那个主机名上按它回答应用来源。

const PREFIX = 'mock-'

export const mockPreviewToken = (appOrigin: string): string =>
  `${PREFIX}${btoa(appOrigin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`

/** 令牌里写着的应用来源；不是 mock 令牌时是 null。 */
export const appOriginOfMockToken = (token: string): string | null => {
  if (!token.startsWith(PREFIX)) return null
  try {
    return atob(token.slice(PREFIX.length).replaceAll('-', '+').replaceAll('_', '/'))
  } catch {
    return null
  }
}

/** mock 模式里预览页用的主机名：应用用 localhost 时是 127.0.0.1，反过来也一样。 */
export const mockPreviewOrigin = (appOrigin: string): string => {
  const url = new URL(appOrigin)
  url.hostname = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
  return url.origin
}
