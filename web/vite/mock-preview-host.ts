import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { appOriginOfMockToken } from '../src/testing/mocks/preview-token.ts'

const HOST_PATH = /^\/api\/whole-film\/preview\/([^/]+)\/host$/

const answer = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

/**
 * 按后端的规则回答预览页的 `GET /api/whole-film/preview/<令牌>/host`：令牌无效 403；
 * 请求的主机名就是应用自己的（在应用域名下打开了预览页）404；否则给出令牌里的应用来源。
 */
const answerPreviewHost = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => {
  const match = HOST_PATH.exec(request.url?.split('?')[0] ?? '')
  const token = match?.[1]
  if (request.method !== 'GET' || token === undefined) {
    next()
    return
  }
  const appOrigin = appOriginOfMockToken(decodeURIComponent(token))
  if (appOrigin === null) {
    answer(response, 403, { detail: '预览令牌无效' })
    return
  }
  const host = new URL(`http://${request.headers.host ?? ''}`).hostname
  if (host === new URL(appOrigin).hostname) {
    answer(response, 404, { detail: 'Not Found' })
    return
  }
  answer(response, 200, { appOrigin })
}

/**
 * 只在 mock 模式下由 dev/preview 服务器提供预览页取应用来源的地址：预览页在另一个主机名上，
 * 应用页的 MSW 管不到它。
 */
export const mockPreviewHostPlugin = (): Plugin => ({
  configurePreviewServer(server) {
    server.middlewares.use(answerPreviewHost)
  },
  configureServer(server) {
    server.middlewares.use(answerPreviewHost)
  },
  name: 'cue-mock-preview-host',
})
